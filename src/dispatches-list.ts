/**
 * The paged `GET /v1/events` answer: its rows and their page label (005 FR-042).
 *
 * Split from `dispatches-service.ts`, which owns the run DTO itself, because
 * the two readers have different failure rules: the DTO parser refuses a row
 * it cannot fully understand, and this one refuses an **answer** whose page
 * label is missing or out of contract — rows without a label would leave the
 * tab unable to say which range it is showing, and a label without rows would
 * let it claim a page it did not read (FR-042, FR-003).
 *
 * Everything mirrors [contracts/dispatch-list.md](../specs/005-panel-ia/contracts/dispatch-list.md):
 * the `events` array keeps its name and its newest-detected-first order, the
 * four accepted page sizes are the service's own, `total` may be `null` and
 * is never the page size by accident, and the `filter` echo is what the tab
 * shows as active rather than the panel's own assumption (FR-043). This is
 * also where the **query half** of that contract lives (`dispatchListPath`),
 * so asking for a page and reading it back sit in one module and cannot
 * drift apart.
 */

import { asRecord, parseJsonObject } from './json.ts';
import { cursorFor, DISPATCH_PAGE_SIZES } from './dispatch-page.ts';
import { EVENTS_PATH } from './service-calls.ts';
import { parseEventRows } from './dispatches-service.ts';
import type { DispatchFilters } from './dispatch-page.ts';
import type { DispatchesState } from './panel-state.ts';
import type { RunRow } from './dispatches-service.ts';

/** What the `page` member of a paged answer carries (005 contract §2). */
export interface DispatchPageMeta {
    /** Effective page size after defaulting. */
    readonly limit: number;
    /** Boundary token for the next page, or `null` at the end of the set. */
    readonly nextCursor: string | null;
    /** Whether a further page exists in the same filtered set. */
    readonly hasMore: boolean;
    /** Size of the filtered set, or `null` when the service withheld it. */
    readonly total: number | null;
    /** Label the service put on this read, so a refresh can be seen as one. */
    readonly snapshotAt: string;
    /** Filters the service actually applied, echoed back. */
    readonly filter: DispatchFilters;
}

/** One paged answer: the rows it carried and where it sits in the set. */
export interface DispatchListAnswer {
    /** Rows in the retained newest-detected-first order. */
    readonly rows: readonly RunRow[];
    /** The page metadata the answer was labelled with. */
    readonly page: DispatchPageMeta;
}

/**
 * Read the filter echo, which must name both members even when they are off.
 *
 * @param value - The `filter` member (unchecked).
 * @returns The applied filters, or `null` when the shape is wrong.
 */
function parseFilterEcho(value: unknown): DispatchFilters | null {
    const filter = asRecord(value);
    if (filter === null) {
        return null;
    }

    const { bindingId, state } = filter;
    if ((bindingId !== null && typeof bindingId !== 'string') || (state !== null && typeof state !== 'string')) {
        return null;
    }

    return { bindingId, state };
}

/**
 * Check the three members that bound the read itself.
 *
 * @param page - The `page` record.
 * @returns `true` when the size is one of the four the contract accepts, the
 *   boundary is a string or `null`, and the flag is a boolean.
 */
function pageBoundsUsable(page: Record<string, unknown>): boolean {
    const { limit, nextCursor, hasMore } = page;

    return typeof limit === 'number'
        && DISPATCH_PAGE_SIZES.includes(limit as (typeof DISPATCH_PAGE_SIZES)[number])
        && (nextCursor === null || typeof nextCursor === 'string')
        && typeof hasMore === 'boolean';
}

/**
 * Check the two members that label the answer.
 *
 * @param page - The `page` record.
 * @returns `true` when the total is a number or `null` and the stamp is a string.
 */
function pageLabelsUsable(page: Record<string, unknown>): boolean {
    const { total, snapshotAt } = page;

    return (total === null || typeof total === 'number') && typeof snapshotAt === 'string';
}

/**
 * Read the `page` member of a paged answer, fail closed (FR-042).
 *
 * @param value - The `page` member (unchecked).
 * @returns The metadata, or `null` when any member is missing or wrong.
 */
function parsePageMeta(value: unknown): DispatchPageMeta | null {
    const page = asRecord(value);
    if (page === null || !pageBoundsUsable(page) || !pageLabelsUsable(page)) {
        return null;
    }

    const filter = parseFilterEcho(page.filter);
    if (filter === null) {
        return null;
    }

    const { limit, nextCursor, hasMore, total, snapshotAt } = page;

    return {
        limit: limit as number,
        nextCursor: nextCursor as string | null,
        hasMore: hasMore as boolean,
        total: total as number | null,
        snapshotAt: snapshotAt as string,
        filter,
    };
}

/**
 * Parse the paged `GET /v1/events` answer as a whole (005 contract §2).
 *
 * @param text - Response body text.
 * @returns The rows and their page label, or `null` when either is unusable.
 */
export function parseDispatchListBody(text: string): DispatchListAnswer | null {
    const root = parseJsonObject(text);
    if (root === null) {
        return null;
    }

    const rows = parseEventRows(root.events);
    const page = parsePageMeta(root.page);
    if (rows === null || page === null) {
        return null;
    }

    return { rows, page };
}

/**
 * Build the query one paged read sends (005 contract §1).
 *
 * Every value the panel cannot stand behind is simply omitted: the cursor only
 * travels when the operator has stepped past page one, and a filter only when
 * it is on — so the barest call is still the closest analogue of an unfiltered
 * first page rather than a filter nobody chose (FR-042, FR-043).
 *
 * @param runs - The section's filters and paging position.
 * @returns `GET /v1/events` with this read's parameters.
 */
export function dispatchListPath(runs: DispatchesState): string {
    const params: string[] = [`limit=${runs.page.limit}`];
    const cursor = cursorFor(runs.page);
    if (cursor !== null) {
        params.push(`cursor=${encodeURIComponent(cursor)}`);
    }

    if (runs.filters.bindingId !== null) {
        params.push(`bindingId=${encodeURIComponent(runs.filters.bindingId)}`);
    }

    if (runs.filters.state !== null) {
        params.push(`state=${encodeURIComponent(runs.filters.state)}`);
    }

    return `${EVENTS_PATH}?${params.join('&')}`;
}
