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
 * The pane is three blocks — the set, the selection, the trail — and the
 * middle one follows Accounts' rule: a control that acts on a selection
 * cannot exist without one, so **Selected dispatch** hides as a whole block,
 * its `h2` included, rather than standing as a heading over an empty region.
 * The outcome note therefore lives at the foot of the *set* block, where the
 * status line's *see the note* still finds it while nothing is selected.
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
    DISPATCHES_HEADING,
    SESSION_CREATED_LABEL,
    runAffordance,
    dispatchRows,
    dispatchesStatusText,
    selectedRun,
} from './dispatches-rows.ts';
import type { BindingsPaneHandlers } from './bindings-ui.ts';
import {
    combineControls,
    createControlGroup,
    dispatchEmptyText,
    mountDispatchesControls,
    mountRowDetail,
    repaintDispatchesControls,
    rowActionLabel,
} from './dispatches-controls.ts';
import type { DispatchesControls } from './dispatches-controls.ts';
import { createBlock, mountColumnHead, mountStyledText } from './style.ts';

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
    /** Status line: idle, loading, ready with a count, or unavailable. */
    readonly dispatchesStatus: TextHandle;
    /** One row per recent event, newest first. */
    readonly dispatchesList: ListHandle;
    /** Re-read `GET /v1/events`. */
    readonly refreshDispatches: ButtonHandle;
    /** Open the selected run's issue in the operator's browser. */
    readonly openDispatch: ButtonHandle;
    /** The whole Selected dispatch block — heading included — hidden with no row open. */
    readonly selectedBox: HTMLElement;
    /** Wrapper around the retry control, hidden when no state accepts one. */
    readonly retryRunBox: HTMLElement;
    /** Requeue the selected run through `POST …/retry`. */
    readonly retryRun: ButtonHandle;
    /** Wrapper around return-to-waiting, hidden unless the run is parked. */
    readonly requeueRunBox: HTMLElement;
    /** Return the selected parked run to waiting. */
    readonly requeueRun: ButtonHandle;
    /** Wrapper around FR-027's two resolutions, hidden unless `unconfirmed`. */
    readonly resolveBox: HTMLElement;
    /** The resolution group's heading — the affordance's own label. */
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
    /** Paging, filter, and row-detail controls (005 T-017, FR-042/FR-043/FR-048). */
    readonly controls: DispatchesControls;
}

/** Board members the heading half owns. */
type DispatchesHeadKeys = 'dispatchesStatus';

/** Board members the list itself owns. */
type DispatchesListKeys = 'dispatchesList';

/** Heading above the controls that act on the row the operator selected. */
const SELECTED_HEADING = 'Selected dispatch';

/** Heading above the audit trail a selected row opens. */
const AUDIT_HEADING = 'Audit trail';

/** The list's column labels, in the order the SDK row lays its cells out. */
const LIST_COLUMNS: readonly string[] = ['Trigger', 'Subject', 'State', 'Age'];

/**
 * Mount the status line that says which set is on screen.
 *
 * @returns The status handle.
 */
function mountDispatchesHead(input: Pick<MountInputs, 'pane' | 'rt'>): Pick<DispatchesBoard, DispatchesHeadKeys> {
    const { pane, rt } = input;
    const text = dispatchesStatusText(rt.state.dispatches);

    return {
        dispatchesStatus: mountStyledText(pane, { className: 'mt-lede', text }),
    };
}

/**
 * Mount the list of runs.
 *
 * Its empty slot is the one AC-122 polices: with a filter on it says the
 * filter matched nothing and offers the control that clears it, never that
 * there are no dispatches.
 *
 * @returns The list handle.
 */
function mountDispatchesList(input: MountInputs): Pick<DispatchesBoard, DispatchesListKeys> {
    const { pane, rt, handlers } = input;
    const { dispatches: runs } = rt.state;
    const grid = pane.ownerDocument.createElement('div');
    grid.className = 'mt-list mt-list--dispatches';
    pane.append(grid);

    return {
        dispatchesList: mountList(grid, {
            items: dispatchRows(runs),
            ariaLabel: 'Dispatches',
            emptyText: dispatchEmptyText(runs),
            selectedId: runs.selectedRun,
            onSelect: (id) => handlers.selectDispatch(id),
        }),
    };
}

/** Board members the shared action row owns. */
type SharedActionKeys = 'refreshDispatches' | 'openDispatch';

/** Label of the control that opens the selected row's issue. */
const OPEN_ISSUE_LABEL = 'Open issue';

/**
 * Mount the two controls every selection offers: refresh, and open the issue.
 *
 * @returns The two buttons.
 */
