/**
 * Service read/write side the Repos tab and the relay share (re-cut).
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

/** Path the panel polls for queued events. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/** Path of the runs history: every event, every state, newest first (M8). */
export const EVENTS_PATH = '/v1/events';

/** Path pattern for one dispatch-result POST. */
const DISPATCH_PATH_PATTERN = '/v1/events/:eventId/dispatched';

/** Path pattern for one run retry POST (M8). */
const RETRY_PATH_PATTERN = '/v1/events/:eventId/retry';

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
    | { readonly ok: false; readonly problem: string; readonly code: string | null };

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
 * Read the error code out of one error envelope, without trusting it.
 *
 * @param body - Response body text (unchecked).
 * @returns The envelope's code, or `null` when absent.
 */
function envelopeCodeOf(body: string): string | null {
    const root = parseJsonObject(body);
    const error = root?.error;
    if (error === null || typeof error !== 'object' || Array.isArray(error)) {
        return null;
    }

    const { code } = error as { readonly code?: unknown };

    return typeof code === 'string' ? code : null;
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
 * the envelope's machine code — extracted from the body, never quoted — so a
 * caller can distinguish a documented refusal from anything else without
 * parsing the body twice.
 *
 * @param answer - The result the host bridged back.
 * @returns The body, or a problem plus the error code when one was sent.
 */
function resultWithErrorOf(answer: GuestRequestResult): ServiceErrorResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    const code = isErrorStatus(answer.status) ? envelopeCodeOf(answer.body) : null;

    return { ok: false, problem: httpProblem(answer.status), code };
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
 * Run one PUT through `host.serviceRequest`.
 *
 * @param input - The host surface, path, and the JSON body text.
 * @returns The wrapper's result.
 */
export async function servicePut(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path to PUT. */
    readonly path: string;
    /** Serialized body. */
    readonly body: string;
}): Promise<ServiceResult> {
    try {
        const answer = await input.serviceRequest({ method: 'PUT', path: input.path, body: input.body });

        return resultOf(answer);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause) };
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
        return { ok: false, problem: describeTransport(cause), code: null };
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
        return { ok: false, problem: describeTransport(cause), code: null };
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
 * Build the dispatch path for one event.
 *
 * @param eventId - The event's id.
 * @returns The path segment to POST to.
 */
export function dispatchedPath(eventId: string): string {
    return DISPATCH_PATH_PATTERN.replace(':eventId', eventId);
}

/**
 * Build the retry path for one run (M8).
 *
 * @param eventId - The event's id.
 * @returns The path segment to POST to.
 */
export function retryPath(eventId: string): string {
    return RETRY_PATH_PATTERN.replace(':eventId', eventId);
}
