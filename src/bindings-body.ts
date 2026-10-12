/**
 * Mounting and disposing the Bindings tab body.
 *
 * [`bindings-ui.ts`](./bindings-ui.ts) holds the pane's contract and its
 * repaint; this module holds the **mount** — the two blocks, the controls
 * inside them, and the one disposer that releases them — because the pane's
 * mount had outgrown the file-length cap on its own.
 *
 * The shape this module builds is the review's own: **the list is the tab,
 * the editor is opened on request.** Entering the block shows the status and
 * note lines, the list, and its toolbar — **New binding**, **Refresh**,
 * **Toggle enabled**, **Remove** — while the editor block sits in a wrapper
 * that starts `hidden` and opens on a row click or on New binding. The
 * editor holds the project controls: the *Dispatch project* select with
 * **Reload projects** and the list's status line beside it (issue #39 moved
 * them here, so a failed `host.listProjects()` still has a surface that says
 * why and offers a retry), and the starting-prompt field before the form's
 * own action row, so one button writes the whole binding (005 FR-051; 004
 * FR-014's untouched-omits rides that write unchanged).
 *
 * Every control is a documented SDK primitive handing its strings to the
 * SDK's text path — no HTML sink (panel-service contract §3 invariant 11) —
 * and every one of them is disposed here (FR-017).
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
import type { BindingStatusRow } from './bindings-service.ts';
import { disposeBindingActors, mountBindingActors } from './bindings-actors.ts';
import type { BindingActorControls } from './bindings-actors.ts';
import {
    disposeBindingHistoryScope,
    historyScopeHelp,
    mountBindingHistoryScope,
    windowInForceLine,
} from './bindings-history.ts';
import type { BindingHistoryScopeControls } from './bindings-history.ts';
import { disposeBindingPrompt, mountBindingPrompt } from './bindings-prompt.ts';
import type { BindingPromptControls } from './bindings-prompt.ts';
import {
    ACCOUNT_PICKER_PLACEHOLDER,
    disposeAccountReason,
    emptyBindingsText,
    mountAccountReason,
} from './bindings-accounts.ts';
import type { AccountReasonControls } from './bindings-accounts.ts';
import {
    accountFieldView,
    editorStateLine,
    mountBindingActions,
    mountBindingMention,
    worktreeFieldView,
} from './bindings-editor.ts';
import type { BindingActions } from './bindings-editor.ts';
import { notListedGuidance, pickerNote } from './project-picker.ts';
import { mountDetailChips, TRIGGER_ASSIGNMENT, TRIGGER_MENTION, TRIGGER_REVIEW } from './bindings-chips.ts';
import type { DetailChips } from './bindings-chips.ts';
import { createBlock, mountColumnHead, mountStyledText } from './style.ts';
import type { Block } from './style.ts';
import { composeStatus } from './bindings-ui.ts';
import type { BindingsPane, BindingsPaneHandlers } from './bindings-ui.ts';

/** Note under the mention checkbox (M6's comment *and* issue-body scan). */
export const MENTION_SCAN_NOTE = 'Issue bodies and comments that @mention the bound account open a dispatch.';

/** Note under the review-request checkbox (M7). */
export const REVIEW_SCAN_NOTE = 'Pull requests that ask the account to review open a dispatch.';

/**
 * How the history-scope guidance reaches the operator (002 FR-090).
 *
 * Mounted as prose rather than as a select `description`, because the SDK's
 * `SelectProps` has no such member and because six sentences of operator-facing
 * guidance are not a caption. It sits directly under the control it explains, so
 * the operator meets it **without opening anything else** — which is the
 * requirement's own wording.
 *
 * It is mounted as a handle and **repainted from state**, not evaluated once: the
 * add and edit paths differ on the one claim that matters before a catch-up opens,
 * and the editor is a single mounted block reused for both.
 */

/** Heading above the bindings list and the selected row's own facts. */
const LIST_HEADING = 'Bindings';

/** Heading above the editor block, which the list opens on request. */
const EDITOR_HEADING = 'Binding editor';

