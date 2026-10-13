/**
 * The two follow-up detectors, and the rows they build (002 FR-102, FR-103).
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import type { BindingRecord } from '../bindings.ts';
import { actorLoginOf, isAttributableAuthor } from './attribution.ts';
import { createEvent, followUpKindOf, subjectTypeOf } from './events.ts';
import { bodyExcerptOf } from './trigger-scan.ts';
import { stampInWindow } from './window.ts';
import type { QueuedEvent } from './events.ts';
import type { PollComment, PollIssue, PollPull } from './poller-entries.ts';
import type { TrackedSubject } from './tracking.ts';

/** Which of the two head-SHA facts one observed pull reports. */
interface HeadObservation {
    /** The pull request the row names. */
    readonly pullNumber: number;
    /** The head SHA the row carries, or `null` when GitHub sent none. */
    readonly headSha: string | null;
}

/** What the comment detector produced: its rows, and nothing else. */
export type FollowUpRows = readonly QueuedEvent[];

/** What the head detector produced: its rows, plus every head it observed. */
export interface HeadFollowUpResult {
    /** The head follow-up rows, in pull order. */
    readonly rows: readonly QueuedEvent[];
    /** Every tracked pull observed with a SHA, for FR-103(b)'s seed write. */
    readonly observations: readonly HeadObservation[];
}

/** The note a comment follow-up carries; names the commenter and the work item. */
function commentNote(commenter: string, issueNumber: number): string {
    return `Comment by ${commenter} on issue #${issueNumber}, on a work item already in progress`;
}

/** The note a head follow-up carries; names the movement and the work item. */
function headNote(pullNumber: number, from: string, to: string): string {
    return `Pull request #${pullNumber} head moved from ${from} to ${to}, on a work item already in progress`;
}

/**
 * Build one comment follow-up row.
 *
 * The row's `kind` is `'mention'` — the feed the detection rode — and its role
 * rides the `~followup~…` discriminator, so it never claims anyone mentioned
 * the account. The `subjectType` is the **tracked subject's own**, never the
 * kind-derived fallback, which would read a head follow-up on a tracked pull as
 * an issue (FR-101).
 */
function commentFollowUp(input: {
    readonly binding: BindingRecord;
    /** The comment that is a movement on the tracked subject. */
    readonly comment: PollComment;
    /** The tracked subject the comment belongs to. */
    readonly tracked: TrackedSubject;
    /** The issue the same scan listed, for title and URL resolution. */
    readonly issue: PollIssue | null;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent | null {
    const { binding, comment, tracked, issue, detectedAt } = input;
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
        followUp: 'comment',
        commentId: comment.commentId,
        issue: {
            issueNumber: comment.issueNumber,
            issueTitle: issue?.title ?? `Issue #${comment.issueNumber}`,
            issueUrl: issue?.url ?? fallbackUrl,
            issueBodyExcerpt: bodyExcerptOf(comment.body),
        },
        // GitHub named the author of the very comment that moved the item, so
        // this attribution is a fact, exactly as a mention's is.
        actorLogin: commenter,
        actorAttribution: 'direct',
        triggerNote: commentNote(commenter, comment.issueNumber),
        detectedAt,
        subjectType: tracked.subjectType,
    });
}

/**
 * Build one head follow-up row.
 *
 * `headSha` is the SHA **observed** — the movement's `to` — and the from → to
 * pair the panel composes with is derived from the run's own history at
 * projection time, so nothing about the earlier head needs storing.
 */
