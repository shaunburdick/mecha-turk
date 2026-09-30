/**
 * Service read/write side the Bindings tab and the relay share (re-cut).
 *
 * One small client for the HTTP calls the panel makes over the documented
 * `host.serviceRequest()` bridge: bindings GET/PUT, event relay GET/POST,
 * and the runs history GET/POST. Status classification lives here so the tab
 * and the loop draw problems from one vocabulary (never quoting a payload).
 *
 * MVP-DEBT: a long-poll cursor and lease headers are contract §2.4
 * machinery this simple client replaces for the MVP cut.
 */

import type { GuestRequestResult } from '@openchamber/sdk';
import type { SpikeHost } from './session.ts';
import { parseJsonObject } from './json.ts';

/** The one method the wrappers call, typed as the documented host surface. */
export type ServiceRequester = Pick<SpikeHost, 'serviceRequest'>['serviceRequest'];

/** Path of the bindings collection. */
export const BINDINGS_PATH = '/v1/bindings';

/** Path of the credential-free account collection (service contract §2.2). */
export const ACCOUNTS_PATH = '/v1/accounts';

/** Path the panel polls for claimed runs. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/**
 * Path of the service configuration document (002 FR-029's baseline source).
 *
 * The panel reads it per verification to pick up `expectedAgent`; a build
 * whose document does not carry the field falls back to the documented
 * default with `provenance: 'defaulted'` rather than blocking the run.
 */
export const CONFIG_PATH = '/v1/config';

/** Path of the runs history: every run, every state, newest first (M8). */
export const EVENTS_PATH = '/v1/events';

/** Path of the correlation-filtered audit read (003 contract, run-history §2). */
export const AUDIT_PATH = '/v1/audit';

/**
 * Path pattern every run-scoped operation shares (003 wire delta).
 *
 * The `:correlationId` segment is the **run's** correlation id (`mt-run-…`),
 * never a delivery id: a post-003 delivery carries no lifecycle field of its
 * own, so a delivery-addressed mutation answers `404 unknown-run`. Each helper
 * below exists so no call site can reintroduce that shape by hand.
 */
const RUN_SCOPE_PATTERN = '/v1/events/:correlationId';

/** Path pattern for one account resource (the delete route). */
const ACCOUNT_DELETE_PATTERN = '/v1/accounts/:numericUserId';

/** Lowest HTTP status code a service answer counts as success. */
const STATUS_OK_MIN = 200;

/** HTTP status just past the last success code (`2xx`). */
const STATUS_OK_MAX_EXCLUSIVE = 300;

/** HTTP status the service answers with a `validation` error body. */
const STATUS_VALIDATION = 422;

/** Lowest HTTP status that carries the documented error envelope (§1). */
const STATUS_ERROR_MIN = 400;

/** Result of one service round trip through the host bridge. */
export type ServiceResult =
    | { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly problem: string };

/** Result of one call where the service's error code matters to the caller. */
export type ServiceErrorResult =
    | { readonly ok: true; readonly body: string }
    | {
        readonly ok: false;
        readonly problem: string;
        readonly code: string | null;
        /** The envelope's own refusal copy, verbatim; `null` when it sent none. */
        readonly message: string | null;
    };

/**
 * Decide whether one HTTP status lands in the 2xx band.
 *
 * @param status - Status to check.
 * @returns `true` inside the band.
 */
function isOkStatus(status: number): boolean {
    return status >= STATUS_OK_MIN && status < STATUS_OK_MAX_EXCLUSIVE;
}

/**
 * Decide whether one HTTP status carries the documented error envelope.
 *
 * Every status from 400 up answers with `{ error: { code, ... } }`
 * (contract §1), so the extraction only needs the band boundary.
 *
 * @param status - Status to check.
 * @returns `true` inside the error band.
 */
function isErrorStatus(status: number): boolean {
    return status >= STATUS_ERROR_MIN;
}

/**
 * Describe one non-2xx service answer from the status alone.
 *
 * @param status - HTTP status the service answered with.
 * @returns A short, secret-free problem string.
 */
function httpProblem(status: number): string {
    if (status === STATUS_VALIDATION) {
        return 'service refused the bindings list';
    }

    return `service answered ${status}`;
}

/**
 * Read one string member out of an error envelope, without trusting it.
 *
 * The envelope is never quoted back into a request — it is read so a refusal
 * can *name its cause*: `code` is what the panel branches on, `message` is the
 * service's own copy, which the contract says 005 (and this panel's notes)
 * render verbatim.
 *
 * @param body - Response body text (unchecked).
 * @param field - Envelope member to read.
 * @returns The member, or `null` when absent or not a string.
 */
function envelopeFieldOf(body: string, field: string): string | null {
    const root = parseJsonObject(body);
    const error = root?.error;
    if (error === null || typeof error !== 'object' || Array.isArray(error)) {
        return null;
    }

    const value = (error as Record<string, unknown>)[field];

    return typeof value === 'string' ? value : null;
}

/**
 * Turn one service answer into the wrapper's result.
 *
 * @param answer - The result the host bridged back.
 * @returns The body, or a status-named problem.
 */
function resultOf(answer: GuestRequestResult): ServiceResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    return { ok: false, problem: httpProblem(answer.status) };
}

/**
 * Turn one service answer into the error-aware wrapper's result.
 *
 * Same as {@link resultOf}, except a refusal in the error bands also carries
 * the envelope's machine code **and its own message** — both extracted from
 * the body, never quoted into anything but a note — so a caller can
 * distinguish a documented refusal from anything else without parsing the body
 * twice, and can still tell the operator what the service said.
 *
 * @param answer - The result the host bridged back.
 * @returns The body, or a problem plus the error code and copy when one was sent.
 */
