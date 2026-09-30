/**
 * Lifecycle proof for the six-tab shell (005 T-031; FR-014, FR-017,
 * FR-018, FR-019, AC-136, AC-137, SC-108, NFR-104, NFR-108, NFR-111).
 *
 * The shell's promises are only true *as a whole*, so this suite measures
 * them across all six tabs rather than one at a time:
 *
 * - **AC-137** a teardown after visiting every tab returns nodes, timers,
 *   and disposers to their pre-mount values;
 * - **FR-014** activating the tab that already shows reads nothing and
 *   changes nothing — a panel that re-reads because it was looked at cannot
 *   be looked at;
 * - **AC-136 / SC-108** one relay loop survives a mid-flight switch, and the
 *   run it holds still produces exactly one `host.startSession()`;
 * - **FR-019 / NFR-111** a failed read keeps the content it had, marked
 *   stale, or says plainly that it has none;
 * - **NFR-108** disposal is idempotent and no handle is ever disposed twice.
 *
 * Offline: the fake host, the fake DOM, and a loopback service on a temp
 * directory. No live OpenChamber, no token, no network (FR-086).
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { loadSettings, readStateLine } from '../src/settings-tab.ts';
import { loadVersion } from '../src/about-tab.ts';
import { pollRelay, startRelayPolling, stopRelayPolling } from '../src/relay.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';
import { startDispatchLoop } from './support/dispatch-loop.ts';

/** What every SDK mount recorded: props, and which handle was disposed. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
    disposed: [] as object[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });
                const handle = {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => {
                        mounts.disposed.push(handle);
                    },
                };

                return handle;
            };
        }
    }

    return stubbed;
});

/** The six tabs FR-010 puts in the strip, in strip order. */
const TAB_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'] as const;

/** The picker callbacks the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** Body the unrouted paths answer with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/** One healthy `GET /v1/config` answer, so a read can land before it fails. */
const CONFIG_BODY = JSON.stringify({
    config: { ...DEFAULT_CONFIG },
    fields: configSchema(),
    source: 'stored',
    defaultsApplied: [],
});

/** One healthy `GET /health` answer. */
const HEALTH_BODY = JSON.stringify({ status: 'ok', version: '0.0.1', schemaVersion: 1 });

/** What one lifecycle run recorded. */
interface LifecycleRun {
    /** The runtime the shell mounted against. */
    readonly rt: PanelRuntime;
    /** The fake panel root. */
    readonly root: ReturnType<typeof fakeDom>['root'];
    /** Requests the host saw, in order. */
    readonly requests: readonly string[];
    /** How the scripted service should answer from now on. */
    fail(): void;
}

/**
 * Mount the shell and visit all six tabs against a scripted service.
 *
 * @returns The runtime, the root, the requests, and a switch that makes
 *   every later service call fail.
 */
async function visitAllTabs(): Promise<LifecycleRun> {
    mounts.log.length = 0;
    mounts.disposed.length = 0;
    const requests: string[] = [];
    let failing = false;
    const host = fakeHost({
        serviceRequest: async (request) => {
            requests.push(`${request.method} ${request.path}`);
            if (failing) {
                throw new Error('connection refused');
            }

            if (request.path === '/v1/config') {
                return { status: 200, body: CONFIG_BODY };
            }

            if (request.path === '/health') {
                return { status: 200, body: HEALTH_BODY };
            }

            return { status: 404, body: UNROUTED };
        },
    });
    const rt = createTestRuntime(host);
    const dom = fakeDom();
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });
    for (const id of TAB_IDS) {
        rt.shell?.activate(id);
    }

    await tick();

    return {
        rt,
        root: dom.root,
        requests,
        fail: (): void => {
            failing = true;
        },
    };
}

describe('AC-137 a teardown returns the panel to its pre-mount counts', () => {
    it('removes every node, timer, and registry entry after visiting all six', async () => {
        const run = await visitAllTabs();
        const { rt, root } = run;

        // Six bodies mounted, nothing armed: the tabs own no loop and no
        // timer of their own (FR-018 — the relay lives at the root).
        expect(rt.tabMounted.size).toBe(6);
        expect(root.children.length).toBeGreaterThan(0);
        expect(rt.state.relay.timer).toBeNull();
        expect(rt.relayArmed).toBe(false);
        expect(rt.pollTimer).toBeNull();

        rt.shell?.dispose();

        expect(root.children).toEqual([]);
        expect(rt.tabMounted.size).toBe(0);
        expect(rt.tabLastRead.size).toBe(0);
        expect(rt.shell).toBeNull();
        expect(rt.statusUi).toBeNull();
        expect(rt.settingsUi).toBeNull();
        expect(rt.aboutUi).toBeNull();
        expect(rt.bindingsUi).toBeNull();
        expect(rt.accountsUi).toBeNull();
        expect(rt.dispatchesUi).toBeNull();
    });

    it('disposes no handle twice, and a second teardown disposes nothing new (NFR-108)', async () => {
        const run = await visitAllTabs();
        run.rt.shell?.dispose();
        const first = mounts.disposed.length;

        expect(first).toBeGreaterThan(10);
        expect(new Set(mounts.disposed).size).toBe(first);

        run.rt.shell?.dispose();
        expect(mounts.disposed).toHaveLength(first);
    });
});

