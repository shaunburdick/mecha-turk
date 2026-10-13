/**
 * Mount-time reconciliation: re-report every unacknowledged attempt before the first claim — bounded, never silent.
 */

import { dispatchedPath, servicePost } from './service-calls.ts';
import type { ServiceErrorResult } from './service-calls.ts';
import { loadDispatchRecord, acknowledgeDispatch, unacknowledgedAttempts } from './dispatch-record.ts';
import type { DispatchAttemptRecord, DispatchRecordDocument } from './dispatch-record.ts';
import { boundedText } from './relay-gates.ts';
import { setStatus } from './panel-state.ts';
import { refresh } from './panel-ui.ts';
import type { PanelRuntime } from './panel-state.ts';

export const RECONCILE_BUDGET_MS = 5_000;

const MAX_WARNING_CHARS = 600;

const MS_PER_SECOND = 1_000;

/**
 * Whether one pass is still inside its budget.
 */
function withinBudget(clock: () => number, startedAt: number): boolean {
    return clock() - startedAt < RECONCILE_BUDGET_MS;
}

export interface ReconcileOutcome {
    readonly attempted: number;
    readonly acknowledged: number;
    readonly outstanding: readonly string[];
    readonly warning: string | null;
}

/**
 * Build the result body one stored attempt re-reports.
 *
 * Both stored outcomes re-report as **Result** (contract §3): a record exists
 * only after the host call returned, which is exactly what distinguishes a
 * Result from an Abandon. `problem` is the recorded cause, bounded to what the
 * route accepts — the panel never invents one.
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
 */
function warningBody(input: {
    readonly outstanding: readonly string[];
    readonly reasons: readonly string[];
}): string {
    const runs = [...new Set(input.outstanding)].join(', ');
    const body = `Re-report pending for ${runs}. ${input.reasons.join(' ')}`;

    return body.length <= MAX_WARNING_CHARS ? body : `${body.slice(0, MAX_WARNING_CHARS - 1)}…`;
}

/**
 * Publish one reconciliation warning: banner first, refusal copy on the note.
 */
function publishWarning(rt: PanelRuntime, input: {
    readonly outstanding: readonly string[];
    readonly reasons: readonly string[];
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
 */
interface PassResult {
    readonly attempted: number;
    readonly acknowledged: number;
    readonly outstanding: readonly string[];
    readonly reasons: readonly string[];
    readonly refusals: readonly string[];
}

/**
 * Re-report every outstanding attempt inside the remaining budget.
 */
async function reportOutstanding(input: {
    readonly rt: PanelRuntime;
    readonly document: DispatchRecordDocument;
    readonly clock: () => number;
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
                // service answers as a duplicate rather than as new work — one
                // `dispatch.duplicate-report` row, never a second (AC-111).
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
