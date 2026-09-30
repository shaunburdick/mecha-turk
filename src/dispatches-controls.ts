/**
 * The Dispatches tab's paging, filter, and row-detail controls (005 FR-042,
 * FR-043, FR-048, FR-049, FR-081).
 *
 * `dispatches-ui.ts` owns the list, the action groups, the audit trail, and
 * the verification banner; this sibling owns everything an operator uses to
 * move *through* that list and to read one row: the range line, the two
 * server-side filters, Previous/Next, the page-size select, the
 * source-reference reveal, and the correlation-id copy. It is its own module
 * because the board is already close to the file-length cap, and a second
 * responsibility is exactly how a file goes over it.
 *
 * Everything operator-facing here is a **pure function of panel state** —
 * which range is showing, which filters are active, what the empty slot says
 * when a filter matched nothing, and the row-naming accessible names FR-081
 * asks for — so the copy is testable without a DOM (FR-086), and the mount
 * and repaint are thin applications of those strings.
 *
 * No control here talks to the service: the paging actions live in
 * `dispatches-paging.ts` and the row actions in `dispatches.ts`, so the one
 * list read and the one action dispatch path FR-049 requires stay exactly
 * where they were.
 */

import { mountButton, mountList, mountSelect, mountText } from '@openchamber/sdk/ui';
import type { ButtonHandle, ListHandle, ListItem, SelectHandle, SelectOption, TextHandle } from '@openchamber/sdk/ui';
import { DISPATCH_PAGE_SIZES } from './dispatch-page.ts';
import { DISPATCHES_EMPTY_TEXT, selectedRun, stateLabel, utcStamp } from './dispatches-rows.ts';
import type { PanelBinding } from './bindings-service.ts';
import type { RunReference, RunRow } from './dispatches-service.ts';
import type { DispatchesState, PanelRuntime } from './panel-state.ts';

/** Select id that means "no filter" in both filter selects. */
const ALL_FILTERS = 'all';

/** Label of the correlation-id copy control (FR-049). */
const COPY_CORRELATION_LABEL = 'Copy correlation id';

/** Label the source-reference reveal carries before a row is selected. */
const REVEAL_IDLE_LABEL = 'Show source references';

/** Accessible name of the reference list before a row is selected. */
const SOURCE_ARIA = 'Source references';

/** Plain state tokens the state filter offers, in the model's own order. */
const STATE_FILTER_TOKENS: readonly string[] = [
    'pending',
    'claimed',
    'starting',
    'dispatched',
    'failed',
    'unconfirmed',
    'dead-lettered',
];

/**
 * Read one state token the way the operator sees it, family included.
 *
 * The `blocked` family has no single badge of its own — every `blocked:*`
 * state labels itself by reason — so the filter names the family explicitly
 * rather than rendering the token through {@link stateLabel}, which would
 * answer *unknown state* for it.
 *
 * @param token - Exact state token or the literal `blocked` family.
 * @returns The operator-facing label for that filter entry.
 */
function stateFilterLabel(token: string): string {
    return token === 'blocked' ? 'blocked — every guarded state' : stateLabel(token);
}

/** Callbacks the paging, filter, and row-detail controls invoke. */
export interface DispatchControlsHandlers {
    /** Step to the previous page of the current set (FR-042). */
    readonly previousPage: () => void;
    /** Step to the next page of the current set (FR-042). */
    readonly nextPage: () => void;
    /** Change the page size and restart at page one of the same set (FR-042). */
    readonly setPageLimit: (limit: number) => void;
    /** Filter by binding, server-side (FR-043). */
    readonly setBindingFilter: (bindingId: string | null) => void;
    /** Filter by state, server-side (FR-043). */
    readonly setStateFilter: (state: string | null) => void;
    /** Clear both filters and return to page one of the whole set (AC-122). */
    readonly clearFilters: () => void;
    /** Reveal or hide the selected row's source references (FR-048). */
    readonly toggleReferences: () => void;
    /** Copy the selected row's correlation id to the clipboard (FR-049). */
    readonly copyCorrelationId: () => void;
}

