/**
 * The run document's persistence: chain, read/write, and the one-shot
 * adoption pass (003 data-model §2.6, T-003/T-005).
 */

import type { ServiceLogger } from '../log.ts';
import { isRecord } from '../json.ts';
import { StorageUnavailableError } from '../store/errors.ts';
import type { ServiceStore } from '../store/index.ts';
import { EVENTS_FILE } from './events-parse.ts';
import { MAX_ATTEMPT_RECORDS, RUNS_SCHEMA_VERSION, parseRunsDocument } from './runs-parse.ts';
import { flushRunAuditIntents } from './runs-audit.ts';
import { hasPostRunDeliveries, planAdoption } from './runs-adopt.ts';
import type { DispatchAttempt, Run, RunState, RunsDocument } from './runs-types.ts';

/** Store file holding the run document. */
export const RUNS_FILE = 'runs.json';

/** Terminal runs kept before the oldest is evicted. */
export const MAX_TERMINAL_RUNS = 500;

/** Store and logger every run operation reads. */
export interface RunsStoreInput {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}

/**
 * A run-document read plus the service-clock stamp its caller is acting
 * with. The stamp matters when the read triggers the first-read adoption:
 * the synthetic lease is only *already expired* **relative to the clock that
 * judges it**, so a pass that adopted under one stamp and judged under an
 * earlier one skipped the one-shot migration recovery and left the run wedged
 * in `claimed` (T-045). Threading the stamp makes the two the same value by
 * construction; `undefined` means the adoption pass samples the clock itself.
 */
export interface RunsReadInput extends RunsStoreInput {
    /** Service-clock stamp this read adopts with; `undefined` samples one. */
    readonly now?: string | undefined;
}

/** Fields every chain-serialized transition reads. */
export interface RunTransitionInput extends RunsStoreInput {
    /** The run this transition addresses, by correlation id. */
    readonly correlationId: string;
    /** Service-clock stamp for the mutation; defaults to `nowIso()`. */
    readonly now?: string | undefined;
}

/** Outcome of one chain-serialized run transition. */
export type RunChange =
    | { readonly status: 'applied'; readonly run: Run }
    | { readonly status: 'not-found' }
    | { readonly status: 'refused'; readonly state: RunState };

/** What the one-shot adoption pass found or produced. */
export type AdoptionOutcome = 'adopted' | 'present' | 'unreadable';

/** The chain both stores' mutations serialize onto (see the module doc). */
const queueChain: { write: Promise<unknown> } = { write: Promise.resolve() };

/**
 * Serialize one queue-or-run mutation behind everything already chained.
 *
 * @returns Whatever `task` produced, once every earlier task settled.
 */
export function inQueueChain<T>(task: () => Promise<T>): Promise<T> {
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs task on its own rejection; this runs once.
    const run = queueChain.write.then(task, task);
    queueChain.write = run;

    return run;
}

/**
 * Resolve once every chain task queued so far has settled. A reader that
 * decides *whether* to take the chain needs this first: a read issued while
 * writes are still landing would act on a document that is about to change,
 * and the work it skipped would come back on the very next poll. Draining
 * makes the snapshot true at the moment it is taken. This is a *read* helper
 * that takes no chain slot of its own, so an idle queue resolves immediately
 * without queueing behind anything.
 */
/**
 * The "the chain is idle" handler, written once so both arms of
 * {@link whenQueueIdle} cannot drift.
 *
 * Intentionally empty: a drained chain and a failed one are both idle, and
 * the caller's own read reports any failure with the store's own error.
 */
function settled(): void {
    // Nothing to do: both arms of the chain are idle however they settled.
}

export function whenQueueIdle(): Promise<void> {
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs settled twice; this runs it once.
    return queueChain.write.then(settled, settled);
}

/** One adoption pass per store handle, shared by every concurrent reader. */
const adoptionPasses = new WeakMap<ServiceStore, Promise<AdoptionOutcome>>();

/**
 * An empty run document: what a store holds before its first run exists.
 */
export function emptyRunsDocument(): RunsDocument {
    return { schemaVersion: RUNS_SCHEMA_VERSION, subjects: {}, runs: [], auditIntents: [] };
}

