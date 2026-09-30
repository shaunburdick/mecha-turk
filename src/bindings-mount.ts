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
 */

import { loadProjects, selectBindingProject } from './project-actions.ts';
import { repaintBindingsSection } from './panel-ui.ts';
import type { PanelRuntime, BindingsSection } from './panel-state.ts';
import {
    armAccountRemoval,
    bindRepository,
    editBindings,
    loadBindings,
    removeAccount,
    removeBinding,
    toggleBinding,
} from './bindings.ts';
import { mountBindingsPane } from './bindings-ui.ts';
import type { BindingsPaneHandlers } from './bindings-ui.ts';
import { loadAuditHistory } from './audit-view.ts';
import {
    loadRuns,
    openRun,
    requeueRun,
    resolveNoSession,
    resolveSessionCreated,
    retryRun,
    selectRun,
    setSessionInput,
} from './runs.ts';

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
        switchTab: (id) => editBindings(rt, { activeTab: id }),
        refresh: () => void loadBindings(rt),
        submit: () => void bindRepository(rt),
        toggle: () => void toggleBinding(rt),
        removeBinding: () => void removeBinding(rt),
        removeAccount: () => {
            if (rt.state.bindings.removeAccountArmed) {
                void removeAccount(rt);

                return;
            }

            armAccountRemoval(rt);
        },
        setRepoInput: (value) => editBindings(rt, { repoInput: value }),
        selectAccount: (id) => editBindings(rt, { accountSelection: id }),
        selectProject: (id) => selectBindingProject(rt, id),
        setAssignment: (checked) => editBindings(rt, { triggerAssignment: checked }),
        setMention: (checked) => editBindings(rt, { triggerMention: checked }),
        setReviewRequest: (checked) => editBindings(rt, { triggerReviewRequest: checked }),
        setWorktree: (id) => editBindings(rt, { worktreeSelection: id }),
        selectBinding: (id) => editBindings(rt, { selectedBinding: id }),
        refreshProjects: () => void loadProjects(rt),
        refreshRuns: () => void loadRuns(rt),
        selectRun: (id) => selectRun(rt, id),
        openRun: () => void openRun(rt),
        retryRun: () => void retryRun(rt),
        requeueRun: () => void requeueRun(rt),
        resolveSessionCreated: () => void resolveSessionCreated(rt),
        resolveNoSession: () => void resolveNoSession(rt),
        setSessionInput: (value) => setSessionInput(rt, value),
        loadAudit: () => void loadAuditHistory(rt),
    };
}

/**
 * Mount the Bindings tab and create the spike tab's body container.
 *
 * The pane's shared tab strip lands as the panel's first element, the pane
 * body second, and the spike body third (hidden while the pane shows). Both
 * bodies' visibility is decided in one place — {@link repaintBindingsSection} —
 * which this call runs once so the first paint already agrees with state.
 * The section is registered on the runtime here, before `createSpikeApp`
 * mounts the spike UI and the handoff group into its body.
 *
 * @param rt - Panel runtime.
 * @param root - Panel root element from `panel/index.html`.
 * @returns The mounted section (also stored on `rt.bindingsSection`).
 */
export function mountBindingsSection(rt: PanelRuntime, root: HTMLElement): BindingsSection {
    const bindings = mountBindingsPane({ root, rt, handlers: createBindingsHandlers(rt) });
    // The bundle gate greps the built panel for this attribute: a string
    // literal that only ships when this pane is wired (identifier names are
    // minified away, so a marker must ride live code). It also names the pane
    // for the operator's DOM inspector.
    bindings.pane.setAttribute('data-mount', 'mountBindingsPane');
    const spike = root.ownerDocument.createElement('div');
    // The spike body mirrors the panel root's own column layout, so the
    // legacy controls keep their 12px rhythm inside the tab container.
    spike.style.display = 'flex';
    spike.style.flexDirection = 'column';
    spike.style.gap = '12px';
    root.append(spike);

    const section: BindingsSection = { bindings, spike };
    rt.bindingsSection = section;
    repaintBindingsSection(rt);
    return section;
}
