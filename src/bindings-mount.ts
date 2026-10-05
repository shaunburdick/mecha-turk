/**
 * The wiring that puts the Bindings tab on screen (MVP blocker, 2026-09-27).
 *
 * `bindings-ui.ts` exports {@link mountBindingsPane} and its painter, but
 * nothing called them: the panel mounted only the legacy UI, so the
 * operator could never reach the bindings form, could never add a binding,
 * and bindings mode could never activate. This module is that missing call
 * site. It mounts the pane first, so the shared tab strip is the panel's
 * first element and both tab bodies hang beneath it: the Bindings pane on
 * its tab, and the dispatch body (a plain container the legacy UI and the
 * handoff group mount into) on the other.
 *
 * Every pane callback maps onto an action that already exists: `editBindings`
 * records each draft-field patch (and repaints through `refresh`), the bindings
 * actions run the tab's reads and writes, and `switchTab` writes
 * `activeTab` for the central repaint to act on. Nothing new is invented —
 * the handlers are a table, not a layer.
 *
 * The two handlers that carry the 2026-10-01 review's shape are spelled out
 * here: **selecting a row loads it into the editor** (the row *is* the Edit
 * affordance, and a stray click on the row being edited keeps the edit open),
 * and **New binding** opens the same editor on an empty draft. The starting
 * prompt travels with whichever primary control writes — untouched omits,
 * cleared travels, a refusal lands at the field — all of it through
 * `saveEditedBinding`, so those rules have exactly one home (005 FR-051,
 * FR-052; 004 FR-014).
 */

import { loadProjects, selectBindingProject } from './project-actions.ts';
import type { PanelRuntime } from './panel-state.ts';
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
    startNewBinding,
    stopEditingBinding,
} from './bindings-edit.ts';
import { storedActorsFor } from './bindings-actors.ts';
import { storedPromptFor } from './bindings-prompt.ts';
import { mountBindingsBody } from './bindings-body.ts';
import { repaintBindingsPane } from './bindings-ui.ts';
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
 * The prompt field's callback, and the row click that opens the editor.
 *
 *
 * Split out so the handler table below stays a table. Selecting a row both
 * selects it and loads it into the editor — the row *is* the Edit affordance
 * since the 2026-10-01 review — so the field opens on what the service holds
 * for that row, never on a fingerprint and never on whichever row was
 * selected before.
 *
 * @returns The handlers the fields invoke.
 */
function promptHandlers(rt: PanelRuntime): Pick<
    BindingsPaneHandlers,
    'selectBinding' | 'setStartingPrompt' | 'setAllowedUsers'
> {
    return {
        selectBinding: (id) => {
            const { bindings } = rt.state;
            // A stray click on the row being edited keeps the edit, so a
            // passing click does not throw work away.
            if (bindings.editing && bindings.selectedBinding === id) {
                return;
            }

            // Clicking another row cancels the open edit first, the way the
            // Accounts rows do: the draft belongs to the row it was loaded
            // from, and carrying it across would let a save write one
            // binding's values into another (005 FR-050: what the form shows
            // is what the grant writes).
            if (bindings.editing) {
                stopEditingBinding(rt, null);
            }

            // The selection is patched here rather than through
            // `editBindings`, because the load below repaints: one click must
            // paint once, and SC-105 counts the paints that carry the prompt.
            bindings.selectedBinding = id;
            // The editor fields open on what the service holds for this row
            // — never on a fingerprint, and never on
            // whichever row was selected before.
            bindings.startingPromptInput = storedPromptFor(bindings, id);
            bindings.startingPromptDirty = false;
            bindings.startingPromptError = null;
            bindings.allowedUsersInput = storedActorsFor(bindings, id);
            bindings.allowedUsersDirty = false;
            bindings.allowedUsersError = null;
            // The click opens the editor on this row — or refuses to open it
            // (a worktree option this editor cannot render) and says why with
            // the editor shut and the draft clean.
            startEditingBinding(rt);
        },
        setStartingPrompt: (value) => editBindings(rt, {
            startingPromptInput: value,
            startingPromptDirty: true,
            startingPromptError: null,
        }),
        setAllowedUsers: (value) => editBindings(rt, {
            allowedUsersInput: value,
            allowedUsersDirty: true,
            allowedUsersError: null,
        }),
    };
}

