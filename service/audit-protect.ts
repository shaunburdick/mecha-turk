/**
 * The chain half of the retention floor: which `seq` numbers the trim pass
 * may never take, derived from the trail itself (006 FR-056(a), (b), (d);
 * 002 FR-035; 003 FR-065).
 */

import type { AuditEntry } from './audit.ts';

/** Event types that record a policy or configuration decision (FR-056(d)). */
const DECISION_EVENTS: ReadonlySet<string> = new Set(['policy.decision', 'config.changed']);

/** Prefixes that make a row run-scoped; read as categories, never as a list. */
const RUN_SCOPED_PREFIXES: readonly string[] = ['run.', 'dispatch.', 'agent.'];

/** The creation row FR-065's "what the run was" rests on (003 §4.3, first hop). */
const RUN_CREATED_EVENT = 'run.created';

/**
 * Event types that record a **state transition** — a hop from one run state
 * to another (003 data-model §4.3). This is what makes FR-065's *its final
 * state … and the reason for its final state* survive a trim: the latest hop
 * of each chain keeps the final state and its reason without freezing the
 * whole chain. Deliberately a **closed set of names**, not the
 * prefix test the run-scoped axis above it applies — a state-recording event
 * type added later is unprotected until it joins this set, or a trim can take
 * the row that left the run in its final state.
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
 */
function isRunScoped(entry: AuditEntry): boolean {
    if (entry.entity.kind === 'run') {
        return true;
    }

    return RUN_SCOPED_PREFIXES.some((prefix) => entry.eventType.startsWith(prefix));
}

/**
 * Decide whether a row records a policy or configuration decision (FR-056(d)).
 */
function isDecisionEvent(entry: AuditEntry): boolean {
    return DECISION_EVENTS.has(entry.eventType);
}

/**
 * Decide whether a row records a hop to a new run state (003 data-model §4.3).
 *
 *   {@link STATE_TRANSITION_EVENTS}; nothing outside it counts.
 */
function isStateTransition(entry: AuditEntry): boolean {
    return STATE_TRANSITION_EVENTS.has(entry.eventType);
}

/**
 * Index the trail: **one** row per correlation id, the earliest one.
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
 * its chain's opener. The creation row carries the run's full subject, and
 * the opener rule protects *a* row per chain rather than this one — a chain
 * opened by `delivery.detected` would otherwise lose its creation row to the
 * first trim (003 FR-065's *its subject*). When it *is* the opener the
 * opener rule holds it already, hence the condition.
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
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
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
