/**
 * Panel application for the extension spike.
 *
 * The app wires the documented host surface to one bounded flow: parse the
 * operator settings, authenticate through `host.request()`, poll one
 * repository for one configured-match issue, persist a redacted evidence
 * record, dispatch one `host.startSession()` call, verify host-owned project,
 * worktree, and session state, and keep a redacted ledger in `host.storage`.
 *
 * Every lifecycle transition the experiment needs (mounted, closed, paused,
 * removed, server-switch) is recorded explicitly; polling never survives the
 * frame because the frame is the only thing running it. Each step is a module
 * level function over the shared runtime so no single function hides the
 * whole flow.
 */

import type { HostReadyContext, JsonValue } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { parseSpikeConfig, repositoryLabel } from './config.ts';
import { EVIDENCE_STORAGE_KEY, readEvidence } from './evidence.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { analyzeLastCloseGap, buildMountContext, LIFECYCLE_EXPERIMENT_PLAN } from './lifecycle.ts';
import { createLedger, LEDGER_STORAGE_KEY, readLedger, recordPhase } from './ledger.ts';
import type { LedgerDetail } from './ledger.ts';
import {
    appendEntryAndPersist,
    ensureIdentity,
    markPhase,
    persistLedger,
    restartPolling,
    runPoll,
    startPolling,
    stopPolling,
    verifyHost,
} from './panel-actions.ts';
import { startDispatch } from './panel-dispatch.ts';
import { createPanelRuntime, setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { mountPanelUi, refresh } from './panel-ui.ts';
import type { PanelHandlers } from './panel-ui.ts';
import { describeError } from './session.ts';
import type { SpikeHost } from './session.ts';

/** Options for {@link createSpikeApp}. */
export interface SpikeAppOptions {
    /** Documented host client. */
    readonly host: SpikeHost;
    /** Panel root element from `panel/index.html`. */
    readonly root: HTMLElement;
    /** Frame window, used for the unload hook. */
    readonly panelWindow: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** Handle to the running panel app. */
export interface SpikeApp {
    /** Unsubscribe, stop timers, dispose UI, and release the host client. */
    dispose: () => void;
}

/**
 * Apply operator settings from the host.
 *
 * Exported so the settings flow — including the poll-timer restart when
 * `pollIntervalMs` changes while polling runs — can be exercised directly by
 * the orchestration tests; the panel itself reaches this through the
 * `onSettings` subscription registered in {@link createSpikeApp}.
 *
 * @param rt - Panel runtime.
 * @param settings - Values from `ctx.settings`.
 */
export function applySettings(rt: PanelRuntime, settings: Readonly<Record<string, string>>): void {
    const result = parseSpikeConfig(settings);
    if (!result.ok) {
        rt.state.config = null;
        stopPolling(rt);
        setStatus(rt, { tone: 'error', title: 'Configuration incomplete', body: result.problems.join('; ') });
        refresh(rt);
        return;
    }

    const previous = rt.state.config;
    rt.state.config = result.config;
    const notes = result.notes.length > 0 ? ` (${result.notes.join('; ')})` : '';
    const label = repositoryLabel(result.config.repository);
    const body = `${label} → project ${result.config.projectId}${notes}`;
    setStatus(rt, { tone: 'info', title: 'Configuration loaded', body });
    if (rt.state.connected && rt.state.login === null) {
        void ensureIdentity(rt);
    }

    if (previous !== null && previous.pollIntervalMs !== result.config.pollIntervalMs) {
        restartPolling(rt);
    }

    refresh(rt);
}

/**
 * React to integration connection changes.
 *
 * @param rt - Panel runtime.
 * @param connected - Whether the host reports a connected token.
 */
function handleConnection(rt: PanelRuntime, connected: boolean): void {
    rt.state.connected = connected;
    if (!connected) {
        stopPolling(rt);
        const body = 'Connect a GitHub token at Settings → Integrations → GitHub (token).';
        setStatus(rt, { tone: 'warning', title: 'Not connected', body });
        refresh(rt);
        return;
    }

    if (rt.state.config === null) {
        const body = 'Waiting for repository, project, and worktree settings.';
        setStatus(rt, { tone: 'info', title: 'Connected', body });
        refresh(rt);
        return;
    }

    if (rt.state.login === null) {
        void ensureIdentity(rt);
    } else {
        startPolling(rt);
    }

    refresh(rt);
}

/**
 * Restore the stored evidence record after a remount.
 *
 * The evidence record is written before a dispatch is attempted, so a panel
 * that is closed and reopened must find it again: without this the reopened
 * panel would show a match it can no longer dispatch (S6 lifecycle).
 *
 * @param rt - Panel runtime.
 */
async function restoreEvidence(rt: PanelRuntime): Promise<void> {
    let stored: JsonValue | undefined;
    try {
        stored = await rt.host.storage.get(EVIDENCE_STORAGE_KEY);
    } catch (cause) {
        setStatus(rt, { tone: 'error', title: 'Storage unavailable', body: describeError(cause) });
        return;
    }

    if (rt.disposed) {
        return;
    }

    const evidence = readEvidence(stored);
    if (evidence !== null) {
        rt.state.evidence = evidence;
    }
}

/**
 * Read whatever ledger storage holds, restore the evidence record, and record
 * this mount.
 *
 * Absence is evidence: a removed extension or another server's namespace
 * yields no ledger, and that is recorded rather than papered over. Exported so
 * the remount path — including restoring the evidence a reopened panel needs to
 * dispatch — can be driven directly by the orchestration tests.
 *
 * @param rt - Panel runtime.
 * @param mountedAt - RFC 3339 time of this mount.
 */
export async function loadLedger(rt: PanelRuntime, mountedAt: string): Promise<void> {
    let stored: JsonValue | undefined;
    try {
        stored = await rt.host.storage.get(LEDGER_STORAGE_KEY);
    } catch (cause) {
        setStatus(rt, { tone: 'error', title: 'Storage unavailable', body: describeError(cause) });
    }

    if (rt.disposed) {
        return;
    }

    const prior = readLedger(stored);
    const gap = analyzeLastCloseGap({ prior, mountedAt });
    const mount = buildMountContext(prior);
    const ledger = createLedger({
        correlationId: prior?.correlationId ?? newCorrelationId(),
        panelGeneration: mount.panelGeneration,
        storagePresentBeforeMount: mount.storagePresent,
        createdAt: mountedAt,
    });

    const note = mount.storagePresent ? `generation ${mount.panelGeneration}` : 'no prior ledger in storage';
    rt.state.ledger = recordPhase(ledger, { phase: 'mounted', at: mountedAt, note });

    if (gap !== null) {
        const detail: LedgerDetail = {
            verdict: gap.verdict,
            pollEntriesInGap: gap.pollEntriesInGap,
            gapMs: gap.gapMs,
            baseline: gap.closedAt,
            reopenedAt: gap.reopenedAt,
        };
        appendEntryAndPersist(rt, { at: mountedAt, kind: 'lifecycle', detail });
    }

    await restoreEvidence(rt);
    await persistLedger(rt);
    refresh(rt);
}

/**
 * Release timers, subscriptions, UI, and the host client.
 *
 * Exported for the orchestration tests, which assert that every subscription
 * collected on the runtime is released; the panel reaches it through the
 * `pagehide` hook and the `dispose()` handed back from {@link createSpikeApp}.
 *
 * @param rt - Panel runtime to tear down.
 */
export function teardown(rt: PanelRuntime): void {
    if (rt.disposed) {
        return;
    }

    rt.disposed = true;
    stopPolling(rt);
    if (rt.pagehideListener !== null) {
        rt.panelWindow.removeEventListener('pagehide', rt.pagehideListener);
        rt.pagehideListener = null;
    }

    for (const unsubscribe of rt.unsubscribes) {
        unsubscribe();
    }

    rt.unsubscribes.length = 0;
    const { ui } = rt;
    if (ui !== null) {
        for (const handle of Object.values(ui)) {
            handle.dispose();
        }

        rt.ui = null;
    }

    rt.host.dispose();
}

/**
 * Record the unload phase and tear the panel down.
 *
 * Exported for the ordering test: the ledger write is started before teardown
 * because the frame is about to go away; if it does not survive, the next mount
 * still detects the gap from its last stored entry. The persist call happens
 * before `disposed` is set, so the write is never skipped by the runtime's own
 * guard.
 *
 * @param rt - Panel runtime.
 */
export function handlePagehide(rt: PanelRuntime): void {
    if (rt.disposed) {
        return;
    }

    rt.state.ledger = recordPhase(rt.state.ledger, { phase: 'closed', at: nowIso(), note: 'panel unload' });
    void persistLedger(rt);
    teardown(rt);
}

/**
 * First-time start, driven by `onReady`.
 *
 * @param rt - Panel runtime.
 * @param context - Ready snapshot from the host.
 */
async function begin(rt: PanelRuntime, context: HostReadyContext): Promise<void> {
    await loadLedger(rt, nowIso());
    if (rt.disposed) {
        return;
    }

    applySettings(rt, context.settings);
    handleConnection(rt, context.connection.connected);
    refresh(rt);
}

/**
 * Register the documented host subscriptions the panel listens to.
 *
 * Every registration is collected on the runtime so `teardown` can release
 * them, keeping the frame inside the host's 32-subscription budget.
 *
 * @param rt - Panel runtime.
 * @param root - Panel root element, needed to apply the theme once.
 */
function registerHostListeners(rt: PanelRuntime, root: HTMLElement): void {
    const { host } = rt;
    rt.unsubscribes.push(
        host.onReady((context) => {
            applyHostReady(context, root.ownerDocument.documentElement);
            if (rt.started || rt.disposed) {
                return;
            }

            rt.started = true;
            void begin(rt, context);
        }),
        host.onSettings((settings) => {
            if (!rt.disposed) {
                applySettings(rt, settings);
            }
        }),
        host.onConnection((connection) => {
            if (!rt.disposed) {
                handleConnection(rt, connection.connected);
            }
        }),
        host.onSessionLifecycle((event) => {
            if (rt.disposed) {
                return;
            }

            const detail: LedgerDetail = { sessionId: event.sessionId, phase: event.phase };
            appendEntryAndPersist(rt, { at: nowIso(), kind: 'lifecycle', detail });
        }),
    );
}

/**
 * Build and start the panel application.
 *
 * Mounts the UI immediately, then waits for `onReady` before reading settings
 * and storage, so the theme and context are applied exactly once.
 *
 * @param options - Host client, root element, and frame window.
 * @returns A handle that tears the panel down again.
 */
export function createSpikeApp(options: SpikeAppOptions): SpikeApp {
    const { host, root, panelWindow } = options;
    const rt = createPanelRuntime(host, panelWindow);
    const handlers: PanelHandlers = {
        poll: () => void runPoll(rt),
        dispatch: () => void startDispatch(rt),
        verify: () => void verifyHost(rt),
        mark: () => void markPhase(rt),
    };

    rt.ui = mountPanelUi(rt, { root, handlers });
    rt.pagehideListener = () => handlePagehide(rt);
    panelWindow.addEventListener('pagehide', rt.pagehideListener);
    registerHostListeners(rt, root);

    const steps = LIFECYCLE_EXPERIMENT_PLAN.length;
    const body = `Lifecycle experiment plan loaded: ${steps} steps.`;
    setStatus(rt, { tone: 'info', title: 'Mecha Turk Spike', body });
    refresh(rt);

    return { dispose: () => teardown(rt) };
}
