/**
 * GitHub poller for the service loop (M1 re-cut, the "small poller client"
 * the cut allows on top of the credential verifier), extended in Slice 2 for
 * the M6 mention and M7 review-request triggers, and at 002 v1.12.0 for the
 * per-item actor read.
 *
 * **This module is the catalogue of endpoints; it is not the transport.** How a
 * request is made, retried, and classified lives beside it in
 * [`poller-transport.ts`](./poller-transport.ts), and the per-row readers for
 * the three list feeds live in [`poller-entries.ts`](./poller-entries.ts). What
 * is left here is what only this module can answer: which endpoints the scan
 * calls, what query each sends, and what each returns.
 *
 * Four of them:
 *
 * - `GET /repos/:owner/:name/issues` (`state=open`, `sort=updated`), the M1
 *   assignment scan and the mention scan's issue-body pass;
 * - `GET /repos/:owner/:name/issues/comments` (`sort=updated`), the M6
 *   comment scan that looks for `@<login>`;
 * - `GET /repos/:owner/:name/pulls` (`state=open`, `sort=updated`), the M7
 *   review-request scan;
 * - `GET /repos/:owner/:name/issues/:number/events`, the item's own event list,
 *   which is where GitHub records **who assigned an issue and who requested a
 *   review** (002 FR-049).
 *
 * And two single-item object reads, **not** list feeds — the one read the
 * tracking lifecycle adds (002 FR-106):
 *
 * - `GET /repos/:owner/:name/issues/:number`, whose `state` / `state_reason` /
 *   `closed_at` answer an issue's terminal state;
 * - `GET /repos/:owner/:name/pulls/:number`, whose `state` / `merged` /
 *   `merged_at` answer a pull's — the only row that carries `merged` at all.
 *
 * Each single-item read is issued **only** for a tracked subject that produced a
 * detected follow-up this cycle, at most once per subject per cycle, never per
 * subject per cycle and never repository-wide (FR-102): both list feeds above are
 * filtered `state=open`, so a concluded item *leaves* them rather than arriving
 * on one, which is why the end of tracking can only be observed here.
 * Neither sends `per_page` or `page`; each answers with one object.
 *
 * The fourth is deliberately unlike the other three. It is read **once per
 * matched candidate item** and never repository-wide, because a repository-wide
 * or timeline read would cost a request on every cycle whether or not anything
 * matched; and it sends `per_page` and `page` **only** — GitHub's OpenAPI
 * description accepts exactly those two on this path, so the scan window has to
 * be a client-side comparison on `created_at` rather than a `since` parameter
 * (002 FR-051). Its rules live in [`poller-events.ts`](./poller-events.ts); this
 * module owns only the URL and the page walk.
 *
 * Every list reads at most two pages of the configured size, newest-updated
 * first, so one binding's scan stays inside its rate budget; the page size and
 * the bounded retry ladder arrive per call from the cycle's configuration (006
 * FR-058, FR-059). Failures are classified at the transport boundary and no
 * upstream text ever leaves this module: the loop turns the class into a skip.
 */

import { API_ORIGIN } from '../github.ts';
import type { FetchLike } from '../github.ts';
import { ITEM_EVENT_MAX_PAGES, pageEndsWalk, readItemEventEntry } from './poller-events.ts';
import type { ItemEventsOutcome, ItemEventsQuery, PollItemEvent } from './poller-events.ts';
import { listPages, listUrl, pollerRuntime, readOneObject, readOnePage } from './poller-transport.ts';
import type { ListPace, PagedList, PollFailure, PollerDeps, PollerRuntime } from './poller-transport.ts';
import { readCommentEntry, readIssueEntry, readIssueObject, readPullEntry, readPullObject } from './poller-entries.ts';
import type { PollComment, PollIssue, PollPull } from './poller-entries.ts';

/** Entry shapes re-exported so callers keep one import path for the poller. */
export type { PollComment, PollIssue, PollPull };

/** Pace, failure class, and injectables re-exported for one import path. */
export type { ListPace, PollFailure, PollerDeps };

/** Newest-updated first, so a scan window sees fresh activity first. */
const NEWEST_UPDATED_FIRST = { sort: 'updated', direction: 'desc' } as const;

