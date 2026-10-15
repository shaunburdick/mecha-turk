/**
 * Shared mutable state for the panel: one runtime object carrying the
 * documented host client, the frame window, the ledger, and the small
 * lifecycle flags that keep a single poll loop and a single dispatch honest.
 */

import type { BannerTone } from '@openchamber/sdk/ui';
import type { BindingContext } from './config.ts';
import type { PanelEvidence } from './evidence.ts';
import type { AuditViewState } from './audit-view.ts';
import { initialAuditHistory } from './audit-view.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { createLedger } from './ledger.ts';
import { initialHandoffState } from './handoff.ts';
import type { PanelLedger } from './ledger.ts';
import type { HandoffState } from './handoff.ts';
import type { HandoffView } from './accounts-ui.ts';
import type { BindingsPane } from './bindings-ui.ts';
import type { AccountsBody } from './accounts-tab.ts';
import { initialAccounts } from './accounts-state.ts';
import type { AccountsTabState } from './accounts-state.ts';
import { initialBindings } from './bindings-state.ts';
import type { BindingsTabState } from './bindings-state.ts';
import { initialProjectPicker } from './project-picker.ts';
import type { ProjectPickerState } from './project-picker.ts';
import type { DispatchesBoard } from './dispatches-ui.ts';
import type { StatusTabUi } from './status-tab.ts';
import { initialStatusTab } from './status-document.ts';
import type { StatusTabState } from './status-document.ts';
import { initialSettingsTab } from './settings-tab.ts';
import type { SettingsTabState, SettingsTabUi } from './settings-tab.ts';
import { initialAboutTab } from './about-tab.ts';
import type { AboutTabState, AboutTabUi } from './about-tab.ts';
import type { TabShell } from './tabs.ts';
import type { PanelUi } from './panel-ui.ts';

// The Accounts and Bindings tabs' working states moved out for the file-length
// gate; both stay importable from here, so no call site had to change with the
// move.
export type { AccountsTabState } from './accounts-state.ts';
export type { BindingsStatus } from './bindings-state.ts';
export type { BindingsTabState };
export { initialBindings };
export { initialProjectPicker };
export type { ProjectPickerState } from './project-picker.ts';

export type { PanelUi } from './panel-ui.ts';
import type { RunRow } from './dispatches-service.ts';
import type { PanelHost } from './session.ts';
import type { FollowUpDeliveryRecord } from './dispatch-record.ts';
import { initialDispatchFilters, initialDispatchListPage } from './dispatch-page.ts';
import type { DispatchFilters, DispatchListPage } from './dispatch-page.ts';

/**
 * The six top-level surfaces, in strip order.
 *
 * A closed union: the shell constructs every value that reaches it, so an
 * unknown id can never arrive and there is no passthrough branch.
 */
export type TabId = 'status' | 'dispatches' | 'bindings' | 'accounts' | 'settings' | 'about';

/** Every {@link TabId}, in strip order — the strip's declaration (FR-010). */
export const TAB_IDS: readonly TabId[] = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'];

/**
 * The tab that owns a repeating read, and the only one (005 FR-100): named
 * rather than spelled at each comparison because two modules have to agree on
 * it — `status-tab.ts` arms the refresh tick only while this tab is active,
 * and a panel that armed for a hidden tab would repaint a background body.
 */
export const STATUS_TAB: TabId = 'status';

export interface PanelStatus {
    readonly tone: BannerTone;
    readonly title: string;
    /** Supporting detail; never contains secret material. */
    readonly body: string;
}

/**
 * Build the empty Dispatches-section state (M8).
 */
export function initialDispatches(): DispatchesState {
    return {
        rows: [],
        status: 'idle',
        note: '',
        selectedRun: null,
        agentNotice: null,
        pendingAction: null,
        sessionInput: '',
        busy: false,
        audit: initialAuditHistory(),
        filters: initialDispatchFilters(),
        page: initialDispatchListPage(),
        referencesOpen: false,
        followUpRecords: [],
    };
}

export function initialRelay(): Relay {
    return {
        timer: null,
        inFlight: false,
        lastPollAt: null,
        dispatching: false,
        handled: [],
        lastError: null,
        currentSessionId: null,
        currentSessionBusy: null,
        followUpRows: [],
        waitingFollowUps: null,
    };
}