/**
 * Terminal run states: a new delivery opens the next ordinal instead of
 * joining, and the eviction tail may drop them.
 */
export function isTerminalRun(run: Run): boolean {
    return run.state === 'dispatched' || run.state === 'dead-lettered';
}

/** Detect any durable evidence that this run already produced a session. */
export function runHistoryIndicatesSession(run: Run): boolean {
    return run.session !== null || run.attempts.some((attempt) =>
        attempt.outcome === 'dispatched' || attempt.sessionId !== null);
}

/**
 * Run the one-shot adoption pass for this store handle.
 *
 */
async function runAdoption(input: RunsReadInput): Promise<AdoptionOutcome> {
    const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
    if (stored.status === 'ok') {
        return 'present';
    }

    if (stored.status === 'quarantined') {
        input.log.warn('stored run document was unusable and has been set aside', {
            quarantinePath: stored.quarantinePath,
        });

        return 'unreadable';
    }

    if (await hasPostRunDeliveries(input.store)) {
        input.log.warn('runs.json is absent while post-run-layer deliveries exist; refusing legacy adoption');

        return 'unreadable';
    }

    const plan = await planAdoption({
        store: input.store,
        ...(input.now !== undefined && { now: input.now }),
    });
    await input.store.writeJson(RUNS_FILE, plan.document);

    return 'adopted';
}

/**
 * Start this handle's one adoption pass and memoise it for every reader that
 * arrives while it runs. A rejected pass is dropped so the next read retries
 * rather than inheriting a failure forever.
 */
function startAdoption(input: RunsReadInput): Promise<AdoptionOutcome> {
    const pass = runAdoption(input).catch((cause: unknown) => {
        adoptionPasses.delete(input.store);
        throw cause;
    });
    adoptionPasses.set(input.store, pass);

    return pass;
}

/**
 * Ensure the store's run document exists, adopting the legacy queue on the
 * first read of this handle.
 *
 */
export async function ensureRunsAdopted(input: RunsReadInput): Promise<AdoptionOutcome> {
    return await (adoptionPasses.get(input.store) ?? startAdoption(input));
}

/**
 * Read the run document, adopting the legacy queue if this handle never
 * has. Every writer reads through this before it writes and the adoption
 * pass is chain-free by design, so an adoption can never be overwritten by a
 * writer that raced it. A caller that will go on to judge expiry (the sweep)
 * passes its own {@link RunsReadInput.now}, so the synthetic lease is minted
 * **under the same stamp the caller judges it with** — otherwise a pass whose
 * sample predates the mint reads a lease that is not yet expired and skips
 * the one-shot recovery. An unreadable `runs.json` throws: serving runs from
 * an empty document could resurrect already-dispatched work.
 */
export async function readRunsDocument(input: RunsReadInput): Promise<RunsDocument> {
    const outcome = await ensureRunsAdopted(input);
    if (outcome === 'unreadable') {
        throw new StorageUnavailableError(
            'run document is unreadable; refusing to serve run state from a quarantined runs.json',
        );
    }

    const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
    if (stored.status !== 'ok') {
        throw new StorageUnavailableError(
            'run document disappeared after adoption; refusing to serve an empty run history',
        );
    }

    return await flushRunAuditIntents({ ...input, document: stored.value, runsFile: RUNS_FILE });
}

/**
 * Read the run document for a *decision*, without taking the write chain:
 * the claim must learn whether anything is waiting **before** it decides to
 * serialize a write, and a chain-occupying read would queue every poll from
 * every panel behind an operation about to discover it has nothing to do.
 * Safe outside the chain because {@link store.writeJson} is atomic. The
 * result is a **snapshot**: a caller that goes on to mutate must re-read
 * inside {@link inQueueChain} and re-plan, because another writer may have
 * landed between the two reads.
 */
