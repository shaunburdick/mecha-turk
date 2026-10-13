/**
 * The review-request trigger (002 FR-015, FR-049 – FR-052).
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import { createEvent } from './events.ts';
import { headFollowUps } from './follow-up.ts';
import { resolveCandidateActor } from './poller-events.ts';
import { trackedPullEnds, withoutEnded } from './tracking.ts';
import { stampInWindow } from './window.ts';
import type { QueuedEvent } from './events.ts';
import type { PollPull } from './poller-entries.ts';
import type { TriggerEvents, TriggerScanInput } from './trigger-scan.ts';

/**
 * Decide whether one pull request asked the bound account to review it.
 *
 * The whole gate is the **subject** match the pulls list can support: an open
 * pull request whose `requested_reviewers` name the bound account,
 * case-insensitively. Who asked is not judged here and cannot be — that is what
 * the per-item events read behind this is for, and an empty bound login matches
 * nothing because a listing never reports an empty reviewer login.
 */
export function isReviewRequestPull(pull: PollPull, bindingLogin: string): boolean {
    if (bindingLogin === '') {
        return false;
    }

    const wanted = bindingLogin.toLowerCase();

    return pull.requestedReviewers.some((candidate) => candidate.toLowerCase() === wanted);
}

/**
 * Build one `review` event from a pull request and the actor its event names.
 *
 * The basis is `direct`: GitHub records who requested the review, in
 * `review_requester`, so this row carries a fact and there is no inference on it
 * to disclose. The legacy `subject-author` basis remains
 * readable for rows written before this correction and is written by nothing here.
 */
function reviewEvent(input: {
    /** The binding that produced the window. */
    readonly binding: TriggerScanInput['binding'];
    /** The pull request that asked for the account. */
    readonly pull: PollPull;
    /** The `review_requester.login` the naming event recorded. */
    readonly actorLogin: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent {
    const { binding, pull, actorLogin, detectedAt } = input;

    return createEvent({
        bindingId: binding.bindingId,
        repository: repositoryLabel(repositoryRefOf(binding.repository)),
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
        actorLogin,
        actorAttribution: 'direct',
        triggerNote: `Pull request #${pull.pullNumber} requested the bound account's review`,
        detectedAt,
        subjectType: 'pull_request',
    });
}

/**
 * List the review-request feed and collect the events its matches produce
 * (M7). The same pulls list answers a second question — which tracked pull's
 * **head moved** since the run's seed was recorded (002 FR-102(b)) — riding
 * the identical read, so at most one head follow-up per subject per cycle,
 * and reporting every head it observed so a run with no seed can record one
 * (FR-103(b)). The list failure ends the branch and is handed up as the
 * cycle's skip, exactly as the assignment branch's is; the per-item reads
 * report their outcomes through {@link resolveCandidateActor}, whose two
 * no-event answers are recorded rather than silent.
 */
export async function reviewRequestEvents(input: TriggerScanInput): Promise<TriggerEvents> {
    const { binding, poller, token, login, windowStart, detectedAt, pace } = input;
    const repository = repositoryRefOf(binding.repository);
    const listed = await poller.listOpenPulls({
        token,
        owner: repository.owner,
        name: repository.name,
        pace,
    });
    if (listed.kind !== 'ok') {
        return { ok: false, failure: listed };
    }

    const events: QueuedEvent[] = [];
    for (const pull of listed.pulls) {
        if (!stampInWindow(pull.updatedAt, windowStart) || !isReviewRequestPull(pull, login)) {
            continue;
        }

        const actor = await resolveCandidateActor({
            poller,
            log: input.log,
            token,
            repository,
            issueNumber: pull.pullNumber,
            kind: 'review',
            boundLogin: login,
            windowStart,
            pace,
        });
        if (actor.kind === 'failed') {
            return { ok: false, failure: actor.failure };
        }

        if (actor.kind === 'actor') {
            events.push(reviewEvent({ binding, pull, actorLogin: actor.login, detectedAt }));
        }
    }

    const pullEnds = trackedPullEnds({ binding, pulls: listed.pulls, tracked: input.tracked });
    const heads = headFollowUps({
        binding,
        pulls: listed.pulls,
        tracked: withoutEnded(input.tracked, pullEnds),
        windowStart,
        detectedAt,
    });

    return {
        ok: true,
        events: [...events, ...heads.rows],
        observedHeads: new Map(heads.observations.flatMap((observation) =>
            observation.headSha === null ? [] : [[observation.pullNumber, observation.headSha]])),
        ...(pullEnds.length > 0 && { ends: pullEnds }),
    };
}
