/**
 * The service-side event queue (MVP tasks M1/M2 — re-cut 2026-09-27).
 *
 * GitHub-scan findings become {@link QueuedEvent} records that wait in
 * `events.json` until the panel carries them into a `host.startSession()`
 * dispatch. One JSON file holds the whole queue; dedupe is by the event's own
 * deterministic `id` (one assignment on one issue can only ever produce one
 * event), a claim is a state flip with a stamp, and a dispatch is terminal.
 * This is the deliberately simple replacement for the contract's long-poll/
 * lease relay (§2.4) — the MVP cut trades leases and run keys for a queue one
 * panel reads through two routes.
 *
 * The row schema and its validator live beside this module in
 * `events-parse.ts` (the read side of the same contract). A queue file that
 * fails that validator is quarantined *and* repaired here: every binding's
 * scan window is cleared and one `delivery.recovered` audit row is written,
 * so the assignments the lost queue carried are re-detected on the next
 * pass instead of silently dropped.
 *
 * MVP-DEBT: retention beyond the dispatched tail and delivery leases are
 * contract §2.4 machinery still deferred; the Slice-2 runs history
 * (`GET /v1/events`) and its retry (`POST /v1/events/:id/retry`) read and
 * reset this queue in place instead of adding a second store.
 */

import { basename, join } from 'node:path';
import { newCorrelationId, nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { parseStoredEvent, parseStoredEvents } from './events-parse.ts';
import { readScanState, serializeScan, writeScanState } from './scan.ts';
import type { EventKind, EventState, QueuedEvent } from './events-parse.ts';
import type { BindingScanState } from './scan.ts';

/** Store file holding the event queue. */
export const EVENTS_FILE = 'events.json';

/** How many dispatched events stay in the file for dedupe and history. */
export const MAX_DISPATCHED_EVENTS = 500;

/** Re-exported: this module stays the one import path for the queue's readers. */
export { parseStoredEvent, parseStoredEvents };

/** Row types re-exported alongside them for the routes and the scan loop. */
export type { EventKind, EventState, QueuedEvent };

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
 * In-flight chain the queue's mutations serialize onto (the `audit.ts`
 * write-chain pattern), so a scan tick and the relay routes never interleave
 * one another's read-modify-write.
 */
const queueChain: { write: Promise<unknown> } = { write: Promise.resolve() };

/**
 * Serialize one queue mutation.
 *
 * @param task - The work to chain.
 * @returns Whatever `task` produced.
 */
function inQueueChain<T>(task: () => Promise<T>): Promise<T> {
    const run = queueChain.write.then(task, task);
    queueChain.write = run;

    return run;
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
function serializedQueue(events: readonly QueuedEvent[]): QueuedEvent[] {
    const live = events.filter((event) => event.state !== 'dispatched');
    const dispatched = events.filter((event) => event.state === 'dispatched').slice(-MAX_DISPATCHED_EVENTS);

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

/**
 * Append events to the queue, skipping every id already recorded in any
 * state — the deterministic event id is the dedupe key, so this one check is
 * the whole of deduplication. The check reads *every* row still in the file,
 * pending, in-flight, and dispatched alike, so a replay (a first scan, or a
 * recovery reset that cleared `lastScanAt`) re-enqueues nothing the queue can
 * still see.
 *
 * MVP-DEBT: `serializedQueue` retains only the newest `MAX_DISPATCHED_EVENTS`
 * (500) dispatched rows, so an issue dispatched longer ago than that has been
 * evicted from the file — a later replay can enqueue it once more. That
 * eviction is the only gap in this dedupe (acceptable for the MVP bar: a
 * queue loss discards the whole file anyway); a durable dedupe index belongs
 * with the contract §2.4 retention machinery on the Slice 2 debt list.
 *
 * @param input - Open store and freshly detected events.
 * @returns The events that were actually appended.
 */
export async function enqueueEvents(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
    /** Fresh events this scan produced. */
    readonly incoming: readonly QueuedEvent[];
}): Promise<readonly QueuedEvent[]> {
    return await inQueueChain(async () => {
        const existing = await readQueue(input);
        const known = new Set(existing.map((event) => event.id));
        const appended = input.incoming.filter((event) => !known.has(event.id));
        if (appended.length === 0) {
            return [];
        }

        await input.store.writeJson(EVENTS_FILE, serializedQueue([...existing, ...appended]));

        return appended;
    });
}

/**
 * Claim every pending event for the panel.
 *
 * @param input - Open store, the claim stamp, and a logger.
 * @returns The events the panel now owns.
 */
export async function claimPendingEvents(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Claim stamp. */
    readonly claimedAt: string;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<QueuedEvent[]> {
    return await inQueueChain(async () => {
        const events = await readQueue(input);
        const pending = events.filter((event) => event.state === 'pending');
        const claim = (event: QueuedEvent): QueuedEvent => ({
            ...event,
            state: 'in-flight' as const,
            claimedAt: input.claimedAt,
        });
        if (pending.length === 0) {
            return [];
        }

        const claimedIds = new Set(pending.map((event) => event.id));
        const claimed = events.map((event) => (claimedIds.has(event.id) ? claim(event) : event));
        await input.store.writeJson(EVENTS_FILE, serializedQueue(claimed));

        return pending.map(claim);
    });
}

/**
 * Mark one event dispatched (terminal) by its id.
 *
 * @param input - Open store, the id, the result summary, and a logger.
 * @returns The event as it now stands, or `null` when the id was not in the
 *   queue at all or was already marked (idempotent re-posts).
 */
export async function markEventDispatched(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Event id. */
    readonly eventId: string;
    /** Result summary: the session id or the failure text. */
    readonly result: string | null;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<QueuedEvent | null> {
    return await inQueueChain(async () => {
        const events = await readQueue(input);
        const match = events.find((event) => event.id === input.eventId);
        if (match === undefined || match.state === 'dispatched') {
            return null;
        }

        const dispatched: QueuedEvent = {
            ...match,
            state: 'dispatched' as const,
            dispatchedAt: nowIso(),
            dispatchResult: input.result,
        };
        const remaining = events.map((event) => (event.id === input.eventId ? dispatched : event));
        await input.store.writeJson(EVENTS_FILE, serializedQueue(remaining));

        return dispatched;
    });
}

/** What one retry request found the event in. */
export type RetryOutcome = 'reset' | 'dispatched' | 'unknown';

/**
 * Return one event to the pending queue for another dispatch.
 *
 * The operator's "dispatch failed → retry" control (M8) posts here. An event
 * the panel claimed but never answered (`in-flight`) goes back to `pending`
 * with its claim stamp cleared; an event already waiting (`pending`) is left
 * exactly as it is — both answer `reset`, so the route answers `200` either
 * way. A terminal event answers `dispatched` (the route turns that into
 * `409`), and an id the queue never held answers `unknown` (`404`).
 *
 * @param input - Open store, the id, and a logger.
 * @returns What the id resolves to.
 */
export async function retryEvent(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Event id. */
    readonly eventId: string;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<RetryOutcome> {
    return await inQueueChain(async () => {
        const events = await readQueue(input);
        const match = events.find((event) => event.id === input.eventId);
        if (match === undefined) {
            return 'unknown';
        }

        if (match.state === 'pending') {
            return 'reset';
        }

        if (match.state === 'dispatched') {
            return 'dispatched';
        }

        const reset = (event: QueuedEvent): QueuedEvent =>
            event.id === input.eventId ? { ...event, state: 'pending' as const, claimedAt: null } : event;
        await input.store.writeJson(EVENTS_FILE, serializedQueue(events.map(reset)));

        return 'reset';
    });
}
