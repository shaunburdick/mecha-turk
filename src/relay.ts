/**
 * Panel event relay (003 T-021): claim runs, run them through the gates, and
 * hand each one to exactly one `host.startSession()` call.
 *
 * This module owns the **loop** — what a tick claims, which attempts this mount
 * has already made, and when polling starts. The steps of one attempt live in
 * the two modules it drives:
 *
 * ```text
 * relay.ts          claim → handled key → gates → attempt
 * relay-gates.ts    binding + project guards → POST …/blocked → POST …/reserve
 * relay-attempt.ts  host.startSession → record → POST …/dispatched → ack → verify
 * ```
 *
 * Four rules hold for the whole tick:
 *
 * - **Nothing is dispatched that was not offered claimed** (FR-035): the only
 *   source of work is this tick's own claim answer, and an entry whose lease
 *   will not parse is unreadable rather than dispatchable — the guard keys off
 *   `lease`, never off `state`, which only records the state the run was
 *   *offered* in.
 * - **No `host.startSession()` after any refusal** (FR-028's panel half): a
 *   refused guard, a refused reserve, or an unreadable authorization each end
 *   the attempt before the host is called.
 * - **The handled list is keyed `correlationId#attempt`** (FR-034): a failed
 *   result report never clears an entry and never authorizes a re-dispatch; a
 *   new lease and attempt arrive under a different key and are free to proceed.
 * - **A claim answer may be partial** (contract `claim-lease.md`): the service
 *   paginates, so a short answer is not "everything that was waiting". The
 *   panel simply polls again on its own clock, and `status.pendingCount` is the
 *   honest "more is waiting" signal the loop never second-guesses.
 *
 * **The follow-up deliveries ride this same tick.** A follow-up is a prompt into
 * a session the dispatch already created, so it needs no claim and no lease: the
 * rows arrive on the relay's **own** read of `GET /v1/events` — a
 * `state=dispatched`-filtered view this loop refreshes on its own clock
 * ({@link readFollowUpRows}), never the operator's paged list — and they are
 * delivered behind the same one-host-action-at-a-time gate. One timer issuing
 * host calls is one scheduler; a second loop would be two (research §R14.5),
 * and the retry ladder the service's own configuration declares is what paces
 * the repeats rather than a timer of this panel's (002 FR-105).
 *
 * After a report the relay also (M8) refreshes the runs history the Dispatches
 * section renders and (M9) reads back the dispatched session's agent —
 * warn-only, see `agent-verify.ts`. Each tick it also publishes what the
 * panel's durable record says about the follow-ups on those rows — the waiting
 * count the Status surface renders (002 FR-036) and the parked reasons the run
 * row names (002 FR-105) — so neither surface waits on an operator refresh to
 * tell the truth about the queue.
 */

import { refresh } from './panel-ui.ts';
import { parsePendingBody } from './claim-service.ts';
import type { ClaimAnswer, ClaimedRun } from './claim-service.ts';
import { EVENTS_PENDING_PATH, serviceGet } from './service-calls.ts';
import {
    RELAY_POLL_INTERVAL_MS,
    abandonReservation,
    guardRun,
    refuseWithBlocked,
    reserveRun,
    stillRunning,
} from './relay-gates.ts';
import { closeAttempt, startRunSession } from './relay-attempt.ts';
import {
    deliverFollowUp,
    isFollowUpDue,
    readFollowUpRetryPolicy,
    readFollowUpRows,
    trackCurrentSession,
} from './follow-up.ts';
import { followUpRecordOf, loadDispatchRecord } from './dispatch-record.ts';
import type { DispatchRecordDocument } from './dispatch-record.ts';
import { nowIso } from './ids.ts';
import { waitingFollowUps } from './dispatches-detail.ts';
import type { PanelRuntime } from './panel-state.ts';
import type { RunFollowUp, RunRow } from './dispatches-service.ts';

export { RELAY_POLL_INTERVAL_MS };

