/**
 * The tab shell (FR-010–FR-019): SDK `mountTabs` over all bodies,
 * mount on first activation, idempotent but the cadence tabs.
 */

import { mountTabs } from '@openchamber/sdk/ui';
import type { TabsHandle } from '@openchamber/sdk/ui';
import { LOGS_TAB, STATUS_TAB, TAB_IDS } from './panel-state.ts';
import type { PanelRuntime, TabId } from './panel-state.ts';
import { loadLogs, stopLogsRefresh } from './logs-tab.ts';
import { loadStatus, stopStatusRefresh } from './status-tab.ts';

export type TabDisposer = () => void;

export interface TabSpec {
    /** The tab's id; also the key its `oc-tab-<id>` association uses. */
    readonly id: TabId;
    readonly label: string;
    /**
     * Mount this body's contents into `body`, exactly once.
     *
     * @returns A disposer for teardown, or `null` when it owns nothing.
     */
    readonly mount: (body: HTMLElement) => TabDisposer | null;
}

export interface TabShell {
    /**
     * Show one tab, mounting its body the first time.
     */
    activate(id: TabId): void;
    /**
     * Record that a tab landed a read.
     */
    noteRead(id: TabId, at: string): void;
    associate(): void;
    dispose(): void;
}

/**
 * One cadence tab's shell duties: stop the tick it armed, issue its read.
 */
interface CadenceTab {
    readonly stop: (rt: PanelRuntime) => void;
    readonly read: (rt: PanelRuntime) => Promise<void>;
}

/**
 * The tabs that own a repeating read (FR-014 as amended, FR-100): each reads
 * on activation and on re-activation, and its own tick is stopped the moment
 * another tab takes over. One table rather than a special case per cadence
 * tab, so the rule is spelled once as the tab set grows (010 FR-005).
 */
const CADENCE_TABS: ReadonlyMap<TabId, CadenceTab> = new Map<TabId, CadenceTab>([
    [STATUS_TAB, { stop: stopStatusRefresh, read: loadStatus }],
    [LOGS_TAB, { stop: stopLogsRefresh, read: loadLogs }],
]);

/**
 * Create the body region: one container per tab, in strip order. The region
 * is the panel's **only** scroller — it takes whatever height the notice, the
 * banners, and the strip leave over, so a tall body moves under a strip that
 * keeps its height and stays clickable instead of squeezing it (005 FR-082: no
 * primary action may require horizontal scrolling, labels truncate rather than
 * wrap and change the strip's height, and a squeezed strip can do neither).
 * The three inline styles are the ones `panel/index.html` deliberately leaves
 * to this element; its `flex-shrink: 0` rule covers every other child of
 * `#root`.
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
    readonly root: HTMLElement;
    readonly specs: readonly TabSpec[];
    readonly bodies: ReadonlyMap<TabId, HTMLElement>;
}): void {
    const { root, specs, bodies } = input;
    for (const spec of specs) {
        // eslint-disable-next-line unicorn/require-css-escape -- `TabId` is fixed literals; escape is the identity.
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
    readonly rt: PanelRuntime;
    readonly specs: readonly TabSpec[];
    readonly bodies: ReadonlyMap<TabId, HTMLElement>;
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
 */
function createActivation(input: {
    readonly root: HTMLElement;
    readonly rt: PanelRuntime;
    readonly specs: readonly TabSpec[];
    readonly bodies: ReadonlyMap<TabId, HTMLElement>;
    readonly disposers: Map<TabId, TabDisposer>;
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

        // Leaving a cadence tab disarms its tick **before** anything else
        // runs, so the window between the click and the next repaint is one
        // in which a backgrounded tab can still issue a read (FR-100).
        if (id !== rt.activeTab) {
            CADENCE_TABS.get(rt.activeTab)?.stop(rt);
        }

        if (id === rt.activeTab) {
            // Re-activating the tab that already shows stays a no-op on the
            // tabs that own no cadence, and reads on a cadence tab — the
            // exception FR-014's re-cut made, because a look causes only a
            // read (FR-100). Each cadence read refuses to stack behind an
            // in-flight one, so pressing the tab repeatedly cannot pile
            // requests up.
            void CADENCE_TABS.get(id)?.read(rt);

            return;
        }

        rt.activeTab = id;
        tabs.update({ activeId: id });
        mountOnce(mountInput, id);
        paint();

        // Switching *to* a cadence tab reads immediately, for the same
        // reason: the tab the operator just asked for answers from a fresh
        // read rather than from whatever was on screen when they left it
        // (FR-100).
        void CADENCE_TABS.get(id)?.read(rt);
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
    readonly rt: PanelRuntime;
    readonly disposers: Map<TabId, TabDisposer>;
    readonly tabs: TabsHandle;
    readonly region: HTMLElement;
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
 * Mount the tab strip and its body region under the panel root.
 */
export function mountTabShell(input: {
    readonly rt: PanelRuntime;
    readonly root: HTMLElement;
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
