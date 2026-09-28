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
 * MVP-DEBT: retention beyond the dispatched tail, delivery leases, and the
 * runs table are contract §2.4 machinery deferred to Slice 2; this file is
 * the simple, honest stand-in.
 */

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

/** Inputs used to assemble one queued event. */
export interface EventSnapshot {
    /** Binding that produced the detection. */
    readonly bindingId: string;
    /** Issued repository in `owner/name` form. */
    readonly repository: string;
    /** The account's durable key. */
    readonly accountNumericUserId: string;
    /** The account's login. */
    readonly accountLogin: string;
    /** Project the binding dispatches to. */
    readonly projectId: string;
    /** Worktree option copied verbatim from the binding. */
    readonly worktreeOption: string;
    /** Trigger that fired; M1 carries `assignment`. */
    readonly kind: EventKind;
    /** Issue fields, already normalized. */
    readonly issue: {
        /** Issue number. */
        readonly issueNumber: number;
        /** Issue title. */
        readonly issueTitle: string;
        /** Issue URL. */
        readonly issueUrl: string;
        /** The (bounded) issue body excerpt. */
        readonly issueBodyExcerpt: string;
    };
    /** The panel-rendered trigger phrase. */
    readonly triggerNote: string;
    /** Detection stamp. */
    readonly detectedAt: string;
}

/**
 * Build the deterministic event id for one assignment observation.
 *
 * The id doubles as the dedupe key and the relay path segment, so the join
 * character is `~` — GitHub owners and repositories (pattern
 * `A-Za-z0-9_-`) joined with `~` never collide — and the result stays inside
 * `[A-Za-z0-9._~]`, which is one URL path segment and no route ambiguity.
 *
 * @param input - Repository, issue, and account the id identifies.
 * @returns A `[A-Za-z0-9._~]`-only id of one path segment.
 */
export function buildEventId(input: {
    /** Repository the issue belongs to. */
    readonly repository: { readonly owner: string; readonly name: string };
    /** Matched issue number. */
    readonly issueNumber: number;
    /** The account the issue is assigned to. */
    readonly accountNumericUserId: string;
}): string {
    const { repository } = input;

    return `evt-${repository.owner}~${repository.name}~${input.issueNumber}~${input.accountNumericUserId}`;
}

/**
 * Assemble one queued event from a fresh detection.
 *
 * @param snapshot - Detection inputs.
 * @returns A fresh event in `pending` state.
 */
export function createEvent(snapshot: EventSnapshot): QueuedEvent {
    const separatorIndex = snapshot.repository.indexOf('/');
    const owner = separatorIndex < 0 ? snapshot.repository : snapshot.repository.slice(0, separatorIndex);
    const name = separatorIndex < 0 ? '' : snapshot.repository.slice(separatorIndex + 1);

    const base = {
        bindingId: snapshot.bindingId,
        kind: snapshot.kind,
        repository: snapshot.repository,
        accountNumericUserId: snapshot.accountNumericUserId,
        accountLogin: snapshot.accountLogin,
        projectId: snapshot.projectId,
        worktreeOption: snapshot.worktreeOption,
        issueNumber: snapshot.issue.issueNumber,
        issueTitle: snapshot.issue.issueTitle,
        issueUrl: snapshot.issue.issueUrl,
        issueBodyExcerpt: snapshot.issue.issueBodyExcerpt,
        triggerNote: snapshot.triggerNote,
        detectedAt: snapshot.detectedAt,
        state: 'pending' as const,
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
    };

    return {
        ...base,
        id: buildEventId({
            repository: { owner, name },
            issueNumber: snapshot.issue.issueNumber,
            accountNumericUserId: snapshot.accountNumericUserId,
        }),
    };
}

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
 * Quarantine passes this process has already recovered, keyed per store handle.
 *
 * A corrupt `events.json` renames to exactly one quarantine path, so the set
 * ties the recovery to the observation itself: the scan's health pass, the
 * panel's claim, and any relay read can all spot the same quarantine without
 * resetting the windows (or writing the audit row) more than once.
 */
const recoveredQuarantines = new WeakMap<ServiceStore, Set<string>>();

/**
 * Claim one quarantine observation for recovery.
 *
 * @param store - Store handle that observed the quarantine.
 * @param quarantinePath - Unique path the unusable file was set aside to.
 * @returns `true` when this caller owns the recovery.
 */
function claimQuarantinePass(store: ServiceStore, quarantinePath: string): boolean {
    const handled = recoveredQuarantines.get(store) ?? new Set<string>();
    recoveredQuarantines.set(store, handled);
    if (handled.has(quarantinePath)) {
        return false;
    }

    handled.add(quarantinePath);

    return true;
}

/**
 * Clear every binding's `lastScanAt` so the next scan re-baselines.
 *
 * The quarantined queue's rows are gone with the file, so the only way to
 * recover what they carried is to re-detect it — and a binding whose window
 * already advanced past those assignments will never match them again.
 * Clearing every slot moves each binding back to "never scanned", which makes
 * `windowFor` open at the binding's own `createdAt`: the same baseline a
 * fresh binding gets. The write runs on the scan-state chain, so it cannot
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

/**
 * Read the queue through the quarantine funnel.
 *
 * Every queue reader — the relay routes, the panel's claim, and the scan's
 * own enqueue — passes this one function, so a file that has to be
 * quarantined always triggers the scan-window recovery, whichever reader
 * reaches it first.
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
 * the whole of deduplication.
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
