/**
 * GitHub issue poller for the service loop (M1 re-cut, the "small poller
 * client" the cut allows on top of the credential verifier).
 *
 * Identical transport rules to the verifier — same API origin, headers, and
 * the shared 15-second abort, imported from `service/github.ts` so the two
 * clients cannot drift — one endpoint more: `/repos/:owner/:name/issues`
 * with `state=open` and `sort=updated`, so a scan window sees the newest
 * activity first. Failures are classified at the boundary and no upstream
 * text ever leaves this module: the loop turns the class into a skip.
 */

import { isRecord, parseJsonText } from '../json.ts';
import {
    API_ORIGIN,
    GITHUB_TIMEOUT_MS,
    isRateLimited,
    requestHeaders,
    retryAfterOf,
    transportDetail,
} from '../github.ts';
import type { FetchLike, UnavailableDetail } from '../github.ts';

/** Shared status constant (the verifier keeps the catalog in `github.ts`). */
const STATUS_UNAUTHORIZED = 401;
/** Shared status constant. */
const STATUS_NOT_FOUND = 404;
/** Shared status constant. */
const STATUS_FORBIDDEN = 403;
/** Shared status constant: primary and secondary GitHub rate limits. */
const STATUS_TOO_MANY_REQUESTS = 429;

/**
 * Minimal GitHub issue shape the poller normalizes.
 *
 * GitHub's own names (`html_url`, `updated_at`) stay inside string
 * arguments, the same rule the panel's issue readers follow; this shape is
 * stated here because the service never imports panel runtime.
 */
export interface PollIssue {
    /** Issue number within the repository. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text. */
    readonly title: string;
    /** Canonical GitHub URL. */
    readonly url: string;
    /** Issue state (`open`/`closed`). */
    readonly state: string;
    /** Issue body, or `null`; untrusted source text. */
    readonly body: string | null;
    /** Logins of the current assignees. */
    readonly assignees: readonly string[];
    /** `true` when the entry is a pull request (GitHub lists PRs as issues). */
    readonly isPullRequest: boolean;
    /** RFC 3339 `updated_at` stamp, or `null` when GitHub sent none. */
    readonly updatedAt: string | null;
}

/** Outcome of one issues-list call (classified at the boundary, like `verify`). */
export type IssueListOutcome =
    | { readonly kind: 'ok'; readonly issues: readonly PollIssue[] }
    | { readonly kind: 'auth-failed' }
    | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
    | { readonly kind: 'unavailable'; readonly detail: UnavailableDetail };

/** The surface the poll loop drives. */
export interface GitHubIssuePoller {
    /**
     * List the open issues of one repository, newest-updated first.
     *
     * @param input - Token, repository, optional `since` filter, page size.
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listOpenIssues(input: {
        readonly token: string;
        readonly owner: string;
        readonly name: string;
        readonly since: string | null;
        readonly perPage: number;
    }): Promise<IssueListOutcome>;
}

/**
 * Narrow a value to a record.
 *
 * @param value - Parsed JSON value.
 * @returns The record, or `null` for anything else.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

/**
 * Read the numeric issue number from one list entry.
 *
 * @param record - Candidate entry.
 * @returns The number, or `null` when the row is unusable.
 */
function readIssueNumber(record: Record<string, unknown>): number | null {
    const value = record.number;

    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Read the assignee logins from one list entry.
 *
 * @param record - Candidate entry.
 * @returns The logins, or `null` when any assignee is malformed.
 */
function readAssignees(record: Record<string, unknown>): readonly string[] | null {
    const raw = record.assignees;
    if (!Array.isArray(raw)) {
        return null;
    }

    const logins: string[] = [];
    for (const entry of raw) {
        const assignee = asRecord(entry);
        const login = assignee === null ? null : assignee.login;
        if (typeof login !== 'string' || login === '') {
            return null;
        }

        logins.push(login);
    }

    return logins;
}

/**
 * Parse one issues-list entry, failing soft per entry.
 *
 * A malformed entry is `null`, so one bad row cannot stop the rest of the
 * page; the list endpoint is a feed, not a transaction.
 *
 * @param value - One element of the parsed list.
 * @returns The normalized issue, or `null`.``
 */
function readIssueEntry(value: unknown): PollIssue | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const issueNumber = readIssueNumber(record);
    if (issueNumber === null) {
        return null;
    }

    const { title } = record;
    const url = record.html_url;
    const { state } = record;
    if (typeof title !== 'string' || typeof url !== 'string' || typeof state !== 'string') {
        return null;
    }

    const assignees = readAssignees(record);
    if (assignees === null) {
        return null;
    }

    const updatedAt = record.updated_at;

    return {
        issueNumber,
        title,
        url,
        state,
        body: typeof record.body === 'string' ? record.body : null,
        assignees,
        // GitHub adds a `pull_request` object only to PRs it lists as issues.
        isPullRequest: 'pull_request' in record,
        updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
    };
}

/**
 * Parse a issues-list page body, skipping entries the shape check refuses.
 *
 * @param text - Response body text.
 * @returns The normalized issues.
 * @throws {Error} When the body is not a JSON array.
 */
function parseIssuePage(text: string): PollIssue[] {
    const parsed = parseJsonText(text);
    if (!parsed.ok || !Array.isArray(parsed.value)) {
        throw new Error('issue list response was not an array');
    }

    return parsed.value.flatMap((entry) => {
        const issue = readIssueEntry(entry);
        return issue === null ? [] : [issue];
    });
}

/**
 * Classify a non-200 issues-list answer.
 *
 * @param response - Upstream response.
 * @returns The classified failure, or the `ok` outcome for a 200.
 */
async function classifyListOutcome(response: Response): Promise<IssueListOutcome> {
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
        listOpenIssues: async (input): Promise<IssueListOutcome> => {
            const target = new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/issues`);
            target.searchParams.set('state', 'open');
            target.searchParams.set('sort', 'updated');
            target.searchParams.set('direction', 'desc');
            target.searchParams.set('per_page', String(input.perPage));
            if (input.since !== null) {
                target.searchParams.set('since', input.since);
            }

            let response: Response;
            try {
                response = await fetchImpl(target.toString(), {
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

            try {
                return { kind: 'ok', issues: parseIssuePage(await response.text()) };
            } catch {
                return { kind: 'unavailable', detail: 'upstream' };
            }
        },
    };
}
