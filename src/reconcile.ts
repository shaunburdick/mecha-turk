/**
 * Mount-time reconciliation before the first claim: re-report resolved attempts, surface unknown ones, settle.
 */

import { auditPath, dispatchedPath, serviceGet, servicePost } from './service-calls.ts';
import type { ServiceErrorResult } from './service-calls.ts';
import { parseAuditRow } from './audit-view.ts';
import type { AuditRow } from './audit-view.ts';
import {
    acknowledgeDispatch,
    loadDispatchRecord,
    settleDispatchAttempt,
    unacknowledgedAttempts,
} from './dispatch-record.ts';
import type { DispatchAttemptRecord, DispatchRecordDocument } from './dispatch-record.ts';
import { boundedText } from './relay-gates.ts';
import { parseJsonObject } from './json.ts';
import { setStatus } from './panel-state.ts';
import { refresh } from './panel-ui.ts';
import type { PanelRuntime } from './panel-state.ts';

export const RECONCILE_BUDGET_MS = 5_000;

const MAX_WARNING_CHARS = 600;

const MS_PER_SECOND = 1_000;

/** The route's own page ceiling; the settle read never uses the audit view's display cap (FR-045). */
const AUDIT_PAGE_LIMIT = 200;

const RESULT_EVENT = 'dispatch.result';

const ABANDONED_EVENT = 'dispatch.abandoned';

const RESERVED_EVENT = 'dispatch.reserved';

const RESOLVED_EVENT = 'dispatch.resolved';

const UNCONFIRMED_EVENT = 'dispatch.unconfirmed';

/**
 * Whether one pass is still inside its budget.
 */
function withinBudget(clock: () => number, startedAt: number): boolean {
    return clock() - startedAt < RECONCILE_BUDGET_MS;
}

interface AuditPage {
    readonly rows: readonly AuditRow[];
    readonly nextCursor: number | null;
}

/** The audit view's reader stops at its display cap and drops the cursor; this one pages by it. */
function parseAuditPage(text: string): AuditPage | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.entries)) {
        return null;
    }

    const rows: AuditRow[] = [];
    for (const entry of root.entries) {
        const row = parseAuditRow(entry);
        if (row === null) {
            return null;
        }

        rows.push(row);
    }

    const { nextCursor } = root;
    if (nextCursor === null || nextCursor === undefined) {
        return { rows, nextCursor: null };
    }

    return typeof nextCursor === 'number' && Number.isSafeInteger(nextCursor) ? { rows, nextCursor } : null;
}