export interface PanelState {
    ledger: PanelLedger;
    /**
     * Dispatch context derived from the first enabled binding, or `null`
     * while no binding supplies one. Since 002 FR-041 emptied the manifest
     * card, this is the **only** producer of the shape — nothing parses it
     * out of `ctx.settings` any more.
     */
    config: BindingContext | null;
    /**
     * Latest settings snapshot from the host, or `null` before the first one:
     * the card declares zero settings, so the snapshot is a "the host is
     * ready" marker rather than a configuration source.
     */
    settings: Readonly<Record<string, string>> | null;
    /**
     * How many service bindings are enabled, as the last bindings read
     * reported. `0` until a read lands; anything above zero puts the panel
     * into bindings-authoritative mode (see `bindings-mode.ts`), where the
     * legacy single-repo settings no longer gate the banner or the loop.
     */
    bindingsActive: number;
    /**
     * The ready snapshot's current project directory: recorded once at mount,
     * in memory only (002 FR-095).
     */
    hostDirectory: string | null;
    projects: ProjectPickerState;
    evidence: PanelEvidence | null;
    status: PanelStatus;
    busy: boolean;
    handoff: HandoffState;
    /** Repository bindings as the Bindings tab reads and edits them (M3). */
    bindings: BindingsTabState;
    accounts: AccountsTabState;
    /** Dispatches list, selection, and M9 notice, as its own tab slice. */
    dispatches: DispatchesState;
    /** The Status tab's projection, read state, and staleness (FR-019, FR-030). */
    statusTab: StatusTabState;
    /** The Settings tab's read state and configuration document (FR-070, FR-078). */
    settingsTab: SettingsTabState;
    /** The About tab's version read (FR-074, FR-078). */
    aboutTab: AboutTabState;
    /** Event-relay loop state (M4). */
    relay: Relay;
}

/** The event-relay loop's runtime state (M4, widened by 003 T-021). */
export interface Relay {
    timer: ReturnType<typeof setInterval> | null;
    inFlight: boolean;
    lastPollAt: string | null;
    dispatching: boolean;
    /**
     * Attempts this mount has already handed to the dispatch path, keyed
     * `"<correlationId>#<attempt>"`: a duplicate-suppression convenience,
     * never a durability mechanism and never evidence that a session exists —
     * entries are only *added*, the attempt in the key means a new lease
     * arrives as a different key, and nothing clears an entry, least of all a
     * failed result report, which must never authorize a re-dispatch alone.
     */
    handled: readonly string[];
    lastError: string | null;
    /**
     * The runs a follow-up can ride, as the relay's own read last saw them —
     * `state=dispatched`, newest first, walked to the end on the relay's own
     * clock, never borrowed from the operator's paged list. Starts empty, and
     * an empty view is "nothing known", never "nothing waiting" (FR-036's
     * no-false-claim rule).
     */
    followUpRows: readonly RunRow[];
    /**
     * How many follow-ups the last relay tick found still waiting, or `null`
     * before the first tick: `null` rather than `0` on purpose — a fresh mount
     * has not read anything, and reporting a zero it never measured is the
     * claim FR-036's amended clause forbids.
     */
    waitingFollowUps: number | null;
    /**
     * The session the host is showing right now, or `null` when none is open:
     * tracked from `host.onSession`, which replays the latest value to a late
     * subscriber, so follow-up delivery can answer "already current?" from a
     * fact the panel already holds instead of a host call (002 FR-104).
     */
    currentSessionId: string | null;
    /** `null` when no observation has landed: **idle is observed, never assumed** — delivery waits on the unknown. */
    currentSessionBusy: boolean | null;
}

export interface PanelRuntime {
    readonly host: PanelHost;
    readonly panelWindow: Pick<Window, 'addEventListener' | 'removeEventListener'>;
    readonly state: PanelState;
    readonly unsubscribes: (() => void)[];
    /**
     * The element the shell mounted into, recorded by `mountPanelApp` before
     * it mounts anything else and left for the async failure renderer to
     * prepend above the tab strip (005 FR-141).
     */
    root: HTMLElement | null;
    ui: PanelUi | null;
    handoffView: HandoffView | null;
    /**
     * The six-tab shell the panel root owns.
     *
     * `null` before `mountTabShell` runs and after teardown, so a headless
     * runtime (orchestration tests) never has to know about tabs.
     */
    shell: TabShell | null;
    bindingsUi: BindingsPane | null;
    accountsUi: AccountsBody | null;
    dispatchesUi: DispatchesBoard | null;
    statusUi: StatusTabUi | null;
    settingsUi: SettingsTabUi | null;
    aboutUi: AboutTabUi | null;
    disposed: boolean;
    started: boolean;
    /**
     * Which tab is showing — the shell's single activation field.
     *
     * Deliberately *not* persisted: the operator opens this panel because
     * something happened, so a reopen always starts on Status.
     */
    activeTab: TabId;
    tabMounted: Set<TabId>;
    tabLastRead: Map<TabId, string | null>;
    pagehideListener: (() => void) | null;
    /**
     * The Status tab's refresh tick: its timer handle, or `null` while nothing
     * is armed (005 FR-100). Written **only** by `status-tab.ts`'s arm/stop
     * helpers, which set and clear it with `statusRefreshMs` — two slots for
     * one fact, because a period with no handle behind it is a period the tab
     * would claim to be running on and is not (NFR-112, 005 FR-101).
     */
    statusRefreshTimer: ReturnType<typeof setInterval> | null;
    /**
     * The period that tick runs on — the effective `polling.intervalMs` the
     * last landed status document carried — or `null` while nothing is armed.
     */
    statusRefreshMs: number | null;
    relayArmed: boolean;
    /**
     * Whether mount-time reconciliation has settled for this runtime: `true`
     * before mounting begins (nothing to reconcile until the panel reads its
     * own record), `false` while `app.ts` re-reports unacknowledged attempts.
     * `startRelayPolling` refuses to arm while `false`, so "no claim before
     * reconciliation" holds whichever call site reaches the relay first.
     */
    reconcileSettled: boolean;
    relayArmPending: boolean;
    /**
     * Verification read-backs this mount started and has not seen settle: the
     * relay starts them detached so a slow read-back can never hold the claim
     * slot, and nothing on a dispatch path awaits them.
     */
    readonly pendingVerifications: Promise<void>[];
}

