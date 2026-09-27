/**
 * Panel rendering for the spike.
 *
 * The UI is built once from `@openchamber/sdk/ui` controls and repainted from
 * state, so `onReady` refreshes never replace a control the user is
 * interacting with. Ledger rows are rendered through {@link redact} as a last
 * line of defence: even a diagnostic string cannot render secret-shaped text.
 */

import { mountBanner, mountButton, mountList, mountSelect, mountText   } from '@openchamber/sdk/ui';
import type { ListItem, SelectOption } from '@openchamber/sdk/ui';
import { repositoryLabel } from './config.ts';
import { isLifecyclePhase, ledgerTail  } from './ledger.ts';
import type { LifecyclePhase } from './ledger.ts';
import { redact } from './redaction.ts';
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

    return { banner, summary, poll, dispatch, verify, phaseSelect, mark, list };
}

/**
 * Build the one-line context summary.
 *
 * @param state - Panel state.
 * @returns Plain text describing configuration, identity, and match state.
 */
function summarizeState(state: PanelState): string {
    const configured = state.config === null ? null : repositoryLabel(state.config.repository);
    const repository = configured === null ? 'repository: not configured' : `repository: ${configured}`;
    const identity = state.login === null ? 'identity: not authenticated' : `identity: ${state.login}`;
    const match = state.match === null ? 'match: none' : `match: issue #${state.match.issueNumber}`;
    const storage = `ledger: generation ${state.ledger.panelGeneration}, ${state.ledger.entries.length} entries`;

    return [repository, identity, match, storage].join(' · ');
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
 * Repaint every mounted control from the current state.
 *
 * @param rt - Panel runtime.
 */
export function refresh(rt: PanelRuntime): void {
    const { ui } = rt;
    if (ui === null || rt.disposed) {
        return;
    }

    const { state } = rt;
    ui.banner.update({ tone: state.status.tone, title: state.status.title, body: state.status.body });
    ui.summary.update({ text: summarizeState(state) });
    ui.list.update({ items: buildListItems(state) });
    ui.poll.update({ disabled: !state.connected || state.config === null || rt.pollInFlight });
    ui.dispatch.update({ disabled: state.evidence === null || state.busy, loading: state.busy });
    ui.verify.update({ disabled: state.config === null || state.busy });
}