/** Inputs every control mount in this module shares. */
export interface DispatchControlsInput {
    /** Runtime whose state the controls render and repaint from. */
    readonly rt: PanelRuntime;
    /** Pane root the controls mount into. */
    readonly pane: HTMLElement;
    /** Handlers the controls invoke. */
    readonly handlers: DispatchControlsHandlers;
}

/** The list's paging and filtering half. */
export interface PagingControls {
    /** Which slice of the filtered set is on screen, and when it was read. */
    readonly rangeLine: TextHandle;
    /** The active filters, named whether or not any is on (FR-043). */
    readonly filterLine: TextHandle;
    /** Step one page back; disabled on the first page. */
    readonly previousPage: ButtonHandle;
    /** Step one page forward; disabled when the answer reported no more. */
    readonly nextPage: ButtonHandle;
    /** Page-size select: 10, 25, 50, or 100 (FR-042). */
    readonly pageSize: SelectHandle;
    /** Server-side binding filter. */
    readonly bindingFilter: SelectHandle;
    /** Server-side state filter. */
    readonly stateFilter: SelectHandle;
    /** Clears both filters; disabled while neither is on. */
    readonly clearFilters: ButtonHandle;
}

/** The selected row's detail half. */
export interface RowDetail {
    /** Wrapper around the whole detail block, hidden with no row selected. */
    readonly detailBox: HTMLElement;
    /** Wrapper around the reveal control, hidden below two references. */
    readonly revealBox: HTMLElement;
    /** The control that names how many further reasons fired (FR-048). */
    readonly sourceReveal: ButtonHandle;
    /** Wrapper around the reference list, hidden until the reveal opens it. */
    readonly listBox: HTMLElement;
    /** Every source reference of the selected row, earliest first. */
    readonly detailList: ListHandle;
    /** Copies the selected row's correlation id (FR-049). */
    readonly copyCorrelation: ButtonHandle;
}

/** Every control the Dispatches body mounts around its list. */
export interface DispatchesControls extends PagingControls, RowDetail {
    /** Release every handle this module mounted (FR-017). */
    readonly dispose: () => void;
}

/**
 * Create a wrapping row the controls mount into.
 *
 * Shared with `dispatches-ui.ts`'s action groups so the pane's controls all
 * lay out the same way: a flex row that wraps instead of scrolling on the
 * narrowest frame the host allows (FR-082).
 *
 * @param pane - The pane root.
 * @returns The row element the controls mount into.
 */
export function createControlGroup(pane: HTMLElement): HTMLElement {
    const group = pane.ownerDocument.createElement('div');
    group.style.display = 'flex';
    group.style.flexWrap = 'wrap';
    group.style.gap = '8px';
    pane.append(group);

    return group;
}

/**
 * Compose the range line: which slice is showing, the set's size, and when.
 *
 * A withheld total reads *total unavailable* rather than being replaced by
 * the page size wearing a total's hat (FR-042, NFR-112), and the stamp is
 * the service's own label for this read, so an explicit refresh can be seen
 * as one (FR-014).
 *
 * @param runs - The Dispatches section's state.
 * @returns The range line.
 */
export function dispatchRangeLine(runs: DispatchesState): string {
    const { page, rows } = runs;
    if (page.snapshotAt === null) {
        return 'No page has been read yet.';
    }

    const total = page.total === null ? 'total unavailable' : `${page.total} dispatches in this set`;
    if (rows.length === 0) {
        return `This page is empty · ${total} · read ${utcStamp(page.snapshotAt)}`;
    }

    const first = page.pageIndex * page.limit + 1;

    return `Showing ${first}–${first + rows.length - 1} · ${total} · read ${utcStamp(page.snapshotAt)}`;
}

/**
 * Whether either server-side filter is on (FR-043).
 *
 * @param runs - The Dispatches section's state.
 * @returns `true` when the tab is showing a filtered set.
 */
export function hasActiveFilters(runs: DispatchesState): boolean {
    return runs.filters.bindingId !== null || runs.filters.state !== null;
}

/**
 * Compose the always-visible filter line (FR-043: "visible at all times").
 *
 * With nothing on it says so, so an unfiltered list never reads as though a
 * filter the operator cannot see is quietly narrowing it.
 *
 * @param runs - The Dispatches section's state.
 * @param bindings - The bindings the binding filter offers, for the label.
 * @returns The filter line.
 */
