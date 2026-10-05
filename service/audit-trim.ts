/**
 * The audit retention pass over `audit.ndjson`.
 *
 * The trail used to grow without bound — `service/audit.ts` recorded trimming as
 * a deferral and nobody discharged it. This module is that consumer, shaped as
 * **read → decide → one atomic rewrite** rather than a series of deletions.
 *
 * Six rules are load-bearing:
 *
 * - **The protected set is computed by rule, never by list.** A row is protected
 *   when it opens or closes a correlation chain containing a run-scoped row,
 *   when it records the hop that left the run in its final state, when it
 *   created the run, when it names an account or binding the store can still
 *   account for, or when it records a policy/configuration decision. A vocabulary
 *   row 003 adds later is *classified* without a change here when it is
 *   run-scoped, because run-scoped means `entity.kind === 'run'` **or** a
 *   `run.`/`dispatch.`/`agent.` event type — a category, never a transcription of
 *   the table. The chain half — openers, outcomes, the hop that recorded the
 *   run's final state, the creation row — lives in `audit-protect.ts`, where the
 *   run-scoped axis reads the same way but the transition table
 *   does not: that table is a **closed set of names**, so a later hop does *not*
 *   land in it by prefix. A new state-recording event type must join that set — a
 *   name outside it is unprotected, so a trim can take the row that left the run
 *   in its final state.
 * - **Both limits are honoured, whichever trips first**, and the pass counts the
 *   `audit.trimmed` row it is about to write *before* it decides, so a cap of N
 *   lands the trail at or below N instead of oscillating one row per cycle — at
 *   or below N once the rows the cap never takes are discounted: the protected
 *   floor and a previous `audit.trimmed` row, which the day window ages out but
 *   the cap never takes. Counted in, the trail lands at or below N when those
 *   exempt rows are fewer than N, and at N + 1 or above when they are not — the
 *   floor holding, not the cap failing. That previous `audit.trimmed` row is the
 *   one thing the **cap** never takes among the unprotected rows: once the
 *   protected set sits at N it is the only row left to delete, and deleting it
 *   would rewrite the file every cycle forever while erasing the only
 *   explanation the trail has for its own `seq` gaps. It still ages out under
 *   the day window — cap-exempt is not age-exempt — so the protected-at-cap
 *   state settles at `removed === 0` and no write at all.
 * - **A trim never renumbers `seq`.** Survivors keep their numbers, the row takes
 *   the next one from the writer's own counter through {@link composeAudit}, and
 *   the gap the removal leaves is the trail's visible signature.
 * - **The row and the removals land in the same rename.** One
 *   {@link serializeAudit} slot holds the read, the decision, and
 *   `writeLines(AUDIT_FILE, [...survivors, trimRow])`, so a crash leaves either
 *   the pre-trim trail or the post-trim one — never a removal without its record,
 *   and never a `seq` a restart could re-seed below a used number. The same slot
 *   keeps a pass from removing a row `appendAudit` wrote while the pass was
 *   computing.
 * - **An erasure nobody counted is still an erasure.** The reader refuses lines
 *   it cannot parse, and a rewrite drops every refused line with it — so this
 *   pass warns on the read and carries the count onto the `audit.trimmed` row as
 *   `details.malformedLinesDropped`, making the loss an auditable fact rather
 *   than a silent one. A pass that removes nothing rewrites nothing, and the
 *   unreadable lines stay exactly where they are.
 *
 * A pass that removes nothing writes nothing: no file is touched and no row is
 * appended, so an idle cycle costs one read and no write at all.
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
 * removal never takes.
 *
 * The record of a removal explains every `seq` gap that removal left, so
 * deleting the previous record to satisfy the entry cap would both destroy the
 * explanation and guarantee the next pass had something to delete again — a
 * file rewrite every cycle, forever, and a trail whose historical gaps nobody
 * can account for. Such a row still ages out under the day window like any
 * other unprotected row: cap-exempt is not age-exempt.
 */
const TRIM_EVENT = 'audit.trimmed';

/** One retention limit, named the way the trim row's `limitReached` records it. */
export type AuditLimit = 'day-window' | 'entry-cap';

