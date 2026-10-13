/**
 * The excerpt retention pass over `events.json` (006 FR-057).
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
 * Read `runs.json` for the run-layer half of the eligibility rule. Read
 * only, and without the run layer's own readers on purpose: those adopt the
 * legacy queue and flush the audit-intent outbox, and a retention pass must
 * not become a second writer of a document it has no business changing.
 * Fail closed on the two shapes that are not an answer — **absent** is an
 * empty map (the truth rather than a guess), and **quarantined or
 * unparseable** means no post-003 row is eligible while legacy
 * `state === 'dispatched'` rows keep their answer from their own field.
 */
async function readRunStates(input: {
    /** Open store holding the run document. */
    readonly store: ServiceStore;
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
