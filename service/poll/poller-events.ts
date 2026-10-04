/**
 * The item's own **event list** — the one read that names who performed an
 * assignment or requested a review (002 FR-049 – FR-052; research §R8 as
 * rewritten at v1.12.0).
 *
 * This module exists because a research claim this product's whole actor story
 * rested on turned out to be **false**. v1.11.0 read only the two *list* feeds
 * the scan happens to call — `GET /issues` exposes `assignees` (the current set,
 * nobody behind it) and `GET /pulls` exposes `requested_reviewers` (likewise) —
 * and generalized from those two endpoints to GitHub as a whole. GitHub **does**
 * record both actors, one endpoint away, in named fields: `assigner` on the
 * `assigned` event and `review_requester` on the `review_requested` event, both
 * nullable `simple-user` members carrying `login` and `type`.
 *
 * Four rules, each a decision rather than a detail, and each a place where the
 * obvious implementation guesses:
 *
 * - **Per item, and only for an item already detected as a candidate**
 *   (FR-049). Zero requests when nothing matched; one per matched candidate per
 *   cycle. The repository-wide events feed and the timeline feed are **not**
 *   called anywhere: both cost a request on every cycle regardless of activity,
 *   and — since neither has a server-side window — each would need its own
 *   pagination-truncation concept on top of the one the scan already has.
 * - **The correlation is closed, and the asymmetry is deliberate** (FR-050).
 *   An assignment candidate is answered by an `assigned` event whose
 *   **`assignee`** is the bound account, and the actor is that event's
 *   **`assigner`**; a review candidate by a `review_requested` event whose
 *   **`requested_reviewer`** is the bound account, and the actor is its
 *   **`review_requester`**. The *subject* field is what must match the bound
 *   account, because that is the identity FR-015 makes each trigger about. An
 *   event naming a different subject is a **different act** and is never used,
 *   however recent it is.
 * - **`actor` is not the field to read, and that is the point** (FR-049).
 *   `actor` is documented as *the person who generated the event*; `assigner`
 *   and `review_requester` name the actor **of the act**. They coincided on
 *   every row this repository has produced, which is exactly why reading `actor`
 *   would look right here and be wrong in production: an app acting for a human
 *   generates the event as the app and records the act against the human. So the
 *   normalized shape below has **no `actor` member at all** — the substitute
 *   cannot be reached even by accident.
 * - **An actor that cannot be read yields no event, and substitutes nothing**
 *   (FR-052). `null`, `''`, and a bot are refused by the one existing
 *   `isAttributableAuthor` posture, applied here to the actor the event *names*.
 *   A `null` because GitHub had not yet propagated the field costs at most one
 *   cycle: the scan window **overlaps**, so the candidate is re-detected and the
 *   event is created exactly once. That is why refusing is honest here rather
 *   than lossy, and why no fallback reaches for `actor`, the issue author, the
 *   `assignee`, or a previously recorded actor.
 *
 * The window is applied **client-side** (FR-051), because none of these
 * endpoints has a `since` parameter — not this one, not the repository-wide one,
 * not the timeline (which adds only `exclude`). {@link pageEndsWalk} stops the
 * bounded walk only on a page **entirely** older than the window start, which is
 * deliberately one-directional: a wrong assumption about GitHub's ordering can
 * then only cost requests up to {@link ITEM_EVENT_MAX_PAGES} and can never cause
 * an early stop that hides an in-window event.
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
 * A **planning constant**, not a requirement: FR-051 fixes the *behaviour at*
 * the bound — no event this cycle, and the exhaustion recorded with the item —
 * rather than the bound itself. Two pages at the configured `per_page` (whose own
 * maximum is 30, 002 FR-020) matches what every other list call here spends, so
 * the events read cannot quietly become the expensive part of a cycle.
 */
export const ITEM_EVENT_MAX_PAGES = 2;

/** The two trigger kinds whose actor comes off an event rather than off a feed. */
export type ItemCandidateKind = 'assignment' | 'review';

/**
 * One `simple-user` member, as this read needs it.
 *
 * `''` for both fields when GitHub sent none — the same convention
 * `poller-entries.ts` uses for every list feed's author, so one authorship rule
 * covers the list feeds and the event feed alike (002 FR-045).
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
 * Only the members FR-049 names are read, and **not** `actor` — see the module
 * docblock. `issueNumber` is the one member read for correlation rather than for
 * the actor: it is how a row says which item it belongs to, so a row naming a
 * different item cannot answer this candidate even when it is newer.
 */
