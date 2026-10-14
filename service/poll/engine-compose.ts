/**
 * The service-side follow-up message: the panel's own frame builder and
 * delimiter defusing under the follow-up header, measured against the same
 * budget floor before any engine call and refused rather than truncated
 * (FR-104 span A; plan pin 9; constitution IV).
 */

import { defuseDelimiters } from '../../src/context-blocks.ts';
import { CONTEXT_MAX_CHARS, renderBoundedContext } from '../../src/session.ts';
import type { ContextSource } from '../../src/session.ts';
import { followUpKindOf } from './events-parse.ts';
import type { QueuedEvent } from './events-parse.ts';
import type { Run } from './runs-types.ts';

/** The head pair a `head` movement renders, derived from the run's own chain. */
function headPairOf(input: {
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly runRows: readonly QueuedEvent[];
}): { readonly from: string; readonly to: string } | null {
    if (followUpKindOf(input.row.id) !== 'head') {
        return null;
    }

    let previous = input.run.lastHeadSha ?? 'an unrecorded head';
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
        to: input.row.headSha !== null && input.row.headSha !== '' ? input.row.headSha : 'an unrecorded head',
    };
}

/** What one composition settled as. */
export type ComposeOutcome =
    | { readonly ok: true; readonly text: string }
    /** Refused before any engine call; the cause names which refusal it was. */
    | { readonly ok: false; readonly cause: 'over-budget' | 'not-a-follow-up' };

/**
 * Compose the engine path's follow-up message — the same attribution header,
 * FR-028 delimiters, untrusted-source preamble, and correlation id the panel
 * composes, through the same shared modules (plan pin 9). The whole
 * composition is measured against {@link CONTEXT_MAX_CHARS} immediately before
 * it could be sent and refused rather than cut (FR-104).
 */
export function composeEngineFollowUp(input: {
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly sessionId: string;
    /** This run's follow-up rows, in detection order, for the head chain. */
    readonly runRows: readonly QueuedEvent[];
}): ComposeOutcome {
    const kind = followUpKindOf(input.row.id);
    if (kind === null) {
        return { ok: false, cause: 'not-a-follow-up' };
    }

    const { row } = input;
    const heads = headPairOf({ run: input.run, row, runRows: input.runRows });
    const movement = heads === null
        ? 'New comment'
        : `Head moved from ${defuseDelimiters(heads.from)} to ${defuseDelimiters(heads.to)}`;
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
        origin: kind === 'head' ? 'review' : 'comment',
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
            isPullRequest: kind === 'head',
        },
        sources,
    });

    return text.length <= CONTEXT_MAX_CHARS ? { ok: true, text } : { ok: false, cause: 'over-budget' };
}
