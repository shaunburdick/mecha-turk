/**
 * The excerpt retention pass over `events.json` (006 FR-057).
 *
 * The stored payload excerpt — `QueuedEvent.issueBodyExcerpt`, the truncated
 * issue body captured at detection — used to live as long as the queue did.
 * This pass ages it out under `excerptRetentionDays`, and it is deliberately
 * narrower than the dispatched-tail cap beside it:
 *
 * - **Terminal rows only.** {@link isDispatchedTerminal} is the *same*
 *   predicate the tail cap partitions on (plan D6), so the two rules cannot
 *   drift apart; a `pending` or `in-flight` row keeps its excerpt at any age,
 *   because that text is context for a dispatch that has not been sent, and a
 *   row with no `state` at all (everything 003 enqueues) is left alone — its
 *   truth lives on the run, not here.
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
 * beyond the marker above. Every deterministic input (the clock, the
 * configuration) is supplied by the caller, so the whole pass is testable on
 * seeded fixtures with no waiting of its own.
 */

import { appendAudit, CONFIGURATION_ENTITY_ID } from '../audit.ts';
import type { ServiceConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { QueuedEvent } from './events.ts';
import { EVENTS_FILE, isDispatchedTerminal, inQueueChain, readEvents } from './events.ts';

/** Milliseconds in one day — the unit `excerptRetentionDays` is counted in. */
const DAY_MS = 86_400_000;

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
 * Decide whether one row's payload text is this pass's to clear.
 *
 * @param event - One stored queue row.
 * @param cutoff - Epoch milliseconds at which a detection leaves the window.
 * @returns `true` for an untouched, terminal row older than the window that
 *   still carries text to clear.
 */
function clearable(event: QueuedEvent, cutoff: number): boolean {
    if (!isDispatchedTerminal(event) || event.excerptTrimmedAt !== undefined || event.issueBodyExcerpt === '') {
        return false;
    }

    const stamped = Date.parse(event.detectedAt);

    return Number.isFinite(stamped) && stamped < cutoff;
}

/**
 * One pass: clear the eligible excerpts, then record what was cleared.
 *
 * @param input - Store, logger, the effective configuration, and the clock.
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
        const eligible = events.filter((event) => clearable(event, cutoff));
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
        // The row follows the removal, never precedes it (FR-053): a rewrite
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
                // describes trail removals (FR-073), and inventing one for a
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