export function activeFilterLine(runs: DispatchesState, bindings: readonly PanelBinding[]): string {
    const { bindingId, state } = runs.filters;
    if (bindingId === null && state === null) {
        return 'Filters: none — every binding and every state.';
    }

    const bound = bindingId === null
        ? 'all bindings'
        : `binding ${bindings.find((binding) => binding.bindingId === bindingId)?.repository ?? bindingId}`;
    const token = state === null ? 'all states' : `state ${stateFilterLabel(state)}`;

    return `Filters: ${bound} · ${token}`;
}

/**
 * What the list's empty slot says (AC-122).
 *
 * A filtered empty is a statement about the *filter*, never about the
 * history: "there are no dispatches" would be a claim the panel has no way
 * to make while a filter is on.
 *
 * @param runs - The Dispatches section's state.
 * @returns The empty-slot copy.
 */
export function dispatchEmptyText(runs: DispatchesState): string {
    if (!hasActiveFilters(runs)) {
        return DISPATCHES_EMPTY_TEXT;
    }

    return 'The filter matched nothing — use Clear filters to show every dispatch.';
}

/**
 * Name a row-level action with the row it acts on (FR-081).
 *
 * @param base - The action's own label, from the affordance table.
 * @param row - The row the control is acting on.
 * @returns `Retry dispatch for #412 in owner/name` and its siblings.
 */
export function rowActionLabel(base: string, row: RunRow): string {
    return `${base} for #${row.issueNumber} in ${row.repository}`;
}

/**
 * The reveal control's label: the count of reasons, and the row (FR-048).
 *
 * @param open - Whether the reference list is already revealed.
 * @param row - The selected row.
 * @returns The control's accessible name.
 */
export function sourceRevealLabel(open: boolean, row: RunRow): string {
    const where = `#${row.issueNumber} in ${row.repository}`;

    return open ? `Hide the source references for ${where}` : `Show ${row.referenceCount} reasons for ${where}`;
}

/**
 * One line per retained source reference: kind, origin, time, link, mark (AC-120).
 *
 * @param reference - One retained source reference.
 * @returns The reference's line, unredacted — the caller renders it as text.
 */
function referenceLine(reference: RunReference): string {
    const late = reference.presentAtAuthorization
        ? ''
        : ' — arrived after authorization, so it may not have been seen by the agent';

    return `${reference.kind} · from ${reference.origin} · detected ${utcStamp(reference.detectedAt)}`
        + ` · ${reference.sourceUrl}${late}`;
}

/**
 * Every source reference of one row, as the reveal lists them (FR-048, AC-120).
 *
 * @param row - The selected row.
 * @returns One line per retained reference, earliest first.
 */
export function referenceDetailLines(row: RunRow): readonly string[] {
    return row.sourceReferences.map((reference) => referenceLine(reference));
}

/**
 * The same lines as list items, each keyed so the list cannot collide (FR-080).
 *
 * @param row - The selected row.
 * @returns The reveal's items.
 */
export function referenceDetailItems(row: RunRow): ListItem[] {
    return referenceDetailLines(row).map((line, index) => ({ id: `${row.id}#${index}`, title: line }));
}

/**
 * The binding filter's options: an explicit "all", then every binding (FR-043).
 *
 * @param bindings - The bindings the tab already holds.
 * @returns The select options.
 */
export function bindingFilterOptions(bindings: readonly PanelBinding[]): SelectOption[] {
    return [
        { id: ALL_FILTERS, label: 'All bindings' },
        ...bindings.map((binding) => ({ id: binding.bindingId, label: binding.repository })),
    ];
}

/**
 * The state filter's options: an explicit "all", then 003's vocabulary (FR-043).
 *
 * @returns The select options.
 */
export function stateFilterOptions(): SelectOption[] {
    return [
        { id: ALL_FILTERS, label: 'All states' },
        ...STATE_FILTER_TOKENS.map((token) => ({ id: token, label: stateFilterLabel(token) })),
        { id: 'blocked', label: stateFilterLabel('blocked') },
    ];
}

