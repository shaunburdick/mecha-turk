/**
 * The **review-request** trigger (002 FR-015, FR-049 – FR-052).
 *
 * Split out of `triggers.ts` for the file-length gate, and for the same reason
 * its assignment sibling was: this is the second trigger whose actor comes from
 * the item's own event list rather than from the feed that detected it. The
 * pulls list names `requested_reviewers` — who is *asked* — and names nobody who
 * asked; the per-item events feed names both, in `requested_reviewer` (the
 * subject) and `review_requester` (the actor).
 *
 * The gate on the listing is therefore **only** the subject match. v1.11.0 also
 * required a readable, non-bot pull-request author, because that author was the
 * proxy it attributed the request to; with the proxy retired there is nothing on
 * the listing that could stand in for the requester, so the author is no longer
 * read at all (002 FR-045's sentence requiring `PollPull`'s author members is
 * struck at v1.12.0). An event whose `review_requester` is unreadable or a bot
 * produces **no event this cycle** (002 FR-052), where the old gate would have
 * refused on the author's account instead and for the wrong reason.
 *
 * `GET /issues/{number}/events` serves a pull request as readily as an issue — a
 * pull request *is* an issue in GitHub's data model, and it is the `issue` member
 * on the response rows that distinguishes the two — so one per-item read answers
 * both kinds and no separate endpoint is introduced (002 FR-049).
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import { createEvent } from './events.ts';
import { resolveCandidateActor } from './poller-events.ts';
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
 *
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
 * Build one `review` event from a pull request and the actor its event names.
 *
 * The basis is `direct`: GitHub records who requested the review, in
 * `review_requester`, so this row carries a fact and there is no inference on it
 * to disclose. The legacy `subject-author` basis remains
 * readable for rows written before this correction and is written by nothing here.
 *
 * @param input - The binding, the matched pull request, the actor, and the stamp.
 * @returns The event, with the event-named attribution.
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
 * List the review-request feed and collect the events its matches produce (M7).
 *
 * The list failure ends the branch and is handed up as the cycle's skip, exactly
 * as the assignment branch's read failure is; the per-item reads below report
 * their own outcomes through {@link resolveCandidateActor}, whose two
 * no-event answers are recorded rather than silent.
 *
 * @param input - The shared scan input.
 * @returns The review events, or the failure that ended the branch.
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

    return { ok: true, events };
}
