/**
 * The **global-tier** prompt observer (004 FR-088; 006 FR-070, FR-071; plan
 * N7).
 *
 * `config.json` changes on two paths that must never both record the global
 * tier: the panel's whole-document `PUT /v1/config`, whose `config.changed`
 * row the configuration route writes itself, and a **hand edit** of the file
 * that the poll cycle notices on its next read. This module owns the second
 * path — and deliberately owns no second row for the first:
 *
 * - the `PUT` runs {@link recordConfigPromptChanges} *before* it writes (so a
 *   hand edit the cycle has not seen yet is claimed while it is still visible)
 *   and {@link advanceConfigPromptBaseline} *after* its own row lands (so the
 *   write's move is never re-reported at the next cycle);
 * - the cycle funnels its configuration read through
 *   {@link recordConfigPromptChanges} **inside the same chain task that read
 *   the document**, with actor `service`, so the two paths are serialised
 *   rather than racing — and so the snapshot the diff judges is always the
 *   snapshot the cycle runs on. FR-088's *exactly one audit row per change*
 *   becomes a property of ordering, not of timing — the same discipline
 *   [`prompt-audit.ts`](./prompt-audit.ts) gives the binding tier (research
 *   R-3: one hook, at `readCycleConfig`, the cadence the bindings observer
 *   gets).
 *
 * Like the binding and account lanes: **one chain per store handle**, and
 * **one baseline seeded from the trail itself** — the highest-`seq`
 * `config.changed` row carrying a `startingPrompt` change, `null` when the
 * trail has none — so the previous fingerprint survives a restart without a
 * new store file, and a trimmed trail honestly yields `null`. Two differences
 * from those lanes, both because this lane shares a task with the cycle's
 * *read*:
 *
 * - **the chain does not seed.** Seeding happens inside the diff, where a
 *   trail that cannot be read costs the cycle its observation and logs one
 *   `warn` — never its configuration, and never a guessed `from` (fail
 *   closed);
 * - **the baseline advances even when an append fails.**
 *   `appendConfigApplied` reports that loss as a `warn` and answers `false`;
 *   the observation has already moved on, so one unwritten row never becomes
 *   a re-report on every later cycle — and a restart recovers honestly,
 *   because the trail simply holds no row for that change (003 FR-063's
 *   posture, the same one the other two lanes take).
 *
 * The row itself is a `config.changed` in every respect but its actor
 * (`service`): same composer, same fingerprints or `null`, same take-effect
 * class — and **never the prompt's text** (004 FR-053, FR-088; 006 FR-071).
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
    /** Open store. */
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
 *
 * @param store - Open store.
 * @returns The handle's baseline and chain.
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
 *
 * @param details - One row's `details`.
 * @returns The `{ field, from, to }` entry for the global tier, or `null`.
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
 *
 * @param entries - Every readable row of `audit.ndjson`, oldest first.
 * @returns That fingerprint, or `null` when the trail carries none — and also
 *   when the recorded value is not a fingerprint at all, because a baseline is
 *   written back into a later row as `from` ({@link recordedConfigPromptFingerprint}).
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
 *
 * @param input - The store, the state to fill, and the logger.
 * @returns `true` when the baseline is established; `false` when the trail
 *   could not be read — the caller then **skips its diff** rather than
 *   inventing a `from`, and the next attempt reads the trail again.
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
 * Run one task inside the configuration prompt chain.
 *
 * Unlike the binding and account lanes' runners, this one does **not** seed:
 * the cycle's configuration read shares the task (research R-3), and a trail
 * that cannot be read must cost the cycle its observation, never its
 * configuration. Seeding lives inside {@link recordConfigPromptChanges}, where
 * a failure has somewhere honest to go.
 *
 * The chain promise stored in the state always **resolves**, so a failed task
 * rejects for its own caller without wedging the next one — the same shape the
 * other two lanes' chains use, deliberately: three chains, one discipline.
 *
 * @param store - Open store.
 * @param task - The read/diff/write work to serialise.
 * @returns The task's result or rejection, exactly as the task produced it.
 */
export async function runConfigPromptChain<T>(store: ServiceStore, task: () => Promise<T>): Promise<T> {
    const state = stateFor(store);
    // Both handlers are the same continuation: a rejected predecessor must not
    // stop the next task.
    const run = state.chain.then(task, task);
    state.chain = run;

    return await run;
}

/**
 * Diff one configuration document against the baseline and record the
 * difference.
 *
 * **Must run inside {@link runConfigPromptChain}** — the baseline it reads and
 * writes is only safe while no other observation or configuration write can
 * interleave with it. This is the entry point both callers use: `readCycleConfig`
 * calls it inside the very task that read the document (so the snapshot it
 * judges is the snapshot the cycle runs on), and `PUT /v1/config` calls it
 * before its own write. Neither of its two failure modes reaches a caller as an
 * exception: an unreadable trail skips the diff and logs one `warn`
 * ({@link ensureSeeded}), and an append that cannot reach disk is
 * {@link appendConfigApplied}'s `false` plus its own `warn`. So the cycle's
 * read, which shares this task, never inherits an audit problem.
 *
 * @param input - The document, the actor to attribute it to, the store, the logger.
 * @returns How many rows this observation appended (0 or 1).
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

    const written = await appendConfigApplied({
        store: input.store,
        log: input.log,
        actor: input.actor,
        changes: [{ field: 'startingPrompt', from: previous, to: current }],
    });

    return written ? 1 : 0;
}

/**
 * Teach the lane what a configuration write's own row just recorded.
 *
 * The `PUT /v1/config` row already carries this field's `from`/`to`,
 * so the lane must not append a second one at the next cycle —
 * but its baseline would still hold the pre-write value and would therefore
 * claim the write as an unobserved change. This makes the two agree.
 *
 * **Must run inside {@link runConfigPromptChain}**, after the row (or the
 * no-op that owes none) — never through {@link recordConfigPromptChanges},
 * which would append the duplicate this exists to prevent. When the baseline
 * could not be seeded, the advance is skipped rather than written over an
 * unknown value: the next observation seeds from the trail, which is where the
 * write's row landed.
 *
 * @param input - The store, its logger, and the document just written.
 * @returns Nothing; a failed seed is logged by {@link ensureSeeded} and leaves
 *   the baseline pending, which is the fail-closed answer.
 */
export async function advanceConfigPromptBaseline(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
