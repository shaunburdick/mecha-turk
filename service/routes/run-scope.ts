/**
 * Shared request handling for every **run-scoped** operation under
 * `/v1/events/:correlationId/…` (003 FR-051;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md)).
 *
 * Eight routes across two modules answer this shape, and three things must be
 * identical across all of them or the panel cannot rely on any of them:
 *
 * - **What identifies the run.** The path segment is the run's correlation id,
 *   and the body echoes it (FR-051: the service mints it, the panel must not
 *   substitute it). A body that contradicts the path is a validation failure,
 *   never a silently-preferred one of the two.
 * - **What a refusal looks like on the wire.** One code → one status, one
 *   envelope, no per-route drift: `409` for every state verdict, `404` for an
 *   unknown run, `422` for a malformed body.
 * - **What a refusal is worth afterwards.** Every refusal about a run that
 *   *exists* writes exactly one `dispatch.refused` row (FR-003), through the
 *   operation modules, which own that write. This module only owns the mapping
 *   from an operation's answer to a status code and a message.
 *
 * The one refusal with no row is `unknown-run`, and it is deliberate rather than
 * an oversight: there is no run, so there is no entity, no prior state, and no
 * attempt for the row to name, and the contract's rule that the row's entity and
 * correlation are the run's would have to be faked to write one. The panel is
 * told the run is gone; the trail records nothing rather than a fabricated
 * entity.
 */

import { errorResponse, STATUS, validationResponse } from '../http.ts';
import type { FieldIssue, HttpResponse } from '../http.ts';
import type { RunRefusal, RunResult } from '../poll/run-refusal.ts';
import type { Run } from '../poll/runs-types.ts';
import type { RouteContext } from './types.ts';

/** Longest correlation id a path may present before it is refused outright. */
const MAX_CORRELATION_ID_CHARS = 64;

/** The correlation id this build mints: `mt-run-` plus 24 hex characters. */
const CORRELATION_ID_PATTERN = /^mt-run-[0-9a-f]{24}$/;

/** The lease id a panel claim mints; the other shape adoption mints is internal. */
const LEASE_ID_PATTERN = /^lse-[0-9a-f]{24}$/;

/** The single-use token's minted shape; anything else is not a token. */
const DISPATCH_TOKEN_PATTERN = /^dtk-[0-9a-f]{32}$/;

/** Path prefix every run-scoped operation shares. */
export const RUN_SCOPE_PREFIX = '/v1/events/:correlationId';

/** Longest free-text body member the operations accept. */
export const MAX_BODY_TEXT_CHARS = 1_000;

/**
 * Read the `:correlationId` segment a route pattern captured.
 *
 * The pipeline hands the segment through **still URL-escaped** and deliberately
 * does not decode it, so a route must not trust an encoding: this accepts only
 * the one shape the service itself mints, which no escape sequence can produce.
 *
 * @param raw - The captured segment, or `undefined` for a non-parameterised path.
 * @returns The correlation id, or `null` when the segment is not one.
 */
export function pathCorrelationId(raw: string | undefined): string | null {
    if (raw === undefined || raw.length === 0 || raw.length > MAX_CORRELATION_ID_CHARS) {
        return null;
    }

    return CORRELATION_ID_PATTERN.test(raw) ? raw : null;
}

/** A parsed request body for a run-scoped operation. */
export interface RunScopeRequest {
    /** The run the path named. */
    readonly correlationId: string;
    /** The attempt the caller believes is current. */
    readonly attempt: number;
    /** Lease the caller presented, when it presented a well-formed one. */
    readonly leaseId: string | null;
    /** Token the caller presented, when it presented a well-formed one. */
    readonly dispatchToken: string | null;
    /** Every member of the body, for each operation's own fields. */
    readonly fields: Readonly<Record<string, unknown>>;
}

/** The parsed request when the operation required a lease id. */
export type LeaseRequest = RunScopeRequest & { readonly leaseId: string };

/** The parsed request when the operation required a dispatch token. */
export type TokenRequest = RunScopeRequest & { readonly dispatchToken: string };

/**
 * Which optional shared members one operation insists on.
 *
 * The three shapes exist so the overloads can promise a *non-null* lease id or
 * token to the operations that required it. The alternative is every call site
 * casting away a `null` the parser has already proved cannot be there — and a
 * cast is exactly where a future refactor stops being checked.
 */
export type RunScopeNeeds =
    /** Takes a lease and no token: reserve, block report. */
    | { readonly leaseId: true; readonly dispatchToken?: false }
    /** Takes a token and no lease: result, abandon. */
    | { readonly leaseId?: false; readonly dispatchToken: true }
    /** Takes neither: the operator operations. */
    | { readonly leaseId?: false; readonly dispatchToken?: false };

/** The parse result with the collected issues, before the refusal decision. */
interface RunScopeParse extends RunScopeRequest {
    /** Every rejected member; empty when the body is usable. */
    readonly issues: readonly FieldIssue[];
}

