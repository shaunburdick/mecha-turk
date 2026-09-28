/**
 * Entry normalization for the poller's three list feeds (Slice 2, split out
 * of `poller-github.ts` the way `events-parse.ts` sits beside `events.ts` —
 * each module stays inside the file-length gate).
 *
 * Every reader fails soft per entry: a malformed row answers `null` and the
 * page skips it, because a list endpoint is a feed, not a transaction. No
 * upstream text leaves this module either — the shapes below carry only the
 * fields the triggers need, and the loop never sees a raw GitHub body
 * (SEC-11).
 */

import { isRecord } from '../json.ts';

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

/**
 * Minimal issue-comment shape the poller normalizes (M6).
 *
 * The comments endpoint answers for every issue *and* pull-request comment
 * in the repository, which is exactly what the mention scan wants.
 */
export interface PollComment {
    /** Comment id; stable across scans, so it keys a deduplicating event id. */
    readonly commentId: number;
    /** Issue (or PR) number, read from the comment's `issue_url`. */
    readonly issueNumber: number;
    /** Comment body; untrusted source text. */
    readonly body: string;
    /** Canonical comment URL. */
    readonly url: string;
    /** Login of the comment's author. */
    readonly authorLogin: string;
    /** Author type (`User`, `Bot`, `Organization`, …); `''` when absent. */
    readonly authorType: string;
    /** RFC 3339 `updated_at` stamp, or `null` when GitHub sent none. */
    readonly updatedAt: string | null;
}

/**
 * Minimal pull-request shape the poller normalizes (M7).
 *
 * Only what the review-request trigger needs: who is asked to review, and
 * the head/base coordinates the event carries for the dispatch context.
 */
export interface PollPull {
    /** Pull-request number within the repository. */
    readonly pullNumber: number;
    /** PR title; untrusted source text. */
    readonly title: string;
    /** Canonical GitHub URL. */
    readonly url: string;
    /** PR state (`open`/`closed`). */
    readonly state: string;
    /** Logins of the accounts currently requested to review. */
    readonly requestedReviewers: readonly string[];
    /** Head commit SHA, or `null` when GitHub sent none. */
    readonly headSha: string | null;
    /** Base ref name, or `null` when GitHub sent none. */
    readonly baseRef: string | null;
    /** RFC 3339 `updated_at` stamp, or `null` when GitHub sent none. */
    readonly updatedAt: string | null;
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
 * Read one positive integer field.
 *
 * @param value - Candidate value.
 * @returns The integer, or `null` when the value is not one.
 */
function positiveIntOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Read one string field.
 *
 * @param record - Parsed record.
 * @param field - Field name.
 * @returns The text, or `null` when the field is not text.
 */
function textOf(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' ? value : null;
}

/**
 * Read a list of logins out of one list field.
 *
 * @param value - Candidate array (`assignees`, `requested_reviewers`).
 * @returns The logins, or `null` when the field is not an array of text.
 */
function readLogins(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const logins: string[] = [];
    for (const entry of value) {
        const login = asRecord(entry);
        const candidate = login === null ? null : login.login;
        if (typeof candidate !== 'string' || candidate === '') {
            return null;
        }

        logins.push(candidate);
    }

    return logins;
}

/**
 * Read the issue number out of a comment's `issue_url`.
 *
 * @param value - Candidate URL (`…/repos/:owner/:name/issues/:number`).
 * @returns The issue number, or `null` when the URL carries none.
 */
function issueNumberOf(value: unknown): number | null {
    if (typeof value !== 'string') {
        return null;
    }

    return positiveIntOf(Number(value.slice(value.lastIndexOf('/') + 1)));
}

/**
 * Parse one issues-list entry, failing soft per entry.
 *
 * @param value - One element of the parsed list.
 * @returns The normalized issue, or `null`.
 */
export function readIssueEntry(value: unknown): PollIssue | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const issueNumber = positiveIntOf(record.number);
    const title = textOf(record, 'title');
    const url = textOf(record, 'html_url');
    const state = textOf(record, 'state');
    const assignees = readLogins(record.assignees);
    if (issueNumber === null || title === null || url === null || state === null || assignees === null) {
        return null;
    }

    return {
        issueNumber,
        title,
        url,
        state,
        body: textOf(record, 'body'),
        assignees,
        // GitHub adds a `pull_request` object only to PRs it lists as issues.
        isPullRequest: 'pull_request' in record,
        updatedAt: textOf(record, 'updated_at'),
    };
}

/**
 * Read one comment author's login, answering `''` when there is none.
 *
 * @param user - The comment's `user` object, or `null`.
 * @returns The login, or `''`.
 */
function authorLoginOf(user: Record<string, unknown> | null): string {
    return user === null ? '' : (textOf(user, 'login') ?? '');
}

/**
 * Read one comment author's type, answering `''` when there is none.
 *
 * @param user - The comment's `user` object, or `null`.
 * @returns The type (`User`, `Bot`, …), or `''`.
 */
function authorTypeOf(user: Record<string, unknown> | null): string {
    return user === null ? '' : (textOf(user, 'type') ?? '');
}

/**
 * Parse one issue-comments-list entry, failing soft per entry.
 *
 * @param value - One element of the parsed list.
 * @returns The normalized comment, or `null`.
 */
export function readCommentEntry(value: unknown): PollComment | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const commentId = positiveIntOf(record.id);
    const issueNumber = issueNumberOf(record.issue_url);
    const body = textOf(record, 'body');
    const url = textOf(record, 'html_url');
    const user = asRecord(record.user);
    const authorLogin = authorLoginOf(user);
    if (commentId === null || issueNumber === null || body === null || url === null || authorLogin === '') {
        return null;
    }

    return {
        commentId,
        issueNumber,
        body,
        url,
        authorLogin,
        authorType: authorTypeOf(user),
        updatedAt: textOf(record, 'updated_at'),
    };
}

/**
 * Parse one pulls-list entry, failing soft per entry.
 *
 * @param value - One element of the parsed list.
 * @returns The normalized pull request, or `null`.
 */
export function readPullEntry(value: unknown): PollPull | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const pullNumber = positiveIntOf(record.number);
    const title = textOf(record, 'title');
    const url = textOf(record, 'html_url');
    const state = textOf(record, 'state');
    const requestedReviewers = readLogins(record.requested_reviewers);
    if (
        pullNumber === null
        || title === null
        || url === null
        || state === null
        || requestedReviewers === null
    ) {
        return null;
    }

    const head = asRecord(record.head);
    const base = asRecord(record.base);

    return {
        pullNumber,
        title,
        url,
        state,
        requestedReviewers,
        headSha: head === null ? null : textOf(head, 'sha'),
        baseRef: base === null ? null : textOf(base, 'ref'),
        updatedAt: textOf(record, 'updated_at'),
    };
}
