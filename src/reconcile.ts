/**
 * Mount-time reconciliation (003 T-022; FR-025;
 * [contracts/reconciliation.md](../specs/003-dispatch-integrity/contracts/reconciliation.md) §2).
 *
 * On every mount, before the panel issues its first claim, every attempt it
 * durably recorded but has not seen acknowledged is reported again. That is
 * what makes a lost result report recoverable instead of wedging a run:
 * the record from `src/dispatch-record.ts` is the question, this pass is the
 * re-ask, and the service's own idempotency is the answer — a repeat of an
 * already-applied outcome answers `200` unchanged and writes exactly one
 * `dispatch.duplicate-report` row (FR-025, AC-111).
 *
 * Three properties the pass owes:
 *
 * - **Bounded.** {@link RECONCILE_BUDGET_MS} caps the whole pass, every attempt
 *   included, so a silent service cannot stall the panel forever. What the
 *   budget did not reach stays unacknowledged for the next mount.
 * - **Idempotent.** A repeat posts byte-identical bodies and changes no state;
 *   nothing here dispatches, so reconciliation can never create a session.
 * - **Never silent.** Anything still outstanding after the pass — over budget,
 *   refused by the service, or unreachable — becomes a visible warning that
 *   names the runs, and a refusal additionally lands on the panel note with the
 *   service's own copy. An attempt the panel cannot even read gets a warning
 *   that says so rather than a quiet success.
 *
 * The clock is injectable (NFR-112 keeps the *service's* clock injectable at
 * its own seam; this is the panel's), so the budget is tested by moving it
 * rather than by sleeping.
 */

import { dispatchedPath, servicePost } from './service-calls.ts';
import type { ServiceErrorResult } from './service-calls.ts';
import { loadDispatchRecord, acknowledgeDispatch, unacknowledgedAttempts } from './dispatch-record.ts';
import type { DispatchAttemptRecord, DispatchRecordDocument } from './dispatch-record.ts';
import { boundedText } from './relay-gates.ts';
import { setStatus } from './panel-state.ts';
import { refresh } from './panel-ui.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Total wall-clock budget for one reconciliation pass, in milliseconds. */
export const RECONCILE_BUDGET_MS = 5_000;

/** Longest warning body the banner renders before it is cut — visibly. */
const MAX_WARNING_CHARS = 600;

/** Milliseconds in one second; used to phrase the budget for the operator. */
const MS_PER_SECOND = 1_000;

/**
 * Whether one pass is still inside its budget.
 *
 * @returns `true` while there is budget left to spend.
 */
function withinBudget(clock: () => number, startedAt: number): boolean {
    return clock() - startedAt < RECONCILE_BUDGET_MS;
}

/** What one reconciliation pass reached. */
export interface ReconcileOutcome {
    /** Attempts this pass re-reported. */
    readonly attempted: number;
    /** Attempts whose re-report landed **and** whose acknowledgement stuck. */
    readonly acknowledged: number;
    /** Runs still unacknowledged after the pass, in report order. */
    readonly outstanding: readonly string[];
    /** The visible warning the panel renders, or `null` when the pass settled. */
    readonly warning: string | null;
}

/**
 * Build the result body one stored attempt re-reports.
 *
 * Both stored outcomes re-report as **Result** (contract §3): a record exists
 * only after the host call returned, which is exactly what distinguishes a
 * Result from an Abandon. `problem` is the recorded cause, bounded to what the
 * route accepts — the panel never invents one.
 *
 * @returns The body text.
 */
function reportBody(attempt: DispatchAttemptRecord): string {
    const shared = {
        correlationId: attempt.correlationId,
        attempt: attempt.attempt,
        dispatchToken: attempt.dispatchToken,
    };

    return JSON.stringify(
        attempt.outcome === 'dispatched'
            ? { ...shared, sessionId: attempt.sessionId }
            : { ...shared, problem: boundedText(attempt.reason ?? '') },
    );
}

/**
 * Re-report one stored attempt; never throws (`servicePost` catches).
 *
 * @returns The service's answer, carrying its refusal copy when it sent one.
 */
async function reportAttempt(
    rt: PanelRuntime,
    attempt: DispatchAttemptRecord,
): Promise<ServiceErrorResult> {
    return await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: dispatchedPath(attempt.correlationId),
        body: reportBody(attempt),
    });
}

/** One refusal, narrowed to the branch that carries the envelope's copy. */
type ServiceRefusal = Extract<ServiceErrorResult, { readonly ok: false }>;

/**
 * The refusal copy for one attempt, naming the run and what the service said.
 *
 * @returns One line carrying the service's own copy when it sent one.
 */
function refusalLine(attempt: DispatchAttemptRecord, answer: ServiceRefusal): string {
    const detail = answer.message ?? answer.problem;

    return `${attempt.correlationId}: ${boundedText(detail)}`;
}

/**
 * Compose the banner the panel renders when anything is still outstanding.
 *
 * The run names come first, so cutting the body to {@link MAX_WARNING_CHARS}
 * can only ever shorten the *reasons* — the runs an operator has to look at
 * are never the part that gets truncated away.
 *
 * @returns The banner body, already bounded.
 */
