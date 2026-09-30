/**
 * The service-side event queue (MVP tasks M1/M2 — re-cut 2026-09-27).
 *
 * GitHub-scan findings become {@link QueuedEvent} records that wait in
 * `events.json` until the panel carries them into a `host.startSession()`
 * dispatch. One JSON file holds the whole queue; dedupe is by the event's own
 * deterministic `id` (one assignment on one issue can only ever produce one
 * event), and a dispatch is terminal.
 *
 * The row schema and its validator live beside this module in
 * `events-parse.ts` (the read side of the same contract). A queue file that
 * fails that validator is quarantined *and* repaired here: every binding's
 * scan window is cleared and one `delivery.recovered` audit row is written,
 * so the assignments the lost queue carried are re-detected on the next
 * pass instead of silently dropped.
 *
 * **What changed in 003 (T-001–T-006).** A delivery is no longer the unit of
 * dispatch — the **run** is (data-model §1, §2.2) — and this module no longer
 * performs the claim itself. What it does now is:
 *
 * - **enqueue through the run layer**: a fresh delivery either opens a run or
 *   joins an open one (FR-011), on the same chain `runs.json` shares, writing
 *   `runs.json` first and `events.json` second so a crash between the two
 *   self-heals on re-detect (research §R4);
 * - **write the forward link** `runCorrelationId` on the rows it enqueues, and
 *   carry the `subjectType` captured at detection, while leaving the legacy
 *   lifecycle fields (`state`, `claimedAt`, `dispatchedAt`, `dispatchResult`)
 *   frozen — a post-003 row carries none of them, and that absence is what
 *   tells the two vocabularies apart on read (FR-012);
 * - **prune run-linked rows** when their bounded terminal run is evicted, so
 *   `events.json` cannot outlive the run that explains it (T-037).
 *
 * **The legacy queue's terminal mutations were removed** (T-043g). The two
 * routes they served, `POST /v1/events/:id/dispatched` and `…/retry`, were
 * re-addressed to the run by 003's wire delta ("Addressed by the run, not the
 * delivery"), and are answered by [`dispatch.ts`](../routes/dispatch.ts) and
 * [`run-ops.ts`](../routes/run-ops.ts) against `runs.json`. `markEventDispatched`
 * and `retryEvent` had no caller and a second vocabulary for the same facts —
 * one import away from re-creating the state-flip path 003 closed — so they are
 * gone. Nothing here writes the frozen lifecycle fields any more; `GET
 * /v1/events` keeps *reading* them from rows the shipped build wrote until 003
 * T-016 replaces that projection.
 */

