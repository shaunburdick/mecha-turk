/**
 * The Slice-2 trigger detectors: M6's mentions (in comments and in issue
 * bodies, the latter a product decision of 2026-09-28) and M7's review
 * requests, plus the two detection helpers the assignment scan shares with
 * them (`updatedInWindow`, `bodyExcerptOf`).
 *
 * One binding's scan lists the feeds its switches ask for — issue comments
 * when `triggers.mention` is on, open pull requests when
 * `triggers.reviewRequest` is on — under the same credential, window, and
 * page cap the issue list already uses, then turns each match into the same
 * {@link QueuedEvent} rows the assignment trigger writes. The issue-body
 * mention needs no extra feed: it reads the issue list the assignment scan
 * already fetched. The loop keeps the orchestration (account, window,
 * enqueue, audit); everything specific to *what a comment, an issue body, or
 * a pull request means* lives here, so `loop.ts` stays inside the file-length
 * gate.
 *
 * Detection posture, in one place:
 *
 * - a mention is `@<login>` in the comment body *or* the issue body, matched
 *   case-insensitively and bounded on both sides so `@octocat` cannot match
 *   inside `@octocat-mt`;
 * - text authored by bots is ignored — a bot mentioning the account is
 *   noise, and bots mention each other for a living — and an entry with no
 *   readable author is refused rather than dispatched;
 * - a review request is a pull request whose `requested_reviewers` names
 *   the bound account, case-insensitively;
 * - every match still has to fall inside the scan window, exactly like an
 *   assignment (a replay scan has no window, so a first scan sees
 *   everything the feed returns).
 */

import { repositoryLabel } from '../../src/config.ts';
import type { RepositoryRef } from '../../src/config.ts';
import type { BindingRecord } from '../bindings.ts';
import { createEvent } from './events.ts';
import type { QueuedEvent } from './events.ts';
import type { GitHubIssuePoller, PollComment, PollFailure, PollIssue, PollPull } from './poller-github.ts';

/** Longest body excerpt one event carries (bounded untrusted text). */
const BODY_EXCERPT_MAX_CHARS = 600;

/** Longest author login a trigger note carries (bounded upstream text). */
const AUTHOR_LOGIN_MAX_CHARS = 60;

/** What one binding's trigger scan produced. */
export type TriggerEvents =
    | { readonly ok: true; readonly events: readonly QueuedEvent[] }
    | { readonly ok: false; readonly failure: PollFailure };

/**
 * The repository reference behind a binding's validated `owner/name` label.
 *
 * @param binding - Binding whose repository is scanned.
 * @returns The owner/name reference.
 */
export function repositoryRefOf(binding: BindingRecord): RepositoryRef {
    const index = binding.repository.indexOf('/');
    if (index < 0) {
        return { owner: binding.repository, name: '' };
    }

    return { owner: binding.repository.slice(0, index), name: binding.repository.slice(index + 1) };
}

/**
 * Decide whether an item falls inside the scan window.
 *
 * With no window (`windowStart === null` — the first scan, and any replay
 * after a recovery reset) every listed item is in-window: the replay's
 * contract is that everything open matching the trigger enqueues, whether or
 * not the item can report its own freshness (product decision,
 * 2026-09-28). With a window, an item that cannot report its own freshness
 * is never in-window: a feed entry without a date cannot honestly claim to
 * be new.
 *
 * @param updatedAt - GitHub `updated_at` stamp, or `null`.
 * @param windowStart - Window start stamp, or `null` for a replay scan.
 * @returns `true` when in-window — always, when there is no window.
 */
export function updatedInWindow(updatedAt: string | null, windowStart: string | null): boolean {
    if (windowStart === null) {
        return true;
    }

    if (updatedAt === null) {
        return false;
    }

    const stamp = Date.parse(updatedAt);
    const start = Date.parse(windowStart);

    return !Number.isNaN(stamp) && !Number.isNaN(start) && stamp >= start;
}

/**
 * Slice untrusted source text to the excerpt one event can carry.
 *
 * @param body - Raw issue or comment body, or `null` when GitHub sent none.
 * @returns The excerpt, or `''` when there was no body.
 */
export function bodyExcerptOf(body: string | null): string {
    if (body === null) {
        return '';
    }

    if (body.length <= BODY_EXCERPT_MAX_CHARS) {
        return body;
    }

    return `${body.slice(0, BODY_EXCERPT_MAX_CHARS - 1)}…`;
}

