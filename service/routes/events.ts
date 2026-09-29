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
 * `GET /v1/events` projects every event — pending, in-flight, and dispatched
 * alike — newest detected first without claiming anything. It still reads the
 * *delivery* queue: the run-shaped history projection that replaces it is T-016's
 * work, and the delivery routes are not retired by the run layer.
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
 */

import { readBindings } from '../bindings.ts';
import { MAX_CLAIMED_RUNS } from '../poll/claim-bounds.ts';
import { claimPendingRuns, holderOf } from '../poll/claim.ts';
import { readEvents } from '../poll/events.ts';
import { previewRunsDocument } from '../poll/runs-document.ts';
import { readScanState } from '../poll/scan.ts';
import type { BindingRecord } from '../bindings.ts';
import type { EventKind, EventState, QueuedEvent } from '../poll/events.ts';
import { STATUS, storageUnavailableResponse, validationResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceStore } from '../store/index.ts';
import type { ServiceLogger } from '../log.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path the panel polls for queued events. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/** Path of the runs history: every event, every state, newest detected first. */
export const EVENTS_PATH = '/v1/events';

/** How many events the runs history answers with (newest detected first). */
export const MAX_LISTED_EVENTS = 100;

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
        };
    });
}

/**
 * Answer `GET /v1/events/pending` with claimed runs and status.
 *
 * The claim is a lease, not a bare state flip (FR-030): every run this page
 * offers moves to `claimed` under a fresh lease whose expiry comes from the
 * service's own clock, and the sweep recovers it if this panel never answers.
 * Eligibility is the service's alone (FR-037), so a run that is not waiting —
 * or that already produced a session — is simply absent from the answer.
 *
 * The answer is **bounded and paginated** (T-039): the claim leases at most
 * `MAX_CLAIMED_RUNS` runs and at most the documented byte budget, and anything
 * beyond that stays `pending` and unleased for the panel's next call. The
 * status rows carry the true per-binding pending count, so a panel can see
 * that more work is waiting without the lease burning (FR-036).
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
    handler: (context) => handleEventHistory(context),
};

/** Type used to note the queue shape the status row counts from. */
export type { QueueRow, BindingRecord };