describe('FR-014 activating the shown tab reads nothing and changes nothing (NFR-104)', () => {
    it('performs zero service reads when the operator clicks the active tab', async () => {
        const run = await visitAllTabs();
        const before = run.requests.length;
        const state = JSON.stringify(run.rt.state);

        run.rt.shell?.activate('settings');
        run.rt.shell?.activate('settings');

        expect(run.rt.activeTab).toBe('settings');
        expect(run.requests).toHaveLength(before);
        expect(JSON.stringify(run.rt.state)).toBe(state);
    });

    it('changes nothing but the activation field when a new tab opens', async () => {
        const run = await visitAllTabs();
        const { rt } = run;
        rt.activeTab = 'status';
        const state = JSON.stringify(rt.state);

        rt.shell?.activate('bindings');

        expect(rt.activeTab).toBe('bindings');
        expect(JSON.stringify(rt.state)).toBe(state);
    });
});

describe('AC-136 / SC-108 one loop and one session across a mid-flight switch', () => {
    it('keeps a single relay loop armed and dispatches the run exactly once', async () => {
        const loop = await startDispatchLoop();
        try {
            await loop.enqueue({ issueNumber: 7 });
            const rt = loop.mount();
            const dom = fakeDom();
            mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });

            startRelayPolling(rt);
            const armed = rt.state.relay.timer;
            expect(armed).not.toBeNull();
            // Arming is a no-op once armed: there is no second loop (FR-018).
            startRelayPolling(rt);
            expect(rt.state.relay.timer).toBe(armed);

            // The switch happens while that first tick is still in flight —
            // the case AC-136 is about — so nothing below waits for it first.
            rt.shell?.activate('settings');
            rt.shell?.activate('dispatches');
            for (let attempt = 0; attempt < 100 && loop.sessions.length === 0; attempt += 1) {
                await tick();
            }

            expect(loop.timeline.filter((entry) => entry.startsWith('startSession:'))).toHaveLength(1);
            expect(loop.sessions).toHaveLength(1);
            expect(rt.state.relay.timer).toBe(armed);

            // A later tick over the same run dispatches nothing new.
            await pollRelay(rt);
            expect(loop.sessions).toHaveLength(1);

            stopRelayPolling(rt);
            expect(rt.state.relay.timer).toBeNull();
            rt.shell?.dispose();
        } finally {
            await loop.shutdown();
        }
    });
});

describe('FR-019 / NFR-111 a failed read keeps what it had, marked stale', () => {
    it('keeps the Settings document and marks it stale on a failed re-read', async () => {
        const run = await visitAllTabs();
        const { rt } = run;
        expect(rt.state.settingsTab.phase).toBe('loaded');
        expect(rt.state.settingsTab.doc).not.toBeNull();

        run.fail();
        await loadSettings(rt);

        expect(rt.state.settingsTab.phase).toBe('failed');
        expect(rt.state.settingsTab.stale).toBe(true);
        expect(rt.state.settingsTab.doc).not.toBeNull();
        expect(readStateLine(rt.state.settingsTab)).toContain('may be stale');
    });

    it('keeps the About version and marks it stale on a failed re-read', async () => {
        const run = await visitAllTabs();
        const { rt } = run;
        expect(rt.state.aboutTab.version).not.toBeNull();

        run.fail();
        await loadVersion(rt);

        expect(rt.state.aboutTab.phase).toBe('failed');
        expect(rt.state.aboutTab.version).not.toBeNull();
        expect(rt.state.aboutTab.problem).not.toBeNull();
    });

    it('says plainly that there is nothing to keep when nothing ever landed', async () => {
        const rt = createTestRuntime(fakeHost({
            serviceRequest: async () => {
                throw new Error('connection refused');
            },
        }));

        await loadSettings(rt);
        await loadVersion(rt);

        expect(rt.state.settingsTab.stale).toBe(false);
        expect(readStateLine(rt.state.settingsTab)).toContain('Nothing has been read yet');
        expect(rt.state.settingsTab.doc).toBeNull();
        expect(rt.state.aboutTab.version).toBeNull();
    });
});
