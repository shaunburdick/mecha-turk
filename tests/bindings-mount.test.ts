/**
 * Wiring tests for the Bindings tab mount (MVP blocker, 2026-09-27; re-cut
 * for the six-tab shell by 005 T-009).
 *
 * The blocker was that nothing called the pane's mount: the handlers and the
 * repaint existed with no call site. These tests drive the handler table
 * mapped onto the real actions (patch → state → note lines → service reads)
 * and the repaint path `refresh()` takes when the shell has mounted the
 * Bindings body. The SDK mounts themselves need a live `document`, so the pane
 * stands in as a recording stub while the wiring's logic runs for real.
 *
 * Tab-body *visibility* is no longer asserted here: the two-container switch
 * was deleted with the spike era (FR-011), and `tests/tabs.test.ts` is what
 * now owns activation, mounting, and the tab↔body association.
 */

import { describe, expect, it } from 'vitest';
import { refresh } from '../src/panel-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
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
import { stubPaints, stubPanelUi, stubProjectPickerUi, stubBindingsPane } from './support/ui-stubs.ts';

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
 * Register the Bindings body's stubbed views on a runtime.
 *
 * The shell owns visibility now, so what a test needs from the mount is the
 * pair of views `refresh()` repaints: the pane and the picker.
 *
 * @param rt - Runtime to attach the stub views to.
 * @returns The pane stub and its body element.
 */
function attachStubBody(rt: PanelRuntime): {
    readonly bindings: BindingsPane;
    readonly paneBody: HTMLElement;
} {
    const paneBody = fakeDom().root;
    rt.ui = stubPanelUi();
    rt.bindingsUi = stubBindingsPane(paneBody);
    rt.pickerUi = stubProjectPickerUi();

    return { bindings: rt.bindingsUi, paneBody };
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
            {
                numericUserId: '77331',
                login: LOGIN,
                displayName: null,
                usable: true,
                state: 'active',
                connectionState: 'connected',
            },
        ]);
    });
});

describe('refresh (the repaint path a mounted Bindings body takes)', () => {
    it('repaints the pane and the picker the shell mounted', () => {
        const rt = createTestRuntime(fakeHost());
        const { bindings } = attachStubBody(rt);

        refresh(rt);

        expect(paintsOf(bindings.status)).toBe(1);
        expect(paintsOf(bindings.bindingsList)).toBe(1);
        expect(paintsOf(bindings.note)).toBe(1);
        expect(rt.pickerUi).not.toBeNull();
        const picker = rt.pickerUi;
        expect(picker === null ? 0 : paintsOf(picker.projectStatus)).toBe(1);
    });

    it('leaves a headless runtime alone: no body, no repaint, no throw', () => {
        const rt = createTestRuntime(fakeHost());

        expect((): void => {
            refresh(rt);
        }).not.toThrow();
        expect(rt.bindingsUi).toBeNull();
        expect(rt.dispatchesUi).toBeNull();
        expect(rt.pickerUi).toBeNull();
        expect(rt.aboutUi).toBeNull();
    });

    it('repaints nothing after teardown', () => {
        const rt = createTestRuntime(fakeHost());
        const { bindings } = attachStubBody(rt);
        rt.disposed = true;

        refresh(rt);

        expect(paintsOf(bindings.status)).toBe(0);
    });
});
