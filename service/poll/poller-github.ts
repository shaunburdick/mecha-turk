/**
 * GitHub poller for the service loop (M1 re-cut, the "small poller client"
 * the cut allows on top of the credential verifier), extended in Slice 2 for
 * the M6 mention and M7 review-request triggers.
 *
 * Identical transport rules to the verifier — same API origin, headers, and
 * the shared 15-second abort, imported from `service/github.ts` so the
 * clients cannot drift — three endpoints instead of one:
 *
 * - `GET /repos/:owner/:name/issues` (`state=open`, `sort=updated`), the M1
 *   assignment scan;
 * - `GET /repos/:owner/:name/issues/comments` (`sort=updated`), the M6
 *   comment scan that looks for `@<login>`;
 * - `GET /repos/:owner/:name/pulls` (`state=open`, `sort=updated`), the M7
 *   review-request scan.
 *
 * Every list reads at most two pages of the configured size, newest-updated
 * first, so one binding's scan stays inside its rate budget; `MAX_LIST_PAGES`
 * lives here so all three callers inherit it, while the page size and the
 * bounded retry ladder arrive per call from the cycle's configuration (006
 * FR-058, FR-059). Failures are classified at the boundary and no upstream
 * text ever leaves this module: the loop turns the class into a skip. The
 * entry shapes and their per-row readers sit beside this module in
 * `poller-entries.ts`.
 */

import { parseJsonText } from '../json.ts';
import {
    API_ORIGIN,
    GITHUB_TIMEOUT_MS,
    isRateLimited,
    requestHeaders,
    retryAfterOf,
    transportDetail,
} from '../github.ts';
import type { FetchLike, UnavailableDetail } from '../github.ts';
import type { ServiceLogger } from '../log.ts';
import { waitForRetry } from './backoff.ts';
import type { RandomFn, RetryPolicy, SleepFn } from './backoff.ts';
import { readCommentEntry, readIssueEntry, readPullEntry } from './poller-entries.ts';
import type { PollComment, PollIssue, PollPull } from './poller-entries.ts';

/** Entry shapes re-exported so callers keep one import path for the poller. */
export type { PollComment, PollIssue, PollPull };

/** Shared status constant (the verifier keeps the catalog in `github.ts`). */
const STATUS_UNAUTHORIZED = 401;
/** Shared status constant. */
const STATUS_NOT_FOUND = 404;
/** Shared status constant. */
const STATUS_FORBIDDEN = 403;
/** Shared status constant: primary and secondary GitHub rate limits. */
const STATUS_TOO_MANY_REQUESTS = 429;

/** Pages read per list call; a full first page justifies one more. */
const MAX_LIST_PAGES = 2;

/**
 * Page size and retry ladder one list call runs under (006 FR-058, FR-059).
 *
 * Both values are read from the stored configuration **once per cycle** and
 * carried on every query, which is what makes `perPage` and the three retry
 * knobs `next-cycle` rather than live.
 */
export interface ListPace {
    /** `per_page` this call asks for — the validated `perPage`, never above 30. */
    readonly perPage: number;
    /** The poll-*request* ladder this call may run; never a run retry (FR-058). */
    readonly retry: RetryPolicy;
}

/**
 * The poller's own injectables (plan D7): where waits are reported, slept, and
 * jittered. Production gets the shared logger, `setTimeout`, and `Math.random`;
 * a test passes a capturing sink and never sleeps at all.
 */
export interface PollerDeps {
    /** Structured logger; every wait is reported through it (FR-058). */
    readonly log: ServiceLogger;
    /** Injected sleep; production waits, tests record instead. */
    readonly sleep?: SleepFn;
    /** Injected jitter source; tests make every recorded delay deterministic. */
    readonly random?: RandomFn;
}

/** Newest-updated first, so a scan window sees fresh activity first. */
const NEWEST_UPDATED_FIRST = { sort: 'updated', direction: 'desc' } as const;

/**
 * Failure classes a list call can answer with.
 *
 * Shared by all three list outcomes so the loop's skip mapping reads one
 * shape: the class escapes, upstream detail never does.
 */
export type PollFailure =
    | { readonly kind: 'auth-failed' }
    | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
    | { readonly kind: 'unavailable'; readonly detail: UnavailableDetail };

/**
 * What a paged read answers with before the public method renames its
 * payload: the normalized items, or the classified failure.
 */
