/**
 * The history-scope change observer (002 FR-086 – FR-088; plan H12).
 *
 * A binding's history scope can change on three paths, and FR-086 names all
 * three as needing exactly one row each: a whole-file `PUT` through the panel,
 * a hand edit of `bindings.json` the poll loop notices on its next read, and a
 * change riding inside a write alongside other members. This module is what makes
 * "one row per change" a property of **serialisation** rather than of timing —
 * the same posture [`prompt-audit.ts`](./prompt-audit.ts) takes for the starting
 * prompt, and for the same reasons:
 *
 * - **one chain per store handle.** Every seed, every diff, and every append runs
 *   as a task on the same chain, so a poll-cycle observation racing a `PUT`
 *   cannot interleave with the other's read → diff → append sequence;
 * - **one baseline per store handle**, seeded once from the trail itself (the
 *   highest-`seq` row per binding) so a restart does not re-report every change
 *   the trail already records, and a trimmed trail honestly yields "no prior";
 * - **the baseline advances even when an append fails**, so a store that cannot
 *   write the row does not retry it on every subsequent read (003 FR-063's
 *   posture).
 *
 * The row carries **nothing** but the binding, the decision, the previous mode,
 * the new mode, and the actor (002 FR-086). Two fixed names mean there is no
 * free text, no length, and no fingerprint, so nothing credential-shaped is added
 * anywhere and no redaction rule or secret-scan exemption is required (FR-054).
 * No dispatch-lifecycle row gains, loses, or renames a member (FR-088), and no
 * per-observation row is written — the question *"why was this never offered?"*
 * is answered from the binding's own window line and from this trail (FR-087).
 */

import { newCorrelationId } from '../src/ids.ts';
import { AUDIT_FILE, appendAudit, parseAuditEntry } from './audit.ts';
import { effectiveHistoryScope, HISTORY_SCOPES } from './bindings-history-scope.ts';
import type { HistoryScope } from './bindings-history-scope.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceStore } from './store/index.ts';

/**
 * The one event type this feature adds.
 *
 * In the `binding.` prefix 003's data-model §4.2 already reserved for
 * configuration rows, so no new vocabulary leaves that prefix and no
 * dispatch-lifecycle type moves (002 FR-086, FR-088).
 */
export const HISTORY_SCOPE_UPDATED_EVENT = 'binding.history-scope-updated';

/** Who caused the change: `operator` through the panel, `service` otherwise. */
export type HistoryScopeActor = 'operator' | 'service';

/** How a change is named in the audit row's decision. */
export type HistoryScopeDecision =
    /** No previous mode was recorded; this one is being set for the first time. */
    | 'set'
    /** A recorded mode was replaced by a different one. */
    | 'changed'
    /** The mode was cleared back to the documented default. */
    | 'cleared';

/** The binding members this observation reads. */
export interface ObservedScope {
    /** The binding this document entry describes. */
    readonly bindingId: string;
    /** Its stored mode, absent when it stores none. */
    readonly historyScope?: HistoryScope;
}

/** Per-store observation state, created on first use. */
interface ScopeObservationState {
    /** `bindingId` → the effective mode the last recorded observation saw. */
    readonly baseline: Map<string, HistoryScope>;
    /** Whether the baseline has been seeded from the trail for this handle. */
    seeded: boolean;
    /** The task queue every observation of the bindings document joins. */
    chain: Promise<unknown>;
}

/** One state per store handle: a restart re-seeds, a shared handle shares. */
const observationStates = new WeakMap<ServiceStore, ScopeObservationState>();

/**
 * Get (or create) the observation state for one store handle.
 *
 * @returns The handle's baseline and chain.
 */
function stateFor(store: ServiceStore): ScopeObservationState {
    let state = observationStates.get(store);
    if (state === undefined) {
        state = { baseline: new Map(), seeded: false, chain: Promise.resolve() };
        observationStates.set(store, state);
    }

    return state;
}