/**
 * The handled-list key for one offered attempt.
 *
 * Keyed by correlation id **and** attempt, so the service handing the same run
 * back under a new lease and a new attempt is a new key — and a failed report
 * under the old one is not a licence to dispatch it again.
 *
 * @returns `"<correlationId>#<attempt>"`.
 */
export function handledKey(run: Pick<ClaimedRun, 'correlationId' | 'attempt'>): string {
    return `${run.correlationId}#${run.attempt}`;
}

/**
 * Run one offered run's dispatch attempt end to end; never throws.
 *
 * Each gate ends the attempt on its own refusal, and every one of them ends it
 * **before** `host.startSession()` is reachable — which is the panel half of
 * FR-028's impossibility requirement.
 */
async function tryDispatch(input: { readonly rt: PanelRuntime; readonly run: ClaimedRun }): Promise<void> {
    const { rt, run } = input;
    const verdict = await guardRun(rt, run);
    if (verdict.kind === 'interrupted') {
        return;
    }

    if (verdict.kind === 'refused') {
        await refuseWithBlocked({ rt, run, failure: verdict.failure });

        return;
    }

    const reserved = await reserveRun(rt, run);
    if (reserved.kind === 'refused') {
        // The actor-policy gate's one refusal this panel owes a report for,
        //  posted through the operation every other guard already uses.
        // Every other refusal ends the attempt here, having written nothing.
        if (reserved.failure !== undefined) {
            await refuseWithBlocked({ rt, run, failure: reserved.failure });
        }

        return;
    }

    if (!stillRunning(rt)) {
        await abandonReservation({ rt, run, token: reserved.reservation.dispatchToken });

        return;
    }

    const started = await startRunSession({ rt, run, project: verdict.project });
    await closeAttempt({ rt, run, token: reserved.reservation.dispatchToken, started });
}

/**
 * Dispatch one claimed run; never throws.
 *
 * The dispatch guard is one observed handoff per `correlationId#attempt` per
 * mount, so a re-poll can never double-start the same attempt,
 * whatever the service did — and a failed report never clears the entry, so it
 * can never become a licence to dispatch it again.
 */
export async function dispatchClaimedRun(rt: PanelRuntime, run: ClaimedRun): Promise<void> {
    const key = handledKey(run);
    if (rt.disposed || rt.state.relay.dispatching || rt.state.busy || rt.state.relay.handled.includes(key)) {
        return;
    }

    rt.state.relay.handled = [...rt.state.relay.handled, key];
    rt.state.relay.dispatching = true;
    rt.state.busy = true;
    refresh(rt);

    try {
        await tryDispatch({ rt, run });
    } finally {
        rt.state.relay.dispatching = false;
        rt.state.busy = false;
        refresh(rt);
    }
}

/**
 * Claim one batch of runs from the service.
 *
 * The answer is bounded and paginated (contract `claim-lease.md`): a short
 * answer is not "everything that was waiting", so this reader never concludes
 * anything about work it was not offered — `status.pendingCount` carries that
 * signal, and the loop simply claims again on its own clock.
 *
 * @returns The claim answer, or `null` when the service refused or answered
 *   something this build must not act on.
 */
async function claimRuns(rt: PanelRuntime): Promise<ClaimAnswer | null> {
    const fetched = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: EVENTS_PENDING_PATH });
    if (!fetched.ok || !stillRunning(rt)) {
        return null;
    }

    const parsed = parsePendingBody(fetched.body);
    if (parsed === null) {
        rt.state.bindings.note = 'The service answered a claim the panel could not read — nothing was dispatched.';

        return null;
    }

    rt.state.bindings.statusRows = parsed.status;
    if (!parsed.auditWritten && parsed.runs.length > 0) {
        const leased = parsed.runs.length;
        rt.state.bindings.note = `The service leased ${leased} run(s) but could not record every claim row —`
            + ' the audit trail is short one row per run it named.';
    }

    return parsed;
}