/** The list's column labels, in the order the SDK row lays its cells out. */
const LIST_COLUMNS: readonly string[] = ['State', 'Repository and project', 'Pending'];

/** Class of the one row the list's controls share. */
const TOOLBAR_CLASS = 'mt-toolbar';

/** Inputs the mounts share (runtime, pane root, handlers). */
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
    /** The tab's note line, under the status. */
    readonly note: TextHandle;
    readonly bindingsList: ListHandle;
    /** The toolbar row under the list, shared by the list's four controls. */
    readonly toolbar: HTMLElement;
    /** Refresh button (mounted into {@link Board.toolbar}). */
    readonly refreshBindings: ButtonHandle;
    /**
     * FR-121's reason line, mounted **directly after** the toolbar.
     *
     * Beside the control it explains rather than inside the editor the operator
     * has not been able to open, and hidden outright whenever the gate does not
     * hold.
     */
    readonly newBindingReason: AccountReasonControls;
}

/**
 * The two lines the history-scope field mounts around itself.
 *
 * **Both are derived or explanatory prose, not controls.** The guidance is FR-090's
 * six statements the operator must meet without opening anything else; the window
 * line is FR-092's derived state — the lower bound of the window this binding's
 * next scan will open, the mode that produced it, and whether a recovery replay
 * is in force (FR-078).
 *
 * Held as one object so the disposer releases both from the call site that
 * mounted them; a handle that is mounted and never released outlives the panel's
 * listeners (005 FR-017).
 */
interface HistoryScopeLines {
    /** FR-090's guidance, mounted directly under the control. */
    readonly help: TextHandle;
    /** FR-092's derived window line, under the guidance. */
    readonly window: TextHandle;
}

/** The editor half of the pane, which the list opens on request. */
interface Form {
    /** The loaded binding's state, stated under the editor heading. */
    readonly editorState: TextHandle;
    /** Repository input. */
    readonly repoField: TextFieldHandle;
    readonly accountSelect: SelectHandle;
    /** Mention-token line under the account field. */
    readonly mentionToken: TextHandle;
    readonly projectSelect: SelectHandle;
    /**
     * **Reload projects**, beside the project select (issue #39 relocated it
     * here from the removed panel-level picker).
     */
    readonly projectRefresh: ButtonHandle;
    /** The project list's loading/error/empty/count status line. */
    readonly projectStatus: TextHandle;
    readonly assignment: CheckboxHandle;
    readonly mention: CheckboxHandle;
    /** Review-request checkbox. */
    readonly reviewRequest: CheckboxHandle;
    readonly worktree: SelectHandle;
    /** The actor allow-list field, beside the mention-token override. */
    readonly actors: BindingActorControls;
    /** The history-scope control and the derived window line beneath it. */
    readonly historyScope: BindingHistoryScopeControls;
    readonly historyScopeLines: HistoryScopeLines;
}

/** The selected row's wrapper, its chip row, and its detail line. */
interface SelectedDetail {
    /** Wrapper, hidden while nothing is selected. */
    readonly detailBox: HTMLElement;
    /** Chip row over the line: state and triggers. */
    readonly detailChips: DetailChips;
    /** State, stamps, and scan of the selected binding. */
    readonly selectedDetail: TextHandle;
}

/** Everything the pane's disposer needs, assembled by {@link mountBindingsBody}. */
interface BodyParts {
    /** Element the two blocks mounted into. */
    readonly pane: HTMLElement;
    readonly listBlock: Block;
    readonly editorBlock: Block;
    /** Status, note, list, and toolbar half. */
    readonly board: Board;
    /** Editor half. */
    readonly form: Form;
    /** The editor's and the list's control rows. */
    readonly actions: BindingActions;
    /** Actor allow-list field. */
    readonly actors: BindingActorControls;
    /** Starting-prompt field. */
    readonly prompt: BindingPromptControls;
    /** The selected row's wrapper, chips, and line. */
    readonly detail: SelectedDetail;
}

/**
 * Create the toolbar row a block's controls share.
 *
 * @returns The row element.
 */
