/**
 * Shared mutable state for the spike panel.
 *
 * One runtime object carries everything the panel's actions and rendering need:
 * the documented host client, the frame window, the ledger, and the small
 * lifecycle flags that keep a single poll loop and a single dispatch honest.
 */

import type { BannerTone, ButtonHandle, ListHandle, SelectHandle, TextHandle, BannerHandle } from '@openchamber/sdk/ui';
import type { SpikeConfig } from './config.ts';
import type { SpikeEvidence } from './evidence.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import type { GitHubIssue } from './github.ts';
import { createLedger } from './ledger.ts';
import type { LifecyclePhase, SpikeLedger } from './ledger.ts';
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

/** Mutable panel state. */
export interface PanelState {
    /** Ledger being built for this mount. */
    ledger: SpikeLedger;
    /** Validated operator settings, or `null` until they parse. */
    config: SpikeConfig | null;
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
}

/** UI handles, assigned once when the panel mounts. */
export interface PanelUi {
    /** Status banner. */
    banner: BannerHandle;
    /** Context summary line. */
    summary: TextHandle;
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
            login: null,
            match: null,
            evidence: null,
            status: { tone: 'info', title: 'Mecha Turk Spike', body: 'Waiting for the host.' },
            connected: false,
            busy: false,
        },
        unsubscribes: [],
        ui: null,
        disposed: false,
        started: false,
        pollTimer: null,
        pollInFlight: false,
        pendingPhase: 'paused',
        pagehideListener: null,
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
