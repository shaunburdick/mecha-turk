/**
 * Turning a run-scoped operation's answer into the response the panel sees, and
 * into the row the trail owes it (003 FR-003, FR-063;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md)).
 *
 * Split out of [`run-scope.ts`](./run-scope.ts), which reads a request, so that
 * one module owns *reading* and this one owns *answering*: a refusal must look
 * the same whichever of the eight routes produced it, and "one code → one
 * status, one envelope, no per-route drift" is only checkable when there is one
 * place that makes the mapping. Three things live here:
 *
 * - **`REFUSAL_STATUS`** — the whole `RunRefusalCode` union mapped to its HTTP
 *   status, so a new code is a compile-time omission rather than a silent `409`.
 * - **`runOutcomeResponse` / `runAnswer`** — the `200` every run-scoped mutation
 *   answers with, plus FR-063's degraded-trail warn, which runs for a refusal
 *   exactly as it runs for a success.
 * - **`refuseRunRequest`** — the `dispatch.refused` row a `422` owes when the
 *   path names a run that exists (contract §9 as T-044 narrows it), reading the
 *   run inside the chain so the row's `priorState` and `attempt` are this
 *   request's.
 */

import { errorResponse, STATUS } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import { appendRefusalRow, operateRun } from '../poll/run-chain.ts';
import { refuse } from '../poll/run-refusal.ts';
import type { RunRefusal, RunResult } from '../poll/run-refusal.ts';
import type { Run } from '../poll/runs-types.ts';
import type { RouteContext } from './types.ts';

/** Every run-scoped refusal code and the status it answers with. */
const REFUSAL_STATUS = new Map<RunRefusal['code'], number>([
    ['unknown-run', STATUS.notFound],
    ['stale-lease', STATUS.conflict],
    ['already-reserved', STATUS.conflict],
    ['already-dispatched', STATUS.conflict],
    ['invalid-transition', STATUS.conflict],
    // The actor-policy gate (003 FR-077). A `409` like every other state verdict
    // on this path: the run exists, the request was well-formed, and the service
    // answered "not authorized" — which the panel then reports as
    // `blocked:actor-not-allowed` through the existing block report.
    ['actor-not-allowed', STATUS.conflict],
    ['cause-not-cleared', STATUS.conflict],
    // Mapped for completeness: a `422` is refused by this module through
    // {@link refuseRunRequest} rather than routed through
    // {@link runOutcomeResponse}, so nothing answers with this entry today — but
    // a map keyed by the whole union that silently defaulted a member would be
    // one refactor away from turning a validation failure into a conflict.
    ['validation', STATUS.validation],
]);

/**
 * The `404` for an operation addressed to a run this service does not have.
 *
 * @returns The unknown-run response (contract §Error-code additions).
 */
export function unknownRunResponse(): HttpResponse {
    return errorResponse(STATUS.notFound, {
        code: 'unknown-run',
        message: 'no run carries this correlation id; refresh, it may have been evicted',
    });
}

/**
 * Turn one operation's answer into the response the panel sees.
 *
 * The refusal message is the operation's own, verbatim (contract: 005 renders
 * these strings), and it is the same string the `dispatch.refused` row records —
 * which is why this function only ever *copies* it and never composes one.
 *
 * A degraded trail is logged here rather than in each route, because FR-063's
 * "must not be swallowed" obligation is the same obligation for all eight
 * operations and one log line is what makes it observable in the service log.
 *
 * @param context - Route context, for the log a degraded trail leaves.
 * @param operation - The operation name, for that log line.
 * @param outcome - Whatever the operation returned.
 * @param success - Builds the `200` body from the run; a duplicate gets the same
 *   body, because a repeat changed nothing and must look like it.
 * @returns The response to write.
 */
