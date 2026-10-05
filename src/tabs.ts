/**
 * The six-tab shell (005 FR-010–FR-019, FR-082).
 *
 * The panel root owns exactly one navigation surface: the SDK's `mountTabs`
 * strip, six body containers beneath it, and the registry that says which
 * bodies have mounted. This module switches *tabs*, not surfaces that could
 * drift apart (FR-011).
 *
 * Three rules shape it:
 *
 * - **Mount on first activation, never before** (FR-013): the host clears
 *   subscriptions on unmount, so six eagerly-mounted bodies would be six read
 *   paths to tear down. The registry records each mount once.
 * - **Activation is idempotent, except on Status** (FR-014 as re-cut at 005
 *   v1.16.0): activating the tab that already shows reads nothing on the five
 *   tabs that own no cadence, and reads on **Status** — `GET /v1/status` is a
 *   read, so looking at the tab cannot cause work, only a fresh answer. This is
 *   the one place the shell names a specific tab, and it names it for two
 *   reasons that both belong to activation and to nowhere else: the re-activation
 *   exception, and the tick's lifetime (FR-100) — a Status tab left in the
 *   background must issue no reads, and a tab that outlived its own activation
 *   would repaint a hidden body under the operator's hands.
 * - **The association is re-stamped after every repaint** (FR-016): the SDK
 *   repaints its strip by clearing the track, so an `id`/`aria-labelledby`
 *   pair stamped once would vanish on the first selection change.
 */

import { mountTabs } from '@openchamber/sdk/ui';
import type { TabsHandle } from '@openchamber/sdk/ui';
import { STATUS_TAB, TAB_IDS } from './panel-state.ts';
import type { PanelRuntime, TabId } from './panel-state.ts';
import { loadStatus, stopStatusRefresh } from './status-tab.ts';

/** A disposer for one tab body, or `null` when the mount owns nothing. */
export type TabDisposer = () => void;

/** What one tab body mounts on its first activation. */
export interface TabSpec {
    /** The tab's id; also the key its `oc-tab-<id>` association uses. */
    readonly id: TabId;
    /** Visible label, in {@link TAB_IDS} order. */
    readonly label: string;
    /**
     * Mount this body's contents into `body`, exactly once.
     *
     * @returns A disposer for teardown, or `null` when it owns nothing.
     */
    readonly mount: (body: HTMLElement) => TabDisposer | null;
}

/** What the shell owns: activation, read stamps, and disposal. */
export interface TabShell {
    /**
     * Show one tab, mounting its body the first time.
     *
     * @param id - The tab to show; a no-op when it already shows.
     */
    activate(id: TabId): void;
    /**
     * Record that a tab landed a read.
     *
     * @param at - RFC 3339 stamp of the read that landed.
     */
    noteRead(id: TabId, at: string): void;
    /** Re-stamp the tab↔body association. */
    associate(): void;
    /** Dispose every mounted body in strip order, then the strip. */
    dispose(): void;
}

/**
 * Create the body region: one container per tab, in strip order.
 *
 * The region is the panel's **only** scroller. It takes whatever height the
 * notice, the banners, and the strip leave over, and scrolls inside that —
 * so a tall body moves under a strip that keeps its height and stays
 * clickable, instead of squeezing it (005 FR-082: no primary action may
 * require horizontal scrolling, and the labels truncate rather than wrap and
 * change the strip's height — a strip that has been squeezed to nothing
 * cannot do either). The three inline styles are the ones `panel/index.html`
 * deliberately leaves to this element; its `flex-shrink: 0` rule covers
 * every other child of `#root`.
 *
 * @returns The region and the containers it holds, keyed by tab id.
 */
