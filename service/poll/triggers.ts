/**
 * One binding's feeds listed under its own switches, and every event they
 * match: M6 mentions in comments and issue bodies, M7 review requests, and
 * the M1 assignment.
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import type { BindingRecord } from '../bindings.ts';
import { actorLoginOf, isAttributableCommentAuthor } from './attribution.ts';
import { createEvent } from './events.ts';
import { commentFollowUps, headFollowUps, reviewCommentFollowUps } from './follow-up.ts';
import { mentionsLogin } from './mentions-login.ts';
import { trackedIssueEnds, trackedPullEnds, withoutEnded } from './tracking.ts';
import type { TrackingEnd } from './tracking.ts';
import { stampInWindow } from './window.ts';
import { bodyExcerptOf } from './trigger-scan.ts';
import { assignmentEvents } from './triggers-assignment.ts';
import { triggersChecks } from './triggers-checks.ts';
import { reviewCommentMentionEvents } from './review-comment-mention-events.ts';
import { reviewRequestEvents } from './triggers-review.ts';
import { reviewSubmittedEvents } from './triggers-review-submitted.ts';
import type { QueuedEvent, SubjectType } from './events.ts';
import type { PollComment, PollIssue, PollPull } from './poller-entries.ts';
import type { TriggerEvents, TriggerScanInput } from './trigger-scan.ts';
import type { IssueListOutcome, PullListOutcome } from './poller-github.ts';

/**
 * Re-exported: the token match is shared with the review-comment feed, and
 * this module stays the one import path its tests already use.
 */
export { mentionsLogin } from './mentions-login.ts';

/**
 * Decide whether one comment is a mention the binding should react to.
 */
