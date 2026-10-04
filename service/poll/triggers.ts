/**
 * The Slice-2 trigger scan: one binding's feeds listed under its own switches,
 * and every event they match (M6's mentions in comments and issue bodies, M7's
 * review requests, and the M1 assignment).
 *
 * This module is the **coordinator** of a scan's four branches and the home of
 * the mention detectors, which need no feed of their own beyond the two the cycle
 * already lists. The other two branches live beside it —
 * [`triggers-assignment.ts`](./triggers-assignment.ts) and
 * [`triggers-review.ts`](./triggers-review.ts) — because each is a two-stage
 * trigger whose *detection* comes from a list feed and whose *actor* comes from
 * that item's own event list (002 FR-049), and that pairing deserves its own file
 * rather than a corner of the coordinator. The shape all three take is
 * `trigger-scan.ts`'s.
 *
 * Detection posture, in one place:
 *
 * - a mention is `@<login>` in the comment body *or* the issue body, matched
 *   case-insensitively and bounded on both sides so `@octocat` cannot match
 *   inside `@octocat-mt`;
 * - text authored by bots is ignored — a bot mentioning the account is noise,
 *   and bots mention each other for a living — and an entry with no readable
 *   author is refused rather than dispatched. One exported predicate,
 *   `isAttributableAuthor`, makes that judgement for **all four** trigger kinds
 *   (002 FR-045, plan D3), and at v1.12.0 it also judges the actor the per-item
 *   events read names;
 * - every match still has to fall inside the scan window, exactly like an
 *   assignment (a replay scan has no window, so a first scan sees everything the
 *   feed returns).
 *
 * **Attribution after 002 v1.12.0.** Every row this file writes is
 * `actorAttribution: 'direct'`, for all four kinds, because GitHub names the
 * actor in every case: the author of the text for the two mention kinds, and —
 * since v1.12.0 — the `assigner` of the naming `assigned` event and the
 * `review_requester` of the naming `review_requested` event for the other two.
 * The earlier `subject-author` basis, which stood the issue or pull-request
 * author in for an actor the *list* feeds could not name, is **readable and no
 * longer produced**: rows written before the correction carry it in
 * `events.json`, and a vocabulary a stored file still holds cannot be deleted
 * without invalidating that file. Research §R8 recorded the false premise that
 * produced it, and §R8 at v1.12.0 records the correction.
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import type { BindingRecord } from '../bindings.ts';
import { actorLoginOf, isAttributableAuthor } from './attribution.ts';
import { createEvent } from './events.ts';
import { stampInWindow } from './window.ts';
import { bodyExcerptOf } from './trigger-scan.ts';
import { assignmentEvents } from './triggers-assignment.ts';
import { reviewRequestEvents } from './triggers-review.ts';
import type { QueuedEvent, SubjectType } from './events.ts';
import type { PollComment, PollIssue } from './poller-entries.ts';
import type { TriggerEvents, TriggerScanInput } from './trigger-scan.ts';

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
 * Decide whether one comment is a mention the binding should react to.
 *
 * @param comment - Normalized comment.
 * @param bindingLogin - The bound account's login.
 * @returns `true` when a human commented `@<login>` on this issue.
 */
export function isMentionComment(comment: PollComment, bindingLogin: string): boolean {
    if (!isAttributableAuthor(comment.authorLogin, comment.authorType)) {
        return false;
    }

    return mentionsLogin(comment.body, bindingLogin);
}

/**
 * Decide whether one issue body is a mention the binding should react to.
 *
 * Same posture as the comment path (product decision of 2026-09-28: an
 * `@<login>` in an issue body means the same thing as one in a comment):
 * bot-authored and unreadable-author text never triggers, and the token
 * match is the same bounded, case-insensitive one.
 *
 * @param issue - Normalized issue.
 * @param bindingLogin - The bound account's login.
 * @returns `true` when a human opened this issue with `@<login>` in its body.
 */
export function isIssueBodyMention(issue: PollIssue, bindingLogin: string): boolean {
    if (!isAttributableAuthor(issue.authorLogin, issue.authorType)) {
        return false;
    }

    return mentionsLogin(issue.body ?? '', bindingLogin);
}

/**
 * Translate one listing entry's `pull_request` marker into the subject shape
 * the run key stores.
 *
 * @param isPullRequest - Whether GitHub listed the entry as a pull request.
 * @returns The subject shape for the row this detection produces.
 */
