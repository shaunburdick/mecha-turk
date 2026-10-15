/**
 * The asynchronous initial-setup rejection (005 `005 AC-163`, `005 SC-116`,
 * `005 SC-117`, NFR-115): a mount step rejects after the shell is up, and the
 * failure must land in the top-of-panel notice region — above the strip, with
 * Bindings still active beneath it — carrying the stage token and the message
 * verbatim, while the reconciliation gate stays closed, the deferred arming
 * intent clears, and nothing retries, claims, or persists.
 *
 * The shell is real (prerequisite notice, framing banner, six-tab strip); only
 * the SDK mounts and `tabSpecs` are doubled, the pattern the tabs and
 * prerequisites suites already use. The rejection is injected at the seam the
 * plan names — the awaited `loadInitialBindings` step — and the real read runs
 * first, so the arming intent the failure has to clear genuinely exists.
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult, HostReadyContext } from '@openchamber/sdk';
import { begin, mountPanelApp } from '../src/app.ts';
import { LEDGER_STORAGE_KEY } from '../src/ledger.ts';
import type { PanelRuntime, TabId } from '../src/panel-state.ts';
import type * as bindingsMode from '../src/bindings-mode.ts';
import type * as tabBodies from '../src/tab-bodies.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';
import {
    NO_SESSION,
    createPushHarness,
    createStorageDouble,
    createTestRuntime,
    tick,
} from './support/panel.ts';
import { fixtureBindingRow } from './support/binding-fixture.ts';

/** One tab body in this suite's double: an id, a label, and a text node that says it is there. */
interface LiteSpec {
    readonly id: TabId;
    readonly label: string;
    readonly mount: (body: HTMLElement) => () => void;
}

/** The injection, hoisted so the mock factory and the assertions share one value. */
const injected = vi.hoisted(() => ({
    message: 'storage read refused while the ledger was being restored',
    /** `relayArmPending` as the real mount step left it, just before the throw. */
    pendingWhenRejected: false,
}));

/** What the SDK mount doubles recorded: the strip node and the console lines. */
const recorded = vi.hoisted(() => ({
    strip: null as FakeElement | null,
    lines: [] as string[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };

    /** The surface both mounts receive: a node to append into, and a document. */
    interface MountRoot {
        readonly ownerDocument: { createElement(tagName: string): FakeElement };
        append(...nodes: FakeElement[]): void;
    }

    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (): { update: () => void; dispose: () => void } => ({
                update: (): void => undefined,
                dispose: (): void => undefined,
            });
        }
    }

    stubbed.mountBanner = (
        root: MountRoot,
        initial: { readonly title: string; readonly body?: string },
    ): { update: (next: { readonly title?: string; readonly body?: string }) => void; dispose: () => void } => {
        const node = root.ownerDocument.createElement('div');
        let { title } = initial;
        let body = initial.body ?? '';
        const paint = (): void => {
            node.textContent = `${title} — ${body}`;
        };
        paint();
        root.append(node);

        return {
            update: (next): void => {
                title = next.title ?? title;
                body = next.body ?? body;
                paint();
            },
            dispose: (): void => {
                node.remove();
            },
        };
    };

    stubbed.mountTabs = (
        root: MountRoot,
        initial: {
            readonly items: readonly { readonly id: string; readonly label: string }[];
            readonly activeId: string;
        },
    ): { update: (next: { readonly activeId: string }) => void; dispose: () => void } => {
        const track = root.ownerDocument.createElement('div');
        track.setAttribute('role', 'tablist');
        root.append(track);
        const buttons = initial.items.map((item) => {
            const button = root.ownerDocument.createElement('button');
            button.setAttribute('role', 'tab');
            button.dataset.id = item.id;
            track.append(button);

            return button;
        });
        recorded.strip = track;

        const paint = (activeId: string): void => {
            for (const [index, item] of initial.items.entries()) {
                const button = buttons[index];
                if (button !== undefined) {
                    button.setAttribute('aria-selected', item.id === activeId ? 'true' : 'false');
                }
            }
        };

        paint(initial.activeId);
        track.addEventListener('keydown', (): void => undefined);

        return {
            update: (next): void => {
                paint(next.activeId);
            },
            dispose: (): void => {
                track.remove();
            },
        };
    };

    // The fake root carries no document element for the host theme to land on.
    stubbed.applyHostReady = (): void => undefined;

    return stubbed;
});

vi.mock('../src/tab-bodies.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof tabBodies>();
    // Local to the factory: module bindings are not initialized yet when it runs.
    const ids: readonly TabId[] = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'];

    return {
        ...actual,
        tabSpecs: (): LiteSpec[] =>
            ids.map((id) => ({
                id,
                label: id,
                mount: (body: HTMLElement): (() => void) => {
                    const node = body.ownerDocument.createElement('p');
                    node.textContent = `${id} body`;
                    body.append(node);

                    return (): void => {
                        node.remove();
                    };
                },
            })),
    };
});

vi.mock('../src/bindings-mode.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof bindingsMode>();

    return {
        ...actual,
        loadInitialBindings: async (rt: PanelRuntime): Promise<void> => {
            // The real read first: it is what arms the relay against the still-
            // closed gate, so the intent the failure must clear is a real one.
            await actual.loadInitialBindings(rt);
            injected.pendingWhenRejected = rt.relayArmPending;
            throw new Error(injected.message);
        },
    };
});

