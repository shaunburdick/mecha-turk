/**
 * The excerpt retention pass over `events.json` (006 FR-057).
 *
 * The stored payload excerpt — `QueuedEvent.issueBodyExcerpt`, the truncated
 * issue body captured at detection — used to live as long as the queue did.
 * This pass ages it out under `excerptRetentionDays`, and it is deliberately
 * narrower than the dispatched-tail cap beside it:
 *
 * - **Eligible rows only, decided on the run's authority.** A pre-003 legacy
 *   row is terminal exactly when it carries the shipped `dispatched` state —
 *   the *same* predicate the tail cap partitions on (plan D6) — and such a row
 *   answers `409` to a retry, so its text can never be reached again. 003
 *   froze that field, though: nothing this build enqueues writes `state`, so
 *   `state === 'dispatched'` alone matches only rows an earlier build wrote
 *   and the pass would clear **nothing, ever** on a store this build creates —
 *   while the destructive-confirmation copy promises it will (FR-052, and
 *   FR-084's "no setting is inert"). A post-003 row therefore takes its
 *   eligibility from its linked run: `dispatched` clears, and `pending`,
 *   `claimed`, `starting`, `blocked:*`, `unconfirmed`, `failed`, and
 *   `dead-lettered` are **ineligible at any age**, because the relay still
 *   reads this excerpt to dispatch, retry, or return that run to waiting
 *   (`src/relay.ts`) and clearing it would silently degrade live work. A row
 *   with no usable link is left alone — its run was evicted and it was pruned
 *   with it, or it never had one — and so is every post-003 row when the run
 *   document itself cannot be read: unknown keeps its text (invariant 8).
 * - **Only the text goes.** id, state, claim and dispatch stamps, repository
 *   and issue identity, and the correlation identifier are copied through
 *   untouched, so dedupe, history, and correlation are unaffected.
 * - **The clearing is marked.** `excerptTrimmedAt` sits beside the now-empty
 *   excerpt so a reader can tell *trimmed* from *never had a body* (FR-057's
 *   round-trip distinction); a row the pass already cleared is skipped, so the
 *   pass is idempotent and never re-records a removal.
 * - **The row follows the removal.** One `audit.trimmed` row with
 *   `limitReached: 'excerpt-days'` is appended **after** the rewrite
 *   succeeds, and a pass that clears nothing appends nothing (FR-053).
 *
 * The rewrite runs on the queue's own chain (`inQueueChain`), so it cannot
 * interleave with an enqueue or a claim, and it writes the rows it read in the
 * order it read them — no tail cap, no pruning, no field is dropped or added
 * beyond the marker above. The run document is **read** inside that same slot
 * and never written: this pass opens no runs file, joins no chain of its own,
 * and adopts nothing. Every deterministic input (the clock, the configuration)
 * is supplied by the caller, so the whole pass is testable on seeded fixtures
 * with no waiting of its own.
 */