function attemptOf(row: AuditRow): number | null {
    const value = row.details.attempt;

    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function reservedSeqOf(rows: readonly AuditRow[], attempt: number): number | null {
    let latest: number | null = null;
    for (const row of rows) {
        if (row.eventType !== RESERVED_EVENT || attemptOf(row) !== attempt) {
            continue;
        }

        latest = latest === null ? row.seq : Math.max(latest, row.seq);
    }

    return latest;
}

type SettleVerdict = 'settled' | 'unconfirmed' | 'no-evidence' | 'unreadable';

/**
 * A `dispatch.resolved` counts only after the `dispatch.reserved` row naming the
 * attempt in the same read (no clock comparison, NFR-112); `dispatch.unconfirmed`
 * and a non-numeric attempt reference settle nothing.
 */
function judgeEvidence(rows: readonly AuditRow[], attempt: number): SettleVerdict {
    const isPast = rows.some((row) => (row.eventType === RESULT_EVENT || row.eventType === ABANDONED_EVENT)
        && attemptOf(row) === attempt);
    if (isPast) {
        return 'settled';
    }

    const anchor = reservedSeqOf(rows, attempt);
    if (anchor !== null && rows.some((row) => row.eventType === RESOLVED_EVENT && row.seq > anchor)) {
        return 'settled';
    }

    return rows.some((row) => row.eventType === UNCONFIRMED_EVENT && attemptOf(row) === attempt)
        ? 'unconfirmed'
        : 'no-evidence';
}

/** Walk the correlation-filtered read to exhaustion inside the pass budget; any doubt is `unreadable`. */
async function readSettleVerdict(input: {
    readonly rt: PanelRuntime;
    readonly attempt: DispatchAttemptRecord;
    readonly clock: () => number;
    readonly startedAt: number;
}): Promise<SettleVerdict> {
    const { rt, attempt, clock, startedAt } = input;
    const rows: AuditRow[] = [];
    let cursor: number | null = null;
    let isDone = false;
    while (!isDone) {
        if (!withinBudget(clock, startedAt)) {
            return 'unreadable';
        }

        const answer = await serviceGet({
            serviceRequest: rt.host.serviceRequest,
            path: auditPath(attempt.correlationId, { limit: AUDIT_PAGE_LIMIT, cursor }),
        });
        if (!answer.ok) {
            return 'unreadable';
        }

        const page = parseAuditPage(answer.body);
        if (page === null) {
            return 'unreadable';
        }

        rows.push(...page.rows);
        cursor = page.nextCursor;
        isDone = cursor === null;
    }

    return judgeEvidence(rows, attempt.attempt);
}

export interface ReconcileOutcome {
    readonly attempted: number;
    readonly acknowledged: number;
    readonly outstanding: readonly string[];
    readonly warning: string | null;
}

/**
 * Both resolved outcomes re-report as **Result** (contract §3); an `unknown`
 * record never reaches here, because it is surfaced, never reported (FR-025).
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
    const body = `Reconciliation needs the operator for ${runs}. ${input.reasons.join(' ')}`;

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
    attempted: number;
    acknowledged: number;
    readonly outstanding: string[];
    readonly reasons: string[];
    readonly refusals: string[];
}

function resolvedAttempts(document: DispatchRecordDocument): readonly DispatchAttemptRecord[] {
    return unacknowledgedAttempts(document).filter((attempt) => attempt.outcome !== 'unknown');
}

function unknownAttempts(document: DispatchRecordDocument): readonly DispatchAttemptRecord[] {
    return unacknowledgedAttempts(document)
        .filter((attempt) => attempt.outcome === 'unknown' && attempt.settledAt === null);
}

/**
 * Re-report every outstanding resolved attempt inside the remaining budget.
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

    for (const attempt of resolvedAttempts(input.document)) {
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

function checkLine(verdict: SettleVerdict): string {
    if (verdict === 'unreadable') {
        return 'the panel could not check the service\'s audit trail for this attempt';
    }

    if (verdict === 'unconfirmed') {
        return 'the service recorded no result for it, so the run still needs your decision';
    }

    return 'the service\'s audit trail holds no outcome for it yet';
}

function unknownLine(rt: PanelRuntime, attempt: DispatchAttemptRecord, verdict: SettleVerdict): string {
    const hasRow = rt.state.dispatches.rows.some((row) => row.correlationId === attempt.correlationId);
    const row = hasRow
        ? 'the row offers "session created" or "no session created" once the run reads unconfirmed'
        : 'the loaded Dispatches list does not hold its row, so the row could not be read; once the run reads '
            + 'unconfirmed that row offers "session created" or "no session created"';

    return `${attempt.correlationId}: an authorized dispatch was never recorded as producing a session — `
        + `project ${attempt.projectId ?? 'not recorded'}, worktree option `
        + `${attempt.worktreeOption ?? 'not recorded'}, attachment ${attempt.correlationId}. `
        + `Check OpenChamber's session list; ${row}; ${checkLine(verdict)}.`;
}

/** After the re-reports, so a slow audit read can never block them. */
async function surfaceUnknown(input: {
    readonly rt: PanelRuntime;
    readonly document: DispatchRecordDocument;
    readonly clock: () => number;
    readonly startedAt: number;
    readonly pass: PassResult;
}): Promise<void> {
    const { rt, document, clock, startedAt, pass } = input;

    for (const attempt of unknownAttempts(document)) {
        if (!withinBudget(clock, startedAt)) {
            pass.outstanding.push(attempt.correlationId);
            pass.reasons.push(`${attempt.correlationId}: the panel could not check the service's audit trail — the `
                + `${RECONCILE_BUDGET_MS / MS_PER_SECOND}s budget ran out.`);

            continue;
        }

        const verdict = await readSettleVerdict({ rt, attempt, clock, startedAt });
        if (verdict === 'settled') {
            if (await settleDispatchAttempt({
                rt,
                correlationId: attempt.correlationId,
                attempt: attempt.attempt,
            })) {
                continue;
            }

            pass.outstanding.push(attempt.correlationId);
            pass.reasons.push(`${attempt.correlationId}: the attempt is past, but the panel could not write the `
                + 'settlement down, so it is surfaced again next mount.');

            continue;
        }

        pass.outstanding.push(attempt.correlationId);
        pass.reasons.push(unknownLine(rt, attempt, verdict));
    }
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
    await surfaceUnknown({ rt, document: read.document, clock, startedAt, pass });
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
