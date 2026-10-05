/**
 * Report the outcome of an authorized attempt, or abandon it
 * ([contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md)).
 *
 * These two operations spend the authorization
 * [`dispatch-authorize.ts`](./dispatch-authorize.ts) minted, and they share the
 * one shape that makes spending safe: **a report is judged against the recorded
 * attempt history, not the state name.** "Identical repeat" and
 * "different outcome" can only be told apart by what the run already
 * recorded, so the verdict reads the attempt record for the run's current attempt
 * *and* requires the run state to corroborate it. Anything that does not
 * corroborate is a **conflict** and is refused — a session id must never be
 * overwritable by a problem, nor swapped.
 *
 * The attempt history is also what makes the derivation safe *across* a
 * dead-letter reset. The token is pinned to `sha256(runKey|attempt)`, and a
 * reset returns a run to attempt 1 — so chain 2 re-mints chain 1's
 * **byte-identical** token, and the live reservation alone cannot tell the two
 * apart. {@link tokenSpent} is the difference: a token any *earlier* record
 * closed can never authorize a report again, whatever a later reservation says.
 * The check reads history
 * and nothing else, so `reserve` — which consults no history — still authorizes
 * after a reset and the dead-letter path cannot dead-end.
 *
 * Abandon is a result report whose outcome is *no session*, so it shares
 * this operation and this matrix entirely; it is distinguished from Result's
 * `problem` shape by when it is true rather than by the state it ends in.
 *
 * Two more properties their transitions owe:
 *
 * - **The outcome and the consumed reservation are one write.** A result that
 *   recorded an outcome but left the reservation unconsumed would leave a token
 *   that authorizes nothing yet looks live. This module exists to make that
 *   impossible.
 * - **A `problem` never yields `dispatched`**, anywhere in the answer,
 *   the stored run, or the audit row.
 *
 * The chain task and the refusal-row writer live in
 * [`run-chain.ts`](./run-chain.ts); what is here is each operation's decision and
 * the transition it applies.
 */

import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { appendRunRow, abandonedRow, duplicateReportRow, resultRow } from './dispatch-audit.ts';
import { sessionIdOf } from './dispatch-authorize.ts';
import { appendRefusalRow, operateRun, sessionRefOf } from './run-chain.ts';
import { buildDispatchTokenFingerprint } from './run-key.ts';
import { attemptHistory, currentAttempt } from './runs-document.ts';
import { refuse } from './run-refusal.ts';
import type { RunApplied, RunDuplicate, RunNotFound, RunRefused, RunRefusal } from './run-refusal.ts';
import type { DispatchAttempt, Run, RunReservation } from './runs-types.ts';

/** What a result, abandon, or block report answered. */
export type ReportResult = RunApplied | RunDuplicate | RunRefused | RunNotFound;

/** What a report carries, reduced to what the staleness matrix compares. */
interface ReportOutcome {
    /** Outcome the attempt record will carry when applied. */
    readonly attemptOutcome: 'dispatched' | 'failed' | 'abandoned';
    /** Session the dispatch created, else `null`. */
    readonly sessionId: string | null;
    /** Failure or abandonment reason, else `null`. */
    readonly reason: string | null;
}

/** The outcome a report asks the service to apply. */
export interface ReportInput {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The run being reported on, by correlation id. */
    readonly correlationId: string;
    /** The token the panel holds for this attempt. */
    readonly dispatchToken: string;
    /** Attempt the panel believes is current. */
    readonly attempt: number;
    /** What the host call produced. */
    readonly outcome: ReportOutcome;
    /** Which operation is reporting, for the row and the refusal. */
    readonly operation: 'result' | 'abandon';
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}

/** The wire code every state verdict in this module carries. */
const INVALID_TRANSITION = 'invalid-transition';

/** The generic staleness message every token mismatch carries. */
const STALE_TOKEN_MESSAGE = 'the dispatch token is unknown, superseded, or already consumed by another attempt';

/**
 * Whether a consumed reservation's recorded outcome is exactly the one repeated.
 *
 * Both the attempt record and the run state must agree: a record that says
 * `dispatched` on a run that is still `starting` is a contradiction, and the
 * fail-closed answer to a contradiction is a refusal, never a silent `200`.
 *
 * @returns `true` when the repeat is byte-for-byte the recorded one.
 */
