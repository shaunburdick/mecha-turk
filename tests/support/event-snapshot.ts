/** The one assignment-detection snapshot the run and prompt suites enqueue. */

import type { ActorAttribution } from '../../service/poll/attribution.ts';
import type { EventSnapshot } from '../../service/poll/events.ts';
import { FIXTURE_BINDING_STAMP } from './binding-fixture.ts';

/** Fields one assignment snapshot differs on. */
export interface AssignmentSnapshotOptions {
    readonly bindingId: string;
    readonly repository?: string;
    readonly accountNumericUserId?: string;
    readonly accountLogin?: string;
    readonly projectId?: string;
    readonly issueTitle?: string;
    readonly excerpt?: string;
    readonly actorLogin?: string;
    readonly actorAttribution?: ActorAttribution;
    readonly triggerNote?: string;
    readonly detectedAt?: string;
}

/**
 * The values every assignment snapshot carries unless a suite varies them: supply a member to
 * vary it — passing `undefined` would void the default the spread below relies on.
 */
const DEFAULTS = {
    repository: 'acme/widget',
    accountNumericUserId: '77331',
    accountLogin: 'octocat',
    projectId: 'prj_42',
    actorLogin: 'alice',
    actorAttribution: 'subject-author',
    detectedAt: FIXTURE_BINDING_STAMP,
} as const;

export function assignmentSnapshot(
    issueNumber: number,
    options: AssignmentSnapshotOptions,
): EventSnapshot {
    const picked = { ...DEFAULTS, ...options };
    const { repository } = picked;

    return {
        bindingId: picked.bindingId,
        repository,
        accountNumericUserId: picked.accountNumericUserId,
        accountLogin: picked.accountLogin,
        projectId: picked.projectId,
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: options.issueTitle ?? `Issue ${issueNumber}`,
            issueUrl: `https://github.com/${repository}/issues/${issueNumber}`,
            issueBodyExcerpt: options.excerpt ?? `body ${issueNumber}`,
        },
        actorLogin: picked.actorLogin,
        actorAttribution: picked.actorAttribution,
        triggerNote: options.triggerNote ?? 'assigned',
        detectedAt: picked.detectedAt,
    };
}