export type PagedList<T> = { readonly kind: 'ok'; readonly items: readonly T[] } | PollFailure;

/** Outcome of one issues-list call (classified at the boundary, like `verify`). */
export type IssueListOutcome = { readonly kind: 'ok'; readonly issues: readonly PollIssue[] } | PollFailure;

/** Outcome of one issue-comments-list call. */
export type CommentListOutcome = { readonly kind: 'ok'; readonly comments: readonly PollComment[] } | PollFailure;

/** Outcome of one pulls-list call. */
export type PullListOutcome = { readonly kind: 'ok'; readonly pulls: readonly PollPull[] } | PollFailure;

/** Credential, repository, and the `since` window a windowed list takes. */
interface WindowedListQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
    readonly since: string | null;
    /** Page size and retry ladder this call runs under (006 FR-058, FR-059). */
    readonly pace: ListPace;
}

/** Credential and repository for a list that has no `since` window (pulls). */
interface RepoListQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
    /** Page size and retry ladder this call runs under (006 FR-058, FR-059). */
    readonly pace: ListPace;
}

/** The surface the poll loop drives. */
export interface GitHubIssuePoller {
    /**
     * List the open issues of one repository, newest-updated first.
     *
     * @param query - Token, repository, optional `since` filter.
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listOpenIssues(query: WindowedListQuery): Promise<IssueListOutcome>;

    /**
     * List the issue comments of one repository, newest-updated first (M6).
     *
     * @param query - Token, repository, optional `since` filter.
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listIssueComments(query: WindowedListQuery): Promise<CommentListOutcome>;

    /**
     * List the open pull requests of one repository, newest-updated first (M7).
     *
     * @param query - Token and repository.
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listOpenPulls(query: RepoListQuery): Promise<PullListOutcome>;
}

/**
 * Parse one list page body, skipping entries the shape check refuses.
 *
 * @param input - The body text, the error text when it is not an array
 *   (never upstream text), and the per-entry reader (`null` drops one
 *   malformed entry).
 * @returns The normalized entries.
 * @throws {Error} When the body is not a JSON array.
 */
function parseListPage<T>(input: {
    readonly text: string;
    readonly message: string;
    readonly read: (value: unknown) => T | null;
}): T[] {
    const parsed = parseJsonText(input.text);
    if (!parsed.ok || !Array.isArray(parsed.value)) {
        throw new Error(input.message);
    }

    return parsed.value.flatMap((entry) => {
        const item = input.read(entry);
        return item === null ? [] : [item];
    });
}

/**
 * Classify a non-200 list answer.
 *
 * @param response - Upstream response.
 * @returns The classified failure, or the `ok` outcome for a 200.
 */
async function classifyListOutcome(response: Response): Promise<PollFailure> {
    if (response.status === STATUS_UNAUTHORIZED || response.status === STATUS_NOT_FOUND) {
        return { kind: 'auth-failed' };
    }

    const rateLimitStatuses = [STATUS_FORBIDDEN, STATUS_TOO_MANY_REQUESTS];
    if (rateLimitStatuses.includes(response.status) && isRateLimited(response)) {
        return { kind: 'rate-limited', retryAfterSeconds: retryAfterOf(response) };
    }

    return { kind: 'unavailable', detail: 'upstream' };
}

/** One page attempt: a usable response, or the classified failure. */
type PageAttempt = { readonly response: Response } | { readonly failure: PollFailure };

/** The request context a wait is performed inside. */
interface WaitContext {
    /** Transport plus the poller's injectables. */
    readonly runtime: PollerRuntime;
    /** Request URL; only its path reaches the log line. */
    readonly url: URL;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
}

/**
 * Sleep the ladder's next wait, reporting it first.
 *
 * The report happens before the sleep so an operator can see the delay start,
 * and it carries the path, the attempt, the length, and the source — never a
 * header value and never a credential (FR-058's log requirement; 002 FR-007).
 *
 * @param context - The request context the wait belongs to.
 * @param wait - The attempt the wait precedes (the first is never waited for)
 *   and the rate-limit guidance in seconds, or `null`.
 */
async function waitBeforeNextAttempt(
    context: WaitContext,
    wait: { readonly attempt: number; readonly guidanceSeconds: number | null },
): Promise<void> {
    const { runtime, pace, url } = context;
    await waitForRetry({
        policy: pace.retry,
        attempt: wait.attempt,
        guidanceSeconds: wait.guidanceSeconds,
        sleep: runtime.sleep,
        random: runtime.random,
        onWait: (record) => {
            runtime.log.info('poll request waiting before its next attempt', {
                path: url.pathname,
                attempt: record.attempt,
                delayMs: record.delayMs,
                source: record.source,
            });
        },
    });
}

/**
 * Issue one page request, retrying under the configured ladder (FR-058).
 *
 * `auth-failed` returns immediately — a credential GitHub refuses is a stop
 * condition, not a transient error (constitution II) — and every other class
 * may be attempted up to `retryMaxAttempts` times **including the first**.
 * Each wait is reported before it starts, naming its length and its source,
 * with no header value and no credential in the line.
 *
 * @param input - Transport, poller injectables, credential, URL, and pace.
 * @returns The response, or the failure the last attempt produced.
 */
async function requestPage(input: {
    /** Transport plus the poller's injectables. */
    readonly runtime: PollerRuntime;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Request URL for this page. */
    readonly url: URL;
    /** Page size and retry ladder for this call. */
    readonly pace: ListPace;
}): Promise<PageAttempt> {
    const policy = input.pace.retry;
    const attempts = Math.max(1, policy.maxAttempts);
    let last: PollFailure = { kind: 'unavailable', detail: 'upstream' };

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let response: Response;
        try {
            response = await input.runtime.fetchImpl(input.url.toString(), {
                method: 'GET',
                headers: requestHeaders(input.token),
                signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
            });
        } catch (error) {
            // Transport failures are classified, never described (SEC-11).
            last = { kind: 'unavailable', detail: transportDetail(error) };
            if (attempt >= attempts) {
                return { failure: last };
            }
            await waitBeforeNextAttempt(input, { attempt: attempt + 1, guidanceSeconds: null });
            continue;
        }

        if (response.ok) {
            return { response };
        }

        last = await classifyListOutcome(response);
        if (last.kind === 'auth-failed' || attempt >= attempts) {
            return { failure: last };
        }

        const guidanceSeconds = last.kind === 'rate-limited' ? last.retryAfterSeconds : null;
        await waitBeforeNextAttempt(input, { attempt: attempt + 1, guidanceSeconds });
    }

