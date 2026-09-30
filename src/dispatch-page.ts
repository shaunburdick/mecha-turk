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

/** Page size a fresh Dispatches list asks for (FR-042). */
export const DEFAULT_PAGE_SIZE = 25;

/** Middle page the Dispatches list offers (FR-042). */
const MID_PAGE_SIZE = 50;

/** Largest page the Dispatches list offers — the service's own cap (FR-042). */
export const MAX_PAGE_SIZE = 100;

/** Every page size the Dispatches list offers, smallest first (FR-042). */
export const DISPATCH_PAGE_SIZES = [MIN_PAGE_SIZE, DEFAULT_PAGE_SIZE, MID_PAGE_SIZE, MAX_PAGE_SIZE] as const;

/**
 * The server-side filters the Dispatches list applies (FR-043).
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
 * Where the operator is inside a filtered set (FR-042).
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
 * @returns Both filters off: the whole history, unfiltered (FR-043).
 */
export function initialDispatchFilters(): DispatchFilters {
    return { bindingId: null, state: null };
}

/**
 * Build the paging position a fresh Dispatches list starts at (FR-042).
 *
 * @returns The first page of the unfiltered set, reading nothing yet.
 */
export function initialDispatchListPage(): DispatchListPage {
    return {
        cursorStack: [null],
        pageIndex: 0,
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
 * new set does not contain (FR-042, FR-043).
 *
 * @param page - The position to reset; its `limit` is kept, its cursors are not.
 * @returns The first page of the new set.
 */
export function resetDispatchListPage(page: DispatchListPage): DispatchListPage {
    return { ...initialDispatchListPage(), limit: page.limit };
}