export function runOutcomeResponse(input: {
    /** Route context, for the log a degraded trail leaves. */
    readonly context: RouteContext;
    /** The operation name, for that log line. */
    readonly operation: string;
    /** Whatever the operation returned. */
    readonly outcome: RunResult;
    /** Builds the `200` body from the run; a duplicate gets the same body. */
    readonly success: (run: Run, auditWritten: boolean) => Record<string, unknown>;
}): HttpResponse {
    const { context, operation, outcome, success } = input;
    if (outcome.status === 'not-found') {
        return unknownRunResponse();
    }

    // FR-063's "must not be swallowed" is one obligation for all eight
    // operations, and a refusal owes it exactly as a success does: when a
    // `dispatch.refused` row fails to append, the panel is told its request was
    // refused and the trail says nothing about it — the one case an operator
    // most needs to be able to reconstruct. The warn therefore runs *before* the
    // refusal answers, not only on the `200` path.
    if (!outcome.auditWritten && outcome.run !== null) {
        context.log.warn('dispatch operation could not record its row', {
            correlationId: outcome.run.correlationId,
            operation,
            outcome: outcome.status,
        });
    }

    if (outcome.status === 'refused') {
        const { code, message, referenceWindow } = outcome.refusal;

        // `referenceWindow` rides the envelope only where the gate set it, and is
        // **copied** like the message rather than re-derived here: the route layer
        // knows a status and a code, and the window is a fact about the decision
        // the run layer just made (constitution II). Its absence is meaningful —
        // it is how a panel tells "the gate judged the whole list" from "this
        // build states no window" — so it is never defaulted to `complete`.
        return errorResponse(REFUSAL_STATUS.get(code) ?? STATUS.conflict, {
            code,
            message,
            ...(referenceWindow === undefined ? {} : { referenceWindow }),
        });
    }

    return { status: STATUS.ok, body: success(outcome.run, outcome.auditWritten) };
}

/** The `200` body every run-scoped mutation answers with, plus `auditWritten`. */
export function runAnswer(input: {
    /** The run the path named. */
    readonly correlationId: string;
    /** The run as it stands; a duplicate repeats it byte-stably. */
    readonly run: Run;
    /** Whether the lifecycle row reached the trail (FR-063). */
    readonly auditWritten: boolean;
}): Record<string, unknown> {
    return {
        correlationId: input.correlationId,
        attempt: input.run.attempt,
        state: input.run.state,
        auditWritten: input.auditWritten,
    };
}

/** What a refusal row records when its response carries no message to copy. */
const UNREADABLE_BODY_REASON = 'the request did not validate';

/** Narrow a value to a plain JSON object, without casting through `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The secret-free cause a `422` response already carries, read from its own
 * envelope.
 *
 * Derived rather than passed in so the trail and the wire cannot drift: the
 * `dispatch.refused` row records "the same secret-free cause the response
 * carries" (contract §9), and one source for both is what makes that claim
 * checkable instead of aspirational. Two refusal shapes exist —
 * {@link validationResponse}'s `field: remediation` list, restated into
 * `message`, and the free-prose `errorResponse` — and both put their cause in
 * `error.message`, which is all this reads.
 *
 * @param response - The `422` about to be answered with.
 * @returns The cause, or a fixed one when the envelope carries none.
 */
function refusalReason(response: HttpResponse): string {
    const { body } = response;
    if (!isRecord(body) || !isRecord(body.error)) {
        return UNREADABLE_BODY_REASON;
    }

    const { message } = body.error;

    return typeof message === 'string' && message.length > 0 ? message : UNREADABLE_BODY_REASON;
}

/**
 * Answer a run-scoped request that failed validation, recording the row the run
 * is owed first.
 *
 * Contract §9 promises a `dispatch.refused` row for every `4xx` an operation in
 * this directory answers — narrowed by T-044 to the state verdicts **plus** a
 * `422` on a run that exists, because a state verdict is refused inside its
 * operation module while a malformed body never reaches one. The run is read
 * inside the chain the operation modules use, so the row's `priorState` and
 * `attempt` are the run's as of this request rather than a snapshot taken
 * before it, and nothing is written when no run carries the id: there is no
 * entity to attach a row to (contract §9's own scope reading).
 *
 * A failed append is logged by {@link appendRunRow} itself, naming the run and
 * the event type, so FR-063's surfacing holds here too even though a `422`
 * envelope has nowhere to carry `auditWritten`.
 *
 * @param context - Route context, carrying the open store and logger.
 * @param operation - The operation name the row records (`reserve`, `result`, …).
 * @param correlationId - The run the path named.
 * @param response - The `422` to answer with; its message is the row's reason.
 * @returns The response unchanged, once the row has been attempted.
 */
export async function refuseRunRequest(input: {
    /** Route context, carrying the open store and logger. */
    readonly context: RouteContext;
    /** The operation name the row records. */
    readonly operation: string;
    /** The run the path named. */
    readonly correlationId: string;
    /** The `422` to answer with. */
    readonly response: HttpResponse;
}): Promise<HttpResponse> {
    const { context, correlationId, operation, response } = input;
    const { store } = context;
    if (store !== null) {
        const reason = refusalReason(response);
        await operateRun(
            { store, log: context.log, correlationId },
            async ({ run }) =>
                await appendRefusalRow({
                    store,
                    log: context.log,
                    refusal: { run, operation, refusal: refuse('validation', reason), attempt: run.attempt },
                }),
        );
    }

    return response;
}