function subjectShapeOf(isPullRequest: boolean): SubjectType {
    return isPullRequest ? 'pull_request' : 'issue';
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
    const repository = repositoryRefOf(binding.repository);
    const commenter = actorLoginOf(comment.authorLogin);
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
        // GitHub named the author of the very comment that carried the mention,
        // so this attribution is a fact rather than an inference.
        actorLogin: commenter,
        actorAttribution: 'direct',
        triggerNote: `Comment by ${commenter} on issue #${comment.issueNumber} mentioned the bound account`,
        detectedAt,
        // The comment feed answers for issues *and* pull requests; when the
        // same scan's issue list carried the item, its `pull_request` marker
        // decides the run key's subject type. When it did not (a closed item,
        // a paged-out one) the row keeps no subject type and reads as an
        // issue, exactly as an adopted row does (data-model §2.1).
        ...(issue === null ? {} : { subjectType: subjectShapeOf(issue.isPullRequest) }),
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
        const eligible = stampInWindow(comment.updatedAt, windowStart)
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
 * The body path rides the issue list the assignment branch already consumed, so
 * it adds no feed and no request to the cycle (product decision, 2026-09-28):
 * window, authorship, and the bounded token match are the only gates. The id's
 * fixed `~mention~body` suffix never changes, so an edited body re-detects to the
 * same row and the queue's id dedupe absorbs it — one body mention per issue per
 * account, ever — while staying distinct from the assignment id and from every
 * `~mention~<commentId>` row.
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
    const label = repositoryLabel(repositoryRefOf(binding.repository));
    const events: QueuedEvent[] = [];

    for (const issue of issues) {
        const eligible = stampInWindow(issue.updatedAt, windowStart)
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
                // GitHub named the author of the very issue body that carried the
                // mention, so this attribution is a fact too.
                actorLogin: actorLoginOf(issue.authorLogin),
                actorAttribution: 'direct',
                triggerNote: 'mentioned in issue body',
                detectedAt,
                subjectType: subjectShapeOf(issue.isPullRequest),
            }),
        );
    }

    return events;
}

/**
 * List the comment feed the mention switch asks for and collect its events,
 * including the issue-body mentions the issue list already covers (M6).
 *
 * @param input - The shared scan input plus the issues the cycle listed.
 * @returns The events, or the list failure that ends the scan.
 */
async function mentionEventsOf(input: TriggerScanInput & {
    /** Issues the cycle's own issue list yielded. */
    readonly issues: readonly PollIssue[];
}): Promise<TriggerEvents> {
    const { poller, token, binding, login, windowStart, detectedAt, issues, pace } = input;
    const repository = repositoryRefOf(binding.repository);
    const listed = await poller.listIssueComments({
        token,
        owner: repository.owner,
        name: repository.name,
        since: windowStart,
        pace,
    });
    if (listed.kind !== 'ok') {
        return { ok: false, failure: listed };
    }

    const events = [
        // The issue-body path needs no feed of its own: the cycle lists issues
        // whenever the assignment *or* the mention switch is on.
        ...bodyMentionEvents({ binding, login, issues, windowStart, detectedAt }),
        ...mentionEvents({ binding, login, comments: listed.comments, issues, windowStart, detectedAt }),
    ];

    return { ok: true, events };
}

/**
 * List the feeds this binding's switches ask for and collect every event they
 * match.
 *
 * A binding with no switch on is a no-op (the cycle still walks it so the scan
 * state stays honest), and no feed is listed for a trigger the operator turned
 * off — the rate budget only ever pays for triggers that are on. The issue-body
 * mention rides the issue list the assignment branch already consumes, so it
 * adds no request of its own.
 *
 * Branch order is also the **event order** the queue sees: assignment, then the
 * two mention kinds, then the review request. It is not load-bearing for any
 * rule, and it is fixed rather than incidental so a suite can assert it.
 *
 * The first failure ends the whole scan, whichever branch raised it. A failed
 * per-item events read is such a failure and is treated identically to a failed
 * list call — see `poller-events.ts`'s `resolveCandidateActor` for why, and for
 * the difference between that and a candidate that simply produced no event.
 *
 * @param input - Poller, credential, logger, binding, window, and pace.
 * @returns The events, or the first failure's class for the cycle's skip.
 */
export async function collectTriggerEvents(input: TriggerScanInput): Promise<TriggerEvents> {
    const { binding, poller, token, windowStart, pace } = input;
    const repository = repositoryRefOf(binding.repository);
    const events: QueuedEvent[] = [];

    const issues = binding.triggers.assignment || binding.triggers.mention
        ? await poller.listOpenIssues({
            token,
            owner: repository.owner,
            name: repository.name,
            since: windowStart,
            pace,
        })
        : { kind: 'ok' as const, issues: [] as readonly PollIssue[] };
    if (issues.kind !== 'ok') {
        return { ok: false, failure: issues };
    }

    if (binding.triggers.assignment) {
        const branch = await assignmentEvents({ ...input, issues: issues.issues });
        if (!branch.ok) {
            return branch;
        }

        events.push(...branch.events);
    }

    if (binding.triggers.mention) {
        const branch = await mentionEventsOf({ ...input, issues: issues.issues });
        if (!branch.ok) {
            return branch;
        }

        events.push(...branch.events);
    }

    if (binding.triggers.reviewRequest) {
        const branch = await reviewRequestEvents(input);
        if (!branch.ok) {
            return branch;
        }

        events.push(...branch.events);
    }

    return { ok: true, events };
}