function resultWithErrorOf(answer: GuestRequestResult): ServiceErrorResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    const inEnvelope = isErrorStatus(answer.status);

    return {
        ok: false,
        problem: httpProblem(answer.status),
        code: inEnvelope ? envelopeFieldOf(answer.body, 'code') : null,
        message: inEnvelope ? envelopeFieldOf(answer.body, 'message') : null,
    };
}

/**
 * Describe one transport failure without quoting host payloads.
 *
 * @param cause - Caught value.
 * @returns A short, secret-free problem string.
 */
function describeTransport(cause: unknown): string {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;

    return typeof code === 'string' ? `service unreachable: ${code}` : 'service unreachable';
}

/**
 * Run one GET through `host.serviceRequest`.
 *
 * @param input - The host surface and the path to fetch.
 * @returns The wrapper's result.
 */
export async function serviceGet(input: {
    /** Host `serviceRequest` surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path to GET. */
    readonly path: string;
}): Promise<ServiceResult> {
    try {
        const answer = await input.serviceRequest({ method: 'GET', path: input.path });

        return resultOf(answer);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause) };
    }
}

/**
 * Run one PUT through `host.serviceRequest`, reading the error code.
 *
 * The error-aware shape (same as {@link servicePost}) costs nothing for a
 * caller that only checks `ok`, and it lets the bindings grant put the
 * service's own field-level remediation next to the field it belongs to
 * (005 FR-052) instead of behind a generic "the service refused".
 *
 * @param input - The host surface, path, and the JSON body text.
 * @returns The wrapper's result, carrying the envelope when it sent one.
 */
export async function servicePut(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path to PUT. */
    readonly path: string;
    /** Serialized body. */
    readonly body: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({ method: 'PUT', path: input.path, body: input.body });

        return resultWithErrorOf(answer);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, message: null };
    }
}

/**
 * Run one POST through `host.serviceRequest`, reading the error code.
 *
 * The error-aware shape (same as {@link serviceDelete}) costs nothing for
 * callers that only check `ok`, and it lets the runs list explain a refused
 * retry from the service's own envelope code — `invalid-transition` means the
 * run was already dispatched, which is a fact about the run, not about the
 * panel's connection.
 *
 * @param input - Host surface, path, and body.
 * @returns The wrapper's error-aware result.
 */
export async function servicePost(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path. */
    readonly path: string;
    /** Body — sent only when defined. */
    readonly body?: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({
            method: 'POST',
            path: input.path,
            ...(input.body === undefined ? {} : { body: input.body }),
        });

        return resultWithErrorOf(answer);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, message: null };
    }
}

/**
 * Run one DELETE through `host.serviceRequest`, reading the error code.
 *
 * The account delete route refuses with a *documented* envelope (409
 * invalid-transition while bindings still reference the account), and the
 * removal affordance needs that code to tell the operator to remove the
 * binding first — so this wrapper surfaces the code next to the problem.
 *
 * @param input - Host surface and the path to delete.
 * @returns The wrapper's error-aware result.
 */
export async function serviceDelete(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path to delete. */
    readonly path: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({ method: 'DELETE', path: input.path });

        return resultWithErrorOf(answer);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, message: null };
    }
}

/**
 * Build the delete path for one account.
 *
 * @param numericUserId - GitHub numeric user id of the account to delete.
 * @returns The path segment to DELETE.
 */
export function accountDeletePath(numericUserId: string): string {
    return ACCOUNT_DELETE_PATTERN.replace(':numericUserId', numericUserId);
}

/**
 * Build the path of one run-scoped operation.
 *
 * @param correlationId - The run's correlation id (`mt-run-…`, one segment).
 * @param verb - The operation's suffix under `/v1/events/:correlationId/`.
 * @returns The path segment to POST to.
 */
function runOperationPath(correlationId: string, verb: string): string {
    return `${RUN_SCOPE_PATTERN.replace(':correlationId', correlationId)}/${verb}`;
}

/**
 * Build the reserve path: declare intent and receive the single-use token.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function reservePath(correlationId: string): string {
    return runOperationPath(correlationId, 'reserve');
}

/**
 * Build the result path: report what `host.startSession()` produced.
 *
 * @param correlationId - The run's correlation id (never a delivery id).
 * @returns The path segment to POST to.
 */
export function dispatchedPath(correlationId: string): string {
    return runOperationPath(correlationId, 'dispatched');
}

/**
 * Build the abandon path: a reserved attempt that made no host call at all.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function abandonPath(correlationId: string): string {
    return runOperationPath(correlationId, 'abandon');
}

/**
 * Build the block-report path: a fail-closed guard refused before any host call.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function blockedPath(correlationId: string): string {
    return runOperationPath(correlationId, 'blocked');
}

/**
 * Build the retry path (M8).
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function retryPath(correlationId: string): string {
    return runOperationPath(correlationId, 'retry');
}

/**
 * Build the requeue path: return a dead-lettered run to waiting (FR-033).
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function requeuePath(correlationId: string): string {
    return runOperationPath(correlationId, 'requeue');
}

/**
 * Build the resolve path: one of FR-027's two explicit `unconfirmed` decisions.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function resolvePath(correlationId: string): string {
    return runOperationPath(correlationId, 'resolve');
}

/**
 * Build the verification path: the post-dispatch agent read-back (FR-043).
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function verificationPath(correlationId: string): string {
    return runOperationPath(correlationId, 'verification');
}

/**
 * Build the correlation-filtered audit-read path (FR-053).
 *
 * @param correlationId - The run whose rows to read.
 * @returns `GET` path carrying the filter as a query parameter.
 */
export function auditPath(correlationId: string): string {
    return `${AUDIT_PATH}?correlationId=${encodeURIComponent(correlationId)}`;
}