export function isMentionComment(comment: PollComment, bindingLogin: string): boolean {
    if (!isAttributableCommentAuthor(comment.authorLogin, comment.authorType, bindingLogin)) {
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
 */
export function isIssueBodyMention(issue: PollIssue, bindingLogin: string): boolean {
    if (!isAttributableCommentAuthor(issue.authorLogin, issue.authorType, bindingLogin)) {
        return false;
    }

    return mentionsLogin(issue.body ?? '', bindingLogin);
}

/**
 * Translate one listing entry's `pull_request` marker into the subject shape
 * the run key stores.
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
        ...(issue !== null && { subjectType: subjectShapeOf(issue.isPullRequest) }),
    });
}

/**
 * Build one `mention` event per matching comment.
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
    readonly windowStart: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent[] {
    const { binding, login, comments, issues, windowStart, detectedAt } = input;
    const known = new Map(issues.map((issue) => [issue.issueNumber, issue]));
    const events: QueuedEvent[] = [];

    for (const comment of comments) {
        const isEligible = stampInWindow(comment.updatedAt, windowStart)
            && isMentionComment(comment, login);
        if (!isEligible) {
            continue;
        }

        const issue = known.get(comment.issueNumber) ?? null;
        events.push(mentionEvent({ binding, comment, issue, detectedAt }));
    }

    return events;
}

/**
 * Build one `mention` event per issue whose *body* mentions the account. The
 * body path rides the issue list the assignment branch already consumed, so
 * it adds no feed and no request to the cycle (product decision,
 * 2026-09-28): window, authorship and the bounded token match are the only
 * gates. The id's fixed `~mention~body` suffix never changes, so an edited
 * body re-detects to the same row and the queue's id dedupe absorbs it — one
 * body mention per issue per account, ever — while staying distinct from the
 * assignment id and every `~mention~<commentId>` row.
 */
function bodyMentionEvents(input: {
    /** The binding that produced the window. */
    readonly binding: BindingRecord;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    /** Issues the same scan listed. */
    readonly issues: readonly PollIssue[];
    /** Window start; `null` on a replay scan. */
    readonly windowStart: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent[] {
    const { binding, login, issues, windowStart, detectedAt } = input;
    const label = repositoryLabel(repositoryRefOf(binding.repository));
    const events: QueuedEvent[] = [];

    for (const issue of issues) {
        const isEligible = stampInWindow(issue.updatedAt, windowStart)
            && isIssueBodyMention(issue, login);
        if (!isEligible) {
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
 * including the issue-body mentions the issue list already covers (M6). The
 * same feed answers a second question — which of its rows are a **movement
 * on a work item already in progress** (002 FR-102(a)) — riding a read the
 * mention switch already pays for, so a binding with that switch off lists
 * no comments and therefore detects no comment follow-ups: the honest
 * reading of *no new read*.
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

    // The inline review comments are a **second** comment feed: GitHub serves
    // them from `pulls/comments`, not from `issues/comments`, so a mention or a
    // movement there is invisible to the read above. One repository-wide,
    // `since`-windowed call per mention-enabled binding is the whole added rate
    // cost (FR-111, NFR-003). Its failure is tolerated: the feed is
    // additive, and failing the cycle would suppress the detection the operator
    // already paid for on the conversation feed.
    const reviewed = await poller.listReviewComments({
        token,
        owner: repository.owner,
        name: repository.name,
        since: windowStart,
        pace,
    });
    if (reviewed.kind !== 'ok') {
        input.log.warn('review-comment feed could not be listed; this cycle detects none', {
            failure: reviewed.kind,
        });
    }

    const reviewComments = reviewed.kind === 'ok' ? reviewed.comments : [];

    const events = [
        // The issue-body path needs no feed of its own: the cycle lists issues
        // whenever the assignment *or* the mention switch is on.
        ...bodyMentionEvents({ binding, login, issues, windowStart, detectedAt }),
        ...mentionEvents({ binding, login, comments: listed.comments, issues, windowStart, detectedAt }),
        ...reviewCommentMentionEvents({
            binding,
            login,
            comments: reviewComments,
            windowStart,
            detectedAt,
        }),
        ...commentFollowUps({
            binding,
            comments: listed.comments,
            issues,
            tracked: input.tracked,
            windowStart,
            detectedAt,
        }),
        ...reviewCommentFollowUps({
            binding,
            comments: reviewComments,
            tracked: input.tracked,
            windowStart,
            detectedAt,
        }),
    ];

    return { ok: true, events };
}

/**
 * List the issues this binding's assignment or mention switch needs.
 *
 * A binding with both off lists nothing, so the rate budget only ever pays for
 * triggers the operator turned on — and the empty answer is a legitimate
 * `kind: 'ok'`, not a failure.
 */
async function listedIssues(input: {
    readonly poller: TriggerScanInput['poller'];
    readonly token: string;
    readonly repository: { readonly owner: string; readonly name: string };
    readonly windowStart: string;
    readonly pace: TriggerScanInput['pace'];
    readonly binding: BindingRecord;
}): Promise<IssueListOutcome> {
    const { poller, token, repository, windowStart, pace, binding } = input;
    if (!binding.triggers.assignment && !binding.triggers.mention) {
        return { kind: 'ok', issues: [] };
    }

    return await poller.listOpenIssues({
        token,
        owner: repository.owner,
        name: repository.name,
        since: windowStart,
        pace,
    });
}

/**
 * List the open pull requests when any of the three pull-dependent switches is
 * on; all three off lists nothing.
 *
 * One read serves review requests, review submissions and head movements, so a
 * cycle never lists pulls twice. A `checks`-only binding pays this read
 * because observing a movement is what its detection requires (FR-130).
 */
function pullsNeeded(binding: BindingRecord): boolean {
    return binding.triggers.reviewRequest || binding.triggers.reviewSubmitted || binding.triggers.checks;
}

async function listedPulls(input: {
    readonly poller: TriggerScanInput['poller'];
    readonly token: string;
    readonly repository: { readonly owner: string; readonly name: string };
    readonly pace: TriggerScanInput['pace'];
    readonly binding: BindingRecord;
}): Promise<PullListOutcome> {
    const { poller, token, repository, pace, binding } = input;
    if (!pullsNeeded(binding)) {
        return { kind: 'ok', pulls: [] };
    }

    return await poller.listOpenPulls({
        token,
        owner: repository.owner,
        name: repository.name,
        pace,
    });
}

/**
 * The pull-dependent branches over the cycle's one pulls read, in fixed order:
 * review requests, review submissions, head rows, check rows.
 *
 * Each arm is skipped when its own switch is off: a `reviewSubmitted`-only
 * binding runs no review-request arm, so it makes no `issues/{n}/events` read
 * and emits no `~review` trigger; head rows stay gated on `reviewRequest`, so
 * the shared read widens what is observed, never what is delivered (FR-130).
 * `observedHeads` and `ends` are reported whenever the read ran.
 */
async function pullEventsOf(input: {
    readonly scan: TriggerScanInput;
    readonly pulls: readonly PollPull[];
}): Promise<TriggerEvents> {
    const { scan, pulls } = input;
    const { binding } = scan;
    const events: QueuedEvent[] = [];

    const pullEnds = trackedPullEnds({ binding, pulls, tracked: scan.tracked });
    const tracked = withoutEnded(scan.tracked, pullEnds);
    // Computed once, before any actor gate: a checks-only binding still needs
    // the movement's new SHA even when no head row can be delivered.
    const heads = headFollowUps({
        binding,
        pulls,
        tracked,
        windowStart: scan.windowStart,
        detectedAt: scan.detectedAt,
    });

    if (binding.triggers.reviewRequest) {
        const requests = await reviewRequestEvents({ ...scan, tracked, pulls });
        if (!requests.ok) {
            return requests;
        }

        events.push(...requests.events);
    }

    if (binding.triggers.reviewSubmitted) {
        const submitted = await reviewSubmittedEvents({ ...scan, tracked, pulls });
        if (!submitted.ok) {
            return submitted;
        }

        events.push(...submitted.events);
    }

    if (binding.triggers.reviewRequest) {
        events.push(...heads.rows);
    }

    if (binding.triggers.checks) {
        const checks = await triggersChecks({ ...scan, tracked, pulls, movements: heads.movements });
        if (!checks.ok) {
            return checks;
        }

        events.push(...checks.events);
    }

    return {
        ok: true,
        events,
        observedHeads: new Map(heads.observations.flatMap((observation) =>
            observation.headSha === null ? [] : [[observation.pullNumber, observation.headSha]])),
        ...(pullEnds.length > 0 && { ends: pullEnds }),
    };
}

/**
 * Run the branches the binding's switches ask for, in the queue's fixed order.
 *
 * Branch order is also the **event** order the queue sees: assignment, then the
 * two mention kinds, then the pull-dependent rows. It is not load-bearing for
 * any rule, and it is fixed rather than incidental so a suite can assert it.
 */
async function triggerBranches(input: {
    readonly scan: TriggerScanInput;
    readonly issues: readonly PollIssue[];
    readonly pulls: readonly PollPull[];
}): Promise<readonly TriggerEvents[]> {
    const { scan, issues, pulls } = input;
    const branches: TriggerEvents[] = [];

    if (scan.binding.triggers.assignment) {
        branches.push(await assignmentEvents({ ...scan, issues }));
    }

    if (scan.binding.triggers.mention) {
        branches.push(await mentionEventsOf({ ...scan, issues }));
    }

    if (pullsNeeded(scan.binding)) {
        branches.push(await pullEventsOf({ scan, pulls }));
    }

    return branches;
}

/**
 * List the feeds this binding's switches ask for and collect every event
 * they match. A switch that is off lists nothing — the rate budget only
 * ever pays for triggers the operator turned on — and the first failure ends
 * the whole scan, a failed per-item events read included, treated exactly
 * like a failed list call (see `poller-events.ts`'s
 * `resolveCandidateActor`). The issue-list read is also where the end of
 * tracking for a tracked issue is observed (002 FR-106), since both feeds
 * the scan reads are `state=open`.
 */
export async function collectTriggerEvents(input: TriggerScanInput): Promise<TriggerEvents> {
    const { binding, poller, token, windowStart, pace } = input;
    const repository = repositoryRefOf(binding.repository);
    const issues = await listedIssues({ poller, token, repository, windowStart, pace, binding });
    if (issues.kind !== 'ok') {
        return { ok: false, failure: issues };
    }

    const pulls = await listedPulls({ poller, token, repository, pace, binding });
    if (pulls.kind !== 'ok') {
        return { ok: false, failure: pulls };
    }

    const ends: TrackingEnd[] = [...trackedIssueEnds({
        binding,
        issues: issues.issues,
        tracked: input.tracked,
    })];
    // The end of tracking stops new detection on the subjects it names, so the
    // branches below see the view without them: a comment that arrived in the
    // same cycle as the item's conclusion is not a follow-up (FR-106).
    const tracked = withoutEnded(input.tracked, ends);
    const events: QueuedEvent[] = [];
    let observedHeads: ReadonlyMap<number, string> | undefined;

    const branches = await triggerBranches({ scan: { ...input, tracked }, issues: issues.issues, pulls: pulls.pulls });
    for (const branch of branches) {
        if (!branch.ok) {
            return branch;
        }

        events.push(...branch.events);
        observedHeads = branch.observedHeads ?? observedHeads;
        if (branch.ends !== undefined) {
            ends.push(...branch.ends);
        }
    }

    return {
        ok: true,
        events,
        ...(observedHeads !== undefined && { observedHeads }),
        ...(ends.length > 0 && { ends }),
    };
}
