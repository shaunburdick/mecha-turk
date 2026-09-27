import { describe, expect, it } from 'vitest';
import {
    fetchAuthenticatedLogin,
    fetchOpenIssues,
    issueDetailRequest,
    issueListRequest,
    parseAuthenticatedLogin,
    parseIssueDetail,
    parseIssueList,
    userRequest,
    GitHubApiError,
} from '../extension/src/github.ts';
import type { RequestingHost } from '../extension/src/github.ts';

/** Repository used by the request builders and the fixtures. */
const REPO = { owner: 'acme', name: 'widget' };

/** HTTP status used for the success path. */
const OK = 200;

/** HTTP status used for the permission-denied path. */
const FORBIDDEN = 403;

/** Number of issues in the fixture page. */
const PAGE_SIZE = 3;

/** Login the fixture token authenticates as. */
const LOGIN = 'mecha-bot';

/** Title of the fixture issue. */
const TITLE = 'Fix the flaky test';

/** URL of the fixture issue. */
const ISSUE_URL = 'https://github.com/acme/widget/issues/7';

/** Body of the fixture issue; untrusted source text. */
const ISSUE_BODY = 'It fails once in ten runs.';

/**
 * A realistic GitHub issue list page, exactly as the host returns it as text.
 *
 * The fixture stays a raw JSON string on purpose: GitHub's own field names are
 * snake_case, and the repository lint rules keep snake_case out of the code we
 * author.
 */
const ISSUE_PAGE = [
    '[{"number":7,"title":"TITLE","html_url":"ISSUE_URL","state":"open",',
    ' "assignees":[{"login":"LOGIN"}],"body":"ISSUE_BODY"}',
    ',{"number":8,"title":"Refactor the parser",',
    ' "html_url":"https://github.com/acme/widget/pull/8","state":"open",',
    ' "assignees":[{"login":"LOGIN"}],"body":null,',
    ' "pull_request":{"url":"https://api.github.com/repos/acme/widget/pulls/8"}}',
    ',{"number":9,"title":"Upgrade dependencies",',
    ' "html_url":"https://github.com/acme/widget/issues/9","state":"closed",',
    ' "assignees":[],"body":null}]',
]
    .join('')
    .replaceAll('TITLE', TITLE)
    .replaceAll('ISSUE_URL', ISSUE_URL)
    .replaceAll('LOGIN', LOGIN)
    .replaceAll('ISSUE_BODY', ISSUE_BODY);

/** A single-issue detail payload for the detail endpoint. */
const ISSUE_DETAIL = [
    `{"number":7,"title":"${TITLE}","html_url":"${ISSUE_URL}","state":"open",`,
    ` "assignees":[{"login":"${LOGIN}"}],"body":"${ISSUE_BODY}"}`,
].join('');

/**
 * Build a host double that answers with a canned response.
 *
 * @param status - HTTP status to answer with.
 * @param body - Response body text.
 * @returns A `request`-compatible host.
 */
function fakeHost(status: number, body: string): RequestingHost {
    return {
        request: async () => ({ status, body }),
    };
}

/**
 * Run a synchronous callback and return the error it threw.
 *
 * @param run - Callback expected to throw.
 * @returns The caught error, or `null` when nothing was thrown.
 */
function captureError(run: () => unknown): Error | null {
    try {
        run();
        return null;
    } catch (error) {
        return error instanceof Error ? error : new Error('non-error throw');
    }
}

/**
 * Await a promise expected to reject and return the reason.
 *
 * @param promise - Promise expected to reject.
 * @returns The rejection reason as an `Error`, or `null` when it resolved.
 */
async function captureRejection(promise: Promise<unknown>): Promise<Error | null> {
    try {
        await promise;
        return null;
    } catch (error) {
        return error instanceof Error ? error : new Error('non-error rejection');
    }
}

