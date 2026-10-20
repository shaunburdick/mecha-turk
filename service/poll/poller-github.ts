/**
 * GitHub poller for the service loop: the catalogue of endpoints the scan
 * calls, the query each sends, and what each returns (002 FR-049, FR-051;
 * 006 FR-058, FR-059).
 */

import { API_ORIGIN } from '../github.ts';
import type { FetchLike } from '../github.ts';
import { ITEM_EVENT_MAX_PAGES, pageEndsWalk, readItemEventEntry } from './poller-events.ts';
import type { ItemEventsOutcome, ItemEventsQuery, PollItemEvent } from './poller-events.ts';
import { listPages, listUrl, pollerRuntime, readOneObject, readOnePage } from './poller-transport.ts';
import type { ListPace, PagedList, PollFailure, PollerDeps, PollerRuntime } from './poller-transport.ts';
import {
    readCommentEntry,
    readIssueEntry,
    readIssueObject,
    readPullEntry,
    readPullObject,
    readReviewCommentEntry,
} from './poller-entries.ts';
import type { PollComment, PollIssue, PollPull, PollReviewComment } from './poller-entries.ts';

/** Entry shapes re-exported so callers keep one import path for the poller. */
export type { PollComment, PollIssue, PollPull, PollReviewComment } from './poller-entries.ts';

/** Pace, failure class, and injectables re-exported for one import path. */
export type { ListPace, PollFailure, PollerDeps };

/** Newest-updated first, so a scan window sees fresh activity first. */
const NEWEST_UPDATED_FIRST = { sort: 'updated', direction: 'desc' } as const;

/** Outcome of one issues-list call (classified at the boundary, like `verify`). */
export type IssueListOutcome = PollFailure | { readonly kind: 'ok'; readonly issues: readonly PollIssue[] };

export type CommentListOutcome = PollFailure | { readonly kind: 'ok'; readonly comments: readonly PollComment[] };

export type ReviewCommentListOutcome =
    PollFailure | { readonly kind: 'ok'; readonly comments: readonly PollReviewComment[] };

export type PullListOutcome = PollFailure | { readonly kind: 'ok'; readonly pulls: readonly PollPull[] };

/** Outcome of the single-item issue terminal read (002 FR-106). */
export type IssueStateOutcome = PollFailure | { readonly kind: 'ok'; readonly issue: PollIssue };

/** Outcome of the single-item pull terminal read (002 FR-106). */
export type PullStateOutcome = PollFailure | { readonly kind: 'ok'; readonly pull: PollPull };

/** Credential, repository, and the `since` window a windowed list takes. */
interface WindowedListQuery {
    readonly token: string;
    readonly owner: string;
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
    readonly pace: ListPace;
}

/** Credential and repository for a list that has no `since` window (pulls). */
interface RepoListQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
    readonly pace: ListPace;
}

/** Credential, coordinates, and pace for a single-item terminal read (002 FR-106). */
interface ItemStateQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
    /** The issue or pull-request number; one repository, one numbering space. */
    readonly itemNumber: number;
    readonly pace: ListPace;
}

export interface GitHubIssuePoller {
    /**
     * List the open issues of one repository, newest-updated first.
     *
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listOpenIssues(query: WindowedListQuery): Promise<IssueListOutcome>;

    /**
     * List the issue comments of one repository, newest-updated first (M6).
     *
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listIssueComments(query: WindowedListQuery): Promise<CommentListOutcome>;

    /**
     * List the pull-request **review comments** of one repository, newest
     * updated first (FR-111). Inline review comments live on this feed,
     * not on `issues/comments`: a mention or a movement in one is invisible
     * to the conversation-comment read. One repository-wide, `since`-windowed
     * call per cycle, issued only for a binding whose mention switch is on.
     */
    listReviewComments(query: WindowedListQuery): Promise<ReviewCommentListOutcome>;

    /**
     * List the open pull requests of one repository, newest-updated first (M7).
     *
     * @returns The classified outcome; upstream detail never escapes as text.
     */
    listOpenPulls(query: RepoListQuery): Promise<PullListOutcome>;

    /**
     * Read **one item's** own event list — the per-item events feed, and the
     * only read that names who assigned an issue or requested a review (002
     * FR-049). Called once per matched candidate, never repository-wide and
     * never through the timeline, so a cycle in which nothing matched costs
     * zero requests; it sends `per_page` and `page` only, because the endpoint
     * has no `since` and the caller's window is compared against `created_at`
     * here.
     */
    listIssueEvents(query: ItemEventsQuery): Promise<ItemEventsOutcome>;

