/**
 * The audit retention pass over `audit.ndjson`: read, decide, and rewrite
 * the trail in one atomic write, honouring both retention limits.
 */

import { BINDINGS_FILE, listAccountsUnobserved } from './accounts/store.ts';
import {
    AUDIT_FILE,
    CONFIGURATION_ENTITY_ID,
    composeAudit,
    readAuditTrail,
    serializeAudit,
} from './audit.ts';
import { chainAndDecisionSeqs } from './audit-protect.ts';
import { isRecord } from './json.ts';
import type { AuditEntry, AuditTrailRead } from './audit.ts';
import type { ServiceConfig } from './config.ts';
import type { ServiceLogger } from './log.ts';
import type { JsonReadResult, ServiceStore } from './store/index.ts';

/** Milliseconds in one day — the unit `auditRetentionDays` is counted in. */
const DAY_MS = 86_400_000;

/**
 * The trim row's own vocabulary (002's reserved name), which a **cap**-driven
 * removal never takes: the record explains every `seq` gap the removal
 * left, so deleting it to satisfy the cap would destroy the explanation and
 * guarantee the next pass had something to delete again — a file rewrite
 * every cycle, forever. It still ages out under the day window:
 * cap-exempt is not age-exempt.
 */
const TRIM_EVENT = 'audit.trimmed';

/** One retention limit, named the way the trim row's `limitReached` records it. */
export type AuditLimit = 'day-window' | 'entry-cap';

export interface TrimAuditOutcome {
    /** Rows removed by this pass; `0` means the file was not touched. */
    readonly removed: number;
    /** Which limit tripped first, or `null` when nothing was removed. */
    readonly limitReached: AuditLimit | null;
    readonly minimalReferencesPreserved: number;
}

/** Inputs one pass reads; the configuration is the caller's single cycle read. */
export interface TrimAuditInput {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The effective configuration, read once by the boundary that runs this. */
    readonly config: ServiceConfig;
    /**
     * Service clock in epoch milliseconds; `Date.now()` when omitted.
     *
     * Injected so a test can age a seeded trail against a fixed instant with no
     * real waiting (006's offline-determinism bar: injected clock, no sleeps).
     */
    readonly now?: number;
}

interface RemovalPlan {
    /** Rows that stay, in `seq` order. */
    readonly survivors: readonly AuditEntry[];
    /** Rows this pass takes, oldest first. */
    readonly removed: readonly AuditEntry[];
    readonly limitReached: AuditLimit | null;
}

/**
 * Read the stored bindings document's identity list, without the store's own
 * reader collapsing two different answers into one: that reader answers `[]`
 * both when the file is *absent* (no bindings exist — their rows are
 * trimmable) and when it is *unreadable* (unknown — their rows must stay), so
 * this pass probes the document itself to tell those apart. Fail-closed
 * parsing applied to a destructive decision (invariant 8); an unparseable
 * document still quarantines, exactly as the real reader does moments later
 * in the same cycle.
 */
function bindingIdsOf(probe: JsonReadResult<unknown>): ReadonlySet<string> | null {
    if (probe.status === 'absent') {
        return new Set<string>();
    }

    if (probe.status === 'quarantined' || !Array.isArray(probe.value)) {
        return null;
    }

    const ids = new Set<string>();
    for (const entry of probe.value) {
        if (isRecord(entry) && typeof entry.bindingId === 'string') {
            ids.add(entry.bindingId);
        }
    }

    return ids;
}

/**
 * List the accounts the floor rule protects while they still exist.
 */
