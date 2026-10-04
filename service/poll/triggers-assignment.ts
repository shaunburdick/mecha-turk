/**
 * The **assignment** trigger (002 FR-015, FR-049 – FR-052).
 *
 * Split out of `loop.ts` for the file-length gate, and because this is the one
 * trigger whose *detection* and whose *actor* come from different places: the
 * list feed answers "is this item assigned to the bound account", and the item's
 * own event list answers "who did it". Getting that second half from the feed
 * that asked the first question is what v1.11.0 did, and it is the defect this
 * trigger's shape exists to correct.
 *
 * Two stages, and neither substitutes for the other:
 *
 * 1. **Detect**, from the issues list the cycle already fetched: an open issue
 *    whose `assignees` names the bound account. No request of its own.
 * 2. **Attribute**, from one per-item events read for that issue and no other
 *    (002 FR-049): the naming `assigned` event, whose `assignee` is the bound
 *    account, whose `assigner` is the actor.
 *
 * The attribution stage can answer *nothing*, and that is a real outcome rather
 * than an error (002 FR-050, FR-051, FR-052). A missing or stale naming event, an
 * actor GitHub sent no login for, and a bot assigner all yield **no event for
 * this cycle** — never a row carrying the issue author, the `actor` member, or
 * the `assignee` — because a stale assignment is not new work and a guessed
 * actor is worse than a missing one. What *does* end the scan is a failure of the
 * read itself, which the cycle turns into its usual skip: see
 * {@link resolveCandidateActor} for why that distinction is load-bearing.
 */

import { repositoryLabel, repositoryRefOf } from '../../src/config.ts';
import { createEvent } from './events.ts';
import { resolveCandidateActor } from './poller-events.ts';
import { stampInWindow } from './window.ts';
import { bodyExcerptOf } from './trigger-scan.ts';
import type { QueuedEvent } from './events.ts';
import type { PollIssue } from './poller-entries.ts';
import type { TriggerEvents, TriggerScanInput } from './trigger-scan.ts';

/**
 * Decide whether one issue is an assignment candidate for the bound account.
 *
 * The gate is the list feed's own evidence — an **open** issue whose current
 * `assignees` name the bound account — and it says nothing about who did it,
 * which is why the event read behind it is not optional. Pull-request assignment
 * and the review trigger can both fire on one pull request; the run layer
 * coalesces them on the same subject key.
 *
 * @param issue - Normalized issue.
 * @param bindingLogin - The bound account's login.
 * @returns `true` when the issue is open and assigned to that account.
 */
export function isIssueAssignment(issue: PollIssue, bindingLogin: string): boolean {
    if (issue.state !== 'open') {
        return false;
    }

    return issue.assignees.some((login) => login.toLowerCase() === bindingLogin.toLowerCase());
}

/**
 * Build one `assignment` event from an issue and the actor its event names.
 *
 * The basis is `direct` for the same reason the mention kinds are: GitHub records
 * who performed the assignment, in `assigner`, so there is no inference on this
 * row to disclose. The legacy `subject-author` basis stays in the
 * union and stays readable for rows written before this correction; **nothing
 * here writes it**, and no fallback path below reaches for it.
 *
 * @param input - The binding, the matched issue, the actor, and the stamp.
 * @returns The event, with the event-named attribution.
 */
function assignmentEvent(input: {
    /** The binding that produced the window. */
    readonly binding: TriggerScanInput['binding'];
    /** The assigned issue. */
    readonly issue: PollIssue;
    /** The `assigner.login` the naming event recorded. */
    readonly actorLogin: string;
    /** RFC 3339 stamp pinned at cycle start. */
    readonly detectedAt: string;
}): QueuedEvent {
    const { binding, issue, actorLogin, detectedAt } = input;
    const repository = repositoryRefOf(binding.repository);

    return createEvent({
        bindingId: binding.bindingId,
        repository: repositoryLabel(repository),
        accountNumericUserId: binding.accountNumericUserId,
        accountLogin: binding.accountLogin,
        projectId: binding.projectId,
        worktreeOption: binding.worktreeOption,
        kind: 'assignment',
        issue: {
            issueNumber: issue.issueNumber,
            issueTitle: issue.title,
            issueUrl: issue.url,
            issueBodyExcerpt: bodyExcerptOf(issue.body),
        },
        // GitHub named the person who performed the assignment on the naming
        // event's `assigner` member, so this attribution is a fact (002 FR-044,
        // FR-050). The issue author is *not* a fallback for it.
        actorLogin,
        actorAttribution: 'direct',
        triggerNote: 'Issue assigned to the bound account',
        detectedAt,
        subjectType: issue.isPullRequest ? 'pull_request' : 'issue',
    });
}

/**
 * Collect the assignment events one binding's issues matched.
 *
 * Candidates are filtered by the window **twice**, deliberately: the listing's
 * `updated_at` says the *item* moved recently (the pre-existing rule, unchanged),
 * and the event's `created_at` says the *assignment* is new (002 FR-051). Only
 * the second makes this a trigger rather than a re-detection of old work, and
 * requiring both is what stops a merely-touched issue from re-firing on a
 * months-old assignment.
 *
 * @param input - The shared scan input plus the issues the cycle listed.
 * @returns The assignment events, or the failure that ended the read.
 */
export async function assignmentEvents(input: TriggerScanInput & {
    /** Issues the cycle's own issue list yielded. */
    readonly issues: readonly PollIssue[];
}): Promise<TriggerEvents> {
    const events: QueuedEvent[] = [];
    for (const issue of input.issues) {
        if (!stampInWindow(issue.updatedAt, input.windowStart) || !isIssueAssignment(issue, input.login)) {
            continue;
        }

        const actor = await resolveCandidateActor({
            poller: input.poller,
            log: input.log,
            token: input.token,
            repository: repositoryRefOf(input.binding.repository),
            issueNumber: issue.issueNumber,
            kind: 'assignment',
            boundLogin: input.login,
            windowStart: input.windowStart,
            pace: input.pace,
        });
        if (actor.kind === 'failed') {
            return { ok: false, failure: actor.failure };
        }

        if (actor.kind === 'actor') {
            events.push(assignmentEvent({
                binding: input.binding,
                issue,
                actorLogin: actor.login,
                detectedAt: input.detectedAt,
            }));
        }
    }

    return { ok: true, events };
}
