/**
 * The binding editor's edit mode (005 FR-050, FR-053).
 *
 * Three actions, one shape: **load** a row into the editor the Bindings tab
 * mounts (the row click is the affordance — the editor is not open by
 * default), **leave** that editor without writing, and **save** it through the
 * same whole-file `PUT /v1/bindings` grant every other write uses. There is
 * deliberately no per-binding endpoint here — 005 FR-050 keeps 002's MVP
 * decision closed — so an edit is a rebuilt row in a whole-list grant,
 * refused or accepted by the service like any other.
 *
 * The module is its own file for the reason `bindings-prompt.ts` is: the
 * bindings action module was already at the file-length cap, and a second
 * responsibility with its own load/save pair is exactly how a file goes over
 * it. It imports the draft reader and the draft reset from `bindings.ts` and
 * composes nothing back into it, so the two stay a one-way dependency.
 */

import { actorsRefusal, allowedUsersPatch, storedActorsFor } from './bindings-actors.ts';
import { promptRefusal, storedPromptFor } from './bindings-prompt.ts';
import { grantBindings } from './bindings-grant.ts';
import { readDraft, resetDraft, SELECT_TO_EDIT_NOTE } from './bindings.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { ServiceErrorResult } from './service-calls.ts';

/**
 * Open the editor on an empty draft — the list's **New binding** control
 *.
 *
 * Opening a new row and editing an existing one are mutually exclusive
 * states of one editor, so this does exactly what a row click does in
 * reverse: no row is selected (the add form's own signal throughout — the
 * account picker lists, the prompt field waits), every draft field returns to
 * its default, and the stale note from the last action is cleared so the form
 * opens saying nothing rather than repeating an old refusal.
 *
 */
export function startNewBinding(rt: PanelRuntime): void {
    const { bindings } = rt.state;
    resetDraft(bindings);
    bindings.selectedBinding = null;
    bindings.editing = false;
    bindings.editorOpen = true;
    bindings.startingPromptInput = '';
    bindings.startingPromptDirty = false;
    bindings.startingPromptError = null;
    bindings.allowedUsersInput = '';
    bindings.allowedUsersDirty = false;
    bindings.allowedUsersError = null;
    bindings.note = '';
    refresh(rt);
}

/**
 * Load the selected binding into the editor and enter edit mode.
 *
 *
 * Every field the editor presents is loaded from the stored row — repository,
 * bound account, project, the three triggers, the worktree option, and the
 * starting prompt (FR-051's one field, fed from the stored text) — so what
 * the form shows is what a save would write. Two refusals to load are
 * deliberate: no selection, and a worktree option this editor cannot render
 * (`new:<branch>`, which the service accepts and the panel's two-choice
 * select does not). Loading such a row would display *none* and silently
 * rewrite it on save, so the edit is refused with the reason instead
 * (FR-003: a displayed value and a saved value are the same value, or the
 * edit does not open) — and the editor **closes with a clean draft**, because
 * a form that stays open showing one row's values while another row is
 * selected is exactly how a save writes one binding's values into another.
 *
 */
export function startEditingBinding(rt: PanelRuntime): void {
    const { bindings } = rt.state;
    const binding =
        bindings.bindings.find((candidate) => candidate.bindingId === bindings.selectedBinding) ?? null;
    if (binding === null) {
        bindings.note = SELECT_TO_EDIT_NOTE;
        bindings.editorOpen = false;
        bindings.editing = false;
        resetDraft(bindings);
        refresh(rt);

        return;
    }

    if (binding.worktreeOption !== 'none' && binding.worktreeOption !== 'generated') {
        bindings.note =
            `This binding's worktree option (${binding.worktreeOption}) is not one the editor offers, ` +
            'so editing it here would change it — leave it as it is.';
        bindings.editorOpen = false;
        bindings.editing = false;
        resetDraft(bindings);
        refresh(rt);

        return;
    }

    bindings.repoInput = binding.repository;
    bindings.accountSelection = binding.accountNumericUserId;
    bindings.repoProjectSelection = binding.projectId === '' ? null : binding.projectId;
    bindings.triggerAssignment = binding.triggers.assignment;
    bindings.triggerMention = binding.triggers.mention;
    bindings.triggerReviewRequest = binding.triggers.reviewRequest;
    bindings.worktreeSelection = binding.worktreeOption === 'generated' ? 'generated' : 'none';
    bindings.startingPromptInput = storedPromptFor(bindings, binding.bindingId);
    bindings.startingPromptDirty = false;
    bindings.startingPromptError = null;
    // The allow-list loads the same way: the field shows what the
    // service holds for this row, so what the form shows is what a save writes.
    bindings.allowedUsersInput = storedActorsFor(bindings, binding.bindingId);
    bindings.allowedUsersDirty = false;
    bindings.allowedUsersError = null;
    bindings.editing = true;
    bindings.editorOpen = true;
    bindings.note = `Editing ${binding.repository}. Change the fields above, then Save changes.`;
    refresh(rt);
}