function repeatedOutcome(input: { readonly run: Run; readonly outcome: ReportOutcome }): boolean {
    const { run, outcome } = input;
    const recorded = currentAttempt(run);
    if (recorded.outcome !== outcome.attemptOutcome) {
        return false;
    }

    return outcome.sessionId === null
        ? recorded.reason === outcome.reason && run.state === 'failed'
        : recorded.sessionId === outcome.sessionId && sessionIdOf(run) === outcome.sessionId;
}

/**
 * The message a conflicting repeat carries, naming what already stands.
 *
 * @returns The refusal, which never carries the token being presented.
 */
function conflict(run: Run): RunRefusal {
    const sessionId = sessionIdOf(run);

    return refuse(
        INVALID_TRANSITION,
        sessionId === null
            ? 'a different outcome is already recorded for this attempt and cannot be replaced'
            : `this attempt already reported session ${sessionId}; a different outcome cannot replace it`,
    );
}

/**
 * Whether the attempt history already spent this token **on an earlier record**.
 *
 * A record "spent" the token when it carries it **and** is closed: either the
 * stamp landed (`resultReportedAt`) or an outcome was recorded. The derivation
 * is a pure function of `(runKey, attempt)`, and a reset returns
 * the run to attempt 1, so a later chain re-mints the exact bytes an earlier one
 * consumed — which is why "does the live reservation hold this token" is the
 * wrong question to ask on its own. The history is durable, append-only, and
 * survives the reset, so it is the one record that can still tell the
 * chains apart.
 *
 * **The current attempt's own record is excluded, and only it.** That is the
 * record `reserveDispatch` writes and `reservation.consumed` already governs —
 * and the sweep's `unconfirmed` wedge *closes* it (the result deadline passed)
 * while leaving the authorization deliberately live, because a late report must
 * still reconcile the run.
 * Excluding exactly that one record is what keeps the two requirements from
 * contradicting each other: every *other* record carrying a closed token is a
 * token from a chain the run has already left, and none of them may ever apply.
 *
 * @param dispatchToken - Token the report presented.
 * @returns `true` when some record other than the live reservation's own already
 *   closed this token.
 */
function tokenSpent(run: Run, dispatchToken: string): boolean {
    const live = currentAttempt(run);

    return run.attempts.some((record) => record !== live
        && record.dispatchToken === dispatchToken
        && (record.resultReportedAt !== null || record.outcome !== null));
}

/** The verdict's three arms, so each is applied by its own named step. */
type ReportVerdict =
    | { readonly verdict: 'apply' }
    | { readonly verdict: 'duplicate' }
    | { readonly refusal: RunRefusal };

/**
 * Judge a token-bearing report against the recorded attempt.
 *
 * The matrix, in the order a request can fail it: an unknown, mismatched, or
 * superseded token is stale; a consumed token is a duplicate **only** when the
 * recorded outcome is exactly the one being repeated and the run state
 * corroborates it, and a conflict otherwise; a token the attempt history has
 * already closed is stale whatever the live reservation says (the cross-chain
 * replay a dead-letter reset makes possible); and an unconsumed token applies
 * from `starting` or from `unconfirmed` (the reconciliation case), and from
 * nowhere else.
 *
 * @returns `apply`, `duplicate`, or the refusal.
 */
