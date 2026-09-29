/**
 * The operator routes: retry, return-to-waiting, resolve, and the verification
 * report (003 FR-027, FR-033, FR-041, FR-043; contract §5–§8).
 *
 * Four operations a human asks for and no timer ever asks for. Keeping them in
 * their own module — separate from the authorization family in
 * [`dispatch.ts`](./dispatch.ts) — is what makes FR-036 auditable by reading the
 * route table: the automatic handler is the sweep, and nothing on this page is
 * reachable without a request.
 *
 * Each route validates what its contract names and nothing more. The refusals
 * carry their own distinct wording (FR-041, FR-003) and 005 renders them
 * verbatim, so this module never composes a message from a template: the strings
 * live with the decisions, in
 * [`run-operate.ts`](../poll/run-operate.ts) and, for the read-back,
 * [`run-verify.ts`](../poll/run-verify.ts).
 *
 * "What its contract names" differs per operation on purpose: §5 and §6 carry
 * `attempt` beside the correlation echo and validate both, while §7 and §8 name
 * neither an attempt nor a lease — only FR-051's echo, which every one of them
 * carries. Requiring a member those two request bodies do not contain would be
 * a wire change the contract does not ask for; accepting an echo that
 * contradicts the path would be the silent partial apply FR-051 forbids.
 *
 * Two of the four carry a fact the service cannot check for itself, and each says
 * so on the wire rather than implying a verification it did not perform:
 * `retry` on a `blocked:project-missing` run audits the panel's report as
 * *reported* cleared (the service may not call host APIs), and `resolve` records
 * the operator's own note about what they checked (constitution IV: the honesty
 * of the operator's verification is the operator's).
 */

import { errorResponse, STATUS, storageUnavailableResponse } from '../http.ts';
import { requeueDispatch, resolveDispatch, retryDispatch } from '../poll/run-operate.ts';
import { recordVerification } from '../poll/run-verify.ts';
import type { HttpResponse } from '../http.ts';
import type { ResolveDecision } from '../poll/run-operate.ts';
import {
    RUN_SCOPE_PREFIX,
    flagMember,
    isRefusal,
    pathCorrelationId,
    readRunScopeBody,
    readRunScopeRequest,
    runAnswer,
    runOutcomeResponse,
    textMember,
    unknownRunResponse,
} from './run-scope.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** The operator returns a failed or blocked run to waiting. */
export const RETRY_PATH = `${RUN_SCOPE_PREFIX}/retry`;

/** The operator returns a dead-lettered run to waiting, resetting its counters. */
export const REQUEUE_PATH = `${RUN_SCOPE_PREFIX}/requeue`;

/** The operator settles an `unconfirmed` run one of two explicit ways. */
export const RESOLVE_PATH = `${RUN_SCOPE_PREFIX}/resolve`;

/** The panel posts the post-dispatch agent read-back. */
export const VERIFICATION_PATH = `${RUN_SCOPE_PREFIX}/verification`;

/** The two explicit resolutions; anything else is refused as unknown. */
const RESOLVE_DECISIONS: ReadonlySet<string> = new Set<ResolveDecision>(['session-created', 'no-session']);

/** The decision whose proof is a session the operator names (FR-027). */
const SESSION_CREATED = 'session-created';

/**
 * Narrow a body member to one of the two explicit resolutions (FR-027).
 *
 * `Set.has` cannot narrow a `string` to the set's element type on its own, and
 * widening the decision back to `string` would push an unchecked value into
 * `resolveDispatch` — the one operation whose `decision` decides whether a run
 * may be re-dispatched. The guard is where the union is enforced.
 *
 * @param value - The member as read from the body.
 * @returns `true` for `session-created` and `no-session`.
 */
function isResolveDecision(value: string): value is ResolveDecision {
    return RESOLVE_DECISIONS.has(value);
}

/** What a resolve body read: either its two members, or the refusal to answer. */
type ResolutionRead =
    | { readonly ok: true; readonly decision: ResolveDecision; readonly sessionId: string | null }
    | { readonly ok: false; readonly response: HttpResponse };

/**
 * Read a resolve body's own members: the decision, and the session it names.
 *
 * Split out of the handler because these are the checks that make an ambiguous
 * body *stay* ambiguous rather than be resolved by a precedence rule, and
 * because `no-session` is the only path that re-dispatches an `unconfirmed` run:
 *
 * - `session-created` requires the session id — without it the operator's
 *   decision records a fact the row cannot carry.
 * - `no-session` **rejects** one — silently discarding it would obtain a fresh
 *   authorization for a run whose session the same body just reported, which is
 *   exactly the ambiguity the result handler refuses with "report exactly one
 *   outcome" (FR-040, constitution II).
 *
 * @param fields - The body's members, after FR-051's echo already matched.
 * @returns The decision and the session it names, or the `422` naming the field.
 */
