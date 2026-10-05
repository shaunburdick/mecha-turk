/**
 * Outbound GitHub client — identity verification (task T-007).
 *
 * The service, never the panel, talks to `api.github.com` with its own
 * `fetch` (FR-006): `GET /user` establishes the numeric id that keys an
 * account (FR-009) and the login shown for it, `GET /rate_limit` is a free
 * budget baseline (token-handoff §2 step ⑤). Both calls share one 15-second
 * `AbortSignal.timeout`, so a hung upstream cannot hold a verify slot open
 * (the throttle in `throttle.ts` counts on it being bounded).
 *
 * **Nothing upstream ever reaches a log line or an error body.** Responses are
 * read as text and parsed non-throwingly; failures are classified into the
 * contract's reason classes here, at the boundary, and only the *class* leaves
 * this module — raw GitHub bodies can echo request metadata (contract §4 rule
 * 3) and upstream error messages can quote anything (SEC-11).
 *
 * Scope matrix (FR-010): GitHub reports granted classic scopes in the
 * `x-oauth-scopes` response header. When it is present and non-empty each
 * capability is decided against the classic scope set; when it is empty
 * (fine-grained PATs, GitHub App tokens) every capability reports `unknown`
 * rather than guessing — `missing` is only ever claimed with evidence, and
 * `unknown` is resolved by the first real poll that meets a 403 (contract §2
 * step ⑥: `ok/missing/unknown` per capability, never a silent downgrade).
 */

import { nowIso } from '../src/ids.ts';
import { isRecord, parseJsonText } from './json.ts';

/** Base URL of the GitHub REST API; the only outbound origin the service uses. */
export const API_ORIGIN = 'https://api.github.com';

/** Path of the identity endpoint that keys every account. */
const USER_PATH = '/user';

/** Path of the free rate-limit probe used for budget baselining. */
const RATE_LIMIT_PATH = '/rate_limit';

/** Timeout applied to every upstream call (contract §2 step ⑤). */
export const GITHUB_TIMEOUT_MS = 15_000;

/** API version header GitHub uses to pin response shapes (contract §2 step ⑤). */
const API_VERSION = '2022-11-28';

/** Header naming this extension to GitHub, as their API requires. */
const USER_AGENT = 'mecha-turk-extension';

/** Fallback wait after a rate-limit refusal that carries no `retry-after`. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Error name `AbortSignal.timeout` gives its rejection.
 *
 * Node raises a `DOMException` named `TimeoutError` when the shared 15-second
 * budget fires; a refused connection raises a `TypeError` instead, which is
 * the distinction the classification below depends on (review W2-7).
 */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

/** Capabilities of the FR-010 scope matrix, in reporting order. */
export type ScopeCapability = 'metadata' | 'issues' | 'pull-requests' | 'contents';

/** Result recorded for one capability. */
export type ScopeResult = 'ok' | 'missing' | 'unknown';

/** Scope results plus when they were taken. */
export interface ScopeCheck {
    /** RFC 3339 timestamp of the check. */
    readonly checkedAt: string;
    /** One result per FR-010 capability. */
    readonly results: Readonly<Record<ScopeCapability, ScopeResult>>;
}

/** Credential family, recorded with the credential itself (data-model Account). */
export type CredentialKind = 'fine-grained' | 'classic' | 'unknown';

/** Identity recovered from `GET /user`. */
export interface GitHubIdentity {
    /** Numeric GitHub user id — the durable account key. */
    readonly numericUserId: string;
    /** Display login; renames update this field only. */
    readonly login: string;
}

/** Reason classes a credential rejection can carry (contract §4, SEC-03). */
export type RejectReason = 'auth-failed' | 'sso-required' | `scope-missing:${ScopeCapability}`;

/** Why an upstream call could not produce an identity (contract §4 `502`). */
export type UnavailableDetail = 'offline' | 'timeout' | 'upstream';

/** Result of verifying one presented credential against GitHub. */
export type VerifyOutcome =
    | {
        readonly kind: 'ok';
        readonly identity: GitHubIdentity;
        readonly scopeCheck: ScopeCheck;
        readonly credentialKind: CredentialKind;
        readonly rateBaseline: RateBaseline | null;
    }
    | { readonly kind: 'rejected'; readonly reason: RejectReason }
    | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
    | { readonly kind: 'unavailable'; readonly detail: UnavailableDetail };

