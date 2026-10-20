/**
 * The review-submitted detector: a changes-requested review on the account's
 * own open pull request (FR-120 – FR-124).
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import { actorLoginOf, isAttributableAuthor } from './attribution.ts';
import { createEvent } from './events.ts';
import { reviewSubmittedFollowUp } from './follow-up.ts';
import { stampInWindow } from './window.ts';
import type { QueuedEvent } from './events.ts';
import type { PollPull, PollReview } from './poller-entries.ts';
import type { TrackedSubject } from './tracking.ts';
import type { TriggerEvents, TriggerScanInput } from './trigger-scan.ts';

/**
 * Whether one open pull request is a subject this account authored.
 *
 * Case-insensitive, and an empty login on either side matches nothing: a pull
 * GitHub sent no author for cannot prove ownership.
 */
export function isOwnPullCandidate(pull: PollPull, bindingLogin: string): boolean {
    if (bindingLogin === '' || pull.authorLogin === '') {
        return false;
    }

    return pull.authorLogin.toLowerCase() === bindingLogin.toLowerCase();
}

/**
 * Whether one review is the changes-requested submission this detection wants:
 * exact state, a readable in-window stamp, an attributable author, and no
 * self-review.
 */
export function isSubmittedReview(review: PollReview, bindingLogin: string, windowStart: string): boolean {
    if (review.state !== 'CHANGES_REQUESTED' || review.submittedAt === null) {
        return false;
    }

    const submitted = Date.parse(review.submittedAt);
    const start = Date.parse(windowStart);
    if (!Number.isFinite(submitted)
        || !Number.isFinite(start)
        || submitted < start
        || !isAttributableAuthor(review.authorLogin, review.authorType)) {
        return false;
    }

    return review.authorLogin.toLowerCase() !== bindingLogin.toLowerCase();
}

/**
 * The tracked pull request when the review is strictly newer than the reference
 * that established the run; `null` when untracked, a tracked issue, or not
 * proven newer. An absent or unreadable stamp is never proven newer.
 */
function newerTrackedPull(input: {
    readonly tracked: TrackedSubject | undefined;
    readonly submittedAt: string | null;
}): TrackedSubject | null {
    const subject = input.tracked;
    if (subject?.subjectType !== 'pull_request' || input.submittedAt === null) {
        return null;
    }

    const submitted = Date.parse(input.submittedAt);
    const established = Date.parse(subject.establishedAt ?? '');
    if (!Number.isFinite(submitted) || !Number.isFinite(established) || submitted <= established) {
        return null;
    }

    return subject;
}

/**
 * Build one `~review~submitted~<reviewId>` trigger for an own pull with no
 * tracked run (or one whose review is not provably newer).
 */
function submittedTrigger(input: {
    readonly binding: TriggerScanInput['binding'];
    readonly pull: PollPull;
    readonly review: PollReview;
    readonly detectedAt: string;
}): QueuedEvent {
    const { binding, pull, review, detectedAt } = input;
    const reviewer = actorLoginOf(review.authorLogin);

    return createEvent({
        bindingId: binding.bindingId,
        repository: repositoryLabel(repositoryRefOf(binding.repository)),
        accountNumericUserId: binding.accountNumericUserId,
        accountLogin: binding.accountLogin,
        projectId: binding.projectId,
        worktreeOption: binding.worktreeOption,
        kind: 'review',
        reviewId: review.reviewId,
        headSha: pull.headSha,
        baseRef: pull.baseRef,
        issue: {
            issueNumber: pull.pullNumber,
            issueTitle: pull.title,
            issueUrl: pull.url,
            issueBodyExcerpt: '',
        },
        actorLogin: reviewer,
        actorAttribution: 'direct',
        triggerNote: `Review changes requested by ${reviewer} on pull request #${pull.pullNumber}`,
        detectedAt,
        subjectType: 'pull_request',
    });
}

/**
 * Read each own open pull request's reviews once and collect the rows.
 *
 * A failed reviews read ends the branch with its class (FR-132); a truncated
 * read is recorded with the pull number and produces no row. The allow-list is
 * deliberately not applied: policy is judged once, at dispatch (FR-123).
 */
export async function reviewSubmittedEvents(
    input: TriggerScanInput & { readonly pulls: readonly PollPull[] },
): Promise<TriggerEvents> {
    const { binding, poller, token, login, windowStart, detectedAt, pace, pulls } = input;
    const repository = repositoryRefOf(binding.repository);
    const events: QueuedEvent[] = [];

    for (const pull of pulls) {
        if (!stampInWindow(pull.updatedAt, windowStart) || !isOwnPullCandidate(pull, login)) {
            continue;
        }

        const listed = await poller.listPullReviews({
            token,
            owner: repository.owner,
            name: repository.name,
            pullNumber: pull.pullNumber,
            windowStart,
            pace,
        });
        if (listed.kind !== 'ok') {
            return { ok: false, failure: listed };
        }

        if (listed.truncated) {
            input.log.warn('review feed truncated; this pull request produces nothing this cycle', {
                pullNumber: pull.pullNumber,
            });
            continue;
        }

        for (const review of listed.reviews) {
            if (!isSubmittedReview(review, login, windowStart)) {
                continue;
            }

            const tracked = newerTrackedPull({
                tracked: input.tracked.get(pull.pullNumber),
                submittedAt: review.submittedAt,
            });
            events.push(tracked === null
                ? submittedTrigger({ binding, pull, review, detectedAt })
                : reviewSubmittedFollowUp({ binding, pull, tracked, review, detectedAt }));
        }
    }

    return { ok: true, events };
}
