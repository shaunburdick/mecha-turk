/**
 * Route-level types for the service's HTTP API.
 *
 * Handlers are plain functions over a fixed {@link RouteContext} and a
 * parsed request; they never touch the socket, the environment, or host APIs.
 * Keeping the surface this small is what lets the contract tests drive the
 * whole API through the real loopback server instead of a mocking layer.
 */

import type { HttpResponse } from '../http.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';

/** One parsed request handed to a route handler. */
export interface RouteRequest {
    /** HTTP method as it arrived (already matched against the route). */
    readonly method: string;
    /** Parsed, loopback-confined request target. */
    readonly url: URL;
    /** Parsed JSON body, or `undefined` when the request carried none. */
    readonly body: unknown;
}

/** Long-lived state every route handler receives. */
export interface RouteContext {
    /** Open store, or `null` when the data directory is unusable (503). */
    readonly store: ServiceStore | null;
    /** Resolved data directory, reported for backup and diagnostics. */
    readonly dataDir: string;
    /** `Date.now()` at server start, for uptime reporting. */
    readonly startedAt: number;
    /** Structured logger; routes never write to stdout themselves. */
    readonly log: ServiceLogger;
    /** Schema version this build declares (contract §1 versioning). */
    readonly schemaVersion: number;
}

/** A route handler: two parameters, no socket or environment access. */
export type RouteHandler = (
    context: RouteContext,
    request: RouteRequest,
) => Promise<HttpResponse> | HttpResponse;

/** One exact method + path entry in the route table. */
export interface Route {
    /** HTTP method, e.g. `GET` or `PUT`. */
    readonly method: string;
    /** Exact path matched against `url.pathname`. */
    readonly path: string;
    /** Handler invoked for this method and path. */
    readonly handler: RouteHandler;
}
