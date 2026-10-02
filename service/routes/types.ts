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
import type { GitHubVerifier } from '../github.ts';
import type { VerifyThrottle } from '../throttle.ts';
import type { PollingView } from '../poll/view.ts';

/** One parsed request handed to a route handler. */
export interface RouteRequest {
    /** HTTP method as it arrived (already matched against the route). */
    readonly method: string;
    /** Parsed, loopback-confined request target. */
    readonly url: URL;
    /** Parsed JSON body, or `undefined` when the request carried none. */
    readonly body: unknown;
    /**
     * Path parameters captured from the route pattern (`:name` segments).
     *
     * Always populated for routes declared with parameters and empty for
     * exact routes; values are the decoded, still-URL-escaped segments, so a
     * route that uses one must validate it (see `isNumericUserId`).
     */
    readonly params: Readonly<Record<string, string>>;
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
    /** GitHub identity verifier used by the credential routes (T-007). */
    readonly github: GitHubVerifier;
    /** Verify throttle shared by the credential routes (SEC-04). */
    readonly throttle: VerifyThrottle;
    /**
     * Read-only view of the live poll scheduler (005 FR-031).
     *
     * The status route reports the loop's own state through it instead of a
     * literal the running process would contradict.
     */
    readonly polling: PollingView;
}

/** A route handler: two parameters, no socket or environment access. */
export type RouteHandler = (
    context: RouteContext,
    request: RouteRequest,
) => Promise<HttpResponse> | HttpResponse;

/** One method + path entry in the route table. */
export interface Route {
    /** HTTP method, e.g. `GET` or `PUT`. */
    readonly method: string;
    /**
     * Path matched against `url.pathname`: either an exact path or a pattern
     * whose `:name` segments capture one path segment each. Literal routes
     * win over parameterised ones regardless of declaration order, and a
     * parameterised route never satisfies an exact path (or vice versa).
     */
    readonly path: string;
    /** Handler invoked for this method and path. */
    readonly handler: RouteHandler;
}