/** Budget baseline read from `GET /rate_limit` (best effort). */
export interface RateBaseline {
    /** Hourly budget reported by GitHub. */
    readonly limit: number;
    /** Requests remaining in the current window. */
    readonly remaining: number;
    /** RFC 3339 reset time of the current window. */
    readonly resetAt: string;
}

/** The client surface routes and startup reconciliation depend on. */
export interface GitHubVerifier {
    /**
     * Verify one credential and recover its identity.
     *
     * @param token - Credential to present; never logged or echoed.
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    verify(token: string): Promise<VerifyOutcome>;
}

/** The four FR-010 capabilities, in the order the matrix reports them. */
const SCOPE_CAPABILITIES: readonly ScopeCapability[] = ['metadata', 'issues', 'pull-requests', 'contents'];

/** Classic scopes that satisfy any FR-010 capability (all are read-only). */
const CLASSIC_READ_SCOPES: readonly string[] = ['repo', 'public_repo'];

/** Milliseconds in one second, for GitHub's epoch-second rate-limit stamps. */
const MS_PER_SECOND = 1_000;

/** HTTP statuses GitHub uses to answer a credential presentation. */
const STATUS_UNAUTHORIZED = 401;

/** HTTP status for a refusal that is neither an identity nor an SSO problem. */
const STATUS_FORBIDDEN = 403;

/** HTTP status `/user` answers when the credential identifies nobody. */
const STATUS_NOT_FOUND = 404;

/** HTTP status for GitHub's own primary and secondary rate limits. */
const STATUS_TOO_MANY_REQUESTS = 429;

/** Rate-limit response header GitHub sets alongside 403/429 refusals. */
const RATE_REMAINING_HEADER = 'x-ratelimit-remaining';

/** Secondary-limit response header; its presence means "wait, do not retry". */
const RETRY_AFTER_HEADER = 'retry-after';

/** Response header GitHub sets when an organization requires SSO for the token. */
const SSO_HEADER = 'x-github-sso';

/** Response header listing the scopes a classic token holds. */
const OAUTH_SCOPES_HEADER = 'x-oauth-scopes';

/**
 * Classify a credential's family from its own prefix.
 *
 * The prefix is the only thing read here: the value itself never leaves this
 * call, and the result (`classic`/`fine-grained`) is stored with the
 * credential where it belongs.
 *
 * @param token - Presented credential.
 * @returns The credential family, or `'unknown'` for an unrecognised shape.
 */
export function credentialKindOf(token: string): CredentialKind {
    if (token.startsWith('github_pat_')) {
        return 'fine-grained';
    }

    return /^gh[pousr]_/.test(token) ? 'classic' : 'unknown';
}

/**
 * Build the request headers for one upstream call.
 *
 * @param token - Credential to authenticate with.
 * @returns The documented header set, including the pinned API version.
 */
export function requestHeaders(token: string): Record<string, string> {
    // Pairs rather than an object literal: HTTP header names are not
    // camelCase identifiers, and the contract fixes their exact spelling.
    const entries: readonly (readonly [string, string])[] = [
        ['authorization', `Bearer ${token}`],
        ['accept', 'application/vnd.github+json'],
        ['x-github-api-version', API_VERSION],
        ['user-agent', USER_AGENT],
    ];

    return Object.fromEntries(entries);
}

/**
 * Read `GET /user` into an identity, failing closed on a malformed payload.
 *
 * @returns The identity, or `null` when `id`/`login` are not usable — a
 *   response the normaliser cannot trust never keys an account.
 */
function readIdentity(text: string): GitHubIdentity | null {
    const parsed = parseJsonText(text);
    if (!parsed.ok || !isRecord(parsed.value)) {
        return null;
    }

    const { id, login } = parsed.value;
    if (login === '' || typeof login !== 'string' || typeof id !== 'number' || !Number.isSafeInteger(id)) {
        return null;
    }

    return { numericUserId: String(id), login };
}

/**
 * Decide one capability from the granted classic scopes.
 *
 * @param granted - Scopes GitHub reported; empty means GitHub reported none.
 * @returns `unknown` without evidence, otherwise `ok`/`missing` against the
 *   classic scope set — `missing` is only ever claimed with evidence.
 */
function scopeVerdict(granted: readonly string[]): ScopeResult {
    if (granted.length === 0) {
        return 'unknown';
    }

    return CLASSIC_READ_SCOPES.some((scope) => granted.includes(scope)) ? 'ok' : 'missing';
}

/**
 * Build the FR-010 scope matrix from the granted classic scopes.
 *
 * @param granted - Scopes GitHub reported for this token.
 * @returns One result per capability, keyed as the data model declares.
 */
function scopeResults(granted: readonly string[]): Record<ScopeCapability, ScopeResult> {
    const verdict = scopeVerdict(granted);
    const entries = SCOPE_CAPABILITIES.map((capability) => [capability, verdict] as const);

    return Object.fromEntries(entries) as Record<ScopeCapability, ScopeResult>;
}

/**
 * Build the FR-010 scope matrix from a response's `x-oauth-scopes` header.
 *
 * @param header - Raw header value, or `null` when GitHub sent none.
 * @returns The matrix with `checkedAt` stamped now.
 */
function buildScopeCheck(header: string | null): ScopeCheck {
    const granted = (header ?? '')
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope !== '');

