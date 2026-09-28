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
import type { ListItem, SelectOption } from '@openchamber/sdk/ui';
import { refreshHandoff } from './accounts-ui.ts';
import { repositoryLabel } from './config.ts';
import { isLifecyclePhase, ledgerTail } from './ledger.ts';
import type { LifecyclePhase } from './ledger.ts';
import {
    describeProjectSelection,
    pickerNote,
    pickerOptions,
    pickerPlaceholder,
    selectedProjectId,
} from './project-picker.ts';
import { redact } from './redaction.ts';
import { repaintReposPane } from './repos-ui.ts';
import type { PanelRuntime, PanelState, PanelUi } from './panel-state.ts';

/** Number of ledger rows shown, newest first. */
const VISIBLE_ENTRIES = 25;

/** Start offset of the time part inside an RFC 3339 timestamp. */
const TIME_START = 11;

/** End offset of the time part inside an RFC 3339 timestamp. */
const TIME_END = 19;

/** Lifecycle phases the operator marks by hand because the frame cannot see them. */
const MARKER_PHASES: readonly LifecyclePhase[] = ['paused', 'removed', 'server-switch'];

/** Callbacks the mounted controls invoke. */
export interface PanelHandlers {
    /** Run one poll immediately. */
    readonly poll: () => void;
    /** Dispatch the matched issue as one session. */
    readonly dispatch: () => void;
    /** Verify host-owned project/worktree/session state. */
    readonly verify: () => void;
    /** Record the selected lifecycle phase marker. */
    readonly mark: () => void;
    /** Reload the project list behind the picker. */
    readonly refreshProjects: () => void;
    /** Adopt the project the operator picked in the picker. */
    readonly selectProject: (id: string) => void;
    /** Copy the effective project id to the host clipboard. */
    readonly copyProjectId: () => void;
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
 * Record the phase the operator selected in the picker.
 *
 * @param rt - Panel runtime.
 * @param id - Selected option id.
 */
function selectPhase(rt: PanelRuntime, id: string): void {
    if (!isLifecyclePhase(id)) {
        return;
    }

    rt.pendingPhase = id;
    rt.ui?.phaseSelect.update({ value: id });
}

/**
 * Build the options for the lifecycle phase picker.
 *
 * @returns One option per operator-markable phase.
 */
function markerOptions(): SelectOption[] {
    return MARKER_PHASES.map((phase) => ({ id: phase, label: phase }));
}

/**
 * Create the horizontal row that holds the action controls.
 *
 * @param root - Panel root element.
 * @returns The row element the controls mount into.
 */
function createControlsRow(root: HTMLElement): HTMLElement {
    const controls = root.ownerDocument.createElement('div');
    controls.style.display = 'flex';
    controls.style.flexWrap = 'wrap';
    controls.style.gap = '8px';
    controls.style.alignItems = 'flex-end';
    root.appendChild(controls);

    return controls;
}

/**
 * Create the container that groups the project picker's controls.
 *
 * The picker sits above the action row because it is configuration, not an
 * action: a control row for the select and its buttons, with the status and
 * selection lines underneath.
 *
 * @param root - Panel root element.
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

/** Picker handles returned by {@link mountProjectPicker}. */
type ProjectPickerUi = Pick<
    PanelUi,
    'projectSelect' | 'projectStatus' | 'projectDetail' | 'projectRefresh' | 'projectCopy'
>;

/**
 * Mount the project picker: list select, reload, copy, and its two lines.
 *
 * The select starts empty and disabled; `refresh` fills it in from the picker
 * state, so the loading, error, and empty states are painted from state rather
 * than from whatever the mount happened to see.
 *
 * @param input - Runtime, panel root, and the callbacks the picker invokes.
 * @returns The picker handles used for later repaints.
 */
function mountProjectPicker(input: {
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

    return { projectSelect, projectStatus, projectDetail, projectRefresh, projectCopy };
}

/**
 * Mount every panel control once.
 *
 * @param rt - Panel runtime.
 * @param input - Panel root element and the callbacks wired to the actions.
 * @returns The handles used for later repaints.
 */
export function mountPanelUi(rt: PanelRuntime, input: { root: HTMLElement; handlers: PanelHandlers }): PanelUi {
    const { root, handlers } = input;
    const banner = mountBanner(root, { tone: 'info', title: 'Mecha Turk Spike', body: 'Waiting for the host.' });
    const summary = mountText(root, { text: 'Starting…' });
    const picker = mountProjectPicker({ rt, root, handlers });
    const controls = createControlsRow(root);

    const poll = mountButton(controls, {
        label: 'Poll now',
        variant: 'secondary',
        disabled: true,
        onClick: handlers.poll,
    });
    const dispatch = mountButton(controls, { label: 'Start session', disabled: true, onClick: handlers.dispatch });
    const verify = mountButton(controls, {
        label: 'Verify host state',
        variant: 'outline',
        disabled: true,
        onClick: handlers.verify,
    });
    const phaseSelect = mountSelect(controls, {
        label: 'Observed phase',
        value: rt.pendingPhase,
        options: markerOptions(),
        onChange: (id) => selectPhase(rt, id),
    });
    const mark = mountButton(controls, { label: 'Record phase', variant: 'ghost', onClick: handlers.mark });

    const list = mountList(root, {
        items: [],
        ariaLabel: 'Spike ledger',
        emptyText: 'No ledger entries yet.',
        onSelect: (id) => void openEntry(rt, id),
    });

    return { banner, summary, ...picker, poll, dispatch, verify, phaseSelect, mark, list };
}

/**
 * Build the identity segment of the one-line context summary.
 *
 * Bindings mode polls under the service-side account bound to the
 * repository, so the legacy `state.login` — the host integration token — is
 * not the identity any scan runs as, and reporting it as "not authenticated"
 * while bindings poll is simply false. The line therefore names the connected
 * service login (`identity: <login> (service)`), falling back to the plain
 * `identity: service account` while nothing is connected yet. With no active
 * bindings the legacy single-repo wording is kept unchanged.
 *
 * @param state - Panel state.
 * @returns The `identity: …` segment of the summary.
 */
function identityLine(state: PanelState): string {
    if (state.bindingsActive > 0) {
        const { connected } = state.handoff;

        return connected === null ? 'identity: service account' : `identity: ${connected.login} (service)`;
    }

    return state.login === null ? 'identity: not authenticated' : `identity: ${state.login}`;
}

/**
 * Build the one-line context summary.
 *
 * Exported so the truthfulness of each segment (identity in bindings mode
 * above all) can be asserted without a live DOM.
 *
 * @param state - Panel state.
 * @returns Plain text describing configuration, identity, and match state.
 */
export function summarizeState(state: PanelState): string {
    const configured = state.config === null ? null : repositoryLabel(state.config.repository);
    const repository = configured === null ? 'repository: not configured' : `repository: ${configured}`;
    const match = state.match === null ? 'match: none' : `match: issue #${state.match.issueNumber}`;
    const storage = `ledger: generation ${state.ledger.panelGeneration}, ${state.ledger.entries.length} entries`;

    return [repository, identityLine(state), match, storage].join(' · ');
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
 * Repaint the tab bodies from `repos.activeTab`.
 *
 * The shared tab strip's active state and each body's `hidden` flag are all
 * decided from `rt.state.repos.activeTab` — the switch handler only writes
 * state, and every repaint (including the first, which `mountReposSection`
 * runs before returning) applies visibility here. A runtime without the
 * mounted section (headless orchestration tests) has nothing to show.
 *
 * @param rt - Panel runtime.
 */
export function repaintReposSection(rt: PanelRuntime): void {
    const section = rt.reposSection;
    if (section === null) {
        return;
    }

    const reposShows = rt.state.repos.activeTab === 'repos';
    section.spike.hidden = reposShows;
    section.repos.pane.hidden = !reposShows;
    repaintReposPane(rt, section.repos);
}

/**
 * Repaint the project picker from the picker state.
 *
 * @param state - Panel state.
 * @param ui - Mounted UI handles.
 */
function refreshProjectPicker(state: PanelState, ui: PanelUi): void {
    const picker = state.projects;
    const selected = selectedProjectId(state);

    ui.projectSelect.update({
        options: pickerOptions(picker),
        // The picker's own value, not the effective one: a project that only
        // the integration setting supplies has not been picked yet, and the
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
 * Nothing runs on a disposed runtime; each surface repaints only when it is
 * mounted, so a runtime without the spike UI (headless tests) can still
 * repaint the Repositories tab it actually holds.
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
        ui.list.update({ items: buildListItems(state) });
        // Bindings mode leaves this legacy control alone deliberately: the
        // "Bindings active" banner already says the service owns polling, so
        // the button keeps driving only the legacy single-repo loop it always
        // did (MVP fix 4 chose the smaller change over a disabled note).
        ui.poll.update({ disabled: !state.connected || state.config === null || rt.pollInFlight });
        ui.dispatch.update({ disabled: state.evidence === null || state.busy, loading: state.busy });
        ui.verify.update({ disabled: state.config === null || state.busy });
        refreshProjectPicker(state, ui);
    }

    repaintReposSection(rt);
    refreshHandoff(rt);
}