function judgeReport(input: {
    /** The run being reported on. */
    readonly run: Run;
    /** Token the panel presented. */
    readonly dispatchToken: string;
    /** Attempt the panel claims to be acting under. */
    readonly attempt: number;
    /** Outcome the report carries. */
    readonly outcome: ReportOutcome;
}): ReportVerdict {
    const { run, dispatchToken, attempt, outcome } = input;
    const stale = refuse('stale-lease', STALE_TOKEN_MESSAGE);
    const { reservation } = run;
    if (reservation?.dispatchToken !== dispatchToken) {
        return { refusal: stale };
    }

    // A newer attempt owns the run: the panel is reporting for an attempt the
    // service has already moved past. This is what makes a
    // slow panel's late report a refusal rather than a second outcome.
    if (reservation.attempt !== run.attempt || attempt !== run.attempt) {
        return { refusal: stale };
    }

    if (reservation.consumed) {
        return repeatedOutcome({ run, outcome }) ? { verdict: 'duplicate' } : { refusal: conflict(run) };
    }

    // The live reservation holds this token and has not spent it — which is
    // exactly the shape a dead-letter reset produces, because the reset returns
    // the run to attempt 1 and the derivation re-mints chain 1's bytes. Every
    // record the history already closed *around* this one is a token from a
    // chain the run has left, so the report in front of us is that chain's late
    // arrival rather than this one's, and it is refused instead of applied.
    //  The live reservation's own record is
    // excluded from that scan — it is the one `reservation.consumed` above
    // already governs, and the sweep's wedge closes it while the authorization
    // is still meant to be reportable.
    if (tokenSpent(run, dispatchToken)) {
        return { refusal: stale };
    }

    return run.state === 'starting' || run.state === 'unconfirmed'
        ? { verdict: 'apply' }
        : {
            refusal: refuse(
                INVALID_TRANSITION,
                `this run is ${run.state}; an authorized outcome can only be reported while it is `
                + 'starting or unconfirmed',
            ),
        };
}

/**
 * The attempt record one applied report closes.
 *
 * @returns The closed record.
 */
function closedAttempt(input: {
    /** The attempt as it stands before the report. */
    readonly attempt: DispatchAttempt;
    /** What the host call produced. */
    readonly outcome: ReportOutcome;
    /** Service-clock stamp. */
    readonly now: string;
}): DispatchAttempt {
    return {
        ...input.attempt,
        outcome: input.outcome.attemptOutcome,
        sessionId: input.outcome.sessionId,
        reason: input.outcome.reason,
        resultReportedAt: input.now,
    };
}

/**
 * Build the run an applied report produces.
 *
 * A session makes the run `dispatched`; its absence makes it `failed` — never
 * `dispatched`. The reservation is consumed and the claim dropped in
 * this **same** object, so a run can never be left holding a token that
 * authorizes nothing while looking live.
 *
 * @returns The settled run.
 */
function reportedRun(input: {
    /** The `starting` or `unconfirmed` run the report applies to. */
    readonly run: Run;
    /** What the host call produced. */
    readonly outcome: ReportOutcome;
    /** Service-clock stamp. */
    readonly now: string;
}): Run {
    const { run, outcome, now } = input;
    // `judgeReport` returns `apply` only for an unconsumed reservation on the
    // run's current attempt, so this non-null read is that verdict's own
    // precondition rather than an assumption about the document.
    const reservation = run.reservation as RunReservation;
    const { sessionId } = outcome;

    return {
        ...run,
        state: sessionId === null ? 'failed' : 'dispatched',
        stateReason: sessionId === null
            ? (outcome.reason ?? 'dispatch produced no session')
            : `session ${sessionId} created`,
        lease: null,
        reservation: { ...reservation, consumed: true },
        attempts: attemptHistory(run, closedAttempt({ attempt: currentAttempt(run), outcome, now })),
        ...(sessionId !== null && { session: sessionRefOf({ run, sessionId, now }) }),
        updatedAt: now,
    };
}

/**
 * Build the row an applied result or abandonment records.
 *
 * @returns The row to append.
 */
function reportRow(input: {
    /** The run as it now stands. */
    readonly run: Run;
    /** The token the report carried; recorded as its fingerprint only. */
    readonly dispatchToken: string;
    /** What the host call produced. */
    readonly outcome: ReportOutcome;
    /** Which operation reported. */
    readonly operation: 'result' | 'abandon';
}) {
    if (input.operation === 'abandon') {
        return abandonedRow({
            run: input.run,
            dispatchToken: input.dispatchToken,
            reason: input.outcome.reason ?? '',
        });
    }

    return resultRow({
        run: input.run,
        dispatchToken: input.dispatchToken,
        sessionId: input.outcome.sessionId,
        problem: input.outcome.reason,
    });
}