    return { checkedAt: nowIso(), results: scopeResults(granted) };
}

/**
 * Parse `retry-after` (seconds) out of a refusal, falling back to a default.
 *
 * @param response - Upstream response that refused the call.
 * @returns Seconds to wait before the next attempt.
 */
export function retryAfterOf(response: Response): number {
    const header = response.headers.get(RETRY_AFTER_HEADER);
    if (header === null || !/^\d+$/.test(header)) {
        return DEFAULT_RETRY_AFTER_SECONDS;
    }

    return Number(header);
}

/**
 * Read `GET /rate_limit` as a budget baseline; failures are not fatal.
 *
 * @param response - Response of the free rate-limit probe.
 * @returns The baseline, or `null` when the payload was not usable.
 */
async function readRateBaseline(response: Response): Promise<RateBaseline | null> {
    const parsed = parseJsonText(await response.text());
    if (!parsed.ok || !isRecord(parsed.value) || !isRecord(parsed.value.core)) {
        return null;
    }

    const { limit, remaining, reset } = parsed.value.core;
    if (
        typeof limit !== 'number' ||
        typeof remaining !== 'number' ||
        typeof reset !== 'number' ||
        !Number.isFinite(reset)
    ) {
        return null;
    }

    const resetDate = new Date(reset * MS_PER_SECOND);
    if (Number.isNaN(resetDate.getTime())) {
        return null;
    }

    return { limit, remaining, resetAt: resetDate.toISOString() };
}

/**
 * Recognise a rate-limit refusal (primary `429` or secondary limits on `403`).
 *
 * @param response - Upstream response that was not 200.
 * @returns `true` when GitHub is asking us to slow down rather than rejecting
 *   the credential — a distinction FR-024 requires us to get right.
 */
export function isRateLimited(response: Response): boolean {
    return (
        response.status === STATUS_TOO_MANY_REQUESTS ||
        response.headers.get(RATE_REMAINING_HEADER) === '0' ||
        response.headers.has(RETRY_AFTER_HEADER)
    );
}

/**
 * Recognise the "your organization requires SSO" refusal (contract §4).
 *
 * @param response - Upstream response that was not 200.
 * @returns `true` only for a `403` carrying GitHub's required-SSO header.
 */
function isSsoRefusal(response: Response): boolean {
    const sso = response.headers.get(SSO_HEADER);

    return response.status === STATUS_FORBIDDEN && sso?.includes('required') === true;
}

/**
 * Name the first capability the granted scopes are missing.
 *
 * @param scopeCheck - Matrix derived from the response headers.
 * @returns A `scope-missing:<capability>` reason class.
 */
function missingScopeReason(scopeCheck: ScopeCheck): RejectReason {
    const missing = SCOPE_CAPABILITIES.find((capability) => scopeCheck.results[capability] === 'missing');

    return `scope-missing:${missing ?? 'metadata'}`;
}