/**
 * Decide whether one character belongs to GitHub's username alphabet.
 *
 * @param character - One character (or `''` at an edge of the text).
 * @returns `true` when the character could be part of a login.
 */
function isLoginCharacter(character: string): boolean {
    return /^[A-Za-z0-9_-]$/.test(character);
}

/**
 * Decide whether a body of text carries the bound account's mention token.
 *
 * The token is `@<login>`, matched case-insensitively and bounded on both
 * sides by GitHub's username alphabet (`A-Za-z0-9_-`), so `@octocat-mt`
 * neither matches inside `@octocat-mt2` nor inside `x@octocat-mt`. The scan
 * is written out rather than compiled from the login, so no untrusted string
 * ever reaches a regular-expression engine.
 *
 * @param body - Comment or issue body; untrusted source text.
 * @param login - The bound account's login.
 * @returns `true` when the body mentions that account.
 */
export function mentionsLogin(body: string, login: string): boolean {
    if (login === '') {
        return false;
    }

    const haystack = body.toLowerCase();
    const token = `@${login.toLowerCase()}`;
    let from = haystack.indexOf(token);
    while (from !== -1) {
        const before = from === 0 ? '' : haystack.charAt(from - 1);
        const after = haystack.charAt(from + token.length);
        if (!isLoginCharacter(before) && !isLoginCharacter(after)) {
            return true;
        }

        from = haystack.indexOf(token, from + 1);
    }

    return false;
}

/**
 * Decide whether an author is a bot.
 *
 * GitHub marks its own accounts with a `[bot]` login suffix and reports
 * `type: 'Bot'` for the rest; either signal is enough.
 *
 * @param authorLogin - Author's login.
 * @param authorType - Author type (`User`, `Bot`, …), `''` when absent.
 * @returns `true` when the author is a bot.
 */
export function isBotAuthor(authorLogin: string, authorType: string): boolean {
    return authorLogin.toLowerCase().endsWith('[bot]') || authorType.toLowerCase() === 'bot';
}

/**
 * Decide whether one author's text may trigger a mention at all.
 *
 * Bots are noise (they mention each other for a living), and an author
 * GitHub would not name (`authorLogin === ''`) is ambiguous — the comment
 * reader drops such an entry outright — so both fail closed (spec FR-016,
 * FR-024).
 *
 * @param authorLogin - Author's login, `''` when GitHub sent no `user`.
 * @param authorType - Author type (`User`, `Bot`, …), `''` when absent.
 * @returns `true` only for a readable, non-bot author.
 */
function isMentionableAuthor(authorLogin: string, authorType: string): boolean {
    return authorLogin !== '' && !isBotAuthor(authorLogin, authorType);
}

/**
 * Decide whether one comment is a mention the binding should react to.
 *
 * @param comment - Normalized comment.
 * @param bindingLogin - The bound account's login.
 * @returns `true` when a human commented `@<login>` on this issue.
 */
export function isMentionComment(comment: PollComment, bindingLogin: string): boolean {
    if (!isMentionableAuthor(comment.authorLogin, comment.authorType)) {
        return false;
    }

    return mentionsLogin(comment.body, bindingLogin);
}

/**
 * Decide whether one issue body is a mention the binding should react to.
 *
 * Same posture as the comment path (product decision, 2026-09-28: an
 * `@<login>` in an issue body means the same thing as one in a comment):
 * bot-authored and unreadable-author text never triggers, and the token
 * match is the same bounded, case-insensitive one.
 *
 * @param issue - Normalized issue.
 * @param bindingLogin - The bound account's login.
 * @returns `true` when a human opened this issue with `@<login>` in its body.
 */
export function isIssueBodyMention(issue: PollIssue, bindingLogin: string): boolean {
    if (!isMentionableAuthor(issue.authorLogin, issue.authorType)) {
        return false;
    }

    return mentionsLogin(issue.body ?? '', bindingLogin);
}

/**
 * Decide whether one pull request asked the bound account to review it.
 *
 * @param pull - Normalized pull request.
 * @param bindingLogin - The bound account's login.
 * @returns `true` when that account is one of the requested reviewers.
 */
