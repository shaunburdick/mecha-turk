/**
 * The one assignment-detection snapshot the run and prompt suites enqueue.
 *
 * Eleven suites each assembled this `EventSnapshot` inline; the shape is fixed
 * by `createEvent` (002 FR-042) and only the members a suite's case judges —
 * its binding, title, excerpt, trigger note, and detection stamp — differ. It
 * lives here so a new snapshot field is added once.
 *
 * The issue URL is derived from the repository, the way the poller writes it —
 * a fixture cannot claim one repository and cite another.
 */

import type { ActorAttribution } from '../../service/poll/attribution.ts';
import type { EventSnapshot } from '../../service/poll/events.ts';
import { FIXTURE_BINDING_STAMP } from './binding-fixture.ts';

/** Fields one assignment snapshot differs on. */
export interface AssignmentSnapshotOptions {
    /** Binding the detection belongs to. */
    readonly bindingId: string;
    /** Repository label, `owner/name`. */
    readonly repository?: string;
    /** Bound account's GitHub numeric id. */
    readonly accountNumericUserId?: string;
    /** Bound account's login. */
    readonly accountLogin?: string;
    /** OpenChamber project the dispatch targets. */
    readonly projectId?: string;
    /** Issue title the event carries. */
    readonly issueTitle?: string;
    /** Issue-body excerpt the event carries. */
    readonly excerpt?: string;
    /** Attributed actor login (002 FR-043). */
    readonly actorLogin?: string;
    /** Attribution basis (002 FR-044). */
    readonly actorAttribution?: ActorAttribution;
    /** The trigger note the event records. */
    readonly triggerNote?: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt?: string;
}

/**
 * The values every assignment snapshot carries unless a suite varies them.
 *
 * A suite varies a member by supplying it — it is never passed as `undefined`,
 * so the spread below can never silently void a default.
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

/**
 * Build one assignment detection for one issue.
 *
 * @returns The snapshot `createEvent` accepts.
 */
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
