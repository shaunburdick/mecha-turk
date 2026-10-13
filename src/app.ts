/**
 * Panel application for the extension: wires the documented host surface to
 * one bounded flow — settings snapshot, bindings and event relay, exactly one
 * `host.startSession()` per claimed run, host-state verification, and a
 * redacted ledger in `host.storage`.
 */

import type { HostReadyContext, JsonValue } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { applyBindingsMode, loadInitialBindings } from './bindings-mode.ts';
import { preflightAndRepaint } from './accounts-ui.ts';
import { restoreStoredEvidence } from './evidence.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { analyzeLastCloseGap, buildMountContext, LIFECYCLE_EXPERIMENT_PLAN } from './lifecycle.ts';
import { createLedger, LEDGER_STORAGE_KEY, readLedger, recordPhase } from './ledger.ts';
import type { LedgerDetail } from './ledger.ts';
import { appendEntryAndPersist, persistLedger } from './panel-actions.ts';
import { mountPrerequisiteNotice, disposePrerequisites } from './prerequisites.ts';
import { createPanelRuntime, setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { mountPanelFraming, refresh } from './panel-ui.ts';
import { loadProjects, recordHostDirectory } from './project-actions.ts';
import { reconcileDispatchAttempts } from './reconcile.ts';
import { settleReconciliation, stopRelayPolling } from './relay.ts';
import { loadDispatches } from './dispatches.ts';
import { loadStatus } from './status-tab.ts';
import { mountTabShell } from './tabs.ts';
import { tabSpecs } from './tab-bodies.ts';
import { describeError } from './session.ts';
import type { PanelHost } from './session.ts';

export interface PanelAppOptions {
    readonly host: PanelHost;
    readonly root: HTMLElement;
    readonly panelWindow: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface PanelApp {
    dispose: () => void;
}

/**
 * Apply the host's settings snapshot. Since 002 FR-041 emptied
 * `contributes.integration.settings`, the snapshot carries **zero** declared
 * settings, so nothing is parsed: it records the snapshot (prerequisites reads
 * it as the "the host is ready" marker) and re-applies bindings-authoritative
 * mode when a binding already supplies the dispatch context, so a settings
 * event can never demote a configured panel. The legacy single-repo branch is
 * **retired, not kept as a fallback** (002 FR-041(a)): a panel with no binding
 * says it is waiting for one instead of naming a setting the manifest no longer
 * declares. Exported so the orchestration tests can drive the settings flow.
 */
export function applySettings(rt: PanelRuntime, settings: Readonly<Record<string, string>>): void {
    rt.state.settings = settings;
    if (rt.state.bindingsActive > 0) {
        applyBindingsMode(rt);
        refresh(rt);
        return;
    }

    rt.state.config = null;
    setStatus(rt, {
        tone: 'info',
        title: 'Waiting for a binding',
        body: 'Dispatch context comes from a binding; the integration card declares no settings.',
    });
    refresh(rt);
}

/**
 * Read whatever ledger storage holds, restore the evidence record, and record
 * this mount.
 *
 * Absence is evidence: a removed extension or another server's namespace
 * yields no ledger, and that is recorded rather than papered over. Exported so
 * the remount path — including restoring the evidence a reopened panel needs to
 * dispatch — can be driven directly by the orchestration tests.
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

    await restoreStoredEvidence(rt);
    await persistLedger(rt);
    refresh(rt);
}

/**
 * Release timers, subscriptions, UI, and the host client.
 *
 * Exported for the orchestration tests, which assert that every subscription
 * collected on the runtime is released; the panel reaches it through the
 * `pagehide` hook and the `dispose()` handed back from {@link createPanelApp}.
 */
export function teardown(rt: PanelRuntime): void {
    if (rt.disposed) {
        return;
    }

    rt.disposed = true;
    // The relay is root-owned, so this is where its loop stops: a
    // torn-down panel must leave no surviving timer behind,
    // and nothing else in the teardown path knows the loop exists.
    stopRelayPolling(rt);
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

    // Mounted outside `ui`, so nothing above would release them.
    disposePrerequisites(rt);

    if (rt.handoffView !== null) {
        rt.handoffView.dispose();
        rt.handoffView = null;
    }

    if (rt.shell !== null) {
        // One path for all six bodies: each disposer it registered runs in
        // strip order, then the strip itself removes.
        rt.shell.dispose();
    }

    rt.bindingsUi = null;
    rt.dispatchesUi = null;
    rt.aboutUi = null;

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
 * Whether the frame was torn down while the last await was in flight. A
 * function call rather than a bare `rt.disposed` read: the analyzer narrows that
 * property across an `await` and calls a second direct check unreachable, while
 * the frame really can go away between two awaits — and carrying on would
 * reconcile, claim, and dispatch from a disposed panel.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 * Mount the panel: restore, configure, read, reconcile, repaint.
 */
async function mountPanel(rt: PanelRuntime, context: HostReadyContext): Promise<void> {
    // First on purpose: the default's snapshot is load-time only, recorded
    // before anything can repaint from it (002 FR-095).
    recordHostDirectory(rt, context.directory ?? null);
    await loadLedger(rt, nowIso());
    if (rt.disposed) {
        return;
    }

    applySettings(rt, context.settings);
    void loadProjects(rt);
    // Bindings land before the handoff pre-flight so the banner reflects
    // them and the relay is armed for the operator's loop test. Awaited
    // rather than fired: it is the one mount-time read that writes a banner
    // of its own, and reconciliation's warning has to be the last one this
    // mount writes (a warning that later reads as "Configuration loaded"
    // would be a silent skip in a prettier font).
    await loadInitialBindings(rt);
    if (tornDown(rt)) {
        return;
    }

    // The runs history is read on mount too (M8), beside the bindings it
    // sits under: one GET /v1/events that fails here lands on the runs
    // note line instead of an empty area nobody can explain.
    void loadDispatches(rt);
    // The Status tab's projection is read at mount as well, so the tab the
    // panel opens on answers its one question immediately; its own refresh
    // control is the explicit re-read.
    void loadStatus(rt);
    // The handoff input stays disabled until this pre-flight proves the
    // service storage is writable (F10/SEC-08); a failed pre-flight leaves
    // the reason on screen instead of a usable credential field.
    void preflightAndRepaint(rt);

    // FR-025: every attempt this panel recorded and has not seen acknowledged
    // is re-reported here — bounded, idempotent, and never silently skipped.
    // The relay cannot claim before this returns, because the gate is still
    // closed and every arming site defers to it.
    await reconcileDispatchAttempts(rt);
    refresh(rt);
}

/**
 * First-time start, driven by `onReady`.
 *
 * The reconcile gate closes before anything that could arm the relay and opens
 * only after every outstanding attempt has been re-reported, in a
 * `finally` so no mount path can leave the relay unarmed — or armed ahead of
 * its own reconciliation.
 */
async function begin(rt: PanelRuntime, context: HostReadyContext): Promise<void> {
    rt.reconcileSettled = false;
    try {
        await mountPanel(rt, context);
    } finally {
        settleReconciliation(rt);
    }
}

/**
 * Register the documented host subscriptions the panel listens to.
 *
 * Every registration is collected on the runtime so `teardown` can release
 * them, keeping the frame inside the host's 32-subscription budget.
 *
 * The root element is needed to apply the theme once.
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
 * @returns A handle that tears the panel down again.
 */
export function createPanelApp(options: PanelAppOptions): PanelApp {
    const { host, root, panelWindow } = options;
    const rt = createPanelRuntime(host, panelWindow);

    // Above the tab strip on purpose: FR-036 and FR-037 need the notice region
    // outside every section, and the banner is read-state framing that belongs
    // to the whole panel rather than to one tab.
    mountPrerequisiteNotice({ rt, parent: root });
    rt.ui = mountPanelFraming(root);
    mountTabShell({ rt, root, specs: tabSpecs(rt) });
    rt.pagehideListener = () => handlePagehide(rt);
    panelWindow.addEventListener('pagehide', rt.pagehideListener);
    registerHostListeners(rt, root);

    const steps = LIFECYCLE_EXPERIMENT_PLAN.length;
    const body = `Lifecycle experiment plan loaded: ${steps} steps.`;
    setStatus(rt, { tone: 'info', title: 'Mecha Turk', body });
    refresh(rt);

    return { dispose: () => teardown(rt) };
}
