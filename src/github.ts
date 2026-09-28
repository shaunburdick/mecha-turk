/**
 * GitHub REST access for the spike, performed exclusively through the
 * documented `host.request()` bridge.
 *
 * The sandboxed panel cannot reach the network itself: OpenChamber joins the
 * path to the manifest's `apiOrigin` and attaches the user's token. This
 * module therefore only ever builds paths and parses response bodies — it
 * never sees, stores, or logs a credential.
 *
 * Provider payload fields are read through accessors rather than destructured,
 * so GitHub's own snake_case names stay inside string arguments instead of
 * becoming identifiers in this codebase.
 */

import type { GuestRequest, HostClient } from '@openchamber/sdk';
import type { RepositoryRef } from './config.ts';

/** The host surface the GitHub flow needs: `request` and nothing else. */
export type RequestingHost = Pick<HostClient, 'request'>;

/** Normalised, minimal view of a GitHub issue as used by the spike. */
export interface GitHubIssue {
    /** Issue number within the repository. */
    readonly issueNumber: number;
    /** Issue title. Untrusted source text. */
    readonly title: string;
    /** Canonical `https://github.com/...` URL. */
    readonly url: string;
    /** Repository state, `open` or `closed`. */
    readonly state: string;
    /** Issue body, or `null` when GitHub returned none. Untrusted source text. */
    readonly body: string | null;
    /** Logins of the current assignees. */
    readonly assignees: readonly string[];
    /** `true` when the entry is a pull request (GitHub lists PRs as issues). */
    readonly isPullRequest: boolean;
}

/** HTTP status that counts as success for every GET this module performs. */
const HTTP_OK = 200;

/**
 * Raised when GitHub answers with a non-200 status or a payload the spike
 * cannot parse.
 *
 * The message never embeds the response body: provider payloads are untrusted
 * and may carry anything, including content the ledger must not hold.
 */
export class GitHubApiError extends Error {
    /** Stable machine-readable marker so callers can discriminate. */
    public override readonly name = 'GitHubApiError';

    /** HTTP status reported by GitHub, or `null` when the payload was unusable. */
    public readonly status: number | null;

    /**
     * @param message - Description of the failure; never includes payload text.
     * @param status - HTTP status code, or `null` for malformed payloads.
     */
    public constructor(message: string, status: number | null) {
        super(message);
        this.status = status;
    }
}

/**
 * Build the `GET /user` request used to discover the PAT identity.
 *
 * @returns The documented request descriptor for the authenticated login.
 */
export function userRequest(): GuestRequest {
    return { method: 'GET', path: '/user' };
}

/**
 * Build the open-issues list request for one repository.
 *
 * The spike reads the endpoint's default first page of open issues: GitHub's
 * documented defaults already return open issues newest-first, and a
 * single-issue spike does not need paging. Production pagination belongs to the
 * daemon design, not this gate.
 *
 * @param repository - Repository to poll.
 * @returns The documented request descriptor for the issue list.
 */
export function issueListRequest(repository: RepositoryRef): GuestRequest {
    return {
        method: 'GET',
        path: `/repos/${repository.owner}/${repository.name}/issues`,
        query: { state: 'open' },
    };
}

/**
 * Build the single-issue detail request.
 *
 * @param repository - Repository that owns the issue.
 * @param issueNumber - Issue number.
 * @returns The documented request descriptor for the issue detail.
 */
export function issueDetailRequest(repository: RepositoryRef, issueNumber: number): GuestRequest {
    return { method: 'GET', path: `/repos/${repository.owner}/${repository.name}/issues/${issueNumber}` };
}

/**
 * Narrow an unknown JSON value to a record.
 *
 * @param value - Parsed JSON value.
 * @returns The value as a record, or `null` for anything else.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, unknown>;
}

/**
 * Parse a JSON document, failing closed on anything unusable.
 *
 * @param body - Raw response text.
 * @param what - Short label used in error messages.
 * @returns The parsed value.
 * @throws {GitHubApiError} When the body is not valid JSON.
 */
function parseJson(body: string, what: string): unknown {
    try {
        return JSON.parse(body) as unknown;
    } catch {
        throw new GitHubApiError(`${what} response was not valid JSON`, null);
    }
}

/**
 * Read a required string field from a payload record.
 *
 * @param input - Record to read from, the field name, and the error context.
 * @returns The field value.
 * @throws {GitHubApiError} When the field is missing or not a string.
 */
function requireString(input: { record: Record<string, unknown>; field: string; context: string }): string {
    const value = input.record[input.field];
    if (typeof value !== 'string' || value === '') {
        throw new GitHubApiError(`${input.context} is missing "${input.field}"`, null);
    }

    return value;
}

/**
 * Read the positive integer issue number from a payload record.
 *
 * @param record - Source record.
 * @param context - Short label used in error messages.
 * @returns The issue number.
 * @throws {GitHubApiError} When the field is absent or not a positive integer.
 */
function requireIssueNumber(record: Record<string, unknown>, context: string): number {
    const issueNumber = record.number;
    if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
        throw new GitHubApiError(`${context} has no usable issue number`, null);
    }

    return issueNumber;
}

