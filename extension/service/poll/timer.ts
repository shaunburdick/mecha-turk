/**
 * The interval timer that drives the M1 poll loop (re-cut 2026-09-27).
 *
 * An immediate first cycle, then self-rescheduling timers that re-read the
 * configured interval each cycle, so `PUT /v1/config` retunes the loop
 * without a restart. The timer is unref'd, so it never keeps an idle process
 * alive, and the shutdown path cancels it through {@link PollLoop.stop}. A
 * cycle still running when the next timer fires is skipped, not overlapped.
 */

import { currentIntervalMs, describeKind, runScanCycle } from './loop.ts';
import { createGitHubIssuePoller } from './poller-github.ts';
import type { GitHubIssuePoller } from './poller-github.ts';
import type { PollLoop, ScanDeps } from './loop.ts';

export type { PollLoop };

/**
 * Start the interval loop: an immediate first cycle, then self-rescheduling
 * timers that re-read the configured interval each cycle.
 *
 * The timer is unref'd, so it never keeps an idle process alive, and the
 * shutdown path cancels it through {@link PollLoop.stop}. A cycle still
 * running when the next timer fires is skipped rather than overlapped.
 *
 * @param deps - Store, logger, and poller.
 * @returns A handle that stops the loop.
 */
export function startPollLoop(deps: ScanDeps): PollLoop {
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;
    let inFlight = false;

    const cycle = async (): Promise<void> => {
        if (stopped || inFlight) {
            return;
        }

        inFlight = true;
        try {
            await runScanCycle(deps);
        } catch (cause) {
            deps.log.warn('poll cycle failed', { errorKind: describeKind(cause) });
        } finally {
            inFlight = false;
        }

        await currentIntervalMs(deps.store, deps.log).then((interval) => {
            if (stopped) {
                return null;
            }

            timer = setTimeout(() => {
                timer = null;
                void cycle();
            }, interval);
            timer.unref();

            return interval;
        });
    };

    void cycle();

    return {
        stop: (): void => {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };
}

export function createDefaultPoller(): GitHubIssuePoller {
    return createGitHubIssuePoller();
}
