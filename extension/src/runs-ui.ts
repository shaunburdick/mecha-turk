/**
 * The Runs section's mount (M8) — split from `repos-ui.ts`, which the pane's
 * bindings board and add form already fill to the file-length limit.
 *
 * One heading, one status line, one list of recent events (newest first),
 * three actions over the selected row, a note for outcomes, and the M9
 * agent-verification banner in its own wrapper — a banner cannot be
 * unmounted through its handle, so the wrapper's `hidden` flag is what keeps
 * the area empty until a verification has something to say. Every control is
 * a documented SDK primitive repainted from state, exactly like the rest of
 * the pane, and every service-supplied string reaches the DOM through those
 * primitives' `textContent` writes (panel-service contract §3 invariant 11).
 */

import { mountBanner, mountButton, mountList, mountText } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, ListHandle, TextHandle } from '@openchamber/sdk/ui';
import type { PanelRuntime } from './panel-state.ts';
import { RUNS_EMPTY_TEXT, RUNS_HEADING, runRows, runsStatusText } from './runs-rows.ts';
import type { ReposPaneHandlers } from './repos-ui.ts';

/** Inputs the runs section's mounts share (runtime, pane root, handlers). */
interface MountInputs {
    /** Runtime whose state the section repaints from. */
    readonly rt: PanelRuntime;
    /** Pane root the controls mount into. */
    readonly pane: HTMLElement;
    /** Handlers the controls invoke. */
    readonly handlers: ReposPaneHandlers;
}

/** The runs half of the pane: heading, list, actions, and notes. */
export interface RunsBoard {
    /** Heading above the section. */
    readonly runsHeading: TextHandle;
    /** Status line: idle, loading, ready with a count, or unavailable. */
    readonly runsStatus: TextHandle;
    /** One row per recent event, newest first. */
    readonly runsList: ListHandle;
    /** Re-read `GET /v1/events`. */
    readonly refreshRuns: ButtonHandle;
    /** Open the selected run's issue in the operator's browser. */
    readonly openRun: ButtonHandle;
    /** Requeue the selected run. */
    readonly retryRun: ButtonHandle;
    /** Note for load failures and retry outcomes. */
    readonly runsNote: TextHandle;
    /** Wrapper around the verification banner, hidden when there is none. */
    readonly agentNoticeBox: HTMLElement;
    /** Agent-verification banner (M9). */
    readonly agentNotice: BannerHandle;
}

/**
 * Create the horizontal row the runs actions mount into.
 *
 * @param pane - The pane root.
 * @returns The row element the buttons mount into.
 */
function createRunsControls(pane: HTMLElement): HTMLElement {
    const controls = pane.ownerDocument.createElement('div');
    controls.style.display = 'flex';
    controls.style.flexWrap = 'wrap';
    controls.style.gap = '8px';
    pane.append(controls);

    return controls;
}

/**
 * Mount the runs section: heading, status, list, actions, and notes.
 *
 * The list starts from whatever state the mount already holds (idle on a
 * fresh panel, rows after a restore), so the first repaint after
 * `loadRuns` completes is the one that fills it in — exactly how the
 * bindings board above behaves.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The runs handles the pane repaints through.
 */
export function mountRunsBoard(input: MountInputs): RunsBoard {
    const { pane, rt, handlers } = input;
    const { runs } = rt.state.repos;
    const runsHeading = mountText(pane, { text: RUNS_HEADING });
    const runsStatus = mountText(pane, { text: runsStatusText(runs) });
    const runsList = mountList(pane, {
        items: runRows(runs),
        ariaLabel: 'Event runs',
        emptyText: RUNS_EMPTY_TEXT,
        selectedId: runs.selectedRun,
        onSelect: (id) => handlers.selectRun(id),
    });
    const controls = createRunsControls(pane);
    const refreshRuns = mountButton(controls, {
        label: 'Refresh runs',
        variant: 'secondary',
        onClick: handlers.refreshRuns,
    });
    const openRun = mountButton(controls, {
        label: 'Open issue',
        variant: 'outline',
        disabled: true,
        onClick: handlers.openRun,
    });
    const retryRun = mountButton(controls, {
        label: 'Retry run',
        variant: 'outline',
        disabled: true,
        onClick: handlers.retryRun,
    });
    const runsNote = mountText(pane, { text: runs.note });

    const agentNoticeBox = pane.ownerDocument.createElement('div');
    agentNoticeBox.style.marginTop = '8px';
    agentNoticeBox.hidden = runs.agentNotice === null;
    pane.append(agentNoticeBox);
    const agentNotice = mountBanner(agentNoticeBox, { tone: 'info', title: 'Session agent', body: '' });

    return { runsHeading, runsStatus, runsList, refreshRuns, openRun, retryRun, runsNote, agentNoticeBox, agentNotice };
}