/** What to tell the operator when a body is not the JSON object the contract names. */
const BODY_REMEDIATION = 'send a JSON object carrying the run identity and attempt';

/** What to tell the operator when the body's run identity disagrees with the path. */
const ECHO_REMEDIATION = 'echo the run correlation id exactly as the path names it';

/**
 * Whether a received body is the plain JSON object every run-scoped contract
 * shape is written as.
 *
 * @param raw - The parsed body, or `undefined` when the request carried none.
 * @returns `true` for a non-array, non-null object (or no body at all).
 */
function isBodyObject(raw: unknown): boolean {
    return raw === undefined || (typeof raw === 'object' && raw !== null && !Array.isArray(raw));
}

/**
 * The one rejected body member, and what would fix it.
 *
 * @param record - The body's members.
 * @param correlationId - The run the path named.
 * @returns The `correlationId` issue when the echo disagrees, else `null`.
 */
function echoIssue(record: Readonly<Record<string, unknown>>, correlationId: string): FieldIssue | null {
    // FR-051: the service mints the id and the panel must not substitute it, so
    // an echo that disagrees with the path is refused rather than reconciled.
    return record.correlationId === correlationId
        ? null
        : { field: 'correlationId', remediation: ECHO_REMEDIATION };
}

/**
 * Read one optional member, refusing anything that is not the shape minted.
 *
 * @param value - The member as received, or `undefined`.
 * @param pattern - The exact shape this build mints for it.
 * @returns The member, or `null` when absent or malformed.
 */
function readMember(value: unknown, pattern: RegExp): string | null {
    return typeof value === 'string' && pattern.test(value) ? value : null;
}

/**
 * The one rejected member, and what would fix it.
 *
 * A rejection is always `{ field, remediation }`: the service names the member
 * and the fix and **never echoes what it received** (SEC-11 / contract §1).
 */
type MemberIssue = FieldIssue;

/**
 * Read one shared member and collect its issue, when the operation requires it.
 *
 * @param input - The record, the member's name, its shape, and whether it is required.
 * @returns The member as received.
 */
function requiredMember(input: {
    /** The body's members. */
    readonly record: Readonly<Record<string, unknown>>;
    /** The member's name, as the panel sends it. */
    readonly name: string;
    /** The exact shape this build mints for it. */
    readonly pattern: RegExp;
    /** What to tell the operator when the member is missing or malformed. */
    readonly remediation: string;
    /** Whether this operation insists on the member. */
    readonly required: boolean;
    /** Where a refusal is collected. */
    readonly issues: MemberIssue[];
}): string | null {
    const value = readMember(input.record[input.name], input.pattern);
    if (input.required && value === null) {
        input.issues.push({ field: input.name, remediation: input.remediation });
    }

    return value;
}

/**
 * Collect every problem with a run-scoped body's shared members.
 *
 * All members are read and reported together rather than short-circuiting at the
 * first problem: a panel that fixed one field at a time would need four round
 * trips to learn what is wrong, and the 422 is the one place that can say all of
 * it at once.
 *
 * @param input - The parsed body, the run the path named, and what is required.
 * @returns The members as received, plus every issue found.
 */
function parseRunScopeRequest(input: {
    /** Parsed body, or `undefined` when the request carried none. */
    readonly raw: unknown;
    /** The run the path named. */
    readonly correlationId: string;
    /** Which optional members this operation requires. */
    readonly needs: RunScopeNeeds;
}): RunScopeParse {
    const { raw, correlationId, needs } = input;
    const structured = isBodyObject(raw) && raw !== undefined;
    const record = structured ? raw as Record<string, unknown> : {};
    const issues: MemberIssue[] = [];

    if (raw !== undefined && !structured) {
        issues.push({ field: 'body', remediation: BODY_REMEDIATION });
    }

    const echo = echoIssue(record, correlationId);
    if (echo !== null) {
        issues.push(echo);
    }

    const { attempt } = record;
    if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
        issues.push({ field: 'attempt', remediation: 'send the attempt number this run is on, as a whole number' });
    }

    const leaseId = requiredMember({
        record,
        name: 'leaseId',
        pattern: LEASE_ID_PATTERN,
        remediation: 'send the lease id this run was claimed under',
        required: needs.leaseId === true,
        issues,
    });
    const dispatchToken = requiredMember({
        record,
        name: 'dispatchToken',
        pattern: DISPATCH_TOKEN_PATTERN,
        remediation: 'send the dispatch token this run was authorized with',
        required: needs.dispatchToken === true,
        issues,
    });

    return { correlationId, attempt: attempt as number, leaseId, dispatchToken, fields: record, issues };
}

/** One operation's body, the run its path named, and what that operation needs. */
interface ReadRequest {
    /** Parsed body, or `undefined` when the request carried none. */
    readonly raw: unknown;
    /** The run the path named. */
    readonly correlationId: string;
}

/**
 * Read an operation's body when it required a lease id.
 *
 * @param input - The parsed body, the run, and the operation's requirements.
 * @returns The request with a non-null lease id, or the `422`.
 */