/**
 * Leave the editor and restore the add form's defaults and the prompt field.
 *
 * The editor closes: the list is the tab, and a cancelled edit leaves nothing
 * open to mistake for a saved one. The prompt field goes back to what the
 * service stores for the selected row, so a draft the operator walks away
 * from cannot be mistaken for a saved one (004 FR-014's untouched-omits rule
 * depends on the dirty flag being reset with it).
 *
 * @param note - Note to leave behind, or `null` to keep the current one (a
 *   row selection that merely closes the editor already has its own copy).
 */
export function stopEditingBinding(rt: PanelRuntime, note: string | null): void {
    const { bindings } = rt.state;
    resetDraft(bindings);
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
    if (note !== null) {
        bindings.note = note;
    }

    refresh(rt);
}

/**
 * Save the edited row through the same whole-file grant every other write
 * uses (005 FR-050: no per-binding endpoint, no second write path).
 *
 * The row is rebuilt from the draft under its own id, state, and creation
 * stamp; a prompt the operator touched in the same pass travels with the
 * write, and one they left alone is omitted so the service keeps what it
 * holds. A refusal leaves the stored list byte-identical
 * and keeps the draft on screen with the remediation — on the
 * prompt field when it belongs there, on the tab note otherwise.
 *
 */
/**
 * Apply one save's answer to the editor's state.
 *
 * **Accepted** closes the editor and repaints both fields from what the service
 * actually stored — which is what makes a *cleared* field read as cleared rather
 * than as a draft that failed to save. **Refused**
 * leaves the draft on screen with the service's own remediation split back to
 * whichever field it names and never reports the value as
 * saved; the stored list stays byte-identical because the grant is
 * all-or-nothing after validation.
 *
 * @param input - The tab state, the grant's answer, and the row this save wrote.
 */
function applySaveOutcome(input: {
    /** The Bindings tab's state. */
    readonly bindings: BindingsTabState;
    /** The grant's answer. */
    readonly answer: ServiceErrorResult;
    /** The row this save wrote. */
    readonly target: string;
}): void {
    const { bindings, answer, target } = input;
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
    resetDraft(bindings);
    bindings.startingPromptDirty = false;
    bindings.startingPromptError = null;
    // The service normalises (trim, cap, line endings), so each field shows
    // what it actually stored rather than what was typed.
    bindings.startingPromptInput = storedPromptFor(bindings, target);
    bindings.allowedUsersDirty = false;
    bindings.allowedUsersError = null;
    bindings.allowedUsersInput = storedActorsFor(bindings, target);
}

/**
 * Save the edited row through the same whole-file grant every other write
 * uses (005 FR-050: no per-binding endpoint, no second write path).
 *
 * The row is rebuilt from the draft under its own id, state, and creation
 * stamp; a prompt the operator touched in the same pass travels with the
 * write, and one they left alone is omitted so the service keeps what it
 * holds. The allow-list rides the same write with the opposite
 * default: every row states its own, and only the operator's edit overrides it
 * (002 FR-047, contract §2). A refusal leaves the stored list byte-identical
 * and keeps the draft on screen with the remediation — on the prompt
 * field or the allow-list field when it belongs there, on the
 * tab note otherwise.
 *
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
    });
    if (rt.disposed) {
        return;
    }

    applySaveOutcome({ bindings, answer, target });
    refresh(rt);
}