export type { BindingStatusRow } from './bindings-service.ts';

/** Lifecycle of the runs list the Dispatches section renders (M8). */
export type DispatchesStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'error';

/**
 * The Dispatches section's state (M8): newest-first rows straight from
 * `GET /v1/events` (capped at the endpoint's 100 — no pagination in this cut),
 * the selection the open/retry buttons act on, and the M9 agent-verification
 * notice, which lives here because the runs area is where the operator looks
 * when a dispatch's outcome matters.
 */
export interface DispatchesState {
    rows: readonly RunRow[];
    status: DispatchesStatus;
    /** Operator-facing note about the list or the last retry; redacted. */
    note: string;
    selectedRun: string | null;
    /**
     * Post-dispatch agent-verification banner (M9), or `null` before the
     * first verification. Warn-only: it never blocks or kills a session.
     */
    agentNotice: PanelStatus | null;
    /**
     * The control the operator armed for its confirm step, or `null` when
     * nothing is armed: the panel has no dialog primitive, so a destructive
     * action confirms the way Remove-account does — first click arms and
     * states what will happen, second click sends. Retry is deliberately
     * absent; it changes nothing the run's own history does not explain.
     */
    pendingAction: RunPendingAction | null;
    sessionInput: string;
    /** Single in-flight gate for the run operations; one flag, never several. */
    busy: boolean;
    /** The selected run's audit trail, read on demand (003 T-026). */
    audit: AuditViewState;
    filters: DispatchFilters;
    page: DispatchListPage;
    /** Whether the selected row's source-reference reveal is open (FR-048). */
    referencesOpen: boolean;
    /**
     * What the panel's own durable record says about the follow-ups on the
     * rows it renders (002 FR-105): the service projects a follow-up's
     * *existence* and its text, but only this record knows what *happened* to
     * each one — delivered, parked with its cause, or still waiting. Empty
     * until the first successful read of `mecha-turk:dispatches`.
     */
    followUpRecords: readonly FollowUpDeliveryRecord[];
}

export type RunPendingAction = 'requeue' | 'resolve-session' | 'resolve-no-session' | 'reoffer-follow-up';

/**
 * Build the mutable state one mount starts with — split out of
 * {@link createPanelRuntime} so the constructor reads as a list of runtime
 * slots rather than as one long literal.
 */
function initialState(createdAt: string): PanelState {
    return {
        ledger: createLedger({
            correlationId: newCorrelationId(),
            panelGeneration: 1,
            storagePresentBeforeMount: false,
            createdAt,
        }),
        config: null,
        settings: null,
        bindingsActive: 0,
        hostDirectory: null,
        projects: initialProjectPicker(),
        evidence: null,
        status: { tone: 'info', title: 'Mecha Turk', body: 'Waiting for the host.' },
        busy: false,
        handoff: initialHandoffState(),
        bindings: initialBindings(),
        accounts: initialAccounts(),
        dispatches: initialDispatches(),
        statusTab: initialStatusTab(),
        settingsTab: initialSettingsTab(),
        aboutTab: initialAboutTab(),
        relay: initialRelay(),
    };
}

/**
 * Create the runtime with a fresh, unmounted state.
 */
export function createPanelRuntime(
    host: PanelHost,
    panelWindow: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): PanelRuntime {
    const createdAt = nowIso();

    return {
        host,
        panelWindow,
        state: initialState(createdAt),
        unsubscribes: [],
        root: null,
        ui: null,
        handoffView: null,
        shell: null,
        bindingsUi: null,
        accountsUi: null,
        dispatchesUi: null,
        statusUi: null,
        settingsUi: null,
        aboutUi: null,
        disposed: false,
        started: false,
        activeTab: STATUS_TAB,
        tabMounted: new Set<TabId>(),
        tabLastRead: new Map<TabId, string | null>(),
        pagehideListener: null,
        statusRefreshTimer: null,
        statusRefreshMs: null,
        relayArmed: false,
        reconcileSettled: true,
        relayArmPending: false,
        pendingVerifications: [],
    };
}

export function setStatus(rt: PanelRuntime, next: PanelStatus): void {
    rt.state.status = next;
}
