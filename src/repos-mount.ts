/**
 * The wiring that puts the Repositories tab on screen (MVP blocker, 2026-09-27).
 *
 * `repos-ui.ts` exports {@link mountRepositoriesPane} and its painter, but
 * nothing called them: the panel mounted only the legacy spike UI, so the
 * operator could never reach the bindings form, could never add a binding,
 * and bindings mode could never activate. This module is that missing call
 * site. It mounts the pane first, so the shared tab strip is the panel's
 * first element and both tab bodies hang beneath it: the Repositories pane on
 * its tab, and the spike body (a plain container the legacy UI and the
 * handoff group mount into) on the other.
 *
 * Every pane callback maps onto an action that already exists: `editRepos`
 * records each draft-field patch (and repaints through `refresh`), the repos
 * actions run the tab's reads and writes, and `switchTab` writes
 * `activeTab` for the central repaint to act on. Nothing new is invented —
 * the handlers are a table, not a layer.
 */

import { loadProjects } from './project-actions.ts';
import { repaintReposSection } from './panel-ui.ts';
import type { PanelRuntime, ReposSection } from './panel-state.ts';
import {
    armAccountRemoval,
    bindRepository,
    editRepos,
    loadRepositories,
    removeAccount,
    removeBinding,
    toggleBinding,
} from './repos.ts';
import { mountRepositoriesPane } from './repos-ui.ts';
import type { ReposPaneHandlers } from './repos-ui.ts';
import { loadRuns, openRun, retryRun, selectRun } from './runs.ts';

/**
 * Map the Repositories pane's callbacks onto the existing actions.
 *
 * The pane is repainted from state on every patch (`editRepos` refreshes), so
 * the handlers stay one-line delegations and the tab cannot diverge from what
 * the runtime knows.
 *
 * @param rt - Panel runtime the actions read and repaint.
 * @returns The handler table for {@link mountRepositoriesPane}.
 */
export function createRepositoriesHandlers(rt: PanelRuntime): ReposPaneHandlers {
    return {
        switchTab: (id) => editRepos(rt, { activeTab: id }),
        refresh: () => void loadRepositories(rt),
        submit: () => void bindRepository(rt),
        toggle: () => void toggleBinding(rt),
        removeBinding: () => void removeBinding(rt),
        removeAccount: () => {
            if (rt.state.repos.removeAccountArmed) {
                void removeAccount(rt);

                return;
            }

            armAccountRemoval(rt);
        },
        setRepoInput: (value) => editRepos(rt, { repoInput: value }),
        selectAccount: (id) => editRepos(rt, { accountSelection: id }),
        selectProject: (id) => editRepos(rt, { repoProjectSelection: id }),
        setAssignment: (checked) => editRepos(rt, { triggerAssignment: checked }),
        setMention: (checked) => editRepos(rt, { triggerMention: checked }),
        setReviewRequest: (checked) => editRepos(rt, { triggerReviewRequest: checked }),
        setWorktree: (id) => editRepos(rt, { worktreeSelection: id }),
        selectBinding: (id) => editRepos(rt, { selectedBinding: id }),
        refreshProjects: () => void loadProjects(rt),
        refreshRuns: () => void loadRuns(rt),
        selectRun: (id) => selectRun(rt, id),
        openRun: () => void openRun(rt),
        retryRun: () => void retryRun(rt),
    };
}

/**
 * Mount the Repositories tab and create the spike tab's body container.
 *
 * The pane's shared tab strip lands as the panel's first element, the pane
 * body second, and the spike body third (hidden while the pane shows). Both
 * bodies' visibility is decided in one place — {@link repaintReposSection} —
 * which this call runs once so the first paint already agrees with state.
 * The section is registered on the runtime here, before `createSpikeApp`
 * mounts the spike UI and the handoff group into its body.
 *
 * @param rt - Panel runtime.
 * @param root - Panel root element from `panel/index.html`.
 * @returns The mounted section (also stored on `rt.reposSection`).
 */
export function mountReposSection(rt: PanelRuntime, root: HTMLElement): ReposSection {
    const repos = mountRepositoriesPane({ root, rt, handlers: createRepositoriesHandlers(rt) });
    // The bundle gate greps the built panel for this attribute: a string
    // literal that only ships when this pane is wired (identifier names are
    // minified away, so a marker must ride live code). It also names the pane
    // for the operator's DOM inspector.
    repos.pane.setAttribute('data-mount', 'mountRepositoriesPane');
    const spike = root.ownerDocument.createElement('div');
    // The spike body mirrors the panel root's own column layout, so the
    // legacy controls keep their 12px rhythm inside the tab container.
    spike.style.display = 'flex';
    spike.style.flexDirection = 'column';
    spike.style.gap = '12px';
    root.append(spike);

    const section: ReposSection = { repos, spike };
    rt.reposSection = section;
    repaintReposSection(rt);
    return section;
}
