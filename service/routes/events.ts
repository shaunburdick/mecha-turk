/**
 * The event relay routes (003; MVP tasks M2/M8 re-cut 2026-09-27).
 *
 * `GET /v1/events/pending` is no longer the MVP cut's bare state flip. It
 * **claims runs**: every run the service alone finds waiting moves `pending →
 * claimed` under a fresh lease (id, attempt, issue stamp, expiry, holder), and
 * the answer is the run projection the contract lists, bounded and paginated so
 * a lease is never written for a run the answer cannot carry (FR-030, FR-037,
 * T-039). The lease is a fencing token, not a capability — the service's bearer
 * token is the only authentication gate — and the sweep recovers an expired
 * lease with no panel action.
 *
 * `GET /v1/events` projects **runs** — the widened history row of
 * [contracts/run-history-audit.md](../../specs/003-dispatch-integrity/contracts/run-history-audit.md)
 * §1: state and reason, run key, ordinal, attempt, attachment id, the
 * snapshotted target, lease expiry, source references with their counting
 * members, session pointer, verification outcome — newest detected first,
 * capped, without claiming anything (T-016). The projection itself lives in
 * [`run-history-project.ts`](../poll/run-history-project.ts) beside the claim's,
 * so this file stays a route; the delivery queue is read only for the members a
 * run does not store (title, canonical link, PR coordinates).
 *
 * **The two delivery-scoped mutations this file used to hold are gone.** 003's
 * wire delta addresses a dispatch outcome and an operator retry **by the run, not
 * the delivery** (`contracts/dispatch-authorization.md`): a post-003 delivery
 * carries no lifecycle field of its own — its truth lives on the run
 * (data-model §2.1) — so `POST /v1/events/:eventId/dispatched` could only ever
 * answer `404` for real work, and `POST /v1/events/:eventId/retry` had nothing to
 * reset. They are answered instead by [`dispatch.ts`](./dispatch.ts) and
 * [`run-ops.ts`](./run-ops.ts), under `/v1/events/:correlationId/…`.
 *
 * The same `GET /v1/events/pending` response carries the per-binding scan status
 * the panel's status line renders, because the panel polls this route on its
 * own clock and the status has no other surface yet (the contract's
 * `/v1/status` repositories section is 005's work). Its `pendingCount` counts
 * runs, not deliveries (T-040a).
 *
 * Those rows also carry each binding's **actor-policy shape** (005 FR-093,
 * added at v1.11.0) — `'open' | 'restricted'`, never a login. It is derived in
 * the same projection from the same binding the row is already built from, so
 * the claim answer, the Bindings tab, and `/v1/status` cannot disagree about a
 * binding's policy (005 plan D17; contract `status-projection.md` §8).
 */

import { readBindings } from '../bindings-read.ts';
import { MAX_CLAIMED_RUNS } from '../poll/claim-bounds.ts';
import { claimPendingRuns, holderOf } from '../poll/claim.ts';
import { readEvents } from '../poll/events.ts';
import { projectRunHistory } from '../poll/run-history-project.ts';
import { previewRunsDocument } from '../poll/runs-document.ts';
import { readScanState } from '../poll/scan.ts';
import type { BindingRecord } from '../bindings.ts';
import type { QueuedEvent } from '../poll/events.ts';
import type { ActorPolicy } from '../poll/runs-types.ts';
import type { RunHistoryRow } from '../poll/run-history-project.ts';
import { STATUS, storageUnavailableResponse, validationResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceStore } from '../store/index.ts';
import type { ServiceLogger } from '../log.ts';
import {
    MAX_PAGE_SIZE,
    afterBoundary,
    buildEventPage,
    encodeBoundary,
    listQueryOf,
    matchesFilters,
    newestFirst,
} from './events-page.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path the panel polls for queued events. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/** Path of the runs history: every event, every state, newest detected first. */
export const EVENTS_PATH = '/v1/events';

/**
 * How many events the runs history answered with before paging (contract §0).
 *
 * The shipped 100-row cap is the **maximum page size** now: the 101st
 * dispatch is reachable through the cursor, and this name is kept
 * because the contract set and the tests read it.
 */
