/**
 * The wiring that puts the Bindings tab on screen (MVP blocker, 2026-09-27).
 *
 * `bindings-ui.ts` exports {@link mountBindingsPane} and its painter, but
 * nothing called them: the panel mounted only the legacy spike UI, so the
 * operator could never reach the bindings form, could never add a binding,
 * and bindings mode could never activate. This module is that missing call
 * site. It mounts the pane first, so the shared tab strip is the panel's
 * first element and both tab bodies hang beneath it: the Bindings pane on
 * its tab, and the spike body (a plain container the legacy UI and the
 * handoff group mount into) on the other.
 *
 * Every pane callback maps onto an action that already exists: `editBindings`
 * records each draft-field patch (and repaints through `refresh`), the bindings
 * actions run the tab's reads and writes, and `switchTab` writes
 * `activeTab` for the central repaint to act on. Nothing new is invented —
 * the handlers are a table, not a layer.
 *
 * The one write spelled out here rather than imported is the starting
 * prompt's save: it is the form's own rule set (untouched omits, cleared
 * travels, a refusal lands at the field), and keeping it beside the table
 * that submits it is what stops a second implementation of those rules from
 * appearing somewhere with less reason to know them (005 FR-051, FR-052).
 */

import { loadProjects, selectBindingProject } from './project-actions.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import type { PanelRuntime } from './panel-state.ts';
import { grantBindings } from './bindings-grant.ts';
import { promptRefusal, storedPromptFor } from './bindings-prompt.ts';
import {
    bindRepository,
    editBindings,
    loadBindings,
    removeBinding,
    toggleBinding,
} from './bindings.ts';
import {
    saveEditedBinding,
    startEditingBinding,
    stopEditingBinding,
} from './bindings-edit.ts';
import { mountBindingsBody } from './bindings-ui.ts';
import type { BindingsPaneHandlers } from './bindings-ui.ts';
import { loadAuditHistory } from './audit-view.ts';
import {
    clearFilters,
    nextPage,
    previousPage,
    setBindingFilter,
    setPageLimit,
    setStateFilter,
} from './dispatches-paging.ts';
import {
    copyCorrelationId,
    loadDispatches,
    openDispatch,
    requeueRun,
    resolveNoSession,
    resolveSessionCreated,
    retryRun,
    selectDispatch,
    setSessionInput,
    toggleReferences,
} from './dispatches.ts';

/**
 * Write the edited starting prompt through the whole-file grant (FR-051).
 *
 * Three rules are enforced here rather than in the field: a save the operator
 * never asked for **does nothing at all**, so the key stays omitted and the
 * service keeps what it holds (004 FR-014); an explicit clear travels as an
 * empty string, which is how the route is told to remove it; and a refusal is
 * rendered **at the field** with the service's own remediation while the
 * stored prompt stays in force and nothing is reported as saved (FR-052).
 *
 * @param rt - Panel runtime.
 */
async function saveStartingPrompt(rt: PanelRuntime): Promise<void> {
    const { bindings } = rt.state;
    const target = bindings.selectedBinding;
    if (target === null) {
        bindings.note = 'Select a binding to edit its starting prompt.';
        refresh(rt);

        return;
    }

    if (!bindings.startingPromptDirty) {
        bindings.note = 'Nothing to save: the starting prompt was not changed.';
        refresh(rt);

        return;
    }

    const stored = bindings.bindings.find((binding) => binding.bindingId === target)?.repository ?? target;
    const clearing = bindings.startingPromptInput.trim() === '';
    const answer = await grantBindings({
        rt,
        bindings: bindings.bindings,
        note: clearing ? `Starting prompt cleared for ${stored}.` : `Starting prompt saved for ${stored}.`,
        prompt: { bindingId: target, startingPrompt: bindings.startingPromptInput },
    });
    if (rt.disposed) {
        return;
    }

    if (answer.ok) {
        bindings.startingPromptError = null;
        bindings.startingPromptDirty = false;
        // The service normalises (trim, cap, line endings), so the field shows
        // what it actually stored rather than what was typed.
        bindings.startingPromptInput = storedPromptFor(bindings, target);
    } else {
        // A refusal keeps the draft exactly as it was typed: the operator gets
        // their text back with the remediation, not a silent revert.
        const refusal = promptRefusal(answer);
        bindings.startingPromptError = refusal === null ? null : redact(refusal);
    }

    refresh(rt);
}

/**
 * The prompt field's three callbacks (005 FR-051, FR-052).
 *
 * Split out so the handler table below stays a table: selecting a row opens
 * the field on what the service holds for it, typing marks the edit, and the
 * save runs the rules spelled out in {@link saveStartingPrompt}.
 *
 * @param rt - Panel runtime the actions read and repaint.
 * @returns The handlers the field and its save control invoke.
 */
