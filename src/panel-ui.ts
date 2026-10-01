/**
 * Panel rendering for the spike.
 *
 * The UI is built once from `@openchamber/sdk/ui` controls and repainted from
 * state, so `onReady` refreshes never replace a control the user is
 * interacting with. The project picker renders from the picker state alone —
 * loading, error, empty, and ready are all values, not code paths — and every
 * body repaints only while it is mounted, so a tab the operator has never
 * opened owns no handles yet (FR-013, FR-019).
 */

import { mountBanner, mountButton, mountSelect, mountText } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, SelectHandle, TextHandle } from '@openchamber/sdk/ui';
import { refreshHandoff } from './accounts-ui.ts';
import { repaintAccountsBody } from './accounts-tab.ts';
import { repaintAboutTab } from './about-tab.ts';
import { repaintDispatchesBoard } from './dispatches-ui.ts';
import {
    describeProjectSelection,
    notListedGuidance,
    pickerNote,
    pickerOptions,
    pickerPlaceholder,
    selectedProjectId,
} from './project-picker.ts';
import { repaintPrerequisites } from './prerequisites.ts';
import { repaintBindingsPane } from './bindings-ui.ts';
import type { PanelRuntime, PanelState } from './panel-state.ts';
import { mountStyledText } from './style.ts';

/** Callbacks the mounted controls invoke. */
export interface PanelHandlers {
    /** Reload the project list behind the picker. */
    readonly refreshProjects: () => void;
    /** Adopt the project the operator picked in the picker. */
    readonly selectProject: (id: string) => void;
    /** Copy the effective project id to the host clipboard. */
    readonly copyProjectId: () => void;
}

/** The root framing: the banner and the one-line summary. */
export interface PanelUi {
    /** Status banner. */
    banner: BannerHandle;
    /** Context summary line. */
    summary: TextHandle;
}

/** The project picker's handles; they live inside the Bindings tab body. */
export interface ProjectPickerUi {
    /** Project picker select. */
    projectSelect: SelectHandle;
    /** Project picker status line (loading / error / empty / note). */
    projectStatus: TextHandle;
    /** Selected project id, shown with its source. */
    projectDetail: TextHandle;
    /** Reload-projects button. */
    projectRefresh: ButtonHandle;
    /** Copy-the-selected-id button. */
    projectCopy: ButtonHandle;
}

/**
 * Create the container that groups the project picker's controls.
 *
 * The picker sits above the form because it is configuration, not an
 * action: a control row for the select and its buttons, with the status and
 * selection lines underneath.
 *
 * @param root - Body element the picker mounts into.
 * @returns The group element and the control row inside it.
 */
function createProjectGroup(root: HTMLElement): { readonly group: HTMLElement; readonly row: HTMLElement } {
    const group = root.ownerDocument.createElement('div');
    group.style.display = 'grid';
    group.style.gap = '4px';
    group.style.marginBottom = '8px';

    const row = root.ownerDocument.createElement('div');
    row.style.display = 'flex';
    row.style.flexWrap = 'wrap';
    row.style.gap = '8px';
    row.style.alignItems = 'flex-end';
    group.append(row);
    root.append(group);

    return { group, row };
}

/**
 * Mount the project picker: list select, reload, copy, and its two lines.
 *
 * The select starts empty and disabled; `refresh` fills it in from the picker
 * state, so the loading, error, and empty states are painted from state rather
 * than from whatever the mount happened to see. It mounts inside the Bindings
 * body, because that is where the operator is when a project is what is
 * missing (FR-038).
 *
 * @param input - Runtime, body element, and the callbacks the picker invokes.
 * @returns The picker handles used for later repaints.
 */
export function mountProjectPicker(input: {
    readonly rt: PanelRuntime;
    readonly root: HTMLElement;
    readonly handlers: PanelHandlers;
}): ProjectPickerUi {
    const { rt, root, handlers } = input;
    const { group, row } = createProjectGroup(root);

    const projectSelect = mountSelect(row, {
        label: 'OpenChamber project',
        value: rt.state.projectSelection,
        options: [],
        searchable: true,
        searchPlaceholder: 'Search by name or id',
        placeholder: 'Select a project',
        disabled: true,
        onChange: (id) => handlers.selectProject(id),
    });
    const projectRefresh = mountButton(row, {
        label: 'Reload projects',
        variant: 'secondary',
        onClick: handlers.refreshProjects,
    });
    const projectCopy = mountButton(row, {
        label: 'Copy project id',
        variant: 'outline',
        onClick: handlers.copyProjectId,
    });
    const projectStatus = mountText(group, { text: pickerNote(rt.state.projects) });
    const projectDetail = mountText(group, { text: describeProjectSelection(rt.state) });
    // FR-070: the same "Not listed?" line the binding picker shows, so the
    // routes to register a project are readable from either picker without
    // leaving the panel. Constant copy, so it is painted once, not repainted.
    mountText(group, { text: notListedGuidance() });

    return { projectSelect, projectStatus, projectDetail, projectRefresh, projectCopy };
}

/**
 * Mount the panel's root framing: the banner and the one-line summary.
 *
 * These two are what the panel root keeps that is *not* a tab (plan §The
 * shell): the banner is the read-state framing every tab shares, so it mounts
 * once above the strip and never moves.
 *
 * @param root - Panel root element from `panel/index.html`.
 * @returns The two handles the repaint path updates.
 */