function createToolbar(into: HTMLElement): HTMLElement {
    const toolbar = into.ownerDocument.createElement('div');
    toolbar.className = TOOLBAR_CLASS;
    into.append(toolbar);

    return toolbar;
}

/**
 * Mount the bindings list half: status, note, list, and its toolbar row.
 *
 * The note sits directly under the status rather than under the form, because
 * a note reports what an action *did* — a refused write, a removal, a failed
 * read — and the editor being closed must not hide that answer.
 */
function mountBindingsBoard(input: MountInputs): Board {
    const { pane, rt, handlers } = input;
    const status = mountStyledText(pane, { className: 'mt-lede', text: composeStatus(rt.state.bindings) });
    const note = mountText(pane, { text: rt.state.bindings.note });
    const grid = pane.ownerDocument.createElement('div');
    grid.className = 'mt-list';
    pane.append(grid);
    mountColumnHead(grid, { modifier: 'mt-head--bindings', cells: LIST_COLUMNS });
    const list = mountList(grid, {
        items: [],
        ariaLabel: 'Bindings',
        emptyText: emptyBindingsText(rt.state.bindings),
        onSelect: (id: string) => handlers.selectBinding(id),
    });
    const toolbar = createToolbar(pane);
    const refresh = mountButton(
        toolbar,
        { label: 'Refresh bindings', variant: 'outline', onClick: handlers.refresh },
    );
    // FR-121: the reason belongs directly under the control row it explains.
    const newBindingReason = mountAccountReason({ rt, pane });
    return { status, note, bindingsList: list, toolbar, refreshBindings: refresh, newBindingReason };
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
        placeholder: ACCOUNT_PICKER_PLACEHOLDER,
        disabled: view.disabled,
        onChange: (id) => input.handlers.selectAccount(id),
    });
}
/** The project controls the add form mounts together (issue #39). */
interface ProjectControls {
    readonly projectSelect: SelectHandle;
    /** **Reload projects**, beside the select. */
    readonly projectRefresh: ButtonHandle;
    /** The project list's loading/error/empty/count status line. */
    readonly projectStatus: TextHandle;
}