function headFollowUp(input: {
    readonly binding: BindingRecord;
    /** The pull request whose head moved. */
    readonly pull: PollPull;
    /** The tracked subject the pull request is. */
    readonly tracked: TrackedSubject;
    /** The seed the movement was measured against. */
    readonly fromHeadSha: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent | null {
    const { binding, pull, tracked, fromHeadSha, detectedAt } = input;
    const actor = tracked.actorLogin;
    const attribution = tracked.actorAttribution;
    // A head movement carries no author of its own on the pulls row, so it
    // rides the work item's own attribution — and only when that attribution
    // is a **fact** GitHub recorded (`direct`). A legacy `subject-author` basis
    // has no producer (002 FR-044), so a row may not newly wear it.
    if (actor === null || attribution !== 'direct') {
        return null;
    }

    return createEvent({
        bindingId: binding.bindingId,
        repository: repositoryLabel(repositoryRefOf(binding.repository)),
        accountNumericUserId: binding.accountNumericUserId,
        accountLogin: binding.accountLogin,
        projectId: binding.projectId,
        worktreeOption: binding.worktreeOption,
        kind: 'review',
        followUp: 'head',
        headSha: pull.headSha ?? '',
        baseRef: null,
        issue: {
            issueNumber: pull.pullNumber,
            issueTitle: pull.title,
            issueUrl: pull.url,
            issueBodyExcerpt: '',
        },
        actorLogin: actor,
        actorAttribution: attribution,
        triggerNote: headNote(pull.pullNumber, fromHeadSha, pull.headSha ?? ''),
        detectedAt,
        subjectType: 'pull_request',
    });
}

/**
 * Detect the comment follow-ups in one cycle's comment feed. Every gate is
 * one the mention path already applies, in the order it applies them: the
 * scan window, then the attribution predicate, then the tracked-subject
 * lookup. A comment that mentions nothing is still a movement on a tracked
 * item, so the mention-token match is deliberately **not** a gate here and
 * the author judgement is the only one this branch adds.
 */
export function commentFollowUps(input: {
    readonly binding: BindingRecord;
    /** Comments the cycle's own comment feed listed. */
    readonly comments: readonly PollComment[];
    /** Issues the same scan listed, for title and URL resolution. */
    readonly issues: readonly PollIssue[];
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
    /** Window start; every observation must be inside it. */
    readonly windowStart: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): FollowUpRows {
    const { binding, comments, issues, tracked, windowStart, detectedAt } = input;
    const known = new Map(issues.map((issue) => [issue.issueNumber, issue]));
    const rows: QueuedEvent[] = [];

    for (const comment of comments) {
        const subject = tracked.get(comment.issueNumber);
        // Every gate is one the mention path already applies, in the order it
        // applies them: the scan window, then the attribution predicate.
        if (subject === undefined
            || !stampInWindow(comment.updatedAt, windowStart)
            || !isAttributableAuthor(comment.authorLogin, comment.authorType)) {
            continue;
        }

        const row = commentFollowUp({
            binding,
            comment,
            tracked: subject,
            issue: known.get(comment.issueNumber) ?? null,
            detectedAt,
        });
        if (row !== null) {
            rows.push(row);
        }
    }

    return rows;
}

/**
 * Detect the head follow-ups in one cycle's pulls feed, and report every
 * head it observed. Two answers at once, because they are one read: a
 * movement produces a row, and **every** observed head is reported so the
 * run with no seed yet can record one (FR-103(b)). A run with no seed
 * compares nothing and emits nothing — its establishing cycle.
 */
export function headFollowUps(input: {
    readonly binding: BindingRecord;
    /** Pull requests the cycle's own pulls feed listed. */
    readonly pulls: readonly PollPull[];
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
    /** Window start; every observation must be inside it. */
    readonly windowStart: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): HeadFollowUpResult {
    const { binding, pulls, tracked, windowStart, detectedAt } = input;
    const rows: QueuedEvent[] = [];
    const observations: HeadObservation[] = [];

    for (const pull of pulls) {
        if (!stampInWindow(pull.updatedAt, windowStart)) {
            continue;
        }

        const subject = tracked.get(pull.pullNumber);
        // No tracked subject and no observed head are both "nothing to do": the
        // first is not a movement on work in progress, and the second is not a
        // head at all.
        if (subject === undefined || pull.headSha === null) {
            continue;
        }

        observations.push({ pullNumber: pull.pullNumber, headSha: pull.headSha });

        // No seed is never a change: a run that recorded no baseline has
        // nothing to compare against, so its establishing cycle records the
        // head it observed and emits nothing (FR-103).
        const seed = subject.lastHeadSha;
        if (seed === null || seed === pull.headSha) {
            continue;
        }

        const row = headFollowUp({ binding, pull, tracked: subject, fromHeadSha: seed, detectedAt });
        if (row !== null) {
            rows.push(row);
        }
    }

    return { rows, observations };
}

/** The distinct subjects whose follow-up rows a cycle produced, split by shape. */
export interface FollowUpSubjects {
    /** Issue-subject numbers that produced at least one comment follow-up. */
    readonly issues: readonly number[];
    /** Pull-subject numbers that produced at least one follow-up of either kind. */
    readonly pulls: readonly number[];
}

/**
 * Read the distinct subjects that produced at least one follow-up row this
 * cycle, keyed by the shape their terminal read addresses. FR-106's read is
 * issued **only** for such a subject and **at most once per subject per
 * cycle**, so this is the deduplicated set the rows name rather than a sweep
 * over every tracked subject. A subject's number is unique within its
 * repository, and the row's own `subjectType` — written from the tracked
 * subject, never inferred (FR-101) — routes the read to the issue or the
 * pull single-item endpoint.
 */
export function followUpSubjects(events: readonly QueuedEvent[]): FollowUpSubjects {
    const issues: number[] = [];
    const pulls: number[] = [];

    for (const event of events) {
        if (followUpKindOf(event.id) === null) {
            continue;
        }

        const bucket = subjectTypeOf(event) === 'pull_request' ? pulls : issues;
        if (!bucket.includes(event.issueNumber)) {
            bucket.push(event.issueNumber);
        }
    }

    return { issues, pulls };
}

/**
 * Drop the follow-up rows whose subject ended tracking, leaving every trigger
 * row in place. The end is one-directional and stops **new detection** only
 * (FR-106): the terminal read, issued before the enqueue, drops the subject's
 * follow-up from this cycle's enqueue rather than retracting one the queue
 * already holds, so a follow-up queued before the end still delivers. A
 * trigger row's own fate on a concluded subject belongs to that trigger's
 * path, not to this filter.
 */
export function withoutEndedFollowUps(
    events: readonly QueuedEvent[],
    endedNumbers: ReadonlySet<number>,
): readonly QueuedEvent[] {
    if (endedNumbers.size === 0) {
        return events;
    }

    return events.filter((event) => followUpKindOf(event.id) === null || !endedNumbers.has(event.issueNumber));
}