/**
 * The page-size select's options — the four the contract accepts (FR-042).
 *
 * @returns The select options.
 */
export function pageSizeOptions(): SelectOption[] {
    return DISPATCH_PAGE_SIZES.map((size) => ({ id: String(size), label: `${size} per page` }));
}

/**
 * Read a filter select's choice back as a filter, or `null` for "all".
 *
 * @param id - The id the select reported.
 * @returns The filter value, with the "all" entry read as no filter.
 */
function filterValue(id: string): string | null {
    return id === ALL_FILTERS ? null : id;
}

/**
 * Mount the range line, the filters, and the paging controls (FR-042, FR-043).
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The paging and filtering handles.
 */
export function mountDispatchesControls(input: DispatchControlsInput): PagingControls {
    const { pane, rt, handlers } = input;
    const { dispatches: runs, bindings } = rt.state;
    const rangeLine = mountText(pane, { text: dispatchRangeLine(runs) });
    const filterLine = mountText(pane, { text: activeFilterLine(runs, bindings.bindings) });

    const paging = createControlGroup(pane);
    const previousPage = mountButton(paging, {
        label: 'Previous page',
        variant: 'outline',
        onClick: handlers.previousPage,
    });
    const nextPage = mountButton(paging, { label: 'Next page', variant: 'outline', onClick: handlers.nextPage });
    const pageSize = mountSelect(paging, {
        label: 'Rows per page',
        value: String(runs.page.limit),
        options: pageSizeOptions(),
        onChange: (id) => handlers.setPageLimit(Number(id)),
    });

    const filters = createControlGroup(pane);
    const bindingFilter = mountSelect(filters, {
        label: 'Binding',
        value: runs.filters.bindingId ?? ALL_FILTERS,
        options: bindingFilterOptions(bindings.bindings),
        searchable: true,
        onChange: (id) => handlers.setBindingFilter(filterValue(id)),
    });
    const stateFilter = mountSelect(filters, {
        label: 'State',
        value: runs.filters.state ?? ALL_FILTERS,
        options: stateFilterOptions(),
        onChange: (id) => handlers.setStateFilter(filterValue(id)),
    });
    const clearFilters = mountButton(filters, {
        label: 'Clear filters',
        variant: 'ghost',
        onClick: handlers.clearFilters,
    });

    return { rangeLine, filterLine, previousPage, nextPage, pageSize, bindingFilter, stateFilter, clearFilters };
}

/**
 * Mount the selected row's detail: the reveal control, the references, the copy.
 *
 * The list is display-only — rows are evidence, not a selection — so its
 * `onSelect` is a no-op exactly like the audit trail's.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The row-detail handles and its wrapper.
 */
export function mountRowDetail(input: DispatchControlsInput): RowDetail {
    const { pane, handlers } = input;

    const detailBox = pane.ownerDocument.createElement('div');
    detailBox.style.marginTop = '8px';
    detailBox.hidden = true;
    pane.append(detailBox);

    // The reveal is its own wrapper because FR-048 makes it *absent* — not
    // greyed out — on a row with one reason or none: there is nothing more to
    // show, and a disabled control would still promise that there is.
    const revealBox = pane.ownerDocument.createElement('div');
    revealBox.hidden = true;
    detailBox.append(revealBox);
    const sourceReveal = mountButton(revealBox, {
        label: REVEAL_IDLE_LABEL,
        variant: 'ghost',
        onClick: handlers.toggleReferences,
    });

    const listBox = pane.ownerDocument.createElement('div');
    listBox.hidden = true;
    detailBox.append(listBox);
    const detailList = mountList(listBox, {
        items: [],
        ariaLabel: SOURCE_ARIA,
        emptyText: 'No source references were retained for this dispatch.',
        onSelect: () => {
            // The reveal is display-only: a reference is evidence, not a row.
        },
    });

    const copyCorrelation = mountButton(detailBox, {
        label: COPY_CORRELATION_LABEL,
        variant: 'outline',
        onClick: handlers.copyCorrelationId,
    });

    return { detailBox, revealBox, sourceReveal, listBox, detailList, copyCorrelation };
}

