/**
 * The two retention passes, wired at the two boundaries they run at (006
 * FR-055, FR-057, FR-036, FR-047).
 *
 * Both passes are configuration consumers with the same `next-cycle` story, so
 * both run (a) **once when the store opens** — before the listener accepts, so
 * a stopped service's first start applies the limits it was saved under — and
 * (b) **at every poll-cycle boundary**, from the configuration the cycle
 * already read once (006 T-007's single read). This module is the only place
 * that knows about both boundaries, which is what keeps `server.ts` and
 * `loop.ts` to a single call apiece and keeps the near-gate modules from
 * growing a second copy of the wiring.
 *
 * Two rules this wiring exists to hold:
 *
 * - **A configuration write runs no trim** (FR-047): nothing here is reachable
 *   from the route, so a save changes the limit and the *next* boundary
 *   applies it. A `PUT` that lowers a retention knob therefore writes no trim
 *   row of its own.
 * - **A boundary never fails and never skips silently**: each pass is guarded
 *   independently (one failure still runs the other), and an unreadable
 *   configuration degrades to the documented defaults with a warn line rather
 *   than to a pass that quietly did nothing (invariant 8).
 */

import { CONFIG_FILE, DEFAULT_CONFIG, configFromStore, parseStoredConfig } from './config.ts';
import { trimAudit } from './audit-trim.ts';
import { trimExcerpts } from './poll/excerpt-trim.ts';
import type { ServiceConfig } from './config.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/** What both passes read: the store, the logger, and the effective config. */
export interface RetentionInput {
    /** Open store; the caller has already ruled out the unusable case. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /**
     * The configuration this boundary runs on — the caller's **single** read
     * (006 FR-055/FR-057's "one read, once per cycle"; the cycle-boundary call
     * must not add a second read of its own).
     */
    readonly config: ServiceConfig;
    /**
     * Service clock in epoch milliseconds; `Date.now()` when omitted.
     *
     * Passed through so a test can age fixtures against a fixed instant.
     */
    readonly now?: number;
}

/**
 * Run one pass without letting its failure stop the boundary.
 */
async function runGuarded(input: {
    /** Message the failure is reported under; never carries upstream text. */
    readonly message: string;
    /** The pass to run. */
    readonly pass: () => Promise<unknown>;
    /** Structured logger. */
    readonly log: ServiceLogger;
}): Promise<void> {
    try {
        await input.pass();
    } catch (cause) {
        input.log.warn(input.message, { errorKind: cause instanceof Error ? cause.name : typeof cause });
    }
}

/**
 * Run both retention passes for one boundary, oldest limit first.
 *
 * @returns Resolves when both passes have settled; never rejects.
 */
export async function runRetentionPasses(input: RetentionInput): Promise<void> {
    await runGuarded({
        message: 'audit retention pass failed',
        log: input.log,
        pass: () => trimAudit(input),
    });
    await runGuarded({
        message: 'excerpt retention pass failed',
        log: input.log,
        pass: () => trimExcerpts(input),
    });
}

/**
 * Read the configuration one open-boundary pass runs on.
 *
 * Same posture as the rest of the boot reads: an unreadable document degrades
 * to the documented defaults with one warn line, so a bad `config.json` costs
 * the operator one pass at default limits rather than a service that never
 * trims at all (invariant 8).
 *
 * @param log - Logger used when the document cannot be read.
 * @returns The effective configuration for this boundary.
 */
async function readOpenConfig(store: ServiceStore, log: ServiceLogger): Promise<ServiceConfig> {
    try {
        const { config } = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);

        return config;
    } catch (cause) {
        log.warn('retention configuration read failed', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return DEFAULT_CONFIG;
    }
}

/**
 * Run both passes once, at store open, before the listener accepts (FR-055(a),
 * FR-057's "once at service start").
 *
 * @returns Resolves when both passes have settled; never rejects.
 */
export async function runRetentionAtOpen(input: {
    /** Open store, or `null` when the data directory is unusable. */
    readonly store: ServiceStore | null;
    /** Structured logger. */
    readonly log: ServiceLogger;
}): Promise<void> {
    if (input.store === null) {
        return;
    }

    const config = await readOpenConfig(input.store, input.log);
    await runRetentionPasses({ store: input.store, log: input.log, config });
}
