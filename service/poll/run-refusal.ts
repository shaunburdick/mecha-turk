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
    /** The run already holds a live authorization. */
    | 'already-reserved'
    /** The run already produced a session; the message names it. */
    | 'already-dispatched'
    /** The run is not in a state this operation accepts, with a distinct message. */
    | 'invalid-transition'
    /**
     * The binding's actor allow-list admits nobody on this run (003 FR-077).
     *
     * The gate's one code covers all three of its causes — no reference names an
     * allowed actor; a reference's actor is absent, empty, or bot-shaped;
     * the policy itself could not be read (constitution II) — because
     * all three leave the run in the same place and are repaired the same way:
     * the operator changes the binding's `allowedUsers`, then retries. One code
     * is also one less wire vocabulary for the panel to keep in step.
     */
    | 'actor-not-allowed'
    /** A blocked run's cause has not cleared (002 §4's retained code). */
    | 'cause-not-cleared'
    /**
     * The body failed validation (002 §4's `422 validation`).
     *
     * A response code rather than an operation verdict: it never reaches
     * {@link RunOutcome} from an operation module, because a `422` is decided in
     * the route layer before the run is touched. It exists here so the
     * `dispatch.refused` row a run is owed for one (contract §9, as narrowed by
     * T-044) records **the same code the wire carried**, and so `REFUSAL_STATUS`
     * maps it rather than falling through to a default.
     */
    | 'validation';

/**
 * How much of a run's trigger history an authorization decision could actually
 * see.
 *
 * A **closed word rather than the run's boolean**, for three reasons that all
 * point the same way:
 *
 * - **Absence is meaningful.** A reader handed `false` cannot tell *"the
 *   decision saw the whole list"* from *"this build does not report a
 *   window"*; an absent member is unambiguously the second thing, which is
 *   what lets a reader fail closed instead of defaulting a fact it was never
 *   told.
 * - **It states the decision, not the document.** The gate's quantifier runs
 *   over the retained list it read inside its own chain task, so the window
 *   belongs to *that judgement* rather than to a run record a reader might
 *   re-read at a different moment and get a different answer from.
 * - **The vocabulary can widen.** `actor-not-allowed` is the only code that
 *   judges a window today; a second one adds a word rather than a second wire
 *   shape or a boolean that would mean two different things per code.
 *
 * **Value-free by construction** — two words about a list, never a login — so
 * it can ride the envelope without becoming a second copy of the access policy.
 *
 */
export type ReferenceWindow = 'complete' | 'truncated';

/** One refusal: its machine code and the secret-free cause the row records. */
export interface RunRefusal {
    /** Stable code from the wire catalog. */
    readonly code: RunRefusalCode;
    /** Secret-free cause; never a token value and never untrusted source text. */
    readonly message: string;
    /**
     * The window the deciding gate could see, on the one code that judges one.
     *
     * Absent on every other refusal, and on any refusal from a build that
     * predates the member — which is exactly why it is a **word** and not a
     * boolean, and why absence is not read as `complete` (see
     * {@link ReferenceWindow}). Present on **every** refusal the actor gate
     * produces, so a reader is never left guessing whether it was told.
     */
    readonly referenceWindow?: ReferenceWindow;
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
 * Build the one refusal that also states the window its gate judged.
 *
 * **A second constructor rather than a third argument**, and that is a
 * readability decision as much as a lint one: every other refusal in the family
 * is `refuse(code, message)`, and twenty-odd call sites should keep reading like
 * that. The actor gate is the single caller that has a third fact, and it has
 * exactly one per refusal, so it gets a name.
 *
 * It **delegates** rather than forming the pair again, so the two refusals
 * cannot disagree about anything but the window.
 *
 * @param input - The same code and cause {@link refuse} takes, plus the window.
 * @returns The refusal, carrying the window.
 */
export function refuseOnWindow(input: {
    /** Stable code from the wire catalog. */
    readonly code: RunRefusalCode;
    /** Secret-free cause; the same string the response carries. */
    readonly message: string;
    /** The window the deciding gate could see. */
    readonly referenceWindow: ReferenceWindow;
}): RunRefusal {
    return { ...refuse(input.code, input.message), referenceWindow: input.referenceWindow };
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
    /** Whether the lifecycle row reached the trail. */
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
    /** Whether the `dispatch.refused` row reached the trail. */
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
