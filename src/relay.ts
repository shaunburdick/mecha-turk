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
 * After a report the relay also (M8) refreshes the runs history the Runs
 * section renders and (M9) reads back the dispatched session's agent —
 * warn-only, see `agent-verify.ts`.
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
import { nowIso } from './ids.ts';
import type { PanelRuntime } from './panel-state.ts';

export { RELAY_POLL_INTERVAL_MS };

/**
 * The handled-list key for one offered attempt (FR-034).
 *
 * Keyed by correlation id **and** attempt, so the service handing the same run
 * back under a new lease and a new attempt is a new key — and a failed report
 * under the old one is not a licence to dispatch it again.
 *
 * @param run - The offered run.
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
 *
 * @param input - Runtime and the run to try.
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
    if (reserved === null) {
        return;
    }

    if (!stillRunning(rt)) {
        await abandonReservation({ rt, run, token: reserved.dispatchToken });

        return;
    }

    const started = await startRunSession({ rt, run, project: verdict.project });
    await closeAttempt({ rt, run, token: reserved.dispatchToken, started });
}

/**
 * Dispatch one claimed run; never throws.
 *
 * The dispatch guard is one observed handoff per `correlationId#attempt` per
 * mount (FR-034), so a re-poll can never double-start the same attempt,
 * whatever the service did — and a failed report never clears the entry, so it
 * can never become a licence to dispatch it again.
 *
 * @param rt - Panel runtime.
 * @param run - The run to dispatch.
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
 * @param rt - Panel runtime.
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
        rt.state.repos.note = 'The service answered a claim the panel could not read — nothing was dispatched.';

        return null;
    }

    rt.state.repos.statusRows = parsed.status;
    if (!parsed.auditWritten && parsed.runs.length > 0) {
        rt.state.repos.note = `The service leased ${parsed.runs.length} run(s) but could not record every claim row —`
            + ' the audit trail is short one row per run it named.';
    }

    return parsed;
}

/**
 * One relay tick: claim, dispatch each, and repaint. Never throws.
 *
 * @param rt - Panel runtime.
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

        if (stillRunning(rt)) {
            rt.state.relay.lastPollAt = nowIso();
        }
    } finally {
        rt.state.relay.inFlight = false;
        refresh(rt);
    }
}

/**
 * Arm the relay loop: one immediate poll, then the interval.
 *
 * Mount-time reconciliation settles first (FR-025): while it is running this
 * call only records the intent, and reconciliation releases it once every
 * outstanding attempt has been re-reported. That makes "no claim before
 * reconciliation" a property of the arm itself rather than of whichever call
 * site happens to reach here first — there are three of them (connection,
 * mount-time bindings, every later read or grant).
 *
 * The timer is unref'd, so it never keeps an idle process alive; teardown
 * clears it through {@link stopRelayPolling}.
 *
 * @param rt - Panel runtime.
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
    rt.state.relay.timer = setInterval(() => {
        void pollRelay(rt);
    }, RELAY_POLL_INTERVAL_MS);
    if (typeof rt.state.relay.timer.unref === 'function') {
        rt.state.relay.timer.unref();
    }

    void pollRelay(rt);
}

/**
 * Open the reconcile gate and release whatever arming it deferred (FR-025).
 *
 * The gate is what makes "no claim before reconciliation" a property of the
 * arm rather than of the call site that happens to reach it first: any of the
 * three arming sites may ask while `app.ts` is still re-reporting outstanding
 * attempts, and each one only records its intent until this runs.
 *
 * @param rt - Panel runtime.
 */
export function settleReconciliation(rt: PanelRuntime): void {
    rt.reconcileSettled = true;
    if (!rt.relayArmPending || rt.disposed) {
        return;
    }

    rt.relayArmPending = false;
    startRelayPolling(rt);
}

/**
 * Stop the relay loop.
 *
 * @param rt - Panel runtime.
 */
export function stopRelayPolling(rt: PanelRuntime): void {
    rt.relayArmed = false;
    if (rt.state.relay.timer !== null) {
        clearInterval(rt.state.relay.timer);
        rt.state.relay.timer = null;
    }
}
