/**
 * What every trigger branch of one binding's scan is handed, what it answers,
 * and the one helper they all share (002 FR-015, FR-045; 006 FR-058).
 *
 * One binding's scan has four branches — assignment, comment mention, issue-body
 * mention, review request — and they live in three modules so that none of them
 * is the coordinator. This is the contract they all take, kept in its own module
 * for the reason `runs-types.ts` and `dispatch-corpus.ts` exist: a shape shared by
 * siblings belongs with neither of them, and a branch module that imported it
 * from a sibling would close a cycle the moment a second branch was added.
 *
 * Three properties of the input are decisions rather than conveniences:
 *
 * - **`windowStart` is the one window**, already widened by the cycle's own
 *   configured overlap (006 FR-059(a)) or by the binding's history scope (002
 *   FR-065 – FR-067), and every branch compares against it with the single rule
 *   in `window.ts`. A branch that computed its own window would be a second
 *   answer to "what counts as new this cycle". **The history scope is not passed
 *   down with it** (002 FR-068): the mode decides a window's start and nothing
 *   else, so no branch — and no comparison about an individual observation — can
 *   consult it.
 * - **`login` is the account record's login when it has one** and the binding's
 *   otherwise, decided once by the cycle, so the subject fields the triggers
 *   match are matched against the same identity everywhere (002 FR-009).
 * - **`log` is the cycle's logger**, because two branches record a *decision not
 *   to emit an event* — the per-item actor read's refusal and its page-bound
 *   exhaustion (002 FR-051, FR-052) — and an operator must be able to explain a
 *   missing trigger (constitution IV). A branch that dropped a candidate silently
 *   would have left no trace of it at all.
 *
 * The answer is deliberately narrow: a branch either produced rows, or it hit a
 * **classified upstream failure** the cycle turns into a skip. It cannot answer
 * "I found nothing", because finding nothing is not a branch's problem — it is
 * the ordinary case, and the branches whose candidates found nothing are the
 * subject of 002 FR-049's per-item read.
 */

import type { ServiceLogger } from '../log.ts';
import type { BindingRecord } from '../bindings.ts';
import type { GitHubIssuePoller, ListPace, PollFailure } from './poller-github.ts';
import type { QueuedEvent } from './events.ts';

/** Longest body excerpt one event carries (bounded untrusted text). */
const BODY_EXCERPT_MAX_CHARS = 600;

/** Everything one binding's trigger branches are given. */
export interface TriggerScanInput {
    /** Poller the feeds and the per-item events read are issued through. */
    readonly poller: GitHubIssuePoller;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Structured logger the branch's own decisions are recorded on. */
    readonly log: ServiceLogger;
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** The bound account's login, as the account record reports it. */
    readonly login: string;
    /**
     * The window this scan opened, already widened by whatever the cycle's own
     * configuration and the binding's history scope declared (002 FR-065).
     *
     * A `string`, not `string | null`: since v1.13.0 **every** scan opens at a
     * computable lower bound, so "no window" is not a state a branch has to
     * handle — and a branch that could receive one would have to decide whether
     * an undated observation counts, which is the arm FR-069 retired.
     */
    readonly windowStart: string;
    /** RFC 3339 stamp pinned at cycle start, shared by every row of the cycle. */
    readonly detectedAt: string;
    /** Page size and retry ladder this cycle's calls run under (006 FR-058/FR-059). */
    readonly pace: ListPace;
}

/** What one trigger branch produced: its events, or the failure that ended it. */
export type TriggerEvents =
    | { readonly ok: true; readonly events: readonly QueuedEvent[] }
    | { readonly ok: false; readonly failure: PollFailure };

/**
 * Slice untrusted source text to the excerpt one event can carry.
 *
 * One bound for every kind, and therefore one place: the assignment, the comment,
 * and the issue-body branches all carry an excerpt of the same bound, and a
 * second spelling of the number would be a second answer to "how much of a pull
 * request's text reaches a session's prompt".
 *
 * @param body - Raw issue or comment body, or `null` when GitHub sent none.
 * @returns The excerpt, or `''` when there was no body.
 */
export function bodyExcerptOf(body: string | null): string {
    if (body === null) {
        return '';
    }

    if (body.length <= BODY_EXCERPT_MAX_CHARS) {
        return body;
    }

    return `${body.slice(0, BODY_EXCERPT_MAX_CHARS - 1)}…`;
}