/** What a refused report needs beyond the report's own coordinates. */
interface RefusedReport {
    /** The report's store and logger. */
    readonly target: { readonly store: ServiceStore; readonly log: ServiceLogger };
    /** The run as it stands. */
    readonly run: Run;
    /** The operation the caller attempted, as the row names it. */
    readonly operation: 'result' | 'abandon';
    /** The verdict. */
    readonly refusal: RunRefusal;
    /** Attempt the caller presented. */
    readonly attempt: number;
    /** Token the caller presented; the row records its fingerprint, never it. */
    readonly dispatchToken: string;
}

/**
 * Answer a refused report with its one `dispatch.refused` row.
 *
 * The row names the token as a **fingerprint**: a staleness verdict is about
 * *which* authorization was presented, so the row records that reference —
 * while the contract's fingerprint rule forbids recording the
 * capability itself.
 *
 * @returns The refusal, carrying whether its row reached the trail.
 */
async function refusedReport(input: RefusedReport): Promise<RunRefused> {
    const { target, run, operation, refusal, attempt, dispatchToken } = input;

    return {
        status: 'refused',
        refusal,
        run,
        auditWritten: await appendRefusalRow({
            store: target.store,
            log: target.log,
            refusal: {
                run,
                operation,
                refusal,
                attempt,
                dispatchTokenFingerprint: buildDispatchTokenFingerprint(dispatchToken),
            },
        }),
    };
}

/**
 * Record a repeat of an outcome already recorded, without moving the run.
 *
 * @param run - The run, byte-unchanged by the repeat.
 * @returns The `duplicate` answer, carrying whether its row reached the trail.
 */
async function duplicateReport(input: ReportInput, run: Run): Promise<RunDuplicate> {
    return {
        status: 'duplicate',
        run,
        auditWritten: await appendRunRow({
            store: input.store,
            log: input.log,
            correlationId: run.correlationId,
            row: duplicateReportRow({ run, dispatchToken: input.dispatchToken, state: run.state }),
        }),
    };
}

/**
 * Apply a verdict: settle the run and record the row, or refuse.
 *
 * @param run - The run as the chain task read it.
 * @param verdict - What the judge decided.
 * @param persist - The chain task's write.
 * @returns The operation's answer.
 */
async function applyVerdict(input: {
    /** The report's own input. */
    readonly report: ReportInput;
    /** The run as the chain task read it. */
    readonly run: Run;
    /** What the judge decided. */
    readonly verdict: ReportVerdict;
    /** The chain task's write. */
    readonly persist: (run: Run) => Promise<void>;
}): Promise<ReportResult> {
    const { report, run, verdict, persist } = input;
    if ('refusal' in verdict) {
        return await refusedReport({
            target: report,
            run,
            operation: report.operation,
            refusal: verdict.refusal,
            attempt: report.attempt,
            dispatchToken: report.dispatchToken,
        });
    }

    if (verdict.verdict === 'duplicate') {
        return await duplicateReport(report, run);
    }

    const settled = reportedRun({ run, outcome: report.outcome, now: report.now ?? run.updatedAt });
    await persist(settled);
    const wasAppended = await appendRunRow({
        store: report.store,
        log: report.log,
        correlationId: settled.correlationId,
        row: reportRow({
            run: settled,
            dispatchToken: report.dispatchToken,
            outcome: report.outcome,
            operation: report.operation,
        }),
    });

    return { status: 'applied', run: settled, auditWritten: wasAppended };
}

/**
 * Report the outcome of an authorized attempt: a session makes the run
 * `dispatched`, its absence makes it `failed` — never `dispatched`.
 *
 * Abandon shares this operation and this matrix: it is a result report whose
 * outcome is *no session*, distinguished from Result's `problem` shape
 * by when it is true rather than by the state it ends in.
 *
 * @returns The settled run, the duplicate verdict, or the refusal.
 * @throws {StorageUnavailableError} When the run document cannot be read or written.
 */
export async function reportDispatch(input: ReportInput): Promise<ReportResult> {
    return await operateRun(input, async ({ run, now, persist }): Promise<ReportResult> => {
        const report = { ...input, now };
        const verdict = judgeReport({
            run,
            dispatchToken: input.dispatchToken,
            attempt: input.attempt,
            outcome: input.outcome,
        });

        return await applyVerdict({ report, run, verdict, persist });
    });
}