    return { failure: last };
}

/**
 * Read every page one list call covers.
 *
 * Page 2 is requested only when page 1 filled its cap, so the rate budget
 * never sees a burst; a page that keeps failing under the ladder stops the
 * paging and reports its class alone.
 *
 * @param input - Transport, poller injectables, the URL to page through, the
 *   pace, and the page reader.
 * @returns The normalized items, or the page failure's class.
 */
async function listPages<T>(input: {
    /** Transport plus the poller's injectables. */
    readonly runtime: PollerRuntime;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Request URL; the `page` parameter is set per iteration. */
    readonly url: URL;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
    /** Error text when a body is not an array (never upstream text). */
    readonly message: string;
    /** Per-entry reader; `null` drops one malformed entry. */
    readonly read: (value: unknown) => T | null;
}): Promise<PagedList<T>> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        input.url.searchParams.set('page', String(page));
        // FR-059(b): the configured page size, whose own maximum is 30, so
        // 002 FR-020's ceiling is the field's bound and nothing else.
        input.url.searchParams.set('per_page', String(input.pace.perPage));

        const attempt = await requestPage({
            runtime: input.runtime,
            token: input.token,
            url: input.url,
            pace: input.pace,
        });
        if (!('response' in attempt)) {
            return attempt.failure;
        }

        let parsed: T[];
        try {
            parsed = parseListPage({
                text: await attempt.response.text(),
                message: input.message,
                read: input.read,
            });
        } catch {
            return { kind: 'unavailable', detail: 'upstream' };
        }

        items.push(...parsed);
        if (parsed.length < input.pace.perPage) {
            break;
        }
    }

    return { kind: 'ok', items };
}

/**
 * Build the repository URL one list method pages through.
 *
 * @param input - Repository coordinates, the path after the repo, the query
 *   parameters the method always sends, and its optional `since` window.
 * @returns The request URL with those query parameters set.
 */
