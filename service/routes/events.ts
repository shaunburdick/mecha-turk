/**
 * The event relay routes (003; MVP tasks M2/M8): the run claim, the run
 * projection behind `GET /v1/events`, and the per-binding scan status.
 */

import { effectiveHistoryScope } from '../bindings-history-scope.ts';
import { readBindings } from '../bindings-read.ts';
import { MAX_CLAIMED_RUNS } from '../poll/claim-bounds.ts';
import { claimPendingRuns, holderOf } from '../poll/claim.ts';
import { readCycleConfig } from '../poll/cycle-config.ts';
import { readEvents } from '../poll/events.ts';
import { projectRunHistory } from '../poll/run-history-project.ts';
import { previewRunsDocument } from '../poll/runs-document.ts';
import { bindingScanOf, readScanState } from '../poll/scan.ts';
import { windowFor } from '../poll/window.ts';
import type { BindingRecord } from '../bindings.ts';
import type { HistoryScope } from '../bindings-history-scope.ts';
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

type QueueRow = Pick<QueuedEvent, 'id' | 'bindingId' | 'state'>;

export interface BindingStatusRow {
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    readonly projectId: string;
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
     * Derived here, from the binding this row is already built from, so the
     * Status route, the claim answer and the Bindings tab all read one
     * projection. `'restricted'` therefore always means *at least one* login:
     * the service refuses an empty list on write **and** on read, so no
     * permitted login is needed — or permitted — to answer it.
     */
    readonly actorPolicy: ActorPolicy;
    /**
     * The lower bound the binding's next scan will open at, as the service
     * computed it (002 FR-092, FR-065). **Derived state, never configured**:
     * the operator sets the history scope, this row reports what the service
     * made of it. `null` means no window yet (no completed scan and no
     * derivable baseline), with the refusal on
     * {@link BindingStatusRow.lastError}; both window ends are readable
     * together: this, and `lastScanAt`.
     */
    readonly windowStart: string | null;
    /**
     * The history scope in force, as the service holds it (002 FR-055, FR-092).
     *
     * The **documented default** is projected for a binding that stores no
     * member, so the operator's surface renders from one source of truth and
     * never invents a reading of an absent key (002 FR-058; plan H13).
     */
    readonly historyScope: HistoryScope;
    /**
     * Whether a **recovery replay** is in force for this binding: its checkpoint
     * was cleared to recover a lost or quarantined queue (002 FR-074, FR-078).
     *
     * Separate from `lastScanAt === null`, which also means *never scanned*: the
     * two are different facts with different windows, and while this is `true` the
     * binding is re-offering in-window work because the queue was lost — not
     * because the operator chose a look-back.
     */
    readonly forceReplay: boolean;
}

/**
 * The allow-list shape one binding's row reports.
 *
 * **Absent is open**: no `allowedUsers` member is the complete "no policy
 * configured" state, meaning any human actor may trigger this repository.
 * A present member is a non-empty list by the same rule that
 * refuses `[]`, so it is always `'restricted'`.
 */
function actorPolicyOf(binding: BindingRecord): ActorPolicy {
    return binding.allowedUsers === undefined ? 'open' : 'restricted';
}

/**
 * Read the claim's `limit` parameter, refusing anything over the cap: the
 * cap is the service's, not the caller's, and answering a larger one as
 * though it could be satisfied is exactly the T-039 failure in a new dress.
 * Absent or unparseable values take the documented default; an out-of-range
 * one is a client error naming the field and the fix, never the received
 * value (SEC-10/11).
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
 * Read the per-binding status rows: one row per stored binding, built from
 * the scan state and the **run** document so every status-reporting route
 * answers the same shape, with `pendingCount` counting runs in `state ===
 * 'pending'` only (T-040a). `windowStart`, `historyScope` and `forceReplay`
 * come from the same {@link windowFor} verdict the scan opens under, so the
 * row cannot disagree with the loop (002 FR-092, FR-078); a `null` on each
 * means no window yet, and the refusal is already on `lastError`.
 */
