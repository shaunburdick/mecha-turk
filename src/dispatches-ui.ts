/**
 * The Dispatches section's mount and repaint (M8, widened by 003 T-025) — split
 * from `bindings-ui.ts`, which the pane's bindings board and add form already
 * fill to the file-length limit.
 *
 * One heading, one status line, one list of recent events (newest first), the
 * actions over the selected row, a note for outcomes, and the M9
 * agent-verification banner in its own wrapper — a banner cannot be
 * unmounted through its handle, so the wrapper's `hidden` flag is what keeps
 * the area empty until a verification has something to say. Every control is
 * a documented SDK primitive repainted from state, exactly like the rest of
 * the pane, and every service-supplied string reaches the DOM through those
 * primitives' `textContent` writes (panel-service contract §3 invariant 11).
 *
 * The three operator actions mount as **groups that show and hide**: the SDK
 * buttons have no "absent" state of their own, so each group wraps its buttons
 * in an element whose `hidden` flag is the "no control here" the affordance
 * table asks for — a disabled button would promise an action the service would
 * refuse (FR-041, FR-074, AC-123). The resolve group carries FR-027's two
 * resolutions plus the field where the operator names the session.
 */

import { mountBanner, mountButton, mountList, mountText, mountTextField } from '@openchamber/sdk/ui';
import type { BannerHandle, ButtonHandle, ListHandle, TextHandle, TextFieldHandle } from '@openchamber/sdk/ui';
import { AUDIT_BUTTON_LABEL, auditItems, auditStatusText } from './audit-view.ts';
import type { PanelRuntime, DispatchesState } from './panel-state.ts';
import {
    CONFIRM_NO_SESSION_LABEL,
    CONFIRM_RETURN_LABEL,
    CONFIRM_SESSION_CREATED_LABEL,
    NO_SESSION_LABEL,
    RESOLVE_LABEL,
    RETRY_LABEL,
    RETURN_LABEL,
    DISPATCHES_EMPTY_TEXT,
    DISPATCHES_HEADING,
    SESSION_CREATED_LABEL,
    runAffordance,
    dispatchRows,
    dispatchesStatusText,
    selectedRun,
} from './dispatches-rows.ts';
import type { BindingsPaneHandlers } from './bindings-ui.ts';

/** Inputs the runs section's mounts share (runtime, pane root, handlers). */
interface MountInputs {
    /** Runtime whose state the section repaints from. */
    readonly rt: PanelRuntime;
    /** Pane root the controls mount into. */
    readonly pane: HTMLElement;
    /** Handlers the controls invoke. */
    readonly handlers: BindingsPaneHandlers;
}

/** The runs half of the pane: heading, list, actions, and notes. */
export interface DispatchesBoard {
    /** Heading above the section. */
    readonly dispatchesHeading: TextHandle;
    /** Status line: idle, loading, ready with a count, or unavailable. */
    readonly dispatchesStatus: TextHandle;
    /** One row per recent event, newest first. */
    readonly dispatchesList: ListHandle;
    /** Re-read `GET /v1/events`. */
    readonly refreshDispatches: ButtonHandle;
    /** Open the selected run's issue in the operator's browser. */
    readonly openDispatch: ButtonHandle;
    /** Wrapper around the retry control, hidden when no state accepts one. */
    readonly retryRunBox: HTMLElement;
    /** Requeue the selected run through `POST …/retry`. */
    readonly retryRun: ButtonHandle;
    /** Wrapper around return-to-waiting, hidden unless the run is parked. */
    readonly requeueRunBox: HTMLElement;
    /** Return the selected parked run to waiting (FR-033). */
    readonly requeueRun: ButtonHandle;
    /** Wrapper around FR-027's two resolutions, hidden unless `unconfirmed`. */
    readonly resolveBox: HTMLElement;
    /** The resolution group's heading — the affordance's own label (T-024). */
    readonly resolveHeading: TextHandle;
    /** First resolution: the dispatch did create a session. */
    readonly resolveSession: ButtonHandle;
    /** Second resolution: the dispatch created no session. */
    readonly resolveNoSession: ButtonHandle;
    /** Where the operator names the session the first resolution records. */
    readonly sessionField: TextFieldHandle;
    /** Note for load failures and action outcomes. */
    readonly dispatchesNote: TextHandle;
    /** Reads the selected run's audit trail (FR-053, contract §3). */
    readonly auditButton: ButtonHandle;
    /** Status line for the audit view: idle, loading, ready, or failed. */
    readonly auditStatus: TextHandle;
    /** Wrapper around the trail, hidden until there are rows to show. */
    readonly auditBox: HTMLElement;
    /** One row per audit entry, oldest first, bounded by the fetch. */
    readonly auditList: ListHandle;
    /** Wrapper around the verification banner, hidden when there is none. */
    readonly agentNoticeBox: HTMLElement;
    /** Agent-verification banner (M9). */
    readonly agentNotice: BannerHandle;
}

