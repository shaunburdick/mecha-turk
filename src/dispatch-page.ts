/**
 * The Dispatches list's paging state (005 FR-042, FR-043;
 * [data-model.md](../specs/005-panel-ia/data-model.md) §3.2).
 *
 * It lives beside the panel state rather than inside it because the page is a
 * small machine of its own: a cursor stack, an index, and two rules (a filter
 * or a page-size change resets; a failed read leaves the position alone). The
 * panel never persists any of it — it is per-mount working state, so a reopen
 * starts on Status with nothing to resume (FR-015).
 */

/** Smallest page the Dispatches list offers (FR-042). */
const MIN_PAGE_SIZE = 10;

/** Page size a fresh Dispatches list asks for. */
export const DEFAULT_PAGE_SIZE = 25;

/** Middle page the Dispatches list offers. */
const MID_PAGE_SIZE = 50;

/** Largest page the Dispatches list offers — the service's own cap (FR-042). */
export const MAX_PAGE_SIZE = 100;

/** Every page size the Dispatches list offers, smallest first. */
export const DISPATCH_PAGE_SIZES = [MIN_PAGE_SIZE, DEFAULT_PAGE_SIZE, MID_PAGE_SIZE, MAX_PAGE_SIZE] as const;

/**
 * The server-side filters the Dispatches list applies.
 *
 * Both are applied by the service, so a filter and a page always describe the
 * same set — the panel never filters a page and calls it a history.
 */
export interface DispatchFilters {
    /** Binding to show rows for, or `null` for every binding. */
    readonly bindingId: string | null;
    /** Exact state token (or the `blocked` family) to show, or `null`. */
    readonly state: string | null;
}

/**
 * Where the operator is inside a filtered set.
 *
 * The cursor stack is what makes **Previous** work without a backward cursor
 * from the service, and what lets an explicit refresh resume on the page the
 * operator was reading instead of resetting them to the first.
 */
export interface DispatchListPage {
    /** Cursor that produced each visited page; index 0 is the first page. */
    readonly cursorStack: (string | null)[];
    /** Which entry of `cursorStack` the operator is on. */
    readonly pageIndex: number;
    /** Boundary token the last answer supplied for the page after this one. */
    readonly nextCursor: string | null;
    /** Operator-selectable page size; one of {@link DISPATCH_PAGE_SIZES}. */
    readonly limit: number;
    /** Whether the last answer reported another page. */
    readonly hasMore: boolean;
    /** Size of the filtered set, or `null` when the service withheld it. */
    readonly total: number | null;
    /** Label the last answer carried, or `null` before the first read. */
    readonly snapshotAt: string | null;
}

/**
 * Build the empty server-side filter pair a fresh list starts with.
 *
 * @returns Both filters off: the whole history, unfiltered.
 */
export function initialDispatchFilters(): DispatchFilters {
    return { bindingId: null, state: null };
}

/**
 * Build the paging position a fresh Dispatches list starts at.
 *
 * @returns The first page of the unfiltered set, reading nothing yet.
 */
export function initialDispatchListPage(): DispatchListPage {
    return {
        cursorStack: [null],
        pageIndex: 0,
        nextCursor: null,
        limit: DEFAULT_PAGE_SIZE,
        hasMore: false,
        total: null,
        snapshotAt: null,
    };
}

/**
 * Reset a paging position back to the first page of a new set.
 *
 * A filter or a page-size change must take the operator to page one of the set
 * it describes — a position carried across the change would describe rows the
 * new set does not contain.
 *
 * @param page - The position to reset; its `limit` is kept, its cursors are not.
 * @returns The first page of the new set.
 */
export function resetDispatchListPage(page: DispatchListPage): DispatchListPage {
    return { ...initialDispatchListPage(), limit: page.limit };
}

/**
 * Build a paging position at a chosen page size (FR-042's operator select).
 *
 * @param limit - The new page size; unknown values fall back to the default
 *   rather than being sent to a service that would refuse them.
 * @returns The first page of the new set, at `limit`.
 */
export function dispatchListPageAt(limit: number): DispatchListPage {
    const accepted = DISPATCH_PAGE_SIZES.includes(limit as (typeof DISPATCH_PAGE_SIZES)[number]);

    return { ...initialDispatchListPage(), limit: accepted ? limit : DEFAULT_PAGE_SIZE };
}

/**
 * The cursor the next read should start from.
 *
 * `null` on page one; the stack entry the operator is standing on afterwards.
 * An explicit refresh resumes here rather than restarting the set.
 *
 * @param page - The position to read from.
 * @returns The cursor for the next read.
 */
export function cursorFor(page: DispatchListPage): string | null {
    return page.cursorStack[page.pageIndex] ?? null;
}

/**
 * Step one page forward, recording the boundary that produced it.
 *
 * The stack is truncated at the current index first, so stepping forward from
 * a page the operator backed up to abandons the tail they can no longer reach
 * — a stale cursor there would silently skip rows. A position
 * with no boundary to step to is left alone.
 *
 * @param page - The position to advance.
 * @returns The advanced position, or `page` when there is nothing to advance to.
 */
export function advanceDispatchPage(page: DispatchListPage): DispatchListPage {
    if (page.nextCursor === null) {
        return page;
    }

    const kept = page.cursorStack.slice(0, page.pageIndex + 1);

    return { ...page, cursorStack: [...kept, page.nextCursor], pageIndex: page.pageIndex + 1 };
}

/**
 * Step one page back; a no-op on the first page.
 *
 * @param page - The position to retreat.
 * @returns The previous position, or `page` when there is none.
 */
export function retreatDispatchPage(page: DispatchListPage): DispatchListPage {
    if (page.pageIndex === 0) {
        return page;
    }

    return { ...page, pageIndex: page.pageIndex - 1 };
}

/**
 * Record what the last answer said about the set.
 *
 * @param page - The position to annotate.
 * @param meta - The boundary for the next page, whether one exists, the set's
 *   size (or `null` when the service withheld it), and the answer's stamp.
 * @returns The annotated position.
 */
export function recordDispatchPageMeta(
    page: DispatchListPage,
    meta: {
        readonly nextCursor: string | null;
        readonly hasMore: boolean;
        readonly total: number | null;
        readonly snapshotAt: string;
    },
): DispatchListPage {
    return {
        ...page,
        nextCursor: meta.nextCursor,
        hasMore: meta.hasMore,
        total: meta.total,
        snapshotAt: meta.snapshotAt,
    };
}
