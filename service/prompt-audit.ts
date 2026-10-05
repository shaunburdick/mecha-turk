/**
 * The prompt-change observer (004 FR-051, SC-125; plan D8, N3).
 *
 * A binding's prompt can change on two paths that must never both record it:
 * a whole-file `PUT` through the panel, and a hand edit of `bindings.json`
 * that the poll loop notices on its next read. This module makes "exactly one
 * row per change" a property of *serialisation* rather than of timing:
 *
 * - **one chain per store handle** — every baseline seed, every read of the
 *   bindings document, every write of it, and every diff runs as a task on the
 *   same chain, so a poll-cycle observation racing a `PUT` cannot interleave
 *   its read → diff → write → baseline sequence with the other's;
 * - **one baseline per store handle**, seeded once from the trail itself
 *   (the highest-`seq` `binding.prompt-updated` row per binding) so
 *   `previousFingerprint` survives a restart without a new store file
 *   (004 NFR-129) and a trimmed trail honestly yields `null`;
 * - **the baseline advances even when an append fails** — the same posture
 *   003 FR-063 gives its lifecycle rows: state stands, the failure is logged
 *   as a `warn` naming the binding and the fingerprint (never the text), and
 *   nothing rolls back.
 *
 * The row itself carries the binding, presence, fingerprint, length, the
 * previous fingerprint, and the actor — and **never the prompt's text**
 * (004 FR-051, FR-053). The text lives in the binding and in the run's own
 * snapshot, nowhere else.
 */

import { newCorrelationId } from '../src/ids.ts';
import { AUDIT_FILE, appendAudit, parseAuditEntry } from './audit.ts';
import { PROMPT_FINGERPRINT_PATTERN, promptTierOf } from './prompt.ts';
import type { TierPrompt } from './prompt.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/**
 * The one event type this feature adds (004 `### Audit Vocabulary Delta`).
 *
 * The reserved `binding.` prefix 003's data-model §4.2 already held for
 * configuration rows: no dispatch-lifecycle type is added, renamed, or
 * changed, and the row is a non-run row with its own generated correlation id.
 */
export const PROMPT_UPDATED_EVENT = 'binding.prompt-updated';

/** Who caused the change: `operator` through the panel, `service` otherwise. */
export type PromptChangeActor = 'operator' | 'service';

/** The binding members an observation reads. */
export interface ObservedBinding {
    /** The binding this document entry describes. */
    readonly bindingId: string;
    /** Its stored prompt, when it carries one. */
    readonly startingPrompt?: string;
}

/** Per-store observation state, created on first use. */
interface PromptObservationState {
    /** `bindingId` → the fingerprint the last recorded change produced. */
    readonly baseline: Map<string, string | null>;
    /** Whether the baseline has been seeded from the trail for this handle. */
    seeded: boolean;
    /** The task queue every read/write/diff of the bindings document joins. */
    chain: Promise<unknown>;
}

/** One state per store handle: a restart re-seeds, a shared handle shares. */
const observationStates = new WeakMap<ServiceStore, PromptObservationState>();

/**
 * Get (or create) the observation state for one store handle.
 *
 * @param store - Open store.
 * @returns The handle's baseline and chain.
 */
function stateFor(store: ServiceStore): PromptObservationState {
    let state = observationStates.get(store);
    if (state === undefined) {
        state = { baseline: new Map(), seeded: false, chain: Promise.resolve() };
        observationStates.set(store, state);
    }

    return state;
}

/**
 * Seed the baseline from the audit trail: highest-`seq` row per binding.
 *
 * @param store - Open store holding `audit.ndjson`.
 * @param baseline - The map to fill (empty on first use for this handle).
 * @throws {StorageUnavailableError} When the trail cannot be read — a chain
 *   that cannot establish its baseline must not start guessing at diffs.
 */