/**
 * Whether one follow-up still needs an attempt from this panel.
 *
 * @returns `true` when the record is absent, due, and neither delivered nor parked.
 */
function isOutstanding(input: {
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly document: DispatchRecordDocument;
    readonly atMs: number;
}): boolean {
    const { row, followUp, document, atMs } = input;
    if (row.session === null) {
        return false;
    }

    const record = followUpRecordOf(document, followUp.deliveryId);

    return record === undefined || (!record.delivered && !record.parked && isFollowUpDue(record, atMs));
}

/**
 * Deliver one follow-up from the rows the relay's own read holds.
 *
 * The follow-up rides the relay's own view of the runs history — refreshed on
 * this loop's clock, never the operator's paged list — so this needs no claim
 * and no second read: the target session is the row's own
 * `session.sessionId`, and the durable record the panel keeps is what stops a
 * remount from sending the same delivery id twice (NFR-002).
 */
async function deliverOneFollowUp(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly document: DispatchRecordDocument;
}): Promise<void> {
    const { rt, row, followUp, document } = input;
    const record = followUpRecordOf(document, followUp.deliveryId);
    const policy = await readFollowUpRetryPolicy(rt.host.serviceRequest);
    await deliverFollowUp({
        rt,
        row,
        followUp,
        attempt: record?.attempt === undefined ? 1 : record.attempt + 1,
        policy,
    });
}

/**
 * Deliver one waiting follow-up, and hand the record back for the surfaces.
 *
 * One per tick, behind the same gate a dispatch attempt uses: the host is called
 * for exactly one thing at a time, and the retry ladder paces the rest across
 * later ticks rather than a second timer (FR-104, FR-105).
 *
 * @returns The record document this tick read, or `null` when it could not be
 *   read — in which case nothing was delivered either, and the caller keeps
 *   whatever the previous tick published.
 */
async function deliverFollowUps(rt: PanelRuntime): Promise<DispatchRecordDocument | null> {
    const read = await loadDispatchRecord(rt);
    if (!read.ok) {
        // A record this build cannot read is not a licence to deliver: the panel
        // would have no way to know it had already sent this follow-up, and a
        // duplicate prompt is the failure direction the whole design exists to
        // prevent (NFR-002).
        rt.state.relay.lastError = 'the panel could not read its own delivery record; no follow-up was delivered';

        return null;
    }

    const atMs = Date.now();
    const next = rt.state.relay.followUpRows
        .flatMap((row) => (row.followUps ?? []).map((followUp) => ({ row, followUp })))
        .find((candidate) => isOutstanding({
            row: candidate.row,
            followUp: candidate.followUp,
            document: read.document,
            atMs,
        }));
    if (next === undefined || rt.disposed || rt.state.relay.dispatching || rt.state.busy) {
        return read.document;
    }

    rt.state.relay.dispatching = true;
    rt.state.busy = true;
    refresh(rt);
    try {
        await deliverOneFollowUp({ rt, row: next.row, followUp: next.followUp, document: read.document });
    } finally {
        rt.state.relay.dispatching = false;
        rt.state.busy = false;
        refresh(rt);
    }

    // The attempt just wrote its outcome, so the document this tick started
    // with is stale for the surfaces: publishing it would report a waiting
    // follow-up that has just been delivered, which is the false claim
    // FR-036's amended clause forbids. Read it back — and if the read-back
    // fails, fall back to the document that was read rather than to nothing.
    const settled = await loadDispatchRecord(rt);

    return settled.ok ? settled.document : read.document;
}

/**
 * Publish what the panel's durable record says about the follow-ups it holds.
 *
 * Two surfaces read it, and both would otherwise wait on an operator refresh to
 * tell the truth: the Status surface's waiting count (002 FR-036) and the run
 * row's parked reason (002 FR-105). The relay is the publisher because it is the
 * one loop that holds the complete runs view and the record on the same tick —
 * an operator refresh of the Dispatches list publishes the same view through
 * `loadDispatches`.
 *
 * @param rt - Panel runtime whose dispatches slice and relay state are written.
 * @param document - The record document this tick read.
 */
