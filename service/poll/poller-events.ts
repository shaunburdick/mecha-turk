/**
 * The item's own event list — the one read that names who performed an
 * assignment or requested a review (002 FR-049).
 */

import { isRecord } from '../json.ts';
import type { ServiceLogger } from '../log.ts';
import type { RepositoryRef } from '../../src/config.ts';
import { actorLoginOf, isAttributableAuthor } from './attribution.ts';
import type { GitHubIssuePoller, ListPace, PollFailure } from './poller-github.ts';
import { stampInWindow } from './window.ts';

/**
 * Pages one item-events call walks before it gives up.
 *
 * A **planning constant**, not a requirement: what the specification fixes is the
 * *behaviour at* the bound — no event this cycle, and the exhaustion recorded
 * with the item — rather than the bound itself. Two pages at the configured
 * `per_page` (whose own maximum is 30) matches what every other list call here
 * spends, so the events read cannot quietly become the expensive part of a cycle.
 */
export const ITEM_EVENT_MAX_PAGES = 2;

/** The two trigger kinds whose actor comes off an event rather than off a feed. */
export type ItemCandidateKind = 'assignment' | 'review';

/**
 * One `simple-user` member, as this read needs it.
 *
 * `''` for both fields when GitHub sent none — the same convention
 * `poller-entries.ts` uses for every list feed's author, so one authorship rule
 * covers the list feeds and the event feed alike.
 */
export interface ItemEventActor {
    /** The account's login, `''` when absent or unreadable. */
    readonly login: string;
    /** The account's type (`User`, `Bot`, …), `''` when absent. */
    readonly type: string;
}

/**
 * One normalized row of an item's event list.
 *
 * Only the members the actor read names are read, and **not** `actor` — see the
 * module docblock. `issueNumber` is the one member read for correlation rather
 * than for the actor: it is how a row says which item it belongs to, so a row
 * naming a different item cannot answer this candidate even when it is newer.
 */
export interface PollItemEvent {
    /**
     * The kind word (`assigned`, `review_requested`, `unassigned`, `closed`, …).
     *
     * The wire schema carries **no enum** here, so an unrecognized word is
     * carried through and simply never matches a candidate — it is ignored, never
     * coerced into a kind this build knows.
     */
    readonly event: string;
    /** `assignee` — the **subject** of an assignment. */
    readonly assignee: ItemEventActor;
    /** `assigner` — the **actor** of an assignment. */
    readonly assigner: ItemEventActor;
    /** `requested_reviewer` — the **subject** of a review request. */
    readonly requestedReviewer: ItemEventActor;
    /** `review_requester` — the **actor** of a review request. */
    readonly reviewRequester: ItemEventActor;
    /** `issue.number`, or `null` when GitHub sent no `issue` member. */
    readonly issueNumber: number | null;
    /** RFC 3339 `created_at`, never `null` and never unparseable. */
    readonly createdAt: string;
}

export interface ItemEventsQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
    readonly issueNumber: number;
    /** The window this scan opened, compared on `created_at`. */
    readonly windowStart: string;
    readonly pace: ListPace;
}

export type ItemEventsOutcome =
    | PollFailure
    | {
        readonly kind: 'ok';
        /** Every event the walk saw, in page order. */
        readonly events: readonly PollItemEvent[];
        /**
         * Whether the walk reached {@link ITEM_EVENT_MAX_PAGES} without a page
         * that ends it. `true` means the list may hold events this read never saw,
         * which is why an exhaustion with no qualifying event produces nothing
         * rather than a guess from a partial list.
         */
        readonly exhausted: boolean;
    };

export type ActorRefusal =
    /** The read worked and found nothing in the window to answer the candidate. */
    | 'no-qualifying-event'
    /** The naming event's actor member is `null` or empty. */
    | 'unreadable-actor'
    | 'bot-actor';

export type CandidateActor =
    /** A readable, non-bot actor the naming event records. */
    | { readonly kind: 'actor'; readonly login: string }
    /** No event this cycle, and the reason, which is recorded (constitution IV). */
    | { readonly kind: 'refused'; readonly reason: ActorRefusal }
    /** No event this cycle: the page bound was reached with nothing qualifying. */
    | { readonly kind: 'exhausted' }
    /** The read failed; the caller classifies it exactly as a list failure. */
    | { readonly kind: 'failed'; readonly failure: PollFailure };

/** An absent `simple-user`, answering `''`/`''` like every other feed's author. */
const NO_ACTOR: ItemEventActor = { login: '', type: '' };