export const MAX_LISTED_EVENTS = MAX_PAGE_SIZE;

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
    /**
     * The **shape** of this binding's actor allow-list, never its contents.
     *
     *
     * Derived here, from the binding this row is already built from, so the
     * Status route, the claim answer, and the Bindings tab all read one
     * projection and one source for the fact. `'restricted'`
     * therefore always means *at least one* login: the service refuses an empty
     * list on write **and** on read, so no permitted login is
     * needed — or permitted — to answer it.
     */
    readonly actorPolicy: ActorPolicy;
}

/**
 * The allow-list shape one binding's row reports.
 *
 * **Absent is open**: no `allowedUsers` member is the complete "no policy
 * configured" state, meaning any human actor may trigger this repository.
 * A present member is a non-empty list by the same rule that
 * refuses `[]`, so it is always `'restricted'`.
 *
 * @param binding - The binding this row is keyed by.
 * @returns `'open'` when the binding carries no list, `'restricted'` when it does.
 */
function actorPolicyOf(binding: BindingRecord): ActorPolicy {
    return binding.allowedUsers === undefined ? 'open' : 'restricted';
}

/**
 * Read the claim's `limit` parameter, refusing anything over the cap.
 *
 * The cap is the service's, not the caller's: a limit above
 * {@link MAX_CLAIMED_RUNS} is a request this answer could never satisfy, and
 * answering it as though it could is exactly the T-039 failure in a new dress.
 * Absent or unparseable values take the documented default; an out-of-range one
 * is a client error naming the field and the fix, never the received value
 * (SEC-10/11).
 *
 * @param raw - The query parameter as it arrived, or `null` when absent.
 * @returns The page size to ask for, or `null` when it exceeds the cap.
 */
function claimLimitOf(raw: string | null): number | null {
    if (raw === null || raw === '') {
        return MAX_CLAIMED_RUNS;
    }

    if (!/^[0-9]{1,6}$/.test(raw)) {
        return null;
    }

    const limit = Number(raw);

    return limit >= 1 && limit <= MAX_CLAIMED_RUNS ? limit : null;
}

/**
 * Read the per-binding status rows.
 *
 * One row per stored binding, built from the scan state and the **run**
 * document, so every route that reports status (the relay's pending answer and
 * the bindings collection) answers the panel's parser with the same shape. The
 * caller passes the bindings it already read, so one collection read never
 * happens twice inside a single request.
 *
 * `pendingCount` counts runs in `state === 'pending'` and nothing else (T-040a).
 * It used to count delivery rows, which is wrong in two directions after the
 * run layer landed: a post-003 delivery carries no lifecycle state of its own,
 * so every completed run's deliveries kept counting and the number grew with
 * finished work while never falling below the truth. The contract promised a
 * count derived from runs, and that is what this reads — the same document the
 * claim answers from, so the two can never disagree.
 *
 * @param input - Store, logger, and the bindings every row is keyed by.
 * @returns One row per binding, with scan state and pending count.
 * @throws {StorageUnavailableError} When the run document cannot be read.
 */
export async function readStatusRows(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Stored bindings, as the route itself read them. */
    readonly bindings: readonly BindingRecord[];
}): Promise<BindingStatusRow[]> {
    const [scannedState, runs] = await Promise.all([readScanState(input), previewRunsDocument(input)]);

    const counts = new Map<string, number>();
    for (const run of runs.runs) {
        if (run.state === 'pending') {
            counts.set(run.bindingId, (counts.get(run.bindingId) ?? 0) + 1);
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
            actorPolicy: actorPolicyOf(binding),
        };
    });
}

/**
 * Answer `GET /v1/events/pending` with claimed runs and status.
 *
 * The claim is a lease, not a bare state flip: every run this page
 * offers moves to `claimed` under a fresh lease whose expiry comes from the
 * service's own clock, and the sweep recovers it if this panel never answers.
 * Eligibility is the service's alone, so a run that is not waiting —
 * or that already produced a session — is simply absent from the answer.
 *
 * The answer is **bounded and paginated**: the claim leases at most
 * `MAX_CLAIMED_RUNS` runs and at most the documented byte budget, and anything
 * beyond that stays `pending` and unleased for the panel's next call. The
 * status rows carry the true per-binding pending count, so a panel can see
 * that more work is waiting without the lease burning.
 *
 * `auditWritten` reports FR-063's operator-visible surfacing: `false` means the
 * leases are durable and the `dispatch.claimed` rows are not, and the panel
 * warns rather than implying traceability it does not have.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the query may carry `holder` and `limit`.
 * @returns `200 { events, status, auditWritten }`, or the documented 422/503.
 */