/**
 * Classify a non-200 `GET /user` response.
 *
 * Order matters: a rate-limited 403/429 must not be mistaken for a scope
 * problem (FR-024 blocks with the *exact* cause), and an SSO refusal must not
 * be mistaken for a missing scope (contract §4 reason classes).
 *
 * @param response - Upstream response that was not 200.
 * @param scopeCheck - Matrix already derived from the response headers.
 * @returns The classified outcome.
 */
function classifyRejection(response: Response, scopeCheck: ScopeCheck): VerifyOutcome {
    const { status } = response;
    if (isRateLimited(response)) {
        return { kind: 'rate-limited', retryAfterSeconds: retryAfterOf(response) };
    }

    if (status === STATUS_UNAUTHORIZED || status === STATUS_NOT_FOUND) {
        return { kind: 'rejected', reason: 'auth-failed' };
    }

    if (isSsoRefusal(response)) {
        return { kind: 'rejected', reason: 'sso-required' };
    }

    if (status === STATUS_FORBIDDEN) {
        return { kind: 'rejected', reason: missingScopeReason(scopeCheck) };
    }

    return { kind: 'unavailable', detail: 'upstream' };
}

/** The `fetch` shape this client needs; tests inject a fake of the same shape. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Call `GET /rate_limit` without ever letting a probe failure fail a verify.
 *
 * @param fetchImpl - Client used for the probe.
 * @param token - Credential already proven valid by `GET /user`.
 * @returns The baseline, or `null` on any transport or shape failure.
 */
async function readRateBaselineQuietly(fetchImpl: FetchLike, token: string): Promise<RateBaseline | null> {
    try {
        const response = await fetchImpl(`${API_ORIGIN}${RATE_LIMIT_PATH}`, {
            method: 'GET',
            headers: requestHeaders(token),
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });

        return response.ok ? await readRateBaseline(response) : null;
    } catch {
        return null;
    }
}

/**
 * Classify why an upstream call never produced a response.
 *
 * Only the rejection's *kind* is read: the caught value can quote the URL, the
 * cause chain, or the request options, and none of that may reach a log line
 * or an error body (SEC-11 — no upstream text in logs). The two classes the
 * panel shows different copy for are the 15-second abort (`timeout`: "GitHub
 * did not answer in time") and everything else (`offline`: "check the
 * network"), so a hung upstream never masquerades as a connectivity problem.
 *
 * @param error - The rejection from the aborted or failed `fetch`.
 * @returns `timeout` for the shared abort, `offline` for transport failures.
 */
export function transportDetail(error: unknown): UnavailableDetail {
    return error instanceof Error && error.name === TIMEOUT_ERROR_NAME ? 'timeout' : 'offline';
}

/**
 * Create the GitHub verifier the service uses for handoffs and rotation.
 *
 * @param fetchImpl - Injectable `fetch`; defaults to the process global so
 *   production uses Node's built-in client and tests supply a fake.
 * @returns The verifier bound to that `fetch`.
 */
export function createGitHubVerifier(
    fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
): GitHubVerifier {
    return {
        verify: async (token: string): Promise<VerifyOutcome> => {
            let response: Response;
            try {
                response = await fetchImpl(`${API_ORIGIN}${USER_PATH}`, {
                    method: 'GET',
                    headers: requestHeaders(token),
                    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
                });
            } catch (error) {
                // Transport failures are classified, never described: the
                // caught message can quote the URL, the cause chain, or the
                // request options (SEC-11 — no upstream text in logs).
                return { kind: 'unavailable', detail: transportDetail(error) };
            }

            const scopeCheck = buildScopeCheck(response.headers.get(OAUTH_SCOPES_HEADER));
            if (!response.ok) {
                return classifyRejection(response, scopeCheck);
            }

            const identity = readIdentity(await response.text());
            if (identity === null) {
                return { kind: 'rejected', reason: 'auth-failed' };
            }

            return {
                kind: 'ok',
                identity,
                scopeCheck,
                credentialKind: credentialKindOf(token),
                rateBaseline: await readRateBaselineQuietly(fetchImpl, token),
            };
        },
    };
}