/**
 * Create a wrapping row the runs controls mount into.
 *
 * @param pane - The pane root.
 * @returns The row element the buttons mount into.
 */
function createControlGroup(pane: HTMLElement): HTMLElement {
    const group = pane.ownerDocument.createElement('div');
    group.style.display = 'flex';
    group.style.flexWrap = 'wrap';
    group.style.gap = '8px';
    pane.append(group);

    return group;
}

/** Board members the list half owns. */
type DispatchesListKeys = 'dispatchesHeading' | 'dispatchesStatus' | 'dispatchesList';

/**
 * Mount the heading, status line, and list of runs.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The three handles the list half needs.
 */
function mountDispatchesList(input: MountInputs): Pick<DispatchesBoard, DispatchesListKeys> {
    const { pane, rt, handlers } = input;
    const { dispatches: runs } = rt.state;

    return {
        dispatchesHeading: mountText(pane, { text: DISPATCHES_HEADING }),
        dispatchesStatus: mountText(pane, { text: dispatchesStatusText(runs) }),
        dispatchesList: mountList(pane, {
            items: dispatchRows(runs),
            ariaLabel: 'Event runs',
            emptyText: DISPATCHES_EMPTY_TEXT,
            selectedId: runs.selectedRun,
            onSelect: (id) => handlers.selectDispatch(id),
        }),
    };
}

/** Board members the shared action row owns. */
type SharedActionKeys = 'refreshDispatches' | 'openDispatch';

/**
 * Mount the two controls every selection offers: refresh, and open the issue.
 *
 * @param input - Pane root and handlers.
 * @returns The two buttons.
 */
function mountSharedActions(input: Pick<MountInputs, 'pane' | 'handlers'>): Pick<DispatchesBoard, SharedActionKeys> {
    const controls = createControlGroup(input.pane);

    return {
        refreshDispatches: mountButton(controls, {
            label: 'Refresh runs',
            variant: 'secondary',
            onClick: input.handlers.refreshDispatches,
        }),
        openDispatch: mountButton(controls, {
            label: 'Open issue',
            variant: 'outline',
            disabled: true,
            onClick: input.handlers.openDispatch,
        }),
    };
}

/**
 * Mount the two state-gated transitions: retry, and return to waiting.
 *
 * Each sits in its own group so the group's `hidden` flag can say "not this
 * state" without leaving a greyed-out sibling visible.
 *
 * @param input - Pane root and handlers.
 * @returns The groups and their buttons.
 */
function mountTransitions(input: Pick<MountInputs, 'pane' | 'handlers'>): Pick<
    DispatchesBoard,
    'retryRunBox' | 'retryRun' | 'requeueRunBox' | 'requeueRun'
> {
    const retryRunBox = createControlGroup(input.pane);
    retryRunBox.hidden = true;
    const retryRun = mountButton(retryRunBox, {
        label: RETRY_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: input.handlers.retryRun,
    });
    const requeueRunBox = createControlGroup(input.pane);
    requeueRunBox.hidden = true;
    const requeueRun = mountButton(requeueRunBox, {
        label: RETURN_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: input.handlers.requeueRun,
    });

    return { retryRunBox, retryRun, requeueRunBox, requeueRun };
}

