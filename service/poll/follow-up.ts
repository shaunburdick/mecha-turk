/**
 * The two follow-up detectors, and the rows they build (002 FR-102, FR-103).
 *
 * A follow-up is **not a trigger** and adds no trigger kind: it is a movement
 * observed on a subject whose run already carries a recorded session, detected
 * from a feed the scan already read for some other purpose. Two kinds are
 * detected and the two are the whole of the slice:
 *
 * - a **comment** on a tracked subject, read from the repository-wide
 *   issue-comments list the mention trigger already pays for, matched to its
 *   issue by the row's own `issue_url` (`research.md` §R12.1);
 * - a **head-SHA change** on a tracked pull request, read from the pulls list
 *   the review-request trigger already pays for, compared against the run's
 *   seed.
 *
 * Neither adds a request, an endpoint, or a page walk, which is the whole of
 * FR-102's cost claim and why NFR-003 is not amended.
 *
 * **The author judgement is the existing one.** A comment follow-up applies
 * `isAttributableAuthor` / `isBotAuthor` — the same predicate the mention
 * trigger already applies to every kind — so a bot-authored or unattributed
 * comment yields no follow-up (FR-016). It is called by a branch that did not
 * call it before, not re-spelled beside one that did.
 *
 * **At most one head follow-up per subject per cycle.** The pulls list carries
 * one row per pull request, so one row produces at most one follow-up; where
 * two pushes land between two cycles, only the final observed SHA is visible,
 * the intermediate one is not fetched, is not promised, and is not audited as
 * a gap (FR-102).
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import type { BindingRecord } from '../bindings.ts';
import { actorLoginOf, isAttributableAuthor } from './attribution.ts';
import { createEvent } from './events.ts';
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
 *
 * @returns The row, or `null` when the tracked subject names no actor this row
 *   may carry.
 */
function commentFollowUp(input: {
    /** The binding being scanned. */
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
 *
 * @returns The row, or `null` when the tracked subject's actor cannot be
 *   carried honestly.
 */
function headFollowUp(input: {
    /** The binding being scanned. */
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
 * Detect the comment follow-ups in one cycle's comment feed.
 *
 * Every gate is one the mention path already applies, in the order it applies
 * them: the scan window, then the attribution predicate, then the
 * tracked-subject lookup. A comment that mentions nothing is still a movement
 * on a tracked item — that is the whole point — so the mention-token match is
 * deliberately **not** a gate here, and the author judgement is the only one
 * this branch adds.
 *
 * @returns The rows, in comment order.
 */
export function commentFollowUps(input: {
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** Comments the cycle's own comment feed listed. */
    readonly comments: readonly PollComment[];
    /** Issues the same scan listed, for title and URL resolution. */
    readonly issues: readonly PollIssue[];
    /** Subjects this binding and account is following. */
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
 * Detect the head follow-ups in one cycle's pulls feed, and report every head
 * it observed.
 *
 * Two answers at once, because they are one read: a movement produces a row,
 * and **every** observed head is reported so the run that has no seed yet can
 * record one (FR-103(b)). A run with no seed compares nothing and emits
 * nothing — its establishing cycle — and a track whose row carries no SHA at
 * all produces neither.
 *
 * @returns The rows, and the observed heads.
 */
export function headFollowUps(input: {
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** Pull requests the cycle's own pulls feed listed. */
    readonly pulls: readonly PollPull[];
    /** Subjects this binding and account is following. */
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
