/**
 * Shared mutable state for the spike panel.
 *
 * One runtime object carries everything the panel's actions and rendering need:
 * the documented host client, the frame window, the ledger, and the small
 * lifecycle flags that keep a single poll loop and a single dispatch honest.
 */

import type { BannerTone } from '@openchamber/sdk/ui';
import type { SpikeConfig } from './config.ts';
import type { SpikeEvidence } from './evidence.ts';
import type { AuditViewState } from './audit-view.ts';
import { initialAuditHistory } from './audit-view.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { createLedger } from './ledger.ts';
import { initialHandoffState } from './handoff.ts';
import type { SpikeLedger } from './ledger.ts';
import type { HandoffState } from './handoff.ts';
import type { HandoffView } from './accounts-ui.ts';
import type { BindingsPane } from './bindings-ui.ts';
import type { AccountsBody } from './accounts-tab.ts';
import { initialAccounts } from './accounts-state.ts';
import type { AccountsTabState } from './accounts-state.ts';
import { initialProjectPicker } from './project-picker.ts';
import type { ProjectPickerState } from './project-picker.ts';

export type { AccountsTabState } from './accounts-state.ts';
export { initialProjectPicker, type ProjectPickerState };
import type { DispatchesBoard } from './dispatches-ui.ts';
import type { StatusTabUi } from './status-tab.ts';
import { initialStatusTab } from './status-document.ts';
import type { StatusTabState } from './status-document.ts';
import { initialSettingsTab } from './settings-tab.ts';
import type { SettingsTabState, SettingsTabUi } from './settings-tab.ts';
import { initialAboutTab } from './about-tab.ts';
import type { AboutTabState, AboutTabUi } from './about-tab.ts';
import type { TabShell } from './tabs.ts';
import type { PanelUi, ProjectPickerUi } from './panel-ui.ts';

export type { PanelUi, ProjectPickerUi } from './panel-ui.ts';
import type { PanelAccount, PanelBinding, BindingStatusRow } from './bindings-service.ts';
import type { RunRow } from './dispatches-service.ts';
import type { SpikeHost } from './session.ts';
import { initialDispatchFilters, initialDispatchListPage } from './dispatch-page.ts';
import type { DispatchFilters, DispatchListPage } from './dispatch-page.ts';

/**
 * The six top-level surfaces, in strip order (005 FR-010).
 *
 * A closed union: the shell constructs every value that reaches it, so an
 * unknown id can never arrive and there is no passthrough branch.
 */
export type TabId = 'status' | 'dispatches' | 'bindings' | 'accounts' | 'settings' | 'about';

/** Every {@link TabId}, in strip order — the strip's declaration (FR-010). */
export const TAB_IDS: readonly TabId[] = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'];

/** Banner content shown at the top of the panel. */
export interface PanelStatus {
    /** Banner tone. */
    readonly tone: BannerTone;
    /** One-line headline. */
    readonly title: string;
    /** Supporting detail; never contains secret material. */
    readonly body: string;
}

/**
 * Build the empty Dispatches-section state (M8).
 *
 * @returns The state before the first read.
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
    };
}

/**
 * Build the empty Bindings tab state.
 *
 * @returns The state before the first load.
 */
export function initialBindings(): BindingsTabState {
    return {
        bindings: [],
        accounts: [],
        status: 'idle',
        note: '',
        repoInput: '',
        accountSelection: null,
        repoProjectSelection: null,
        triggerAssignment: true,
        triggerMention: false,
        triggerReviewRequest: true,
        worktreeSelection: 'none',
        selectedBinding: null,
        statusRows: [],
        editorOpen: false,
        editing: false,
        startingPromptInput: '',
        startingPromptDirty: false,
        startingPromptError: null,
    };
}

/**
 * Build the empty relay state.
 *
 * @returns The state before the loop starts.
 */
export function initialRelay(): Relay {
    return {
        timer: null,
        inFlight: false,
        lastPollAt: null,
        dispatching: false,
        handled: [],
        lastError: null,
    };
}

