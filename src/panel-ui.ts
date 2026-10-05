/**
 * Panel rendering.
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

/** The root framing: the banner above the prerequisite and tab strip. */
export interface PanelUi {
    /** Status banner. */
    banner: BannerHandle;
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
 * missing.
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
    mountStyledText(group, { className: 'mt-prose', text: notListedGuidance() });

    return { projectSelect, projectStatus, projectDetail, projectRefresh, projectCopy };
}

/**
 * Mount the panel's root framing: the banner above the tab strip.
 *
 * The banner is the read-state framing every tab shares, so it mounts once
 * above the strip and never moves (plan §The shell). The root carries
 * **nothing else** that is not a tab: the context summary line the panel used
 * to print here (`bindings: … · accounts: … · identity: … · ledger: …`) was
 * removed by the 2026-10-01 product-owner review — every fact it carried
 * already has a tab that owns it, and a second home for a fact is a second
 * place it can drift from.
 *
 * @param root - Panel root element from `panel/index.html`.
 * @returns The one handle the repaint path updates.
 */
export function mountPanelFraming(root: HTMLElement): PanelUi {
    const banner = mountBanner(root, { tone: 'info', title: 'Mecha Turk', body: 'Waiting for the host.' });

    return { banner };
}

/**
 * Repaint the project picker from the picker state.
 *
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
 * registry on `rt` is what says so.
 *
 */
export function refresh(rt: PanelRuntime): void {
    if (rt.disposed) {
        return;
    }

    const { ui } = rt;
    if (ui !== null) {
        const { state } = rt;
        ui.banner.update({ tone: state.status.tone, title: state.status.title, body: state.status.body });
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
