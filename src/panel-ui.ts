/**
 * Panel rendering for the spike.
 *
 * The UI is built once from `@openchamber/sdk/ui` controls and repainted from
 * state, so `onReady` refreshes never replace a control the user is
 * interacting with. The project picker renders from the picker state alone —
 * loading, error, empty, and ready are all values, not code paths — and ledger
 * rows are rendered through {@link redact} as a last line of defence: even a
 * diagnostic string cannot render secret-shaped text.
 */

import { mountBanner, mountButton, mountList, mountSelect, mountText } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, ListHandle, ListItem, SelectHandle, TextHandle } from '@openchamber/sdk/ui';
import { refreshHandoff } from './accounts-ui.ts';
import { repaintDispatchesBoard } from './dispatches-ui.ts';
import { ledgerTail } from './ledger.ts';
import {
    describeProjectSelection,
    notListedGuidance,
    pickerNote,
    pickerOptions,
    pickerPlaceholder,
    selectedProjectId,
} from './project-picker.ts';
import { redact } from './redaction.ts';
import { repaintPrerequisites } from './prerequisites.ts';
import { repaintBindingsPane } from './bindings-ui.ts';
import type { PanelRuntime, PanelState } from './panel-state.ts';

/** Number of ledger rows shown, newest first. */
const VISIBLE_ENTRIES = 25;

/** Start offset of the time part inside an RFC 3339 timestamp. */
const TIME_START = 11;

/** End offset of the time part inside an RFC 3339 timestamp. */
const TIME_END = 19;

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

/** The About tab's read-only ledger list (FR-075). */
export interface DiagnosticsUi {
    /** Ledger list. */
    list: ListHandle;
}

/**
 * Open the source URL of a ledger row when it has one.
 *
 * @param rt - Panel runtime.
 * @param id - Row id, which is the ledger entry sequence number.
 */
async function openEntry(rt: PanelRuntime, id: string): Promise<void> {
    const entry = rt.state.ledger.entries.find((candidate) => String(candidate.seq) === id);
    const url = entry?.detail.issueUrl;
    if (typeof url === 'string') {
        await rt.host.openUrl(url);
    }
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
    const summary = mountText(root, { text: 'Starting…' });

    return { banner, summary };
}

/**
 * Mount the About tab's read-only diagnostics list (FR-075).
 *
 * The ledger is a compatibility surface: it is what would notice an
 * `extension-spike-1` evidence-schema change, so it survives the spike's
 * retirement as a read-only section rather than being deleted with the
 * controls that wrote it (Gate Question 2).
 *
 * @param rt - Panel runtime whose ledger the list renders.
 * @param root - The About body container the shell created.
 * @returns The list handle.
 */
export function mountDiagnostics(rt: PanelRuntime, root: HTMLElement): DiagnosticsUi {
    const list = mountList(root, {
        items: [],
        ariaLabel: 'Diagnostics ledger',
        emptyText: 'No ledger entries yet.',
        onSelect: (id) => void openEntry(rt, id),
    });

    return { list };
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
 * Format an RFC 3339 timestamp as `HH:MM:SS`.
 *
 * @param iso - Timestamp to format.
 * @returns The time slice, or the raw value when it is too short.
 */
function formatTime(iso: string): string {
    return iso.length > TIME_END ? iso.slice(TIME_START, TIME_END) : iso;
}

/**
 * Convert recent ledger entries into list rows.
 *
 * @param state - Panel state.
 * @returns Up to {@link VISIBLE_ENTRIES} rows, newest first.
 */
function buildListItems(state: PanelState): ListItem[] {
    return ledgerTail(state.ledger, VISIBLE_ENTRIES).map((entry) => ({
        id: String(entry.seq),
        leading: entry.kind,
        title: entry.kind === 'phase' ? `phase: ${entry.phase ?? 'unknown'}` : entry.kind,
        subtitle: redact(JSON.stringify(entry.detail)),
        meta: formatTime(entry.at),
    }));
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

    const { bindingsUi, dispatchesUi, pickerUi, aboutUi } = rt;
    if (bindingsUi !== null) {
        repaintBindingsPane(rt, bindingsUi);
    }

    if (dispatchesUi !== null) {
        repaintDispatchesBoard(rt, dispatchesUi);
    }

    if (pickerUi !== null) {
        refreshProjectPicker(rt.state, pickerUi);
    }

    if (aboutUi !== null) {
        aboutUi.list.update({ items: buildListItems(rt.state) });
    }

    refreshHandoff(rt);
    repaintPrerequisites(rt);
}