/** What one pass did, for the caller's log line and its tests. */
export interface TrimAuditOutcome {
    /** Rows removed by this pass; `0` means the file was not touched. */
    readonly removed: number;
    /** Which limit tripped first, or `null` when nothing was removed. */
    readonly limitReached: AuditLimit | null;
    /** Protected rows this pass deliberately kept. */
    readonly minimalReferencesPreserved: number;
}

/** Inputs one pass reads; the configuration is the caller's single cycle read. */
export interface TrimAuditInput {
    /** Open store holding the trail. */
    readonly store: ServiceStore;
    /** Structured logger. */
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

/** The trail ordered, plus what a pass decided about each row. */
interface RemovalPlan {
    /** Rows that stay, in `seq` order. */
    readonly survivors: readonly AuditEntry[];
    /** Rows this pass takes, oldest first. */
    readonly removed: readonly AuditEntry[];
    /** Which limit tripped first, or `null` when nothing was removed. */
    readonly limitReached: AuditLimit | null;
}

/**
 * Read the stored bindings document's identity list, without the store's own
 * reader collapsing two different answers into one.
 *
 * The bindings reader answers `[]` both when the file is *absent* (no bindings
 * exist — their rows are trimmable) and when it is *unreadable* (unknown —
 * their rows must stay), so this pass probes the document itself to tell those
 * apart: fail-closed parsing applied to a destructive decision (invariant 8).
 * An unparseable document still quarantines, exactly as the real reader
 * quarantines it moments later in the same cycle.
 *
 * @returns The binding ids, `[]` when there is no document, or `null` when the
 *   document exists but cannot be understood.
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
 *
 * @returns Their numeric ids, or `null` when the custody directory cannot be
 *   listed — unknown keeps the rows, because a reference is only removable
 *   once the subject is provably gone.
 */
async function existingAccountIds(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
 *
 * @returns Their ids, `[]` when there is no document, or `null` when the
 *   document could not be read.
 */
async function existingBindingIds(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
 *
 * @param input - Trail rows, the store, and the logger.
 * @returns The protected `seq` numbers this half of the rule contributes.
 */
async function subjectSeqs(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
 *
 * @returns The `seq` numbers a trim must never remove.
 */
async function protectedSeqsOf(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
 * Choose what one pass removes: unprotected rows that fall outside the day
 * window, plus enough of the oldest of them to bring an over-cap trail down.
 *
 * The walk is oldest-first and skips every protected row, so removals always
 * take the oldest trimmable rows first and a protected row is never chosen at
 * any age or any cap. It also skips the **cap** for a previous `audit.trimmed`
 * row: at the protected-at-cap state that row is the only row left to take, and
 * taking it would rewrite the file every cycle forever while destroying the
 * record that explains the trail's own `seq` gaps (see {@link TRIM_EVENT}) — so
 * the state yields `removed === 0` and no write, exactly like an all-protected
 * trail. The day window still applies to it. A timestamp that will not parse
 * never marks a row too old — an undatable row is kept, never guessed out of
 * the file.
 *
 * @param input - The ordered trail, the protected set, and the two limits.
 * @returns The survivors and removals, with the limit that tripped first.
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
 *
 * @param input - The plan, the limit that tripped, the protected count, the
 *   unreadable-line count this rewrite is erasing, and the open store.
 * @returns The composed row, ready to be written beside its removals.
 */
async function composeTrimRow(input: {
    /** The plan that produced the removals. */
    readonly plan: RemovalPlan;
    /** The limit that tripped first; the row names it. */
    readonly limitReached: AuditLimit;
    /** Protected rows deliberately kept. */
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
 *
 * @returns The usable rows ordered by `seq`, plus the lines that were refused.
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
 *
 * @returns The ordered rows plus the unreadable-line count.
 */
async function readForPass(input: {
    /** Open store holding the trail. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
 *
 * @returns What the pass removed; `removed: 0` means nothing was touched.
 * @throws {StorageUnavailableError} When the trail cannot be read or rewritten;
 *   the caller (store open, cycle boundary) logs the failure and moves on, and
 *   the file still holds its pre-trim bytes.
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