/**
 * The note a cancelled editor leaves behind.
 *
 * A loaded edit says it wrote nothing, because that is the promise the
 * control makes; the add form simply closes — there was no row to disown, and
 * an empty note is the honest one rather than claiming a cancelled *edit*
 * that never started.
 *
 * @returns The note, which may be empty but is never `null`-meaningful.
 */
function cancelNote(rt: PanelRuntime): string {
    return rt.state.bindings.editing ? 'Edit cancelled; nothing was written.' : '';
}

/**
 * Map the Bindings pane's callbacks onto the existing actions.
 *
 * The pane is repainted from state on every patch (`editBindings` refreshes), so
 * the handlers stay one-line delegations and the tab cannot diverge from what
 * the runtime knows.
 *
 * @returns The handler table for {@link mountBindingsPane}.
 */
export function createBindingsHandlers(rt: PanelRuntime): BindingsPaneHandlers {
    return {
        refresh: () => void loadBindings(rt),
        // One primary control, two shapes: the same button adds a row in add
        // mode and saves the loaded one in edit mode, so there is never a
        // second write path beside the whole-file grant.
        submit: (): void => {
            if (rt.state.bindings.editing) {
                void saveEditedBinding(rt);

                return;
            }

            void bindRepository(rt);
        },
        toggle: () => void toggleBinding(rt),
        removeBinding: () => void removeBinding(rt),
        newBinding: () => startNewBinding(rt),
        cancelEdit: () => stopEditingBinding(rt, cancelNote(rt)),
        setRepoInput: (value) => editBindings(rt, { repoInput: value }),
        selectAccount: (id) => editBindings(rt, { accountSelection: id }),
        selectProject: (id) => selectBindingProject(rt, id),
        setAssignment: (isChecked) => editBindings(rt, { triggerAssignment: isChecked }),
        setMention: (isChecked) => editBindings(rt, { triggerMention: isChecked }),
        setReviewRequest: (isChecked) => editBindings(rt, { triggerReviewRequest: isChecked }),
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
 * Mount the Bindings tab body into the container the shell created.
 *
 * The six-tab shell owns the strip and decides when this body first appears;
 * everything here is the body itself — the status line, the list, and the add
 * form — and the runtime handle the repaint path reads.
 *
 * The body repaints once at mount, as Status and Accounts do: the list mounts
 * empty (its items arrive only through a repaint), so without this call the
 * first frame would show "No binding yet" under a status line that already
 * counts the bindings the runtime holds — true only until the next refresh
 * tick, which is exactly how long a first frame is allowed to lie.
 */
export function mountBindingsTabBody(input: {
    /** Panel runtime the body repaints for. */
    readonly rt: PanelRuntime;
    /** The body container `mountTabShell` created for `bindings`. */
    readonly root: HTMLElement;
    /** Anything the tab mounts inside the first block, before this pane. */
    readonly mountFirst?: (into: HTMLElement) => void;
}): void {
    const view = mountBindingsBody({
        root: input.root,
        rt: input.rt,
        handlers: createBindingsHandlers(input.rt),
        ...(input.mountFirst !== undefined && { mountFirst: input.mountFirst }),
    });
    // The bundle gate greps the built panel for this attribute: a string
    // literal that only ships when this pane is wired (identifier names are
    // minified away, so a marker must ride live code). It also names the pane
    // for the operator's DOM inspector.
    view.pane.dataset.mount = 'mountBindingsBody';
    input.rt.bindingsUi = view;
    // Paint what the runtime already knows, before anything is read: the
    // status line mounts composed from state, but the list does not, and the
    // two must never disagree on the first frame.
    repaintBindingsPane(input.rt, view);
}