function createBodyRegion(
    root: HTMLElement,
    specs: readonly TabSpec[],
): { readonly region: HTMLElement; readonly bodies: Map<TabId, HTMLElement> } {
    const document = root.ownerDocument;
    const region = document.createElement('div');
    region.dataset.bodyRegion = 'true';
    region.style.display = 'flex';
    region.style.flexDirection = 'column';
    region.style.gap = '12px';
    region.style.marginTop = '8px';
    region.style.flex = '1 1 auto';
    region.style.minHeight = '0';
    region.style.overflowY = 'auto';
    root.append(region);

    const bodies = new Map<TabId, HTMLElement>();
    for (const spec of specs) {
        const body = document.createElement('div');
        body.dataset.body = spec.id;
        region.append(body);
        bodies.set(spec.id, body);
    }

    return { region, bodies };
}

/**
 * Stamp `id` on each tab button and the panel association on each body.
 *
 * The SDK emits `role="tab"`, `aria-selected`, and the roving `tabIndex`, but
 * no `id`/`aria-controls` pair — so the shell owns the association and
 * re-stamps it whenever the strip repaints (FR-016, D4).
 */
function associate(input: {
    /** Panel root the strip lives in. */
    readonly root: HTMLElement;
    /** The six specs, in strip order. */
    readonly specs: readonly TabSpec[];
    /** The containers keyed by tab id. */
    readonly bodies: ReadonlyMap<TabId, HTMLElement>;
}): void {
    const { root, specs, bodies } = input;
    for (const spec of specs) {
        // eslint-disable-next-line unicorn/require-css-escape -- `TabId` is six literals; escape is the identity.
        const tab = root.querySelector(`[role="tab"][data-id="${spec.id}"]`);
        tab?.setAttribute('id', `oc-tab-${spec.id}`);

        const body = bodies.get(spec.id);
        if (body === undefined) {
            continue;
        }

        body.setAttribute('role', 'tabpanel');
        body.setAttribute('aria-labelledby', `oc-tab-${spec.id}`);
    }
}

/**
 * Mount one body the first time it is shown.
 */
function mountOnce(input: {
    /** Runtime whose mount registry records the body. */
    readonly rt: PanelRuntime;
    /** The six specs, in strip order. */
    readonly specs: readonly TabSpec[];
    /** The containers keyed by tab id. */
    readonly bodies: ReadonlyMap<TabId, HTMLElement>;
    /** Disposers the shell hands teardown. */
    readonly disposers: Map<TabId, TabDisposer>;
}, id: TabId): void {
    const { rt, specs, bodies, disposers } = input;
    if (rt.tabMounted.has(id)) {
        return;
    }

    const spec = specs.find((candidate) => candidate.id === id);
    const body = bodies.get(id);
    if (spec === undefined || body === undefined) {
        return;
    }

    rt.tabMounted.add(id);
    const dispose = spec.mount(body);
    if (dispose !== null) {
        disposers.set(id, dispose);
    }
}

/**
 * Build the pair that shows exactly one body at a time.
 *
 * @returns `activate` for the strip's callback and `paint` for the shell.
 */
