/**
 * Wiring tests for the Repositories tab mount (MVP blocker, 2026-09-27).
 *
 * The blocker was that nothing called `mountRepositoriesPane`: the handlers
 * and the tab-body repaint existed with no call site. These tests drive the
 * call site's two halves headlessly — the handler table mapped onto the real
 * actions (patch → state → note lines → service reads), and the section
 * repaint that switches tab-body visibility from `repos.activeTab` through
 * `refresh()`. The SDK mounts themselves need a live `document`, so the pane
 * stands in as a recording stub while the wiring's logic runs for real.
 */

import { describe, expect, it } from 'vitest';
import { repaintReposSection } from '../src/panel-ui.ts';
import type { PanelRuntime, ReposSection } from '../src/panel-state.ts';
import type { ReposPane } from '../src/repos-ui.ts';
import { createRepositoriesHandlers } from '../src/repos-mount.ts';
import { BINDINGS_PATH } from '../src/service-calls.ts';
import {
    createTestRuntime,
    DEFAULT_BODY,
    DEFAULT_STATUS,
    fakeHost,
    LOGIN,
    PROJECTS,
    tick,
} from './support/panel.ts';
import { fakeDom } from './support/dom.ts';
import { stubPaints, stubPanelUi, stubReposPane } from './support/ui-stubs.ts';

/**
 * Read a stubbed handle's paint count.
 *
 * Import-adapter so the test bodies read naturally while the typing stays on
 * the support module: a single narrow parameter type instead of per-cast.
 *
 * @param handle - Handle mounted by one of the stub builders.
 * @returns Recorded `update` count.
 */
function paintsOf(handle: Parameters<typeof stubPaints>[0]): number {
    return stubPaints(handle);
}

/**
 * Register a stub Repositories section on a runtime.
 *
 * The section pairs the recording pane stub with a fake spike body, so
 * `repaintReposSection` and `refresh` run their real visibility logic against
 * something the test can read. The bodies are distinct elements: the
 * visibility writes mean different things for the two of them.
 *
 * @param rt - Runtime to attach the stub section to.
 * @returns The fake bodies and the pane, keyed instead of positional.
 */
function attachStubSection(rt: PanelRuntime): {
    readonly repos: ReposPane;
    readonly paneBody: HTMLElement;
    readonly spike: HTMLElement;
} {
    const paneBody = fakeDom().root;
    const spike = fakeDom().root;
    const repos = stubReposPane(paneBody);
    const section: ReposSection = { repos, spike };
    rt.reposSection = section;

    return { repos, paneBody, spike };
}

