/**
 * The Bindings pane (M3 re-cut): list, add, and enable/disable bindings.
 *
 * Every control is a documented SDK primitive repainted from runtime state,
 * so the pane never diverges from what the runtime knows. The add form
 * mirrors the spike's picker patterns: an `owner/name` text field, an
 * account select sourced from `GET /v1/accounts`, a project select sourced
 * from the host's own `listProjects()` state, then the trigger checkboxes
 * and the worktree option. All service-supplied strings reach the DOM
 * through the SDK primitives' `textContent` writes — no HTML sink is
 * touched (panel-service contract §3 invariant 11). The binding list rows
 * themselves — the scan stamp, skip reason, and pending count the operator
 * reads per row — live in `bindings-rows.ts`, and the runs section's row copy
 * lives beside it in `dispatches-rows.ts` (M8).
 */

import {
    mountButton,
    mountCheckbox,
    mountList,
    mountSelect,
    mountText,
    mountTextField,
} from '@openchamber/sdk/ui';
import type {
    ButtonHandle,
    CheckboxHandle,
    ListHandle,
    SelectHandle,
    TextHandle,
    TextFieldHandle,
} from '@openchamber/sdk/ui';
import type { PanelRuntime, BindingsTabState } from './panel-state.ts';
import type { DispatchControlsHandlers } from './dispatches-controls.ts';
import { disposeBindingPrompt, mountBindingPrompt, repaintBindingPrompt } from './bindings-prompt.ts';
import type { BindingPromptControls, BindingPromptHandlers } from './bindings-prompt.ts';
import {
    accountFieldView,
    mountBindingActions,
    mountBindingMention,
    repaintBindingActions,
    repaintBindingMention,
    worktreeFieldView,
} from './bindings-editor.ts';
import type { BindingActions } from './bindings-editor.ts';
import { formProjectOptions, notListedGuidance } from './project-picker.ts';
import { bindingRows, selectedBindingDetail } from './bindings-rows.ts';
import { mountDetailChips, TRIGGER_ASSIGNMENT, TRIGGER_MENTION, TRIGGER_REVIEW } from './bindings-chips.ts';
import type { DetailChips } from './bindings-chips.ts';
import { createBlock, mountColumnHead, mountStyledText } from './style.ts';

/** The pane handle: the mounted element and every repaint handle it needs. */
export interface BindingsPane {
    /** The pane root this view mounted. */
    readonly pane: HTMLElement;
    /** Status line at the top. */
    readonly status: TextHandle;
    /** Bindings list with per-binding scan lines. */
    readonly bindingsList: ListHandle;
    /** Bindings refresh button. */
    readonly refreshBindings: ButtonHandle;
    /** Repository owner/name input. */
    readonly repoField: TextFieldHandle;
    /** Account select: fixed to the binding in edit mode, a picker in add mode. */
    readonly accountSelect: SelectHandle;
    /** The mention token in force, marked when it differs (005 FR-057). */
    readonly mentionToken: TextHandle;
    /** Project select (from the host's project list). */
    readonly projectSelect: SelectHandle;
    /** Assignment trigger checkbox. */
    readonly assignmentCheck: CheckboxHandle;
    /** Mention trigger checkbox. */
    readonly mentionCheck: CheckboxHandle;
    /** Review-request trigger checkbox. */
    readonly reviewRequestCheck: CheckboxHandle;
    /** Worktree option select. */
    readonly worktreeSelect: SelectHandle;
    /** Add-binding button (the same control saves the loaded row in edit mode). */
    readonly addBinding: ButtonHandle;
    /** Enable/disable toggle for the selected row. */
    readonly toggleSelected: ButtonHandle;
    /** Removal button for the selected row. */
    readonly removeSelected: ButtonHandle;
    /** Loads the selected row into the editor (005 FR-050's Edit affordance). */
    readonly editSelected: ButtonHandle;
    /** Leaves the loaded edit without writing it. */
    readonly cancelEdit: ButtonHandle;
    /** Note under the form. */
    readonly note: TextHandle;
    /** Wrapper around the selected binding's own line (005 FR-053). */
    readonly detailBox: HTMLElement;
    /** Chip row over that line: the binding's state and its triggers. */
    readonly detailChips: DetailChips;
    /** State, created/updated stamps, and scan of the selected binding. */
    readonly selectedDetail: TextHandle;
    /** The starting-prompt field and its save control (005 FR-051). */
    readonly prompt: BindingPromptControls;
    /** Remove every node this pane mounted. */
    readonly dispose: () => void;
}