/**
 * Mount FR-027's two resolutions and the field that names the session.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The group, its heading, its two buttons, and the session field.
 */
function mountResolutions(input: MountInputs): Pick<
    DispatchesBoard,
    'resolveBox' | 'resolveHeading' | 'resolveSession' | 'resolveNoSession' | 'sessionField'
> {
    const { pane, rt, handlers } = input;
    const resolveBox = createControlGroup(pane);
    resolveBox.hidden = true;
    const resolveHeading = mountText(resolveBox, { text: RESOLVE_LABEL });
    const resolveSession = mountButton(resolveBox, {
        label: SESSION_CREATED_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: handlers.resolveSessionCreated,
    });
    const resolveNoSession = mountButton(resolveBox, {
        label: NO_SESSION_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: handlers.resolveNoSession,
    });
    const sessionField = mountTextField(resolveBox, {
        label: 'Session id to record',
        value: rt.state.dispatches.sessionInput,
        placeholder: 'ses_…',
        mono: true,
        disabled: true,
        helper: 'Read it from the OpenChamber session list under the attachment id shown above.',
        onChange: (value) => handlers.setSessionInput(value),
    });

    return { resolveBox, resolveHeading, resolveSession, resolveNoSession, sessionField };
}

/**
 * Mount the audit view: its button, its status line, and its bounded list.
 *
 * The list sits in its own wrapper so it can disappear when there is nothing
 * to show while the status line keeps saying why — an empty trail, a failed
 * read, and a still-loading one all read differently (T-026).
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The audit view's handles.
 */
function mountAuditView(input: MountInputs): Pick<
    DispatchesBoard,
    'auditButton' | 'auditStatus' | 'auditBox' | 'auditList'
> {
    const { pane, rt, handlers } = input;
    const { audit } = rt.state.dispatches;
    const controls = createControlGroup(pane);
    const auditButton = mountButton(controls, {
        label: AUDIT_BUTTON_LABEL,
        variant: 'secondary',
        disabled: true,
        onClick: handlers.loadAudit,
    });
    const auditStatus = mountText(pane, { text: auditStatusText(audit) });
    const auditBox = pane.ownerDocument.createElement('div');
    auditBox.style.marginTop = '8px';
    auditBox.hidden = true;
    pane.append(auditBox);
    const auditList = mountList(auditBox, {
        items: auditItems(audit),
        ariaLabel: 'Audit history',
        emptyText: 'No audit rows.',
        onSelect: () => {
            // The trail is display-only: rows are evidence, not a selection.
        },
    });

    return { auditButton, auditStatus, auditBox, auditList };
}

/**
 * Mount the verification banner in its own hide-able wrapper.
 *
 * @param pane - Pane root.
 * @param runs - Section state, for the wrapper's first flag.
 * @returns The wrapper and the banner.
 */
function mountAgentNotice(
    pane: HTMLElement,
    runs: DispatchesState,
): Pick<DispatchesBoard, 'agentNoticeBox' | 'agentNotice'> {
    const agentNoticeBox = pane.ownerDocument.createElement('div');
    agentNoticeBox.style.marginTop = '8px';
    agentNoticeBox.hidden = runs.agentNotice === null;
    pane.append(agentNoticeBox);

    return {
        agentNoticeBox,
        agentNotice: mountBanner(agentNoticeBox, { tone: 'info', title: 'Session agent', body: '' }),
    };
}

/**
 * Mount the runs section: heading, status, list, actions, and notes.
 *
 * The list starts from whatever state the mount already holds (idle on a
 * fresh panel, rows after a restore), so the first repaint after
 * `loadDispatches` completes is the one that fills it in — exactly how the
 * bindings board above behaves.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The runs handles the pane repaints through.
 */
export function mountDispatchesBoard(input: MountInputs): DispatchesBoard {
    const { pane, rt } = input;
    const { dispatches: runs } = rt.state;

    return {
        ...mountDispatchesList(input),
        ...mountSharedActions(input),
        ...mountTransitions(input),
        ...mountResolutions(input),
        dispatchesNote: mountText(pane, { text: runs.note }),
        ...mountAuditView(input),
        ...mountAgentNotice(pane, runs),
    };
}

