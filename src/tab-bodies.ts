/**
 * The six tab bodies, in 005 FR-010's order.
 *
 * The shell ([`tabs.ts`](./tabs.ts)) owns *when* a body appears; this module
 * owns *what* appears in each one. Every mount is a mapping from an existing
 * surface onto a container — the spike era's two hidden bodies become six
 * bodies that each mount once and stay mounted (FR-013).
 *
 * One body still carries no read: Settings renders what wave 9 fills in.
 * Mounting an empty container is honest in a way a placeholder promise would
 * not be, and it keeps "no second path to a capability" true while the tabs
 * are still being filled (FR-010).
 */

import {
    acceptConsentAndRepaint,
    mountHandoffDom,
    refreshHandoff,
    submitHandoffAndRepaint,
} from './accounts-ui.ts';
import { createBindingsHandlers, mountBindingsTabBody } from './bindings-mount.ts';
import { disposeDispatchesBoard, mountDispatchesBoard } from './dispatches-ui.ts';
import { declineHandoffConsent } from './handoff.ts';
import type { PanelRuntime } from './panel-state.ts';
import { mountDiagnostics, mountProjectPicker } from './panel-ui.ts';
import type { PanelHandlers } from './panel-ui.ts';
import { mountPrerequisitesSection } from './prerequisites.ts';
import { disposeStatusTab, mountStatusTab } from './status-tab.ts';
import type { TabSpec } from './tabs.ts';

/**
 * Mount the Accounts body: the one-shot handoff group (FR-060, FR-061).
 *
 * The flow is relocated, not redesigned — same consent gate, same storage
 * pre-flight, same two-step refusal — so this is the mount call the spike body
 * used to own, pointed at the container the shell created instead.
 *
 * @param rt - Panel runtime.
 * @param body - The Accounts body container the shell created.
 * @returns `null`: teardown owns the handoff view, exactly as before.
 */
function mountAccountsBody(rt: PanelRuntime, body: HTMLElement): null {
    rt.handoffView = mountHandoffDom({
        root: body,
        handlers: {
            accept: () => {
                void acceptConsentAndRepaint(rt);
            },
            decline: () => {
                declineHandoffConsent(rt);
                refreshHandoff(rt);
            },
            submit: (token) => {
                void submitHandoffAndRepaint(rt, token);
            },
        },
    });
    refreshHandoff(rt);

    return null;
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
    rt.pickerUi = mountProjectPicker({ rt, root: body, handlers });
    mountBindingsTabBody(rt, body);

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
 * The About body: the read-only diagnostics list (FR-075).
 *
 * @param rt - Panel runtime whose ledger the list renders.
 * @param body - The body container the shell created.
 * @returns A disposer that releases the list handle.
 */
function mountAboutBody(rt: PanelRuntime, body: HTMLElement): () => void {
    rt.aboutUi = mountDiagnostics(rt, body);

    return () => {
        const diagnostics = rt.aboutUi;
        if (diagnostics !== null) {
            diagnostics.list.dispose();
        }

        rt.aboutUi = null;
    };
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
        { id: 'settings', label: 'Settings', mount: () => null },
        { id: 'about', label: 'About', mount: (body) => mountAboutBody(rt, body) },
    ];
}
