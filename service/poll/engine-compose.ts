/** The service-side follow-up message: the panel's frame builder and defusing — over budget refused, never cut. */

import { defuseDelimiters } from '../../src/context-blocks.ts';
import { CONTEXT_MAX_CHARS, renderBoundedContext } from '../../src/session.ts';
import type { ContextSource } from '../../src/session.ts';
import { followUpKindOf } from './events-parse.ts';
import type { FollowUpKind, QueuedEvent } from './events-parse.ts';
import type { Run } from './runs-types.ts';

/** The kinds whose movement is a comment on a pull request rather than an issue. */
const PULL_SHAPED_KINDS: ReadonlySet<FollowUpKind> = new Set(['head', 'review', 'review-comment']);
const UNRECORDED_HEAD = 'an unrecorded head';

function movementOf(kind: FollowUpKind, heads: { readonly from: string; readonly to: string } | null): string {
    switch (kind) {
        case 'head': {
            return `Head moved from ${defuseDelimiters(heads?.from ?? UNRECORDED_HEAD)} to ${
                defuseDelimiters(heads?.to ?? UNRECORDED_HEAD)}`;
        }
        case 'review': {
            return 'Review requested on this pull request';
        }
        case 'review-comment': {
            return 'New review comment';
        }
        case 'comment': {
            return 'New comment';
        }
    }
}

function headPairOf(input: {
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly runRows: readonly QueuedEvent[];
}): { readonly from: string; readonly to: string } | null {
    if (followUpKindOf(input.row.id) !== 'head') {
        return null;
    }

    let previous = input.run.lastHeadSha ?? UNRECORDED_HEAD;
    for (const candidate of input.runRows) {
        if (candidate.id === input.row.id) {
            break;
        }

        if (followUpKindOf(candidate.id) === 'head' && candidate.headSha !== null && candidate.headSha !== '') {
            previous = candidate.headSha;
        }
    }

    return {
        from: previous,
        to: input.row.headSha !== null && input.row.headSha !== '' ? input.row.headSha : UNRECORDED_HEAD,
    };
}

export type ComposeOutcome =
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly cause: 'over-budget' | 'not-a-follow-up' };

export function composeEngineFollowUp(input: {
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly sessionId: string;
    readonly runRows: readonly QueuedEvent[];
}): ComposeOutcome {
    const kind = followUpKindOf(input.row.id);
    if (kind === null) {
        return { ok: false, cause: 'not-a-follow-up' };
    }

    const { row } = input;
    const heads = headPairOf({ run: input.run, row, runRows: input.runRows });
    const movement = movementOf(kind, heads);
    const isPullShaped = PULL_SHAPED_KINDS.has(kind);
    const header = [
        'Mecha Turk follow-up (automated — continuing a work item Mecha Turk already started).',
        `Correlation: ${defuseDelimiters(input.run.correlationId)}`,
        `Repository: ${defuseDelimiters(row.repository)}`,
        `Issue #${row.issueNumber}: ${defuseDelimiters(row.issueTitle)}`,
        `URL: ${defuseDelimiters(row.issueUrl)}`,
        `Session: ${defuseDelimiters(input.sessionId)}`,
        `Movement: ${movement}`,
        `Observed by: ${defuseDelimiters(row.actorLogin ?? '')} at ${defuseDelimiters(row.detectedAt)}`,
        'Rule: this is the same work item the session was started for; reply inside this session.',
    ];
    const sources: readonly ContextSource[] = [{
        origin: isPullShaped ? 'review' : 'comment',
        kind: row.kind,
        detectedAt: row.detectedAt,
        url: row.issueUrl,
        excerpt: row.issueBodyExcerpt,
    }];
    const text = renderBoundedContext({
        header,
        issue: {
            issueNumber: row.issueNumber,
            title: row.issueTitle,
            url: row.issueUrl,
            state: 'open',
            body: null,
            assignees: [],
            isPullRequest: isPullShaped,
        },
        sources,
    });

    return text.length <= CONTEXT_MAX_CHARS ? { ok: true, text } : { ok: false, cause: 'over-budget' };
}