function mountProjectSelect(input: MountInputs): ProjectControls {
    const projectSelect = mountSelect(input.pane, {
        label: 'Dispatch project',
        value: input.rt.state.bindings.repoProjectSelection,
        options: [],
        searchable: true,
        searchPlaceholder: 'Search projects by name or id',
        placeholder: 'Pick a project',
        disabled: true,
        onChange: (id: string) => input.handlers.selectProject(id),
    });
    // Issue #39: the reload button and the list's status line moved here with
    // the picker's removal, so a failed `host.listProjects()` still has a
    // surface that says why and offers a retry (constitution II, fail closed).
    const projectRefresh = mountButton(input.pane, {
        label: 'Reload projects',
        variant: 'secondary',
        onClick: input.handlers.refreshProjects,
    });
    const projectStatus = mountText(input.pane, { text: pickerNote(input.rt.state.projects) });

    return { projectSelect, projectRefresh, projectStatus };
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
 * The status row for the binding the editor is open on.
 *
 * `null` in add mode and whenever the panel holds no row for the selection — an
 * absent row is not a row with zeroes, and {@link windowInForceLine} says nothing
 * rather than claiming a window it cannot see (002 FR-092).
 *
 * @param bindings - The Bindings tab's state.
 * @returns The row, or `null`.
 */
function statusRowFor(bindings: BindingsTabState): BindingStatusRow | null {
    if (bindings.selectedBinding === null) {
        return null;
    }

    return bindings.statusRows.find((row) => row.bindingId === bindings.selectedBinding) ?? null;
}

/**
 * Mount the editor's controls: the state line, then the fields.
 *
 * The state line leads because it is the fact the whole form acts on — the
 * 2026-10-01 review found no indication in the editor that the binding is
 * enabled or disabled, which made *Toggle enabled* the only place that truth
 * lived. The starting prompt mounts with these fields (005 FR-051: one field,
 * in the binding's editor) and is written by the same **Save changes** as
 * everything above it, so it reads as part of the binding rather than as a
 * section of its own.
 *
 * @returns The form handles.
 */
function mountAddForm(input: MountInputs): Form {
    const editorState = mountStyledText(input.pane, {
        className: 'mt-prose',
        text: editorStateLine(input.rt.state.bindings),
    });
    const repoField = mountRepoField(input);
    const accountSelect = mountAccountSelect(input);
    // FR-057: the token in force, derived in `bindings-editor.ts`, under the account it belongs to.
    const mentionToken = mountBindingMention(input);
    // FR-090: the allow-list sits beside the mention-token override, because the
    // two of them are what decides *what counts as a trigger for this
    // repository* (005 clarification row 38).
    const actors = mountBindingActors(input);
    // FR-090: the history scope decides *when* a trigger is looked for, so it
    // mounts with the trigger switches, immediately after the allow-list that
    // decides *who* may cause one.
    const historyScope = mountBindingHistoryScope(input);
    // FR-090's guidance and FR-092's derived window line, both mounted directly
    // under the control they belong to.
    const historyScopeLines: HistoryScopeLines = {
        // FR-090: the guidance is **repainted** from state, because the add and edit
        // paths say different things about what a catch-up will offer.
        help: mountStyledText(input.pane, {
            className: 'mt-prose',
            text: historyScopeHelp(input.rt.state.bindings),
        }),
        window: mountStyledText(input.pane, {
            className: 'mt-prose',
            text: windowInForceLine(statusRowFor(input.rt.state.bindings)) ?? '',
        }),
    };
    const { projectSelect, projectRefresh, projectStatus } = mountProjectSelect(input);
    // FR-038's "Not listed?" affordance: constant copy, no handle to keep,
    // mounted directly under the project controls it explains.
    // Prose, so it keeps a measure on a rail (`.mt-prose` caps it at 72ch).
    mountStyledText(input.pane, { className: 'mt-prose', text: notListedGuidance() });
    const checks = mountTriggerChecks(input);
    const worktree = mountSelect(
        input.pane,
        worktreeFieldView(input.rt.state.bindings, input.handlers.setWorktree),
    );

    return {
        editorState,
        repoField,
        accountSelect,
        mentionToken,
        actors,
        historyScope,
        historyScopeLines,
        projectSelect,
        projectRefresh,
        projectStatus,
        assignment: checks.assignment,
        mention: checks.mention,
        reviewRequest: checks.reviewRequest,
        worktree,
    };
}

/**
 * Mount the selected row's own facts: its wrapper, its chips, its line.
 *
 * @returns The wrapper, the chip row, and the detail line.
 */
function mountSelectedDetail(parent: HTMLElement): SelectedDetail {
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
 * Release every handle the body mounted, then its own nodes.
 *
 * Teardown releases what the tab mounted rather than merely hiding it — the
 * SDK handles carry listeners that would otherwise outlive the panel — and
 * both block headings go with their blocks.
 */
function disposeBindingsBody(input: BodyParts): void {
    const { pane, listBlock, editorBlock, board, form, actions, actors, prompt, detail } = input;
    const handles = [
        board.status,
        board.note,
        board.bindingsList,
        board.refreshBindings,
        form.editorState,
        form.repoField,
        form.accountSelect,
        form.mentionToken,
        form.projectSelect,
        form.projectRefresh,
        form.projectStatus,
        form.assignment,
        form.mention,
        form.reviewRequest,
        form.worktree,
        ...Object.values(actions),
    ];

    for (const handle of handles) {
        handle.dispose();
    }

    detail.detailBox.remove();
    disposeBindingActors(actors);
    disposeBindingHistoryScope(form.historyScope);
    form.historyScopeLines.help.dispose();
    form.historyScopeLines.window.dispose();
    disposeBindingPrompt(prompt);
    disposeAccountReason(board.newBindingReason);
    detail.detailChips.dispose();
    detail.selectedDetail.dispose();
    listBlock.dispose();
    editorBlock.dispose();
    pane.remove();
}

/**
 * Create the two blocks: the list that is the tab, and the editor that it
 * opens (hidden until a row click or New binding says otherwise).
 *
 * The editor block lives in its own wrapper so hiding it is one attribute on
 * one element rather than a claim about which node `createBlock` handed back.
 *
 * @returns The list block, the wrapper, and the editor block inside it.
 */
function createBlocks(pane: HTMLElement): {
    readonly listBlock: Block;
    readonly editorBox: HTMLElement;
    readonly editorBlock: Block;
} {
    // Two blocks, and the first carries the tab title: one rule across the six
    // tabs — the tab title is the first block's heading, controls live in it.
    const listBlock = createBlock(pane, { heading: LIST_HEADING, title: true });
    const editorBox = pane.ownerDocument.createElement('div');
    pane.append(editorBox);
    const editorBlock = createBlock(editorBox, { heading: EDITOR_HEADING });

    return { listBlock, editorBox, editorBlock };
}

/**
 * Assemble the pane the disposer and the repaint share.
 *
 * @returns The pane handle, with its one disposer attached.
 */
function assemblePane(input: BodyParts & { readonly editorBox: HTMLElement }): BindingsPane {
    const { board, form, actions, detail } = input;

    return {
        pane: input.pane,
        status: board.status,
        note: board.note,
        bindingsList: board.bindingsList,
        refreshBindings: board.refreshBindings,
        newBindingReason: board.newBindingReason,
        newBinding: actions.newBinding,
        toggleSelected: actions.toggle,
        removeSelected: actions.removeSelected,
        editorBox: input.editorBox,
        editorState: form.editorState,
        repoField: form.repoField,
        accountSelect: form.accountSelect,
        mentionToken: form.mentionToken,
        actors: form.actors,
        historyScope: form.historyScope,
        historyScopeHelp: form.historyScopeLines.help,
        windowScopeLine: form.historyScopeLines.window,
        projectSelect: form.projectSelect,
        projectRefresh: form.projectRefresh,
        projectStatus: form.projectStatus,
        assignmentCheck: form.assignment,
        mentionCheck: form.mention,
        reviewRequestCheck: form.reviewRequest,
        worktreeSelect: form.worktree,
        addBinding: actions.add,
        cancelEdit: actions.cancel,
        detailBox: detail.detailBox,
        detailChips: detail.detailChips,
        selectedDetail: detail.selectedDetail,
        prompt: input.prompt,
        dispose: () => disposeBindingsBody(input),
    };
}

/**
 * Mount the Bindings tab body: the list first, the editor behind it.
 *
 * The six-tab shell owns the strip, so this mounts no tabs of
 * its own and no dispatches board — those live in their own bodies, which is
 * what makes each capability reachable through exactly one tab.
 *
 * @returns The mounted body's handles.
 */
export function mountBindingsBody(input: {
    /** Container the shell created for the Bindings tab. */
    readonly root: HTMLElement;
    /** Runtime whose state the body repaints from. */
    readonly rt: PanelRuntime;
    /** Handlers the controls invoke. */
    readonly handlers: BindingsPaneHandlers;
}): BindingsPane {
    const { root, rt, handlers } = input;
    const pane = root.ownerDocument.createElement('div');
    root.append(pane);
    const { listBlock, editorBox, editorBlock } = createBlocks(pane);

    const board = mountBindingsBoard({ rt, pane: listBlock.body, handlers });
    // The selected row's own facts sit under the list they describe.
    const detail = mountSelectedDetail(listBlock.body);
    const form = mountAddForm({ rt, pane: editorBlock.body, handlers });
    // The starting prompt is a field of this form, so it mounts before the
    // form's own controls: the buttons end the form they submit, and one
    // button writes all of it (FR-051, 004 FR-014 — untouched still omits; the
    // allow-list above rides the same write, where omission means *unset*).
    const prompt = mountBindingPrompt({ rt, pane: editorBlock.body, handlers });
    const actions = mountBindingActions({
        editor: createToolbar(editorBlock.body),
        row: board.toolbar,
        handlers,
    });
    editorBox.hidden = !rt.state.bindings.editorOpen;

    return assemblePane({
        pane,
        listBlock,
        editorBlock,
        board,
        form,
        actions,
        actors: form.actors,
        prompt,
        detail,
        editorBox,
    });
}