function readResolution(fields: Readonly<Record<string, unknown>>): ResolutionRead {
    const decision = textMember(fields.decision);
    const sessionId = textMember(fields.sessionId);
    if (decision === null || !isResolveDecision(decision)) {
        return {
            ok: false,
            response: errorResponse(STATUS.validation, {
                code: 'validation',
                message: `decision: choose ${[...RESOLVE_DECISIONS].join(' or ')}`,
            }),
        };
    }

    if (decision === SESSION_CREATED && sessionId === null) {
        return {
            ok: false,
            response: errorResponse(STATUS.validation, {
                code: 'validation',
                message: 'sessionId: this dispatch did create a session, so name the session id to record',
            }),
        };
    }

    if (decision !== SESSION_CREATED && sessionId !== null) {
        return {
            ok: false,
            response: errorResponse(STATUS.validation, {
                code: 'validation',
                message: 'sessionId: a no-session resolution reports that no session exists, so name exactly one '
                    + 'outcome — drop sessionId, or choose session-created to record it',
            }),
        };
    }

    return {
        ok: true,
        decision,
        sessionId: decision === SESSION_CREATED ? sessionId : null,
    };
}

/**
 * Answer `POST /v1/events/:correlationId/retry`.
 *
 * Returns a `failed` or `blocked:*` run to waiting under the **same run key**,
 * incrementing the attempt exactly once and preserving the source references and
 * every prior attempt's record (FR-041). It does not create a new run, so the
 * ordinal counter is untouched.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the path captures `:correlationId`.
 * @returns `200 { correlationId, attempt, state }`, or a distinct refusal.
 */
async function handleRetry(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: {} });
    if (isRefusal(parsed)) {
        return parsed;
    }

    const retried = await retryDispatch({
        store,
        log: context.log,
        correlationId,
        attempt: parsed.attempt,
        causeCleared: flagMember(parsed.fields.causeCleared, false),
        causeReport: textMember(parsed.fields.causeReport),
    });

    return runOutcomeResponse({
        context,
        operation: 'retry',
        outcome: retried,
        success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten }),
    });
}

/**
 * Answer `POST /v1/events/:correlationId/requeue`.
 *
 * The single control that resolves a `dead-lettered` run, and the one that
 * resets the attempt count (FR-033). `confirm` is required: the reset discards
 * the budget accounting that dead-lettering produced, so it is taken only when the
 * caller says so rather than inferred from the request's existence.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the path captures `:correlationId`.
 * @returns `200 { correlationId, attempt, state }`, or the refusal.
 */
async function handleRequeue(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    // §7's body carries `correlationId` and `confirm` and no attempt member, so
    // the echo is validated and the reset counter is not required of the caller.
    const body = readRunScopeBody({ raw: request.body, correlationId });
    if (isRefusal(body)) {
        return body;
    }

    if (flagMember(body.fields.confirm, false) !== true) {
        return errorResponse(STATUS.validation, {
            code: 'validation',
            message: 'confirm: returning a run to waiting resets its attempt count; confirm that explicitly',
        });
    }

    const requeued = await requeueDispatch({ store, log: context.log, correlationId });

    return runOutcomeResponse({
        context,
        operation: 'requeue',
        outcome: requeued,
        success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten }),
    });
}

/**
 * Answer `POST /v1/events/:correlationId/resolve`.
 *
 * The operator's two explicit resolutions of an `unconfirmed` run (FR-027).
 * `session-created` requires the session id, and `no-session` is the **only** path
 * that re-dispatches an `unconfirmed` run — the one place in the service where a
 * second `host.startSession()` can be authorized for a run that may already have
 * one, which is exactly why it is an explicit, audited human decision. A body
 * that carries a session id *with* `no-session` is therefore refused `422`
 * naming `sessionId` rather than silently dropped: the request would otherwise
 * obtain a fresh authorization for a run whose session it just reported.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the path captures `:correlationId`.
 * @returns `200 { correlationId, attempt, state }`, or the refusal.
 */
async function handleResolve(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    // §8's body carries `correlationId`, the decision, and the operator's own
    // members — no attempt member, so the echo is all the shared validation
    // applies here.
    const parsedBody = readRunScopeBody({ raw: request.body, correlationId });
    if (isRefusal(parsedBody)) {
        return parsedBody;
    }

    const { fields } = parsedBody;
    const resolution = readResolution(fields);
    if (!resolution.ok) {
        return resolution.response;
    }

    const resolved = await resolveDispatch({
        store,
        log: context.log,
        correlationId,
        decision: resolution.decision,
        sessionId: resolution.sessionId,
        note: textMember(fields.note),
        guidance: textMember(fields.guidance),
    });

    return runOutcomeResponse({
        context,
        operation: 'resolve',
        outcome: resolved,
        success: (run, auditWritten) => runAnswer({ correlationId, run, auditWritten }),
    });
}