/**
 * Narrow a value read back from the trail to a recorded mode.
 *
 * **Only a shape a row should have carried is trusted**, the same rule
 * `prompt-audit.ts` applies to a fingerprint and `config-audit.ts` to its own
 * seeds. This value becomes the baseline and is written back into a later row as
 * `from`, so anything that is not one of the two names — a number a hand-edited
 * trail holds, an object, a third string — would otherwise be echoed forward into
 * a new row as though the service had recorded it (002 FR-086's "nothing else").
 *
 * A row that recorded no mode, or one this build does not accept, seeds as the
 * documented default: the trail is history the product did not write, and a
 * seeded value this build cannot vouch for must not become the `from` of a row it
 * does write.
 *
 * @param recorded - The `to` member a prior row carried.
 * @returns The mode, or `null` when the row carried none this build accepts.
 */
function recordedScopeOf(recorded: unknown): HistoryScope | null {
    return HISTORY_SCOPES.find((scope) => scope === recorded) ?? null;
}

/**
 * Seed the baseline from the audit trail: highest-`seq` row per binding.
 *
 * @param baseline - The map to fill (empty on first use for this handle).
 * @throws {StorageUnavailableError} When the trail cannot be read — a chain that
 *   cannot establish its baseline must not start guessing at diffs.
 */
async function seedBaseline(store: ServiceStore, baseline: Map<string, HistoryScope>): Promise<void> {
    const trail = await store.readLines(AUDIT_FILE, parseAuditEntry);
    const highest = new Map<string, { readonly seq: number; readonly scope: HistoryScope }>();
    for (const entry of trail.entries) {
        if (entry.eventType !== HISTORY_SCOPE_UPDATED_EVENT) {
            continue;
        }

        const { bindingId } = entry.details;
        if (typeof bindingId !== 'string') {
            continue;
        }

        const scope = recordedScopeOf(entry.details.to) ?? effectiveHistoryScope();
        const prior = highest.get(bindingId);
        if (prior === undefined || entry.seq > prior.seq) {
            highest.set(bindingId, { seq: entry.seq, scope });
        }
    }

    for (const [bindingId, value] of highest) {
        baseline.set(bindingId, value.scope);
    }
}

/**
 * Run one task inside the observation chain, seeding the baseline first.
 *
 * The chain promise stored in the state always **resolves**, so a failed task
 * rejects for its own caller without wedging the next one.
 *
 * @param task - The read/append work to serialise.
 * @returns The task's result or rejection, exactly as the task produced it.
 * @throws {StorageUnavailableError} When the baseline cannot be seeded.
 */
export async function runHistoryScopeChain<T>(store: ServiceStore, task: () => Promise<T>): Promise<T> {
    const state = stateFor(store);
    const start = async (): Promise<T> => {
        if (!state.seeded) {
            await seedBaseline(store, state.baseline);
            state.seeded = true;
        }

        return await task();
    };
    // Both handlers are the same continuation: a rejected predecessor must not
    // stop the next task.
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs start on its own rejection; this runs once.
    const run = state.chain.then(start, start);
    state.chain = run;

    return await run;
}

/**
 * Name the decision two modes imply, and only those (002 FR-086).
 *
 * Four cases and no fifth, because the documented default has two sides and both
 * must be distinguishable: a binding moving **to** the default is *cleared*, and
 * a binding moving **from** it is *set*, while any other move is *changed*. The
 * equal case is `changed` — the caller never reaches it, since a resubmission of
 * the mode in force writes nothing (FR-086), and naming it rather than throwing
 * keeps the row's vocabulary total.
 *
 * @returns The decision the row records.
 */
function decisionFor(input: {
    /** The mode in force before this change. */
    readonly from: HistoryScope;
    /** The mode in force after it. */
    readonly to: HistoryScope;
}): HistoryScopeDecision {
    if (input.from === input.to) {
        return 'changed';
    }

    const fallback = effectiveHistoryScope();
    if (input.from === fallback) {
        return 'set';
    }

    return input.to === fallback ? 'cleared' : 'changed';
}

/**
 * Append exactly one `binding.history-scope-updated` row.
 *
 * The decision is **derived** from the two modes rather than passed in, so the
 * vocabulary (`set` | `changed` | `cleared`) cannot drift from what the baseline
 * says happened — and a resubmission of the mode in force cannot reach this
 * function at all, because the caller compares first.
 *
 * @throws {StorageUnavailableError} When the append fails; the caller decides
 *   whether that rolls anything back (it never does — see the module header).
 */