/** Outcome of one issues-list call (classified at the boundary, like `verify`). */
export type IssueListOutcome = PollFailure | { readonly kind: 'ok'; readonly issues: readonly PollIssue[] };

/** Outcome of one issue-comments-list call. */
export type CommentListOutcome = PollFailure | { readonly kind: 'ok'; readonly comments: readonly PollComment[] };

/** Outcome of one pulls-list call. */
export type PullListOutcome = PollFailure | { readonly kind: 'ok'; readonly pulls: readonly PollPull[] };

/** Outcome of the single-item issue terminal read (002 FR-106). */
export type IssueStateOutcome = PollFailure | { readonly kind: 'ok'; readonly issue: PollIssue };

/** Outcome of the single-item pull terminal read (002 FR-106). */
export type PullStateOutcome = PollFailure | { readonly kind: 'ok'; readonly pull: PollPull };

/** Credential, repository, and the `since` window a windowed list takes. */
interface WindowedListQuery {
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Repository owner. */
    readonly owner: string;
    /** Repository name. */
    readonly name: string;
    /**
     * Window start, sent as `since`.
     *
     * A `string` since v1.13.0, not `string | null`: every scan now opens at a
     * computable lower bound (002 FR-065), so a windowed list always carries one
     * and "send no `since` at all" is no longer a state a caller can reach
     * (plan H11).
     */
    readonly since: string;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
}

/** Credential and repository for a list that has no `since` window (pulls). */
interface RepoListQuery {
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Repository owner. */
    readonly owner: string;
    /** Repository name. */
    readonly name: string;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
}

/** Credential, coordinates, and pace for a single-item terminal read (002 FR-106). */
interface ItemStateQuery {
    /** Account credential presented to GitHub. */
    readonly token: string;
    /** Repository owner. */
    readonly owner: string;
    /** Repository name. */
    readonly name: string;
    /** The issue or pull-request number; one repository, one numbering space. */
    readonly itemNumber: number;
    /** Page size and retry ladder this call runs under. */
    readonly pace: ListPace;
}

/** The surface the poll loop drives. */
export interface GitHubIssuePoller {
    /**
     * List the open issues of one repository, newest-updated first.
     *
     * @param query - Token, repository, optional `since` filter.
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listOpenIssues(query: WindowedListQuery): Promise<IssueListOutcome>;

    /**
     * List the issue comments of one repository, newest-updated first (M6).
     *
     * @param query - Token, repository, optional `since` filter.
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listIssueComments(query: WindowedListQuery): Promise<CommentListOutcome>;

    /**
     * List the open pull requests of one repository, newest-updated first (M7).
     *
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listOpenPulls(query: RepoListQuery): Promise<PullListOutcome>;

    /**
     * Read **one item's** own event list — the per-item events feed, and the
     * only read that names who assigned an issue or requested a review (002
     * FR-049).
     *
     * Called **once per matched candidate item**, never for a whole repository
     * and never through the timeline, so a cycle in which nothing matched costs
     * zero requests. It sends `per_page` and `page` only: this
     * endpoint has no `since` parameter, so the caller's window is compared
     * against `created_at` here rather than sent.
     *
     * @returns The events read plus whether the page bound was reached, or the
     *   classified failure; upstream detail never escapes as text.
     */
    listIssueEvents(query: ItemEventsQuery): Promise<ItemEventsOutcome>;

    /**
     * Read **one issue's** own object for its terminal state (002 FR-106).
     *
     * Both list feeds the scan reads are filtered `state=open`, so a concluded
     * issue *leaves* the list rather than arriving on it — this single-item read
     * is the only source that can observe an issue's `state` / `state_reason` /
     * `closed_at`. It is the one read the tracking lifecycle adds, and it is lazy:
     * issued **only** for a tracked subject that produced a detected follow-up
     * this cycle, at most **once per subject per cycle**, never per subject per
     * cycle and never repository-wide (FR-102). One object, one request, no page
     * walk (`research.md` §R12.5).
     *
     * @returns The issue with its terminal members, or the classified failure;
     *   upstream detail never escapes as text.
     */
    readIssueState(query: ItemStateQuery): Promise<IssueStateOutcome>;