async function existingAccountIds(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<ReadonlySet<string> | null> {
    try {
        // Unobserved on purpose: a retention pass is not a read surface, and
        // appending an observation row from inside the pass that rewrites the
        // trail would be one writer too many (that lane belongs to the
        // read funnels, not to retention).
        const accounts = await listAccountsUnobserved(input.store, input.log);

        return new Set(accounts.map((account) => account.numericUserId));
    } catch (cause) {
        input.log.warn('audit trim could not list accounts', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return null;
    }
}

/**
 * List the bindings the floor rule protects while they still exist.
 */
async function existingBindingIds(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<ReadonlySet<string> | null> {
    let probe: JsonReadResult<unknown>;
    try {
        probe = await input.store.readJson(BINDINGS_FILE, (raw) => raw);
    } catch (cause) {
        input.log.warn('audit trim could not read the bindings document', {
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return null;
    }

    return bindingIdsOf(probe);
}

/**
 * The `seq` numbers the floor rule protects: rows naming a subject that exists.
 */
async function subjectSeqs(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** Trail rows, in any order. */
    readonly entries: readonly AuditEntry[];
}): Promise<readonly number[]> {
    const accounts = await existingAccountIds(input);
    const bindings = await existingBindingIds(input);
    const protectedSeqs: number[] = [];
    for (const entry of input.entries) {
        const { kind, id } = entry.entity;
        if (kind === 'account' && (accounts === null || accounts.has(id))) {
            protectedSeqs.push(entry.seq);
        }

        if (kind === 'binding' && (bindings === null || bindings.has(id))) {
            protectedSeqs.push(entry.seq);
        }
    }

    return protectedSeqs;
}

/**
 * Compute the protected set — by rule, before anything is chosen.
 *
 * (a) the earliest row of every correlation chain that contains a run-scoped
 * row, (b) that chain's latest run-scoped row **plus** the latest state hop and
 * the `run.created` row that are not the opener, (c) `account`/`binding`
 * entity rows whose subject still exists, and (d) every `policy.decision` /
 * `config.changed` row.
 */
async function protectedSeqsOf(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** Trail rows, as the reader produced them. */
    readonly entries: readonly AuditEntry[];
}): Promise<ReadonlySet<number>> {
    const protectedSeqs = new Set<number>(chainAndDecisionSeqs(input.entries));
    const subjects = await subjectSeqs(input);
    for (const seq of subjects) {
        protectedSeqs.add(seq);
    }

    return protectedSeqs;
}

/**
 * Choose what one pass removes: unprotected rows outside the day window,
 * plus enough of the oldest to bring an over-cap trail down. The walk is
 * oldest-first and skips every protected row, and it skips the **cap** for a
 * previous `audit.trimmed` row — at the protected-at-cap state that row is
 * the only one left, and taking it would rewrite the file forever while
 * erasing the record that explains the trail's `seq` gaps (the day window
 * still ages it out). An unparseable timestamp never marks a row too old.
 */
function planRemoval(input: {
    /** Trail rows in `seq` order. */
    readonly ordered: readonly AuditEntry[];
    /** `seq` numbers the floor rule protects. */
    readonly protectedSeqs: ReadonlySet<number>;
    /** Epoch milliseconds at which a row leaves the day window. */
    readonly cutoff: number;
    /** Entry cap; the trim row this plan implies is counted against it. */
    readonly maxEntries: number;
}): RemovalPlan {
    const { ordered, protectedSeqs, cutoff, maxEntries } = input;
    // The cap counts the row this pass is about to append — but only when the
    // trail is *over* the cap, because a pass inside the limit writes no row
    // and must not reserve a slot for one. That distinction is what keeps a
    // trail sitting exactly at the cap stable instead of deleting one row per
    // cycle to make room for the row that would record the deletion
    // (the no-oscillation clause).
    const isOverCap = ordered.length > maxEntries;
    const neededForCap = isOverCap ? ordered.length + 1 - maxEntries : 0;
    const survivors: AuditEntry[] = [];
    const removed: AuditEntry[] = [];
    let limitReached: AuditLimit | null = null;

    for (const entry of ordered) {
        if (protectedSeqs.has(entry.seq)) {
            survivors.push(entry);
            continue;
        }

        const stamped = Date.parse(entry.timestamp);
        const isTooOld = Number.isFinite(stamped) && stamped < cutoff;
        // Cap-exempt, not age-exempt: a trim row is only ever taken here when
        // the day window took it.
        const isForCap = removed.length < neededForCap && entry.eventType !== TRIM_EVENT;
        if (!isTooOld && !isForCap) {
            survivors.push(entry);
            continue;
        }

        // Whichever limit trips first names the row: the walk is
        // oldest-first, so the first removal is the binding one.
        limitReached ??= isTooOld ? 'day-window' : 'entry-cap';
        removed.push(entry);
    }

    return { survivors, removed, limitReached };
}

/**
 * Build the `audit.trimmed` row for a plan that removed something.
 */
async function composeTrimRow(input: {
    readonly plan: RemovalPlan;
    readonly limitReached: AuditLimit;
    readonly minimalReferencesPreserved: number;
    /** Lines the reader could not use and this rewrite is therefore erasing. */
    readonly malformedLinesDropped: number;
    /** Open store the writer's `seq` counter lives on. */
    readonly store: ServiceStore;
}): Promise<AuditEntry> {
    const { plan, limitReached, minimalReferencesPreserved, malformedLinesDropped, store } = input;
    const oldestSeq = Math.min(...plan.removed.map((entry) => entry.seq));
    const newestSeq = Math.max(...plan.removed.map((entry) => entry.seq));

    return await composeAudit(store, {
        eventType: TRIM_EVENT,
        actorSource: 'service',
        entity: { kind: 'service', id: CONFIGURATION_ENTITY_ID },
        decision: 'trimmed',
        reason: `audit trail trimmed; limit reached: ${limitReached}`,
        details: {
            entriesRemoved: plan.removed.length,
            oldestSeq,
            newestSeq,
            limitReached,
            minimalReferencesPreserved,
            // The loss this rewrite performs that no removal accounts for. It
            // rides on *this* row because this row is the only thing written
            // for a rewrite: recording it here is what turns an invisible
            // erasure into an auditable one.
            malformedLinesDropped,
        },
    });
}

/**
 * Read the trail oldest-first, as the sequence a reader walks it in, keeping
 * the unreadable-line count beside it.
 */
async function readOrderedTrail(store: ServiceStore): Promise<AuditTrailRead> {
    const trail = await readAuditTrail(store);

    return { entries: [...trail.entries].toSorted((left, right) => left.seq - right.seq), malformed: trail.malformed };
}

/**
 * Read the trail for one pass, reporting any line the reader had to refuse.
 *
 * The warn lands here, on the read whose result is destructive: this is the
 * pass that erases those lines if it goes on to rewrite, and it says so before
 * it does. The count then travels onto the trim row itself, so the loss is
 * recorded rather than performed invisibly.
 */
async function readForPass(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<AuditTrailRead> {
    const trail = await readOrderedTrail(input.store);
    if (trail.malformed > 0) {
        input.log.warn('audit trail holds unreadable lines; a rewrite this pass makes erases them', {
            malformedLinesDropped: trail.malformed,
        });
    }

    return trail;
}

/**
 * One pass: read the trail, decide, and write survivors **plus** their row in a
 * single atomic replace — or write nothing at all.
 */
export async function trimAudit(input: TrimAuditInput): Promise<TrimAuditOutcome> {
    const now = input.now ?? Date.now();
    const cutoff = now - input.config.auditRetentionDays * DAY_MS;

    return await serializeAudit(input.store, async () => {
        const trail = await readForPass(input);
        const ordered = trail.entries;
        const protectedSeqs = await protectedSeqsOf({
            store: input.store,
            log: input.log,
            entries: ordered,
        });
        const plan = planRemoval({
            ordered,
            protectedSeqs,
            cutoff,
            maxEntries: input.config.auditMaxEntries,
        });
        const minimalReferencesPreserved = protectedSeqs.size;
        const outcome: TrimAuditOutcome = {
            removed: plan.removed.length,
            limitReached: plan.limitReached,
            minimalReferencesPreserved,
        };
        if (plan.removed.length === 0 || plan.limitReached === null) {
            return outcome;
        }

        const trimRow = await composeTrimRow({
            plan,
            limitReached: plan.limitReached,
            minimalReferencesPreserved,
            malformedLinesDropped: trail.malformed,
            store: input.store,
        });
        await input.store.writeLines(AUDIT_FILE, [...plan.survivors, trimRow]);
        input.log.info('audit trail trimmed', {
            entriesRemoved: plan.removed.length,
            limitReached: plan.limitReached,
            minimalReferencesPreserved,
            entriesAfter: plan.survivors.length + 1,
        });

        return outcome;
    });
}