import { appendAudit, CONFIGURATION_ENTITY_ID } from '../audit.ts';
import type { ServiceConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { QueuedEvent } from './events.ts';
import { EVENTS_FILE, isDispatchedTerminal, inQueueChain, readEvents } from './events.ts';
import { RUNS_FILE } from './runs-document.ts';
import { parseRunsDocument } from './runs-parse.ts';

/** Milliseconds in one day — the unit `excerptRetentionDays` is counted in. */
const DAY_MS = 86_400_000;

/** The one run state this pass clears against; everything else keeps text. */
const RUN_DISPATCHED = 'dispatched';

/** What one excerpt pass did, for the caller's log line and its tests. */
export interface TrimExcerptsOutcome {
    /** Rows whose payload text this pass cleared; `0` touched nothing. */
    readonly cleared: number;
}

/** Inputs one pass reads; the configuration is the caller's single cycle read. */
export interface TrimExcerptsInput {
    /** Open store holding the queue. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The effective configuration, read once by the boundary that runs this. */
    readonly config: ServiceConfig;
    /**
     * Service clock in epoch milliseconds; `Date.now()` when omitted.
     *
     * Injected so a test can age a seeded queue against a fixed instant with
     * no real waiting (006's offline-determinism bar).
     */
    readonly now?: number;
}

/**
 * Read `runs.json` for the run-layer half of the eligibility rule.
 *
 * Read only, and read without the run layer's own readers on purpose: those
 * adopt the legacy queue and flush the audit-intent outbox, and a retention
 * pass must not become a second writer of a document it has no business
 * changing. Fail closed on the two shapes that are not an answer:
 *
 * - **absent** — a store that has never enqueued a run has no post-003 rows
 *   either, so the empty map is the truth rather than a guess;
 * - **quarantined or unparseable** — unknown, so *no* post-003 row is
 *   eligible; the legacy `state === 'dispatched'` rows keep their own answer
 *   from their own field, which needs no run document at all.
 *
 * @returns correlation id → run state, or an empty map when unknown.
 */
async function readRunStates(input: {
    /** Open store holding the run document. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
}): Promise<ReadonlyMap<string, string>> {
    const stored = await input.store.readJson(RUNS_FILE, parseRunsDocument);
    if (stored.status === 'quarantined') {
        input.log.warn('stored run document is unreadable; post-003 excerpts stay put', {
            quarantinePath: stored.quarantinePath,
        });
    }

    if (stored.status !== 'ok') {
        return new Map<string, string>();
    }

    return new Map(stored.value.runs.map((run) => [run.correlationId, run.state]));
}

/**
 * Decide whether one row's dispatch is finished, on the authority its schema
 * gives it.
 *
 * @param runStates - correlation id → run state, as {@link readRunStates}
 *   read them (empty when unknown).
 * @returns `true` for a legacy row in the terminal `dispatched` state, or a
 *   post-003 row whose linked run is `dispatched`.
 */
function dispatchFinished(event: QueuedEvent, runStates: ReadonlyMap<string, string>): boolean {
    if (isDispatchedTerminal(event)) {
        return true;
    }

    if (event.state !== undefined || event.runCorrelationId === undefined) {
        return false;
    }

    return runStates.get(event.runCorrelationId) === RUN_DISPATCHED;
}

/**
 * Decide whether one row's payload text is this pass's to clear.
 *
 * @returns `true` for an untouched, eligible row older than the window that
 *   still carries text to clear.
 */
function clearable(input: {
    /** One stored queue row. */
    readonly event: QueuedEvent;
    /** correlation id → run state, as {@link readRunStates} read them. */
    readonly runStates: ReadonlyMap<string, string>;
    /** Epoch milliseconds at which a detection leaves the window. */
    readonly cutoff: number;
}): boolean {
    const { event, runStates, cutoff } = input;
    if (!dispatchFinished(event, runStates) || event.excerptTrimmedAt !== undefined || event.issueBodyExcerpt === '') {
        return false;
    }

    const stamped = Date.parse(event.detectedAt);

    return Number.isFinite(stamped) && stamped < cutoff;
}

/**
 * One pass: clear the eligible excerpts, then record what was cleared.
 *
 * @returns How many rows this pass cleared; `0` means nothing was touched.
 * @throws {StorageUnavailableError} When the queue cannot be rewritten; the
 *   caller (store open, cycle boundary) logs the failure and moves on, and the
 *   file still holds its pre-pass bytes.
 */
export async function trimExcerpts(input: TrimExcerptsInput): Promise<TrimExcerptsOutcome> {
    const now = input.now ?? Date.now();

    return await inQueueChain(async () => {
        const events = await readEvents({ store: input.store, log: input.log });
        const cutoff = now - input.config.excerptRetentionDays * DAY_MS;
        const runStates = events.length === 0
            ? new Map<string, string>()
            : await readRunStates({ store: input.store, log: input.log });
        const eligible = events.filter((event) => clearable({ event, runStates, cutoff }));
        if (eligible.length === 0) {
            return { cleared: 0 };
        }

        const clearing = new Set(eligible.map((event) => event.id));
        const clearedAt = new Date(now).toISOString();
        const next = events.map((event): QueuedEvent =>
            clearing.has(event.id)
                ? { ...event, issueBodyExcerpt: '', excerptTrimmedAt: clearedAt }
                : event,);
        await input.store.writeJson(EVENTS_FILE, next);
        // The row follows the removal, never precedes it: a rewrite
        // that failed has already returned, and the trail says nothing about a
        // clearing that did not happen.
        await appendAudit(input.store, {
            eventType: 'audit.trimmed',
            actorSource: 'service',
            entity: { kind: 'service', id: CONFIGURATION_ENTITY_ID },
            decision: 'trimmed',
            reason: 'stored payload excerpts trimmed; limit reached: excerpt-days',
            details: {
                // The rows whose text went. No audit `seq` is removed here,
                // which is why this row carries no seq range — that range
                // describes trail removals, and inventing one for a
                // queue that has no `seq` would be worse than omitting it.
                entriesRemoved: eligible.length,
                limitReached: 'excerpt-days',
                minimalReferencesPreserved: 0,
            },
        });
        input.log.info('stored payload excerpts trimmed', { entriesRemoved: eligible.length });

        return { cleared: eligible.length };
    });
}
