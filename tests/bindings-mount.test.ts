/**
 * Wiring tests for the Bindings tab mount (MVP blocker, 2026-09-27).
 *
 * The blocker was that nothing called `mountBindingsPane`: the handlers
 * and the tab-body repaint existed with no call site. These tests drive the
 * call site's two halves headlessly — the handler table mapped onto the real
 * actions (patch → state → note lines → service reads), and the section
 * repaint that switches tab-body visibility from `bindings.activeTab` through
 * `refresh()`. The SDK mounts themselves need a live `document`, so the pane
 * stands in as a recording stub while the wiring's logic runs for real.
 */

import { describe, expect, it } from 'vitest';
import { repaintBindingsSection } from '../src/panel-ui.ts';
import type { PanelRuntime, BindingsSection } from '../src/panel-state.ts';
import type { BindingsPane } from '../src/bindings-ui.ts';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
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
import { stubPaints, stubPanelUi, stubBindingsPane } from './support/ui-stubs.ts';

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
 * Register a stub Bindings section on a runtime.
 *
 * The section pairs the recording pane stub with a fake spike body, so
 * `repaintBindingsSection` and `refresh` run their real visibility logic against
 * something the test can read. The bodies are distinct elements: the
 * visibility writes mean different things for the two of them.
 *
 * @param rt - Runtime to attach the stub section to.
 * @returns The fake bodies and the pane, keyed instead of positional.
 */
function attachStubSection(rt: PanelRuntime): {
    readonly bindings: BindingsPane;
    readonly paneBody: HTMLElement;
    readonly spike: HTMLElement;
} {
    const paneBody = fakeDom().root;
    const spike = fakeDom().root;
    const bindings = stubBindingsPane(paneBody);
    const section: BindingsSection = { bindings, spike };
    rt.bindingsSection = section;

    return { bindings, paneBody, spike };
}

describe('createBindingsHandlers (handler table wired to real actions)', () => {
    it('patches every draft field through editBindings', () => {
        const rt = createTestRuntime(fakeHost());
        // The project step is guarded (FR-070): only an id the loaded list
        // contains may reach the draft, so the list has to be loaded first.
        rt.state.projects.status = 'ready';
        rt.state.projects.projects = PROJECTS.projects;
        const handlers = createBindingsHandlers(rt);

        handlers.setRepoInput('acme/widget');
        handlers.selectAccount('77331');
        handlers.selectProject('prj_42');
        handlers.setAssignment(false);
        handlers.setMention(true);
        // A new binding asks for reviews by default; the form can turn that off.
        expect(rt.state.bindings.triggerReviewRequest).toBe(true);
        handlers.setReviewRequest(false);
        handlers.setWorktree('generated');
        handlers.selectBinding('bnd-1');

        const { bindings } = rt.state;
        expect(bindings.repoInput).toBe('acme/widget');
        expect(bindings.accountSelection).toBe('77331');
        expect(bindings.repoProjectSelection).toBe('prj_42');
        expect(bindings.triggerAssignment).toBe(false);
        expect(bindings.triggerMention).toBe(true);
        expect(bindings.triggerReviewRequest).toBe(false);
        expect(bindings.worktreeSelection).toBe('generated');
        expect(bindings.selectedBinding).toBe('bnd-1');
    });

    it('switches the active tab through state and repaints both tab bodies', () => {
        const rt = createTestRuntime(fakeHost());
        rt.ui = stubPanelUi();
        const bodies = attachStubSection(rt);
        const handlers = createBindingsHandlers(rt);

        handlers.switchTab('repos');

        expect(rt.state.bindings.activeTab).toBe('repos');
        // The repaint switched the bodies: exactly one tab body is visible.
        expect(bodies.spike.hidden).toBe(true);
        expect(bodies.paneBody.hidden).toBe(false);

        handlers.switchTab('spike');

        expect(rt.state.bindings.activeTab).toBe('spike');
        expect(bodies.spike.hidden).toBe(false);
        expect(bodies.paneBody.hidden).toBe(true);
    });

    it('wires submit to bindRepository, which refuses an incomplete draft on the note', async () => {
        const rt = createTestRuntime(fakeHost());
        const handlers = createBindingsHandlers(rt);

        handlers.setRepoInput('not-a-repository');
        handlers.submit();
        await tick();

        expect(rt.state.bindings.note).toBe('repository must be `owner/name`');
    });

    it('wires toggle to toggleBinding, which demands a selected row', async () => {
        const rt = createTestRuntime(fakeHost());
        const handlers = createBindingsHandlers(rt);

        handlers.toggle();
        await tick();

        expect(rt.state.bindings.note).toBe('Select a binding to toggle.');
    });

    it('wires refresh to loadBindings, which answers a failed read on the note', async () => {
        const rt = createTestRuntime(fakeHost());
        const handlers = createBindingsHandlers(rt);

        handlers.refresh();
        await tick();

        // The default host double answers every service path with a neutral
        // 404, so the reads fail closed and the note says so.
        expect(rt.state.bindings.status).toBe('error');
        expect(rt.state.bindings.note).toBe('One of the reads failed — refresh to retry.');
    });

    it('wires refresh to loadBindings, which loads the accounts the picker offers', async () => {
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
        const handlers = createBindingsHandlers(rt);

        handlers.refresh();
        await tick();

        expect(rt.state.bindings.status).toBe('ready');
        expect(rt.state.bindings.note).toBe('');
        expect(rt.state.bindings.accounts).toEqual([
            { numericUserId: '77331', login: LOGIN, displayName: null, usable: true },
        ]);
    });
});

/**
 * Build a runtime with a stub section whose pane records its repaints.
 *
 * @returns The runtime, the pane stub, and the fake spike body.
 */
function stubbedRuntime(): {
    readonly rt: PanelRuntime;
    readonly bindings: BindingsPane;
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
    const bindings = stubBindingsPane(paneBody);
    const section: BindingsSection = { bindings, spike };
    rt.bindingsSection = section;

    return { rt, bindings, paneBody, spike };
}

describe('repaintBindingsSection (tab-body visibility from state)', () => {
    it('hides the spike body and shows the pane body while the Bindings tab is active', () => {
        const { rt, spike, paneBody } = stubbedRuntime();

        rt.state.bindings.activeTab = 'repos';
        repaintBindingsSection(rt);

        expect(spike.hidden).toBe(true);
        expect(paneBody.hidden).toBe(false);
    });

    it('shows the spike body again on the spike tab and repaints the pane', () => {
        const { rt, bindings, spike, paneBody } = stubbedRuntime();
        rt.state.bindings.activeTab = 'repos';
        repaintBindingsSection(rt);

        rt.state.bindings.activeTab = 'spike';
        repaintBindingsSection(rt);

        expect(spike.hidden).toBe(false);
        expect(paneBody.hidden).toBe(true);
        // The pane repainted: the recording stubs prove the handles saw an
        // `update` on each pass, not a silent skip.
        expect(paintsOf(bindings.status)).toBe(2);
        expect(paintsOf(bindings.bindingsList)).toBe(2);
    });

    it('leaves both bodies alone when no section is mounted (headless runtime)', () => {
        const rt = createTestRuntime(fakeHost());

        expect((): void => {
            repaintBindingsSection(rt);
        }).not.toThrow();
        expect(rt.bindingsSection).toBeNull();
    });
});