/** Callbacks the mounted Bindings pane invokes. */
export interface BindingsPaneHandlers extends DispatchControlsHandlers, BindingPromptHandlers {
    /** Operators re-read the bindings and accounts. */
    readonly refresh: () => void;
    /** Operators submitted the add form. */
    readonly submit: () => void;
    /** Operators toggled a binding's enabled state (selected row). */
    readonly toggle: () => void;
    /** Operators removed the selected binding from the granted list. */
    readonly removeBinding: () => void;
    /** Operators asked to load the selected binding into the editor (FR-050). */
    readonly editBinding: () => void;
    /** Operators walked away from the loaded edit without writing it. */
    readonly cancelEdit: () => void;
    /** Operators changed the repository input. */
    readonly setRepoInput: (value: string) => void;
    /** Operators picked an account. */
    readonly selectAccount: (id: string) => void;
    /** Operators picked a project. */
    readonly selectProject: (id: string) => void;
    /** Operators set the assignment trigger checkbox. */
    readonly setAssignment: (checked: boolean) => void;
    /** Operators set the mention trigger checkbox. */
    readonly setMention: (checked: boolean) => void;
    /** Operators set the review-request trigger checkbox. */
    readonly setReviewRequest: (checked: boolean) => void;
    /** Operators picked a worktree option. */
    readonly setWorktree: (id: 'none' | 'generated') => void;
    /** Operators clicked a binding row. */
    readonly selectBinding: (id: string) => void;
    /** Operators reloaded the project list behind the picker. */
    readonly refreshProjects: () => void;
    /** Operators asked for a fresh runs history (M8). */
    readonly refreshDispatches: () => void;
    /** Operators clicked a run row. */
    readonly selectDispatch: (id: string) => void;
    /** Operators asked to open the selected run's issue. */
    readonly openDispatch: () => void;
    /** Operators asked to requeue the selected run. */
    readonly retryRun: () => void;
    /** Operators asked to return the selected parked run to waiting. */
    readonly requeueRun: () => void;
    /** Operators confirmed FR-027's first resolution (a session exists). */
    readonly resolveSessionCreated: () => void;
    /** Operators confirmed FR-027's second resolution (no session exists). */
    readonly resolveNoSession: () => void;
    /** Operators typed into the session-id field. */
    readonly setSessionInput: (value: string) => void;
    /** Operators asked for the selected run's audit history (FR-053). */
    readonly loadAudit: () => void;
}

/** Note under the mention checkbox (M6's comment *and* issue-body scan). */
export const MENTION_SCAN_NOTE = 'Issue bodies and comments that @mention the bound account open a dispatch.';

/** Note under the review-request checkbox (M7). */
export const REVIEW_SCAN_NOTE = 'Pull requests that ask the account to review open a dispatch.';

/** Heading above the bindings list and the selected row's own facts. */
const LIST_HEADING = 'Bindings';

/** Heading above the form that creates or edits one binding. */
const EDITOR_HEADING = 'Binding editor';

/** The list's column labels, in the order the SDK row lays its cells out. */
const LIST_COLUMNS: readonly string[] = ['State', 'Repository and project', 'Pending'];

/**
 * Compose the pane's one status line.
 *
 * @param bindings - The Bindings tab's state.
 * @returns The summary text the status line shows.
 */
function composeStatus(bindings: BindingsTabState): string {
    const enabled = bindings.bindings.filter((binding) => binding.state === 'active').length;

    return `Bindings: ${bindings.bindings.length} (${enabled} enabled) · Accounts: ${bindings.accounts.length}`;
}

/** What `mountBindingsPane` builds; exactly {@link BindingsPane} plus tabs. */
type MountedPane = BindingsPane & { readonly pane: HTMLElement };