/**
 * Parse one issue-shaped entry from the GitHub REST API.
 *
 * @param value - A single element of a list response, or a detail response.
 * @param context - Short label used in error messages.
 * @returns The normalised issue.
 * @throws {GitHubApiError} When a required field has an unexpected shape.
 */
function parseIssueEntry(value: unknown, context: string): GitHubIssue {
    const record = asRecord(value);
    if (record === null) {
        throw new GitHubApiError(`${context} is not an object`, null);
    }

    const issueNumber = requireIssueNumber(record, context);
    const state = requireString({ record, field: 'state', context });

    const rawAssignees = record.assignees;
    if (!Array.isArray(rawAssignees)) {
        throw new GitHubApiError(`${context} has no usable assignees`, null);
    }

    const assignees = rawAssignees.map((entry) => {
        const assignee = asRecord(entry);
        if (assignee === null) {
            throw new GitHubApiError(`${context} has a malformed assignee`, null);
        }

        return requireString({ record: assignee, field: 'login', context: `${context} assignee` });
    });

    const rawBody = record.body;
    const body = typeof rawBody === 'string' ? rawBody : null;

    return {
        issueNumber,
        title: requireString({ record, field: 'title', context }),
        url: requireString({ record, field: 'html_url', context }),
        state,
        body,
        assignees,
        // GitHub adds a `pull_request` object only to PRs it lists as issues;
        // key presence is the documented discriminator.
        isPullRequest: 'pull_request' in record,
    };
}

/**
 * Parse the `GET /user` response body.
 *
 * @param body - Raw response text.
 * @returns The authenticated login.
 * @throws {GitHubApiError} When the payload has no usable `login`.
 */
export function parseAuthenticatedLogin(body: string): string {
    const record = asRecord(parseJson(body, '/user'));
    if (record === null) {
        throw new GitHubApiError('/user response was not an object', null);
    }

    return requireString({ record, field: 'login', context: '/user' });
}

/**
 * Parse an issue-list response body.
 *
 * @param body - Raw response text.
 * @returns Every normalised issue in the page, pull requests included.
 * @throws {GitHubApiError} When the payload is not an array of issues.
 */
export function parseIssueList(body: string): GitHubIssue[] {
    const parsed = parseJson(body, 'issue list');
    if (!Array.isArray(parsed)) {
        throw new GitHubApiError('issue list response was not an array', null);
    }

    return parsed.map((entry, index) => parseIssueEntry(entry, `issue list entry ${index}`));
}

/**
 * Parse a single-issue detail response body.
 *
 * @param body - Raw response text.
 * @returns The normalised issue.
 * @throws {GitHubApiError} When the payload is not an issue object.
 */
export function parseIssueDetail(body: string): GitHubIssue {
    return parseIssueEntry(parseJson(body, 'issue detail'), 'issue detail');
}

/**
 * Perform a request through the host and validate its status.
 *
 * @param input - Host client, request descriptor, and expected status.
 * @returns The response body text.
 * @throws {GitHubApiError} When the status is not the expected one.
 */
async function requestOk(input: { host: RequestingHost; request: GuestRequest; expect: number }): Promise<string> {
    const result = await input.host.request(input.request);
    if (result.status !== input.expect) {
        const answered = `${input.request.method} ${input.request.path} answered ${result.status}`;
        throw new GitHubApiError(answered, result.status);
    }

    return result.body;
}

/**
 * Read the authenticated login for the connected token.
 *
 * @param host - Host client supplying `request`.
 * @returns The login GitHub reports for the attached credential.
 * @throws {GitHubApiError} On a non-OK answer or an unusable payload.
 */
export async function fetchAuthenticatedLogin(host: RequestingHost): Promise<string> {
    return parseAuthenticatedLogin(await requestOk({ host, request: userRequest(), expect: HTTP_OK }));
}

/**
 * List the open issues of one repository.
 *
 * @param host - Host client supplying `request`.
 * @param repository - Repository to poll.
 * @returns Every normalised issue on the default first page.
 * @throws {GitHubApiError} On a non-OK answer or an unusable payload.
 */
export async function fetchOpenIssues(host: RequestingHost, repository: RepositoryRef): Promise<GitHubIssue[]> {
    return parseIssueList(await requestOk({ host, request: issueListRequest(repository), expect: HTTP_OK }));
}

/**
 * Fetch one issue's current detail.
 *
 * @param input - Host client, repository, and issue number.
 * @returns The normalised issue as GitHub reports it now.
 * @throws {GitHubApiError} On a non-OK answer or an unusable payload.
 */
export async function fetchIssueDetail(input: {
    /** Host client supplying `request`. */
    host: RequestingHost;
    /** Repository that owns the issue. */
    repository: RepositoryRef;
    /** Issue number. */
    issueNumber: number;
}): Promise<GitHubIssue> {
    const request = issueDetailRequest(input.repository, input.issueNumber);
    return parseIssueDetail(await requestOk({ host: input.host, request, expect: HTTP_OK }));
}
