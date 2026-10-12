/**
 * Panel rendering.
 *
 * The UI is built once from `@openchamber/sdk/ui` controls and repainted from
 * state, so `onReady` refreshes never replace a control the user is
 * interacting with, and every body repaints only while it is mounted, so a tab
 * the operator has never opened owns no handles yet (FR-013, FR-019).
 *
 * The panel-level *OpenChamber project* picker that used to head the
 * Bindings tab is gone (issue #39): the binding form's own *Dispatch
 * project* field is the one project control, and it carries the list's
 * reload button and status line beside it (`bindings-body.ts`).
 */

import { mountBanner } from '@openchamber/sdk/ui';
import type { BannerHandle } from '@openchamber/sdk/ui';
import { refreshHandoff } from './accounts-ui.ts';
import { repaintAccountsBody } from './accounts-tab.ts';
import { repaintAboutTab } from './about-tab.ts';
import { repaintDispatchesBoard } from './dispatches-ui.ts';
import { repaintPrerequisites } from './prerequisites.ts';
import { repaintBindingsPane } from './bindings-ui.ts';
import type { PanelRuntime } from './panel-state.ts';

/** The root framing: the banner above the prerequisite and tab strip. */
export interface PanelUi {
    /** Status banner. */
    banner: BannerHandle;
}

/**
 * Mount the panel's root framing: the banner above the tab strip.
 *
 * The banner is the read-state framing every tab shares, so it mounts once
 * above the strip and never moves (plan §The shell). The root carries
 * **nothing else** that is not a tab: the context summary line the panel used
 * to print here (`bindings: … · accounts: … · identity: … · ledger: …`) was
 * removed by the 2026-10-01 product-owner review — every fact it carried
 * already has a tab that owns it, and a second home for a fact is a second
 * place it can drift from.
 *
 * @returns The one handle the repaint path updates.
 */
export function mountPanelFraming(root: HTMLElement): PanelUi {
    const banner = mountBanner(root, { tone: 'info', title: 'Mecha Turk', body: 'Waiting for the host.' });

    return { banner };
}

/**
 * Repaint every mounted control from the current state.
 *
 * Nothing runs on a disposed runtime, and each body repaints only while it is
 * mounted: a tab the operator has never opened owns no handles yet, and the
 * registry on `rt` is what says so.
 */
export function refresh(rt: PanelRuntime): void {
    if (rt.disposed) {
        return;
    }

    const { ui } = rt;
    if (ui !== null) {
        const { state } = rt;
        ui.banner.update({ tone: state.status.tone, title: state.status.title, body: state.status.body });
    }

    const { bindingsUi, dispatchesUi, accountsUi } = rt;
    if (bindingsUi !== null) {
        repaintBindingsPane(rt, bindingsUi);
    }

    if (accountsUi !== null) {
        repaintAccountsBody(rt, accountsUi);
    }

    if (dispatchesUi !== null) {
        repaintDispatchesBoard(rt, dispatchesUi);
    }

    // The About tab paints itself from state it shares with no other body:
    // its version line is its own read, while the data directory, phase
    // record, and ledger come from state this repaint has just refreshed.
    repaintAboutTab(rt);

    refreshHandoff(rt);
    repaintPrerequisites(rt);
}