    /**
     * Read **one pull request's** own object for its terminal state (FR-106).
     *
     * The pulls list returns `Pull Request Simple`, which carries `merged_at` but
     * **no** `merged` — so a concluded pull leaves the `state=open` list with no
     * row that can say *merged* at all. The single-pull object carries `merged`
     * as a required boolean, so this is the only row that answers a merged pull
     * from a closed-unmerged one. Bounded and issued exactly as
     * {@link readIssueState}.
     *
     * @returns The pull with its terminal members, or the classified failure;
     *   upstream detail never escapes as text.
     */
    readPullState(query: ItemStateQuery): Promise<PullStateOutcome>;
}

/**
 * Run the M1 issue list and answer it under the field the interface promises.
 *
 * @param runtime - Transport plus the poller's injectables.
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function issuesList(runtime: PollerRuntime, query: WindowedListQuery): Promise<IssueListOutcome> {
    const result = await listPages({
        runtime,
        pace: query.pace,
        token: query.token,
        url: listUrl({
            owner: query.owner,
            name: query.name,
            path: 'issues',
            query: { state: 'open', ...NEWEST_UPDATED_FIRST },
            since: query.since,
        }),
        message: 'issue list response was not an array',
        read: readIssueEntry,
    });

    return result.kind === 'ok' ? { kind: 'ok', issues: result.items } : result;
}

/**
 * Run the M6 issue-comments list and answer it under its promised field.
 *
 * @param runtime - Transport plus the poller's injectables.
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function commentsList(runtime: PollerRuntime, query: WindowedListQuery): Promise<CommentListOutcome> {
    const result = await listPages({
        runtime,
        pace: query.pace,
        token: query.token,
        url: listUrl({
            owner: query.owner,
            name: query.name,
            path: 'issues/comments',
            query: { ...NEWEST_UPDATED_FIRST },
            since: query.since,
        }),
        message: 'issue comment list response was not an array',
        read: readCommentEntry,
    });

    return result.kind === 'ok' ? { kind: 'ok', comments: result.items } : result;
}

/**
 * Run the M7 pulls list and answer it under its promised field.
 *
 * @param runtime - Transport plus the poller's injectables.
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function pullsList(runtime: PollerRuntime, query: RepoListQuery): Promise<PullListOutcome> {
    const result = await listPages({
        runtime,
        pace: query.pace,
        token: query.token,
        url: listUrl({
            owner: query.owner,
            name: query.name,
            path: 'pulls',
            query: { state: 'open', ...NEWEST_UPDATED_FIRST },
            since: null,
        }),
        message: 'pull list response was not an array',
        read: readPullEntry,
    });

    return result.kind === 'ok' ? { kind: 'ok', pulls: result.items } : result;
}

/**
 * Build the per-item events URL.
 *
 * The query string carries **`per_page` and `page` and nothing else**, which is
 * not a style choice: GitHub's own OpenAPI description for this path accepts
 * exactly those two, so a `since` parameter would be silently ignored rather
 * than honoured, and a window applied server-side would be a fiction. This is
 * why it does **not** go through {@link listUrl}, whose `since` parameter exists
 * for the two list feeds that genuinely accept one. The scan window is therefore
 * a **client-side comparison on `created_at`**, made by `poller-events.ts`.
 *
 * @returns The request URL, before paging parameters are set.
 */