export async function appendHistoryScopeChange(input: {
    /** Open store whose audit trail this row joins. */
    readonly store: ServiceStore;
    /** Binding whose mode changed. */
    readonly bindingId: string;
    /** The mode in force **before** this change, as the baseline recorded it. */
    readonly from: HistoryScope;
    /** The mode in force **after** this change. */
    readonly to: HistoryScope;
    /** Who actually made the change, never claimed for anyone else. */
    readonly actor: HistoryScopeActor;
}): Promise<void> {
    const decision = decisionFor({ from: input.from, to: input.to });

    await appendAudit(input.store, {
        eventType: HISTORY_SCOPE_UPDATED_EVENT,
        actorSource: input.actor,
        entity: { kind: 'binding', id: input.bindingId },
        correlationId: newCorrelationId(),
        decision,
        reason: null,
        // Two fixed names and nothing else: no text, no length, no fingerprint,
        // and therefore no redaction surface (002 FR-086, FR-054).
        details: { bindingId: input.bindingId, from: input.from, to: input.to, actor: input.actor },
    });
}

/** What one observation of a bindings document carries. */
interface ScopeObservation {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger for a failed append (binding id and the two names only). */
    readonly log: ServiceLogger;
    /** The bindings document as it now stands. */
    readonly bindings: readonly ObservedScope[];
    /** Who made the changes this document carries. */
    readonly actor: HistoryScopeActor;
}

/**
 * Forget every binding the document no longer carries.
 *
 * A dropped binding is not a mode change and writes no row; dropping it from the
 * baseline means re-adding it later reads as a fresh `set` rather than
 * inheriting a mode nobody holds any more.
 *
 * @param observed - The binding ids this document carried.
 */
function dropUnobserved(state: ScopeObservationState, observed: ReadonlySet<string>): void {
    for (const bindingId of state.baseline.keys()) {
        if (!observed.has(bindingId)) {
            state.baseline.delete(bindingId);
        }
    }
}

/**
 * Append one difference's row, or log its failure and count nothing.
 *
 * @returns `1` when the row reached the trail, `0` when the append failed.
 */
async function recordOneChange(context: {
    /** The observation this difference belongs to. */
    readonly input: ScopeObservation;
    /** The binding whose mode differs from the baseline. */
    readonly binding: ObservedScope;
    /** The mode the snapshot carries. */
    readonly to: HistoryScope;
    /** The mode the baseline held. */
    readonly from: HistoryScope;
}): Promise<number> {
    const { input, binding, to, from } = context;
    try {
        await appendHistoryScopeChange({
            store: input.store,
            bindingId: binding.bindingId,
            from,
            to,
            actor: input.actor,
        });

        return 1;
    } catch (cause) {
        input.log.warn('history-scope change audit row could not be appended', {
            bindingId: binding.bindingId,
            from,
            to,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return 0;
    }
}

/**
 * Diff one bindings document against the baseline and record the differences.
 *
 * **Must run inside {@link runHistoryScopeChain}** — the baseline it reads and
 * writes is only safe while no other observation can interleave with it.
 *
 * A submission that **resends the mode in force writes nothing** (002 FR-086):
 * the comparison below is on effective values, so absence, an explicit
 * `new-only`, and a stored `recent-history` all compare equal to themselves and
 * produce no row.
 *
 * @returns How many rows this observation appended.
 */
export async function recordHistoryScopeChanges(input: ScopeObservation): Promise<number> {
    const state = stateFor(input.store);
    const observed = new Set<string>();
    let rows = 0;

    for (const binding of input.bindings) {
        observed.add(binding.bindingId);
        const to = effectiveHistoryScope(binding.historyScope);
        const from = state.baseline.get(binding.bindingId) ?? effectiveHistoryScope();
        // Advance first: an append that fails must not re-report the same change
        // on every later read.
        state.baseline.set(binding.bindingId, to);
        if (from === to) {
            continue;
        }

        rows += await recordOneChange({ input, binding, to, from });
    }

    dropUnobserved(state, observed);

    return rows;
}

/**
 * Observe one bindings document on the chain: seed, diff, record, advance.
 *
 * The entry point `readBindings` funnels through with actor `service`, so a
 * mode edited outside the panel is recorded by whoever the service could
 * actually attribute the change to.
 *
 * @returns How many rows this observation appended.
 */
export async function observeHistoryScopeChanges(input: ScopeObservation): Promise<number> {
    return await runHistoryScopeChain(input.store, async () => await recordHistoryScopeChanges(input));
}
