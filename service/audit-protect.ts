/**
 * The chain half of the retention floor: which `seq` numbers 006 FR-056(a),
 * (b), and (d) protect, derived from the trail itself (002 FR-035's "minimal
 * references", 003 FR-065's "its final state … and the reason for its final
 * state").
 *
 * This module is pure — rows in, `seq` numbers out — and owns nothing but the
 * rule, which is what lets `audit-trim.ts` stay the read → decide → write pass
 * it documents itself as. Three properties the rule is built to hold:
 *
 * - **A category, and a table.** "Run-scoped" is a `run` entity or a
 *   `run.`/`dispatch.`/`agent.` event prefix — a category, so a run-scoped row
 *   either feature adds later is classified without a change here. "Records a
 *   state transition" is the exception: 003 data-model §4.3's vocabulary as a
 *   **closed set of names**, so a state-recording event type added later is
 *   classified only once it joins that set.
 * - **Both ends of a chain, always.** An opener is only protected together
 *   with an outcome, so "an outcome with no opener" (or the reverse) is
 *   structurally impossible rather than merely unobserved.
 * - **The final state is its own row.** The latest run-scoped row of a
 *   dispatched run is the warn-only read-back, not the `dispatch.result` that
 *   recorded the outcome — so the latest *hop* is protected on its own axis,
 *   and the creation row (the run's full subject) is protected whenever some
 *   other row opened the chain.
 *
 * The subject half of FR-056(c) — rows naming an account or binding the store
 * can still account for — needs the store, so it stays in `audit-trim.ts`.
 */

import type { AuditEntry } from './audit.ts';

/** Event types that record a policy or configuration decision (FR-056(d)). */
const DECISION_EVENTS: ReadonlySet<string> = new Set(['policy.decision', 'config.changed']);

/** Prefixes that make a row run-scoped; read as categories, never as a list. */
const RUN_SCOPED_PREFIXES: readonly string[] = ['run.', 'dispatch.', 'agent.'];

/** The creation row FR-065's "what the run was" rests on (003 §4.3, first hop). */
const RUN_CREATED_EVENT = 'run.created';

/**
 * Event types that record a **state transition** — a hop from one run state to
 * another (003 data-model §4.3, "Transition → row coverage").
 *
 * This list is what makes FR-065's "its final state … and the reason for its
 * final state" survive a trim. In the real chronology of a dispatched run the
 * chain's *latest* run-scoped row is the warn-only `agent.verified` /
 * `agent.mismatch` row, which records no state at all: the row that left the
 * run in its final state is the `dispatch.result` a few rows earlier, and
 * without this set a day-window or cap trim would take it while leaving the
 * warning beside it. Protecting the **latest** hop of each chain (the `…` in
 * FR-056(b)'s rule, applied to the transition axis) therefore keeps the final
 * state and its reason without freezing the whole chain.
 *
 * Deliberately absent: `run.coalesced` (a delivery joins; the run does not
 * move), `dispatch.duplicate-report` (decision `no-change`), `dispatch.refused`
 * (a refusal that records the prior state it did *not* change), and
 * `agent.verified` / `agent.mismatch` (post-dispatch verification, warn-only).
 * `run.created` **is** listed — §4.3's first hop — but it is also protected
 * unconditionally by rule (ii) in {@link chainAndDecisionSeqs}, because the
 * latest-hop rule alone would drop it the moment any later hop exists.
 *
 * Read as "rows that move a run", but this axis is a **closed set of names**,
 * not the prefix test the run-scoped axis above it applies: a state-recording
 * event type 003 adds later is unprotected here until it joins this set, so a
 * trim can take the row that left the run in its final state. Extend the table
 * when the vocabulary grows — the prefixes above will not pick the name up.
 */
const STATE_TRANSITION_EVENTS: ReadonlySet<string> = new Set([
    RUN_CREATED_EVENT,
    'run.migrated',
    'dispatch.claimed',
    'dispatch.reserved',
    'dispatch.result',
    'dispatch.abandoned',
    'dispatch.lease-expired',
    'dispatch.unconfirmed',
    'dispatch.retry',
    'dispatch.resolved',
    'run.blocked',
    'run.dead_lettered',
]);

/**
 * Decide whether a row is run-scoped (data-model §4.2's reading of FR-056).
 *
 * @param entry - Trail row.
 * @returns `true` for a `run` entity or a `run.`/`dispatch.`/`agent.` event.
 */
function isRunScoped(entry: AuditEntry): boolean {
    if (entry.entity.kind === 'run') {
        return true;
    }

    return RUN_SCOPED_PREFIXES.some((prefix) => entry.eventType.startsWith(prefix));
}

/**
 * Decide whether a row records a policy or configuration decision (FR-056(d)).
 *
 * @param entry - Trail row.
 * @returns `true` for the two vocabulary names the rule names.
 */
function isDecisionEvent(entry: AuditEntry): boolean {
    return DECISION_EVENTS.has(entry.eventType);
}

