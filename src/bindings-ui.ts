/**
 * The Bindings pane's contract and its repaint (M3 re-cut).
 *
 * **The list is the tab, and the editor is opened on request** (2026-10-01
 * product-owner review): entering the tab shows the status and note lines,
 * the list, and its row controls — **New binding**, **Refresh**, **Toggle
 * enabled**, **Remove** — while the editor block underneath stays hidden
 * until a row is clicked (which loads that row into it) or **New binding**
 * is activated (which opens an empty draft). The editor carries the project
 * controls — the *Dispatch project* select with **Reload projects** and the
 * list's status line beside it (issue #39) — states the loaded binding's
 * enabled/disabled state in words, so *Toggle enabled* is never the only
 * place that truth lives, and holds the starting prompt as a field of that
 * same form: one primary button writes all of it.
 *
 * This module owns what those controls **are** ({@link BindingsPane}), what
 * they ask for ({@link BindingsPaneHandlers}), the tab's status copy, and the
 * painter that keeps them equal to runtime state. The mount and the disposer
 * live in [`bindings-body.ts`](./bindings-body.ts), which builds the shape
 * described above.
 *
 * Every service-supplied string reaches the DOM through the SDK primitives'
 * `textContent` writes — no HTML sink is touched (panel-service contract §3
 * invariant 11). The binding list rows — the scan stamp, skip reason, and
 * pending count the operator reads per row — live in `bindings-rows.ts`, and
 * the dispatches row copy lives beside it in `dispatches-rows.ts` (M8).
 */

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
import { repaintBindingPrompt } from './bindings-prompt.ts';
import type { BindingPromptControls, BindingPromptHandlers } from './bindings-prompt.ts';
import { emptyBindingsText, repaintAccountReason } from './bindings-accounts.ts';
import type { AccountReasonControls } from './bindings-accounts.ts';
import { repaintBindingActors } from './bindings-actors.ts';
import type { BindingActorControls, BindingActorHandlers } from './bindings-actors.ts';
import { historyScopeHelp, repaintBindingHistoryScope, windowInForceLine } from './bindings-history.ts';
import type { BindingHistoryScopeControls, BindingHistoryScopeHandlers } from './bindings-history.ts';
import { accountFieldView, editorStateLine, repaintBindingActions, repaintBindingMention } from './bindings-editor.ts';
import { bindingRows, selectedBindingDetail } from './bindings-rows.ts';
import { formProjectOptions, pickerNote } from './project-picker.ts';
import type { DetailChips } from './bindings-chips.ts';

/** The pane handle: the mounted element and every repaint handle it needs. */
export interface BindingsPane {
    /** The pane root this view mounted. */
    readonly pane: HTMLElement;
    /** FR-090's guidance under the editor's history-scope control. */
    readonly historyScopeHelp: TextHandle;
    /** The window-in-force line under the editor's history-scope control (002 FR-092). */
    readonly windowScopeLine: TextHandle;
    /** Status line at the top. */
    readonly status: TextHandle;
    /** The tab's note line, under the status: refusals and results (FR-085). */
    readonly note: TextHandle;
    /** Bindings list with per-binding scan lines. */
    readonly bindingsList: ListHandle;
    readonly refreshBindings: ButtonHandle;
    /**
     * FR-121's reason line, under the list's toolbar.
     *
     * Hidden outright whenever the gate does not hold — and its text empty then
     * too, so "absent" survives a DOM reading as well as a visual one.
     */
    readonly newBindingReason: AccountReasonControls;
    /** Opens the editor on an empty draft — disabled while zero accounts exist. */
    readonly newBinding: ButtonHandle;
    /** Enable/disable toggle for the selected row; a list-level control. */
    readonly toggleSelected: ButtonHandle;
    /** Removal button for the selected row; a list-level control. */
    readonly removeSelected: ButtonHandle;
    /** Wrapper around the editor block, hidden until an edit is invoked. */
    readonly editorBox: HTMLElement;
    /** The loaded binding's enabled/disabled state, stated in the editor. */
    readonly editorState: TextHandle;
    /** Repository owner/name input. */
    readonly repoField: TextFieldHandle;
    /** Account select: fixed to the binding in edit mode, a picker in add mode. */
    readonly accountSelect: SelectHandle;
    /** The mention token in force, marked when it differs. */
    readonly mentionToken: TextHandle;
    /** The actor allow-list field — the only element holding its logins. */
    readonly actors: BindingActorControls;
    /**
     * The history-scope control — the **only** place the mode renders panel-wide
     * (002 FR-091).
     */
    readonly historyScope: BindingHistoryScopeControls;
    /** Project select (from the host's project list). */
    readonly projectSelect: SelectHandle;
    /** **Reload projects**, beside the project select (issue #39). */
    readonly projectRefresh: ButtonHandle;
    /** The project list's loading/error/empty/count status line. */
    readonly projectStatus: TextHandle;
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
    /** Closes the open editor without writing it. */
    readonly cancelEdit: ButtonHandle;
    /** Wrapper around the selected binding's own line (005 FR-053). */
    readonly detailBox: HTMLElement;
    /** Chip row over that line: the binding's state and its triggers. */
    readonly detailChips: DetailChips;
    /** State, created/updated stamps, and scan of the selected binding. */
    readonly selectedDetail: TextHandle;
    /** The starting-prompt field — the form's own field, saved with the form. */
    readonly prompt: BindingPromptControls;
    /** Remove every node this pane mounted. */
    readonly dispose: () => void;
}