export interface PollItemEvent {
    /**
     * The kind word (`assigned`, `review_requested`, `unassigned`, `closed`, …).
     *
     * The wire schema carries **no enum** here, so an unrecognized word is
     * carried through and simply never matches a candidate — it is ignored, never
     * coerced into a kind this build knows (FR-050).
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

/** Credential, repository, item, and window one events call takes (FR-049, FR-051). */
export interface ItemEventsQuery {
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Repository owner. */
    readonly owner: string;
    /** Repository name. */
    readonly name: string;
    /** The item whose events are read — an issue number or a pull-request number. */
    readonly issueNumber: number;
    /** Window start, or `null` for a replay scan; compared on `created_at`. */
    readonly windowStart: string | null;
    /** Page size and retry ladder this call runs under (006 FR-058, FR-059). */
    readonly pace: ListPace;
}

/** Outcome of one item-events call: the events read, or the classified failure. */
export type ItemEventsOutcome =
    | {
        /** The pages answered. */
        readonly kind: 'ok';
        /** Every event the walk saw, in page order. */
        readonly events: readonly PollItemEvent[];
        /**
         * Whether the walk reached {@link ITEM_EVENT_MAX_PAGES} without a page
         * that ends it. `true` means the list may hold events this read never saw,
         * which is why an exhaustion with no qualifying event produces nothing
         * rather than a guess from a partial list (FR-051).
         */
        readonly exhausted: boolean;
    }
    | PollFailure;

/** Why one candidate's actor could not be used (FR-052). */
export type ActorRefusal =
    /** The read worked and found nothing in the window to answer the candidate. */
    | 'no-qualifying-event'
    /** The naming event's actor member is `null` or empty. */
    | 'unreadable-actor'
    /** The naming event's actor is a bot (002 FR-045(a)). */
    | 'bot-actor';

/** What resolving one candidate's actor found. */
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

/**
 * Read one `simple-user` member.
 *
 * @param value - The member as the wire carries it, which may be `null`.
 * @returns The actor, or `''`/`''` when there is none to read.
 */
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
 * @param value - The `issue` member as the wire carries it, which may be absent
 *   or `null` — the schema allows it, so an event with no `issue` member is kept
 *   and simply makes no claim about its item.
 * @returns The item number, or `null` when the member carries none.
 */
function issueNumberOf(value: unknown): number | null {
    const record = isRecord(value) ? value : null;
    if (record === null) {
        return null;
    }

    const issueNumber = record.number;

    return typeof issueNumber === 'number' && Number.isInteger(issueNumber) && issueNumber > 0 ? issueNumber : null;
}

/**
 * Read a row's `created_at`, which the whole selection rule is measured against.
 *
 * @param value - The member as the wire carries it.
 * @returns The RFC 3339 stamp, or `null` when it is absent or unparseable.
 */
function createdAtOf(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * Parse one row of an item's event list, failing soft per row.
 *
 * A row is skipped — not the page — when it carries no kind word or no readable
 * `created_at`. Both are refusals of the **row**, not of the read: the endpoint
 * returns kinds this build does not implement and rows GitHub left undated, and
 * neither can name a subject nor be judged in-window. Selection is by greatest
 * `created_at`, so a stamp the clock cannot read would also leave "greatest"
 * undefined.
 *
 * @param value - One element of the parsed list.
 * @returns The normalized event, or `null` when the row is not usable.
 */
export function readItemEventEntry(value: unknown): PollItemEvent | null {
    if (!isRecord(value)) {
        return null;
    }

    const createdAt = createdAtOf(value.created_at);
    if (typeof value.event !== 'string' || value.event === '' || createdAt === null) {
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
 * Decide whether one page ends the walk (FR-051).
 *
 * **Two** signals end it, and they are deliberately different in kind:
 *
 * - **The page under-filled its cap.** This is GitHub's own "there are no more
 *   pages" answer, the same in-band signal every list call here already honours
 *   (`poller-github.ts`'s `parsed.length < perPage`). It is not an assumption
 *   about ordering, so it can end the walk immediately even on a replay scan
 *   whose window could never end it — without it, a replay would pay the whole
 *   page bound for a candidate whose item holds two events.
 * - **Every event on the page is older than the window start.** This is the
 *   window-based stop, and it requires the **whole** page, so a wrong assumption
 *   about GitHub's ordering can only cause over-fetching: more requests until
 *   {@link ITEM_EVENT_MAX_PAGES}, never an early stop that misses an in-window
 *   event.
 *
 * The asymmetry is the point. One signal is the provider saying it is done; the
 * other is a heuristic about how it sorts, and the heuristic is written to fail
 * only into wasted budget.
 *
 * @param input - The page's events, the window start, and the `per_page` asked for.
 * @returns `true` when this page can hold nothing further in-window.
 */
export function pageEndsWalk(input: {
    /** One page's events, in the order the response carried them. */
    readonly events: readonly PollItemEvent[];
    /** Window start, or `null` for a replay scan. */
    readonly windowStart: string | null;
    /** The `per_page` this walk asked for. */
    readonly perPage: number;
}): boolean {
    return input.events.length < input.perPage
        || input.events.every((event) => !stampInWindow(event.createdAt, input.windowStart));
}

/** What the correlation needs to decide whether one row answers a candidate. */
interface CorrelationInput {
    /** Which trigger kind the candidate is. */
    readonly kind: ItemCandidateKind;
    /** The bound account the **subject** field must name. */
    readonly boundLogin: string;
    /** The item being scanned, so a row about another item cannot answer it. */
    readonly issueNumber: number;
    /** Window start, or `null` for a replay scan. */
    readonly windowStart: string | null;
}

/**
 * Decide whether one event qualifies as the answer to a candidate (FR-050).
 *
 * Four filters, in the order they can refuse: the kind word, the item the row
 * says it belongs to, the window, and the **subject** the bound account must be
 * named by. The event word alone is not the filter — `unassigned`, `closed`,
 * `labeled`, `referenced`, and `head_ref_deleted` are all kinds this endpoint
 * returns, and none of them is an answer.
 *
 * @param input - The candidate's kind, bound account, item number, and window.
 * @param event - One normalized event row.
 * @returns `true` when this row is the evidence for that candidate.
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
 * Pick the one event that answers a candidate, if any does (FR-050, FR-051).
 *
 * Selection is by **greatest `created_at`** among the qualifying rows and never
 * by position in the response, so a feed that answers newest-first,
 * oldest-first, or interleaved produces the same actor. A bulk assignment that
 * touches the bound account twice inside one window is defined for by the same
 * rule.
 *
 * @param events - Every event the walk saw, in page order.
 * @param input - The candidate's kind, bound account, item number, and window.
 * @returns The answering event, or `null` when none of them qualifies.
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

/** What reading the actor off one qualifying event found. */
export type EventActor =
    | { readonly usable: true; readonly login: string }
    | { readonly usable: false; readonly reason: 'unreadable-actor' | 'bot-actor' };

/**
 * Read the actor one qualifying event records (FR-050, FR-052).
 *
 * The field is the one the **kind** names — `assigner` for an assignment,
 * `review_requester` for a review request — and never `actor`, never the issue
 * author, never the `assignee` beside it, and never an actor recorded earlier
 * for the same item. Those four substitutes each record a guess as a fact, and
 * each was reachable in the build this correction replaces; the shape has no
 * member for the first and the code reaches for none of them.
 *
 * @param input - The candidate's kind and the event that answered it.
 * @returns The bounded login, or the reason there is none.
 */
export function actorOfNamingEvent(input: {
    /** Which trigger kind the candidate is. */
    readonly kind: ItemCandidateKind;
    /** The event that qualified. */
    readonly event: PollItemEvent;
}): EventActor {
    const named = input.kind === 'assignment' ? input.event.assigner : input.event.reviewRequester;
    if (!isAttributableAuthor(named.login, named.type)) {
        return { usable: false, reason: named.login === '' ? 'unreadable-actor' : 'bot-actor' };
    }

    return { usable: true, login: actorLoginOf(named.login) };
}

/** Everything {@link resolveCandidateActor} needs, including what it records on. */
interface CandidateRequest {
    /** Poller the read is issued through. */
    readonly poller: GitHubIssuePoller;
    /** Logger every no-event answer is recorded on. */
    readonly log: ServiceLogger;
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** The repository the item lives in. */
    readonly repository: RepositoryRef;
    /** The item's number — an issue's or a pull request's. */
    readonly issueNumber: number;
    /** Which trigger kind the candidate is. */
    readonly kind: ItemCandidateKind;
    /** The bound account, as the account record reports it. */
    readonly boundLogin: string;
    /** Window start, or `null` for a replay scan. */
    readonly windowStart: string | null;
    /** Page size and retry ladder this cycle's reads run under. */
    readonly pace: ListPace;
}

/**
 * Record the two ways this cycle produces no event for a matched candidate.
 *
 * Both are **recorded** rather than dropped in silence, because an operator must
 * be able to explain a missing trigger (constitution IV) and because neither
 * leaves anything behind in the queue for a later gate to guess about (FR-052).
 * The scan window overlaps, so the candidate is re-detected next cycle: refusing
 * costs at most one cycle of latency.
 *
 * @param input - The request, the log-safe path of the item, and the reason.
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
 * Resolve the actor for one detected candidate — the whole of FR-049's read,
 * FR-050's correlation, FR-051's window, and FR-052's refusal, in one call.
 *
 * The two ways this answers "nothing" are deliberately different outcomes:
 *
 * - **refused / exhausted** — the read worked and there is no honest actor: no
 *   qualifying event in the window, an actor `null`/empty/bot, or the page bound
 *   reached with nothing qualifying. The candidate is dropped for this cycle, the
 *   reason is logged, and the overlapping window re-detects it — which is why
 *   this is a refusal rather than a loss (FR-052).
 * - **failed** — the *read itself* failed, and this escapes so the caller can
 *   treat it exactly as it treats a list failure: the binding's scan is skipped,
 *   its checkpoint is **retained** rather than advanced, and its `lastError` names
 *   the class. Dropping only the candidate would instead advance the window past
 *   an assignment nobody ever attributed, leaving the operator with no event, no
 *   row, no reason, and a checkpoint that has already moved on.
 *
 * @param request - The candidate, the poller, the credential, and the window.
 * @returns The actor, one of the two recorded no-event answers, or a failure.
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