/** Mutable panel state. */
export interface PanelState {
    /** Ledger being built for this mount. */
    ledger: SpikeLedger;
    /**
     * Dispatch context derived from the first enabled binding, or `null`
     * while no binding supplies one. Since 002 FR-041 emptied the manifest
     * card, this is the **only** producer of the shape — nothing parses it
     * out of `ctx.settings` any more.
     */
    config: SpikeConfig | null;
    /**
     * Latest settings snapshot from the host, or `null` before the first one.
     *
     * The card declares zero settings, so the snapshot is a "the host is
     * ready" marker rather than a configuration source; prerequisites reads
     * it for exactly that (005 FR-037).
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
     * Project id chosen by the panel picker, restored from extension storage.
     *
     * `null` means "no panel selection": no project is configured, and the
     * panel says so rather than inventing one (002 FR-004, FR-041).
     */
    projectSelection: string | null;
    /** Project list backing the picker. */
    projects: ProjectPickerState;
    /** Evidence record for the current match. */
    evidence: SpikeEvidence | null;
    /** Banner content. */
    status: PanelStatus;
    /** Whether an action is running; blocks concurrent dispatches. */
    busy: boolean;
    /** One-shot handoff state: storage pre-flight and outcome. */
    handoff: HandoffState;
    /** Repository bindings as the Bindings tab reads and edits them (M3). */
    bindings: BindingsTabState;
    /** Which row the Accounts tab has open, armed, or drafting (FR-060). */
    accounts: AccountsTabState;
    /** Dispatches list, selection, and M9 notice, as its own tab slice (FR-012). */
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

/** Lifecycle of the Bindings tab's data. */
export type BindingsStatus =
    /** Nothing fetched yet. */
    | 'idle'
    /** A GET /v1/bindings or /v1/accounts is in flight. */
    | 'loading'
    /** Both sources answered. */
    | 'ready'
    /** The host or service refused. */
    | 'error';

/** The event-relay loop's runtime state (M4, widened by 003 T-021). */
export interface Relay {
    /** Timer handle while the loop runs. */
    timer: ReturnType<typeof setInterval> | null;
    /** Whether a relay request is in flight. */
    inFlight: boolean;
    /** RFC 3339 stamp of the last completed poll. */
    lastPollAt: string | null;
    /** Whether a dispatch is being processed right now. */
    dispatching: boolean;
    /**
     * Attempts this mount has already handed to the dispatch path (FR-034),
     * keyed `"<correlationId>#<attempt>"`.
     *
     * A duplicate-suppression convenience, never a durability mechanism and
     * never evidence that a session exists: an entry is only ever *added*, and
     * because the key carries the attempt, the service handing the same run
     * back under a new lease and a new attempt arrives as a different key.
     * Nothing clears an entry — least of all a failed result report, which must
     * never on its own authorize a re-dispatch.
     */
    handled: readonly string[];
    /** Last relay error line, else empty. */
    lastError: string | null;
}

/** The Bindings tab's working state (M3). */
export interface BindingsTabState {
    /** Bindings as GET /v1/bindings answered. */
    bindings: readonly PanelBinding[];
    /** Accounts offered to the binding form. */
    accounts: readonly PanelAccount[];
    /** Where the data stands. */
    status: BindingsStatus;
    /** Operator-facing note; never credential material. */
    note: string;
    /** Draft repository input (`owner/name`). */
    repoInput: string;
    /** Draft account selection (numeric id). */
    accountSelection: string | null;
    /** Draft project selection (id the picker confirmed from the host list). */
    repoProjectSelection: string | null;
    /** Draft assignment trigger. */
    triggerAssignment: boolean;
    /** Draft mention trigger (M6 comment and issue-body scan). */
    triggerMention: boolean;
    /** Draft review-request trigger (M7), on by default for a new binding. */
    triggerReviewRequest: boolean;
    /** Draft worktree option. */
    worktreeSelection: 'none' | 'generated';
    /** The row the operator last clicked, for the enable/disable toggle. */
    selectedBinding: string | null;
    /** Last relay status rows rendered per binding. */
    statusRows: readonly BindingStatusRow[];
    /**
     * Whether the binding editor block is on screen at all (2026-10-01 review).
     *
     * The editor is **not open by default**: the tab entry shows the list, a
     * row click loads that row into the editor and opens it, and **New
     * binding** opens an empty one. `false` at mount, and false again after a
     * save, a cancel, or a refusal to load — the list is the surface the
     * operator returns to.
     */
    editorOpen: boolean;
    /**
     * Whether the form is loaded with `selectedBinding` and its primary
     * control **saves** that row instead of adding one (005 FR-050).
     *
     * Set by the row click that loads a binding into the editor (the Edit
     * affordance the post-install review added, now the row itself) and
     * cleared by a save, a cancel, or a refusal to load — so the draft on
     * screen always describes the row the primary control would write, which
     * is what keeps a displayed value and a saved value the same thing.
     */
    editing: boolean;
    /** The starting-prompt editor field's current text (005 FR-051). */
    startingPromptInput: string;
    /**
     * Whether the operator changed that field on this selection (004 FR-014).
     *
     * Untouched means a save **omits** `startingPrompt` entirely, so the
     * service keeps whatever it holds; a change — clearing the field included —
     * means the save carries the value explicitly.
     */
    startingPromptDirty: boolean;
    /** The service's field-level refusal for the prompt, or `null` (FR-052). */
    startingPromptError: string | null;
}

/** Everything the panel's functions share. */
export interface PanelRuntime {
    /** Documented host client. */
    readonly host: SpikeHost;
    /** Frame window, used for the unload hook. */
    readonly panelWindow: Pick<Window, 'addEventListener' | 'removeEventListener'>;
    /** Mutable panel state. */
    readonly state: PanelState;
    /** Host subscription disposers collected during wiring. */
    readonly unsubscribes: (() => void)[];
    /** UI handles once mounted. */
    ui: PanelUi | null;
    /** Mounted handoff group, when this surface shows one. */
    handoffView: HandoffView | null;
    /**
     * The six-tab shell the panel root owns (005 FR-010).
     *
     * `null` before `mountTabShell` runs and after teardown, so a headless
     * runtime (orchestration tests) never has to know about tabs.
     */
    shell: TabShell | null;
    /** Bindings body's mounted view, `null` until that tab first activates. */
    bindingsUi: BindingsPane | null;
    /** Accounts body's mounted view, `null` until that tab first activates. */
    accountsUi: AccountsBody | null;
    /** Dispatches body's mounted board, `null` until that tab first activates. */
    dispatchesUi: DispatchesBoard | null;
    /** Status body's mounted view, `null` until that tab first activates. */
    statusUi: StatusTabUi | null;
    /** Settings body's mounted view, `null` until that tab first activates. */
    settingsUi: SettingsTabUi | null;
    /** Project picker handles, which live inside the Bindings body. */
    pickerUi: ProjectPickerUi | null;
    /** About body's diagnostics list, `null` until that tab first activates. */
    aboutUi: AboutTabUi | null;
    /** `true` once the panel has been torn down. */
    disposed: boolean;
    /** `true` once the first `onReady` snapshot has been handled. */
    started: boolean;
    /**
     * Which tab is showing — the shell's single activation field (FR-012).
     *
     * Deliberately *not* persisted: the operator opens this panel because
     * something happened, so a reopen always starts on Status (FR-015).
     */
    activeTab: TabId;
    /** Tabs whose bodies have mounted; each mounts once, on first activation. */
    tabMounted: Set<TabId>;
    /** When each tab last landed a read; `null` until one does (FR-014). */
    tabLastRead: Map<TabId, string | null>;
    /** Registered unload listener, so teardown can remove exactly what it added. */
    pagehideListener: (() => void) | null;
    /** Whether the event relay loop is armed on this runtime. */
    relayArmed: boolean;
    /**
     * Whether mount-time reconciliation has settled for this runtime (FR-025).
     *
     * `true` for a runtime that has not begun mounting — there is nothing to
     * reconcile until the panel has read its own record — and `false` for the
     * whole window in which `app.ts` is re-reporting unacknowledged attempts.
     * `startRelayPolling` refuses to arm while it is `false`, so "no claim
     * before reconciliation" holds no matter which call site reaches the relay
     * first.
     */
    reconcileSettled: boolean;
    /** Relay arming requested while reconciliation was still running. */
    relayArmPending: boolean;
    /**
     * Verification read-backs this mount started and has not seen settle.
     *
     * The relay starts them detached so a slow read-back can never hold the
     * claim slot (AC-125); nothing on a dispatch path awaits them, and a test
     * drains the list to observe what a verification wrote without racing it.
     */
    readonly pendingVerifications: Promise<void>[];
}

/** Per-binding event counts from the last relay poll. */
export type { BindingStatusRow } from './bindings-service.ts';

/** Lifecycle of the runs list the Dispatches section renders (M8). */
export type DispatchesStatus =
    /** Nothing fetched yet. */
    | 'idle'
    /** A `GET /v1/events` is in flight. */
    | 'loading'
    /** The service answered a list the panel could read. */
    | 'ready'
    /** The service refused, was unreachable, or answered something unreadable. */
    | 'error';

/**
 * The Dispatches section's state (M8).
 *
 * Newest-first rows straight from `GET /v1/events` (capped at the 100 the
 * endpoint returns — no pagination in this cut), plus the selection the
 * open/retry buttons act on and the M9 agent-verification notice, which
 * lives here because the runs area is where the operator looks when a
 * dispatch's outcome matters.
 */
export interface DispatchesState {
    /** Rows as the last successful read reported them (newest first). */
    rows: readonly RunRow[];
    /** Where the list read stands. */
    status: DispatchesStatus;
    /** Operator-facing note about the list or the last retry; redacted. */
    note: string;
    /** The row the operator last clicked, for the open/retry buttons. */
    selectedRun: string | null;
    /**
     * Post-dispatch agent-verification banner (M9), or `null` before the
     * first verification. Warn-only: it never blocks or kills a session.
     */
    agentNotice: PanelStatus | null;
    /**
     * The control the operator armed for its confirm step (003 T-025), or
     * `null` when nothing is armed.
     *
     * The panel has no dialog primitive, so a destructive or state-changing
     * action confirms the way the Remove-account control already does: first
     * click arms and states what will happen, second click sends. Retry is
     * deliberately absent from this list — it changes nothing the run's own
     * history does not already explain, and the service answers it either way.
     */
    pendingAction: RunPendingAction | null;
    /** Session id typed for the "a session was created" resolution (FR-027). */
    sessionInput: string;
    /** Single in-flight gate for the run operations; one flag, never several. */
    busy: boolean;
    /** The selected run's audit trail, read on demand (003 T-026). */
    audit: AuditViewState;
    /** Server-side filters the list applies; both off means the whole set (FR-043). */
    filters: DispatchFilters;
    /** Paging position inside the set the filters describe (FR-042). */
    page: DispatchListPage;
    /** Whether the selected row's source-reference reveal is open (FR-048). */
    referencesOpen: boolean;
}

/** The run controls that ask for a confirmation step before they act (T-025). */
export type RunPendingAction = 'requeue' | 'resolve-session' | 'resolve-no-session';

/**
 * Build the mutable state one mount starts with.
 *
 * Split out of {@link createPanelRuntime} so the constructor reads as a list of
 * runtime slots rather than as one long literal: the state is what every other
 * module shares, and it deserves to be readable in one pass.
 *
 * @param createdAt - RFC 3339 stamp pinned at construction.
 * @returns The state object the runtime carries.
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
        projectSelection: null,
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
 *
 * @param host - Documented host client.
 * @param panelWindow - Frame window for the unload hook.
 * @returns The shared panel runtime.
 */
export function createPanelRuntime(
    host: SpikeHost,
    panelWindow: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): PanelRuntime {
    const createdAt = nowIso();

    return {
        host,
        panelWindow,
        state: initialState(createdAt),
        unsubscribes: [],
        ui: null,
        handoffView: null,
        shell: null,
        bindingsUi: null,
        accountsUi: null,
        dispatchesUi: null,
        statusUi: null,
        settingsUi: null,
        pickerUi: null,
        aboutUi: null,
        disposed: false,
        started: false,
        activeTab: 'status',
        tabMounted: new Set<TabId>(),
        tabLastRead: new Map<TabId, string | null>(),
        pagehideListener: null,
        relayArmed: false,
        reconcileSettled: true,
        relayArmPending: false,
        pendingVerifications: [],
    };
}

/**
 * Replace the banner content.
 *
 * @param rt - Panel runtime.
 * @param next - Status to show.
 */
export function setStatus(rt: PanelRuntime, next: PanelStatus): void {
    rt.state.status = next;
}
