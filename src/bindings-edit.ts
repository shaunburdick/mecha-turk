/**
 * The binding editor's edit mode: load a row, leave, or save through the one whole-file grant (005 FR-050, FR-053).
 */

import { actorsRefusal, allowedUsersPatch, storedActorsFor } from './bindings-actors.ts';
import { storedHistoryScopeFor } from './bindings-history.ts';
import { promptRefusal, storedPromptFor } from './bindings-prompt.ts';
import { worktreeChoice } from './bindings-editor.ts';
import { parseWorktreeOption } from './config.ts';
import { grantBindings } from './bindings-grant.ts';
import { readDraft, resetDraft, SELECT_TO_EDIT_NOTE } from './bindings.ts';
import { refresh } from './panel-ui.ts';
import { currentProjectDefault } from './project-picker.ts';
import { redact } from './redaction.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { ServiceErrorResult } from './service-calls.ts';

/**
 * Open the editor on an empty draft — the list's **New binding** control.
 * Opening a new row and editing an existing one are mutually exclusive states
 * of one editor, so this does what a row click does in reverse: no row is
 * selected (the add form's own signal throughout), every draft field returns
 * to its default, and the stale note from the last action is cleared so the
 * form opens saying nothing rather than repeating an old refusal.
 */
export function startNewBinding(rt: PanelRuntime): void {
    const { bindings } = rt.state;
    resetDraft(bindings, currentProjectDefault(rt.state));
    bindings.selectedBinding = null;
    bindings.editing = false;
    bindings.editorOpen = true;
    bindings.startingPromptInput = '';
    bindings.startingPromptDirty = false;
    bindings.startingPromptError = null;
    bindings.allowedUsersInput = '';
    bindings.allowedUsersDirty = false;
    bindings.allowedUsersError = null;
    // The documented default, so an untouched control on the add form writes the
    // default rather than a sentinel (002 FR-089).
    bindings.historyScopeInput = storedHistoryScopeFor(bindings.bindings, null);
    bindings.note = '';
    refresh(rt);
}

/**
 * Load the selected binding into the editor and enter edit mode: every field comes from the stored
 * row — including FR-051's prompt fed from the stored text, and the `new:<branch>` worktree option
 * fed into the select and the branch-name input — so what the form shows is what a save would
 * write. One refusal is deliberate: no selection. A worktree option that is not one of the three
 * (`none`, `generated`, `new:<name>`) loads as `none` and stays put, because the editor cannot
 * render a value outside its own vocabulary and inventing one would violate FR-003; every option
 * the service accepts is one the editor now offers, so nothing a save writes differs from what it
 * displayed.
 */
export function startEditingBinding(rt: PanelRuntime): void {
    const { bindings } = rt.state;
    const binding =
        bindings.bindings.find((candidate) => candidate.bindingId === bindings.selectedBinding) ?? null;
    if (binding === null) {
        bindings.note = SELECT_TO_EDIT_NOTE;
        bindings.editorOpen = false;
        bindings.editing = false;
        // Add-mode fallback, so the reset takes the displayed value; the edit
        // path below loads the binding's own project (002 FR-097(c)).
        resetDraft(bindings, currentProjectDefault(rt.state));
        refresh(rt);

        return;
    }

    const worktree = parseWorktreeOption(binding.worktreeOption);
    bindings.worktreeSelection = worktreeChoice(worktree?.kind ?? 'none');
    bindings.worktreeNameInput = worktree?.kind === 'new' ? worktree.name : '';
    bindings.repoInput = binding.repository;
    bindings.accountSelection = binding.accountNumericUserId;
    bindings.repoProjectSelection = binding.projectId === '' ? null : binding.projectId;
    bindings.triggerAssignment = binding.triggers.assignment;
    bindings.triggerMention = binding.triggers.mention;
    bindings.triggerReviewRequest = binding.triggers.reviewRequest;
    bindings.triggerReviewSubmitted = binding.triggers.reviewSubmitted;
    bindings.triggerChecks = binding.triggers.checks;
    bindings.startingPromptInput = storedPromptFor(bindings, binding.bindingId);
    bindings.startingPromptDirty = false;
    bindings.startingPromptError = null;
    // The allow-list loads the same way: the field shows what the
    // service holds for this row, so what the form shows is what a save writes.
    bindings.allowedUsersInput = storedActorsFor(bindings, binding.bindingId);
    bindings.allowedUsersDirty = false;
    bindings.allowedUsersError = null;
    // The scope loads the same way: the select opens on what the service holds
    // for this row, so an untouched save preserves the stored choice (002 FR-057).
    bindings.historyScopeInput = storedHistoryScopeFor(bindings.bindings, binding.bindingId);
    bindings.editing = true;
    bindings.editorOpen = true;
    bindings.note = `Editing ${binding.repository}. Change the fields above, then Save changes.`;
    refresh(rt);
}

/**
 * Leave the editor and restore the add form's defaults and the prompt field.
 * The editor closes: the list is the tab, and a cancelled edit leaves nothing
 * open to mistake for a saved one. The prompt field goes back to what the
 * service stores for the selected row, so an abandoned draft cannot be
 * mistaken for a saved one (004 FR-014's untouched-omits rule depends on the
 * dirty flag being reset with it). `note` leaves a message behind; `null`
 * keeps the current one.
 */
