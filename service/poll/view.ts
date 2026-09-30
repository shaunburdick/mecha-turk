/**
 * A read-only view of the live poll scheduler for `GET /v1/status` (005 FR-031,
 * [contracts/status-projection.md](../../specs/005-panel-ia/contracts/status-projection.md) §1).
 *
 * The status document used to carry `paused: true`, `nextPollAt: null`, and
 * `pausedReason: 'config-incomplete'` as **literals**, describing a process
 * that was running all along. The fix is to report the scheduler's own state,
 * so this module is deliberately thin: it holds the handle the loop published
 * and answers three questions about it — is it running, when is its next cycle
 * armed, and is it shutting down. It never starts, stops, or reschedules
 * anything, and the route keeps no second implementation of the schedule.
 *
 * The one value the view cannot read directly is the next-poll stamp during the
 * loop's very first cycle: the timer is armed only *after* that cycle finishes,
 * so {@link nextPollAtOf} falls back to `now + intervalMs` while the loop is
 * running with no timer armed yet. That stamp is never later than the real one,
 * and a stamp in the past is a valid answer the panel renders as *overdue*
 * (contract §1) rather than one it may silently replace.
 */

import type { PollLoop } from './loop.ts';

/** The closed paused-reason vocabulary (005 FR-031; contract §1). */
export const PAUSED_REASONS = ['config-incomplete', 'no-active-bindings', 'store-unavailable', 'stopping'] as const;

/** One of the four codes the service may emit while polling is paused. */
export type PausedReason = (typeof PAUSED_REASONS)[number];

/**
 * Whether a string is a member of the closed vocabulary.
 *
 * @param value - The candidate reason.
 * @returns `true` when the service itself would emit it.
 */
export function isPausedReason(value: string): value is PausedReason {
    return (PAUSED_REASONS as readonly string[]).includes(value);
}

/** What a route reads from the scheduler; every method is a pure read. */
export interface PollingView {
    /**
     * Whether the poll loop is running right now.
     *
     * `false` before a loop is observed, after `stop()`, and once shutdown has
     * begun — the three moments where "is polling happening" is honestly no.
     */
    isRunning(): boolean;
    /** Epoch milliseconds of the armed cycle, or `null` when none is armed. */
    nextPollAtMs(): number | null;
    /** Whether the service has begun shutting the scheduler down. */
    isStopping(): boolean;
}

/** The view plus the two calls that publish what it describes. */
export interface PollingViewSlot {
    /** The read-only view routes hold; identity is stable for the lifetime. */
    readonly view: PollingView;
    /**
     * Publish the loop `startPollLoop` returned, or `null` when there was no
     * store to poll with. Called once, before any request can be served.
     */
    observe(loop: PollLoop | null): void;
    /** Record that shutdown has begun, so the reason reads `stopping`. */
    beginShutdown(): void;
}

/**
 * Create the empty view; the service observes its loop into it at start.
 *
 * @returns The slot carrying the stable read-only view.
 */
export function createPollingView(): PollingViewSlot {
    let loop: PollLoop | null = null;
    let stopping = false;

    const running = (): boolean => !stopping && loop !== null && !loop.state().stopped;

    const view: PollingView = {
        isRunning: (): boolean => running(),
        nextPollAtMs: (): number | null => (running() ? loop?.state().nextPollAtMs ?? null : null),
        isStopping: (): boolean => stopping,
    };

    return {
        view,
        observe: (next: PollLoop | null): void => {
            loop = next;
        },
        beginShutdown: (): void => {
            stopping = true;
        },
    };
}

/**
 * The `nextPollAt` member of the polling block (contract §1).
 *
 * @param view - The scheduler view the route reads.
 * @param intervalMs - The effective configured interval the route already read.
 * @returns The next-poll stamp while polling runs, `null` while it does not.
 */
export function nextPollAtOf(view: PollingView, intervalMs: number): string | null {
    if (!view.isRunning()) {
        return null;
    }

    const armed = view.nextPollAtMs();

    return new Date(armed ?? Date.now() + intervalMs).toISOString();
}

/**
 * The `paused` / `pausedReason` pair, from the scheduler and the store reads
 * the status route already performs (contract §1's transition table).
 *
 * `paused` is `true` only when the loop is genuinely not running; the reason is
 * then the first failed precondition, most fundamental first. The service only
 * ever emits a member of {@link PAUSED_REASONS} or `''` — a reason outside the
 * vocabulary is the *reader's* to pass through verbatim (005 FR-003), and this
 * function never maps an unknown code to a friendly guess because it never
 * receives one.
 *
 * @param input - Store usability, scheduler state, and the active-binding count.
 * @returns `''` while polling runs, else the closed-vocabulary reason.
 */
export function pausedReasonOf(input: {
    /** Whether the data directory can serve reads right now. */
    readonly storeUsable: boolean;
    /** Whether the scheduler is running (from the view). */
    readonly running: boolean;
    /** Whether shutdown has begun. */
    readonly stopping: boolean;
    /** How many stored bindings are `active`. */
    readonly activeBindings: number;
}): string {
    if (!input.storeUsable) {
        return 'store-unavailable';
    }

    if (input.stopping) {
        return 'stopping';
    }

    if (input.running) {
        return '';
    }

    // The loop is not running and the store is fine: either there is nothing
    // to poll, or the configuration it would start from is not in place.
    return input.activeBindings > 0 ? 'config-incomplete' : 'no-active-bindings';
}