async function seedBaseline(store: ServiceStore, baseline: Map<string, string | null>): Promise<void> {
    const trail = await store.readLines(AUDIT_FILE, parseAuditEntry);
    const highest = new Map<string, { readonly seq: number; readonly fingerprint: string | null }>();
    for (const entry of trail.entries) {
        if (entry.eventType !== PROMPT_UPDATED_EVENT) {
            continue;
        }

        const { bindingId } = entry.details;
        if (typeof bindingId !== 'string') {
            continue;
        }

        // Only a value that already carries the `mtp-` shape is trusted — the
        // same rule `config-audit.ts` uses to seed its own baseline. This
        // value becomes the lane's baseline and is written back into a later
        // row as `previousFingerprint`, so anything that is not a fingerprint
        // (text a row should never have carried, a number, an object) would
        // otherwise be echoed forward into a new row. `null` keeps 004
        // FR-053's never-the-text rule in force on the **read** side too.
        const recorded = entry.details.promptFingerprint;
        const fingerprint =
            typeof recorded === 'string' &&
            entry.details.promptPresent === true &&
            PROMPT_FINGERPRINT_PATTERN.test(recorded)
                ? recorded
                : null;
        const prior = highest.get(bindingId);
        if (prior === undefined || entry.seq > prior.seq) {
            highest.set(bindingId, { seq: entry.seq, fingerprint });
        }
    }

    for (const [bindingId, value] of highest) {
        baseline.set(bindingId, value.fingerprint);
    }
}

/**
 * Run one task inside the observation chain, seeding the baseline first.
 *
 * The chain promise stored in the state always **resolves**, so a failed task
 * rejects for its own caller without wedging the next one — the same shape the
 * audit writer's write chain uses.
 *
 * @param store - Open store.
 * @param task - The read/write/diff work to serialise.
 * @returns The task's result or rejection, exactly as the task produced it.
 * @throws {StorageUnavailableError} When the baseline cannot be seeded.
 */
export async function runPromptChain<T>(store: ServiceStore, task: () => Promise<T>): Promise<T> {
    const state = stateFor(store);
    const start = async (): Promise<T> => {
        if (!state.seeded) {
            await seedBaseline(store, state.baseline);
            state.seeded = true;
        }

        return await task();
    };
    // Both handlers are the same continuation, exactly as the audit writer's
    // write chain does it: a rejected predecessor must not stop the next task.
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs start on its own rejection; this runs once.
    const run = state.chain.then(start, start);
    state.chain = run;

    return await run;
}

/** What one prompt-change row records (004 FR-051; data-model §4.1). */
export interface PromptChange {
    /** Open store whose audit trail this row joins. */
    readonly store: ServiceStore;
    /** Binding whose prompt changed. */
    readonly bindingId: string;
    /** The prompt **after** the change, or `null` when it was cleared. */
    readonly current: TierPrompt | null;
    /** The fingerprint the previous row for this binding recorded, else `null`. */
    readonly previousFingerprint: string | null;
    /** Who actually made the change, never claimed for anyone else. */
    readonly actor: PromptChangeActor;
}

/**
 * Append exactly one `binding.prompt-updated` row.
 *
 * The decision is derived from the two fingerprints rather than passed in, so
 * the vocabulary (`set` | `changed` | `cleared`) cannot drift from what the
 * baseline says happened.
 *
 * @param input - The binding, both fingerprints, and the actor.
 * @throws {StorageUnavailableError} When the append fails; the caller decides
 *   whether that rolls anything back (it never does — see the module header).
 */
export async function appendPromptChange(input: PromptChange): Promise<void> {
    const isPresent = input.current !== null;
    let decision: string;
    if (input.current === null) {
        decision = 'cleared';
    } else {
        decision = input.previousFingerprint === null ? 'set' : 'changed';
    }

    await appendAudit(input.store, {
        eventType: PROMPT_UPDATED_EVENT,
        actorSource: input.actor,
        entity: { kind: 'binding', id: input.bindingId },
        correlationId: newCorrelationId(),
        decision,
        reason: null,
        details: {
            bindingId: input.bindingId,
            promptPresent: isPresent,
            promptFingerprint: input.current?.fingerprint ?? null,
            // Data-model §4.1 types this `number`: an absent prompt is zero
            // characters of instruction, which is a length rather than a hole.
            promptLength: input.current?.length ?? 0,
            previousFingerprint: input.previousFingerprint,
        },
    });
}

