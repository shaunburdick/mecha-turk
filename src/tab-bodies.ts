/**
 * The seven tab bodies, in 005 FR-010's order: the shell owns *when* a body
 * appears, this module owns *what* appears in each one — every mount maps an
 * existing surface onto a container, each body mounts once and stays mounted
 * (FR-013), and each owns its own read and its own disposer.
 */

import { createAccountsHandlers, mountAccountsBody as mountAccountsTab } from './accounts-tab.ts';
import { disposeAboutTab, mountAboutTab } from './about-tab.ts';
import { createBindingsHandlers, mountBindingsTabBody } from './bindings-mount.ts';
import { disposeDispatchesBoard, mountDispatchesBoard } from './dispatches-ui.ts';
import { disposeLogsTab, mountLogsTab } from './logs-tab.ts';
import type { PanelRuntime } from './panel-state.ts';
import { mountPrerequisitesSection } from './prerequisites.ts';
import { disposeSettingsTab, mountSettingsTab } from './settings-tab.ts';
import { disposeStatusTab, mountStatusTab } from './status-tab.ts';
import type { TabDisposer, TabSpec } from './tabs.ts';

/**
 * The Accounts body: the handoff group, the account list, and one detail
 * line. The flow is relocated with the same storage pre-flight and the same
 * two-step refusal (the consent gate it used to open with was removed by
 * product-owner order on 2026-10-01, 002 v1.9.0), and the list is the
 * credential-free DTO the service answers with. Only this body's own handles
 * are disposed here: the handoff view stays owned by the panel root, exactly
 * as before.
 */
function mountAccountsBody(rt: PanelRuntime, body: HTMLElement): () => void {
    const view = mountAccountsTab({ rt, body, handlers: createAccountsHandlers(rt) });

    return () => {
        view.dispose();
        rt.accountsUi = null;
    };
}

/**
 * The Status body: the honest projection, then the first-run prerequisites.
 *
 * The projection leads because it is the answer to "is it working"; the
 * checklist follows with its own remediation per line, and the unmet notice
 * it raises lives in the root region where switching tabs cannot hide it.
 */
function statusSpec(rt: PanelRuntime, body: HTMLElement): () => void {
    mountStatusTab({ rt, parent: body });
    mountPrerequisitesSection({ rt, parent: body });

    return () => disposeStatusTab(rt);
}

/**
 * The Settings body: the read-only configuration rows.
 *
 * The mount reads `GET /v1/config` once — the tab's one read, with Refresh as
 * its one retry — and the disposer releases every handle it created. Nothing
 * here writes: the configuration document is rendered, not edited.
 */
function settingsSpec(rt: PanelRuntime, body: HTMLElement): TabDisposer {
    mountSettingsTab({ rt, body });

    return () => disposeSettingsTab(rt);
}

/**
 * The Dispatches body: the list, its affordances, and its audit trail.
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
 * The Bindings body: the status/list and the add form.
 */
function mountBindingsBody(input: {
    readonly rt: PanelRuntime;
    readonly body: HTMLElement;
}): () => void {
    const { rt, body } = input;
    mountBindingsTabBody({
        rt,
        root: body,
    });

    return () => {
        const view = rt.bindingsUi;
        if (view !== null) {
            view.dispose();
        }

        rt.bindingsUi = null;
    };
}

/**
 * The About body: static identity, the version, and the read-only
 * Diagnostics section.
 */
function mountAboutBody(rt: PanelRuntime, body: HTMLElement): TabDisposer {
    mountAboutTab({ rt, body });

    return () => disposeAboutTab(rt);
}

/**
 * The Logs body: the retained stream and its cadence controls.
 */
function mountLogsBody(rt: PanelRuntime, body: HTMLElement): TabDisposer {
    mountLogsTab({ rt, parent: body });

    return () => disposeLogsTab(rt);
}

/**
 * The seven tab bodies order.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export function tabSpecs(rt: PanelRuntime): readonly TabSpec[] {
    return [
        { id: 'status', label: 'Status', mount: (body) => statusSpec(rt, body) },
        { id: 'dispatches', label: 'Dispatches', mount: (body) => mountDispatchesBody(rt, body) },
        { id: 'bindings', label: 'Bindings', mount: (body) => mountBindingsBody({ rt, body }) },
        { id: 'accounts', label: 'Accounts', mount: (body) => mountAccountsBody(rt, body) },
        { id: 'settings', label: 'Settings', mount: (body) => settingsSpec(rt, body) },
        { id: 'about', label: 'About', mount: (body) => mountAboutBody(rt, body) },
        { id: 'logs', label: 'Logs', mount: (body) => mountLogsBody(rt, body) },
    ];
}
