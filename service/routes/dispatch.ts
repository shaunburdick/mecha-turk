/**
 * The authorization routes: reserve, result, abandon, and block report (003
 * FR-020 – FR-023, FR-026, FR-028, FR-040, FR-042; contract §1–§4).
 *
 * These four paths are the service side of the impossibility requirement
 * (FR-028): between them they are the only way a run acquires an authorization to
 * start a session, and the only ways that authorization is spent. The routes are
 * deliberately thin — parse, delegate, map — because every decision worth
 * arguing about lives in [`dispatch-authorize.ts`](../poll/dispatch-authorize.ts),
 * where it is a pure function of the run and can be tested without a socket.
 *
 * Three wire facts this module owns:
 *
 * - **`/dispatched` is now addressed by the run.** It used to take a delivery id
 *   and flip a queue row; a post-003 delivery carries no lifecycle state of its
 *   own (data-model §2.1), so that route could only ever answer `404`. The path
 *   shape is unchanged and the parameter is renamed, which is exactly the
 *   contract's wire delta: "Addressed by the run, not the delivery."
 * - **A report names one outcome or the other, never both.** A body carrying a
 *   session id *and* a problem is refused rather than resolved by a precedence
 *   rule: FR-040's whole point is that the two are different facts, and guessing
 *   which one the caller meant is exactly the ambiguity constitution II forbids.
 * - **Every answer carries `auditWritten`** (FR-063). `false` means the state
 *   change is durable and its lifecycle row is not, and the panel turns that into
 *   a visible warning naming the run rather than implying traceability it does not
 *   have.
 */

import { reserveDispatch } from '../poll/dispatch-authorize.ts';
import { BLOCKED_REASONS, blockDispatch } from '../poll/dispatch-block.ts';
import { reportDispatch } from '../poll/dispatch-report.ts';
import { errorResponse, STATUS, storageUnavailableResponse, validationResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import { RUN_SCOPE_PREFIX, isRefusal, pathCorrelationId, readRunScopeRequest } from './run-scope.ts';
import { refuseRunRequest, runAnswer, runOutcomeResponse, unknownRunResponse } from './run-answer.ts';
import { overLongTextResponse, sessionIdIssue, textMember } from './run-fields.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** The panel declares intent to start a session and receives its token. */
export const RESERVE_PATH = `${RUN_SCOPE_PREFIX}/reserve`;

/** The panel reports what the host call produced. */
export const DISPATCHED_PATH = `${RUN_SCOPE_PREFIX}/dispatched`;

/** The panel reports that a reserved attempt created no session. */
export const ABANDON_PATH = `${RUN_SCOPE_PREFIX}/abandon`;

/** The panel reports that a fail-closed guard refused before any host call. */
export const BLOCKED_PATH = `${RUN_SCOPE_PREFIX}/blocked`;

/**
 * Answer `POST /v1/events/:correlationId/reserve`.
 *
 * Mints the single-use token and records the reservation in the same write that
 * moves the run to `starting`, so a run holding an authorization is never also
 * `claimed` and therefore never invisible to the sweep. Every refusal writes one
 * `dispatch.refused` row and mints nothing.
 *
 * @returns `200 { correlationId, attempt, dispatchToken, tokenExpiresAt,
 *   resultDeadlineAt, state, auditWritten }`, or the documented
 *   `404`/`409`/`422`/`503`.
 */
async function handleReserve(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { leaseId: true } });
    if (isRefusal(parsed)) {
        return await refuseRunRequest({ context, operation: 'reserve', correlationId, response: parsed });
    }

    const reserved = await reserveDispatch({
        store,
        log: context.log,
        correlationId,
        leaseId: parsed.leaseId,
        attempt: parsed.attempt,
    });

    return runOutcomeResponse({ context, operation: 'reserve', outcome: reserved, success: (run, auditWritten) => ({
        ...runAnswer({ correlationId, run, auditWritten }),
        // The token is the one thing this route hands back, and neither a
        // refusal nor a duplicate has one to give: answering `null` rather than
        // omitting the member keeps the panel's parser from branching on
        // whether the key is present. Both deadlines ride beside it for the same
        // reason — the lease says when the *claim* dies, the deadline says when
        // the *authorization* is reported or wedged (T-043d).
        dispatchToken: reserved.status === 'applied' ? reserved.dispatchToken : null,
        tokenExpiresAt: reserved.status === 'applied' ? reserved.tokenExpiresAt : null,
        resultDeadlineAt: reserved.status === 'applied' ? reserved.resultDeadlineAt : null,
    }) });
}