/** Inputs the add-form mounts share (runtime, pane root, handlers). */
interface MountInputs {
    /** Runtime whose state repaints the control. */
    readonly rt: PanelRuntime;
    /** The pane root the control mounts into. */
    readonly pane: HTMLElement;
    /** Handlers the control invokes. */
    readonly handlers: BindingsPaneHandlers;
}

/** The bindings list half of the pane. */
interface Board {
    /** Status line at the top. */
    readonly status: TextHandle;
    /** Bindings list. */
    readonly bindingsList: ListHandle;
    /** Refresh button. */
    readonly refreshBindings: ButtonHandle;
}

/** The add-form half of the pane. */
interface Form {
    /** Repository input. */
    readonly repoField: TextFieldHandle;
    /** Account select. */
    readonly accountSelect: SelectHandle;
    /** Mention-token line under the account field. */
    readonly mentionToken: TextHandle;
    /** Project select. */
    readonly projectSelect: SelectHandle;
    /** Assignment checkbox. */
    readonly assignment: CheckboxHandle;
    /** Mention checkbox. */
    readonly mention: CheckboxHandle;
    /** Review-request checkbox. */
    readonly reviewRequest: CheckboxHandle;
    /** Worktree select. */
    readonly worktree: SelectHandle;
    /** The primary control, the Edit affordance, and the row controls. */
    readonly actions: BindingActions;
    /** Note under the form. */
    readonly note: TextHandle;
}

/**
 * Mount the bindings list and its refresh.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The board handles.
 */
function mountBindingsBoard(input: MountInputs): Board {
    const { pane, rt, handlers } = input;
    const text = composeStatus(rt.state.bindings);
    const status = mountStyledText(pane, { className: 'mt-lede', text });
    const grid = pane.ownerDocument.createElement('div');
    grid.className = 'mt-list';
    pane.append(grid);
    mountColumnHead(grid, { modifier: 'mt-head--bindings', cells: LIST_COLUMNS });
    const list = mountList(grid, {
        items: [],
        ariaLabel: 'Bindings',
        emptyText: 'No binding yet — add one below or refresh.',
        onSelect: (id: string) => handlers.selectBinding(id),
    });
    const refresh = mountButton(
        pane,
        { label: 'Refresh bindings', variant: 'secondary', onClick: handlers.refresh },
    );
    return { status, bindingsList: list, refreshBindings: refresh };
}

function mountRepoField(input: MountInputs): TextFieldHandle {
    return mountTextField(input.pane, {
        label: 'Repository (owner/name)',
        value: input.rt.state.bindings.repoInput,
        placeholder: 'acme/widget',
        mono: true,
        onChange: (value) => input.handlers.setRepoInput(value),
    });
}
function mountAccountSelect(input: MountInputs): SelectHandle {
    const view = accountFieldView(input.rt.state.bindings);

    return mountSelect(input.pane, {
        label: 'Poll as account',
        value: view.value,
        options: view.options,
        searchable: true,
        placeholder: 'Select a verified account',
        disabled: view.disabled,
        onChange: (id) => input.handlers.selectAccount(id),
    });
}
function mountProjectSelect(input: MountInputs): SelectHandle {
    const options = {
        label: 'Dispatch project',
        value: input.rt.state.bindings.repoProjectSelection,
        options: [],
        searchable: true,
        searchPlaceholder: 'Search projects by name or id',
        placeholder: 'Pick a project',
        disabled: true,
        onChange: (id: string) => input.handlers.selectProject(id),
    };

    return mountSelect(input.pane, options);
}
function mountTriggerChecks(input: MountInputs): {
    readonly assignment: CheckboxHandle;
    readonly mention: CheckboxHandle;
    readonly reviewRequest: CheckboxHandle;
} {
    const assignment = mountCheckbox(input.pane, {
        label: TRIGGER_ASSIGNMENT,
        checked: input.rt.state.bindings.triggerAssignment,
        onChange: (checked) => input.handlers.setAssignment(checked),
    });
    const mention = mountCheckbox(input.pane, {
        label: TRIGGER_MENTION,
        description: MENTION_SCAN_NOTE,
        checked: input.rt.state.bindings.triggerMention,
        onChange: (checked) => input.handlers.setMention(checked),
    });
    const reviewRequest = mountCheckbox(input.pane, {
        label: TRIGGER_REVIEW,
        description: REVIEW_SCAN_NOTE,
        checked: input.rt.state.bindings.triggerReviewRequest,
        onChange: (checked) => input.handlers.setReviewRequest(checked),
    });

    return { assignment, mention, reviewRequest };
}
/**
 * Mount the add form's controls.
 *
 * @param input - Runtime, pane root, and handlers.
 * @returns The form handles.
 */