/**
 * Dispose every SDK handle a mounted dispatches board owns (FR-017).
 *
 * The wrapper elements go with their body's node; the handles themselves carry
 * listeners the host would otherwise outlive the teardown with.
 *
 * @param board - The board the Dispatches body mounted.
 */
export function disposeDispatchesBoard(board: DispatchesBoard): void {
    const handles = [
        board.dispatchesHeading,
        board.dispatchesStatus,
        board.dispatchesList,
        board.refreshDispatches,
        board.openDispatch,
        board.retryRun,
        board.requeueRun,
        board.resolveHeading,
        board.resolveSession,
        board.resolveNoSession,
        board.sessionField,
        board.dispatchesNote,
        board.auditButton,
        board.auditStatus,
        board.auditList,
        board.agentNotice,
    ];

    for (const handle of handles) {
        handle.dispose();
    }
}

/**
 * Repaint FR-027's two resolutions and the field that names the session.
 *
 * Split out of {@link repaintDispatchesBoard} because the two armed labels are the
 * two branches an operator reads as "this click will send".
 *
 * @param runs - The runs section's state.
 * @param board - The mounted runs half.
 */
function repaintResolutions(runs: DispatchesState, board: DispatchesBoard): void {
    board.resolveSession.update({
        label: runs.pendingAction === 'resolve-session' ? CONFIRM_SESSION_CREATED_LABEL : SESSION_CREATED_LABEL,
        disabled: runs.busy,
    });
    board.resolveNoSession.update({
        label: runs.pendingAction === 'resolve-no-session' ? CONFIRM_NO_SESSION_LABEL : NO_SESSION_LABEL,
        disabled: runs.busy,
    });
    board.sessionField.update({ value: runs.sessionInput, disabled: runs.busy });
}

/**
 * Repaint the runs half of the pane from state.
 *
 * The affordance table decides which transition group exists: one nobody can
 * use is hidden rather than greyed out, because a disabled button still
 * promises an action the service would refuse (FR-041, AC-123), and an armed
 * control repaints its confirm label from the same state the action module
 * wrote (T-025).
 *
 * @param rt - Panel runtime.
 * @param board - The mounted runs half.
 */
export function repaintDispatchesBoard(rt: PanelRuntime, board: DispatchesBoard): void {
    const { dispatches: runs } = rt.state;
    const selected = selectedRun(runs);
    const affordance = selected === null ? null : runAffordance(selected);

    board.dispatchesStatus.update({ text: dispatchesStatusText(runs) });
    board.dispatchesList.update({ items: dispatchRows(runs), selectedId: runs.selectedRun });
    board.refreshDispatches.update({ disabled: runs.status === 'loading' });
    board.openDispatch.update({ disabled: selected === null });
    board.retryRunBox.hidden = affordance?.action !== 'retry';
    board.retryRun.update({ disabled: runs.busy });
    board.requeueRunBox.hidden = affordance?.action !== 'requeue';
    board.requeueRun.update({
        label: runs.pendingAction === 'requeue' ? CONFIRM_RETURN_LABEL : RETURN_LABEL,
        disabled: runs.busy,
    });
    board.resolveBox.hidden = selected?.state !== 'unconfirmed';
    repaintResolutions(runs, board);
    board.dispatchesNote.update({ text: runs.note });
    board.auditButton.update({ disabled: selected === null || runs.audit.status === 'loading' });
    board.auditStatus.update({ text: auditStatusText(runs.audit) });
    board.auditBox.hidden = runs.audit.status !== 'ready' || runs.audit.rows.length === 0;
    board.auditList.update({ items: auditItems(runs.audit) });
    board.agentNoticeBox.hidden = runs.agentNotice === null;
    if (runs.agentNotice !== null) {
        board.agentNotice.update({
            tone: runs.agentNotice.tone,
            title: runs.agentNotice.title,
            body: runs.agentNotice.body,
        });
    }
}