async function handlePendingEvents(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const limit = claimLimitOf(request.url.searchParams.get('limit'));
    if (limit === null) {
        return validationResponse([{
            field: 'limit',
            remediation: `ask for at most ${MAX_CLAIMED_RUNS} runs per claim; `
                + 'the rest stay claimable for the next call',
        }]);
    }

    const claimed = await claimPendingRuns({
        store,
        log: context.log,
        holder: holderOf(request.url.searchParams.get('holder')),
        maxRuns: limit,
    });
    const bindings = await readBindings({ store, log: context.log });
    const rows = await readStatusRows({ store, log: context.log, bindings });

    return {
        status: STATUS.ok,
        body: { events: claimed.runs, status: rows, auditWritten: claimed.auditWritten },
    };
}

/**
 * Project the whole history in the retained order.
 *
 * The run document is read **first and directly**: it is the reader that runs
 * the one-shot legacy adoption, so a store upgraded moments ago
 * answers with its adopted rows rather than with an empty list. An unreadable
 * document throws `StorageUnavailableError`, which the pipeline maps to the
 * contract's only refusal — `503 storage-unavailable` — instead of inventing an
 * empty history a constitution-II reading would forbid.
 *
 * @param context - Route context carrying the structured logger.
 * @param store - Open store.
 * @returns Every retained run's row, newest detected first with the tiebreak.
 */
async function projectHistory(
    context: RouteContext,
    store: ServiceStore,
): Promise<readonly RunHistoryRow[]> {
    const document = await previewRunsDocument({ store, log: context.log });
    const queue = await readEvents({ store, log: context.log });

    return projectRunHistory({
        runs: document.runs,
        deliveries: new Map(queue.map((event) => [event.id, event])),
        // The whole projection: the cap is a page size now, not a wall.
        cap: document.runs.length,
    }).sort(newestFirst);
}

/**
 * Answer `GET /v1/events` with one page of the runs history.
 *
 * The read is read-only: it never flips a state, so it can be polled as often
 * as the operator likes without stealing runs from a live relay. The query is
 * validated before any document is read, the order is the retained one, and
 * the answer carries the `page` member beside the rows.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the query may carry `limit`, `cursor`,
 *   `bindingId`, and `state`.
 * @returns `200 { events, page }`, or the documented 422/503.
 */
async function handleEventHistory(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const parsed = listQueryOf(request);
    if (!parsed.ok) {
        return parsed.response;
    }

    const { query } = parsed;
    const rows = await projectHistory(context, store);

    const filtered = rows.filter((row) => matchesFilters(row, query));
    const { boundary } = query;
    const remaining = boundary === null ? filtered : filtered.filter((row) => afterBoundary(row, boundary));
    const window = remaining.slice(0, query.limit + 1);
    const hasMore = window.length > query.limit;
    const events = window.slice(0, query.limit);
    const last = events[events.length - 1];

    return {
        status: STATUS.ok,
        body: {
            events,
            page: buildEventPage({
                limit: query.limit,
                nextCursor: hasMore && last !== undefined ? encodeBoundary(last) : null,
                hasMore,
                total: filtered.length,
                snapshotAt: new Date().toISOString(),
                filter: { bindingId: query.bindingId === '' ? null : query.bindingId, state: query.state },
            }),
        },
    };
}

/** Claim and return every waiting run, each under a fresh lease. */
export const pendingEventsRoute: Route = {
    method: 'GET',
    path: EVENTS_PENDING_PATH,
    handler: (context, request) => handlePendingEvents(context, request),
};

/** Read the runs history: every event, credential-free, newest first. */
export const eventHistoryRoute: Route = {
    method: 'GET',
    path: EVENTS_PATH,
    handler: (context, request) => handleEventHistory(context, request),
};

/** Type used to note the queue shape the status row counts from. */
export type { QueueRow, BindingRecord };