export async function previewRunsDocument(input: RunsReadInput): Promise<RunsDocument> {
    const outcome = await ensureRunsAdopted(input);
    if (outcome === 'unreadable') {
        throw new StorageUnavailableError(
            'run document is unreadable; refusing to serve run state from a quarantined runs.json',
        );
    }

    // An absent file is only "absent" because adoption ran and found nothing to
    // adopt; anything else — quarantined, torn, or a document this build cannot
    // read — refuses rather than answering an empty history. Serving `[]` here
    // would report "nothing is waiting" for work the store cannot describe,
    // which is the one answer constitution II forbids.
    const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
    if (stored.status !== 'ok') {
        throw new StorageUnavailableError(
            'run document disappeared after adoption; refusing to serve an empty run history',
        );
    }

    return stored.value;
}

/** Remove linked state-free deliveries only when their bounded terminal run is evicted. */
async function pruneEvictedRunDeliveries(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly retainedRunIds: ReadonlySet<string>;
}): Promise<void> {
    try {
        const stored = await input.store.readJson(EVENTS_FILE, (raw) => raw);
        if (stored.status !== 'ok' || !Array.isArray(stored.value)) {
            return;
        }

        const retained = stored.value.filter((row) => {
            if (!isRecord(row) || row.state !== undefined || typeof row.runCorrelationId !== 'string') {
                return true;
            }

            return input.retainedRunIds.has(row.runCorrelationId);
        });
        if (retained.length !== stored.value.length) {
            await input.store.writeJson(EVENTS_FILE, retained);
        }
    } catch (cause) {
        input.log.warn('run-linked delivery retention could not be synchronized', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    }
}

/**
 * Persist the document, evicting the oldest terminal runs first.
 *
 * Terminal runs leave before live ones do, but the `subjects` counters are
 * never pruned: an evicted run's ordinal must not be reusable, which is the
 * whole reason the counter exists (plan D3, "numbering is never reused").
 */
export async function writeRunsDocument(
    input: RunsStoreInput & { readonly document: RunsDocument },
): Promise<RunsDocument> {
    const terminal = input.document.runs.filter((run) => isTerminalRun(run));
    const evictCount = Math.max(terminal.length - MAX_TERMINAL_RUNS, 0);
    const dropped = new Set(terminal.slice(0, evictCount).map((run) => run.correlationId));
    const runs = input.document.runs.filter((run) => !dropped.has(run.correlationId));

    const persisted = { ...input.document, runs };
    await input.store.writeJson(RUNS_FILE, persisted);
    if (dropped.size > 0) {
        await pruneEvictedRunDeliveries({
            ...input,
            retainedRunIds: new Set(runs.map((run) => run.correlationId)),
        });
    }

    return persisted;
}
/**
 * Open an in-flight attempt record (data-model §2.4).
 */
function openAttempt(attempt: number): DispatchAttempt {
    return {
        attempt,
        dispatchToken: null,
        reservedAt: null,
        outcome: null,
        sessionId: null,
        reason: null,
        resultReportedAt: null,
    };
}

/**
 * Read the current attempt's record, opening one when the attempt has none.
 *
 * A run adopted with a state already in flight has no record yet, and closing
 * its outcome must still produce one (data-model §2.4).
 */
export function currentAttempt(run: Run): DispatchAttempt {
    let found = openAttempt(run.attempt);
    for (const entry of run.attempts) {
        if (entry.attempt === run.attempt) {
            found = entry;
        }
    }

    return found;
}

/**
 * Record one attempt, keeping the history bounded.
 *
 * Closing or enriching replaces only the current attempt's record: records
 * from earlier attempts survive FR-033's attempt reset untouched.
 *
 * @returns The bounded history to store on the run.
 */
export function attemptHistory(run: Run, record: DispatchAttempt): readonly DispatchAttempt[] {
    const index = run.attempts.map((entry) => entry.attempt).lastIndexOf(record.attempt);
    const updated = index === -1
        ? [...run.attempts, record]
        : run.attempts.map((entry, position) => (position === index ? record : entry));

    return updated.slice(-MAX_ATTEMPT_RECORDS);
}

/**
 * Open one claim's record: a claim starts an attempt whether or not it ever
 * reserves, and this record is what the outcome transitions later close.
 *
 * @returns The bounded history including the fresh open record.
 */
export function openedHistory(run: Run): readonly DispatchAttempt[] {
    return [...run.attempts, openAttempt(run.attempt)].slice(-MAX_ATTEMPT_RECORDS);
}
