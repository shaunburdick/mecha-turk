import { refresh } from './panel-ui.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime, PanelStatus } from './panel-state.ts';

/** Operator-safe copy used when the panel cannot finish its initial startup. */
export const PANEL_STARTUP_FAILURE_COPY =
    "Mecha Turk could not start. Reopen the panel; if the problem persists, check OpenChamber's host logs.";

/** Status banner for an asynchronous initial host-ready setup failure. */
export const PANEL_STARTUP_FAILURE_STATUS: PanelStatus = {
    tone: 'error',
    title: 'Panel startup failed',
    body: PANEL_STARTUP_FAILURE_COPY,
};

/**
 * Replace the static startup notice with the safe, accessible failure state.
 *
 * @param notice - The visible status node from the panel document.
 */
export function renderPanelStartupFailure(
    notice: Pick<HTMLElement, 'setAttribute' | 'textContent'>,
): void {
    notice.textContent = PANEL_STARTUP_FAILURE_COPY;
    notice.setAttribute('role', 'alert');
    notice.setAttribute('aria-live', 'assertive');
    notice.setAttribute('aria-atomic', 'true');
}

/**
 * Remove the overlay only after the panel shell has mounted successfully.
 *
 * @param notice - The static or dynamically-created startup node.
 */
export function dismissPanelStartupNotice(notice: Pick<HTMLElement, 'remove'>): void {
    notice.remove();
}

/**
 * Expose startup failure while keeping the reconciliation/relay gate closed.
 *
 * @param rt - The runtime whose initial setup failed.
 */
export function reportPanelStartupFailure(rt: PanelRuntime): void {
    rt.relayArmPending = false;
    if (rt.disposed) {
        return;
    }

    setStatus(rt, PANEL_STARTUP_FAILURE_STATUS);
    refresh(rt);
}

/**
 * Run initial host-ready work without leaking a rejected startup promise.
 *
 * The failure callback receives no exception value so a host error cannot be
 * accidentally copied into the operator-visible status.
 *
 * @param operation - Initial panel setup to run.
 * @param onSuccess - Reconciliation action released only after setup succeeds.
 * @param onFailure - Visible, fail-closed recovery action.
 */
export async function runPanelStartup(
    operation: () => Promise<void>,
    onSuccess: () => void | Promise<void>,
    onFailure: () => void | Promise<void>,
): Promise<void> {
    try {
        await operation();
    } catch {
        await onFailure();

        return;
    }

    await onSuccess();
}
