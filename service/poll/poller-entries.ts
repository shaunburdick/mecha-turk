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
 *
 * The fourth feed the poller reads — one item's own event list — is **not** a
 * list feed and its reader lives in `poller-events.ts`, beside the rules that
 * decide which of its rows answers a candidate. The split is along the line of
 * what the row is for: these three rows *are* the observations the triggers act
 * on, and an event row is evidence about an observation already detected.
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
    /** Login of the issue's author, or `''` when GitHub sent no `user`. */
    readonly authorLogin: string;
    /** Author type (`User`, `Bot`, `Organization`, …); `''` when absent. */
    readonly authorType: string;
    /** Logins of the current assignees. */
    readonly assignees: readonly string[];
    /** `true` when the entry is a pull request (GitHub lists PRs as issues). */
    readonly isPullRequest: boolean;
    /** RFC 3339 `updated_at` stamp, or `null` when GitHub sent none. */
    readonly updatedAt: string | null;
    /**
     * `closed_at` as GitHub sent it, or `null` while the issue is open.
     *
     * Read for the tracking lifecycle's end-of-tracking judgement (002 FR-106):
     * the date the work item concluded, recorded beside the terminal fact so
     * *"when did this conclude?"* is answerable from the trail. **Absentable on
     * read** and read as *no terminal state reported*, which is the direction
     * that can only fail to end tracking.
     */
    readonly closedAt?: string | null;
    /**
     * `state_reason` — `completed`, `not_planned`, or `reopened` — or `null`.
     *
     * The member that distinguishes a completed issue from one closed as not
     * planned. Absent on the pull-request object entirely, which is why the
     * terminal fact a tracking end records is derived rather than quoted.
     */
    readonly stateReason?: string | null;
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
 * Only what the review-request trigger needs: who is asked to review, and the
 * head/base coordinates the event carries for the dispatch context.
 *
 * **There is deliberately no author member here, and its absence is the record
 * of a correction.** Two builds ago this shape gained `authorLogin` /
 * `authorType` to make a `subject-author` attribution possible for the review
 * trigger, on the premise — taken from the two *list* feeds this poller calls —
 * that GitHub records no requester. That premise was false, and 002 v1.12.0
 * struck the sentence that required these fields: GitHub records the requester
 * in `review_requester` on the item's own `review_requested` event, which the
 * per-item read in `poller-events.ts` now consults. The
 * proxy was their only consumer, so with the proxy retired they are gone rather
 * than left as a second, unread answer to "who asked" (research §R8, rewritten).
 *
 * `PollIssue` and `PollComment` **keep** their author members: a comment is the
 * act that carried the mention, and an issue body that names the account is a
 * mention the same way — so their authors are facts, not stand-ins.
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
    /**
     * `merged` as GitHub sent it; an absent member reads as `false`.
     *
     * Read for FR-106's end-of-tracking judgement, which distinguishes a merged
     * pull request from one closed unmerged. **Absentable on read**, and `false`
     * is the reading of an absent member because it is the direction that can
     * only ever fail to end tracking and never end it on a guess.
     */
    readonly merged?: boolean;
    /** `merged_at` as GitHub sent it, or `null` when it sent none. */
    readonly mergedAt?: string | null;
    /** RFC 3339 `updated_at` stamp, or `null` when GitHub sent none. */
    readonly updatedAt: string | null;
}

/**
 * Narrow a value to a record.
 *
 * @returns The record, or `null` for anything else.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

/**
 * Read one positive integer field.
 *
 * @returns The integer, or `null` when the value is not one.
 */
function positiveIntOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Read one string field.
 *
 * @returns The text, or `null` when the field is not text.
 */
function textOf(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' ? value : null;
}

/**
 * Read a list of logins out of one list field.
 *
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
 * Read one entry author's login, answering `''` when there is none.
 *
 * @returns The login, or `''`.
 */
function authorLoginOf(user: Record<string, unknown> | null): string {
    return user === null ? '' : (textOf(user, 'login') ?? '');
}

/**
 * Read one entry author's type, answering `''` when there is none.
 *
 * @returns The type (`User`, `Bot`, …), or `''`.
 */
function authorTypeOf(user: Record<string, unknown> | null): string {
    return user === null ? '' : (textOf(user, 'type') ?? '');
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

    const lastSegment = value.slice(value.lastIndexOf('/') + 1);
    return positiveIntOf(Number(lastSegment));
}

/**
 * Parse one issues-list entry, failing soft per entry.
 *
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

    const user = asRecord(record.user);

    return {
        issueNumber,
        title,
        url,
        state,
        body: textOf(record, 'body'),
        // Authorship feeds the mention trigger's bot filter — the same fields
        // the comment reader takes. An entry GitHub sent no `user` for keeps
        // the issue (the assignment trigger never depended on it) and reads as
        // an unknown author, which the body-mention check refuses.
        authorLogin: authorLoginOf(user),
        authorType: authorTypeOf(user),
        assignees,
        // GitHub adds a `pull_request` object only to PRs it lists as issues.
        isPullRequest: 'pull_request' in record,
        updatedAt: textOf(record, 'updated_at'),
        closedAt: textOf(record, 'closed_at'),
        stateReason: textOf(record, 'state_reason'),
    };
}

/**
 * Parse one issue-comments-list entry, failing soft per entry.
 *
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
        merged: record.merged === true,
        mergedAt: textOf(record, 'merged_at'),
        updatedAt: textOf(record, 'updated_at'),
    };
}

/**
 * Read one **single-item** issue object — the terminal read's shape (FR-106).
 *
 * The item's own `GET /repos/{owner}/{repo}/issues/{number}` returns the same
 * Issue object a list row is, so the read reuses {@link readIssueEntry} and the
 * terminal members it already fills (`state`, `stateReason`, `closedAt`), taking
 * one object where the page readers took one entry of a page (`research.md`
 * §R14.10's item 4). What this reader adds is the only thing a `state=open` list
 * never had to decide: the `state` word is the **whole** terminal fact a read can
 * carry, so a value outside `open` / `closed` is refused here rather than read as
 * a silent not-closed. That is what makes an unreadable answer fail the scan
 * instead of ending — or extending — tracking on a guess (AC-052, invariant 8);
 * `null` is the direction that can only fail to end tracking.
 *
 * @returns The issue with its terminal members, or `null` when the object is
 *   unrecognizable or its `state` is outside the known vocabulary.
 */
export function readIssueObject(value: unknown): PollIssue | null {
    const issue = readIssueEntry(value);

    return issue !== null && (issue.state === 'open' || issue.state === 'closed') ? issue : null;
}

/**
 * Read one **single-item** pull object — the terminal read's shape (FR-106).
 *
 * The item's own `GET /repos/{owner}/{repo}/pulls/{number}` returns the full
 * Pull Request object, which the pulls **list** (`Pull Request Simple`) is not:
 * the single object carries `merged` as a required boolean, and that is the one
 * field which tells a merged pull from one closed unmerged — the exact fact the
 * `state=open` list cannot carry at all (`research.md` §R12.2, §R12.5). The read
 * reuses {@link readPullEntry}, which already fills `merged` / `mergedAt` /
 * `state`, and applies the same `open` / `closed` refusal {@link readIssueObject}
 * does: an unusable `state` word is unreadable, not a guess (AC-052).
 *
 * @returns The pull with its terminal members, or `null` when the object is
 *   unrecognizable or its `state` is outside the known vocabulary.
 */
export function readPullObject(value: unknown): PollPull | null {
    const pull = readPullEntry(value);

    return pull !== null && (pull.state === 'open' || pull.state === 'closed') ? pull : null;
}
