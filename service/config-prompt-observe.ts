/**
 * The global-tier prompt observer (004 FR-088; 006 FR-070, FR-071; plan N7).
 */

import { AUDIT_FILE, parseAuditEntry } from './audit.ts';
import {
    CONFIG_CHANGED_EVENT,
    appendConfigApplied,
    configPromptFingerprint,
    recordedConfigPromptFingerprint,
} from './config-audit.ts';
import { isRecord } from './json.ts';
import type { AuditEntry } from './audit.ts';
import type { ConfigChangeActor } from './config-audit.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/** The configuration member an observation reads. */
export interface ObservedConfigPrompt {
    /** The global tier as the document carries it; absent reads as unset. */
    readonly startingPrompt?: string | null;
}

/** What one observation of the configuration document carries. */
export interface ConfigPromptObservation {
    readonly store: ServiceStore;
    /** Logger for the seed's warn line; the append warns through its own. */
    readonly log: ServiceLogger;
    /** The document as this read produced it. */
    readonly config: ObservedConfigPrompt;
    /** Who made the change this observation carries. */
    readonly actor: ConfigChangeActor;
}

/** Per-store observation state, created on first use. */
interface ConfigPromptObservationState {
    /** The fingerprint the last recorded change produced, or `null`. */
    baseline: string | null;
    /** Whether the baseline has been seeded from the trail for this handle. */
    seeded: boolean;
    /** The task queue every cycle read and configuration write joins. */
    chain: Promise<unknown>;
}

/** One state per store handle: a restart re-seeds, a shared handle shares. */
const observationStates = new WeakMap<ServiceStore, ConfigPromptObservationState>();

/**
 * Get (or create) the observation state for one store handle.
 */
function stateFor(store: ServiceStore): ConfigPromptObservationState {
    let state = observationStates.get(store);
    if (state === undefined) {
        state = { baseline: null, seeded: false, chain: Promise.resolve() };
        observationStates.set(store, state);
    }

    return state;
}

/** The one triple this lane seeds from: what a row says the tier became. */
interface PromptChangeTriple {
    /** The recorded `to`; read through {@link recordedConfigPromptFingerprint}. */
    readonly to: unknown;
}

/**
 * Pick the `startingPrompt` triple out of a row's `changes`, if it has one.
 *
 * A refused row carries `issueCount`/`fields` instead of `changes`, and an
 * accepted row may simply not have moved this field — both read as *no triple*
 * here, which is why a later row that changed only `intervalMs` cannot
 * displace the baseline a prompt row established.
 */
function startingPromptChangeOf(details: Readonly<Record<string, unknown>>): PromptChangeTriple | null {
    const { changes } = details;
    if (!Array.isArray(changes)) {
        return null;
    }

    for (const change of changes) {
        if (isRecord(change) && change.field === 'startingPrompt') {
            return { to: change.to };
        }
    }

    return null;
}

/**
 * Derive the baseline from the trail: the `to` of the highest-`seq`
 * `config.changed` row that carries a `startingPrompt` change.
 */
function baselineFromTrail(entries: readonly AuditEntry[]): string | null {
    let highestSeq = 0;
    let baseline: string | null = null;
    for (const entry of entries) {
        if (entry.eventType !== CONFIG_CHANGED_EVENT || entry.seq <= highestSeq) {
            continue;
        }

        const change = startingPromptChangeOf(entry.details);
        if (change === null) {
            continue;
        }

        highestSeq = entry.seq;
        baseline = recordedConfigPromptFingerprint(change.to);
    }

    return baseline;
}

/**
 * Seed the baseline from the audit trail, once per store handle.
 */
async function ensureSeeded(input: {
    /** Open store holding `audit.ndjson`. */
    readonly store: ServiceStore;
    /** The handle's state. */
    readonly state: ConfigPromptObservationState;
    /** Structured logger for the failure line. */
    readonly log: ServiceLogger;
}): Promise<boolean> {
    if (input.state.seeded) {
        return true;
    }

    try {
        const trail = await input.store.readLines(AUDIT_FILE, parseAuditEntry);
        input.state.baseline = baselineFromTrail(trail.entries);
        input.state.seeded = true;

        return true;
    } catch (cause) {
        input.log.warn('configuration prompt baseline could not be established', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return false;
    }
}

/**
 * Run one task inside the configuration prompt chain. Unlike the binding and
 * account lanes' runners, this one does **not** seed: the cycle's
 * configuration read shares the task (research R-3), so a trail that cannot
 * be read must cost the cycle its observation, never its configuration —
 * seeding lives inside {@link recordConfigPromptChanges}, where a failure has
 * somewhere honest to go. The stored chain promise always **resolves**, so a
 * failed task rejects for its own caller without wedging the next one.
 */
export async function runConfigPromptChain<T>(store: ServiceStore, task: () => Promise<T>): Promise<T> {
    const state = stateFor(store);
    // Both handlers are the same continuation: a rejected predecessor must not
    // stop the next task.
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs task on its own rejection; this runs once.
    const run = state.chain.then(task, task);
    state.chain = run;

    return await run;
}

/**
 * Diff one configuration document against the baseline and record the
 * difference. **Must run inside {@link runConfigPromptChain}** — the
 * baseline it reads and writes is only safe while no other observation or
 * configuration write can interleave with it. `readCycleConfig` calls it
 * inside the very task that read the document, `PUT /v1/config` before its
 * own write. Neither failure mode escapes as an exception: an unreadable
 * trail warns and skips, a failed append answers `false` plus its own warn,
 * so the cycle's shared read never inherits an audit problem.
 */
export async function recordConfigPromptChanges(input: ConfigPromptObservation): Promise<number> {
    const state = stateFor(input.store);
    if (!(await ensureSeeded({ store: input.store, state, log: input.log }))) {
        return 0;
    }

    const current = configPromptFingerprint(input.config.startingPrompt);
    const previous = state.baseline;
    // Advance first: an append that fails must not re-report the same change
    // on every later read (003 FR-063's posture, plan D8).
    state.baseline = current;
    if (previous === current) {
        return 0;
    }

    const isWritten = await appendConfigApplied({
        store: input.store,
        log: input.log,
        actor: input.actor,
        changes: [{ field: 'startingPrompt', from: previous, to: current }],
    });

    return isWritten ? 1 : 0;
}

/**
 * Teach the lane what a configuration write's own row just recorded, so the
 * next cycle does not append a duplicate while its baseline would still
 * hold the pre-write value and claim the write as unobserved. **Must run
 * inside {@link runConfigPromptChain}**, after the row — never through
 * {@link recordConfigPromptChanges}, which would append the duplicate this
 * exists to prevent. When the baseline could not be seeded the advance is
 * skipped rather than written over an unknown value: the next observation
 * seeds from the trail, where the write's row landed.
 */
export async function advanceConfigPromptBaseline(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The document the write put in force. */
    readonly config: ObservedConfigPrompt;
}): Promise<void> {
    const state = stateFor(input.store);
    if (!(await ensureSeeded({ store: input.store, state, log: input.log }))) {
        return;
    }

    state.baseline = configPromptFingerprint(input.config.startingPrompt);
}