function mountSharedActions(input: Pick<MountInputs, 'pane' | 'handlers'>): Pick<DispatchesBoard, SharedActionKeys> {
    const controls = createControlGroup(input.pane);

    return {
        refreshDispatches: mountButton(controls, {
            label: 'Refresh dispatches',
            variant: 'secondary',
            onClick: input.handlers.refreshDispatches,
        }),
        openDispatch: mountButton(controls, {
            label: OPEN_ISSUE_LABEL,
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
 * read, and a still-loading one all read differently.
 *
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
    const auditStatus = mountStyledText(pane, { className: 'mt-lede', text: auditStatusText(audit) });
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
 * Dispose every SDK handle a mounted dispatches board owns.
 *
 * The wrapper elements go with their body's node; the handles themselves carry
 * listeners the host would otherwise outlive the teardown with.
 */
export function disposeDispatchesBoard(board: DispatchesBoard): void {
    const handles = [
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

    board.controls.dispose();
}

/**
 * Repaint FR-027's two resolutions and the field that names the session.
 *
 * Split out of {@link repaintDispatchesBoard} because the two armed labels are the
 * two branches an operator reads as "this click will send". Each label names
 * the row it will act on.
 */
function repaintResolutions(input: {
    /** The runs section's state. */
    readonly runs: DispatchesState;
    /** Names one action label with the selected row. */
    readonly labelFor: (base: string) => string;
    /** The mounted runs half. */
    readonly board: DispatchesBoard;
}): void {
    const { runs, labelFor, board } = input;
    const sessionBase = runs.pendingAction === 'resolve-session'
        ? CONFIRM_SESSION_CREATED_LABEL
        : SESSION_CREATED_LABEL;
    const noSessionBase = runs.pendingAction === 'resolve-no-session'
        ? CONFIRM_NO_SESSION_LABEL
        : NO_SESSION_LABEL;

    board.resolveSession.update({ label: labelFor(sessionBase), disabled: runs.busy });
    board.resolveNoSession.update({ label: labelFor(noSessionBase), disabled: runs.busy });
    board.sessionField.update({ value: runs.sessionInput, disabled: runs.busy });
}

/**
 * Repaint the runs half of the pane from state.
 *
 * The affordance table decides which transition group exists: one nobody can
 * use is hidden rather than greyed out, because a disabled button still
 * promises an action the service would refuse, and an armed
 * control repaints its confirm label from the same state the action module
 * wrote.
 *
 * Every row-level action also repaints an **accessible name that names its
 * row** — *Retry dispatch for #412 in owner/name* — because a list of
 * identically-labelled buttons is a list an operator cannot act on with a
 * screen reader.
 *
 * @param board - The mounted runs half.
 */
export function repaintDispatchesBoard(rt: PanelRuntime, board: DispatchesBoard): void {
    const { dispatches: runs } = rt.state;
    const selected = selectedRun(runs);
    const affordance = selected === null ? null : runAffordance(selected);
    const labelFor = (base: string): string => (selected === null ? base : rowActionLabel(base, selected));

    board.dispatchesStatus.update({ text: dispatchesStatusText(runs) });
    board.dispatchesList.update({
        items: dispatchRows(runs),
        selectedId: runs.selectedRun,
        emptyText: dispatchEmptyText(runs),
    });
    board.refreshDispatches.update({ disabled: runs.status === 'loading' });
    board.openDispatch.update({ disabled: selected === null, label: labelFor(OPEN_ISSUE_LABEL) });
    // The block itself goes first: with no row open its heading would promise
    // a selection the panel does not have (the Accounts rule, module note).
    board.selectedBox.hidden = selected === null;
    board.retryRunBox.hidden = affordance?.action !== 'retry';
    board.retryRun.update({ disabled: runs.busy, label: labelFor(RETRY_LABEL) });
    board.requeueRunBox.hidden = affordance?.action !== 'requeue';
    board.requeueRun.update({
        label: labelFor(runs.pendingAction === 'requeue' ? CONFIRM_RETURN_LABEL : RETURN_LABEL),
        disabled: runs.busy,
    });
    board.resolveBox.hidden = selected?.state !== 'unconfirmed';
    repaintResolutions({ runs, labelFor, board });
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

    repaintDispatchesControls(rt, board.controls);
}

/**
 * Mount the runs section: heading, controls, list, actions, and notes.
 *
 * The list starts from whatever state the mount already holds (idle on a
 * fresh panel, rows after a restore), so a mount finishes with **one repaint**
 * — the body first appears long after the mount-time read landed, and without
 * it the paging controls would render their pre-read flags while the rows
 * already show the answer.
 *
 * @returns The runs handles the pane repaints through.
 */
export function mountDispatchesBoard(input: MountInputs): DispatchesBoard {
    const { pane, rt, handlers } = input;
    const { dispatches: runs } = rt.state;
    // Three blocks, in the order an operator reads them: the set — what it
    // says, which slice of it is on screen, and the rows themselves; then the
    // controls the selection opens; then the trail a row leaves behind. The
    // first carries the tab title (one rule across the six tabs, 2026-10-01).
    const set = createBlock(pane, { heading: DISPATCHES_HEADING, title: true });
    // No lede, so `selected.body` *is* the block element: hiding it takes its
    // heading with it, which is exactly how Accounts' detail block behaves.
    const selected = createBlock(pane, { heading: SELECTED_HEADING });
    const trail = createBlock(pane, { heading: AUDIT_HEADING });

    const head = mountDispatchesHead({ pane: set.body, rt });
    const paging = mountDispatchesControls({ pane: set.body, rt, handlers });
    mountColumnHead(set.body, { modifier: 'mt-head--dispatches', cells: LIST_COLUMNS });
    const list = mountDispatchesList({ pane: set.body, rt, handlers });
    const shared = mountSharedActions({ pane: set.body, handlers });
    // The outcome note closes the *set* block, the way Accounts closes its
    // list block: it carries read failures as well as action outcomes, so it
    // must survive a selection the panel does not have (see the module note).
    const note = mountStyledText(set.body, { className: 'mt-lede', text: runs.note });

    const transitions = mountTransitions({ pane: selected.body, handlers });
    const resolutions = mountResolutions({ pane: selected.body, rt, handlers });
    const detail = mountRowDetail({ pane: selected.body, rt, handlers });

    const audit = mountAuditView({ pane: trail.body, rt, handlers });
    const agent = mountAgentNotice(pane, runs);
    const board: DispatchesBoard = {
        ...head,
        ...list,
        ...shared,
        selectedBox: selected.body,
        ...transitions,
        ...resolutions,
        controls: combineControls(paging, detail),
        dispatchesNote: note,
        ...audit,
        ...agent,
    };
    repaintDispatchesBoard(rt, board);

    return board;
}
