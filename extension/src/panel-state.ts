/**
 * Shared mutable state for the spike panel.
 *
 * One runtime object carries everything the panel's actions and rendering need:
 * the documented host client, the frame window, the ledger, and the small
 * lifecycle flags that keep a single poll loop and a single dispatch honest.
 */

import type {
    BannerHandle,
    BannerTone,
    ButtonHandle,
    ListHandle,
    SelectHandle,
    TextHandle,
} from '@openchamber/sdk/ui';
import type { GuestProject } from '@openchamber/sdk';
import type { SpikeConfig } from './config.ts';
import type { SpikeEvidence } from './evidence.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import type { GitHubIssue } from './github.ts';
import { createLedger } from './ledger.ts';
import { initialHandoffState } from './handoff.ts';
import type { LifecyclePhase, SpikeLedger } from './ledger.ts';
import type { HandoffState } from './handoff.ts';
import type { HandoffView } from './accounts-ui.ts';
import type { ReposPane } from './repos-ui.ts';
import type { PanelAccount, PanelBinding, BindingStatusRow } from './repos-service.ts';
import type { SpikeHost } from './session.ts';

/** Banner content shown at the top of the panel. */
export interface PanelStatus {
    /** Banner tone. */
    readonly tone: BannerTone;
    /** One-line headline. */
    readonly title: string;
    /** Supporting detail; never contains secret material. */
    readonly body: string;
}

/** Lifecycle of the project picker's project list. */
export type ProjectPickerStatus =
    /** Nothing requested yet; the picker shows its idle text. */
    | 'idle'
    /** `host.listProjects()` is in flight. */
    | 'loading'
    /** The host answered with a usable snapshot. */
    | 'ready'
    /** The host refused, failed, or reported an error snapshot. */
    | 'error';

/** Project picker state carried by the panel runtime. */
export interface ProjectPickerState {
    /** Where the last `host.listProjects()` call got to. */
    status: ProjectPickerStatus;
    /** Projects the host reported; retained across a failed refresh. */
    projects: readonly GuestProject[];
    /** Operator-facing note about the picker, already redacted. */
    note: string;
}

/**
 * Build the empty Repos tab state.
 *
 * @returns The state before the first load.
 */
