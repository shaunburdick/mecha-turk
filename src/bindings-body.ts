/**
 * Mounting and disposing the Bindings tab body.
 *
 * [`bindings-ui.ts`](./bindings-ui.ts) holds the pane's contract and its
 * repaint; this module holds the **mount** — the two blocks, the controls
 * inside them, and the one disposer that releases them — because the pane's
 * mount had outgrown the file-length cap on its own.
 *
 * The shape this module builds is the review's own: **the list is the tab,
 * the editor is opened on request.** Entering the block shows the picker
 * (FR-038), the status and note lines, the list, and its toolbar — **New
 * binding**, **Refresh**, **Toggle enabled**, **Remove** — while the editor
 * block sits in a wrapper that starts `hidden` and opens on a row click or on
 * New binding. The starting-prompt field mounts inside that editor, before
 * the form's own action row, so one button writes the whole binding (005
 * FR-051; 004 FR-014's untouched-omits rides that write unchanged).
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
import type { PanelRuntime } from './panel-state.ts';
import { disposeBindingActors, mountBindingActors } from './bindings-actors.ts';
import type { BindingActorControls } from './bindings-actors.ts';
import { disposeBindingPrompt, mountBindingPrompt } from './bindings-prompt.ts';
import type { BindingPromptControls } from './bindings-prompt.ts';
import {
    accountFieldView,
    editorStateLine,
    mountBindingActions,
    mountBindingMention,
    worktreeFieldView,
} from './bindings-editor.ts';
import type { BindingActions } from './bindings-editor.ts';
import { notListedGuidance } from './project-picker.ts';
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

/** Heading above the bindings list and the selected row's own facts. */
const LIST_HEADING = 'Bindings';

/** Heading above the editor block, which the list opens on request. */
const EDITOR_HEADING = 'Binding editor';

/** The list's column labels, in the order the SDK row lays its cells out. */
const LIST_COLUMNS: readonly string[] = ['State', 'Repository and project', 'Pending'];

/** Class of the one row the list's controls share. */
const TOOLBAR_CLASS = 'mt-toolbar';

/** What the list says when the store holds nothing, naming the way to add one. */
const LIST_EMPTY = 'No binding yet — select New binding to add one, or refresh.';

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
    /** Bindings list. */
    readonly bindingsList: ListHandle;
    /** The toolbar row under the list, shared by the list's four controls. */
    readonly toolbar: HTMLElement;
    /** Refresh button (mounted into {@link Board.toolbar}). */
    readonly refreshBindings: ButtonHandle;
}

/** The editor half of the pane, which the list opens on request. */
interface Form {
    /** The loaded binding's state, stated under the editor heading. */
    readonly editorState: TextHandle;
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
    /** The actor allow-list field, beside the mention-token override. */
    readonly actors: BindingActorControls;
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
    /** The list block. */
    readonly listBlock: Block;
    /** The editor block. */
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
        emptyText: LIST_EMPTY,
        onSelect: (id: string) => handlers.selectBinding(id),
    });
    const toolbar = createToolbar(pane);
    const refresh = mountButton(
        toolbar,
        { label: 'Refresh bindings', variant: 'outline', onClick: handlers.refresh },
    );
    return { status, note, bindingsList: list, toolbar, refreshBindings: refresh };
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
    const projectSelect = mountProjectSelect(input);
    // FR-038's "Not listed?" affordance: constant copy, no handle to keep.
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
        projectSelect,
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
    disposeBindingPrompt(prompt);
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
        newBinding: actions.newBinding,
        toggleSelected: actions.toggle,
        removeSelected: actions.removeSelected,
        editorBox: input.editorBox,
        editorState: form.editorState,
        repoField: form.repoField,
        accountSelect: form.accountSelect,
        mentionToken: form.mentionToken,
        actors: form.actors,
        projectSelect: form.projectSelect,
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
    /** Anything that opens the first block ahead of this pane — FR-038's picker. */
    readonly mountFirst?: (into: HTMLElement) => void;
}): BindingsPane {
    const { root, rt, handlers } = input;
    const pane = root.ownerDocument.createElement('div');
    root.append(pane);
    const { listBlock, editorBox, editorBlock } = createBlocks(pane);

    input.mountFirst?.(listBlock.body);
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
