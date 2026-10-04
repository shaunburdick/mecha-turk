/**
 * The six tab bodies, in 005 FR-010's order.
 *
 * The shell ([`tabs.ts`](./tabs.ts)) owns *when* a body appears; this module
 * owns *what* appears in each one. Every mount is a mapping from an existing
 * surface onto a container — six bodies, each of which mounts once and stays
 * mounted (FR-013).
 *
 * Each body owns its own read and its own disposer: Settings reads the
 * configuration document on first activation and releases it on teardown,
 * exactly as Status reads the projection and Dispatches reads the list.
 */

import { createAccountsHandlers, mountAccountsBody as mountAccountsTab } from './accounts-tab.ts';
import { disposeAboutTab, mountAboutTab } from './about-tab.ts';
import { createBindingsHandlers, mountBindingsTabBody } from './bindings-mount.ts';
import { disposeDispatchesBoard, mountDispatchesBoard } from './dispatches-ui.ts';
import type { PanelRuntime } from './panel-state.ts';
import { mountProjectPicker } from './panel-ui.ts';
import type { PanelHandlers } from './panel-ui.ts';
import { mountPrerequisitesSection } from './prerequisites.ts';
import { disposeSettingsTab, mountSettingsTab } from './settings-tab.ts';
import { disposeStatusTab, mountStatusTab } from './status-tab.ts';
import type { TabDisposer, TabSpec } from './tabs.ts';

/**
 * The Accounts body: the handoff group, the account list, and one detail
 * line (FR-060, FR-061, FR-062).
 *
 * The flow is relocated with the same storage
 * pre-flight and the same two-step refusal (the consent gate it used to open
 * with was removed by product-owner order on 2026-10-01, 002 v1.9.0) — and
 * the list is the credential-free DTO
 * the service answers with. Only this body's own handles are disposed here:
 * the handoff view stays owned by the panel root, exactly as before.
 *
 * @param rt - Panel runtime.
 * @param body - The Accounts body container the shell created.
 * @returns A disposer that releases the list, detail, and note handles.
 */
function mountAccountsBody(rt: PanelRuntime, body: HTMLElement): () => void {
    const view = mountAccountsTab({ rt, body, handlers: createAccountsHandlers(rt) });

    return () => {
        view.dispose();
        rt.accountsUi = null;
    };
}

/**
 * The Status body: the honest projection, then the first-run prerequisites
 * (FR-030, FR-037).
 *
 * The projection leads because it is the answer to "is it working"; the
 * checklist follows with its own remediation per line, and the unmet notice
 * it raises lives in the root region where switching tabs cannot hide it.
 *
 * @param rt - Panel runtime the body reads.
 * @param body - The Status body container the shell created.
 * @returns A disposer that releases the projection's handles; the section
 *   disposes through its own registry at teardown.
 */
function statusSpec(rt: PanelRuntime, body: HTMLElement): () => void {
    mountStatusTab({ rt, parent: body });
    mountPrerequisitesSection({ rt, parent: body });

    return () => disposeStatusTab(rt);
}

/**
 * The Settings body: the read-only configuration rows (FR-070–FR-073).
 *
 * The mount reads `GET /v1/config` once — the tab's one read, with Refresh as
 * its one retry — and the disposer releases every handle it created. Nothing
 * here writes: the configuration document is rendered, not edited (FR-070).
 *
 * @param rt - Panel runtime the body reads and repaints.
 * @param body - The Settings body container the shell created.
 * @returns A disposer that releases the body's handles.
 */
function settingsSpec(rt: PanelRuntime, body: HTMLElement): TabDisposer {
    mountSettingsTab({ rt, body });

    return () => disposeSettingsTab(rt);
}

/**
 * The Dispatches body: the list, its affordances, and its audit trail (FR-040).
 *
 * @param rt - Panel runtime.
 * @param body - The body container the shell created.
 * @returns A disposer that releases the board's handles.
 */
function mountDispatchesBody(rt: PanelRuntime, body: HTMLElement): () => void {
    const board = mountDispatchesBoard({ rt, pane: body, handlers: createBindingsHandlers(rt) });
    rt.dispatchesUi = board;

    return () => {
        disposeDispatchesBoard(board);
        rt.dispatchesUi = null;
    };
}

/**
 * The Bindings body: the picker, the status/list, and the add form (FR-038).
 *
 * @param rt - Panel runtime.
 * @param body - The body container the shell created.
 * @param handlers - The picker's callbacks.
 * @returns A disposer that releases the picker and the pane's handles.
 */
function mountBindingsBody(input: {
    /** Panel runtime the body reads and repaints. */
    readonly rt: PanelRuntime;
    /** The body container the shell created. */
    readonly body: HTMLElement;
    /** The picker's callbacks. */
    readonly handlers: PanelHandlers;
}): () => void {
    const { rt, body, handlers } = input;
    mountBindingsTabBody({
        rt,
        root: body,
        // The picker opens the tab's first block rather than floating above
        // it: one rule across the six tabs — the tab title is the first
        // block's heading, and the controls live inside that block
        // (2026-10-01 review).
        mountFirst: (into) => {
            rt.pickerUi = mountProjectPicker({ rt, root: into, handlers });
        },
    });

    return () => {
        const picker = rt.pickerUi;
        if (picker !== null) {
            for (const handle of Object.values(picker)) {
                handle.dispose();
            }
        }

        rt.pickerUi = null;
        const view = rt.bindingsUi;
        if (view !== null) {
            view.dispose();
        }

        rt.bindingsUi = null;
    };
}

/**
 * The About body: static identity, the version, and the read-only
 * Diagnostics section (FR-074, FR-075).
 *
 * @param rt - Panel runtime the body reads and repaints.
 * @param body - The About body container the shell created.
 * @returns A disposer that releases the body's handles.
 */
function mountAboutBody(rt: PanelRuntime, body: HTMLElement): TabDisposer {
    mountAboutTab({ rt, body });

    return () => disposeAboutTab(rt);
}

/**
 * The six tab bodies, in FR-010's order.
 *
 * @param rt - Panel runtime the bodies read and repaint.
 * @param handlers - The picker's callbacks, which live on the Bindings body.
 * @returns The specs the shell mounts from.
 */
export function tabSpecs(rt: PanelRuntime, handlers: PanelHandlers): readonly TabSpec[] {
    return [
        { id: 'status', label: 'Status', mount: (body) => statusSpec(rt, body) },
        { id: 'dispatches', label: 'Dispatches', mount: (body) => mountDispatchesBody(rt, body) },
        { id: 'bindings', label: 'Bindings', mount: (body) => mountBindingsBody({ rt, body, handlers }) },
        { id: 'accounts', label: 'Accounts', mount: (body) => mountAccountsBody(rt, body) },
        { id: 'settings', label: 'Settings', mount: (body) => settingsSpec(rt, body) },
        { id: 'about', label: 'About', mount: (body) => mountAboutBody(rt, body) },
    ];
}
