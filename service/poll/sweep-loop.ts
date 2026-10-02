/**
 * The sweep's periodic timer (003 FR-032; T-009, T-040f).
 *
 * The recovery rules live in [`sweep.ts`](./sweep.ts); this module owns only
 * *when* a pass runs, which is a separate responsibility with a separate
 * failure mode: a cadence computed from the wrong source is not a wrong
 * recovery, it is a correct recovery that arrives too late to matter.
 *
 * Two properties follow from that split, and both were defects before it:
 *
 * - **The first tick is armed from the stored durations**, read before the
 *   timer exists. Arming from the defaults left an operator whose `leaseMs`
 *   sat at its 30,000 ms minimum without a sweep pass for the first 60,000 ms
 *   — the recovery that exists to be prompt arriving later than the lease it
 *   recovers.
 * - **The timer is unref'd**, so an idle service can still exit, and armed only
 *   while the loop is running, so a shutdown that lands mid-pass cannot bring
 *   the timer back.
 */

import { nowIso } from '../../src/ids.ts';
import { DEFAULT_CONFIG, CONFIG_FILE, configFromStore, parseStoredConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { sweepOnce } from './sweep.ts';

/** The two durations the sweep reads; also the knobs it reschedules on. */
export interface SweepDurations {
    /** Lease duration in milliseconds. */
    readonly leaseMs: number;
    /** Result deadline in milliseconds. */
    readonly resultDeadlineMs: number;
}

/** Store and logger the sweep loop reads. */
export interface SweepLoopInput {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
}

/** A running sweep, stopped on shutdown. */
export interface SweepLoop {
    /** Cancel the pending tick; a pass in flight finishes on its own. */
    stop(): void;
}

/** Mutable arming state one sweep loop owns for its lifetime. */
interface LoopState {
    /** The pending tick, or `null` when no tick is armed. */
    timer: NodeJS.Timeout | null;
    /** Whether shutdown has landed; read through {@link isHalted}. */
    stopped: boolean;
    /** Whether a pass is running right now. */
    inFlight: boolean;
}

/**
 * Read the stop flag through a function, so the compiler cannot narrow it away
 * across the `await` boundaries in the cycle.
 *
 * @param state - The loop's own state.
 * @returns `true` once shutdown has landed.
 */
function isHalted(state: LoopState): boolean {
    return state.stopped;
}

/**
 * The cadence one tick waits before the next: half the shorter of the two
 * durations, so every lease and every result deadline is examined at least
 * twice inside its own window (FR-032's "at least once per lease duration"),
 * independently of the poll interval — a 300 s poll cadence must not push the
 * lease sweep past its own bound.
 *
 * @param durations - The configured lease and result deadline.
 * @returns Milliseconds between ticks.
 */
export function sweepIntervalMs(durations: SweepDurations): number {
    return Math.floor(Math.min(durations.leaseMs, durations.resultDeadlineMs) / 2);
}

/**
 * Read the two sweep durations, answering the defaults when unreadable.
 *
 * Exported because the cadence is a property an operator reasons about: a test
 * that pins what the loop will arm is pinning the fix, not an implementation
 * detail of a timer.
 *
 * @param input - Open store and structured logger.
 * @returns The configured durations, or the documented defaults.
 */
export async function readSweepDurations(input: SweepLoopInput): Promise<SweepDurations> {
    try {
        const stored = await input.store.readJson(CONFIG_FILE, parseStoredConfig);
        const { config } = configFromStore(stored, input.log);

        return { leaseMs: config.leaseMs, resultDeadlineMs: config.resultDeadlineMs };
    } catch (cause) {
        input.log.warn('sweep cadence read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return { leaseMs: DEFAULT_CONFIG.leaseMs, resultDeadlineMs: DEFAULT_CONFIG.resultDeadlineMs };
    }
}

/**
 * Schedule the next tick on an unref'd timer.
 *
 * @param input - The loop's state and the callback its next tick runs.
 * @param durations - The cadence the next tick waits.
 */
function arm(
    input: { readonly state: LoopState; readonly cycle: () => Promise<void> },
    durations: SweepDurations,
): void {
    const { state, cycle } = input;
    if (isHalted(state)) {
        return;
    }

    state.timer = setTimeout(() => {
        state.timer = null;
        void cycle();
    }, sweepIntervalMs(durations));
    state.timer.unref();
}

/**
 * Run one pass and re-arm the tick that follows it.
 *
 * A tick still running when the next fires is skipped rather than overlapped:
 * the sweep is a chain task, and two passes would only contend for the same
 * lock. A shutdown that landed mid-pass must not re-arm.
 *
 * @param input - Store, logger, the loop's state, and its tick callback.
 */
async function runPass(input: {
    /** Open store and structured logger. */
    readonly sweep: SweepLoopInput;
    /** The loop's arming state. */
    readonly state: LoopState;
    /** The next tick's callback, so the loop can recurse. */
    readonly cycle: () => Promise<void>;
}): Promise<void> {
    const { sweep, state } = input;
    if (isHalted(state) || state.inFlight) {
        return;
    }

    state.inFlight = true;
    const durations = await readSweepDurations(sweep);
    try {
        await sweepOnce({ ...sweep, now: nowIso() });
    } catch (cause) {
        sweep.log.warn('dispatch sweep pass failed', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    } finally {
        state.inFlight = false;
    }

    arm({ state, cycle: input.cycle }, durations);
}

/**
 * Start the periodic sweep on its own unref'd timer.
 *
 * Each tick re-reads the configured durations, so `PUT /v1/config` retunes the
 * cadence without a restart, and the **first** tick is armed from the stored
 * durations rather than the defaults (T-040f).
 *
 * @param input - Store and logger.
 * @returns A handle that stops the timer.
 */
export function startSweep(input: SweepLoopInput): SweepLoop {
    const state: LoopState = { timer: null, stopped: false, inFlight: false };
    const cycle = async (): Promise<void> => await runPass({ sweep: input, state, cycle });
    const loop = { state, cycle };

    void readSweepDurations(input)
        .then((durations: SweepDurations) => arm(loop, durations))
        .catch((cause: unknown) => {
            input.log.warn('sweep cadence read failed', {
                errorKind: cause instanceof Error ? cause.name : typeof cause,
            });
            arm(loop, DEFAULT_CONFIG);
        });

    return {
        stop: (): void => {
            state.stopped = true;
            if (state.timer !== null) {
                clearTimeout(state.timer);
                state.timer = null;
            }
        },
    };
}
