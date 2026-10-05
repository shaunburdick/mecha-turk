/**
 * GitHub doubles for the service suites (tasks T-007–T-008).
 *
 * The credential routes are exercised end-to-end: the real
 * {@link createGitHubVerifier} runs over the fake `fetch` below, so the
 * classification rules (401/403/429/SSO, scope matrix, transport failure) are
 * tested exactly as production runs them — only the socket is fake. Every
 * call is recorded with the `Authorization` header it presented, which is what
 * lets the suites assert a *registered-token* scan: the tokens a test handed
 * the service must appear in no response, no log line, and no audit row.
 *
 * {@link offlineVerifier} is the harness default for tests that never meant to
 * touch GitHub at all: it answers `unavailable: offline` without opening a
 * socket, so an accidental call fails the test instead of the network.
 */

import { createGitHubVerifier } from '../../service/github.ts';
import type { FetchLike, GitHubVerifier, VerifyOutcome } from '../../service/github.ts';
import type { GitHubIssuePoller } from '../../service/poll/poller-github.ts';

/** One scripted answer for one GitHub endpoint. */
export interface EndpointResponse {
    /** HTTP status; defaults to `200`. */
    readonly status?: number;
    /** Response body text; defaults to an empty body. */
    readonly body?: string;
    /** Response headers, e.g. `x-oauth-scopes` or `x-github-sso`. */
    readonly headers?: Readonly<Record<string, string>>;
    /** When set, the call rejects with this message (a transport failure). */
    readonly failWith?: string;
    /**
     * When set, the call rejects with an `Error` carrying this `name`.
     *
     * Used to reproduce `AbortSignal.timeout`'s `TimeoutError` rejection
     * without waiting out the real 15-second budget (review W2-7).
     */
    readonly failWithName?: string;
}

/** Script for the endpoints a handoff calls. */
export interface GitHubScript {
    /** Answer for `GET /user`. */
    readonly user: EndpointResponse;
    /** Answer for `GET /rate_limit`; defaults to a healthy baseline. */
    readonly rateLimit?: EndpointResponse;
}

/** One recorded upstream call. */
export interface RecordedCall {
    /** Request path, e.g. `/user`. */
    readonly path: string;
    /** The `Authorization` header exactly as presented. */
    readonly authorization: string;
}

/** A fake `fetch` plus the real verifier built on top of it. */
export interface FakeGitHub {
    /** The production verifier, bound to this fake's `fetch`. */
    readonly verifier: GitHubVerifier;
    /** The fake `fetch`, for tests that build their own client. */
    readonly fetch: FetchLike;
    /** Every call observed, in order. */
    readonly calls: readonly RecordedCall[];
    /** Credential strings presented by the client, for secret scans. */
    presentedTokens(): readonly string[];
    /** Swap the script, so one test can change GitHub's answer mid-run. */
    setScript(script: GitHubScript): void;
}

/** A verifier plus the tokens it was asked to check. */
export interface ScriptedVerifier {
    /** The verifier handed to the service. */
    readonly verifier: GitHubVerifier;
    /** Credentials presented, in order. */
    readonly tokens: readonly string[];
}

/** Healthy `GET /rate_limit` baseline body (epoch-second reset stamp). */
const DEFAULT_RATE_LIMIT_BODY = '{"resources":{"core":{"limit":5000,"remaining":4999,"reset":1893456000}}}';

/** Header name carrying the credential on every upstream request. */
const AUTHORIZATION_HEADER = 'authorization';

/** Prefix the GitHub client puts in front of the credential. */
const BEARER_PREFIX = 'Bearer ';

/**
 * Read one header from a `fetch` init, case-insensitively.
 *
 * @param headers - Headers as the client passed them.
 * @param name - Header name to find.
 * @returns The value, or `''` when the header is absent.
 */
function headerValue(headers: RequestInit['headers'], name: string): string {
    if (headers === undefined) {
        return '';
    }

    if (headers instanceof Headers) {
        return headers.get(name) ?? '';
    }

    if (Array.isArray(headers)) {
        return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? '';
    }

    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);

    return match?.[1] ?? '';
}