describe('createRepositoriesHandlers (handler table wired to real actions)', () => {
    it('patches every draft field through editRepos', () => {
        const rt = createTestRuntime(fakeHost());
        // The project step is guarded (FR-070): only an id the loaded list
        // contains may reach the draft, so the list has to be loaded first.
        rt.state.projects.status = 'ready';
        rt.state.projects.projects = PROJECTS.projects;
        const handlers = createRepositoriesHandlers(rt);

        handlers.setRepoInput('acme/widget');
        handlers.selectAccount('77331');
        handlers.selectProject('prj_42');
        handlers.setAssignment(false);
        handlers.setMention(true);
        // A new binding asks for reviews by default; the form can turn that off.
        expect(rt.state.repos.triggerReviewRequest).toBe(true);
        handlers.setReviewRequest(false);
        handlers.setWorktree('generated');
        handlers.selectBinding('bnd-1');

        const { repos } = rt.state;
        expect(repos.repoInput).toBe('acme/widget');
        expect(repos.accountSelection).toBe('77331');
        expect(repos.repoProjectSelection).toBe('prj_42');
        expect(repos.triggerAssignment).toBe(false);
        expect(repos.triggerMention).toBe(true);
        expect(repos.triggerReviewRequest).toBe(false);
        expect(repos.worktreeSelection).toBe('generated');
        expect(repos.selectedBinding).toBe('bnd-1');
    });

    it('switches the active tab through state and repaints both tab bodies', () => {
        const rt = createTestRuntime(fakeHost());
        rt.ui = stubPanelUi();
        const bodies = attachStubSection(rt);
        const handlers = createRepositoriesHandlers(rt);

        handlers.switchTab('repos');

        expect(rt.state.repos.activeTab).toBe('repos');
        // The repaint switched the bodies: exactly one tab body is visible.
        expect(bodies.spike.hidden).toBe(true);
        expect(bodies.paneBody.hidden).toBe(false);

        handlers.switchTab('spike');

        expect(rt.state.repos.activeTab).toBe('spike');
        expect(bodies.spike.hidden).toBe(false);
        expect(bodies.paneBody.hidden).toBe(true);
    });

    it('wires submit to bindRepository, which refuses an incomplete draft on the note', async () => {
        const rt = createTestRuntime(fakeHost());
        const handlers = createRepositoriesHandlers(rt);

        handlers.setRepoInput('not-a-repository');
        handlers.submit();
        await tick();

        expect(rt.state.repos.note).toBe('repository must be `owner/name`');
    });

    it('wires toggle to toggleBinding, which demands a selected row', async () => {
        const rt = createTestRuntime(fakeHost());
        const handlers = createRepositoriesHandlers(rt);

        handlers.toggle();
        await tick();

        expect(rt.state.repos.note).toBe('Select a binding to toggle.');
    });

    it('wires refresh to loadRepositories, which answers a failed read on the note', async () => {
        const rt = createTestRuntime(fakeHost());
        const handlers = createRepositoriesHandlers(rt);

        handlers.refresh();
        await tick();

        // The default host double answers every service path with a neutral
        // 404, so the reads fail closed and the note says so.
        expect(rt.state.repos.status).toBe('error');
        expect(rt.state.repos.note).toBe('One of the reads failed — refresh to retry.');
    });

    it('wires refresh to loadRepositories, which loads the accounts the picker offers', async () => {
        // MVP blocker fix regression guard: the GET /v1/accounts read must
        // land in state, or the "Poll as account" select renders zero options
        // and every add is refused with "Pick the account this repository
        // polls under.". The service double answers both reads by path.
        const accountsBody = JSON.stringify({
            accounts: [
                {
                    numericUserId: '77331',
                    login: LOGIN,
                    state: 'active',
                    connectionState: 'connected',
                },
            ],
        });
        const bindingsBody = JSON.stringify({ bindings: [], status: [] });
        const host = fakeHost({
            serviceRequest: async (request) => {
                if (request.path === '/v1/accounts') {
                    return { status: 200, body: accountsBody };
                }

                if (request.path === BINDINGS_PATH) {
                    return { status: 200, body: bindingsBody };
                }

                return { status: DEFAULT_STATUS, body: DEFAULT_BODY };
            },
        });
        const rt = createTestRuntime(host);
        const handlers = createRepositoriesHandlers(rt);

        handlers.refresh();
        await tick();

        expect(rt.state.repos.status).toBe('ready');
        expect(rt.state.repos.note).toBe('');
        expect(rt.state.repos.accounts).toEqual([{ numericUserId: '77331', login: LOGIN, usable: true }]);
    });
});

/**
 * Build a runtime with a stub section whose pane records its repaints.
 *
 * @returns The runtime, the pane stub, and the fake spike body.
 */
function stubbedRuntime(): {
    readonly rt: PanelRuntime;
    readonly repos: ReposPane;
    readonly paneBody: HTMLElement;
    readonly spike: HTMLElement;
} {
    const rt = createTestRuntime(fakeHost());
    rt.ui = stubPanelUi();
    // Distinct bodies: the visibility writes meaningfully differ between the
    // pane body and the spike body, so one element cannot stand for both
    // (that would make the assertions read one shared node twice).
    const paneBody = fakeDom().root;
    const spike = fakeDom().root;
    const repos = stubReposPane(paneBody);
    const section: ReposSection = { repos, spike };
    rt.reposSection = section;

    return { rt, repos, paneBody, spike };
}

describe('repaintReposSection (tab-body visibility from state)', () => {
    it('hides the spike body and shows the pane body while the Repositories tab is active', () => {
        const { rt, spike, paneBody } = stubbedRuntime();

        rt.state.repos.activeTab = 'repos';
        repaintReposSection(rt);

        expect(spike.hidden).toBe(true);
        expect(paneBody.hidden).toBe(false);
    });

    it('shows the spike body again on the spike tab and repaints the pane', () => {
        const { rt, repos, spike, paneBody } = stubbedRuntime();
        rt.state.repos.activeTab = 'repos';
        repaintReposSection(rt);

        rt.state.repos.activeTab = 'spike';
        repaintReposSection(rt);

        expect(spike.hidden).toBe(false);
        expect(paneBody.hidden).toBe(true);
        // The pane repainted: the recording stubs prove the handles saw an
        // `update` on each pass, not a silent skip.
        expect(paintsOf(repos.status)).toBe(2);
        expect(paintsOf(repos.bindingsList)).toBe(2);
    });

    it('leaves both bodies alone when no section is mounted (headless runtime)', () => {
        const rt = createTestRuntime(fakeHost());

        expect((): void => {
            repaintReposSection(rt);
        }).not.toThrow();
        expect(rt.reposSection).toBeNull();
    });
});
