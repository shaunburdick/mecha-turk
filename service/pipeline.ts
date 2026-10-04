/**
 * The request pipeline: authenticate, confine, match, read, dispatch, write.
 *
 * Order is deliberate and is what the contract's invariants rest on:
 * authentication runs before anything else, so a wrong token gets the same
 * 401 whether the path exists or not (no route oracle); the request target is
 * confined to loopback origin-form before it is parsed into a URL; the route
 * table decides `404`/`405` before any body is read; and the response writer
 * closes the connection whenever the pipeline answered without consuming the
 * body, so refused requests cannot corrupt a keep-alive stream.
 *
 * The pipeline owns no timers and no sockets of its own — the in-flight
 * counter it maintains here is the signal the graceful shutdown drains on.
 */

import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { newCorrelationId } from '../src/ids.ts';
import { redact } from '../src/redaction.ts';
import { isAuthorized } from './auth.ts';
import { readJsonBody } from './body.ts';
import {
    errorBody,
    errorResponse,
    JSON_CONTENT_TYPE,
    parseRequestTarget,
    REQUEST_BODY_MAX_CHARS,
    serializeBody,
    STATUS,
    unauthorizedResponse,
} from './http.ts';
import { describeError } from './log.ts';
import { StorageUnavailableError } from './store/index.ts';
import type { ServiceEnv } from './env.ts';
import type { HttpResponse } from './http.ts';
import type { ServiceLogger } from './log.ts';
import type { Route, RouteContext, RouteRequest } from './routes/types.ts';

/** Header names this pipeline sets explicitly. */
const CONTENT_TYPE_HEADER = 'content-type';

/** Header carrying the serialized body length. */
const CONTENT_LENGTH_HEADER = 'content-length';

/** Header used to close a connection the pipeline refused to reuse. */
const CONNECTION_HEADER = 'connection';

/** Marker introducing a captured segment in a route path. */
const PARAM_PREFIX = ':';

/** Mutable counters shared by the pipeline and the shutdown drain. */
export interface PipelineState {
    /** Requests whose response has not finished yet. */
    inFlight: number;
}

/** Everything a request handler needs; fixed once, at server start. */
export interface PipelineDeps {
    /** Validated host environment (port + bearer token). */
    readonly env: ServiceEnv;
    /** Long-lived route state (store, data dir, logger, schema). */
    readonly context: RouteContext;
    /** Exact method + path table. */
    readonly routes: readonly Route[];
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** In-flight counter this pipeline maintains. */
    readonly state: PipelineState;
}

/** One in-flight HTTP exchange. */
interface ServiceCall {
    readonly request: IncomingMessage;
    readonly response: ServerResponse;
    readonly deps: PipelineDeps;
    /** Whether the body was fully read; `false` forces `Connection: close`. */
    bodyRead: boolean;
    /** Whether a response has already been written. */
    sent: boolean;
}

/** Why a target was refused when no route matched its method and path. */
type RouteRefusal =
    | { readonly kind: 'not-found' }
    | { readonly kind: 'method-not-allowed'; readonly allow: readonly string[] };

/** Match of a request target against the route table. */
type RouteMatch =
    | RouteRefusal
    | {
        readonly kind: 'matched';
        readonly route: Route;
        readonly params: Readonly<Record<string, string>>;
    };

/** A target that matched at least one method on the route table. */
interface MatchedRequest {
    readonly url: URL;
    readonly route: Route;
    readonly params: Readonly<Record<string, string>>;
}

/** Captured parameters of one pattern match; `null` when the path differs. */
type PatternMatch = Readonly<Record<string, string>> | null;

/**
 * Match a pathname against a route path, capturing its `:name` segments.
 *
 * Segments must line up one-for-one: a pattern segment starting with `:` binds
 * the path segment of the same position (and must not be empty), any other
 * pattern segment must be identical. Encoded characters stay as they arrived —
 * the caller validates what it captures rather than decoding it here, so no
 * `%2e%2e` can be reinterpreted after the fact.
 *
 * @param routePath - Route path, exact or `:name`-parameterised.
 * @param pathname - Request pathname.
 * @returns The captured parameters, or `null` when the path does not match.
 */
function matchPathPattern(routePath: string, pathname: string): PatternMatch {
    const pattern = routePath.split('/');
    const segments = pathname.split('/');
    if (pattern.length !== segments.length) {
        return null;
    }

    const params: Record<string, string> = {};
    for (let index = 0; index < pattern.length; index += 1) {
        const expected = pattern[index];
        const actual = segments[index];
        if (expected === undefined || actual === undefined) {
            return null;
        }

        if (expected.startsWith(PARAM_PREFIX)) {
            if (actual === '') {
                return null;
            }

            params[expected.slice(PARAM_PREFIX.length)] = actual;
        } else if (expected !== actual) {
            return null;
        }
    }

    return params;
}