describe('request builders', () => {
    it('builds the authenticated-login request', () => {
        expect(userRequest()).toEqual({ method: 'GET', path: '/user' });
    });

    it('builds the repository issue list request with the open filter', () => {
        expect(issueListRequest(REPO)).toEqual({
            method: 'GET',
            path: '/repos/acme/widget/issues',
            query: { state: 'open' },
        });
    });

    it('builds the single-issue detail request', () => {
        expect(issueDetailRequest(REPO, 7)).toEqual({
            method: 'GET',
            path: '/repos/acme/widget/issues/7',
        });
    });
});

describe('payload parsing', () => {
    it('normalises an issue page including pull requests', () => {
        const issues = parseIssueList(ISSUE_PAGE);

        expect(issues).toHaveLength(PAGE_SIZE);
        expect(issues[0]).toEqual({
            issueNumber: 7,
            title: TITLE,
            url: ISSUE_URL,
            state: 'open',
            body: ISSUE_BODY,
            assignees: [LOGIN],
            isPullRequest: false,
        });
        expect(issues[1]?.isPullRequest).toBe(true);
        expect(issues[2]?.assignees).toEqual([]);
    });

    it('parses a single issue detail payload', () => {
        expect(parseIssueDetail(ISSUE_DETAIL).issueNumber).toBe(7);
    });

    it('parses the authenticated login', () => {
        expect(parseAuthenticatedLogin(JSON.stringify({ login: LOGIN }))).toBe(LOGIN);
    });

    it('rejects a body that is not JSON', () => {
        expect(() => parseIssueList('<html>rate limited</html>')).toThrow(GitHubApiError);
    });

    it('rejects a JSON body that is not an array', () => {
        expect(() => parseIssueList(JSON.stringify({ message: 'Not Found' }))).toThrow(GitHubApiError);
    });

    it('rejects an issue without a usable number', () => {
        expect(() => parseIssueList(JSON.stringify([{ title: TITLE }]))).toThrow(GitHubApiError);
    });

    it('rejects a login payload without a login', () => {
        expect(() => parseAuthenticatedLogin(JSON.stringify({ name: 'nope' }))).toThrow(GitHubApiError);
    });

    it('never includes the payload text in the error message', () => {
        const payload = JSON.stringify({ message: 'super-secret-provider-detail' });
        const error = captureError(() => parseAuthenticatedLogin(payload));

        expect(error).toBeInstanceOf(GitHubApiError);
        if (error instanceof GitHubApiError) {
            expect(error.message).not.toContain('super-secret-provider-detail');
            expect(error.status).toBeNull();
        }
    });
});

describe('host-backed fetches', () => {
    it('reads the authenticated login through the host', async () => {
        const host = fakeHost(OK, JSON.stringify({ login: LOGIN }));
        await expect(fetchAuthenticatedLogin(host)).resolves.toBe(LOGIN);
    });

    it('reads the issue list through the host', async () => {
        const host = fakeHost(OK, ISSUE_PAGE);
        const issues = await fetchOpenIssues(host, REPO);
        expect(issues).toHaveLength(PAGE_SIZE);
    });

    it('surfaces a non-200 status without echoing the provider body', async () => {
        const body = JSON.stringify({ message: 'Bad credentials' });
        const host = fakeHost(FORBIDDEN, body);
        const error = await captureRejection(fetchOpenIssues(host, REPO));

        expect(error).toBeInstanceOf(GitHubApiError);
        if (error instanceof GitHubApiError) {
            expect(error.status).toBe(FORBIDDEN);
            expect(error.message).not.toContain('Bad credentials');
        }
    });

    it('lets host failures propagate for the caller to record', async () => {
        const host: RequestingHost = {
            request: async () => {
                throw new Error('HOST_UNAVAILABLE: not inside OpenChamber');
            },
        };

        const error = await captureRejection(fetchAuthenticatedLogin(host));
        expect(error?.message).toContain('HOST_UNAVAILABLE');
    });
});