function publishFollowUpState(rt: PanelRuntime, document: DispatchRecordDocument): void {
    const records = document.followUps ?? [];
    rt.state.dispatches.followUpRecords = records;
    rt.state.relay.waitingFollowUps = waitingFollowUps(rt.state.relay.followUpRows, records);
}

/**
 * One relay tick: claim, dispatch each, refresh the follow-up view, deliver one
 * follow-up, and repaint. Never throws.
 */
export async function pollRelay(rt: PanelRuntime): Promise<void> {
    if (rt.disposed || rt.state.relay.inFlight || rt.state.busy) {
        return;
    }

    rt.state.relay.inFlight = true;
    try {
        const claim = await claimRuns(rt);
        if (claim !== null && stillRunning(rt)) {
            for (const run of claim.runs) {
                await dispatchClaimedRun(rt, run);
            }
        }

        // The relay's own view, refreshed after the dispatch phase: a session
        // created by an attempt this very tick is what makes the follow-ups
        // waiting for it deliverable, so the read comes after the dispatches
        // and before the delivery.
        await readFollowUpRows(rt);

        if (stillRunning(rt)) {
            rt.state.relay.lastPollAt = nowIso();
        }

        // The follow-ups ride the rows this tick just read, and they are
        // delivered only once no dispatch attempt is in flight (FR-104).
        const document = await deliverFollowUps(rt);
        if (document !== null) {
            publishFollowUpState(rt, document);
        }
    } finally {
        rt.state.relay.inFlight = false;
        refresh(rt);
    }
}

/**
 * Arm the relay loop: one immediate poll, then the interval.
 *
 * Mount-time reconciliation settles first: while it is running this
 * call only records the intent, and reconciliation releases it once every
 * outstanding attempt has been re-reported. That makes "no claim before
 * reconciliation" a property of the arm itself rather than of whichever call
 * site happens to reach here first — there are three of them (connection,
 * mount-time bindings, every later read or grant).
 *
 * The timer is unref'd, so it never keeps an idle process alive; teardown
 * clears it through {@link stopRelayPolling}.
 */
export function startRelayPolling(rt: PanelRuntime): void {
    if (rt.relayArmed || rt.disposed) {
        return;
    }

    if (!rt.reconcileSettled) {
        rt.relayArmPending = true;

        return;
    }

    rt.relayArmed = true;
    // The host's current session is the one fact the follow-up delivery needs and
    // cannot ask for: it is what makes "no navigation when the target is already
    // current" a property of the design rather than of luck (002 FR-104).
    rt.unsubscribes.push(trackCurrentSession(rt));
    rt.state.relay.timer = setInterval(() => {
        void pollRelay(rt);
    }, RELAY_POLL_INTERVAL_MS);
    if (typeof rt.state.relay.timer.unref === 'function') {
        rt.state.relay.timer.unref();
    }

    void pollRelay(rt);
}

/**
 * Open the reconcile gate and release whatever arming it deferred.
 *
 * The gate is what makes "no claim before reconciliation" a property of the
 * arm rather than of the call site that happens to reach it first: any of the
 * three arming sites may ask while `app.ts` is still re-reporting outstanding
 * attempts, and each one only records its intent until this runs.
 */
export function settleReconciliation(rt: PanelRuntime): void {
    rt.reconcileSettled = true;
    if (!rt.relayArmPending || rt.disposed) {
        return;
    }

    rt.relayArmPending = false;
    startRelayPolling(rt);
}

/** Stop the relay loop. */
export function stopRelayPolling(rt: PanelRuntime): void {
    rt.relayArmed = false;
    if (rt.state.relay.timer === null) {
        return;
    }

    clearInterval(rt.state.relay.timer);
    rt.state.relay.timer = null;
}