function warningBody(input: {
    /** Runs still unacknowledged, in report order. */
    readonly outstanding: readonly string[];
    /** One line per refusal or budget stop. */
    readonly reasons: readonly string[];
}): string {
    const runs = [...new Set(input.outstanding)].join(', ');
    const body = `Re-report pending for ${runs}. ${input.reasons.join(' ')}`;

    return body.length <= MAX_WARNING_CHARS ? body : `${body.slice(0, MAX_WARNING_CHARS - 1)}…`;
}

/**
 * Publish one reconciliation warning: banner first, refusal copy on the note.
 *
 * @returns The warning the panel now shows.
 */
function publishWarning(rt: PanelRuntime, input: {
    /** Runs still unacknowledged, in report order. */
    readonly outstanding: readonly string[];
    /** One line per refusal or budget stop. */
    readonly reasons: readonly string[];
    /** Refusal copy to record on the panel note, if any. */
    readonly refusals: readonly string[];
}): string {
    const warning = warningBody(input);
    setStatus(rt, { tone: 'warning', title: 'Dispatch reconciliation incomplete', body: warning });
    if (input.refusals.length > 0) {
        rt.state.bindings.note = `The service refused a reconciliation report: ${input.refusals.join(' | ')}`;
    }

    refresh(rt);

    return warning;
}

/**
 * Report every outstanding attempt, within one budget, and say what is left.
 *
 * @param options - Injectable clock so the budget is testable without sleeping.
 * @returns What the pass reached, including the warning it published.
 */
/** What one pass over the outstanding attempts reached, before it is published. */
interface PassResult {
    /** Attempts this pass re-reported. */
    readonly attempted: number;
    /** Attempts whose re-report landed and whose acknowledgement stuck. */
    readonly acknowledged: number;
    /** Runs still unacknowledged after the pass, in report order. */
    readonly outstanding: readonly string[];
    /** One line per refusal or budget stop, for the warning body. */
    readonly reasons: readonly string[];
    /** Refusal copy only, for the panel note. */
    readonly refusals: readonly string[];
}

/**
 * Re-report every outstanding attempt inside the remaining budget.
 *
 * @returns What the loop reached, before anything is published.
 */
async function reportOutstanding(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The stored record this pass works from. */
    readonly document: DispatchRecordDocument;
    /** The injected (or real) clock. */
    readonly clock: () => number;
    /** When the pass began, on that clock. */
    readonly startedAt: number;
}): Promise<PassResult> {
    const { rt, clock, startedAt } = input;
    const outstanding: string[] = [];
    const reasons: string[] = [];
    const refusals: string[] = [];
    let attempted = 0;
    let acknowledged = 0;

    for (const attempt of unacknowledgedAttempts(input.document)) {
        if (!withinBudget(clock, startedAt)) {
            reasons.push(`the ${RECONCILE_BUDGET_MS / MS_PER_SECOND}s budget ran out before this run.`);
            outstanding.push(attempt.correlationId);

            continue;
        }

        attempted += 1;
        const answer = await reportAttempt(rt, attempt);
        if (answer.ok) {
            const isFlipped = await acknowledgeDispatch({
                rt,
                correlationId: attempt.correlationId,
                attempt: attempt.attempt,
            });
            if (isFlipped) {
                acknowledged += 1;
            } else {
                // The report landed but the panel could not record that it did;
                // it stays outstanding so the next mount asks again, which the
                // service answers as a duplicate rather than as new work.
                reasons.push('the acknowledgement could not be written, so it is reported again next mount.');
                outstanding.push(attempt.correlationId);
            }

            continue;
        }

        const refusal = refusalLine(attempt, answer);
        refusals.push(refusal);
        reasons.push(refusal);
        outstanding.push(attempt.correlationId);
    }

    return { attempted, acknowledged, outstanding, reasons, refusals };
}

/**
 * Report every outstanding attempt, within one budget, and say what is left.
 *
 * @param options - Injectable clock so the budget is testable without sleeping.
 * @returns What the pass reached, including the warning it published.
 */
export async function reconcileDispatchAttempts(
    rt: PanelRuntime,
    options: { readonly now?: () => number } = {},
): Promise<ReconcileOutcome> {
    const clock = options.now ?? Date.now;
    const startedAt = clock();
    const read = await loadDispatchRecord(rt);
    if (!read.ok) {
        // Nothing may be named here — the record itself is what could not be
        // read — so the warning says exactly that instead of implying a clean
        // pass over a document the panel refuses to half-apply.
        const warning = publishWarning(rt, {
            outstanding: ['an unreadable attempt record'],
            reasons: ['This panel could not read mecha-turk:dispatches, so nothing was re-reported.'],
            refusals: [],
        });

        return { attempted: 0, acknowledged: 0, outstanding: [], warning };
    }

    const pass = await reportOutstanding({ rt, document: read.document, clock, startedAt });
    if (pass.outstanding.length === 0) {
        return {
            attempted: pass.attempted,
            acknowledged: pass.acknowledged,
            outstanding: pass.outstanding,
            warning: null,
        };
    }

    return {
        attempted: pass.attempted,
        acknowledged: pass.acknowledged,
        outstanding: pass.outstanding,
        warning: publishWarning(rt, { outstanding: pass.outstanding, reasons: pass.reasons, refusals: pass.refusals }),
    };
}
