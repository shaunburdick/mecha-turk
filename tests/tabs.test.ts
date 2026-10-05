/**
 * The six-tab shell (005 T-008; FR-010–FR-017, FR-082).
 *
 * The suite drives `mountTabShell` against the panel's own DOM double and a
 * strip double that honours the SDK contract `mountTabs` publishes — six
 * `role="tab"` buttons with `data-id`, `aria-selected`, a roving `tabIndex`,
 * and an `update()` that repaints them. Selection *semantics* (the arrow-key
 * walk, the roving focus) are the SDK's own; what this file proves is that the
 * shell hands the SDK the right six items in the right order, repaints after
 * every activation, re-stamps the tab↔body association the SDK does not emit,
 * mounts each body exactly once, and releases all six on teardown.
 *
 * The strip is replaced through `vi.mock` rather than through a seam in the
 * production API: the shell's own signature stays exactly what the app calls.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mountTabShell } from '../src/tabs.ts';
import { TAB_IDS } from '../src/panel-state.ts';
import type { TabSpec } from '../src/tabs.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';

/** Encoding used when reading source text. */
const UTF8 = 'utf8';

/** What the strip double recorded; hoisted so the mock can write to it. */
const strip = vi.hoisted(() => ({
    labels: [] as string[],
    buttons: [] as FakeElement[],
    updates: 0,
    disposed: false,
    activeId: '',
    onChange: null as ((id: string) => void) | null,
    key: null as string | null,
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual: Record<string, unknown> = await importOriginal();
    return {
        ...actual,
        mountTabs: (root: Element, initial: {
            readonly items: readonly { readonly id: string; readonly label: string }[];
            readonly activeId: string;
            readonly onChange: (id: string) => void;
            readonly trackBackground?: boolean;
        }): { update: (next: { readonly activeId: string }) => void; dispose: () => void } => {
            const host = root as unknown as {
                readonly ownerDocument: { createElement(tagName: string): FakeElement };
                append(...nodes: FakeElement[]): void;
                addEventListener(type: string, listener: () => void): void;
            };
            strip.labels = initial.items.map((item) => item.label);
            strip.activeId = initial.activeId;
            strip.onChange = initial.onChange;
            strip.updates = 0;
            strip.disposed = false;
            strip.key = null;

            const track = host.ownerDocument.createElement('div');
            track.setAttribute('role', 'tablist');
            host.append(track);

            const paint = (activeId: string): void => {
                for (const item of initial.items) {
                    const button = strip.buttons[initial.items.indexOf(item)];
                    if (button !== undefined) {
                        button.setAttribute('aria-selected', item.id === activeId ? 'true' : 'false');
                        button.tabIndex = item.id === activeId ? 0 : -1;
                    }
                }
            };

            strip.buttons = initial.items.map((item) => {
                const button = host.ownerDocument.createElement('button');
                button.setAttribute('role', 'tab');
                button.setAttribute('data-id', item.id);
                track.append(button);
                return button;
            });
            paint(initial.activeId);
            host.addEventListener('keydown', (): void => undefined);
            track.addEventListener('keydown', (): void => undefined);

            return {
                update: (next) => {
                    strip.updates += 1;
                    strip.activeId = next.activeId;
                    paint(next.activeId);
                },
                dispose: () => {
                    strip.disposed = true;
                    track.remove();
                },
            };
        },
    };
});

/** The FR-010 labels, in the order the shell must mount them. */
const LABELS = ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About'];

/** One read stamp the read-state assertions use. */
const STAMP = '2026-09-28T12:00:00.000Z';

/** One spec whose mount and dispose are counted instead of doing work. */
interface CountedSpec {
    /** The spec the shell receives. */
    readonly spec: TabSpec;
    /** How many times this body mounted. */
    mounts: number;
    /** How many times its disposer ran. */
    disposals: number;
}

/**
 * Build the six specs with counting mounters.
 *
 * @returns The specs in strip order, plus the counters the tests read.
 */
function countedSpecs(): { readonly specs: readonly TabSpec[]; readonly counts: Map<string, CountedSpec> } {
    const counts = new Map<string, CountedSpec>();
    const specs = TAB_IDS.map((id) => {
        const record: CountedSpec = {
            mounts: 0,
            disposals: 0,
            spec: {
                id,
                label: LABELS[TAB_IDS.indexOf(id)] ?? id,
                mount: () => {
                    record.mounts += 1;

                    return () => {
                        record.disposals += 1;
                    };
                },
            },
        };
        counts.set(id, record);

        return record.spec;
    });

    return { specs, counts };
}

/**
 * Mount the shell over a fresh runtime and a fake root.
 *
 * @returns Everything a test needs to read back: runtime, root, specs, counts.
 */
function mountShell(): {
    readonly rt: ReturnType<typeof createTestRuntime>;
    readonly root: FakeElement;
    readonly counts: Map<string, CountedSpec>;
    readonly shell: ReturnType<typeof mountTabShell>;
} {
    const rt = createTestRuntime(fakeHost());
    const dom = fakeDom();
    const { specs, counts } = countedSpecs();
    const shell = mountTabShell({ rt, root: dom.root, specs });

    return { rt, root: dom.root as unknown as FakeElement, counts, shell };
}

/**
 * Read the body container the shell created for one tab (they live inside the
 * body region, one level below the root the strip also appended to).
 *
 * @param root - The fake panel root.
 * @param id - The tab id the container carries.
 * @returns The container, or `undefined` when the shell never made one.
 */
function bodyOf(root: FakeElement, id: string): FakeElement | undefined {
    const queue = [...root.children];
    while (queue.length > 0) {
        const node = queue.shift();
        if (node === undefined) {
            break;
        }

        if (node.attribute('data-body') === id) {
            return node;
        }

        queue.push(...node.children);
    }

    return undefined;
}

/**
 * Read the body region the shell created — the one element carrying
 * `data-body-region`, and the panel's only scroller (005 FR-082).
 *
 * @param root - The fake panel root.
 * @returns The region, or `undefined` when the shell made none.
 */
function regionOf(root: FakeElement): FakeElement | undefined {
    return root.children.find((node) => node.attribute('data-body-region') === 'true');
}

describe('mountTabShell (the six-tab shell, 005 FR-010)', () => {
    it('mounts six tabs in FR-010 order with Status active', () => {
        {
            const { rt, root, counts } = mountShell();

            expect(strip.labels).toEqual(LABELS);
            expect(strip.buttons).toHaveLength(6);
            expect(rt.activeTab).toBe('status');
            expect(bodyOf(root, 'status')?.hidden).toBe(false);
            for (const id of TAB_IDS.filter((tab) => tab !== 'status')) {
                expect(bodyOf(root, id)?.hidden).toBe(true);
            }

            // Status is active, so its body mounted on the first paint (FR-013).
            expect(counts.get('status')?.mounts).toBe(1);
        }
        {
            const { root } = mountShell();

            expect(root.children[0]?.attribute('role')).toBe('tablist');
            const region = root.children[1];
            expect(region?.children[0]?.attribute('data-body')).toBe('status');
        }
        {
            mountShell();

            const roving = strip.buttons.map((button) => button.tabIndex);
            expect(roving.filter((index) => index === 0)).toHaveLength(1);
            expect(roving[0]).toBe(0);
            expect(roving.slice(1).every((index) => index === -1)).toBe(true);
        }
    });
});

describe('the strip holds its layout while content scrolls (005 FR-082)', () => {
    it('makes the body region the panel’s only scroller', () => {
        {
            const { root } = mountShell();
            const region = regionOf(root);

            expect(region).toBeDefined();
            // Grow into the space the strip and banners leave, shrink before the
            // page does, and scroll inside that box: the three properties a
            // flex child needs to be the thing that moves instead of its siblings.
            expect(region?.style.flex).toBe('1 1 auto');
            expect(region?.style.minHeight).toBe('0');
            expect(region?.style.overflowY).toBe('auto');
        }
        {
            const { root } = mountShell();
            const region = regionOf(root);
            const stripElement = root.children[0];

            expect(stripElement?.attribute('role')).toBe('tablist');
            expect(region).toBeDefined();
            // The strip is a sibling *before* the scroller, never a child of it:
            // a strip inside the scrolling box would scroll away with the content.
            const stripIndex = root.children.indexOf(stripElement ?? root);
            const regionIndex = root.children.indexOf(region ?? root);
            expect(stripIndex).toBe(0);
            expect(regionIndex).toBeGreaterThan(stripIndex);
        }
        {
            const html = readFileSync(resolve(import.meta.dirname, '../panel/index.html'), 'utf8');

            // The stylesheet half of the contract: the shell only ever styles the
            // region, so every other child — notice, banners, strip — has to be
            // told here not to shrink. Without it a tall body squeezes the strip.
            expect(html).toMatch(/#root > \* \{\s*flex-shrink: 0;\s*\}/);
            expect(html).toMatch(/#root \{[^}]*display: flex;/);
            expect(html).toMatch(/#root \{[^}]*flex-direction: column;/);
        }
    });
});

describe('mountTabShell activation (005 FR-013, FR-014, FR-016)', () => {
    it('mounts a body once and never again (FR-013)', () => {
        {
            const { rt, root, counts } = mountShell();

            rt.shell?.activate('bindings');
            rt.shell?.activate('bindings');
            rt.shell?.activate('status');
            rt.shell?.activate('bindings');

            expect(counts.get('bindings')?.mounts).toBe(1);
            expect(bodyOf(root, 'bindings')?.hidden).toBe(false);
            expect(bodyOf(root, 'status')?.hidden).toBe(true);
        }
        {
            const { rt } = mountShell();
            const { updates } = strip;

            rt.shell?.activate('status');

            expect(strip.updates).toBe(updates);
            expect(rt.activeTab).toBe('status');
        }
        {
            const { rt, counts } = mountShell();

            for (const id of TAB_IDS) {
                rt.shell?.activate(id);
            }

            expect(rt.tabMounted.size).toBe(6);
            for (const id of TAB_IDS) {
                expect(counts.get(id)?.mounts).toBe(1);
            }
        }
        {
            const { rt, root } = mountShell();

            rt.shell?.activate('bindings');
            rt.shell?.activate('accounts');

            for (const id of TAB_IDS) {
                // eslint-disable-next-line unicorn/require-css-escape -- `id` comes from `TAB_IDS`, six literals.
                const tab = root.querySelector(`[role="tab"][data-id="${id}"]`);
                const body = bodyOf(root, id);
                expect(tab?.attribute('id')).toBe(`oc-tab-${id}`);
                expect(body?.attribute('role')).toBe('tabpanel');
                expect(body?.attribute('aria-labelledby')).toBe(`oc-tab-${id}`);
            }
            expect(strip.updates).toBe(2);
        }
        {
            const { rt, counts } = mountShell();

            strip.onChange?.('about');

            expect(rt.activeTab).toBe('about');
            expect(counts.get('about')?.mounts).toBe(1);
            expect(strip.key).toBeNull();
        }
        {
            const { rt } = mountShell();

            rt.shell?.noteRead('status', STAMP);

            expect(rt.tabLastRead.get('status')).toBe(STAMP);
            expect(rt.activeTab).toBe('status');
        }
    });
});

describe('mountTabShell teardown (005 FR-017, NFR-108)', () => {
    it('disposes every mounted body in strip order and clears the registries', () => {
        {
            const { rt, counts, shell } = mountShell();
            rt.shell?.activate('about');
            rt.shell?.activate('dispatches');
            rt.shell?.noteRead('dispatches', STAMP);

            shell.dispose();

            expect(counts.get('status')?.disposals).toBe(1);
            expect(counts.get('about')?.disposals).toBe(1);
            expect(counts.get('dispatches')?.disposals).toBe(1);
            // Never mounted, so nothing to release — dispose is not a mount.
            expect(counts.get('settings')?.disposals).toBe(0);
            expect(rt.tabMounted.size).toBe(0);
            expect(rt.tabLastRead.size).toBe(0);
            expect(strip.disposed).toBe(true);
            expect(rt.shell).toBeNull();
        }
        {
            const { root, shell } = mountShell();
            expect(root.children.length).toBeGreaterThan(1);

            shell.dispose();

            expect(root.children).toHaveLength(0);
        }
    });
});

/**
 * Read every `src/` line that writes a `hidden` flag, tagged with its file.
 *
 * @returns One `path:line` entry per assignment.
 */
function hiddenWrites(): readonly string[] {
    const dir = resolve(import.meta.dirname, '../src');
    const lines: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (!entry.endsWith('.ts')) {
            continue;
        }

        const source = readFileSync(join(dir, entry), UTF8).split('\n');
        for (const [index, line] of source.entries()) {
            if (/\.hidden\s*=/.test(line)) {
                lines.push(`src/${entry}:${index + 1}`);
            }
        }
    }

    return lines;
}

describe('the spike surface is deleted, not hidden (005 SC-103, FR-011)', () => {
    it('leaves no code path that hides a spike-era container', () => {
        {
            // The old switch wrote `section.spike.hidden` and
            // `section.bindings.pane.hidden`; neither container exists any more,
            // so no assignment may name one (FR-011, SC-103).
            const retired = hiddenWrites().filter((entry) => /(section|spike|repos\b|pane)/.test(entry));

            expect(retired).toEqual([]);
        }
        {
            const offenders = hiddenWrites().filter(
                (entry) => entry.includes('body.hidden') && !entry.startsWith('src/tabs.ts'),
            );

            expect(offenders).toEqual([]);
            expect(hiddenWrites().some((entry) => entry.startsWith('src/tabs.ts'))).toBe(true);
        }
    });
});

