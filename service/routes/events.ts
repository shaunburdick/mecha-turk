/**
 * The event relay (MVP task M2 — re-cut 2026-09-27).
 *
 * `GET /v1/events/pending` hands the panel every queued event and flips them
 * in-flight with one stamp — the cheap claim, where the event id *is* the
 * claim. `POST /v1/events/:id/dispatched` marks one claimed event done and
 * stores the panel's own summary for the operator's record. Re-posting the
 * same dispatch is idempotent at the route level: the second post finds the
 * event already terminal and answers the same 200 shape.
 *
 * Slice 2 adds the runs history this MVP cut deferred: `GET /v1/events`
 * projects every event — pending, in-flight, and dispatched alike — newest
 * detected first without claiming anything, and `POST /v1/events/:id/retry`
 * hands one non-dispatched event back to the pending queue (M8's "dispatch
 * failed → retry").
 *
 * The same `GET` response carries the per-binding scan status the panel's
 * status line renders, because the panel polls this route on its own clock
 * and the status has no other surface yet (the contract's `/v1/status`
 * repositories section is a later wave).
 *
 * MVP-DEBT: this surface replaces contract §2.4's long-poll/lease relay for
 * the MVP cut — no run keys, no lease table; a panel that claims an event and
 * dies before dispatching leaves it in the queue file where the operator can
 * see it, and the next delivery is expected from the re-grant. Contracts
 * amend in Slice 2 only if the loop survives.
 */

import { readBindings } from '../bindings.ts';
import { claimPendingRuns, holderOf } from '../poll/claim.ts';
import {
    markEventDispatched,
    readEvents,
    retryEvent,
} from '../poll/events.ts';
import { readScanState } from '../poll/scan.ts';
import type { BindingRecord } from '../bindings.ts';
import type { EventKind, EventState, QueuedEvent } from '../poll/events.ts';
import { errorResponse, STATUS, storageUnavailableResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceStore } from '../store/index.ts';
import type { ServiceLogger } from '../log.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path the panel polls for queued events. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/** Path of the runs history: every event, every state, newest detected first. */
export const EVENTS_PATH = '/v1/events';

/** Path pattern the operator retries one non-dispatched event through. */
export const EVENT_RETRY_PATH = '/v1/events/:eventId/retry';

/** Path pattern the panel reports one dispatch through. */
export const EVENT_DISPATCHED_PATH = '/v1/events/:eventId/dispatched';

/** How many events the runs history answers with (newest detected first). */
export const MAX_LISTED_EVENTS = 100;

/** Longest event id accepted on a dispatch path; ids are built, never parsed. */
const MAX_EVENT_ID_CHARS = 200;

/** Shape of a stored queue row the status reader needs. */
type QueueRow = Pick<QueuedEvent, 'id' | 'bindingId' | 'state'>;

/** One binding's scan status row for the panel's status line. */
export interface BindingStatusRow {
    /** Binding the row describes. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** The binding's project id. */
    readonly projectId: string;
    /** The account login this binding polls under. */
    readonly accountLogin: string;
    /** `true` when the binding is enabled right now. */
    readonly active: boolean;
    /** RFC 3339 stamp of the last completed scan, or `null`. */
    readonly lastScanAt: string | null;
    /** Short machine reason the last scan skipped, else `null`. */
    readonly lastError: string | null;
    /** Events for this binding that are pending or in flight. */
    readonly pendingCount: number;
}

/**
 * Read the numeric event id captured from the dispatch path.
 *
 * @param raw - Captured `:eventId` segment; the pipeline does not decode it,
 *   so reuse keep this validation tight instead of trusting an encoding.
 * @returns The id, or `null` when the segment carries no usable id.
 */
function pathEventId(raw: string | undefined): string | null {
    if (raw === undefined || raw === '' || raw.length > MAX_EVENT_ID_CHARS) {
        return null;
    }

    return /^[A-Za-z0-9._~-]+$/.test(raw) ? raw : null;
}

/** One event as the runs history reports it — credential-free by construction. */
export interface EventRunRow {
    /** Deterministic event id. */
    readonly id: string;
    /** Trigger kind. */
    readonly kind: EventKind;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** Issue (or pull request) number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text. */
    readonly issueTitle: string;
    /** Canonical issue URL. */
    readonly issueUrl: string;
    /** Queue state. */
    readonly state: EventState;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** Claim stamp when (or after) it was claimed, else `null`. */
    readonly claimedAt: string | null;
    /** Dispatch stamp once the panel answered, else `null`. */
    readonly dispatchedAt: string | null;
    /** Session id or the failure text the panel reported, else `null`. */
    readonly dispatchResult: string | null;
    /** Binding that produced the event. */
    readonly bindingId: string;
    /** Head SHA of a review-event pull request; absent on every other kind. */
    readonly headSha?: string;
    /** Base ref of that pull request; absent on every other kind. */
    readonly baseRef?: string;
}