function mountAddForm(input: MountInputs): Form {
    const repoField = mountRepoField(input);
    const accountSelect = mountAccountSelect(input);
    // FR-057: the token in force, derived in `bindings-editor.ts`, under the account it belongs to.
    const mentionToken = mountBindingMention(input);
    const projectSelect = mountProjectSelect(input);
    // FR-070's "Not listed?" affordance: constant copy, no handle to keep.
    mountText(input.pane, { text: notListedGuidance() });
    const checks = mountTriggerChecks(input);
    const worktree = mountSelect(
        input.pane,
        worktreeFieldView(input.rt.state.bindings, input.handlers.setWorktree),
    );
    const actions = mountBindingActions({ pane: input.pane, handlers: input.handlers });

    return {
        repoField,
        accountSelect,
        mentionToken,
        projectSelect,
        assignment: checks.assignment,
        mention: checks.mention,
        reviewRequest: checks.reviewRequest,
        worktree,
        actions,
        note: mountText(input.pane, { text: input.rt.state.bindings.note }),
    };
}

/**
 * Dispose every handle a mounted Bindings body owns, then its own node.
 *
 * FR-017 asks teardown to release what a tab mounted, not merely to hide it —
 * the SDK handles carry listeners that would otherwise outlive the panel.
 *
 * @param input - The body's element and the two halves mounted into it.
 */
function disposeBindingsBody(input: {
    /** Element the board and the form mounted into. */
    readonly pane: HTMLElement;
    /** Status, list, and refresh half. */
    readonly board: Board;
    /** Add-form half. */
    readonly form: Form;
    /** Starting-prompt field and its save control. */
    readonly prompt: BindingPromptControls;
    /** Wrapper around the selected binding's own line. */
    readonly detailBox: HTMLElement;
    /** Chip row over that line. */
    readonly detailChips: DetailChips;
    /** The selected binding's state, stamps, and scan. */
    readonly selectedDetail: TextHandle;
}): void {
    const { pane, board, form, prompt, detailBox, detailChips, selectedDetail } = input;
    const handles = [
        board.status,
        board.bindingsList,
        board.refreshBindings,
        form.repoField,
        form.accountSelect,
        form.mentionToken,
        form.projectSelect,
        form.assignment,
        form.mention,
        form.reviewRequest,
        form.worktree,
        ...Object.values(form.actions),
        form.note,
    ];

    for (const handle of handles) {
        handle.dispose();
    }

    disposeBindingPrompt(prompt);
    detailChips.dispose();
    selectedDetail.dispose();
    detailBox.remove();
    pane.remove();
}

/**
 * Mount the selected row's own facts: its wrapper, its chips, its line.
 *
 * @param parent - The block body these facts describe rows of.
 * @returns The wrapper, the chip row, and the detail line.
 */
function mountSelectedDetail(parent: HTMLElement): {
    readonly detailBox: HTMLElement;
    readonly detailChips: DetailChips;
    readonly selectedDetail: TextHandle;
} {
    const detailBox = parent.ownerDocument.createElement('div');
    detailBox.hidden = true;
    parent.append(detailBox);

    return {
        detailBox,
        detailChips: mountDetailChips(detailBox),
        selectedDetail: mountText(detailBox, { text: '' }),
    };
}

/**
 * Mount the Bindings tab body: status, list, and the add form.
 *
 * The six-tab shell owns the strip (005 FR-010), so this mounts no tabs of its
 * own and no dispatches board — those live in their own bodies, which is what
 * makes each capability reachable through exactly one tab.
 *
 * @param input - Panel root, runtime, and the handlers the controls invoke.
 * @returns The mounted body's handles.
 */