/**
 * Decide whether a row records a hop to a new run state (003 data-model §4.3).
 *
 * @param entry - Trail row.
 * @returns `true` for a name in the closed set
 *   {@link STATE_TRANSITION_EVENTS}; nothing outside it counts.
 */
function isStateTransition(entry: AuditEntry): boolean {
    return STATE_TRANSITION_EVENTS.has(entry.eventType);
}

/**
 * Index the trail: **one** row per correlation id, the earliest one.
 *
 * @param entries - Trail rows, in any order.
 * @returns Every chain's opener, keyed by correlation id.
 */
function openersOf(entries: readonly AuditEntry[]): ReadonlyMap<string, AuditEntry> {
    const openers = new Map<string, AuditEntry>();
    for (const entry of entries) {
        const seen = openers.get(entry.correlationId);
        if (seen === undefined || entry.seq < seen.seq) {
            openers.set(entry.correlationId, entry);
        }
    }

    return openers;
}

/**
 * Index the trail: **one** row per correlation id, the latest one `accept`
 * takes — the outcome axis and the hop axis are two calls of this one rule.
 *
 * @param entries - Trail rows, in any order.
 * @param isAccepted - Whether this row belongs on the axis at all.
 * @returns The latest accepted row of every chain, keyed by correlation id.
 */
function latestOf(
    entries: readonly AuditEntry[],
    isAccepted: (entry: AuditEntry) => boolean,
): ReadonlyMap<string, AuditEntry> {
    const latest = new Map<string, AuditEntry>();
    for (const entry of entries) {
        if (!isAccepted(entry)) {
            continue;
        }

        const seen = latest.get(entry.correlationId);
        if (seen === undefined || entry.seq > seen.seq) {
            latest.set(entry.correlationId, entry);
        }
    }

    return latest;
}

/**
 * The `seq` numbers FR-056(a) and (b) protect for every chain that contains a
 * run-scoped row: its opener, its outcome, and the hop that recorded the state
 * the run was left in.
 *
 * @param entries - Trail rows, in any order.
 * @param openers - The opener index {@link openersOf} derived.
 * @returns The protected `seq` numbers this half of the rule contributes.
 */
function chainSeqs(entries: readonly AuditEntry[], openers: ReadonlyMap<string, AuditEntry>): readonly number[] {
    const outcomes = latestOf(entries, isRunScoped);
    const hops = latestOf(entries, isStateTransition);
    const protectedSeqs: number[] = [];

    // A chain is only protected when it *contains* a run-scoped row, and it
    // keeps three things: the opener and the outcome together — which is what
    // makes "an outcome with no opener" structurally impossible — and
    // the latest hop, the row whose `decision` carries the run's final state,
    // its session, and the reason for it (003 FR-065, cited).
    // Every hop type is run-scoped by prefix, so a hop's chain always reaches
    // this loop.
    for (const [correlationId, outcome] of outcomes) {
        const opener = openers.get(correlationId);
        if (opener !== undefined) {
            protectedSeqs.push(opener.seq);
        }

        protectedSeqs.push(outcome.seq);

        const hop = hops.get(correlationId);
        if (hop !== undefined) {
            protectedSeqs.push(hop.seq);
        }
    }

    return protectedSeqs;
}

/**
 * The `seq` numbers rule (ii) contributes: `run.created` whenever it is not
 * its chain's opener.
 *
 * The creation row carries the run's full subject, and the opener rule
 * protects *a* row per chain, not this one — a chain opened by
 * `delivery.detected` would otherwise lose its creation row to the first trim
 * (003 FR-065's "its subject"). When it *is* the opener the opener rule holds
 * it already, hence the condition.
 *
 * @param entries - Trail rows, in any order.
 * @param openers - The opener index {@link openersOf} derived.
 * @returns The protected `seq` numbers this rule contributes.
 */
function creationSeqs(entries: readonly AuditEntry[], openers: ReadonlyMap<string, AuditEntry>): readonly number[] {
    const protectedSeqs: number[] = [];
    for (const entry of entries) {
        if (entry.eventType !== RUN_CREATED_EVENT) {
            continue;
        }

        const opener = openers.get(entry.correlationId);
        if (opener !== undefined && opener.seq !== entry.seq) {
            protectedSeqs.push(entry.seq);
        }
    }

    return protectedSeqs;
}

/**
 * The `seq` numbers FR-056(a), (b), and (d) protect: chain openers, chain
 * outcomes, the hop that recorded the chain's final state, the creation row,
 * and decision rows.
 *
 * @param entries - Trail rows, in any order.
 * @returns The protected `seq` numbers this half of the rule contributes.
 */
export function chainAndDecisionSeqs(entries: readonly AuditEntry[]): readonly number[] {
    const openers = openersOf(entries);
    const protectedSeqs: number[] = [];
    for (const entry of entries) {
        if (isDecisionEvent(entry)) {
            protectedSeqs.push(entry.seq);
        }
    }

    protectedSeqs.push(...chainSeqs(entries, openers), ...creationSeqs(entries, openers));

    return protectedSeqs;
}
