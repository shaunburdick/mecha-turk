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
 * Every list reads at most two pages of thirty items, newest-updated first,
 * so one binding's scan stays inside its rate budget; the cap lives here so
 * all three callers inherit it. Failures are classified at the boundary and
 * no upstream text ever leaves this module: the loop turns the class into a
 * skip. The entry shapes and their per-row readers sit beside this module in
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

/** Items requested per page; each page stays well inside the response cap. */
const PAGE_SIZE = 30;

/** Pages read per list call; a full first page justifies one more. */
const MAX_LIST_PAGES = 2;

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
}

/** Credential and repository for a list that has no `since` window (pulls). */
interface RepoListQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
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

/**
 * Read every page one list call covers.
 *
 * Page 2 is requested only when page 1 filled its cap, so the rate budget
 * never sees a burst; the first failed page stops the paging and reports its
 * class alone.
 *
 * @param input - Transport, the URL to page through, and the page reader.
 * @returns The normalized items, or the page failure's class.
 */
async function listPages<T>(input: {
    /** Injectable `fetch`. */
    readonly fetchImpl: FetchLike;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Request URL; the `page` parameter is set per iteration. */
    readonly url: URL;
    /** Error text when a body is not an array (never upstream text). */
    readonly message: string;
    /** Per-entry reader; `null` drops one malformed entry. */
    readonly read: (value: unknown) => T | null;
}): Promise<PagedList<T>> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
        input.url.searchParams.set('page', String(page));

        let response: Response;
        try {
            response = await input.fetchImpl(input.url.toString(), {
                method: 'GET',
                headers: requestHeaders(input.token),
                signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
            });
        } catch (error) {
            // Transport failures are classified, never described (SEC-11).
            return { kind: 'unavailable', detail: transportDetail(error) };
        }

        if (!response.ok) {
            return await classifyListOutcome(response);
        }

        let parsed: T[];
        try {
            parsed = parseListPage({ text: await response.text(), message: input.message, read: input.read });
        } catch {
            return { kind: 'unavailable', detail: 'upstream' };
        }

        items.push(...parsed);
        if (parsed.length < PAGE_SIZE) {
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

/**
 * Run the M1 issue list and answer it under the field the interface promises.
 *
 * @param fetchImpl - Transport this client is bound to.
 * @param query - Credential, repository, and the `since` window.
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function issuesList(fetchImpl: FetchLike, query: WindowedListQuery): Promise<IssueListOutcome> {
    const result = await listPages({
        fetchImpl,
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
 * @param fetchImpl - Transport this client is bound to.
 * @param query - Credential, repository, and the `since` window.
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function commentsList(fetchImpl: FetchLike, query: WindowedListQuery): Promise<CommentListOutcome> {
    const result = await listPages({
        fetchImpl,
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
 * @param fetchImpl - Transport this client is bound to.
 * @param query - Credential and repository (no `since` window: the review
 *   request is matched against the PR's own `updated_at` in the scan).
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function pullsList(fetchImpl: FetchLike, query: RepoListQuery): Promise<PullListOutcome> {
    const result = await listPages({
        fetchImpl,
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
 * @param fetchImpl - Injectable `fetch`; defaults to the process global so
 *   production uses Node's built-in client and tests supply a fake.
 * @returns The poller bound to that `fetch`.
 */
export function createGitHubIssuePoller(
    fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
): GitHubIssuePoller {
    return {
        listOpenIssues: (query) => issuesList(fetchImpl, query),
        listIssueComments: (query) => commentsList(fetchImpl, query),
        listOpenPulls: (query) => pullsList(fetchImpl, query),
    };
}