/** One binding on the wire, so the real mount step has a reason to arm. */
const BINDINGS_BODY = JSON.stringify({
    bindings: [fixtureBindingRow('bnd-startup-async', { repository: 'acme/widget' })],
    status: [],
});

/** Answer only the bindings read; every other service route fails closed. */
async function serviceRequest(request: GuestRequest): Promise<GuestRequestResult> {
    if (request.path === '/v1/bindings') {
        return { status: 200, body: BINDINGS_BODY };
    }

    return { status: 404, body: '{"error":{"code":"not-found","message":"unrouted"}}' };
}

/** Every text node under `node`, in document order — the double has no innerText. */
function textOf(node: FakeElement): string {
    return [node.textContent, ...node.children.map((child) => textOf(child))].join(' ');
}

/** The first descendant carrying `name` in its `data-body` attribute. */
function bodyUnder(root: FakeElement, name: string): FakeElement | undefined {
    for (const child of root.children) {
        if (child.attribute('data-body') === name) {
            return child;
        }

        const nested = bodyUnder(child, name);
        if (nested !== undefined) {
            return nested;
        }
    }

    return undefined;
}

describe('a rejected initial setup renders where the operator is looking (005 AC-163)', () => {
    it('categorizes it above the strip, keeps the gate closed, and persists nothing', async () => {
        recorded.lines.length = 0;
        injected.pendingWhenRejected = false;
        const storage = createStorageDouble();
        const startSession = vi.fn(async () => NO_SESSION);
        const harness = createPushHarness({ serviceRequest, storage: storage.storage, startSession });
        const dom = fakeDom();
        dom.rootElement.setAttribute('id', 'root');
        const rt = createTestRuntime(harness.host);

        mountPanelApp(rt, dom.root);

        const capture: { ready: HostReadyContext | null } = { ready: null };
        harness.host.onReady((context): void => {
            capture.ready = context;
        });
        // The suite drives `begin` itself, so the ready push must not start a
        // second one behind it: the guard `registerHostListeners` already has.
        rt.started = true;
        harness.emitReady(null);
        if (capture.ready === null) {
            throw new Error('the harness never fired ready');
        }

        rt.shell?.activate('bindings');
        expect(rt.activeTab).toBe('bindings');

        const consoleLog = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]): void => {
            recorded.lines.push(args.map(String).join(' '));
        });
        const scheduled = {
            timeout: vi.spyOn(globalThis, 'setTimeout'),
            interval: vi.spyOn(globalThis, 'setInterval'),
        };

        await expect(begin(rt, capture.ready)).resolves.toBeUndefined();
        consoleLog.mockRestore();

        // The surface: first child of `#root`, above the strip and the bodies.
        const root = dom.rootElement;
        const banner = root.firstElementChild;
        expect(banner, 'a failure banner is the first thing root holds').not.toBeNull();
        if (banner === null) {
            return;
        }

        const bannerText = textOf(banner);
        expect(bannerText).toContain('initial setup');
        expect(bannerText).toContain(injected.message);
        expect(bannerText, 'the surface states the manual recovery').toContain('Reopen the panel');

        expect(recorded.strip, 'the strip mounted').not.toBeNull();
        const stripIndex = recorded.strip === null ? -1 : root.children.indexOf(recorded.strip);
        expect(stripIndex).toBeGreaterThan(0);
        expect(root.children.indexOf(banner)).toBe(0);
        expect(root.children.indexOf(banner)).toBeLessThan(stripIndex);

        // Bindings is still the tab showing, rendering under the banner.
        expect(rt.activeTab).toBe('bindings');
        const bindingsBody = bodyUnder(root, 'bindings');
        expect(bindingsBody, 'the Bindings body is still mounted').toBeDefined();
        if (bindingsBody === undefined) {
            return;
        }

        expect(bindingsBody.hidden).toBe(false);
        expect(textOf(bindingsBody)).toContain('bindings body');

        // The console carries the same stage and the same error text.
        const entry = recorded.lines.find((line) => line.includes('stage="initial setup"'));
        expect(entry, 'a console entry names the stage').toBeDefined();
        expect(entry).toContain('[mecha-turk/startup]');
        expect(entry).toContain('outcome=failed');
        expect(entry).toContain(injected.message);

        // Fail closed: the gate never opens, the arming intent is gone.
        expect(injected.pendingWhenRejected, 'the real mount step had armed the relay').toBe(true);
        expect(rt.reconcileSettled).toBe(false);
        expect(rt.relayArmPending).toBe(false);
        expect(rt.state.relay.timer).toBeNull();

        expect(startSession).not.toHaveBeenCalled();
        expect(scheduled.timeout).not.toHaveBeenCalled();
        expect(scheduled.interval).not.toHaveBeenCalled();
        scheduled.timeout.mockRestore();
        scheduled.interval.mockRestore();

        // SC-117: the failure itself persists nothing — the only write the drive
        // recorded is the mount's own ledger write, made before the rejection,
        // and no key outside the documented set appears anywhere.
        await tick();
        expect(storage.operations.filter((operation) => operation.startsWith('set:'))).toEqual([
            `set:${LEDGER_STORAGE_KEY}`,
        ]);
    });
});