/** What a result body said, after exactly one outcome validated. */
type ResultOutcome =
    | { readonly ok: true; readonly sessionId: string | null; readonly problem: string | null }
    | { readonly ok: false; readonly response: HttpResponse };

/**
 * Read a result body's outcome: exactly one of `sessionId` / `problem`, and a
 * session in the host's own shape.
 *
 * FR-040's whole point is that the two are different facts, so a body carrying
 * both or neither is refused rather than resolved by a precedence rule — which
 * is the ambiguity constitution II forbids. The session id is checked where it
 * enters because it is echoed into the run's state reason, its attempt record,
 * and audit details (T-043f).
 *
 * @returns The outcome, or the `422` naming what was wrong.
 */
function readResultOutcome(fields: Readonly<Record<string, unknown>>): ResultOutcome {
    const sessionId = textMember(fields.sessionId);
    const problem = textMember(fields.problem);
    const hasSession = sessionId !== null;
    const hasProblem = problem !== null;
    // Exactly one of the two is the contract, so "both" and "neither" are the
    // same refusal — which is what one equality between the two flags states.
    if (hasSession === hasProblem) {
        return {
            ok: false,
            response: errorResponse(STATUS.validation, {
                code: 'validation',
                message: 'report exactly one outcome: the session that was created, '
                    + 'or the problem that prevented one',
            }),
        };
    }

    const sessionIssue = sessionIdIssue(sessionId);

    return sessionIssue === null
        ? { ok: true, sessionId, problem }
        : { ok: false, response: validationResponse([sessionIssue]) };
}

/**
 * Answer `POST /v1/events/:correlationId/dispatched`.
 *
 * Reports the outcome of an authorized attempt. A report naming a session makes
 * the run `dispatched`; a report naming a problem makes it `failed` — never
 * `dispatched`. The reservation is consumed in the same write, and a
 * repeat of an outcome already recorded answers `200` unchanged with one
 * `dispatch.duplicate-report` row.
 *
 * @returns `200 { correlationId, attempt, state, auditWritten }`, or a refusal.
 */
async function handleDispatched(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { dispatchToken: true } });
    if (isRefusal(parsed)) {
        return await refuseRunRequest({ context, operation: 'result', correlationId, response: parsed });
    }

    const report = readResultOutcome(parsed.fields);
    if (!report.ok) {
        return await refuseRunRequest({ context, operation: 'result', correlationId, response: report.response });
    }

    const reported = await reportDispatch({
        store,
        log: context.log,
        correlationId,
        dispatchToken: parsed.dispatchToken,
        attempt: parsed.attempt,
        operation: 'result',
        outcome: {
            attemptOutcome: report.sessionId === null ? 'failed' : 'dispatched',
            sessionId: report.sessionId,
            reason: report.problem,
        },
    });

    return runOutcomeResponse({ context, operation: 'result', outcome: reported, success: (run, auditWritten) =>
        runAnswer({ correlationId, run, auditWritten }) });
}

/**
 * Answer `POST /v1/events/:correlationId/abandon`.
 *
 * A reserved attempt that created no session because the panel aborted **before**
 * any host call. The run becomes retryable `failed` with the reason —
 * never `unconfirmed`, which would wedge a dispatch that provably happened. It is
 * distinguished from Result's `problem` shape by *when* it is true, not by the
 * state it ends in: both are honest, and both are `failed`.
 *
 * @returns `200 { correlationId, attempt, state, auditWritten }`, or a refusal.
 */
async function handleAbandon(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { dispatchToken: true } });
    if (isRefusal(parsed)) {
        return await refuseRunRequest({ context, operation: 'abandon', correlationId, response: parsed });
    }

    const reason = textMember(parsed.fields.reason);
    if (reason === null) {
        return await refuseRunRequest({
            context,
            operation: 'abandon',
            correlationId,
            response: errorResponse(STATUS.validation, {
                code: 'validation',
                message: 'reason: say why the reserved attempt was abandoned, so the failure row is readable',
            }),
        });
    }

    const abandoned = await reportDispatch({
        store,
        log: context.log,
        correlationId,
        dispatchToken: parsed.dispatchToken,
        attempt: parsed.attempt,
        operation: 'abandon',
        outcome: { attemptOutcome: 'abandoned', sessionId: null, reason },
    });

    return runOutcomeResponse({ context, operation: 'abandon', outcome: abandoned, success: (run, auditWritten) =>
        runAnswer({ correlationId, run, auditWritten }) });
}

