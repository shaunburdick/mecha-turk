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
 * MVP-DEBT: retention beyond the dispatched tail, delivery leases, and the
 * runs table are contract §2.4 machinery deferred to Slice 2; this file is
 * the simple, honest stand-in.
 */

import { nowIso } from '../../src/ids.ts';
import { isRecord } from '../json.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';

/** Store file holding the event queue. */
export const EVENTS_FILE = 'events.json';

/** Event kinds the service enqueues; M1 ships assignment only. */
export type EventKind = 'assignment' | 'mention';

/** Lifecycle of one relay event. */
export type EventState = 'pending' | 'in-flight' | 'dispatched';

/** How many dispatched events stay in the file for dedupe and history. */
export const MAX_DISPATCHED_EVENTS = 500;

/** One relay event, exactly as stored and shipped. */
export interface QueuedEvent {
    /** Deterministic `[A-Za-z0-9._~|-]`-shaped id, usable as one path segment. */
    readonly id: string;
    /** Binding that produced this event. */
    readonly bindingId: string;
    /** Trigger kind; only `assignment` is implemented at this cut. */
    readonly kind: EventKind;
    /** The repository in `owner/name` form. */
    readonly repository: string;
    /** GitHub numeric user id of the account that owns the assignment. */
    readonly accountNumericUserId: string;
    /** Display login of that account (not a credential). */
    readonly accountLogin: string;
    /** Project id the dispatch targets, snapshotted at enqueue. */
    readonly projectId: string;
    /** Worktree option snapshotted at enqueue (`none`/`generated`/`new:<name>`). */
    readonly worktreeOption: string;
    /** Issue number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text. */
    readonly issueTitle: string;
    /** Canonical GitHub issue URL. */
    readonly issueUrl: string;
    /** Truncated issue body; untrusted source text, bounded at enqueue. */
    readonly issueBodyExcerpt: string;
    /** Operator-readable trigger phrase the panel shows in the dispatch context. */
    readonly triggerNote: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** Queue state, flipped in place by a claim and a dispatch. */
    readonly state: EventState;
    /** Claim stamp when in-flight, else `null`. */
    readonly claimedAt: string | null;
    /** Dispatch stamp once the panel answered, else `null`. */
    readonly dispatchedAt: string | null;
    /** Session id or the failure text the panel reported, else `null`. */
    readonly dispatchResult: string | null;
}

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

/** Every field a stored event must carry, read with their expected shapes. */
const REQUIRED_FIELDS = [
    'id',
    'bindingId',
    'kind',
    'repository',
    'accountNumericUserId',
    'accountLogin',
    'projectId',
    'worktreeOption',
    'issueNumber',
    'issueTitle',
    'issueUrl',
    'triggerNote',
    'detectedAt',
] as const;

/** Fields a row may carry as a string or a literal `null`. */
const NULLABLE_FIELDS = ['claimedAt', 'dispatchedAt', 'dispatchResult'] as const;

/** Queue states the file may carry. */
const KNOWN_STATES = new Set<string>(['pending', 'in-flight', 'dispatched']);

/**
 * Validate the event fields that must carry usable text.
 *
 * @param record - Parsed candidate row.
 * @param fields - Field names to check.
 * @returns `true` when every field is usable text.
 */
function isUsableTextFieldSet(record: Record<string, unknown>, fields: readonly string[]): boolean {
    return fields.every((field) => {
        const value = record[field];

        return field in record && typeof value === 'string' && value !== '';
    });
}

/**
 * Validate the event fields that carry a stamp-or-null.
 *
 * @param record - Parsed candidate row.
 * @param fields - Field names to check.
 * @returns `true` when every field is a string or literal `null`.
 */
function isNullableTextFieldSet(record: Record<string, unknown>, fields: readonly string[]): boolean {
    return fields.every((field) => {
        const value = record[field];

        return value === null || typeof value === 'string';
    });
}

/**
 * Read one positive integer field.
 *
 * @param value - Candidate value.
 * @returns The integer, or `null` when the value is not one.
 */
function positiveIntOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
/**
 * Validate the stored `state` field.
 *
 * @param value - Candidate value.
 * @returns The state name, or `null` when it is from another vocabulary.
 */
function knownStateOf(value: unknown): string | null {
    if (typeof value !== 'string' || !KNOWN_STATES.has(value)) {
        return null;
    }

    return value;
}

/**
 * Validate every required and nullable field of one stored row.
 *
 * @param record - Parsed candidate row.
 * @returns `true` when all fields hold usable values.
 */
function fieldsHold(record: Record<string, unknown>): boolean {
    return isUsableTextFieldSet(record, REQUIRED_FIELDS) && isNullableTextFieldSet(record, NULLABLE_FIELDS);
}

/**
 * Parse one stored event row.
 *
 * @param raw - One element from the stored array.
 * @returns The event, or `null` when the row cannot be trusted.
 */
export function parseStoredEvent(raw: unknown): QueuedEvent | null {
    const record = isRecord(raw) ? raw : null;
    if (record === null) {
        return null;
    }

    if (!fieldsHold(record)) {
        return null;
    }

    const state = knownStateOf(record.state);
    const issueNumber = positiveIntOf(record.issueNumber);
    if (state === null || issueNumber === null || typeof record.issueBodyExcerpt !== 'string') {
        return null;
    }

    const detectedAt = record.detectedAt as string;
    if (Number.isNaN(Date.parse(detectedAt))) {
        return null;
    }

    return {
        id: record.id as string,
        bindingId: record.bindingId as string,
        kind: record.kind as EventKind,
        repository: record.repository as string,
        accountNumericUserId: record.accountNumericUserId as string,
        accountLogin: record.accountLogin as string,
        projectId: record.projectId as string,
        worktreeOption: record.worktreeOption as string,
        issueNumber,
        issueTitle: record.issueTitle as string,
        issueUrl: record.issueUrl as string,
        issueBodyExcerpt: record.issueBodyExcerpt,
        triggerNote: record.triggerNote as string,
        detectedAt,
        state: state as EventState,
        claimedAt: record.claimedAt as string | null,
        dispatchedAt: record.dispatchedAt as string | null,
        dispatchResult: record.dispatchResult as string | null,
    };
}

/**
 * Parse the whole stored queue.
 *
 * @param raw - Parsed `events.json` document.
 * @returns The queue, or `null` when the document is unusable (quarantined).
 */
export function parseStoredEvents(raw: unknown): QueuedEvent[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }

    const events: QueuedEvent[] = [];
    for (const entry of raw) {
        const event = parseStoredEvent(entry);
        if (event === null) {
            return null;
        }

        events.push(event);
    }

    return events;
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
 * Read the queue.
 *
 * @param store - Open store.
 * @returns Any stored events, `[]` when absent or quarantined.
 */
async function readQueue(store: ServiceStore): Promise<QueuedEvent[]> {
    const result = await store.readJson(EVENTS_FILE, parseStoredEvents);

    return result.status === 'ok' ? result.value : [];
}

/**
 * Read the queue, best-effort: a quarantined or failed read is answered as
 * an empty list with a log line (never fail-stuck).
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
    const { store, log } = input;
    try {
        const result = await store.readJson(EVENTS_FILE, parseStoredEvents);
        if (result.status === 'ok') {
            return result.value;
        }

        if (result.status === 'quarantined') {
            log.warn('stored event queue was unusable and has been set aside', {
                quarantinePath: result.quarantinePath,
            });
        }

        return [];
    } catch (cause) {
        log.warn('event queue read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

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
        const existing = await readQueue(input.store);
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
        const events = await readQueue(input.store);
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
        const events = await readQueue(input.store);
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
