/**
 * The Dispatches tab's page and filter controls (005 FR-042, FR-043).
 *
 * The list itself is read by `dispatches.ts`; this module owns the six ways an
 * operator changes *which* page is being read — next, previous, page size,
 * binding filter, state filter, and clearing both. Each moves the position
 * first and then reads, and the two that can step mid-set roll the position
 * back when the read fails, so a refused page leaves the operator where the
 * last successful read put them rather than on one the panel cannot show
 * (FR-019, FR-042).
 *
 * A filter or page-size change always resets to page one of the set it
 * describes: a position carried across the change would describe rows the new
 * set does not contain (data-model §3.2).
 */

import { refresh } from './panel-ui.ts';
import {
    advanceDispatchPage,
    dispatchListPageAt,
    resetDispatchListPage,
    retreatDispatchPage,
} from './dispatch-page.ts';
import { loadDispatches } from './dispatches.ts';
import type { PanelRuntime } from './panel-state.ts';

/**
 * Step one page forward and read it (FR-042).
 *
 * The position is rolled back when the read fails, so a refused page leaves
 * the operator exactly where the last successful read put them rather than
 * stranding them on a page the panel cannot show (FR-019).
 *
 * @param rt - Panel runtime.
 */
export async function nextPage(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    if (!runs.page.hasMore || runs.page.nextCursor === null) {
        return;
    }

    const before = runs.page;
    runs.page = advanceDispatchPage(runs.page);
    await loadDispatches(rt);
    if (runs.status === 'error') {
        runs.page = before;
        refresh(rt);
    }
}

/**
 * Step one page back and read it (FR-042).
 *
 * @param rt - Panel runtime.
 */
export async function previousPage(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    if (runs.page.pageIndex === 0) {
        return;
    }

    const before = runs.page;
    runs.page = retreatDispatchPage(runs.page);
    await loadDispatches(rt);
    if (runs.status === 'error') {
        runs.page = before;
        refresh(rt);
    }
}

/**
 * Change the page size, taking the operator to page one of the same set.
 *
 * @param rt - Panel runtime.
 * @param limit - The new page size.
 */
export function setPageLimit(rt: PanelRuntime, limit: number): void {
    const { dispatches: runs } = rt.state;
    runs.page = dispatchListPageAt(limit);
    void loadDispatches(rt);
}

/**
 * Filter the set by binding, server-side (FR-043).
 *
 * @param rt - Panel runtime.
 * @param bindingId - Binding to filter to, or `null` for every binding.
 */
export function setBindingFilter(rt: PanelRuntime, bindingId: string | null): void {
    const { dispatches: runs } = rt.state;
    runs.filters = { ...runs.filters, bindingId };
    runs.page = resetDispatchListPage(runs.page);
    void loadDispatches(rt);
}

/**
 * Filter the set by state, server-side (FR-043).
 *
 * @param rt - Panel runtime.
 * @param state - State token (or the `blocked` family) to filter to, or `null`.
 */
export function setStateFilter(rt: PanelRuntime, state: string | null): void {
    const { dispatches: runs } = rt.state;
    runs.filters = { ...runs.filters, state };
    runs.page = resetDispatchListPage(runs.page);
    void loadDispatches(rt);
}

/**
 * Clear both filters and return to the first page of the whole set (FR-043).
 *
 * @param rt - Panel runtime.
 */
export function clearFilters(rt: PanelRuntime): void {
    const { dispatches: runs } = rt.state;
    runs.filters = { bindingId: null, state: null };
    runs.page = resetDispatchListPage(runs.page);
    void loadDispatches(rt);
}