/**
 * Project one queue row for the runs history.
 *
 * The projection carries what a runs row reads — identity, state, stamps,
 * and the PR coordinates M7 captures — and nothing else: no account id, no
 * login, no project, no worktree option. The queue itself never holds a
 * credential, so a credential can only appear here by being projected in;
 * nothing projects one.
 *
 * A row 003 enqueued carries no lifecycle state of its own; its truth lives
 * on the run, and until the run-shaped projection lands (T-016) this reader
 * reports the one state such a row can be in — its run is `pending`, because
 * nothing has claimed it — rather than dropping the `state` key the panel's
 * parser fails closed on.
 *
 * @param event - Stored queue row.
 * @returns The credential-free row.
 */
function runRowOf(event: QueuedEvent): EventRunRow {
    return {
        id: event.id,
        kind: event.kind,
        repository: event.repository,
        issueNumber: event.issueNumber,
        issueTitle: event.issueTitle,
        issueUrl: event.issueUrl,
        state: event.state ?? 'pending',
        detectedAt: event.detectedAt,
        claimedAt: event.claimedAt ?? null,
        dispatchedAt: event.dispatchedAt ?? null,
        dispatchResult: event.dispatchResult ?? null,
        bindingId: event.bindingId,
        ...(event.headSha === null ? {} : { headSha: event.headSha }),
        ...(event.baseRef === null ? {} : { baseRef: event.baseRef }),
    };
}

/**
 * Project the runs history: newest detected first, capped.
 *
 * @param queue - Every event the queue still holds, any state.
 * @returns At most {@link MAX_LISTED_EVENTS} rows, freshest detection first.
 */
function recentRuns(queue: readonly QueuedEvent[]): EventRunRow[] {
    return [...queue]
        .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
        .slice(0, MAX_LISTED_EVENTS)
        .map(runRowOf);
}

/**
 * Read the panel's dispatch summary out of the request body.
 *
 * The panel sends `{ sessionId: string }` after a start, or
 * `{ problem: string }` when its dispatch ended in a refusal. Both shapes are
 * panel-published, so the strings are taken as-is, but the field must be
 * strings for the record to be trustworthy: any other shape reads as no
 * summary at all rather than a partial one.
 *
 * @param raw - Parsed body, or `undefined` when the request carried none.
 * @returns `[sessionId, problem]`, nullable and in this order.
 */
function readDispatchFields(raw: unknown): readonly [string | null, string | null] {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return [null, null];
    }

    const record = raw as Record<string, unknown>;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null;
    const problem = typeof record.problem === 'string' ? record.problem : null;

    return [sessionId, problem];
}

/**
 * Read the per-binding status rows.
 *
 * One row per stored binding, built from the scan state and the queue, so
 * every route that reports status (the relay's pending answer and the
 * bindings collection) answers the panel's parser with the same shape. The
 * caller passes the bindings it already read, so one collection read never
 * happens twice inside a single request.
 *
 * @param input - Store, logger, and the bindings every row is keyed by.
 * @returns One row per binding, with scan state and pending count.
 */
export async function readStatusRows(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Stored bindings, as the route itself read them. */
    readonly bindings: readonly BindingRecord[];
}): Promise<BindingStatusRow[]> {
    const [scannedState, queue] = await Promise.all([readScanState(input), readEvents(input)]);

    const counts = new Map<string, number>();
    for (const event of queue) {
        // Waiting work counts whether the *delivery* still carries the legacy
        // `pending` stamp or (a row 003 enqueued) no lifecycle state at all —
        // both are runs that have not been claimed.
        if (event.state === 'pending' || event.state === 'in-flight' || event.state === undefined) {
            counts.set(event.bindingId, (counts.get(event.bindingId) ?? 0) + 1);
        }
    }

    return input.bindings.map((binding) => {
        const scan = scannedState.bindings[binding.bindingId];

        return {
            bindingId: binding.bindingId,
            repository: binding.repository,
            projectId: binding.projectId,
            accountLogin: binding.accountLogin,
            active: binding.state === 'active',
            lastScanAt: scan?.lastScanAt ?? null,
            lastError: scan?.lastError ?? null,
            pendingCount: counts.get(binding.bindingId) ?? 0,
        };
    });
}

/**
 * Answer `GET /v1/events/pending` with claimed runs and status.
 *
 * The claim is a lease, not a bare state flip (FR-030): every waiting run moves
 * to `claimed` under a fresh lease whose expiry comes from the service's own
 * clock, and the sweep recovers it if this panel never answers. Eligibility is
 * the service's alone (FR-037), so a run that is not waiting — or that already
 * produced a session — is simply absent from the answer.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the query may carry `holder`.
 * @returns `200 { events, status }`, or the documented 503.
 */
