/**
 * Service read/write side the Repos tab and the relay share (re-cut).
 *
 * One small client for the four HTTP calls the panel makes over the
 * documented `host.serviceRequest()` bridge: bindings GET/PUT and event
 * relay GET/POST. Status classification lives here so the tab and the loop
 * draw problems from one vocabulary (never quoting a payload).
 *
 * MVP-DEBT: a long-poll cursor and lease headers are contract §2.4
 * machinery this simple client replaces for the MVP cut.
 */

import type { GuestRequestResult } from '@openchamber/sdk';
import type { SpikeHost } from './session.ts';

/** The one method the wrappers call, typed as the documented host surface. */
export type ServiceRequester = Pick<SpikeHost, 'serviceRequest'>['serviceRequest'];

/** Path of the bindings collection. */
export const BINDINGS_PATH = '/v1/bindings';

/** Path the panel polls for queued events. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/** Path pattern for one dispatch-result POST. */
const DISPATCH_PATH_PATTERN = '/v1/events/:eventId/dispatched';

/** Lowest HTTP status code a service answer counts as success. */
const STATUS_OK_MIN = 200;

/** HTTP status just past the last success code (`2xx`). */
const STATUS_OK_MAX_EXCLUSIVE = 300;

/** HTTP status the service answers with a `validation` error body. */
const STATUS_VALIDATION = 422;

/** Result of one service round trip through the host bridge. */
export type ServiceResult =
    | { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly problem: string };

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
 * Run one POST through `host.serviceRequest`.
 *
 * @param input - Host surface, path, and body.
 * @returns The wrapper's result.
 */
export async function servicePost(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path. */
    readonly path: string;
    /** Body — sent only when defined. */
    readonly body?: string;
}): Promise<ServiceResult> {
    try {
        const answer = await input.serviceRequest({
            method: 'POST',
            path: input.path,
            ...(input.body === undefined ? {} : { body: input.body }),
        });

        return resultOf(answer);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause) };
    }
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