export function isReviewRequestPull(pull: PollPull, bindingLogin: string): boolean {
    if (bindingLogin === '') {
        return false;
    }

    const wanted = bindingLogin.toLowerCase();

    return pull.requestedReviewers.some((candidate) => candidate.toLowerCase() === wanted);
}

/**
 * Build one `mention` event from a comment that already matched.
 *
 * The issue's title and URL are resolved from the issue list the same scan
 * already read; a comment on an issue that list did not carry (closed, or
 * past the page cap) still gets an honest fallback: the issue number the
 * comment reports and a URL assembled from the bound repository.
 *
 * @param input - The binding, the matched comment, the issue its number
 *   resolved to (or `null`), and the detection stamp.
 * @returns The event, in `pending` state.
 */
function mentionEvent(input: {
    /** The binding that produced the window. */
    readonly binding: BindingRecord;
    /** The comment that mentioned the account. */
    readonly comment: PollComment;
    /** The issue the same scan listed, when it carried one. */
    readonly issue: PollIssue | null;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent {
    const { binding, comment, issue, detectedAt } = input;
    const repository = repositoryRefOf(binding);
    const commenter = comment.authorLogin.slice(0, AUTHOR_LOGIN_MAX_CHARS);
    const fallbackUrl = `https://github.com/${repository.owner}/${repository.name}/issues/${comment.issueNumber}`;

    return createEvent({
        bindingId: binding.bindingId,
        repository: repositoryLabel(repository),
        accountNumericUserId: binding.accountNumericUserId,
        accountLogin: binding.accountLogin,
        projectId: binding.projectId,
        worktreeOption: binding.worktreeOption,
        kind: 'mention',
        origin: 'comment',
        commentId: comment.commentId,
        issue: {
            issueNumber: comment.issueNumber,
            issueTitle: issue?.title ?? `Issue #${comment.issueNumber}`,
            issueUrl: issue?.url ?? fallbackUrl,
            issueBodyExcerpt: bodyExcerptOf(comment.body),
        },
        triggerNote: `Comment by ${commenter} on issue #${comment.issueNumber} mentioned the bound account`,
        detectedAt,
    });
}

/**
 * Build one `mention` event per matching comment.
 *
 * @param input - Binding, matches, the issue list, and the detection stamp.
 * @returns The mention events, in comment order.
 */
function mentionEvents(input: {
    /** The binding that produced the window. */
    readonly binding: BindingRecord;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    /** Comments the scan listed. */
    readonly comments: readonly PollComment[];
    /** Issues the same scan listed, for title and URL resolution. */
    readonly issues: readonly PollIssue[];
    /** Window start; `null` on a replay scan. */
    readonly windowStart: string | null;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent[] {
    const { binding, login, comments, issues, windowStart, detectedAt } = input;
    const known = new Map(issues.map((issue) => [issue.issueNumber, issue]));
    const events: QueuedEvent[] = [];

    for (const comment of comments) {
        const eligible = updatedInWindow(comment.updatedAt, windowStart)
            && isMentionComment(comment, login);
        if (!eligible) {
            continue;
        }

        const issue = known.get(comment.issueNumber) ?? null;
        events.push(mentionEvent({ binding, comment, issue, detectedAt }));
    }

    return events;
}

/**
 * Build one `mention` event per issue whose *body* mentions the account.
 *
 * The body path rides the issue list the assignment scan already fetched, so
 * it adds no feed and no request to the cycle (product decision,
 * 2026-09-28): window, authorship, and the bounded token match are the only
 * gates. The id's fixed `~mention~body` suffix never changes, so an edited
 * body re-detects to the same row and the queue's id dedupe absorbs it — one
 * body mention per issue per account, ever — while staying distinct from the
 * assignment id and from every `~mention~<commentId>` row.
 *
 * @param input - Binding, the bound login, the issues, and the stamps.
 * @returns The mention events, in issue order.
 */
function bodyMentionEvents(input: {
    /** The binding that produced the window. */
    readonly binding: BindingRecord;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    /** Issues the same scan listed. */
    readonly issues: readonly PollIssue[];
    /** Window start; `null` on a replay scan. */
    readonly windowStart: string | null;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent[] {
    const { binding, login, issues, windowStart, detectedAt } = input;
    const label = repositoryLabel(repositoryRefOf(binding));
    const events: QueuedEvent[] = [];

    for (const issue of issues) {
        const eligible = updatedInWindow(issue.updatedAt, windowStart)
            && isIssueBodyMention(issue, login);
        if (!eligible) {
            continue;
        }

        events.push(
            createEvent({
                bindingId: binding.bindingId,
                repository: label,
                accountNumericUserId: binding.accountNumericUserId,
                accountLogin: binding.accountLogin,
                projectId: binding.projectId,
                worktreeOption: binding.worktreeOption,
                kind: 'mention',
                origin: 'body',
                issue: {
                    issueNumber: issue.issueNumber,
                    issueTitle: issue.title,
                    issueUrl: issue.url,
                    issueBodyExcerpt: bodyExcerptOf(issue.body),
                },
                triggerNote: 'mentioned in issue body',
                detectedAt,
            }),
        );
    }

    return events;
}

/**
 * Build one `review` event per pull request that asked for the account.
 *
 * @param input - Binding, matches, and the detection stamp.
 * @returns The review events, in pull-request order.
 */
function reviewEvents(input: {
    /** The binding that produced the window. */
    readonly binding: BindingRecord;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    /** Pull requests the scan listed. */
    readonly pulls: readonly PollPull[];
    /** Window start; `null` on a replay scan. */
    readonly windowStart: string | null;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent[] {
    const { binding, login, pulls, windowStart, detectedAt } = input;
    const label = repositoryLabel(repositoryRefOf(binding));
    const events: QueuedEvent[] = [];

    for (const pull of pulls) {
        const eligible = updatedInWindow(pull.updatedAt, windowStart)
            && isReviewRequestPull(pull, login);
        if (!eligible) {
            continue;
        }

        events.push(
            createEvent({
                bindingId: binding.bindingId,
                repository: label,
                accountNumericUserId: binding.accountNumericUserId,
                accountLogin: binding.accountLogin,
                projectId: binding.projectId,
                worktreeOption: binding.worktreeOption,
                kind: 'review',
                headSha: pull.headSha,
                baseRef: pull.baseRef,
                issue: {
                    issueNumber: pull.pullNumber,
                    issueTitle: pull.title,
                    issueUrl: pull.url,
                    issueBodyExcerpt: '',
                },
                triggerNote: `Pull request #${pull.pullNumber} requested the bound account's review`,
                detectedAt,
            }),
        );
    }

    return events;
}

/**
 * List the feeds this binding's Slice-2 switches ask for and collect their
 * events.
 *
 * A binding with neither switch on is a no-op (the loop still walks it so
 * the scan state stays honest), and neither list call is ever made — the
 * rate budget only ever pays for triggers the operator turned on. The
 * issue-body mention rides the issue list the loop already fetched, so it
 * adds no request of its own.
 *
 * @param input - Poller, credential, binding, window, and the issue list.
 * @returns The events, or the first list failure's class for the loop's skip.
 */
export async function collectTriggerEvents(input: {
    /** Poller the feeds are listed through. */
    readonly poller: GitHubIssuePoller;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    /** Window start; `null` opens an unbounded (replay) listing. */
    readonly windowStart: string | null;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
    /** Issues the same scan listed: the body-mention scan and title lookup. */
    readonly issues: readonly PollIssue[];
}): Promise<TriggerEvents> {
    const { poller, token, binding, login, windowStart, detectedAt, issues } = input;
    const repository = repositoryRefOf(binding);
    const events: QueuedEvent[] = [];

    if (binding.triggers.mention === true) {
        // The issue-body path needs no feed of its own: the loop lists issues
        // whenever the assignment *or* the mention switch is on.
        events.push(...bodyMentionEvents({ binding, login, issues, windowStart, detectedAt }));

        const listed = await poller.listIssueComments({
            token,
            owner: repository.owner,
            name: repository.name,
            since: windowStart,
        });
        if (listed.kind !== 'ok') {
            return { ok: false, failure: listed };
        }

        events.push(...mentionEvents({ binding, login, comments: listed.comments, issues, windowStart, detectedAt }));
    }

    if (binding.triggers.reviewRequest === true) {
        const listed = await poller.listOpenPulls({
            token,
            owner: repository.owner,
            name: repository.name,
        });
        if (listed.kind !== 'ok') {
            return { ok: false, failure: listed };
        }

        events.push(...reviewEvents({ binding, login, pulls: listed.pulls, windowStart, detectedAt }));
    }

    return { ok: true, events };
}