/** What one observation of a bindings document carries. */
interface PromptObservation {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger for a failed append (binding id and fingerprint only). */
    readonly log: ServiceLogger;
    /** The bindings document as it now stands. */
    readonly bindings: readonly ObservedBinding[];
    /** Who made the changes this document carries. */
    readonly actor: PromptChangeActor;
}

/**
 * Forget every binding the document no longer carries.
 *
 * A dropped binding is not a prompt change and writes no row; dropping it from
 * the baseline means re-adding it later reads as a fresh `set` rather than
 * inheriting a fingerprint nobody holds any more.
 *
 * @param state - The store's observation state.
 * @param observed - The binding ids this document carried.
 */
function dropUnobserved(state: PromptObservationState, observed: ReadonlySet<string>): void {
    for (const bindingId of state.baseline.keys()) {
        if (!observed.has(bindingId)) {
            state.baseline.delete(bindingId);
        }
    }
}

/**
 * Append one difference's row, or log its failure and count nothing.
 *
 * @param context - The observation, the binding, its snapshot, and both
 *   fingerprints.
 * @returns `1` when the row reached the trail, `0` when the append failed.
 */
async function recordOneChange(context: {
    /** The observation this difference belongs to. */
    readonly input: PromptObservation;
    /** The binding whose prompt differs from the baseline. */
    readonly binding: ObservedBinding;
    /** Its snapshot, or `null` when the prompt is unset. */
    readonly snapshot: TierPrompt | null;
    /** The fingerprint the snapshot carries, or `null`. */
    readonly current: string | null;
    /** The fingerprint the baseline held, or `null`. */
    readonly previous: string | null;
}): Promise<number> {
    const { input, binding, snapshot, current, previous } = context;
    try {
        await appendPromptChange({
            store: input.store,
            bindingId: binding.bindingId,
            current: snapshot,
            previousFingerprint: previous,
            actor: input.actor,
        });

        return 1;
    } catch (cause) {
        input.log.warn('prompt change audit row could not be appended', {
            bindingId: binding.bindingId,
            promptFingerprint: current,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return 0;
    }
}

/**
 * Diff one bindings document against the baseline and record the differences.
 *
 * **Must run inside {@link runPromptChain}** — the baseline it reads and
 * writes is only safe while no other observation can interleave with it.
 *
 * @param input - The document, the actor to attribute it to, and the logger.
 * @returns How many rows this observation appended.
 */
export async function recordPromptChanges(input: PromptObservation): Promise<number> {
    const state = stateFor(input.store);
    const observed = new Set<string>();
    let rows = 0;

    for (const binding of input.bindings) {
        observed.add(binding.bindingId);
        const snapshot = promptTierOf(binding);
        const current = snapshot === null ? null : snapshot.fingerprint;
        const previous = state.baseline.get(binding.bindingId) ?? null;
        // Advance first: an append that fails must not re-report the same
        // change on every later read (003 FR-063's posture, plan D8).
        state.baseline.set(binding.bindingId, current);
        if (previous === current) {
            continue;
        }

        rows += await recordOneChange({ input, binding, snapshot, current, previous });
    }

    dropUnobserved(state, observed);

    return rows;
}

/**
 * Observe one bindings document on the chain: seed, diff, record, advance.
 *
 * This is the entry point `readBindings` funnels through with actor `service`,
 * so a prompt edited outside the panel is recorded by whoever the service
 * could actually attribute the change to.
 *
 * @param input - The document, the actor, the store, and the logger.
 * @returns How many rows this observation appended.
 */
export async function observePromptChanges(input: PromptObservation): Promise<number> {
    return await runPromptChain(input.store, async () => await recordPromptChanges(input));
}