function actorOf(value: unknown): ItemEventActor {
    if (!isRecord(value)) {
        return NO_ACTOR;
    }

    const { login, type } = value;

    return {
        login: typeof login === 'string' ? login : '',
        type: typeof type === 'string' ? type : '',
    };
}

/**
 * Read a row's `issue` member's number, which is how a row says which item it
 * belongs to.
 *
 * The schema allows the member to be absent or `null`, so an event with no
 * `issue` member is kept and simply makes no claim about its item.
 */
function issueNumberOf(value: unknown): number | null {
    const record = isRecord(value) ? value : null;
    if (record === null) {
        return null;
    }

    const issueNumber = record.number;

    return typeof issueNumber === 'number' && Number.isSafeInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

/**
 * Read a row's `created_at`, which the whole selection rule is measured against.
 */
function createdAtOf(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * Parse one row of an item's event list, failing soft per row. A row is
 * skipped — not the page — when it carries no kind word or no readable
 * `created_at`, because the endpoint returns kinds this build does not
 * implement and rows GitHub left undated, and neither can name a subject
 * nor be judged in-window. Selection is by greatest `created_at`, so an
 * unreadable stamp would also leave *greatest* undefined.
 */
export function readItemEventEntry(value: unknown): PollItemEvent | null {
    if (!isRecord(value)) {
        return null;
    }

    const createdAt = createdAtOf(value.created_at);
    if (createdAt === null || typeof value.event !== 'string' || value.event === '') {
        return null;
    }

    return {
        event: value.event,
        assignee: actorOf(value.assignee),
        assigner: actorOf(value.assigner),
        requestedReviewer: actorOf(value.requested_reviewer),
        reviewRequester: actorOf(value.review_requester),
        issueNumber: issueNumberOf(value.issue),
        createdAt,
    };
}

/**
 * Decide whether one page ends the walk. Two signals, deliberately different
 * in kind: an under-filled page is GitHub's own *no more pages* answer and
 * needs no ordering assumption, so a look-back sweep need not pay the whole
 * page bound; the window stop requires the **whole** page older than the
 * window start, so a wrong ordering assumption can only cost requests up to
 * {@link ITEM_EVENT_MAX_PAGES} and never hide an in-window event.
 */
export function pageEndsWalk(input: {
    /** One page's events, in the order the response carried them. */
    readonly events: readonly PollItemEvent[];
    /** The window this scan opened (002 FR-065). */
    readonly windowStart: string;
    readonly perPage: number;
}): boolean {
    return input.events.length < input.perPage
        || input.events.every((event) => !stampInWindow(event.createdAt, input.windowStart));
}

interface CorrelationInput {
    readonly kind: ItemCandidateKind;
    /** The bound account the **subject** field must name. */
    readonly boundLogin: string;
    /** The item being scanned, so a row about another item cannot answer it. */
    readonly issueNumber: number;
    /** The window this scan opened (002 FR-065). */
    readonly windowStart: string;
}

/**
 * Decide whether one event qualifies as the answer to a candidate.
 *
 * Four filters, in the order they can refuse: the kind word, the item the row
 * says it belongs to, the window, and the **subject** the bound account must be
 * named by. The event word alone is not the filter — `unassigned`, `closed`,
 * `labeled`, `referenced`, and `head_ref_deleted` are all kinds this endpoint
 * returns, and none of them is an answer.
 */
function qualifies(input: CorrelationInput, event: PollItemEvent): boolean {
    const isAssignment = input.kind === 'assignment';
    const subject = isAssignment ? event.assignee : event.requestedReviewer;

    return (isAssignment ? event.event === 'assigned' : event.event === 'review_requested')
        && (event.issueNumber === null || event.issueNumber === input.issueNumber)
        && stampInWindow(event.createdAt, input.windowStart)
        && subject.login !== ''
        && subject.login.toLowerCase() === input.boundLogin.toLowerCase();
}

/**
 * Pick the one event that answers a candidate, if any does.
 *
 * Selection is by **greatest `created_at`** among the qualifying rows and never
 * by position in the response, so a feed that answers newest-first,
 * oldest-first, or interleaved produces the same actor. A bulk assignment that
 * touches the bound account twice inside one window is defined for by the same
 * rule.
 */
export function namingEventOf(events: readonly PollItemEvent[], input: CorrelationInput): PollItemEvent | null {
    let newest: PollItemEvent | null = null;
    for (const event of events) {
        if (!qualifies(input, event)) {
            continue;
        }

        if (newest === null || Date.parse(event.createdAt) > Date.parse(newest.createdAt)) {
            newest = event;
        }
    }

    return newest;
}

export type EventActor =
    | { readonly usable: true; readonly login: string }
    | { readonly usable: false; readonly reason: 'unreadable-actor' | 'bot-actor' };

/**
 * The field is the one the **kind** names — `assigner` for an assignment,
 * `review_requester` for a review request — and never `actor`, never the issue
 * author, never the `assignee` beside it, and never an actor recorded earlier
 * for the same item. Those four substitutes each record a guess as a fact, and
 * each was reachable in the build this correction replaces; the shape has no
 * member for the first and the code reaches for none of them.
 */
export function actorOfNamingEvent(input: {
    readonly kind: ItemCandidateKind;
    readonly event: PollItemEvent;
}): EventActor {
    const named = input.kind === 'assignment' ? input.event.assigner : input.event.reviewRequester;
    if (!isAttributableAuthor(named.login, named.type)) {
        return { usable: false, reason: named.login === '' ? 'unreadable-actor' : 'bot-actor' };
    }

    return { usable: true, login: actorLoginOf(named.login) };
}

interface CandidateRequest {
    readonly poller: GitHubIssuePoller;
    /** Logger every no-event answer is recorded on. */
    readonly log: ServiceLogger;
    readonly token: string;
    readonly repository: RepositoryRef;
    readonly issueNumber: number;
    readonly kind: ItemCandidateKind;
    /** The bound account, as the account record reports it. */
    readonly boundLogin: string;
    /** The window this scan opened (002 FR-065). */
    readonly windowStart: string;
    readonly pace: ListPace;
}

/**
 * Record the two ways this cycle produces no event for a matched candidate.
 *
 * Both are **recorded** rather than dropped in silence, because an operator must
 * be able to explain a missing trigger (constitution IV) and because neither
 * leaves anything behind in the queue for a later gate to guess about.
 * The scan window overlaps, so the candidate is re-detected next cycle: refusing
 * costs at most one cycle of latency.
 */
function recordNoEvent(input: { readonly request: CandidateRequest; readonly reason: ActorRefusal }): void {
    const { request, reason } = input;
    request.log.warn('matched candidate produced no event this cycle', {
        path: `issues/${request.issueNumber}`,
        kind: request.kind,
        reason,
        maxPages: ITEM_EVENT_MAX_PAGES,
    });
}

/**
 * Resolve the actor for one detected candidate — the read, the correlation,
 * the window, and the refusal, in one call. Its two ways of answering
 * *nothing* are deliberately different outcomes: **refused / exhausted**
 * means there is no honest actor, so the candidate is dropped for this cycle
 * and the overlapping window re-detects it; **failed** means the read itself
 * failed, so the caller treats it exactly as a list failure — the binding's
 * scan skips, its checkpoint is **retained** rather than advanced, and its
 * `lastError` names the class, because dropping only the candidate would
 * advance the window past an assignment nobody ever attributed.
 */
export async function resolveCandidateActor(request: CandidateRequest): Promise<CandidateActor> {
    const { repository } = request;
    const listed = await request.poller.listIssueEvents({
        token: request.token,
        owner: repository.owner,
        name: repository.name,
        issueNumber: request.issueNumber,
        windowStart: request.windowStart,
        pace: request.pace,
    });
    if (listed.kind !== 'ok') {
        return { kind: 'failed', failure: listed };
    }

    const event = namingEventOf(listed.events, {
        kind: request.kind,
        boundLogin: request.boundLogin,
        issueNumber: request.issueNumber,
        windowStart: request.windowStart,
    });
    if (event === null) {
        if (listed.exhausted) {
            request.log.warn('matched candidate produced no event this cycle', {
                path: `issues/${request.issueNumber}`,
                kind: request.kind,
                reason: 'page-bound-reached',
                maxPages: ITEM_EVENT_MAX_PAGES,
            });

            return { kind: 'exhausted' };
        }

        recordNoEvent({ request, reason: 'no-qualifying-event' });

        return { kind: 'refused', reason: 'no-qualifying-event' };
    }

    const actor = actorOfNamingEvent({ kind: request.kind, event });
    if (!actor.usable) {
        recordNoEvent({ request, reason: actor.reason });

        return { kind: 'refused', reason: actor.reason };
    }

    return { kind: 'actor', login: actor.login };
}