    /**
     * Read **one issue's** own object for its terminal state (002 FR-106).
     * Both list feeds the scan reads are filtered `state=open`, so a concluded
     * issue *leaves* the list rather than arriving on it — this single-item
     * read is the only source that can observe its `state` / `state_reason` /
     * `closed_at`. It is the one read the tracking lifecycle adds, and it is
     * lazy: issued only for a tracked subject that produced a detected
     * follow-up this cycle, at most once per subject per cycle, never
     * repository-wide (FR-102). One object, one request, no page walk
     * (research §R12.5). Upstream detail never escapes as text.
     */
    readIssueState(query: ItemStateQuery): Promise<IssueStateOutcome>;

    /**
     * Read **one pull request's** own object for its terminal state (FR-106).
     * The pulls list is `Pull Request Simple` — `merged_at` but **no** `merged`
     * — so a concluded pull leaves the `state=open` list with no row that can
     * say *merged*; the single-pull object carries `merged` as a required
     * boolean, which is the only row that answers a merged pull from a
     * closed-unmerged one. Bounded and issued exactly as
     * {@link readIssueState}.
     */
    readPullState(query: ItemStateQuery): Promise<PullStateOutcome>;
}

/**
 * Run the M1 issue list and answer it under the field the interface promises.
 *
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
 * Run the pull-request review-comments list and answer it under its promised
 * field (FR-111).
 *
 * @returns The classified outcome; upstream detail never escapes as text.
 */
async function reviewCommentsList(runtime: PollerRuntime, query: WindowedListQuery): Promise<ReviewCommentListOutcome> {
    const result = await listPages({
        runtime,
        pace: query.pace,
        token: query.token,
        url: listUrl({
            owner: query.owner,
            name: query.name,
            path: 'pulls/comments',
            query: { ...NEWEST_UPDATED_FIRST },
            since: query.since,
        }),
        message: 'review comment list response was not an array',
        read: readReviewCommentEntry,
    });

    return result.kind === 'ok' ? { kind: 'ok', comments: result.items } : result;
}

/**
 * Run the M7 pulls list and answer it under its promised field.
 *
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
 * The query string carries **`per_page` and `page` and nothing else**,
 * which is not a style choice: GitHub's own OpenAPI description for this
 * path accepts exactly those two, so a `since` parameter would be silently
 * ignored rather than honoured and a server-side window would be a fiction.
 * This is why it does **not** go through {@link listUrl}, and why the scan
 * window is a **client-side comparison on `created_at`** made by
 * `poller-events.ts`.
 */
function itemEventsUrl(input: { readonly owner: string; readonly name: string; readonly issueNumber: number }): URL {
    return new URL(`${API_ORIGIN}/repos/${input.owner}/${input.name}/issues/${input.issueNumber}/events`);
}

/**
 * Read one item's event list, page by page (002 FR-049 – FR-051). The walk
 * stops on a page that under-fills its cap (GitHub's own *no more pages*) or
 * on a page whose events are **all** older than the window start — the
 * one-directional rule that makes a wrong ordering assumption cost budget
 * rather than visibility. Hitting {@link ITEM_EVENT_MAX_PAGES} reports
 * `exhausted`, never a completed read: a candidate with nothing qualifying
 * among unseen events must produce **no** event rather than one attributed
 * from a partial list.
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
 *
 * `GET /issues/{number}` answers with the Issue object a list row is — the one
 * whose `state=open` filter a closed issue leaves — so the reader is the same
 * {@link readIssueEntry} shape the list reader takes, over one object. No
 * `since`, no `page`, no `per_page`: this is not a walk, it is one object under
 * the shared transport.
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
 *
 * `GET /pulls/{number}` answers with the full Pull Request object — the one that
 * carries `merged` — which the pulls **list**'s `Pull Request Simple` does not,
 * so this is the only row that can tell a merged pull from a closed-unmerged one
 * and the only row a concluded pull can be observed on at all.
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
 */
export function createGitHubIssuePoller(
    deps: PollerDeps,
    fetchImpl: FetchLike = (url, init) => globalThis.fetch(url, init),
): GitHubIssuePoller {
    const runtime = pollerRuntime(deps, fetchImpl);

    return {
        listOpenIssues: (query) => issuesList(runtime, query),
        listIssueComments: (query) => commentsList(runtime, query),
        listReviewComments: (query) => reviewCommentsList(runtime, query),
        listOpenPulls: (query) => pullsList(runtime, query),
        listIssueEvents: (query) => itemEventsList(runtime, query),
        readIssueState: (query) => issueStateObject(runtime, query),
        readPullState: (query) => pullStateObject(runtime, query),
    };
}