/**
 * Build a GitHub `GET /user` body.
 *
 * @param identity - Numeric id and login the token should belong to.
 * @returns The serialized response body.
 */
export function userBody(identity: { readonly id: number; readonly login: string }): string {
    return JSON.stringify({ id: identity.id, login: identity.login, name: 'Fixture User' });
}

/**
 * An error the scripted endpoint throws under a chosen `name`.
 *
 * A subclass rather than a `name` written onto an `Error`, because the name is
 * the whole point of the fixture: production branches on `error.name`, so the
 * test has to be able to pick it.
 */
class ScriptedFailureError extends Error {
    public constructor(message: string, name: string) {
        super(message);
        this.name = name;
    }
}

/**
 * Build a fake GitHub whose `fetch` answers from a script.
 *
 * @param script - Answers for `/user` and `/rate_limit`.
 * @returns The fake, with a production verifier attached.
 */
export function fakeGitHub(script: GitHubScript): FakeGitHub {
    const calls: RecordedCall[] = [];
    let current = script;
    const fetch: FetchLike = async (url, init) => {
        const path = new URL(url).pathname;
        const authorization = headerValue(init.headers, AUTHORIZATION_HEADER);
        calls.push({ path, authorization });
        const isRateLimit = path.endsWith('/rate_limit');
        const endpoint: EndpointResponse = isRateLimit
            ? (current.rateLimit ?? { status: 200, body: DEFAULT_RATE_LIMIT_BODY })
            : current.user;
        if (endpoint.failWith !== undefined) {
            throw new Error(endpoint.failWith);
        }

        if (endpoint.failWithName !== undefined) {
            throw new ScriptedFailureError('upstream call did not complete', endpoint.failWithName);
        }

        return new Response(endpoint.body ?? '', {
            status: endpoint.status ?? 200,
            headers: endpoint.headers ?? {},
        });
    };

    return {
        verifier: createGitHubVerifier(fetch),
        fetch,
        calls,
        presentedTokens: () => calls.map((call) => call.authorization.slice(BEARER_PREFIX.length)),
        setScript: (next: GitHubScript): void => {
            current = next;
        },
    };
}

/**
 * Build a verifier that answers from a handler instead of the network.
 *
 * Used where the *route* is under test rather than the client: a handler that
 * never settles proves the `429 verify-busy` slot, and one that throws proves
 * the sanitized `500` path (SEC-11).
 *
 * @param handler - Receives the credential and answers with an outcome.
 * @returns The verifier plus the credentials it saw.
 */
export function scriptedVerifier(
    handler: (token: string) => VerifyOutcome | Promise<VerifyOutcome>,
): ScriptedVerifier {
    const tokens: string[] = [];

    return {
        verifier: {
            verify: async (token: string): Promise<VerifyOutcome> => {
                tokens.push(token);

                return await handler(token);
            },
        },
        tokens,
    };
}

/**
 * Build the harness-default verifier: answers, but never opens a socket.
 *
 * @returns A verifier reporting `unavailable: offline` for any credential.
 */
export function offlineVerifier(): GitHubVerifier {
    return { verify: async (): Promise<VerifyOutcome> => ({ kind: 'unavailable', detail: 'offline' }) };
}

/**
 * The harness-default **poller**: every feed answers empty, and no socket opens.
 *
 * Lives here beside {@link offlineVerifier} because it answers the same
 * question from the other direction — a fixture that seeds an active binding
 * makes `startService` arm its first scan fire-and-forget, and a real poller
 * would send that cycle to `api.github.com` and write `scan-state.json` on a
 * schedule no shutdown drains. Empty answers keep the cycle on the test's own
 * clock, and an accidental per-item actor read (002 FR-049) reaches the same
 * empty answer rather than the network.
 *
 * @returns A poller whose every call answers an empty, immediate list.
 */
export function offlinePoller(): GitHubIssuePoller {
    return {
        listOpenIssues: async () => ({ kind: 'ok', issues: [] }),
        listIssueComments: async () => ({ kind: 'ok', comments: [] }),
        listOpenPulls: async () => ({ kind: 'ok', pulls: [] }),
        listIssueEvents: async () => ({ kind: 'ok', events: [], exhausted: false }),
    };
}
