/**
 * The bounded backward `pulls/{n}/reviews` walk (FR-121).
 */

import { readReviewEntry } from './poller-entries.ts';
import { listUrl, readOnePage } from './poller-transport.ts';
import type { ListPace, PageRead, PollFailure, PollerRuntime } from './poller-transport.ts';
import type { PollReview } from './poller-entries.ts';

/** Credential, coordinates, window and pace one reviews read runs under. */
export interface PullReviewsQuery {
    readonly token: string;
    readonly owner: string;
    readonly name: string;
    readonly pullNumber: number;
    /** Window start; a review dated earlier than it ends the walk. */
    readonly windowStart: string;
    readonly pace: ListPace;
}

/** One candidate's reviews, or the class that ended the read. */
export type PullReviewsOutcome =
    | PollFailure
    | { readonly kind: 'ok'; readonly reviews: readonly PollReview[]; readonly truncated: boolean };

/** Content pages one candidate may cost, after the discovery request. */
const MAX_REVIEW_CONTENT_PAGES = 2;

/**
 * Whether every readable review on a page is inside the window.
 *
 * An undated or unreadable review cannot prove the page reaches older than the
 * window, so it does not stop the backward walk; only a readable stamp earlier
 * than the window start does.
 */
function entirelyInWindow(reviews: readonly PollReview[], windowStart: string): boolean {
    const start = Date.parse(windowStart);

    return reviews.every((review) => {
        if (review.submittedAt === null) {
            return true;
        }

        const submitted = Date.parse(review.submittedAt);

        return !Number.isFinite(submitted) || submitted >= start;
    });
}

/**
 * Read one page of one candidate's reviews.
 */
async function readPage(input: {
    readonly runtime: PollerRuntime;
    readonly query: PullReviewsQuery;
    readonly url: URL;
    readonly page: number;
}): Promise<PageRead<PollReview>> {
    input.url.searchParams.set('page', String(input.page));
    input.url.searchParams.set('per_page', String(input.query.pace.perPage));

    return await readOnePage({
        runtime: input.runtime,
        token: input.query.token,
        url: input.url,
        pace: input.query.pace,
        message: 'review list response was not an array',
        read: readReviewEntry,
    });
}

/**
 * Walk backwards from the last page, at most two content pages.
 *
 * Advancing only while the page just read is entirely in-window and is not
 * page 1 is what makes an under-filled newest page a normal tail rather than a
 * stop. Truncation is two content pages read with the older still entirely
 * inside the window and not page 1.
 */
async function walkBackward(input: {
    readonly runtime: PollerRuntime;
    readonly query: PullReviewsQuery;
    readonly url: URL;
    readonly lastPage: number;
    readonly discoveryItems: readonly PollReview[];
}): Promise<PullReviewsOutcome> {
    let pageNumber = input.lastPage;
    let page: PageRead<PollReview> = input.lastPage === 1
        ? { kind: 'ok', items: input.discoveryItems, lastPage: input.lastPage }
        : await readPage({ runtime: input.runtime, query: input.query, url: input.url, page: pageNumber });
    if (page.kind !== 'ok') {
        return page;
    }

    const reviews = [...page.items];
    let contentPages = 1;
    while (pageNumber !== 1
        && contentPages < MAX_REVIEW_CONTENT_PAGES
        && entirelyInWindow(page.items, input.query.windowStart)) {
        pageNumber -= 1;
        page = await readPage({ runtime: input.runtime, query: input.query, url: input.url, page: pageNumber });
        if (page.kind !== 'ok') {
            return page;
        }

        reviews.unshift(...page.items);
        contentPages += 1;
    }

    const isTruncated = pageNumber !== 1
        && contentPages === MAX_REVIEW_CONTENT_PAGES
        && entirelyInWindow(page.items, input.query.windowStart);

    return { kind: 'ok', reviews: isTruncated ? [] : reviews, truncated: isTruncated };
}

/**
 * Read one candidate pull request's reviews, newest page first.
 *
 * One discovery request reads `Link: rel="last"`; the walk then reads that last
 * page (the discovery answer when it is page 1) and at most one page before it.
 * A page that straddles the window start is read and its in-window reviews
 * taken. A full page 1 with no usable link is truncation, never a walk guessed
 * forward.
 */
export async function readPullReviews(
    runtime: PollerRuntime,
    query: PullReviewsQuery,
): Promise<PullReviewsOutcome> {
    const url = listUrl({
        owner: query.owner,
        name: query.name,
        path: `pulls/${query.pullNumber}/reviews`,
        query: {},
        since: null,
    });

    const discovery = await readPage({ runtime, query, url, page: 1 });
    if (discovery.kind !== 'ok') {
        return discovery;
    }

    if (discovery.lastPage === null) {
        return discovery.items.length < query.pace.perPage
            ? { kind: 'ok', reviews: discovery.items, truncated: false }
            : { kind: 'ok', reviews: [], truncated: true };
    }

    return await walkBackward({
        runtime,
        query,
        url,
        lastPage: discovery.lastPage,
        discoveryItems: discovery.items,
    });
}