function createActivation(input: {
    /** Panel root the strip and the bodies live under. */
    readonly root: HTMLElement;
    /** Runtime whose activation field the pair writes. */
    readonly rt: PanelRuntime;
    /** The six specs, in strip order. */
    readonly specs: readonly TabSpec[];
    /** The containers keyed by tab id. */
    readonly bodies: ReadonlyMap<TabId, HTMLElement>;
    /** Disposers the shell hands teardown. */
    readonly disposers: Map<TabId, TabDisposer>;
    /** The mounted strip, repainted on every activation. */
    readonly tabs: TabsHandle;
}): {
    readonly activate: (id: TabId) => void;
    readonly paint: () => void;
    readonly mountActive: () => void;
} {
    const { root, rt, specs, bodies, disposers, tabs } = input;
    const mountInput = { rt, specs, bodies, disposers };

    const paint = (): void => {
        for (const spec of specs) {
            const body = bodies.get(spec.id);
            if (body !== undefined) {
                body.hidden = spec.id !== rt.activeTab;
            }
        }

        associate({ root, specs, bodies });
    };

    const activate = (id: TabId): void => {
        if (rt.disposed) {
            return;
        }

        // Leaving Status disarms the tick **before** anything else runs, so the
        // window between the click and the next repaint is one in which a
        // backgrounded tab can still issue a read (FR-100).
        if (id !== STATUS_TAB && rt.activeTab === STATUS_TAB) {
            stopStatusRefresh(rt);
        }

        if (id === rt.activeTab) {
            // Re-activating the tab that already shows stays a no-op on the five
            // tabs that own no cadence, and reads on Status — the exception
            // FR-014's re-cut made, because a look causes only a read (FR-100).
            // `loadStatus` refuses to stack behind an in-flight read, so
            // pressing the tab repeatedly cannot pile requests up.
            if (id === STATUS_TAB) {
                void loadStatus(rt);
            }

            return;
        }

        rt.activeTab = id;
        tabs.update({ activeId: id });
        mountOnce(mountInput, id);
        paint();

        // Switching *to* Status reads immediately, for the same reason: the tab
        // the operator just asked for answers from a fresh read rather than
        // from whatever was on screen when they left it (FR-100).
        if (id === STATUS_TAB) {
            void loadStatus(rt);
        }
    };

    const mountActive = (): void => mountOnce(mountInput, rt.activeTab);

    return { activate, paint, mountActive };
}

/**
 * Release everything the shell mounted: bodies in strip order, then the strip.
 *
 * The order is fixed and never depends on which tab was showing — `TabId` is
 * the closed union, so `TAB_IDS` reaches every body a spec could have mounted.
 */
function disposeShell(input: {
    /** Runtime whose registries are cleared. */
    readonly rt: PanelRuntime;
    /** Disposers the shell collected, keyed by tab id. */
    readonly disposers: Map<TabId, TabDisposer>;
    /** The mounted strip. */
    readonly tabs: TabsHandle;
    /** The body region to remove. */
    readonly region: HTMLElement;
    /** The containers keyed by tab id. */
    readonly bodies: Map<TabId, HTMLElement>;
}): void {
    const { rt, disposers, tabs, region, bodies } = input;
    for (const id of TAB_IDS) {
        const dispose = disposers.get(id);
        if (dispose !== undefined) {
            dispose();
        }
    }

    disposers.clear();
    bodies.clear();
    rt.tabMounted.clear();
    rt.tabLastRead.clear();
    tabs.dispose();
    region.remove();
    rt.shell = null;
}

/**
 * Mount the six-tab strip and its body region under the panel root.
 *
 * @returns The shell; it is also stored on `rt.shell`.
 */
export function mountTabShell(input: {
    /** Runtime whose activation and registries the shell drives. */
    readonly rt: PanelRuntime;
    /** Panel root element from `panel/index.html`. */
    readonly root: HTMLElement;
    /** The six specs order. */
    readonly specs: readonly TabSpec[];
}): TabShell {
    const { rt, root, specs } = input;
    // The strip's callback is installed before `activate` exists, so it reads
    // the pair through a holder: by the time an operator can click, the holder
    // holds the real function, and nothing here has to hoist past a const.
    const holder: { activate: ((id: TabId) => void) | null } = { activate: null };
    const tabs: TabsHandle = mountTabs(root, {
        items: specs.map((spec) => ({ id: spec.id, label: spec.label })),
        activeId: rt.activeTab,
        trackBackground: true,
        onChange: (id) => holder.activate?.(id as TabId),
    });
    const { region, bodies } = createBodyRegion(root, specs);
    const disposers = new Map<TabId, TabDisposer>();
    const { activate, paint, mountActive } = createActivation({
        root,
        rt,
        specs,
        bodies,
        disposers,
        tabs,
    });
    holder.activate = activate;

    const shell: TabShell = {
        activate,
        noteRead: (id, at) => {
            rt.tabLastRead.set(id, at);
        },
        associate: () => associate({ root, specs, bodies }),
        dispose: () => disposeShell({ rt, disposers, tabs, region, bodies }),
    };

    rt.shell = shell;
    mountActive();
    paint();

    return shell;
}
