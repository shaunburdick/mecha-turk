/**
 * The cycle's **configuration** read (006 FR-055, FR-057–FR-059; 004 FR-088).
 *
 * Split out of [`loop.ts`](./loop.ts) when the global prompt tier's observer
 * joined this read: the loop owns cycle orchestration — walk, scan, save — and
 * this module owns *what the cycle runs on*, which as of 004 is two things
 * held together in one chain task: **the** configuration read at the boundary
 * (one read per cycle, every consumer on the same document) and the
 * observation of `startingPrompt` that has to happen with that same snapshot
 * in hand (research R-3: the cadence the bindings observer gets). The interval
 * reader the timer arms itself with lives here too, because it is the same
 * document read at a different moment — one reader, two moments, one set of
 * degradation rules:
 *
 * - a read that throws degrades to the documented defaults with one warn
 *   line, so one unreadable document stops no cycle and no binding
 *   (invariant 8);
 * - an audit problem inside the same task never becomes that exception: an
 *   unreadable trail skips the observation with its own warn, and an append
 *   that cannot reach disk is reported by the row writer.
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
 *
 * @param store - Open store, or `null` when unusable.
 * @param log - Logger used when the config file cannot be read.
 * @returns Milliseconds until the next cycle.
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
 * Read the configuration this cycle runs on — **once**, at the boundary
 * — and observe the global tier while holding it.
 *
 * The read and the observation run as **one task on the configuration prompt
 * chain** (research R-3: the same cadence the bindings observer gets), so the
 * snapshot the lane diffs is the snapshot this cycle runs on. A
 * `PUT /v1/config` landing mid-read therefore cannot leave the lane comparing
 * one document against another's baseline, which is what keeps FR-088's
 * *exactly one audit row per change* true for both orders rather than for the
 * lucky one.
 *
 * A read that throws degrades to the documented defaults with one warn line,
 * exactly as {@link currentIntervalMs} already does, so one unreadable
 * document stops no cycle and no binding (invariant 8).
 *
 * @param input - Store and logger for this cycle.
 * @returns The effective configuration for the whole cycle.
 */
export async function readCycleConfig(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