/** One parsed verification body: what §5 names, after every shared check passed. */
interface ReadBack {
    /** Attempt the panel's request names; validated against the run. */
    readonly attempt: number;
    /** The session the read-back came from. */
    readonly sessionId: string;
    /** The agent the read-back observed, or `null` when unreadable. */
    readonly observedAgent: string | null;
    /** The agent the binding expected. */
    readonly expectedAgent: string;
    /** Whether the two matched. */
    readonly ok: boolean;
    /** Note explaining a mismatch or an unreadable read-back. */
    readonly note: string | null;
}

/**
 * Read one verification body: the shared members first, then §5's own.
 *
 * Split out of the handler because these are two distinct refusals that must
 * not blur — a body that fails FR-051's echo or §5's attempt is a `422` about
 * the *run identity*, and a body missing the read-back itself is a `422` about
 * the *report*.
 *
 * @param request - Routed request; the path captures `:correlationId`.
 * @param correlationId - The run the path named.
 * @returns The parsed read-back, or the `422` that names what was wrong.
 */
function readReadBack(request: RouteRequest, correlationId: string): ReadBack | HttpResponse {
    const parsed = readRunScopeRequest({ raw: request.body, correlationId, needs: {} });
    if (isRefusal(parsed)) {
        return parsed;
    }

    const { fields, attempt } = parsed;
    const sessionId = textMember(fields.sessionId);
    const expectedAgent = textMember(fields.expectedAgent);
    if (sessionId === null || expectedAgent === null) {
        return errorResponse(STATUS.validation, {
            code: 'validation',
            message: 'sessionId and expectedAgent: both are required to file a read-back against this run',
        });
    }

    return {
        attempt,
        sessionId,
        expectedAgent,
        observedAgent: textMember(fields.observedAgent),
        ok: flagMember(fields.ok, false),
        note: textMember(fields.note),
    };
}

/**
 * Answer `POST /v1/events/:correlationId/verification`.
 *
 * Records the post-dispatch agent read-back and **changes no state** (FR-043):
 * a mismatch is shown as a warning and audited, never acted on again. The session
 * id must be the one the run recorded, so a read-back of some other session
 * cannot be filed against this run.
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the path captures `:correlationId`.
 * @returns `200 { correlationId, attempt, state, verification }`, or the refusal.
 */
async function handleVerification(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const correlationId = pathCorrelationId(request.params.correlationId);
    if (correlationId === null) {
        return unknownRunResponse();
    }

    // §5's body carries `correlationId` and `attempt` beside the read-back, so
    // both shared members are required here exactly as on the authorization
    // family: a caller describing a run it no longer sees is refused rather than
    // half-applied (contract, common body fields; FR-051).
    const readBack = readReadBack(request, correlationId);
    if ('status' in readBack) {
        return readBack;
    }

    const recorded = await recordVerification({
        store,
        log: context.log,
        correlationId,
        ...readBack,
    });

    return runOutcomeResponse({
        context,
        operation: 'verification',
        outcome: recorded,
        success: (run, auditWritten) => ({
            ...runAnswer({ correlationId, run, auditWritten }),
            verification: run.verification === null ? null : {
                observedAgent: run.verification.observedAgent,
                expectedAgent: run.verification.expectedAgent,
                ok: run.verification.ok,
                note: run.verification.note,
            },
        }),
    });
}

/** Return a failed or blocked run to waiting under the same run key. */
export const retryRunRoute: Route = {
    method: 'POST',
    path: RETRY_PATH,
    handler: (context, request) => handleRetry(context, request),
};

/** Return a dead-lettered run to waiting with its attempt count reset. */
export const requeueRunRoute: Route = {
    method: 'POST',
    path: REQUEUE_PATH,
    handler: (context, request) => handleRequeue(context, request),
};

/** Settle an `unconfirmed` run one of two explicit ways. */
export const resolveRunRoute: Route = {
    method: 'POST',
    path: RESOLVE_PATH,
    handler: (context, request) => handleResolve(context, request),
};

/** File the post-dispatch agent read-back; never changes the run's state. */
export const verificationRoute: Route = {
    method: 'POST',
    path: VERIFICATION_PATH,
    handler: (context, request) => handleVerification(context, request),
};