/**
 * Release every handle the two mounts above created (FR-017).
 *
 * The wrapper elements go with their body's node; the handles themselves
 * carry listeners the host would otherwise outlive the teardown with.
 *
 * @param controls - The controls the Dispatches body mounted.
 */
function disposeControls(controls: PagingControls & RowDetail): void {
    const handles = [
        controls.rangeLine,
        controls.filterLine,
        controls.previousPage,
        controls.nextPage,
        controls.pageSize,
        controls.bindingFilter,
        controls.stateFilter,
        controls.clearFilters,
        controls.sourceReveal,
        controls.detailList,
        controls.copyCorrelation,
    ];

    for (const handle of handles) {
        handle.dispose();
    }
}

/**
 * Compose the two halves into the object the board carries (FR-017).
 *
 * @param paging - The paging and filtering handles.
 * @param detail - The row-detail handles.
 * @returns The complete control set, with its disposer attached.
 */
export function combineControls(paging: PagingControls, detail: RowDetail): DispatchesControls {
    return { ...paging, ...detail, dispose: (): void => disposeControls({ ...paging, ...detail }) };
}

/**
 * Whether the reveal control exists for a row at all (FR-048).
 *
 * Below two references there is no "+N more" to offer, so the control is
 * **absent** rather than greyed out — a disabled control still promises that
 * something is behind it.
 *
 * @param row - The selected row, or `null`.
 * @returns `true` only for a row with two or more source references.
 */
export function revealVisible(row: RunRow | null): boolean {
    return row !== null && row.referenceCount > 1;
}

/**
 * Whether the reference list itself is on screen (FR-048, AC-120).
 *
 * One reference is listed as soon as its row is selected — there is nothing
 * to reveal — while several wait behind the operator's own reveal.
 *
 * @param row - The selected row, or `null`.
 * @param open - Whether the operator has opened the reveal.
 * @returns `true` when the list should be visible.
 */
export function referencesVisible(row: RunRow | null, open: boolean): boolean {
    if (row === null || row.referenceCount === 0) {
        return false;
    }

    return row.referenceCount === 1 || open;
}

/**
 * Repaint every control this module mounted from state.
 *
 * Nothing here decides anything: the range, the filters, and the two step
 * buttons are all read back from the position the last answer recorded, so a
 * repaint can never advance a page or invent a total.
 *
 * @param rt - Panel runtime.
 * @param controls - The mounted controls.
 */
export function repaintDispatchesControls(rt: PanelRuntime, controls: DispatchesControls): void {
    const { dispatches: runs, bindings } = rt.state;
    const selected = selectedRun(runs);

    controls.rangeLine.update({ text: dispatchRangeLine(runs) });
    controls.filterLine.update({ text: activeFilterLine(runs, bindings.bindings) });
    controls.previousPage.update({ disabled: runs.page.pageIndex === 0 });
    controls.nextPage.update({ disabled: !runs.page.hasMore });
    controls.pageSize.update({ value: String(runs.page.limit) });
    controls.bindingFilter.update({
        options: bindingFilterOptions(bindings.bindings),
        value: runs.filters.bindingId ?? ALL_FILTERS,
    });
    controls.stateFilter.update({ value: runs.filters.state ?? ALL_FILTERS });
    controls.clearFilters.update({ disabled: !hasActiveFilters(runs) });

    controls.detailBox.hidden = selected === null;
    controls.revealBox.hidden = !revealVisible(selected);
    controls.sourceReveal.update({
        label: selected === null ? REVEAL_IDLE_LABEL : sourceRevealLabel(runs.referencesOpen, selected),
    });
    controls.listBox.hidden = !referencesVisible(selected, runs.referencesOpen);
    controls.detailList.update({
        items: selected === null ? [] : referenceDetailItems(selected),
        ariaLabel: selected === null ? SOURCE_ARIA : `Source references for #${selected.issueNumber}`,
    });
    controls.copyCorrelation.update({
        label: selected === null ? COPY_CORRELATION_LABEL : rowActionLabel(COPY_CORRELATION_LABEL, selected),
        disabled: runs.busy,
    });
}
