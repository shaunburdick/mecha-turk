/**
 * What every trigger branch of one binding's scan is handed, what it
 * answers, and the one helper they all share (002 FR-015, FR-045; 006 FR-058).
 */

import type { ServiceLogger } from '../log.ts';
import type { BindingRecord } from '../bindings.ts';
import type { GitHubIssuePoller, ListPace, PollFailure } from './poller-github.ts';
import type { QueuedEvent } from './events.ts';
import type { TrackedSubject, TrackingEnd } from './tracking.ts';

/** Longest body excerpt one event carries (bounded untrusted text). */
const BODY_EXCERPT_MAX_CHARS = 600;

/** Everything one binding's trigger branches are given. */
export interface TriggerScanInput {
    /** Poller the feeds and the per-item events read are issued through. */
    readonly poller: GitHubIssuePoller;
    readonly token: string;
    /** Structured logger the branch's own decisions are recorded on. */
    readonly log: ServiceLogger;
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
    /**
     * The subjects this binding and account is following: the ones whose
     * run carries a recorded session (002 FR-100). Read once per cycle
     * from the run document and shared by every branch, so a follow-up is
     * a property of the **same run document the join reads** rather than a
     * second index of tracked subjects (FR-107: no persisted registry).
     * An empty map is the ordinary case before anything has dispatched,
     * and every branch simply produces no follow-ups.
     */
    readonly tracked: ReadonlyMap<number, TrackedSubject>;
}

/** What one trigger branch produced: its events, or the failure that ended it. */
export type TriggerEvents =
    | {
        readonly ok: true;
        readonly events: readonly QueuedEvent[];
        /**
         * The head SHA each tracked pull request was observed carrying, keyed
         * by pull-request number and carrying only rows GitHub named a SHA
         * for. Reported beside the events because they are the same read: the
         * establishing cycle of a run with no seed records the head it
         * observed (002 FR-103(b)) and that write rides the enqueue's own
         * chain. The cycle maps these onto the run document's subject keys,
         * the only shape the enqueue pass reads.
         */
        readonly observedHeads?: ReadonlyMap<number, string>;
        /**
         * The tracked subjects whose own list row reported a terminal state
         * (002 FR-106), so the cycle can record the end of tracking with its
         * fact and date.
         */
        readonly ends?: readonly TrackingEnd[];
    }
    | { readonly ok: false; readonly failure: PollFailure };

/**
 * Slice untrusted source text to the excerpt one event can carry.
 *
 * One bound for every kind, and therefore one place: the assignment, the comment,
 * and the issue-body branches all carry an excerpt of the same bound, and a
 * second spelling of the number would be a second answer to "how much of a pull
 * request's text reaches a session's prompt".
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
