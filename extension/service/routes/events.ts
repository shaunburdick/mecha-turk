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

import { nowIso } from '../../src/ids.ts';
import { readBindings } from '../bindings.ts';
import {
    claimPendingEvents,
    markEventDispatched,
    readEvents,
} from '../poll/events.ts';
import { readScanState } from '../poll/scan.ts';
import type { BindingRecord } from '../bindings.ts';
import type { QueuedEvent } from '../poll/events.ts';
import { errorResponse, STATUS, storageUnavailableResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceStore } from '../store/index.ts';
import type { ServiceLogger } from '../log.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path the panel polls for queued events. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/** Path pattern the panel reports one dispatch through. */
export const EVENT_DISPATCHED_PATH = '/v1/events/:eventId/dispatched';

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
        if (event.state === 'pending' || event.state === 'in-flight') {
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
 * Answer `GET /v1/events/pending` with claimed queue events and status.
 *
 * @param context - Route context carrying the open store.
 * @returns `200 { events, status }`, or the documented 503.
 */
async function handlePendingEvents(context: RouteContext): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const claimed = await claimPendingEvents({ store, log: context.log, claimedAt: nowIso() });
    const bindings = await readBindings({ store, log: context.log });
    const rows = await readStatusRows({ store, log: context.log, bindings });

    return { status: STATUS.ok, body: { events: claimed, status: rows } };
}

/**
 * Answer `POST /v1/events/:eventId/dispatched` by marking one event done.
 *
 * The panel's summary (the created session id, or a problem the panel reported)
 * is stored so the operator can trace a dispatch failure without a separate
 * runs list. An unknown id still answers `200` when the id has already been
 * marked — the review contract wanted idempotency — but an id that is not in
 * the queue at all is `404 unknown-event`, which is the honest answer for a
 * stale path the panel re-posted later than the queue kept it.
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

/** Claim and return every pending event. */
export const pendingEventsRoute: Route = {
    method: 'GET',
    path: EVENTS_PENDING_PATH,
    handler: (context) => handlePendingEvents(context),
};

/** Mark one claimed event dispatched on the panel's word. */
export const dispatchedEventRoute: Route = {
    method: 'POST',
    path: EVENT_DISPATCHED_PATH,
    handler: (context, request) => handleDispatchedEvent(context, request),
};

/** Type used to note the queue shape the status row counts from. */
export type { QueueRow, BindingRecord };
