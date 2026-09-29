/**
 * The refusal vocabulary every run-scoped operation answers with (003 FR-003,
 * FR-022; [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md)
 *
 * Two properties this module exists to hold, and which cannot be held from
 * either operation module alone:
 *
 * 1. **Each refusal carries its own distinct reason.** FR-003 requires every
 *    refusal to name the exact cause, and FR-041 requires the retry refusals for
 *    `pending`, `dispatched`, and `unconfirmed` to be three different verdicts
 *    rather than one "no". The codes are one closed union here, so the
 *    authorization family and the operator actions cannot drift into reusing
 *    each other's vocabulary.
 * 2. **A refusal is data, not transport.** The HTTP status and the operator's
 *    prose live in the route layer; what the run layer knows is the machine
 *    code and the secret-free cause, which is also exactly what the
 *    `dispatch.refused` row records (contract §9: "reason = the same secret-free
 *    cause the response carries"). One source for both is what makes the trail
 *    and the wire provably agree.
 *
 * The outcome shapes below are also what every operation returns, so a caller
 * cannot forget the two members that matter: a refusal names the run it was
 * refused on (for the refusal row) and reports whether the row it owed actually
 * reached the trail (FR-063).
 */

import type { Run } from './runs-types.ts';

/**
 * Every reason a run-scoped operation can refuse, as the wire's stable codes.
 *
 * `unknown-run` is the one refusal with no run behind it: there is no prior
 * state, no attempt, and no entity to attach a row to, so it answers `404` and
 * writes nothing (see the route layer's note there).
 */
export type RunRefusalCode =
    /** No run carries this correlation id (or the segment is not one). */
    | 'unknown-run'
    /** The lease or token is expired, superseded, unknown, or mismatched. */
    | 'stale-lease'
    /** The run already holds a live authorization (FR-022). */
    | 'already-reserved'
    /** The run already produced a session; the message names it (FR-022, AC-112). */
    | 'already-dispatched'
    /** The run is not in a state this operation accepts, with a distinct message. */
    | 'invalid-transition'
    /** A blocked run's cause has not cleared (002 §4's retained code). */
    | 'cause-not-cleared';

/** One refusal: its machine code and the secret-free cause the row records. */
export interface RunRefusal {
    /** Stable code from the wire catalog. */
    readonly code: RunRefusalCode;
    /** Secret-free cause; never a token value and never untrusted source text. */
    readonly message: string;
}

/** The wire code a superseded lease, token, or attempt answers with. */
export const STALE_LEASE_CODE = 'stale-lease';

/**
 * Build one refusal, so every module in the family spells codes the same way.
 *
 * A refusal is data, not transport: this is the only place the pair is formed,
 * which is what keeps the `dispatch.refused` row and the response envelope
 * provably the same cause (contract §9).
 *
 * @param code - Stable code from the wire catalog.
 * @param message - Secret-free cause; the same string the response carries.
 * @returns The refusal.
 */
export function refuse(code: RunRefusalCode, message: string): RunRefusal {
    return { code, message };
}

/**
 * The message a request carrying a superseded attempt answers with.
 *
 * Shared by the two operations that validate the common `attempt` member
 * (contract §6 retry, §5 verification) so a panel sees one wording for one
 * verdict, whatever operation raised it.
 *
 * @param attempt - Attempt the request named.
 * @param current - Attempt the run actually stands on.
 * @returns The secret-free cause; it echoes only numbers, never a payload.
 */
export function staleAttemptMessage(attempt: number, current: number): string {
    return `the request names attempt ${attempt} but this run stands on attempt ${current}; `
        + 'read the run again and act on the attempt it reports';
}

/** The run moved, and the operation's row was attempted. */
export interface RunApplied {
    /** `applied` — the durable write landed. */
    readonly status: 'applied';
    /** The run as it now stands. */
    readonly run: Run;
    /** Whether the lifecycle row reached the trail (FR-063). */
    readonly auditWritten: boolean;
}

/**
 * A repeat of an outcome already recorded: `200`, no state change, one row.
 *
 * Its own status rather than a boolean on `applied` because the audit row
 * differs (`dispatch.duplicate-report` instead of `dispatch.result`), and a
 * caller that conflated the two would write the wrong vocabulary for exactly the
 * case FR-025's idempotency clause is about.
 */
export interface RunDuplicate {
    /** `duplicate` — the recorded outcome was repeated unchanged. */
    readonly status: 'duplicate';
    /** The run as it stood before and after; byte-stable. */
    readonly run: Run;
    /** Whether the `dispatch.duplicate-report` row reached the trail. */
    readonly auditWritten: boolean;
}

/** Nothing moved; the refusal row says why. */
export interface RunRefused {
    /** `refused` — nothing was written to the run. */
    readonly status: 'refused';
    /** The machine code and cause. */
    readonly refusal: RunRefusal;
    /** The run as it stood, or `null` when no run carries this id. */
    readonly run: Run | null;
    /** Whether the `dispatch.refused` row reached the trail (FR-003). */
    readonly auditWritten: boolean;
}

/** No run carries this correlation id. */
export interface RunNotFound {
    /** `not-found` — the run does not exist, so there is no run to refuse. */
    readonly status: 'not-found';
}

/** Every shape a run operation answers with. */
export type RunOutcome = RunApplied | RunDuplicate | RunRefused;

/** A run operation's answer including the "no such run" case. */
export type RunResult = RunOutcome | RunNotFound;

/**
 * Narrow an operation result to a refusal the caller must answer `4xx`.
 *
 * @param outcome - Whatever the operation returned.
 * @returns The refusal shape, or `null` when the operation applied, duplicated,
 *   or found nothing at all.
 */
export function refusalOf(outcome: RunResult): RunRefused | null {
    return outcome.status === 'refused' ? outcome : null;
}