import { basename, join } from 'node:path';
import { newCorrelationId, nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { PromptSnapshot } from '../prompt.ts';
import type { ServiceStore } from '../store/index.ts';
import { EVENTS_FILE, parseStoredEvent, parseStoredEvents } from './events-parse.ts';
import { recordEnqueueAudits } from './events-enqueue-audit.ts';
import { applyEnqueue } from './runs-join.ts';
import { inQueueChain, readRunsDocument, writeRunsDocument } from './runs-document.ts';
import { readScanState, serializeScan, writeScanState } from './scan.ts';
import type { EventKind, EventState, QueuedEvent, SubjectType } from './events-parse.ts';
import type { BindingScanState } from './scan.ts';

/** Store file holding the event queue (declared beside the row schema). */
export { EVENTS_FILE, subjectTypeOf } from './events-parse.ts';

/**
 * Re-exported: the chain every queue mutation serializes on has exactly one
 * import path, so a rewriting pass (006's excerpt trim) joins the *same* slot
 * an enqueue does instead of keeping a second chain that could race it.
 */
export { inQueueChain };

/** How many dispatched events stay in the file for dedupe and history. */
export const MAX_DISPATCHED_EVENTS = 500;

/** Re-exported: this module stays the one import path for the queue's readers. */
export { parseStoredEvent, parseStoredEvents };

/** Row types re-exported alongside them for the routes and the scan loop. */
export type { EventKind, EventState, QueuedEvent, SubjectType };

/** Re-exported: this module stays the one import path for the queue's writer. */
export { buildEventId, createEvent } from './events-write.ts';
export type {
    AssignmentEventSnapshot,
    EventSnapshot,
    MentionBodyEventSnapshot,
    MentionEventSnapshot,
    MentionOrigin,
    ReviewEventSnapshot,
} from './events-write.ts';

/**
 * The one rule for "this **legacy** row is finished" — used by the
 * dispatched-tail cap, and by 006's excerpt retention pass as the first half
 * of its eligibility rule (006 FR-057, plan D6).
 *
 * A row is terminal exactly when it carries the shipped `dispatched` state:
 * such a row answers `409` to a retry and can never re-enter the queue, so
 * neither its tail position nor its payload text is reachable again. Extracting
 * the predicate rather than restating `state === 'dispatched'` in a second
 * module is what keeps the tail cap and the excerpt pass from ever disagreeing
 * about a legacy row.
 *
 * A row with no `state` at all (everything 003 enqueues) is **not** terminal by
 * this rule: its truth lives on the run, and this predicate has no business
 * reading it. 003 froze the field, so the tail cap leaves those rows to the
 * run-eviction prune beside it, and the excerpt pass reads the linked run's
 * state itself (`poll/excerpt-trim.ts`) rather than asking this function to
 * guess.
 *
 * @param event - One stored queue row.
 * @returns `true` only for a row in the terminal `dispatched` state.
 */
export function isDispatchedTerminal(event: QueuedEvent): boolean {
    return event.state === 'dispatched';
}

/**
 * Serialize the queue into the file's canonical array form.
 *
 * The pending and in-flight events always come forward; the dispatched tail
 * is bounded so the file stays small no matter how long the operator works.
 *
 * @param events - The queue to store.
 * @returns The array to write.
 */
function serializedQueue(events: readonly QueuedEvent[], retainedRunIds?: ReadonlySet<string>): QueuedEvent[] {
    const retained = retainedRunIds === undefined
        ? events
        : events.filter((event) => event.state !== undefined
            || event.runCorrelationId === undefined
            || retainedRunIds.has(event.runCorrelationId));
    const live = retained.filter((event) => !isDispatchedTerminal(event));
    const dispatched = retained.filter((event) => isDispatchedTerminal(event)).slice(-MAX_DISPATCHED_EVENTS);

    return [...live, ...dispatched];
}

/**
 * Quarantine passes this process has already recovered, keyed per store
 * handle by the quarantined file's *name*.
 *
 * A corrupt `events.json` renames to exactly one file name, so keying on the
 * name ties the recovery to the loss rather than to the reader that noticed:
 * the live quarantine, the evidence scan, the panel's claim, and any relay
 * read can all spot the same loss without resetting the windows (or writing
 * the audit row) more than once in one process.
 */
const recoveredQuarantines = new WeakMap<ServiceStore, Set<string>>();

/**
 * Claim one quarantine observation for recovery.
 *
 * @param store - Store handle that observed the loss.
 * @param quarantinePath - Path (or store-relative name) of the quarantined file.
 * @returns `true` when this caller owns the recovery.
 */
function claimQuarantinePass(store: ServiceStore, quarantinePath: string): boolean {
    const handled = recoveredQuarantines.get(store) ?? new Set<string>();
    recoveredQuarantines.set(store, handled);
    if (handled.has(basename(quarantinePath))) {
        return false;
    }

    handled.add(basename(quarantinePath));

    return true;
}

/**
 * Clear every binding's `lastScanAt` so the next scan replays every open
 * issue.
 *
 * The quarantined queue's rows are gone with the file, so the only way to
 * recover what they carried is to re-detect it — and a binding whose window
 * already advanced past those assignments will never match them again.
 * Clearing every slot moves each binding back to "never scanned", which makes
 * `windowFor` return no window at all: the next cycle replays every open
 * issue — the same contract a fresh binding gets (product decision,
 * 2026-09-28) — and the deterministic event ids keep that replay
 * duplicate-free. The write runs on the scan-state chain, so it cannot
 * interleave with the loop's own read-modify-write of that file.
 *
 * @param input - Open store and logger the scan-state read takes.
 * @returns How many bindings had a window to clear.
 */
async function resetScanWindows(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<number> {
    return await serializeScan(async () => {
        const state = await readScanState(input);
        const bindings: Record<string, BindingScanState> = {};
        let cleared = 0;
        for (const [bindingId, slot] of Object.entries(state.bindings)) {
            const next: BindingScanState = slot.lastScanAt === null ? slot : { ...slot, lastScanAt: null };
            cleared += next === slot ? 0 : 1;
            bindings[bindingId] = next;
        }

        if (cleared > 0) {
            await writeScanState({ store: input.store, state: { bindings } });
        }

        return cleared;
    });
}

/**
 * Record one queue-quarantine recovery in the audit trail.
 *
 * @param input - Open store, logger, the quarantine path, and the reset count.
 */
async function recordQueueRecovery(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
    /** Where the unusable queue was set aside. */
    readonly quarantinePath: string;
    /** Bindings whose scan window was cleared. */
    readonly bindingsReset: number;
}): Promise<void> {
    try {
        await appendAudit(input.store, {
            eventType: 'delivery.recovered',
            actorSource: 'service',
            entity: { kind: 'delivery', id: EVENTS_FILE },
            decision: null,
            reason: 'events queue quarantined — scan windows reset',
            correlationId: newCorrelationId(),
            details: { quarantinePath: input.quarantinePath, bindingsReset: input.bindingsReset },
        });
    } catch (cause) {
        // Same posture as a detection row: the window reset is already
        // durable, so a failed audit append is logged rather than thrown
        // back into the read that observed the quarantine.
        input.log.warn('queue recovery audit row could not be appended', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    }
}

/**
 * Recover from a queue file that had to be quarantined.
 *
 * The quarantine consumed the evidence file, so this is the only moment the
 * repair can run: clear every binding's scan window — the lost assignments
 * are re-detected on the next pass, and the deterministic event ids keep that
 * replay duplicate-free — then leave one audit row saying so.
 *
 * @param input - Open store, logger, and the quarantine path.
 */
async function recoverQuarantinedQueue(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
    /** Where the unusable queue was set aside. */
    readonly quarantinePath: string;
}): Promise<void> {
    if (!claimQuarantinePass(input.store, input.quarantinePath)) {
        return;
    }

    const bindingsReset = await resetScanWindows(input);
    input.log.info('scan windows reset after the event queue was quarantined', { bindingsReset });
    await recordQueueRecovery({ ...input, bindingsReset });
}

/** Store file name prefix every quarantined copy of the queue keeps. */
const QUARANTINE_EVIDENCE_PREFIX = `${EVENTS_FILE}.corrupt-`;

/**
 * Recover a queue loss this process never saw happen.
 *
 * The quarantine *renames* the file, so a service that restarts after the
 * loss finds `events.json` simply absent: no read reports `quarantined`
 * again, the reset would never run, and the windows would keep pointing past
 * the assignments the lost queue carried. The evidence file is still in the
 * store directory, so any `events.json.corrupt-*` entry stands in for the
 * observation — the first absent read recovers from it, and the per-store
 * claim set holds that to one reset and one audit row per loss per process.
 * The reset is idempotent, and deterministic event ids keep the re-detection
 * duplicate-free even when a later process repeats it.
 *
 * @param input - Open store and logger.
 */
async function recoverFromEvidence(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<void> {
    const entries = await input.store.listDir('.');
    for (const entry of entries) {
        if (entry.startsWith(QUARANTINE_EVIDENCE_PREFIX)) {
            await recoverQuarantinedQueue({ ...input, quarantinePath: join(input.store.dataDir, entry) });
        }
    }
}

/**
 * Read the queue through the quarantine funnel.
 *
 * Every queue reader — the relay routes, the panel's claim, and the scan's
 * own enqueue — passes this one function, so a lost queue always triggers the
 * scan-window recovery, whichever reader gets there first: a file that has to
 * be quarantined right now, or the evidence an earlier process left behind
 * when the file is already gone.
 *
 * @param input - Open store and logger.
 * @returns Any stored events, `[]` when absent or quarantined.
 */
async function readQueue(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<QueuedEvent[]> {
    const result = await input.store.readJson(EVENTS_FILE, parseStoredEvents);
    if (result.status === 'ok') {
        return result.value;
    }

    if (result.status === 'quarantined') {
        input.log.warn('stored event queue was unusable and has been set aside', {
            quarantinePath: result.quarantinePath,
        });
        await recoverQuarantinedQueue({ ...input, quarantinePath: result.quarantinePath });
    } else {
        // `absent` is the only other outcome: an earlier process renamed the
        // file away, and its evidence stands in for the observation.
        await recoverFromEvidence(input);
    }

    return [];
}

/**
 * Read the queue, best-effort: a quarantined or failed read is answered as
 * an empty list with a log line (never fail-stuck), and a quarantined read
 * has already run the scan-window recovery before it answers.
 *
 * @param input - Open store and logger.
 * @returns The queue, or `[]`.
 */
export async function readEvents(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<QueuedEvent[]> {
    try {
        return await readQueue(input);
    } catch (cause) {
        input.log.warn('event queue read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return [];
    }
}

/** Perform one serialized enqueue, preserving run-before-delivery durability. */
async function enqueueWithinChain(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly incoming: readonly QueuedEvent[];
    readonly prompt?: PromptSnapshot | null;
}): Promise<readonly QueuedEvent[]> {
    const existing = await readQueue(input);
    const known = new Set(existing.map((event) => event.id));
    const fresh = input.incoming.filter((event) => {
        if (known.has(event.id)) {
            return false;
        }

        known.add(event.id);
        return true;
    });
    if (fresh.length === 0) {
        return [];
    }

    const document = await readRunsDocument(input);
    const outcome = applyEnqueue({
        document,
        deliveries: fresh,
        now: nowIso(),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    });
    const appended = fresh.map((event) => {
        const runCorrelationId = outcome.links.get(event.id);
        return runCorrelationId === undefined ? event : { ...event, runCorrelationId };
    });
    const persistedRuns = await writeRunsDocument({ ...input, document: outcome.document });
    await input.store.writeJson(
        EVENTS_FILE,
        serializedQueue([...existing, ...appended], new Set(persistedRuns.runs.map((run) => run.correlationId))),
    );
    // Creation audits are backed by intents in runs.json; draining after both
    // durable state writes closes the crash window without changing audit row
    // vocabulary or rolling back either state file.
    await readRunsDocument(input);
    await recordEnqueueAudits({ ...input, outcome, appended });

    return appended;
}

/**
 * Append events with delivery-id deduplication and one atomic run/queue chain.
 *
 * @param input - Open store and freshly detected events.
 * @returns The events that were actually appended, linked to their run.
 */
export async function enqueueEvents(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
    /** Fresh events this scan produced. */
    readonly incoming: readonly QueuedEvent[];
    /**
     * The scanning binding's prompt snapshot (004 FR-015), carried beside the
     * events the same binding produced `projectId`/`worktreeOption` for.
     *
     * **No field is added to the delivery rows** — the text persists in
     * exactly two places, the binding and this run snapshot (004 FR-053) — so
     * `buildEventId`, dedupe, and the NDJSON event contract are untouched.
     */
    readonly prompt?: PromptSnapshot | null;
}): Promise<readonly QueuedEvent[]> {
    return await inQueueChain(async () => await enqueueWithinChain(input));
}