export function initialRepos(): Repositories {
    return {
        activeTab: 'spike',
        bindings: [],
        accounts: [],
        status: 'idle',
        note: '',
        repoInput: '',
        accountSelection: null,
        repoProjectSelection: null,
        triggerAssignment: true,
        triggerMention: false,
        worktreeSelection: 'none',
        selectedBinding: null,
        removeAccountArmed: false,
        statusRows: [],
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
    /** Validated operator settings, or `null` until they parse. */
    config: SpikeConfig | null;
    /** Latest settings snapshot from the host, or `null` before the first one. */
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
     * `null` means "no panel selection": configuration resolution then falls
     * back to the `project-id` integration setting.
     */
    projectSelection: string | null;
    /** Project list backing the picker. */
    projects: ProjectPickerState;
    /** Login discovered from `GET /user`, or `null` before authentication. */
    login: string | null;
    /** Current single matching issue. */
    match: GitHubIssue | null;
    /** Evidence record for the current match. */
    evidence: SpikeEvidence | null;
    /** Banner content. */
    status: PanelStatus;
    /** Whether the host reports a connected integration. */
    connected: boolean;
    /** Whether an action is running; blocks concurrent dispatches. */
    busy: boolean;
    /** One-shot handoff state: consent, storage pre-flight, and outcome. */
    handoff: HandoffState;
    /** Repository bindings as the Repos tab reads and edits them (M3). */
    repos: Repositories;
    /** Event-relay loop state (M4). */
    relay: Relay;
}

/** Lifecycle of the Repos tab's data. */
export type RepositoriesStatus =
    /** Nothing fetched yet. */
    | 'idle'
    /** A GET /v1/bindings or /v1/accounts is in flight. */
    | 'loading'
    /** Both sources answered. */
    | 'ready'
    /** The host or service refused. */
    | 'error';

/** The event-relay loop's runtime state (M4). */
export interface Relay {
    /** Timer handle while the loop runs. */
    timer: ReturnType<typeof setInterval> | null;
    /** Whether a relay request is in flight. */
    inFlight: boolean;
    /** RFC 3339 stamp of the last completed poll. */
    lastPollAt: string | null;
    /** Whether a dispatch is being processed right now. */
    dispatching: boolean;
    /** Event ids the session already handled (this mount). */
    handled: readonly string[];
    /** Last relay error line, else empty. */
    lastError: string | null;
}

/** The Repos tab's working state (M3). */
export interface Repositories {
    /** Tab visibility; the Repositories pane shows when `repos`. */
    activeTab: 'spike' | 'repos';
    /** Bindings as GET /v1/bindings answered. */
    bindings: readonly PanelBinding[];
    /** Accounts offered to the binding form. */
    accounts: readonly PanelAccount[];
    /** Where the data stands. */
    status: RepositoriesStatus;
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
    /** Draft mention trigger (stored until the M6 comment scan runs). */
    triggerMention: boolean;
    /** Draft worktree option. */
    worktreeSelection: 'none' | 'generated';
    /** The row the operator last clicked, for the enable/disable toggle. */
    selectedBinding: string | null;
    /**
     * Whether the Remove-account control is in its confirm step (MVP
     * fix 2, 2026-09-27): the first click arms, the second click deletes.
     * No `confirm()` exists inside the service frame, so the button itself
     * is the confirmation.
     */
    removeAccountArmed: boolean;
    /** Last relay status rows rendered per binding. */
    statusRows: readonly BindingStatusRow[];
}

/**
 * The two tab bodies the shared strip switches between.
 *
 * The Repositories pane (mount order first, so the strip lands on top) and
 * the spike body the legacy UI and handoff group mount into; the repaint step
 * in `panel-ui.ts` hides exactly one of them from `repos.activeTab`.
 */
export interface ReposSection {
    /** The mounted Repositories pane (strip, rows, and add form). */
    readonly repos: ReposPane;
    /** Spike-tab body; hidden while the Repositories tab shows. */
    readonly spike: HTMLElement;
}

/** UI handles, assigned once when the panel mounts. */
export interface PanelUi {
    /** Status banner. */
    banner: BannerHandle;
    /** Context summary line. */
    summary: TextHandle;
    /** Project picker select. */
    projectSelect: SelectHandle;
    /** Project picker status line (loading / error / empty / note). */
    projectStatus: TextHandle;
    /** Selected project id, shown with its source. */
    projectDetail: TextHandle;
    /** Reload-projects button. */
    projectRefresh: ButtonHandle;
    /** Copy-the-selected-id button. */
    projectCopy: ButtonHandle;
    /** Poll-now button. */
    poll: ButtonHandle;
    /** Start-session button. */
    dispatch: ButtonHandle;
    /** Verify-host button. */
    verify: ButtonHandle;
    /** Lifecycle phase picker. */
    phaseSelect: SelectHandle;
    /** Record-phase button. */
    mark: ButtonHandle;
    /** Ledger list. */
    list: ListHandle;
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
    /** Mounted Repositories tab and spike body, when this surface shows them. */
    reposSection: ReposSection | null;
    /** `true` once the panel has been torn down. */
    disposed: boolean;
    /** `true` once the first `onReady` snapshot has been handled. */
    started: boolean;
    /** Handle for the running poll interval, when one exists. */
    pollTimer: ReturnType<typeof setInterval> | null;
    /** `true` while a poll request is in flight. */
    pollInFlight: boolean;
    /** Lifecycle phase the operator will mark next. */
    pendingPhase: LifecyclePhase;
    /** Registered unload listener, so teardown can remove exactly what it added. */
    pagehideListener: (() => void) | null;
    /** Whether the event relay loop is armed on this runtime. */
    relayArmed: boolean;
}

/** Per-binding event counts from the last relay poll. */
export type { BindingStatusRow } from './repos-service.ts';

/**
 * Create the empty picker state shown before the first `listProjects()` call.
 *
 * @returns The initial project picker state.
 */
export function initialProjectPicker(): ProjectPickerState {
    return { status: 'idle', projects: [], note: '' };
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
        state: {
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
            login: null,
            match: null,
            evidence: null,
            status: { tone: 'info', title: 'Mecha Turk Spike', body: 'Waiting for the host.' },
            connected: false,
            busy: false,
            handoff: initialHandoffState(),
            repos: initialRepos(),
            relay: initialRelay(),
        },
        unsubscribes: [],
        ui: null,
        handoffView: null,
        reposSection: null,
        disposed: false,
        started: false,
        pollTimer: null,
        pollInFlight: false,
        pendingPhase: 'paused',
        pagehideListener: null,
        relayArmed: false,
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
