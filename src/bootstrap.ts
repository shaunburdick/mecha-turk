/** The startup runner (005 FR-141, FR-142): five stages, one catch each; failures never rethrow. */

import { teardown } from './app.ts';
import { createPanelRuntime } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import type { PanelHost } from './session.ts';
import {
    STARTUP_NOTICE,
    emitStartupStage,
    recordStartupFailure,
    startupEnvironment,
} from './startup.ts';
import type { StartupDocument, StartupEnvironment } from './startup.ts';

/** What the composition root hands the runner: document, frame, bridge, shell. */
export interface StartupDeps {
    readonly doc: StartupDocument;
    readonly panelWindow: Pick<Window, 'addEventListener' | 'removeEventListener' | 'isSecureContext'>;
    readonly connect: () => PanelHost;
    readonly mountPanelApp: (rt: PanelRuntime, root: HTMLElement) => void;
}

/** The stage-1 refusal, moved here from the entry point that used to throw it. */
const ROOT_MISSING = 'panel/index.html is missing its #root element';

/**
 * Run startup to a mounted shell, or as far as it gets. Failures route by
 * stage completion, never root: a half-built shell tears down behind the notice.
 */
export function runStartup(deps: StartupDeps): PanelRuntime | null {
    const isInsecureContext = !deps.panelWindow.isSecureContext;
    const environment: StartupEnvironment = startupEnvironment(deps.panelWindow.isSecureContext);

    let root: HTMLElement;
    try {
        const node = deps.doc.querySelector('#root');
        if (node === null) {
            throw new Error(ROOT_MISSING);
        }

        root = node as HTMLElement;
    } catch (cause) {
        recordStartupFailure({
            stage: 'startup markup',
            cause,
            shellMounted: false,
            runtime: null,
            doc: deps.doc,
            environment,
            insecureContext: isInsecureContext,
        });

        return null;
    }

    emitStartupStage({ stage: 'startup markup', runtime: null, environment });

    let host: PanelHost;
    try {
        host = deps.connect();
    } catch (cause) {
        recordStartupFailure({
            stage: 'host bridge',
            cause,
            shellMounted: false,
            runtime: null,
            doc: deps.doc,
            environment: null,
            insecureContext: isInsecureContext,
        });

        return null;
    }

    emitStartupStage({ stage: 'host bridge', runtime: null, environment: null });

    let rt: PanelRuntime;
    try {
        rt = createPanelRuntime(host, deps.panelWindow);
    } catch (cause) {
        recordStartupFailure({
            stage: 'runtime construction',
            cause,
            shellMounted: false,
            runtime: null,
            doc: deps.doc,
            environment: null,
            insecureContext: isInsecureContext,
        });

        return null;
    }

    emitStartupStage({ stage: 'runtime construction', runtime: rt, environment: null });

    try {
        deps.mountPanelApp(rt, root);
        // The shell owns the screen from here; the notice may never sit beside it.
        deps.doc.querySelector(STARTUP_NOTICE)?.remove();
    } catch (cause) {
        recordStartupFailure({
            stage: 'shell mount',
            cause,
            shellMounted: false,
            runtime: rt,
            doc: deps.doc,
            environment: null,
            insecureContext: isInsecureContext,
        });
        // The listener this runtime registered must not run `begin` later.
        try {
            teardown(rt);
        } catch {
            // A throwing disposer costs the cleanup, never the fail-closed
            // state: the gate fields are already cleared above (SC-116).
            return rt;
        }

        return rt;
    }

    emitStartupStage({ stage: 'shell mount', runtime: rt, environment: null });

    return rt;
}