export function mountPanelFraming(root: HTMLElement): PanelUi {
    const banner = mountBanner(root, { tone: 'info', title: 'Mecha Turk', body: 'Waiting for the host.' });
    // The summary is framing, not content: it sits above the tab strip on
    // every tab, so it takes the same dim treatment the tabs give their own
    // ledes rather than reading as a headline in full ink (2026-10-01 review).
    const summary = mountStyledText(root, { className: 'mt-lede', text: 'Starting…' });

    return { banner, summary };
}

/**
 * Build the identity segment of the one-line context summary.
 *
 * Only the **service** account identifies a scan: it is the credential the
 * poll loop and the relay act under, so the line names it and nothing else.
 * The legacy host-integration login and the spike's configured-match verdict
 * are gone with the card settings and the single-repo path (002 FR-041), so
 * there is no second identity to report and no wording left that could call
 * an operating panel "not authenticated".
 *
 * @param state - Panel state.
 * @returns The `identity: …` segment of the summary.
 */
function identityLine(state: PanelState): string {
    const { connected } = state.handoff;

    return connected === null ? 'identity: no service account yet' : `identity: ${connected.login} (service)`;
}

/**
 * Build the bindings segment of the summary (FR-020: the panel says
 * *bindings*, never *repositories*).
 *
 * @param state - Panel state.
 * @returns The `bindings: …` segment of the summary.
 */
function bindingsLine(state: PanelState): string {
    const rows = state.bindings.bindings;
    if (rows.length === 0) {
        return 'bindings: none yet';
    }

    const enabled = rows.filter((row) => row.state === 'active').length;

    return `bindings: ${rows.length} (${enabled} enabled)`;
}

/**
 * Build the accounts segment of the summary (FR-030).
 *
 * @param state - Panel state.
 * @returns The `accounts: …` segment of the summary.
 */
function accountsLine(state: PanelState): string {
    const rows = state.bindings.accounts;

    return rows.length === 0 ? 'accounts: none yet' : `accounts: ${rows.length}`;
}

/**
 * Build the one-line context summary.
 *
 * Four segments, each a fact the panel actually holds: what is bound, how
 * many accounts back it, which service account acts, and how much ledger the
 * mount has written. The spike-era `repository:` and `match:` segments are
 * gone with the single-repo path (002 FR-041), so nothing here can describe a
 * configuration the product no longer has.
 *
 * Exported so each segment's truthfulness can be asserted without a live DOM.
 *
 * @param state - Panel state.
 * @returns Plain text describing bindings, accounts, identity, and the ledger.
 */
export function summarizeState(state: PanelState): string {
    const storage = `ledger: generation ${state.ledger.panelGeneration}, ${state.ledger.entries.length} entries`;

    return [bindingsLine(state), accountsLine(state), identityLine(state), storage].join(' · ');
}

/**
 * Repaint the project picker from the picker state.
 *
 * @param state - Panel state.
 * @param ui - Mounted picker handles inside the Bindings body.
 */
function refreshProjectPicker(state: PanelState, ui: ProjectPickerUi): void {
    const picker = state.projects;
    const selected = selectedProjectId(state);

    ui.projectSelect.update({
        options: pickerOptions(picker),
        // The picker's own value, not the effective one: a project that only
        // a binding supplies has not been picked yet, and the
        // SDK select skips `onChange` when a click matches the current value —
        // so showing it here would silently block the operator from storing it.
        value: state.projectSelection,
        disabled: picker.status !== 'ready' || picker.projects.length === 0,
        placeholder: pickerPlaceholder(picker),
    });
    ui.projectStatus.update({ text: pickerNote(picker) });
    ui.projectDetail.update({ text: describeProjectSelection(state) });
    ui.projectCopy.update({ disabled: selected === null });
}

/**
 * Repaint every mounted control from the current state.
 *
 * Nothing runs on a disposed runtime, and each body repaints only while it is
 * mounted: a tab the operator has never opened owns no handles yet, and the
 * registry on `rt` is what says so (FR-013, FR-019).
 *
 * @param rt - Panel runtime.
 */
export function refresh(rt: PanelRuntime): void {
    if (rt.disposed) {
        return;
    }

    const { ui } = rt;
    if (ui !== null) {
        const { state } = rt;
        ui.banner.update({ tone: state.status.tone, title: state.status.title, body: state.status.body });
        ui.summary.update({ text: summarizeState(state) });
    }

    const { bindingsUi, dispatchesUi, pickerUi, accountsUi } = rt;
    if (bindingsUi !== null) {
        repaintBindingsPane(rt, bindingsUi);
    }

    if (accountsUi !== null) {
        repaintAccountsBody(rt, accountsUi);
    }

    if (dispatchesUi !== null) {
        repaintDispatchesBoard(rt, dispatchesUi);
    }

    if (pickerUi !== null) {
        refreshProjectPicker(rt.state, pickerUi);
    }

    // The About tab paints itself from state it shares with no other body:
    // its version line is its own read, while the data directory, phase
    // record, and ledger come from state this repaint has just refreshed.
    repaintAboutTab(rt);

    refreshHandoff(rt);
    repaintPrerequisites(rt);
}
