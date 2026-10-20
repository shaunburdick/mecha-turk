/**
 * Inline review-comment detection (011 FR-006): mentions and tracked-subject
 * movements on the pull-request review-comment feed.
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import type { BindingRecord } from '../bindings.ts';
import { actorLoginOf, isAttributableAuthor } from './attribution.ts';
import { createEvent } from './events.ts';
import { bodyExcerptOf } from './trigger-scan.ts';
import { mentionsLogin } from './mentions-login.ts';
import { stampInWindow } from './window.ts';
import type { QueuedEvent } from './events.ts';
import type { PollReviewComment } from './poller-entries.ts';

/** The issue fields every review-comment row carries, built from the comment. */
function issueFieldsOf(comment: PollReviewComment, repository: { readonly owner: string; readonly name: string }): {
    readonly issueNumber: number;
    readonly issueTitle: string;
    readonly issueUrl: string;
    readonly issueBodyExcerpt: string;
} {
    return {
        issueNumber: comment.pullNumber,
        issueTitle: `Pull request #${comment.pullNumber}`,
        issueUrl: `https://github.com/${repository.owner}/${repository.name}/pull/${comment.pullNumber}`,
        issueBodyExcerpt: bodyExcerptOf(comment.body),
    };
}

/**
 * Build one `mention` event from a review comment that mentioned the bound
 * account. The discriminator's `review` segment keeps this id distinct from a
 * conversation comment carrying the same integer id; `subjectType` is written
 * from the feed, because a review comment only exists on a pull request.
 */
function reviewCommentMentionEvent(input: {
    readonly binding: BindingRecord;
    readonly comment: PollReviewComment;
    readonly detectedAt: string;
}): QueuedEvent {
    const { binding, comment, detectedAt } = input;
    const repository = repositoryRefOf(binding.repository);
    const commenter = actorLoginOf(comment.authorLogin);

    return createEvent({
        bindingId: binding.bindingId,
        repository: repositoryLabel(repository),
        accountNumericUserId: binding.accountNumericUserId,
        accountLogin: binding.accountLogin,
        projectId: binding.projectId,
        worktreeOption: binding.worktreeOption,
        kind: 'mention',
        origin: 'review-comment',
        commentId: comment.commentId,
        issue: issueFieldsOf(comment, repository),
        actorLogin: commenter,
        actorAttribution: 'direct',
        triggerNote: `Review comment by ${commenter} on pull request #${comment.pullNumber} `
            + 'mentioned the bound account',
        detectedAt,
        subjectType: 'pull_request',
    });
}

/**
 * Build one `mention` event per review comment whose body mentions the
 * account. Window, authorship and the same bounded token match are the only
 * gates — no new mention rule is invented for the second comment feed.
 */
export function reviewCommentMentionEvents(input: {
    readonly binding: BindingRecord;
    readonly login: string;
    readonly comments: readonly PollReviewComment[];
    readonly windowStart: string;
    readonly detectedAt: string;
}): QueuedEvent[] {
    const { binding, login, comments, windowStart, detectedAt } = input;
    const events: QueuedEvent[] = [];

    for (const comment of comments) {
        if (!stampInWindow(comment.updatedAt, windowStart)
            || !isAttributableAuthor(comment.authorLogin, comment.authorType)
            || !mentionsLogin(comment.body, login)) {
            continue;
        }

        events.push(reviewCommentMentionEvent({ binding, comment, detectedAt }));
    }

    return events;
}