export function stopEditingBinding(rt: PanelRuntime, note: string | null): void {
    const { bindings } = rt.state;
    resetDraft(bindings, currentProjectDefault(rt.state));
    bindings.editing = false;
    bindings.editorOpen = false;
    bindings.startingPromptInput = storedPromptFor(bindings, bindings.selectedBinding);
    bindings.startingPromptDirty = false;
    bindings.startingPromptError = null;
    // The allow-list returns to what the service stores, so a draft the
    // operator walks away from cannot be mistaken for a saved one — which is
    // the same reason the dirty flag is reset with it.
    bindings.allowedUsersInput = storedActorsFor(bindings, bindings.selectedBinding);
    bindings.allowedUsersDirty = false;
    bindings.allowedUsersError = null;
    // Same reason as the allow-list: a draft the operator walks away from must not
    // be mistaken for a saved one, and the prompt's untouched-omits rule depends on
    // the draft being reset with it (002 FR-057).
    bindings.historyScopeInput = storedHistoryScopeFor(bindings.bindings, bindings.selectedBinding);
    if (note !== null) {
        bindings.note = note;
    }

    refresh(rt);
}

/**
 * Save the edited row through the same whole-file grant every other write uses (005 FR-050: no
 * per-binding endpoint): the row is rebuilt from the draft under its own id, state and creation
 * stamp, a touched prompt travels while an untouched one is omitted, and a refusal leaves the
 * stored list byte-identical with the draft and remediation on screen.
 */
/**
 * Apply one save's answer to the editor's state. **Accepted** closes the editor and repaints from
 * what the service actually stored, so a *cleared* field reads as cleared; **Refused** leaves the
 * draft with the service's remediation and never reports the value as saved — the stored list
 * stays byte-identical because the grant is all-or-nothing after validation.
 */
function applySaveOutcome(input: {
    /** The Bindings tab's state. */
    readonly bindings: BindingsTabState;
    /** The grant's answer. */
    readonly answer: ServiceErrorResult;
    /** The row this save wrote. */
    readonly target: string;
    /** The current-project default in force right now, if any (002 FR-097(b)). */
    readonly displayed: string | null;
}): void {
    const { bindings, answer, target, displayed } = input;
    if (!answer.ok) {
        const refusal = promptRefusal(answer);
        bindings.startingPromptError = refusal === null ? null : redact(refusal);
        const actorsRefused = actorsRefusal(answer);
        bindings.allowedUsersError = actorsRefused === null ? null : redact(actorsRefused);

        return;
    }

    // The service confirmed the write, so the editor closes: what the operator
    // asked for is on the list, which is the surface the result belongs to (and
    // the note now reports it).
    bindings.editing = false;
    bindings.editorOpen = false;
    resetDraft(bindings, displayed);
    bindings.startingPromptDirty = false;
    bindings.startingPromptError = null;
    // The service normalises (trim, cap, line endings), so each field shows
    // what it actually stored rather than what was typed.
    bindings.startingPromptInput = storedPromptFor(bindings, target);
    bindings.allowedUsersDirty = false;
    bindings.allowedUsersError = null;
    bindings.allowedUsersInput = storedActorsFor(bindings, target);
    // The select repaints from what the service actually stored, for the same
    // reason: a cleared field must read as cleared rather than as a draft that
    // failed to save (002 FR-089).
    bindings.historyScopeInput = storedHistoryScopeFor(bindings.bindings, target);
}

/**
 * Save the edited row through the same whole-file grant every other write
 * uses (005 FR-050: no per-binding endpoint, no second write path). The row
 * is rebuilt from the draft under its own id, state, and creation stamp; a
 * touched prompt travels with the write and an untouched one is omitted so
 * the service keeps what it holds. The allow-list rides the same write with
 * the opposite default: every row states its own, and only the operator's
 * edit overrides it (002 FR-047, contract §2). A refusal leaves the stored
 * list byte-identical and keeps the draft on screen with the remediation — on
 * the field it belongs to, the tab note otherwise.
 */
export async function saveEditedBinding(rt: PanelRuntime): Promise<void> {
    const { bindings } = rt.state;
    const target = bindings.selectedBinding;
    if (target === null) {
        bindings.note = SELECT_TO_EDIT_NOTE;
        refresh(rt);

        return;
    }

    const draft = readDraft(bindings, { bindingId: target });
    if (draft === null) {
        // The note already says why; repaint to show it.
        refresh(rt);

        return;
    }

    const prompt = bindings.startingPromptDirty
        ? { bindingId: target, startingPrompt: bindings.startingPromptInput }
        : undefined;
    const actors = allowedUsersPatch(bindings, target);
    const updated = bindings.bindings.map(
        (candidate) => (candidate.bindingId === target ? draft : candidate),
    );
    const answer = await grantBindings({
        rt,
        bindings: updated,
        note: `Saved ${draft.repository}.`,
        ...(prompt !== undefined && { prompt }),
        ...(actors !== undefined && { actors }),
        // The editor's own select, for the row being saved. The patch **names that
        // row**, which is what keeps the override on this binding: every other row
        // states its own stored mode, so an edit here cannot be read by the service
        // as a mode change elsewhere (002 FR-057, FR-084).
        historyScope: { bindingId: target, historyScope: draft.historyScope },
    });
    if (rt.disposed) {
        return;
    }

    applySaveOutcome({ bindings, answer, target, displayed: currentProjectDefault(rt.state) });
    refresh(rt);
}
