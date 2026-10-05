/**
 * The run store's pure state transitions (003 §1, FR-030–FR-033).
 *
 * Every transition is a function from one run to the next, or `null` when the
 * run is not in a state that transition accepts. The async transitions in
 * `runs.ts` are these functions wrapped in the store's chain and write; the
 * batch paths — the claim route and the sweep — call them directly, because a
 * batch must read and write `runs.json` once, which means it cannot afford one
 * chain round trip per run.
 *
 * Keeping the definitions here is what stops those two from drifting: there is
 * exactly one definition of "a lease expired with no reservation", and the
 * batch that reclaims a hundred stranded claims applies the same rule the
 * single-run path does.
 *
 * Refusals are silent by design — the run simply does not change — and the
 * caller names the reason in its own audit row, so every refusal is recorded
 * exactly once, by whoever refused it (FR-044, FR-063).
 */

import {
    attemptHistory,
    currentAttempt,
    isTerminalRun,
    openedHistory,
    runHistoryIndicatesSession,
} from './runs-document.ts';
import type { LeaseProvenance, Run } from './runs-types.ts';

/**
 * Automatic requeues one run consumes before it is dead-lettered.
 *
 * A module constant, deliberately **not** a configuration field: 003 v1.3.0 and
 * 006's `## Deferred` record that decision — the budget bounds a crashed-panel
 * loop, and no operator-meaningful knob is specified for it.
 */
export const MAX_AUTO_REQUEUES = 3;

/** Coordinates one claim's lease carries (FR-030). */
export interface LeaseCoordinates {
    /** Opaque per-mount id taking the lease; informational, never authorization. */
    readonly holder: string;
    /** Lease identifier minted for this claim. a fencing token, not a capability. */
    readonly leaseId: string;
    /** RFC 3339 issue stamp (service clock). */
    readonly issuedAt: string;
    /** RFC 3339 expiry stamp; the sweep compares it to the service clock. */
    readonly expiresAt: string;
    /** Which path minted the lease; a panel claim is the only live one. */
    readonly provenance: LeaseProvenance;
}

/**
 * The `pending` → `claimed` transition.
 *
 * Claiming is a lease, not a bare state flip: the run records who
 * holds it and until when, and the current attempt's record is opened so the
 * outcome transitions have something to close.
 *
 * @param input - The waiting run, the lease coordinates, and the stamp.
 * @returns The claimed run, or `null` when the run is not claimable — a state
 *   other than `pending`, or a history that already records a session
 *   (FR-037's "under any condition" clause).
 */
export function leaseRun(input: {
    /** The run being claimed. */
    readonly run: Run;
    /** The lease being issued. */
    readonly lease: LeaseCoordinates;
    /** Mutation stamp. */
    readonly now: string;
}): Run | null {
    const { run, lease, now } = input;
    if (run.state !== 'pending' || runHistoryIndicatesSession(run)) {
        return null;
    }

    return {
        ...run,
        state: 'claimed',
        stateReason: `lease held by ${lease.holder} until ${lease.expiresAt}`,
        lease: { attempt: run.attempt, ...lease },
        attempts: openedHistory(run),
        updatedAt: now,
    };
}

/**
 * The `claimed` → `pending` lease-expiry requeue.
 *
 * FR-032: lease expiry **while no reservation was made** is the only automatic
 * requeue trigger, and it is the only thing that consumes an attempt and one
 * unit of the automatic requeue budget (plan D5 — an operator retry increments
 * the attempt without touching the budget). A run whose history already
 * records a session is never requeued: a second dispatch is impossible by
 * construction.
 *
 * `chargeBudget` is the caller's policy, not the transition's: a real panel
 * that let its lease lapse always pays, while the one-shot migration recovery
 * of an adopted claim does not (data-model §1 — the budget bounds a
 * crashed-panel loop, and an adoption cannot loop).
 *
 * @param input - The stranded run, the service-clock stamp expiry is judged
 *   against, and whether this requeue spends budget.
 * @returns The waiting run, or `null` when the run is not an expired,
 *   unreserved claim.
 */
export function expireLease(input: {
    /** The run whose claim expired. */
    readonly run: Run;
    /** Service-clock stamp expiry is judged against. */
    readonly now: string;
    /** Whether this requeue consumes one unit of the automatic budget. */
    readonly chargeBudget: boolean;
}): Run | null {
    const { run, now, chargeBudget } = input;
    if (
        run.state !== 'claimed' ||
        run.lease === null ||
        run.reservation !== null ||
        runHistoryIndicatesSession(run) ||
        Date.parse(run.lease.expiresAt) > Date.parse(now)
    ) {
        return null;
    }

    return {
        ...run,
        state: 'pending',
        stateReason: null,
        attempt: run.attempt + 1,
        requeuesUsed: run.requeuesUsed + (chargeBudget ? 1 : 0),
        lease: null,
        attempts: attemptHistory(run, {
            ...currentAttempt(run),
            outcome: 'expired',
            reason: 'lease expired without a reservation',
            resultReportedAt: now,
        }),
        updatedAt: now,
    };
}

/**
 * The `dead-lettered` park.
 *
 * @returns The parked run, or `null` when the run is terminal or already
 *   produced a session.
 */
export function parkRun(input: { readonly run: Run; readonly now: string; readonly reason: string }): Run | null {
    const { run, now, reason } = input;
    if (isTerminalRun(run) || run.session !== null) {
        return null;
    }

    // A parked run's in-flight attempt ends without a session; a record an
    // earlier transition already closed keeps its own outcome (plan D6:
    // history rows are never rewritten).
    const open = currentAttempt(run);
    const attempts = open.outcome === null
        ? attemptHistory(run, { ...open, outcome: 'expired', reason, resultReportedAt: now })
        : run.attempts;

    return {
        ...run,
        state: 'dead-lettered',
        stateReason: reason,
        lease: null,
        attempts,
        updatedAt: now,
    };
}

/**
 * The `starting` → `unconfirmed` wedge.
 *
 * The fail-closed state: once a reservation exists and its result is
 * late, the run is never re-dispatched, re-leased, or retried automatically.
 *
 * @returns The wedged run, or `null` when the run is not an authorized attempt
 *   waiting on a result.
 */
export function wedgeUnconfirmed(input: { readonly run: Run; readonly now: string }): Run | null {
    const { run, now } = input;
    if (run.state !== 'starting' || run.reservation === null || run.session !== null) {
        return null;
    }

    return {
        ...run,
        state: 'unconfirmed',
        stateReason: `no result by ${run.reservation.resultDeadlineAt}`,
        attempts: attemptHistory(run, {
            ...currentAttempt(run),
            outcome: 'unconfirmed',
            reason: 'result deadline passed',
            resultReportedAt: now,
        }),
        updatedAt: now,
    };
}