/** Whether a route path declares at least one captured segment. */
function isPatternPath(routePath: string): boolean {
    return routePath.split('/').some((segment) => segment.startsWith(PARAM_PREFIX));
}

/**
 * Write a response exactly once.
 *
 * Serialisation runs against the documented size cap, so an oversized or
 * unserialisable body is replaced by an explicit error rather than shipped
 * truncated. The connection is closed when the pipeline answered without
 * reading the body.
 *
 * @param call - The exchange to answer.
 * @param response - Status, body, and optional extra headers.
 */
function writeResponse(call: ServiceCall, response: HttpResponse): void {
    const outgoing = call.response;
    if (call.sent || outgoing.headersSent) {
        call.deps.log.warn('response already committed');
        return;
    }

    call.sent = true;
    const serialized = serializeBody(response.body);
    const status = serialized.ok ? response.status : STATUS.internal;
    // Contract §2 step ⑦: response construction runs through the same
    // redaction guard as audit writes, so a body that somehow carried a
    // token-shaped substring is neutralised on the way out.
    const body = serialized.ok ? serialized.text : JSON.stringify(serialized.fallback.body);
    const text = redact(body);
    const headers: Record<string, string> = {
        [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
        [CONTENT_LENGTH_HEADER]: String(Buffer.byteLength(text)),
    };
    for (const [name, value] of Object.entries(response.headers ?? {})) {
        headers[name] = value;
    }

    if (!call.bodyRead) {
        headers[CONNECTION_HEADER] = 'close';
    }

    outgoing.writeHead(status, headers);
    outgoing.end(text);
}

/**
 * Translate an unexpected route failure into a response.
 *
 * Storage failures are the documented `503 storage-unavailable` setup
 * prerequisite; anything else becomes a `500 internal` with a correlation id
 * that is logged here and returned to the caller (contract §4).
 *
 * @param error - The thrown value.
 * @param call - The exchange being answered, for logging.
 * @returns The response to write.
 */
function describeFailure(error: unknown, call: ServiceCall): HttpResponse {
    if (error instanceof StorageUnavailableError) {
        return errorResponse(STATUS.storageUnavailable, { code: error.code, message: error.message });
    }

    const correlationId = newCorrelationId();
    call.deps.log.error('route failed', { correlationId, error: describeError(error) });

    return errorResponse(STATUS.internal, {
        code: 'internal',
        message: 'unexpected service failure',
        correlationId,
    });
}

/**
 * Collect the parameterised routes whose pattern captures this pathname.
 *
 * @param routes - Full route table.
 * @param pathname - Request pathname.
 * @returns The pattern routes that match, in declaration order.
 */
function patternRoutes(routes: readonly Route[], pathname: string): readonly Route[] {
    return routes.filter(
        (route) =>
            route.path !== pathname &&
            isPatternPath(route.path) &&
            matchPathPattern(route.path, pathname) !== null,
    );
}

/**
 * Match the current request against the route table.
 *
 * Exact routes are preferred over parameterised ones for the same target, so
 * a literal path like `POST /v1/accounts/verify` can never be swallowed by
 * `POST /v1/accounts/:numericUserId/token`'s pattern sibling. The `Allow`
 * list of a `405` covers every method declared for the target, by either
 * route kind (contract §4).
 *
 * @param call - The exchange to match.
 * @param url - The parsed, loopback-confined target.
 * @returns The matched route and its captures, or why the target was refused.
 */
function matchRoute(call: ServiceCall, url: URL): RouteMatch {
    const method = call.request.method ?? '';
    const { routes } = call.deps;
    const candidates = [
        ...routes.filter((route) => route.path === url.pathname),
        ...patternRoutes(routes, url.pathname),
    ];
    if (candidates.length === 0) {
        return { kind: 'not-found' };
    }

    const route = candidates.find((candidate) => candidate.method === method);
    if (route === undefined) {
        return { kind: 'method-not-allowed', allow: candidates.map((candidate) => candidate.method) };
    }

    return { kind: 'matched', route, params: matchPathPattern(route.path, url.pathname) ?? {} };
}

/**
 * Build the response for a path that exists but was refused.
 *
 * @param match - The non-matching result from {@link matchRoute}.
 * @returns A `404` or `405` response (the latter advertising `Allow`).
 */
function refusalResponse(match: RouteRefusal): HttpResponse {
    if (match.kind === 'not-found') {
        return errorResponse(STATUS.notFound, { code: 'not-found', message: 'no route for this path' });
    }

    return {
        status: STATUS.methodNotAllowed,
        body: errorBody({
            code: 'method-not-allowed',
            message: 'method not allowed for this path',
        }),
        headers: { allow: match.allow.join(', ') },
    };
}

/**
 * Read the request body, answering `413`/`400` when it cannot be used.
 *
 * @param call - The exchange whose body should be read.
 * @returns The parsed value (`undefined` when the request carried no body),
 *   or `null` when a refusal has already been written.
 */
async function readBody(call: ServiceCall): Promise<unknown | null> {
    const result = await readJsonBody(call.request);
    call.bodyRead = result.consumed;
    if (result.status === 'too-large') {
        writeResponse(
            call,
            errorResponse(STATUS.payloadTooLarge, {
                code: 'payload-too-large',
                message: `request body exceeds the ${REQUEST_BODY_MAX_CHARS}-character limit`,
            }),
        );

        return null;
    }

    if (result.status === 'invalid-json') {
        writeResponse(
            call,
            errorResponse(STATUS.badRequest, { code: 'invalid-json', message: 'request body must be valid JSON' }),
        );

        return null;
    }

    return result.status === 'ok' ? result.value : undefined;
}

/**
 * Authenticate, confine, and match the request.
 *
 * @param call - The exchange to prepare.
 * @returns The parsed target and route, or `null` when a refusal (401, 400,
 *   404, or 405) has already been written.
 */
function matchRequest(call: ServiceCall): MatchedRequest | null {
    const { request, deps } = call;
    if (!isAuthorized(request.headers.authorization, deps.env.token)) {
        writeResponse(call, unauthorizedResponse());

        return null;
    }

    const url = parseRequestTarget(request.url);
    if (url === null) {
        writeResponse(
            call,
            errorResponse(STATUS.badRequest, {
                code: 'bad-path',
                message: 'request target must be an absolute path on this service',
            }),
        );

        return null;
    }

    const match = matchRoute(call, url);
    if (match.kind !== 'matched') {
        writeResponse(call, refusalResponse(match));

        return null;
    }

    return { url, route: match.route, params: match.params };
}

/**
 * Run one request from socket arrival to response.
 *
 * @param call - The exchange to serve.
 */
async function runPipeline(call: ServiceCall): Promise<void> {
    const matched = matchRequest(call);
    if (matched === null) {
        return;
    }

    const body = await readBody(call);
    if (body === null) {
        return;
    }

    const request: RouteRequest = {
        method: call.request.method ?? 'GET',
        url: matched.url,
        body,
        params: matched.params,
    };
    let response: HttpResponse;
    try {
        response = await matched.route.handler(call.deps.context, request);
    } catch (error) {
        response = describeFailure(error, call);
    }

    writeResponse(call, response);
}

/**
 * Log the completed request and release its in-flight slot.
 *
 * Both `finish` and `close` are wired with a single-settlement guard: a
 * keep-alive response finishes, an aborted one closes, and either way the
 * counter is decremented exactly once and the access line is written exactly
 * once (only the path is logged — never the query string, which is where a
 * credential would travel if a client ever put one there).
 *
 * @param call - The exchange to observe.
 */
function attachCompletion(call: ServiceCall): void {
    const startedAt = Date.now();
    const url = parseRequestTarget(call.request.url);
    let isSettled = false;
    const complete = (): void => {
        if (isSettled) {
            return;
        }

        isSettled = true;
        call.deps.state.inFlight -= 1;
        call.deps.log.info('request', {
            method: call.request.method ?? 'unknown',
            path: url === null ? '<invalid-target>' : url.pathname,
            status: call.response.statusCode,
            durationMs: Date.now() - startedAt,
        });
    };

    call.response.once('finish', complete);
    call.response.once('close', complete);
}

/**
 * Build the `requestListener` the HTTP server is created with.
 *
 * @param deps - Fixed pipeline dependencies from server start.
 * @returns A listener that serves one exchange per request event.
 */
export function createRequestHandler(deps: PipelineDeps): RequestListener {
    return (request, response) => {
        deps.state.inFlight += 1;
        const call: ServiceCall = { request, response, deps, bodyRead: false, sent: false };
        attachCompletion(call);
        void runPipeline(call).catch((error: unknown) => {
            deps.log.error('request pipeline failed', { error: describeError(error) });
            writeResponse(
                call,
                errorResponse(STATUS.internal, {
                    code: 'internal',
                    message: 'unexpected service failure',
                    correlationId: newCorrelationId(),
                }),
            );
        });
    };
}