export function readRunScopeRequest(input: ReadRequest & {
    /** Declares the lease id as required. */
    readonly needs: { readonly leaseId: true };
}): LeaseRequest | HttpResponse;

/**
 * Read an operation's body when it required a dispatch token.
 *
 * @param input - The parsed body, the run, and the operation's requirements.
 * @returns The request with a non-null token, or the `422`.
 */
export function readRunScopeRequest(input: ReadRequest & {
    /** Declares the token as required. */
    readonly needs: { readonly dispatchToken: true };
}): TokenRequest | HttpResponse;

/**
 * Read an operation's body when it required neither optional member.
 *
 * @param input - The parsed body, the run, and the operation's requirements.
 * @returns The request, or the `422`.
 */
export function readRunScopeRequest(input: ReadRequest & {
    /** Declares neither member as required. */
    readonly needs: { readonly leaseId?: false; readonly dispatchToken?: false };
}): RunScopeRequest | HttpResponse;

export function readRunScopeRequest(input: ReadRequest & {
    /** Which optional members this operation requires. */
    readonly needs: RunScopeNeeds;
}): RunScopeRequest | HttpResponse {
    const { raw, correlationId, needs } = input;
    const parsed = parseRunScopeRequest({ raw, correlationId, needs });
    if (parsed.issues.length > 0) {
        return validationResponse(parsed.issues);
    }

    const { leaseId, dispatchToken, attempt, fields } = parsed;

    return { correlationId, attempt, leaseId, dispatchToken, fields };
}

/** A body whose correlation echo matched the path, wrapped so it cannot be mistaken for a response. */
export interface RunScopeBody {
    /** The body's members, ready for the operation's own fields. */
    readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Read an operation's body when the contract names the correlation echo but no
 * shared attempt member — §7 (requeue) and §8 (resolve) are written that way,
 * and a field those request bodies do not carry must not become a required one.
 *
 * What *is* common to every call in this directory is FR-051's echo, so it is
 * checked here with exactly the rule {@link readRunScopeRequest} applies: a body
 * that contradicts the path is a validation failure, never a silently-preferred
 * one of the two.
 *
 * @param input - The parsed body and the run the path named.
 * @returns The body's members, or the `422`.
 */
export function readRunScopeBody(input: ReadRequest): RunScopeBody | HttpResponse {
    const { raw, correlationId } = input;
    const structured = isBodyObject(raw) && raw !== undefined;
    const record = structured ? raw as Record<string, unknown> : {};
    const issues: MemberIssue[] = [];

    if (raw !== undefined && !structured) {
        issues.push({ field: 'body', remediation: BODY_REMEDIATION });
    }

    const echo = echoIssue(record, correlationId);
    if (echo !== null) {
        issues.push(echo);
    }

    return issues.length > 0 ? validationResponse(issues) : { fields: record };
}

/**
 * Narrow a parse result to the validation response it may have produced.
 *
 * @param parsed - Whatever {@link readRunScopeRequest} or {@link readRunScopeBody} answered.
 * @returns The response to write, or `null` when the request parsed cleanly.
 */
export function isRefusal(parsed: RunScopeRequest | RunScopeBody | HttpResponse): parsed is HttpResponse {
    return 'status' in parsed;
}

/**
 * Read one free-text member, treating an absent, blank, or over-long one as absent.
 *
 * Bounding here rather than accepting whatever arrived is what keeps an
 * unbounded panel string out of a durable audit row; the operation then answers
 * `422` naming the field rather than storing a truncated cause as though it were
 * the whole one.
 *
 * @param value - The member as received.
 * @param bound - Longest value accepted.
 * @returns The trimmed text, or `null`.
 */
export function textMember(value: unknown, bound: number = MAX_BODY_TEXT_CHARS): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();

    return trimmed.length === 0 || trimmed.length > bound ? null : trimmed;
}

/**
 * Read one boolean member, answering the fallback when it is absent.
 *
 * @param value - The member as received.
 * @param fallback - What an absent or non-boolean member means here.
 * @returns The boolean, or the fallback.
 */
export function flagMember(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

/** Every run-scoped refusal code and the status it answers with. */
const REFUSAL_STATUS = new Map<RunRefusal['code'], number>([
    ['unknown-run', STATUS.notFound],
    ['stale-lease', STATUS.conflict],
    ['already-reserved', STATUS.conflict],
    ['already-dispatched', STATUS.conflict],
    ['invalid-transition', STATUS.conflict],
    ['cause-not-cleared', STATUS.conflict],
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

    if (outcome.status === 'refused') {
        return errorResponse(REFUSAL_STATUS.get(outcome.refusal.code) ?? STATUS.conflict, {
            code: outcome.refusal.code,
            message: outcome.refusal.message,
        });
    }

    if (!outcome.auditWritten) {
        context.log.warn('dispatch operation changed the run but could not record its row', {
            correlationId: outcome.run.correlationId,
            operation,
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
