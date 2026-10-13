/**
 * The cycle's configuration read (006 FR-055, FR-057–FR-059; 004 FR-088).
 */

import { DEFAULT_CONFIG, CONFIG_FILE, configFromStore, parseStoredConfig } from '../config.ts';
import { recordConfigPromptChanges, runConfigPromptChain } from '../config-prompt-observe.ts';
import type { ServiceConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';

/** Return the caught value's error name alone; never one word of the cause (SEC-11). */
export function describeKind(cause: unknown): string {
    return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * Read the effective interval for the next cycle.
 */
export async function currentIntervalMs(store: ServiceStore | null, log: ServiceLogger): Promise<number> {
    if (store === null) {
        return DEFAULT_CONFIG.intervalMs;
    }

    try {
        const { config } = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);

        return config.intervalMs;
    } catch (cause) {
        log.warn('poll interval read failed', { errorKind: describeKind(cause) });

        return DEFAULT_CONFIG.intervalMs;
    }
}

/**
 * Read the configuration this cycle runs on — **once**, at the boundary —
 * and observe the global tier while holding it. Read and observation run as
 * one task on the configuration prompt chain (research R-3: the same cadence
 * the bindings observer gets), so the snapshot the lane diffs is the
 * snapshot the cycle runs on and FR-088's *exactly one audit row per change*
 * holds for both orders rather than the lucky one. A read that throws
 * degrades to the documented defaults with one warn line, so one unreadable
 * document stops no cycle and no binding (invariant 8).
 */
export async function readCycleConfig(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<ServiceConfig> {
    try {
        return await runConfigPromptChain(input.store, async () => {
            const { config } = configFromStore(
                await input.store.readJson(CONFIG_FILE, parseStoredConfig),
                input.log,
            );
            // Actor `service`: no panel asked for this change, so the row
            // names whoever the service could actually attribute it to — a
            // hand edit of `config.json`.
            await recordConfigPromptChanges({
                store: input.store,
                log: input.log,
                config,
                actor: 'service',
            });

            return config;
        });
    } catch (cause) {
        input.log.warn('cycle configuration read failed', { errorKind: describeKind(cause) });

        return DEFAULT_CONFIG;
    }
}