async function handlePendingEvents(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const claimed = await claimPendingRuns({
        store,
        log: context.log,
        holder: holderOf(request.url.searchParams.get('holder')),
    });
    const bindings = await readBindings({ store, log: context.log });
    const rows = await readStatusRows({ store, log: context.log, bindings });

    return { status: STATUS.ok, body: { events: claimed, status: rows } };
}

/**
 * Answer `POST /v1/events/:eventId/dispatched` by marking one event done.
 *
 * The panel's summary (the created session id, or a problem the panel reported)
 * is stored so the operator can trace a dispatch failure without a separate
 * runs list. A re-post for an id that is already marked answers `404
 * not-found` — `markEventDispatched` waits for a dispatch result only once —
 * as does an id the queue never held, the honest answer for a stale path the
 * panel re-posted later than the queue kept it.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the path captures `:eventId`.
 * @returns `200 { done: true }`, or the documented refusal.
 */
async function handleDispatchedEvent(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const eventId = pathEventId(request.params.eventId);
    if (eventId === null) {
        return errorResponse(STATUS.notFound, {
            code: 'not-found',
            message: 'the dispatch path carries no usable event id',
        });
    }

    const [sessionId, problem] = readDispatchFields(request.body);
    const summary = sessionId ?? problem;
    const marked = await markEventDispatched({ store, eventId, log: context.log, result: summary });
    if (marked === null) {
        return errorResponse(STATUS.notFound, {
            code: 'not-found',
            message: 'no event with this id is waiting for a dispatch result',
        });
    }

    if (problem !== null) {
        context.log.warn('panel reported a dispatch problem', { eventId: marked.id, problem });
    }

    return { status: STATUS.ok, body: { done: true } };
}

/**
 * Answer `GET /v1/events` with the runs history: every queued event, in any
 * state, newest detected first.
 *
 * This is the read-only counterpart to the panel's claim route — it never
 * flips a state, so it can be polled as often as the operator likes without
 * stealing events from a live relay. The answer is the credential-free
 * {@link EventRunRow} projection, capped at {@link MAX_LISTED_EVENTS} so one
 * long queue cannot flood a screen.
 *
 * @param context - Route context carrying the open store.
 * @returns `200 { events }`, or the documented 503.
 */
async function handleEventHistory(context: RouteContext): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const queue = await readEvents({ store, log: context.log });

    return { status: STATUS.ok, body: { events: recentRuns(queue) } };
}

/**
 * Answer `POST /v1/events/:eventId/retry` by returning one event to the
 * pending queue.
 *
 * Only a `pending` or `in-flight` event can be retried: the pending one is
 * already where a retry wants it (the answer stays `200` so a double click
 * is harmless), and the in-flight one loses its claim stamp and waits for
 * the next relay read. A dispatched event is terminal — the operator's own
 * dispatch is the record of what happened — so it answers `409` in the
 * envelope's `invalid-transition` voice, and an id the queue never held (or
 * that fell out of the dispatched tail) answers `404`.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the path captures `:eventId`.
 * @returns `200 { retried: true }`, or the documented refusal.
 */
async function handleRetryEvent(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const eventId = pathEventId(request.params.eventId);
    if (eventId === null) {
        return errorResponse(STATUS.notFound, {
            code: 'not-found',
            message: 'the retry path carries no usable event id',
        });
    }

    const outcome = await retryEvent({ store, eventId, log: context.log });
    if (outcome === 'unknown') {
        return errorResponse(STATUS.notFound, {
            code: 'not-found',
            message: 'no event with this id is in the queue',
        });
    }

    if (outcome === 'dispatched') {
        return errorResponse(STATUS.conflict, {
            code: 'invalid-transition',
            message: 'this event was already dispatched — a dispatched event cannot be retried',
        });
    }

    return { status: STATUS.ok, body: { retried: true } };
}

/** Claim and return every waiting run, each under a fresh lease. */
export const pendingEventsRoute: Route = {
    method: 'GET',
    path: EVENTS_PENDING_PATH,
    handler: (context, request) => handlePendingEvents(context, request),
};

/** Mark one claimed event dispatched on the panel's word. */
export const dispatchedEventRoute: Route = {
    method: 'POST',
    path: EVENT_DISPATCHED_PATH,
    handler: (context, request) => handleDispatchedEvent(context, request),
};

/** Read the runs history: every event, credential-free, newest first. */
export const eventHistoryRoute: Route = {
    method: 'GET',
    path: EVENTS_PATH,
    handler: (context) => handleEventHistory(context),
};

/** Return one non-dispatched event to the pending queue. */
export const retryEventRoute: Route = {
    method: 'POST',
    path: EVENT_RETRY_PATH,
    handler: (context, request) => handleRetryEvent(context, request),
};

/** Type used to note the queue shape the status row counts from. */
export type { QueueRow, BindingRecord };