/** What a block report body said, after its own members validated. */
type BlockReport =
    | { readonly ok: true; readonly blockedReason: string; readonly detail: string; readonly guidance: string | null }
    | { readonly ok: false; readonly response: HttpResponse };

/**
 * Read a block report's members: the cause, the detail, and the in-panel
 * guidance offered with it.
 *
 * The optional guidance is *read* first so a body with two problems is
 * collected all at once, and *reported* after the required cause so the more
 * fundamental failure — no `blockedReason` to build a parseable
 * `blocked:<reason>` state from (data-model §2.2) — is the one the operator
 * reads first. An over-long guidance is a `422` naming the field rather than a
 * silently absent one (T-043e).
 *
 * @param fields - The body's members, after FR-051's echo already matched.
 * @returns The report, or the `422` naming what was wrong.
 */
function readBlockReport(fields: Readonly<Record<string, unknown>>): BlockReport {
    const guidance = textMember(fields.guidance);
    const overlong = overLongTextResponse(fields, ['guidance']);
    const blockedReason = textMember(fields.blockedReason);
    const detail = textMember(fields.detail);
    if (blockedReason === null || detail === null || !BLOCKED_REASONS.has(blockedReason)) {
        return {
            ok: false,
            response: errorResponse(STATUS.validation, {
                code: 'validation',
                message: `blockedReason: name one of ${[...BLOCKED_REASONS].join(', ')}; detail: describe the cause`,
            }),
        };
    }

    if (overlong !== null) {
        return { ok: false, response: overlong };
    }

    return { ok: true, blockedReason, detail, guidance };
}

/**
 * Answer `POST /v1/events/:correlationId/blocked`.
 *
 * A fail-closed guard refused the dispatch before any host call. Valid
 * only from `claimed` under the live lease, and the blocked reason is checked
 * against the four declared causes so the resulting `blocked:<reason>` state stays
 * parseable (data-model §2.2). The attempt number and the automatic requeue
 * budget are untouched — a guard refusal consumes nothing, and the sweep never
 * touches a blocked run.
 *
 * @returns `200 { correlationId, attempt, state, auditWritten }`, or a refusal.
 */
async function handleBlocked(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: { leaseId: true } });
    if (isRefusal(parsed)) {
        return await refuseRunRequest({ context, operation: 'blocked', correlationId, response: parsed });
    }

    const report = readBlockReport(parsed.fields);
    if (!report.ok) {
        return await refuseRunRequest({ context, operation: 'blocked', correlationId, response: report.response });
    }

    const blocked = await blockDispatch({
        store,
        log: context.log,
        correlationId,
        leaseId: parsed.leaseId,
        attempt: parsed.attempt,
        blockedReason: report.blockedReason,
        detail: report.detail,
        guidance: report.guidance,
    });

    return runOutcomeResponse({ context, operation: 'blocked', outcome: blocked, success: (run, auditWritten) =>
        runAnswer({ correlationId, run, auditWritten }) });
}

/** Declare intent to start a session and receive the single-use token. */
export const reserveRoute: Route = {
    method: 'POST',
    path: RESERVE_PATH,
    handler: (context, request) => handleReserve(context, request),
};

/** Report the outcome of an authorized attempt. */
export const dispatchedRoute: Route = {
    method: 'POST',
    path: DISPATCHED_PATH,
    handler: (context, request) => handleDispatched(context, request),
};

/** Report that a reserved attempt created no session. */
export const abandonRoute: Route = {
    method: 'POST',
    path: ABANDON_PATH,
    handler: (context, request) => handleAbandon(context, request),
};

/** Report that a fail-closed guard refused before any host call. */
export const blockedRoute: Route = {
    method: 'POST',
    path: BLOCKED_PATH,
    handler: (context, request) => handleBlocked(context, request),
};