function itemEventsUrl(input: { readonly owner: string; readonly name: string; readonly issueNumber: number }): URL {
    return new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/issues/${input.issueNumber}/events`);
}

/**
 * Read one item's event list, page by page (002 FR-049 – FR-051).
 *
 * The walk stops on a page that **under-fills its cap** — GitHub's own "no more
 * pages" answer — or on a page whose events are **all** older than the window
 * start, which is the one-directional rule that makes a wrong assumption about
 * GitHub's ordering cost budget rather than visibility. Reaching
 * {@link ITEM_EVENT_MAX_PAGES} without either is reported as `exhausted` rather
 * than as a completed read: the caller may be holding events this walk never
 * saw, and a candidate with nothing qualifying among them must produce **no**
 * event rather than one attributed from a partial list.
 *
 * @param runtime - Transport plus the poller's injectables.
 * @returns The events the walk saw, whether it exhausted its bound, or the class.
 */
async function itemEventsList(runtime: PollerRuntime, query: ItemEventsQuery): Promise<ItemEventsOutcome> {
    const url = itemEventsUrl({ owner: query.owner, name: query.name, issueNumber: query.issueNumber });
    const input = {
        runtime,
        token: query.token,
        url,
        pace: query.pace,
        message: 'issue events response was not an array',
        read: readItemEventEntry,
    };
    const events: PollItemEvent[] = [];

    for (let page = 1; page <= ITEM_EVENT_MAX_PAGES; page += 1) {
        url.searchParams.set('page', String(page));
        url.searchParams.set('per_page', String(query.pace.perPage));

        const parsed: PagedList<PollItemEvent> = await readOnePage(input);
        if (parsed.kind !== 'ok') {
            return parsed;
        }

        events.push(...parsed.items);
        if (pageEndsWalk({ events: parsed.items, windowStart: query.windowStart, perPage: query.pace.perPage })) {
            return { kind: 'ok', events, exhausted: false };
        }
    }

    return { kind: 'ok', events, exhausted: true };
}

/** Build the single-item issue terminal-read URL (`GET …/issues/{itemNumber}`). */
function issueStateUrl(input: { readonly owner: string; readonly name: string; readonly itemNumber: number }): URL {
    return new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/issues/${input.itemNumber}`);
}

/** Build the single-item pull terminal-read URL (`GET …/pulls/{itemNumber}`). */
function pullStateUrl(input: { readonly owner: string; readonly name: string; readonly itemNumber: number }): URL {
    return new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/pulls/${input.itemNumber}`);
}

/**
 * Read one issue's own object for its terminal state (002 FR-106).
 *
 * `GET /issues/{number}` answers with the Issue object a list row is — the one
 * whose `state=open` filter a closed issue leaves — so the reader is the same
 * {@link readIssueEntry} shape the list reader takes, over one object. No
 * `since`, no `page`, no `per_page`: this is not a walk, it is one object under
 * the shared transport.
 *
 * @returns The issue with its terminal members, or the classified failure.
 */
async function issueStateObject(runtime: PollerRuntime, query: ItemStateQuery): Promise<IssueStateOutcome> {
    const result = await readOneObject({
        runtime,
        token: query.token,
        url: issueStateUrl({ owner: query.owner, name: query.name, itemNumber: query.itemNumber }),
        pace: query.pace,
        read: readIssueObject,
    });

    return result.kind === 'ok' ? { kind: 'ok', issue: result.object } : result;
}

/**
 * Read one pull request's own object for its terminal state (002 FR-106).
 *
 * `GET /pulls/{number}` answers with the full Pull Request object — the one that
 * carries `merged` — which the pulls **list**'s `Pull Request Simple` does not,
 * so this is the only row that can tell a merged pull from a closed-unmerged one
 * and the only row a concluded pull can be observed on at all.
 *
 * @returns The pull with its terminal members, or the classified failure.
 */
async function pullStateObject(runtime: PollerRuntime, query: ItemStateQuery): Promise<PullStateOutcome> {
    const result = await readOneObject({
        runtime,
        token: query.token,
        url: pullStateUrl({ owner: query.owner, name: query.name, itemNumber: query.itemNumber }),
        pace: query.pace,
        read: readPullObject,
    });

    return result.kind === 'ok' ? { kind: 'ok', pull: result.object } : result;
}

/**
 * Create the GitHub client the poll loop uses.
 *
 * @param deps - Logger every wait is reported through, plus the optional
 *   injected `sleep` and `random` a deterministic test supplies.
 * @param fetchImpl - Injectable `fetch`; defaults to the process global so
 *   production uses Node's built-in client and tests supply a fake.
 * @returns The poller bound to that transport and those injectables.
 */
export function createGitHubIssuePoller(
    deps: PollerDeps,
    fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
): GitHubIssuePoller {
    const runtime = pollerRuntime(deps, fetchImpl);

    return {
        listOpenIssues: (query) => issuesList(runtime, query),
        listIssueComments: (query) => commentsList(runtime, query),
        listOpenPulls: (query) => pullsList(runtime, query),
        listIssueEvents: (query) => itemEventsList(runtime, query),
        readIssueState: (query) => issueStateObject(runtime, query),
        readPullState: (query) => pullStateObject(runtime, query),
    };
}
