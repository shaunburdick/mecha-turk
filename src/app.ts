/**
 * Panel application for the extension.
 *
 * The app wires the documented host surface to one bounded flow: record the
 * host's settings snapshot, follow the service's bindings and event relay,
 * dispatch exactly one `host.startSession()` per claimed run, verify
 * host-owned project, worktree, and session state, and keep a redacted
 * ledger in `host.storage`.
 *
 * Configuration resolution is **bindings-authoritative only** (002 FR-041):
 * the integration card declares zero settings, so nothing here parses
 * `ctx.settings` into a repository, project, interval, or expected login.
 *
 * Every lifecycle transition the experiment needs (mounted, closed, paused,
 * removed, server-switch) is recorded explicitly; the frame is the only thing
 * running, so nothing survives it. Each step is a module level function over
 * the shared runtime so no single function hides the whole flow.
 */

import type { HostReadyContext, JsonValue } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { applyBindingsMode, loadInitialBindings } from './bindings-mode.ts';
import { preflightAndRepaint } from './accounts-ui.ts';
import { parseProjectId } from './config.ts';
import { restoreStoredConsent } from './consent.ts';
import { restoreStoredEvidence } from './evidence.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { analyzeLastCloseGap, buildMountContext, LIFECYCLE_EXPERIMENT_PLAN } from './lifecycle.ts';
import { createLedger, LEDGER_STORAGE_KEY, readLedger, recordPhase } from './ledger.ts';
import type { LedgerDetail } from './ledger.ts';
import {
    appendEntryAndPersist,
    persistLedger,
    stopPolling,
} from './panel-actions.ts';
import { mountPrerequisiteNotice, disposePrerequisites } from './prerequisites.ts';
import { createPanelRuntime, setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { mountPanelFraming, refresh } from './panel-ui.ts';
import type { PanelHandlers } from './panel-ui.ts';
import { isSelectableProject } from './project-picker.ts';
import {
    copyProjectId,
    loadProjects,
    rejectProjectSelection,
    restoreProjectSelection,
    storeProjectSelection,
} from './project-actions.ts';
import { redact } from './redaction.ts';
import { reconcileDispatchAttempts } from './reconcile.ts';
import { settleReconciliation, startRelayPolling } from './relay.ts';
import { loadDispatches } from './dispatches.ts';
import { mountTabShell } from './tabs.ts';
import { tabSpecs } from './tab-bodies.ts';
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
 * Apply the host's settings snapshot.
 *
 * Since 002 FR-041 emptied `contributes.integration.settings`, the snapshot
 * carries **zero** declared settings: there is no single-repo configuration
 * to parse and no card id to read, so this function no longer resolves a
 * config at all. What it still does is (a) record the snapshot — prerequisites
 * reads it as the "the host is ready" marker — and (b) re-apply
 * bindings-authoritative mode when a binding already supplies the dispatch
 * context, so a settings event can never demote a configured panel.
 *
 * The legacy branch that parsed `repository` / `project-id` /
 * `worktree-option` / `poll-interval-ms` / `expected-login` is **retired, not
 * kept as a fallback** (002 FR-041(a)): bindings are the only configuration
 * resolution mode, and a panel with no binding says it is waiting for one
 * instead of naming a setting the manifest no longer declares.
 *
 * Exported so the settings flow can be exercised directly by the
 * orchestration tests; the panel itself reaches this through the `onSettings`
 * subscription registered in {@link createSpikeApp}.
 *
 * @param rt - Panel runtime.
 * @param settings - Values from `ctx.settings` (an empty record in practice).
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
 * Adopt the project the operator picked in the panel picker.
 *
 * The id must come from the list the host just loaded, so a stale or invented
 * value can never reach the dispatch path. It is then persisted to extension
 * storage — integration settings are read-only from the panel in SDK 1.24.2,
 * and since 002 FR-041 there are none to write anyway — and recorded on the
 * runtime as this mount's selection. A refused write keeps the in-memory
 * selection for this mount and says so on the picker line; either way the
 * panel fails closed until a valid id is resolved.
 *
 * Exported for the orchestration tests, which drive the picker without a DOM.
 *
 * @param rt - Panel runtime.
 * @param id - Project id the operator picked.
 */
export async function selectProject(rt: PanelRuntime, id: string): Promise<void> {
    const candidate = parseProjectId(id);
    if (candidate === null || !isSelectableProject(rt.state.projects, candidate)) {
        rejectProjectSelection(rt, id);
        return;
    }

    rt.state.projectSelection = candidate;

    const write = await storeProjectSelection(rt.host, candidate);
    if (rt.disposed) {
        return;
    }

    rt.state.projects.note = write.ok
        ? `Selected project ${candidate}; stored for the next mount.`
        : redact(`Selected project ${candidate} for this session only: ${write.problem}`);
    refresh(rt);
}

/**
 * React to integration connection changes.
 *
 * The declared GitHub (token) integration card is optional and
 * non-authoritative (FR-011): the panel is fully functional with it
 * unconnected, because polling and dispatch run on the *service* accounts
 * under Bindings → Poll as account. The unconnected banner therefore
 * points at that account flow instead of steering the operator to a
 * credential surface the product does not need.
 *
 * The connected path arms nothing single-repository: since 002 FR-041 the
 * card declares no settings, so there is no repository, project, interval, or
 * expected login left to poll or check against — the service's poll loop and
 * the root-owned relay are the only loops in the product, and this handler
 * never starts either (it arms the relay only once a binding says what to
 * relay for).
 *
 * Exported so the orchestration tests can assert the banner copy without a
 * live host subscription.
 *
 * @param rt - Panel runtime.
 * @param connected - Whether the host reports a connected token.
 */
export function handleConnection(rt: PanelRuntime, connected: boolean): void {
    rt.state.connected = connected;
    if (!connected) {
        stopPolling(rt);
        const body =
            'Add one under Repositories → Poll as account — service accounts drive polling and dispatch. ' +
            'The optional GitHub (token) integration card declares no settings and is never required.';
        setStatus(rt, { tone: 'warning', title: 'No account connected', body });
        refresh(rt);
        return;
    }

    if (rt.state.bindingsActive > 0) {
        // Bindings mode: the relay is the loop, so the legacy identity check
        // and single-repo poll loop stay out of the way.
        applyBindingsMode(rt);
        startRelayPolling(rt);
        refresh(rt);
        return;
    }

    setStatus(rt, {
        tone: 'info',
        title: 'Connected',
        body: 'Waiting for a binding; the integration card declares no settings to apply.',
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

    await restoreStoredEvidence(rt);
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

    // Mounted outside `ui`, so nothing above would release them.
    disposePrerequisites(rt);

    if (rt.handoffView !== null) {
        rt.handoffView.dispose();
        rt.handoffView = null;
    }

    if (rt.shell !== null) {
        // One path for all six bodies: each disposer it registered runs in
        // strip order, then the strip itself removes (FR-017, NFR-108).
        rt.shell.dispose();
    }

    rt.bindingsUi = null;
    rt.dispatchesUi = null;
    rt.pickerUi = null;
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
 * Whether the frame was torn down while the last await was in flight.
 *
 * A function call rather than a bare `rt.disposed` read: the analyzer narrows
 * that property across an `await` and calls a second direct check unreachable,
 * while the frame really can go away between two awaits — and carrying on would
 * reconcile, claim, and dispatch from a disposed panel.
 *
 * @param rt - Panel runtime.
 * @returns `true` once the mount has been torn down.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 * Mount the panel: restore, configure, read, reconcile, repaint.
 *
 * @param rt - Panel runtime.
 * @param context - Ready snapshot from the host.
 */
async function mountPanel(rt: PanelRuntime, context: HostReadyContext): Promise<void> {
    await loadLedger(rt, nowIso());
    // The stored selection must land before the first `applySettings`: it is
    // the picker's starting point for this mount. The restore self-guards
    // after its own await, so one dispose check after both awaits is enough.
    await restoreProjectSelection(rt);
    if (rt.disposed) {
        return;
    }

    // The accepted-consent mirror must land before the first handoff repaint:
    // a panel that remounted after accepting must not re-ask for §1.1 consent.
    // It only flips one state flag, so the dispose check above covers it too.
    await restoreStoredConsent(rt);

    applySettings(rt, context.settings);
    handleConnection(rt, context.connection.connected);
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
 * only after every outstanding attempt has been re-reported (FR-025), in a
 * `finally` so no mount path can leave the relay unarmed — or armed ahead of
 * its own reconciliation.
 *
 * @param rt - Panel runtime.
 * @param context - Ready snapshot from the host.
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
        refreshProjects: () => void loadProjects(rt),
        selectProject: (id) => void selectProject(rt, id),
        copyProjectId: () => void copyProjectId(rt),
    };

    // Above the tab strip on purpose: FR-036 and FR-037 need the notice region
    // outside every section, and the banner is read-state framing that belongs
    // to the whole panel rather than to one tab.
    mountPrerequisiteNotice({ rt, parent: root });
    rt.ui = mountPanelFraming(root);
    mountTabShell({ rt, root, specs: tabSpecs(rt, handlers) });
    rt.pagehideListener = () => handlePagehide(rt);
    panelWindow.addEventListener('pagehide', rt.pagehideListener);
    registerHostListeners(rt, root);

    const steps = LIFECYCLE_EXPERIMENT_PLAN.length;
    const body = `Lifecycle experiment plan loaded: ${steps} steps.`;
    setStatus(rt, { tone: 'info', title: 'Mecha Turk', body });
    refresh(rt);

    return { dispose: () => teardown(rt) };
}