function listUrl(input: {
    readonly owner: string;
    readonly name: string;
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
    readonly since: string | null;
}): URL {
    const url = new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/${input.path}`);
    for (const [key, value] of Object.entries(input.query)) {
        url.searchParams.set(key, value);
    }

    if (input.since !== null) {
        url.searchParams.set('since', input.since);
    }

    return url;
}

/** Everything one list call is bound to: transport plus the poller's injectables. */
interface PollerRuntime {
    /** Injectable `fetch`. */
    readonly fetchImpl: FetchLike;
    /** Logger every wait is reported through (FR-058). */
    readonly log: ServiceLogger;
    /** Injected sleep; the production default waits on a real timer. */
    readonly sleep: SleepFn;
    /** Injected jitter source; the production default is `Math.random`. */
    readonly random: RandomFn;
}

/**
 * The production sleep: a real timer, awaited.
 *
 * Tests pass a recorder instead, so a ladder of waits costs them no time at
 * all (SC-116's "injected clock, no real sleeps").
 *
 * @param milliseconds - How long to wait.
 * @returns A promise that settles after the delay.
 */
const systemSleep: SleepFn = async (milliseconds) => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    });
};

/**
 * Run the M1 issue list and answer it under the field the interface promises.
 *
 * @param runtime - Transport plus the poller's injectables.
 * @param query - Credential, repository, window, and pace.
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function issuesList(runtime: PollerRuntime, query: WindowedListQuery): Promise<IssueListOutcome> {
    const result = await listPages({
        runtime,
        pace: query.pace,
        token: query.token,
        url: listUrl({
            owner: query.owner,
            name: query.name,
            path: 'issues',
            query: { state: 'open', ...NEWEST_UPDATED_FIRST },
            since: query.since,
        }),
        message: 'issue list response was not an array',
        read: readIssueEntry,
    });

    return result.kind === 'ok' ? { kind: 'ok', issues: result.items } : result;
}

/**
 * Run the M6 issue-comments list and answer it under its promised field.
 *
 * @param runtime - Transport plus the poller's injectables.
 * @param query - Credential, repository, window, and pace.
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function commentsList(runtime: PollerRuntime, query: WindowedListQuery): Promise<CommentListOutcome> {
    const result = await listPages({
        runtime,
        pace: query.pace,
        token: query.token,
        url: listUrl({
            owner: query.owner,
            name: query.name,
            path: 'issues/comments',
            query: { ...NEWEST_UPDATED_FIRST },
            since: query.since,
        }),
        message: 'issue comment list response was not an array',
        read: readCommentEntry,
    });

    return result.kind === 'ok' ? { kind: 'ok', comments: result.items } : result;
}

/**
 * Run the M7 pulls list and answer it under its promised field.
 *
 * @param runtime - Transport plus the poller's injectables.
 * @param query - Credential, repository, and pace (no `since` window: the review
 *   request is matched against the PR's own `updated_at` in the scan).
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function pullsList(runtime: PollerRuntime, query: RepoListQuery): Promise<PullListOutcome> {
    const result = await listPages({
        runtime,
        pace: query.pace,
        token: query.token,
        url: listUrl({
            owner: query.owner,
            name: query.name,
            path: 'pulls',
            query: { state: 'open', ...NEWEST_UPDATED_FIRST },
            since: null,
        }),
        message: 'pull list response was not an array',
        read: readPullEntry,
    });

    return result.kind === 'ok' ? { kind: 'ok', pulls: result.items } : result;
}

/**
 * Create the GitHub client the poll loop uses.
 *
 * @param deps - Logger every wait is reported through, plus the optional
 *   injected `sleep` and `random` a deterministic test supplies (plan D7).
 * @param fetchImpl - Injectable `fetch`; defaults to the process global so
 *   production uses Node's built-in client and tests supply a fake.
 * @returns The poller bound to that transport and those injectables.
 */
export function createGitHubIssuePoller(
    deps: PollerDeps,
    fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
): GitHubIssuePoller {
    const runtime: PollerRuntime = {
        fetchImpl,
        log: deps.log,
        sleep: deps.sleep ?? systemSleep,
        random: deps.random ?? (() => Math.random()),
    };

    return {
        listOpenIssues: (query) => issuesList(runtime, query),
        listIssueComments: (query) => commentsList(runtime, query),
        listOpenPulls: (query) => pullsList(runtime, query),
    };
}