/** Callbacks the mounted Bindings pane invokes. */
export interface BindingsPaneHandlers
    extends DispatchControlsHandlers, BindingPromptHandlers, BindingActorHandlers, BindingHistoryScopeHandlers {
    /** Operators re-read the bindings and accounts. */
    readonly refresh: () => void;
    /** Operators submitted the add form. */
    readonly submit: () => void;
    /** Operators toggled a binding's enabled state (selected row). */
    readonly toggle: () => void;
    /** Operators removed the selected binding from the granted list. */
    readonly removeBinding: () => void;
    /** Operators asked for a fresh binding editor on an empty draft. */
    readonly newBinding: () => void;
    /** Operators walked away from the open editor without writing it. */
    readonly cancelEdit: () => void;
    /** Operators changed the repository input. */
    readonly setRepoInput: (value: string) => void;
    /** Operators picked an account. */
    readonly selectAccount: (id: string) => void;
    /** Operators picked a project. */
    readonly selectProject: (id: string) => void;
    /** Operators set the assignment trigger checkbox. */
    readonly setAssignment: (isChecked: boolean) => void;
    /** Operators set the mention trigger checkbox. */
    readonly setMention: (isChecked: boolean) => void;
    /** Operators set the review-request trigger checkbox. */
    readonly setReviewRequest: (isChecked: boolean) => void;
    /** Operators picked a worktree option. */
    readonly setWorktree: (id: 'none' | 'generated') => void;
    /** Operators clicked a binding row — which loads it into the editor. */
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

/**
 * Compose the pane's one status line.
 *
 * Exported because [`bindings-body.ts`](./bindings-body.ts) paints it at
 * mount and this module repaints it: one copy of the count, two moments.
 *
 * @returns The summary text the status line shows.
 */
export function composeStatus(bindings: BindingsTabState): string {
    const enabled = bindings.bindings.filter((binding) => binding.state === 'active').length;

    return `Bindings: ${bindings.bindings.length} (${enabled} enabled) · Accounts: ${bindings.accounts.length}`;
}

/**
 * Repaint the pane from state.
 */
export function repaintBindingsPane(rt: PanelRuntime, view: BindingsPane): void {
    const { bindings } = rt.state;

    view.status.update({ text: composeStatus(bindings) });
    view.note.update({ text: bindings.note });
    view.bindingsList.update({ items: bindingRows(bindings), emptyText: emptyBindingsText(bindings) });
    repaintAccountReason(bindings, view.newBindingReason);
    view.refreshBindings.update({ disabled: bindings.status === 'loading' });
    view.editorBox.hidden = !bindings.editorOpen;
    view.editorState.update({ text: editorStateLine(bindings) });
    view.repoField.update({ value: bindings.repoInput });
    const account = accountFieldView(bindings);
    view.accountSelect.update({
        options: account.options,
        value: account.value,
        disabled: account.disabled,
    });
    repaintBindingMention(rt, view.mentionToken);
    repaintBindingActors(rt, view.actors);
    repaintBindingHistoryScope(rt, view.historyScope);
    // FR-090: the guidance follows the editor's mode. The catch-up sentence is the
    // warning an operator needs *before* choosing the look-back on a binding that
    // already scans, and a string mounted once would never say it there.
    view.historyScopeHelp.update({ text: historyScopeHelp(bindings) });
    view.windowScopeLine.update({
        text: windowInForceLine(bindings.statusRows.find((row) => row.bindingId === bindings.selectedBinding) ?? null)
            ?? '',
    });
    view.projectSelect.update({
        options: formProjectOptions(rt.state.projects),
        value: bindings.repoProjectSelection,
        disabled: bindings.status !== 'ready',
    });
    // The list's own status line: the one surface that says why a
    // `host.listProjects()` failure left the select empty, and where the
    // reload button's retry lands (issue #39, constitution II).
    view.projectStatus.update({ text: pickerNote(rt.state.projects) });
    view.assignmentCheck.update({ checked: bindings.triggerAssignment });
    view.mentionCheck.update({ checked: bindings.triggerMention });
    view.reviewRequestCheck.update({ checked: bindings.triggerReviewRequest });
    view.worktreeSelect.update({ value: bindings.worktreeSelection });
    repaintBindingActions({
        bindings,
        actions: {
            add: view.addBinding,
            cancel: view.cancelEdit,
            newBinding: view.newBinding,
            toggle: view.toggleSelected,
            removeSelected: view.removeSelected,
        },
    });
    const detail = selectedBindingDetail(bindings);
    view.detailBox.hidden = detail === null;
    view.selectedDetail.update({ text: detail ?? '' });
    view.detailChips.paint(bindings);
    repaintBindingPrompt(rt, view.prompt);
}