export async function readStatusRows(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** Stored bindings, as the route itself read them. */
    readonly bindings: readonly BindingRecord[];
    /** Configured overlap, so the row reports the same widening the scan applies. */
    readonly overlapMs: number;
}): Promise<BindingStatusRow[]> {
    const [scannedState, runs] = await Promise.all([readScanState(input), previewRunsDocument(input)]);

    const counts = new Map<string, number>();
    for (const run of runs.runs) {
        if (run.state === 'pending') {
            counts.set(run.bindingId, (counts.get(run.bindingId) ?? 0) + 1);
        }
    }

    return input.bindings.map((binding) => {
        const scan = bindingScanOf(scannedState, binding.bindingId);
        // The **same** verdict the next scan opens under, from the same rule and
        // the same slot — the row says what the next scan will do because it reads
        // what the next scan will read (002 FR-092). The history scope is read here
        // only to report which rule is in force; `windowFor` consumed it, through
        // the baseline the loop already derived (002 FR-068).
        const verdict = windowFor({ binding, scanned: scan, overlapMs: input.overlapMs });

        return {
            bindingId: binding.bindingId,
            repository: binding.repository,
            projectId: binding.projectId,
            accountLogin: binding.accountLogin,
            active: binding.state === 'active',
            lastScanAt: scan.lastScanAt,
            lastError: scan.lastError,
            pendingCount: counts.get(binding.bindingId) ?? 0,
            actorPolicy: actorPolicyOf(binding),
            windowStart: 'window' in verdict ? verdict.window : null,
            historyScope: effectiveHistoryScope(binding.historyScope),
            forceReplay: scan.forceReplay,
        };
    });
}

/**
 * Answer `GET /v1/events/pending` with claimed runs and status. The claim is
 * a lease, not a state flip, and it is **bounded and paginated**: at most
 * `MAX_CLAIMED_RUNS` runs and the documented byte budget, so anything beyond
 * stays `pending` and unleased for the next call. Eligibility is the
 * service's alone. `auditWritten: false` means the leases are durable and
 * the `dispatch.claimed` rows are not, so the panel warns rather than
 * implying traceability it does not have (FR-063).
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
    // The overlap comes from the configuration this answer reports against, so
    // `windowStart` is the window a scan run right now would open — not one
    // widened by a different number (002 FR-092).
    const { overlapMs } = await readCycleConfig({ store, log: context.log });
    const rows = await readStatusRows({ store, log: context.log, bindings, overlapMs });

    return {
        status: STATUS.ok,
        body: { events: claimed.runs, status: rows, auditWritten: claimed.auditWritten },
    };
}

/**
 * Project the whole history in the retained order. The run document is read
 * **first and directly**, because that is the reader that runs the one-shot
 * legacy adoption — a store upgraded moments ago must answer with its
 * adopted rows rather than an empty list — and an unreadable document throws
 * `StorageUnavailableError`, which the pipeline maps to the contract's only
 * refusal, `503 storage-unavailable`, instead of an empty history a
 * constitution-II reading forbids. `followUpsFrom` is passed through
 * unchanged: a `null` reaches the projection as no window position at all.
 */
async function projectHistory(
    context: RouteContext,
    store: ServiceStore,
    followUpsFrom: string | null,
): Promise<readonly RunHistoryRow[]> {
    const document = await previewRunsDocument({ store, log: context.log });
    const queue = await readEvents({ store, log: context.log });

    return projectRunHistory({
        runs: document.runs,
        deliveries: new Map(queue.map((event) => [event.id, event])),
        // The whole projection: the cap is a page size now, not a wall.
        cap: document.runs.length,
        followUpsFrom,
    }).toSorted(newestFirst);
}

/**
 * Answer `GET /v1/events` with one page of the runs history. The read never
 * flips a state, so it can be polled as often as the operator likes without
 * stealing runs from a live relay; the query is validated before any
 * document is read and the order is the retained one. `followUpsFrom`
 * reaches the projection and nothing else (002 v1.16.0): no path, method,
 * status, error code, or answer member changes, so a caller that omits it
 * reads exactly what it read before the parameter existed.
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
    const rows = await projectHistory(context, store, query.followUpsFrom);

    const filtered = rows.filter((row) => matchesFilters(row, query));
    const { boundary } = query;
    const remaining = boundary === null ? filtered : filtered.filter((row) => afterBoundary(row, boundary));
    const window = remaining.slice(0, query.limit + 1);
    const hasMore = window.length > query.limit;
    const events = window.slice(0, query.limit);
    const last = events.at(-1);

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

export type { QueueRow, BindingRecord };