export function mountBindingsBody(input: {
    /** Container the shell created for the Bindings tab. */
    readonly root: HTMLElement;
    /** Runtime whose state the body repaints from. */
    readonly rt: PanelRuntime;
    /** Handlers the controls invoke. */
    readonly handlers: BindingsPaneHandlers;
}): MountedPane {
    const { root, rt, handlers } = input;
    const pane = root.ownerDocument.createElement('div');
    root.append(pane);

    // Two blocks: what is bound (and the selected row's own facts), then the
    // form that creates or edits one binding.
    const listBlock = createBlock(pane, { heading: LIST_HEADING });
    const editorBlock = createBlock(pane, { heading: EDITOR_HEADING });

    const board = mountBindingsBoard({ rt, pane: listBlock.body, handlers });
    // The selected row's own facts sit between the list and the form: they
    // describe *this* binding, and the form below is where it is changed
    // (FR-053 — state, created/updated stamps, per-binding scan line).
    const { detailBox, detailChips, selectedDetail } = mountSelectedDetail(listBlock.body);
    const form = mountAddForm({ rt, pane: editorBlock.body, handlers });
    // Mounted last so the field that carries the operator's instruction sits
    // at the end of the form it belongs to, with its own save control.
    const prompt = mountBindingPrompt({ rt, pane: editorBlock.body, handlers });

    return {
        pane,
        status: board.status,
        bindingsList: board.bindingsList,
        refreshBindings: board.refreshBindings,
        repoField: form.repoField,
        accountSelect: form.accountSelect,
        mentionToken: form.mentionToken,
        projectSelect: form.projectSelect,
        assignmentCheck: form.assignment,
        mentionCheck: form.mention,
        reviewRequestCheck: form.reviewRequest,
        worktreeSelect: form.worktree,
        addBinding: form.actions.add,
        toggleSelected: form.actions.toggle,
        removeSelected: form.actions.removeSelected,
        editSelected: form.actions.edit,
        cancelEdit: form.actions.cancel,
        note: form.note,
        detailBox,
        detailChips,
        selectedDetail,
        prompt,
        dispose: () => disposeBindingsBody({ pane, board, form, prompt, detailBox, detailChips, selectedDetail }),
    };
}

/**
 * Repaint the pane from state.
 *
 * @param rt - Panel runtime.
 * @param view - The mounted pane.
 */
export function repaintBindingsPane(rt: PanelRuntime, view: BindingsPane): void {
    const { bindings } = rt.state;

    view.status.update({ text: composeStatus(bindings) });
    view.bindingsList.update({ items: bindingRows(bindings) });
    view.refreshBindings.update({ disabled: bindings.status === 'loading' });
    view.repoField.update({ value: bindings.repoInput });
    const account = accountFieldView(bindings);
    view.accountSelect.update({
        options: account.options,
        value: account.value,
        disabled: account.disabled,
    });
    repaintBindingMention(rt, view.mentionToken);
    view.projectSelect.update({
        options: formProjectOptions(rt.state.projects),
        value: bindings.repoProjectSelection,
        disabled: bindings.status !== 'ready',
    });
    view.assignmentCheck.update({ checked: bindings.triggerAssignment });
    view.mentionCheck.update({ checked: bindings.triggerMention });
    view.reviewRequestCheck.update({ checked: bindings.triggerReviewRequest });
    view.worktreeSelect.update({ value: bindings.worktreeSelection });
    repaintBindingActions({
        bindings,
        actions: {
            add: view.addBinding,
            edit: view.editSelected,
            toggle: view.toggleSelected,
            removeSelected: view.removeSelected,
            cancel: view.cancelEdit,
        },
    });
    view.note.update({ text: bindings.note });
    const detail = selectedBindingDetail(bindings);
    view.detailBox.hidden = detail === null;
    view.selectedDetail.update({ text: detail ?? '' });
    view.detailChips.paint(bindings);
    repaintBindingPrompt(rt, view.prompt);
}
