/**
 * Entry normalization for the poller's list feeds, reviews and check runs,
 * split out of `poller-github.ts` so each module stays inside the file-length
 * gate.
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
    readonly issueNumber: number;
    /** Issue title; untrusted source text. */
    readonly title: string;
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
 * Minimal pull-request **review-comment** shape the poller normalizes (011).
 *
 * A review comment is GitHub's inline, code-anchored comment on a pull
 * request, served by `GET /repos/{owner}/{repo}/pulls/comments` — a different
 * feed from the conversation comments `issues/comments` answers. It carries
 * the pull request's number on `pull_request_url`, the same way an issue
 * comment carries its item on `issue_url`.
 */
export interface PollReviewComment {
    /** Comment id; stable across scans, so it keys a deduplicating event id. */
    readonly commentId: number;
    /** Pull-request number, read from the comment's `pull_request_url`. */
    readonly pullNumber: number;
    /** Comment body; untrusted source text. */
    readonly body: string;
    /** Login of the comment's author. */
    readonly authorLogin: string;
    /** Author type (`User`, `Bot`, `Organization`, …); `''` when absent. */
    readonly authorType: string;
    /** RFC 3339 `updated_at` stamp, or `null` when GitHub sent none. */
    readonly updatedAt: string | null;
}

/**
 * Minimal pull-request shape the poller normalizes (M7): who is asked to
 * review, who authored it, and the head/base coordinates the event carries.
 *
 * The author is read here as a **fact of authorship** for the own-pull
 * candidate set (FR-120), not as the attribution proxy research §R8 retired
 * for review requests — the two questions are different, and the requester is
 * still read from the naming event alone.
 */
export interface PollPull {
    /** Pull-request number within the repository. */
    readonly pullNumber: number;
    /** PR title; untrusted source text. */
    readonly title: string;
    readonly url: string;
    /** PR state (`open`/`closed`). */
    readonly state: string;
    /** Login of the pull request's author, or `''` when GitHub sent no `user`. */
    readonly authorLogin: string;
    /** Author type (`User`, `Bot`, `Organization`, …); `''` when absent. */
    readonly authorType: string;
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

/** Minimal pull-request review shape the poller normalizes (FR-120 – FR-124). */
export interface PollReview {
    /** Review id; stable across scans, so it keys the deduplicating event id. */
    readonly reviewId: number;
    /** GitHub's review state word; only `CHANGES_REQUESTED` produces a row. */
    readonly state: string;
    /** `submitted_at`, or `null` for a `PENDING` review GitHub has not dated. */
    readonly submittedAt: string | null;
    /** Login of the reviewer, or `''` when GitHub sent no `user`. */
    readonly authorLogin: string;
    /** Reviewer type (`User`, `Bot`, …); `''` when absent. */
    readonly authorType: string;
}

/** Minimal check-run shape the poller normalizes (FR-126 – FR-127). */
export interface PollCheckRun {
    /** Check name; required, because it is what the follow-up names. */
    readonly name: string;
    /** GitHub's conclusion word, or `null` while the run has not concluded. */
    readonly conclusion: string | null;
}

/**
 * Narrow a value to a record.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}

/**
 * Read one positive integer field.
 */
function positiveIntOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Read one string field.
 */
function textOf(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' ? value : null;
}

/**
 * Read a list of logins out of one list field.
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
 */
function authorLoginOf(user: Record<string, unknown> | null): string {
    return user === null ? '' : (textOf(user, 'login') ?? '');
}

/**
 * Read one entry author's type, answering `''` when there is none.
 */
function authorTypeOf(user: Record<string, unknown> | null): string {
    return user === null ? '' : (textOf(user, 'type') ?? '');
}

/**
 * Read the issue number out of a comment's `issue_url`.
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
 * Parse one pull-request review-comments-list entry, failing soft per entry.
 *
 * The authorship rule is the comment reader's, not the issue reader's: a
 * review comment **is** the action, so an entry with no readable author is
 * dropped rather than carried as an unknown author (the mention path could
 * never attribute it, and the follow-up path must not invent one).
 */
export function readReviewCommentEntry(value: unknown): PollReviewComment | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const commentId = positiveIntOf(record.id);
    const pullNumber = issueNumberOf(record.pull_request_url);
    const body = textOf(record, 'body');
    const user = asRecord(record.user);
    const authorLogin = authorLoginOf(user);
    if (commentId === null || pullNumber === null || body === null || authorLogin === '') {
        return null;
    }

    return {
        commentId,
        pullNumber,
        body,
        authorLogin,
        authorType: authorTypeOf(user),
        updatedAt: textOf(record, 'updated_at'),
    };
}

/**
 * Parse one pulls-list entry, failing soft per entry.
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
    const user = asRecord(record.user);

    return {
        pullNumber,
        title,
        url,
        state,
        authorLogin: authorLoginOf(user),
        authorType: authorTypeOf(user),
        requestedReviewers,
        headSha: head === null ? null : textOf(head, 'sha'),
        baseRef: base === null ? null : textOf(base, 'ref'),
        merged: record.merged === true,
        mergedAt: textOf(record, 'merged_at'),
        updatedAt: textOf(record, 'updated_at'),
    };
}

/**
 * Parse one pull-request review entry, failing soft per entry.
 *
 * The author may be absent and still parses: attribution is the caller's
 * judgement, and a review GitHub will not name is refused there rather than
 * dropped here.
 */
export function readReviewEntry(value: unknown): PollReview | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const reviewId = positiveIntOf(record.id);
    const state = textOf(record, 'state');
    if (reviewId === null || state === null) {
        return null;
    }

    const user = asRecord(record.user);

    return {
        reviewId,
        state,
        submittedAt: textOf(record, 'submitted_at'),
        authorLogin: authorLoginOf(user),
        authorType: authorTypeOf(user),
    };
}

/**
 * Parse one check-run entry, failing soft per entry.
 *
 * A check with no readable name cannot be named in the follow-up, so it is
 * dropped; an unreadable conclusion is no conclusion, which is not a failure.
 */
export function readCheckRunEntry(value: unknown): PollCheckRun | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const name = textOf(record, 'name');
    if (name === null || name === '') {
        return null;
    }

    return { name, conclusion: textOf(record, 'conclusion') };
}

/**
 * Read one **single-item** issue object — the terminal read's shape (FR-106).
 * It reuses {@link readIssueEntry} for the same Issue object a list row is,
 * and adds the one thing a `state=open` list never had to decide: the `state`
 * word is the whole terminal fact a read can carry, so a value outside `open`
 * / `closed` is refused rather than read as a silent not-closed — an
 * unreadable answer fails the scan instead of ending, or extending, tracking
 * on a guess (AC-052, invariant 8).
 */
export function readIssueObject(value: unknown): PollIssue | null {
    const issue = readIssueEntry(value);

    return issue !== null && (issue.state === 'open' || issue.state === 'closed') ? issue : null;
}

/**
 * Read one **single-item** pull object — the terminal read's shape (FR-106).
 * The full Pull Request object carries `merged` as a required boolean, which
 * the pulls **list** (`Pull Request Simple`) is not — and that is the one
 * field that tells a merged pull from one closed unmerged, the exact fact a
 * `state=open` list cannot carry at all (research §R12.2, §R12.5). It reuses
 * {@link readPullEntry} and the same `open` / `closed` refusal: an unusable
 * `state` word is unreadable, not a guess (AC-052).
 */
export function readPullObject(value: unknown): PollPull | null {
    const pull = readPullEntry(value);

    return pull !== null && (pull.state === 'open' || pull.state === 'closed') ? pull : null;
}