function promptHandlers(rt: PanelRuntime): Pick<
    BindingsPaneHandlers,
    'selectBinding' | 'setStartingPrompt' | 'saveStartingPrompt'
> {
    return {
        selectBinding: (id) => {
            // Selecting another row closes whatever the editor had open, the
            // way the Accounts rows do: the draft belongs to the row it was
            // loaded from, and carrying it across would let a save write one
            // binding's values into another (005 FR-050: what the form shows
            // is what the grant writes). Re-selecting the row being edited
            // keeps the edit, so a stray click does not throw work away.
            if (rt.state.bindings.editing && rt.state.bindings.selectedBinding !== id) {
                stopEditingBinding(rt, null);
            }

            editBindings(rt, {
                selectedBinding: id,
                // The editor field opens on what the service holds for this row
                // (004 FR-012) — never on a fingerprint, and never on whichever
                // row was selected before (005 FR-051).
                startingPromptInput: storedPromptFor(rt.state.bindings, id),
                startingPromptDirty: false,
                startingPromptError: null,
            });
        },
        setStartingPrompt: (value) => editBindings(rt, {
            startingPromptInput: value,
            startingPromptDirty: true,
            startingPromptError: null,
        }),
        saveStartingPrompt: () => void saveStartingPrompt(rt),
    };
}

/**
 * Map the Bindings pane's callbacks onto the existing actions.
 *
 * The pane is repainted from state on every patch (`editBindings` refreshes), so
 * the handlers stay one-line delegations and the tab cannot diverge from what
 * the runtime knows.
 *
 * @param rt - Panel runtime the actions read and repaint.
 * @returns The handler table for {@link mountBindingsPane}.
 */
export function createBindingsHandlers(rt: PanelRuntime): BindingsPaneHandlers {
    return {
        refresh: () => void loadBindings(rt),
        // One primary control, two shapes: the same button adds a row in add
        // mode and saves the loaded one in edit mode, so there is never a
        // second write path beside the whole-file grant (005 FR-050).
        submit: (): void => {
            if (rt.state.bindings.editing) {
                void saveEditedBinding(rt);

                return;
            }

            void bindRepository(rt);
        },
        toggle: () => void toggleBinding(rt),
        removeBinding: () => void removeBinding(rt),
        editBinding: () => startEditingBinding(rt),
        cancelEdit: () => stopEditingBinding(rt, 'Edit cancelled; nothing was written.'),
        setRepoInput: (value) => editBindings(rt, { repoInput: value }),
        selectAccount: (id) => editBindings(rt, { accountSelection: id }),
        selectProject: (id) => selectBindingProject(rt, id),
        setAssignment: (checked) => editBindings(rt, { triggerAssignment: checked }),
        setMention: (checked) => editBindings(rt, { triggerMention: checked }),
        setReviewRequest: (checked) => editBindings(rt, { triggerReviewRequest: checked }),
        setWorktree: (id) => editBindings(rt, { worktreeSelection: id }),
        ...promptHandlers(rt),
        refreshProjects: () => void loadProjects(rt),
        refreshDispatches: () => void loadDispatches(rt),
        selectDispatch: (id) => selectDispatch(rt, id),
        openDispatch: () => void openDispatch(rt),
        retryRun: () => void retryRun(rt),
        requeueRun: () => void requeueRun(rt),
        resolveSessionCreated: () => void resolveSessionCreated(rt),
        resolveNoSession: () => void resolveNoSession(rt),
        setSessionInput: (value) => setSessionInput(rt, value),
        loadAudit: () => void loadAuditHistory(rt),
        previousPage: () => void previousPage(rt),
        nextPage: () => void nextPage(rt),
        setPageLimit: (limit) => setPageLimit(rt, limit),
        setBindingFilter: (bindingId) => setBindingFilter(rt, bindingId),
        setStateFilter: (state) => setStateFilter(rt, state),
        clearFilters: () => clearFilters(rt),
        toggleReferences: () => toggleReferences(rt),
        copyCorrelationId: () => void copyCorrelationId(rt),
    };
}

/**
 * Mount the Bindings tab body into the container the shell created (FR-013).
 *
 * The six-tab shell owns the strip and decides when this body first appears;
 * everything here is the body itself — the status line, the list, and the add
 * form — and the runtime handle the repaint path reads.
 *
 * @param rt - Panel runtime.
 * @param root - The body container `mountTabShell` created for `bindings`.
 */
export function mountBindingsTabBody(rt: PanelRuntime, root: HTMLElement): void {
    const view = mountBindingsBody({ root, rt, handlers: createBindingsHandlers(rt) });
    // The bundle gate greps the built panel for this attribute: a string
    // literal that only ships when this pane is wired (identifier names are
    // minified away, so a marker must ride live code). It also names the pane
    // for the operator's DOM inspector.
    view.pane.setAttribute('data-mount', 'mountBindingsBody');
    rt.bindingsUi = view;
}
