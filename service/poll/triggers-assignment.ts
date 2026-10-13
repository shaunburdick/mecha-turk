/**
 * The assignment trigger (002 FR-015, FR-049 – FR-052).
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
 * Collect the assignment events one binding's issues matched. Candidates are
 * filtered by the window **twice**, deliberately: the listing's `updated_at`
 * says the *item* moved recently (the pre-existing rule, unchanged), and the
 * event's `created_at` says the *assignment* is new (002 FR-051). Only the
 * second makes this a trigger rather than a re-detection of old work, so
 * requiring both stops a merely-touched issue re-firing on a months-old
 * assignment.
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
