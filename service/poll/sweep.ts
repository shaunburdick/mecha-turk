/**
 * The lease/deadline sweep (003 FR-032, FR-033, FR-023, FR-036; T-009, T-040).
 *
 * The sweep is the only automatic handler in the service, and the discipline
 * that makes it safe is that it touches **exactly two** conditions and nothing
 * else:
 *
 * - `claimed` + no reservation + lease expired → requeue (attempt and requeue
 *   budget both increment) or, when the budget is exhausted, park the run
 *   (FR-032, FR-033);
 * - `starting` + result deadline passed → `unconfirmed`, the fail-closed wedge
 *   (FR-023).
 *
 * Everything else — a waiting run, a reserved run, an `unconfirmed` wedge, a
 * terminal run — is left byte-identical, which is what FR-036's "a closed panel
 * burns nothing" reduces to on the service side. Each pass is one task on the
 * same chain the claim and the enqueue use, so a lease expiring while a claim
 * is in flight can never produce a double claim.
 *
 * Expiry is judged against the service's own clock and nothing else (NFR-112);
 * tests therefore inject the stamp at the seam and never wait on a timer.
 *
 * Four properties this module owes the rest of the service (T-040):
 *
 * - **The rows are recoverable.** Every row the sweep owes is written as a
 *   durable intent in the same `runs.json` write that moved the run, using the
 *   outbox [`runs-audit.ts`](./runs-audit.ts) already drains on the next read.
 *   A failed append is therefore *retried*, not lost — the sweep has no reader
 *   to answer, so its own trail is the only operator-visible record it has.
 * - **The answer reports the live failure.** `auditWritten` on
 *   {@link SweepOutcome} is `false` when an append failed during this pass, so
 *   FR-063's "must not be swallowed" holds for the sweep as well as for the
 *   result route.
 * - **Provenance is a typed member, not an id prefix** (T-040e): the lease's
 *   `provenance` says whether adoption minted it, instead of the parser
 *   accepting any non-empty string and a sweep helper reading `migration-`.
 * - **The cadence is read before it is armed** (T-040f): the first tick is
 *   scheduled from the *stored* durations, not the defaults, so an operator
 *   who set `leaseMs` to its 30,000 ms minimum does not wait 60,000 ms for the
 *   first pass.
 */

import { nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { buildDispatchTokenFingerprint } from './run-key.ts';
import { sweepAuditRow } from './runs-audit.ts';
import { inQueueChain, readRunsDocument, writeRunsDocument } from './runs-document.ts';
import { MAX_AUTO_REQUEUES, expireLease, parkRun, wedgeUnconfirmed } from './runs-transitions.ts';
import type { Run, RunLease, RunState, RunsDocument } from './runs-types.ts';

/** The timer lives beside this module; re-exported so callers keep one path. */
export { readSweepDurations, startSweep, sweepIntervalMs } from './sweep-loop.ts';
export type { SweepDurations, SweepLoop, SweepLoopInput } from './sweep-loop.ts';

/** One recovery the sweep performed, with the reason it recorded. */
export interface SweepRecovery {
    /** The run as it now stands. */
    readonly run: Run;
    /** Audit vocabulary this recovery wrote. */
    readonly eventType: 'dispatch.lease-expired' | 'run.dead_lettered' | 'dispatch.unconfirmed';
    /** Prior state the run left. */
    readonly priorState: RunState;
    /** Secret-free reason naming the exact cause. */
    readonly reason: string;
    /** Structured, credential-free details for the audit row. */
    readonly details: Readonly<Record<string, string | number | boolean | null>>;
    /**
     * The durable intent that will (re)write this row if the append fails.
     *
     * Carried on the recovery rather than rebuilt at write time so the row the
     * outbox later appends is byte-for-byte the row this pass owed, even if the
     * run has moved on in between.
     */
    readonly intent: SweepAuditIntent;
}

/** The audit vocabulary entries the sweep's rows belong to. */
export type SweepEventType = SweepRecovery['eventType'];

/** A durable intent for one sweep row, replayed by the run-audit outbox. */
export interface SweepAuditIntent {
    /** The row's vocabulary name. */
    readonly eventType: SweepEventType;
    /** The run this row concerns (FR-062: never a fresh identifier). */
    readonly correlationId: string;
    /** The decision the row records. */
    readonly decision: string;
    /** Secret-free reason naming the exact cause. */
    readonly reason: string;
    /** Structured, credential-free details; never a dispatch token value. */
    readonly details: Readonly<Record<string, string | number | boolean | null>>;
    /**
     * What makes this row distinct from an earlier one for the same run.
     *
     * The outbox retires an intent by finding a matching row, and a run can be
     * lease-expired three times: without a discriminator the second recovery
     * would match the first row and never be written.
     */
    readonly sequence: string;
}

/** What one sweep pass changed. */
export interface SweepOutcome {
    /** Every recovery this pass made, in run order. */
    readonly recoveries: readonly SweepRecovery[];
    /**
     * Whether every row this pass owed reached the trail.
     *
     * `false` means the recovery is durable and the row is not **yet** — the
     * durable intent will write it on the next run-document read. Reported so
     * the boot pass and any caller can see a degraded trail.
     */
    readonly auditWritten: boolean;
}

/** One run's recovery, before it is written. */
interface PlannedRecovery {
    /** The run as it will stand. */
    readonly run: Run;
    /** The row this pass owes it. */
    readonly recovery: SweepRecovery;
}

/**
 * The automatic requeue budget, as a secret-free reason line.
 *
 * @param requeuesUsed - Automatic requeues the run has already consumed.
 * @returns The reason an exhausted run is parked with.
 */
function budgetReason(requeuesUsed: number): string {
    return `automatic requeue budget exhausted after ${requeuesUsed} requeues`;
}

/** The reason an ordinary lease expiry is recorded under. */
const LEASE_EXPIRED_REASON = 'lease expired without a reservation';

/** The reason an adopted claim's recovery is recorded under (data-model §1). */
const MIGRATION_RECOVERY_REASON = 'lease expired on migration recovery after upgrade';

/**
 * Park a run whose next requeue would exceed the automatic budget.
 *
 * The budget bounds how often a crashed panel can requeue one run, so the run
 * that would exceed it stops moving and waits for an operator. The
 * attempt and the budget counters keep the values that explain the park — the
 * operator's return-to-waiting is the thing that resets them.
 *
 * @param input - The expired run, its lease, and the service-clock stamp.
 * @returns The recovery, or `null` when the run must not be parked.
 */
function parkExhaustedRun(input: {
    /** The run whose lease just expired. */
    readonly run: Run;
    /** The lease that expired. */
    readonly lease: RunLease;
    /** Service-clock stamp. */
    readonly now: string;
}): PlannedRecovery | null {
    const { run, lease, now } = input;
    if (run.requeuesUsed < MAX_AUTO_REQUEUES) {
        return null;
    }

    const parked = parkRun({ run, now, reason: budgetReason(run.requeuesUsed) });
    if (parked === null) {
        return null;
    }

    const reason = budgetReason(run.requeuesUsed);
    const details = {
        priorState: run.state,
        leaseId: lease.leaseId,
        leaseExpiry: lease.expiresAt,
        attemptBefore: run.attempt,
        attemptAfter: parked.attempt,
        requeuesUsed: run.requeuesUsed,
        budget: MAX_AUTO_REQUEUES,
    };

    return {
        run: parked,
        recovery: {
            run: parked,
            eventType: 'run.dead_lettered',
            priorState: run.state,
            reason,
            details,
            intent: {
                eventType: 'run.dead_lettered',
                correlationId: parked.correlationId,
                decision: 'dead-lettered',
                reason,
                details,
                sequence: `${lease.leaseId}:${parked.attempt}`,
            },
        },
    };
}

/**
 * Recover one run whose lease expired with no reservation.
 *
 * A **migrated** claim — the synthetic lease adoption mints for a legacy
 * `in-flight` row, which the lease's `provenance` names — is recovered once as
 * migration recovery and is *not* charged to the budget (data-model §1, plan
 * migration table): the budget bounds a crashed-panel loop, and a one-shot
 * adoption cannot loop.
 *
 * @param input - The expired run and the service-clock stamp.
 * @returns The recovery, or `null` when the run is not an expired claim.
 */
function recoverExpiredLease(input: { readonly run: Run; readonly now: string }): PlannedRecovery | null {
    const { run, now } = input;
    const { lease } = run;
    if (lease === null) {
        return null;
    }

    const isMigration = lease.provenance === 'migration';
    const requeued = expireLease({ run, now, chargeBudget: !isMigration });
    if (requeued === null) {
        return null;
    }

    if (!isMigration) {
        const parked = parkExhaustedRun({ run, lease, now });
        if (parked !== null) {
            return parked;
        }
    }

    const reason = isMigration ? MIGRATION_RECOVERY_REASON : LEASE_EXPIRED_REASON;
    const details = {
        priorState: run.state,
        leaseId: lease.leaseId,
        leaseExpiry: lease.expiresAt,
        attemptBefore: run.attempt,
        attemptAfter: requeued.attempt,
        requeuesBefore: run.requeuesUsed,
        requeuesAfter: requeued.requeuesUsed,
        budget: MAX_AUTO_REQUEUES,
        migrationRecovery: isMigration,
    };

    return {
        run: requeued,
        recovery: {
            run: requeued,
            eventType: 'dispatch.lease-expired',
            priorState: run.state,
            reason,
            details,
            intent: {
                eventType: 'dispatch.lease-expired',
                correlationId: requeued.correlationId,
                decision: 'requeued',
                reason,
                details,
                sequence: `${lease.leaseId}:${requeued.attempt}`,
            },
        },
    };
}

/**
 * Wedge one run whose result never arrived.
 *
 * The row records the outstanding token's **fingerprint**, never the token
 * (T-040c): an unconsumed dispatch token is a live authorization to report a
 * result, this file is operator-facing and retained for months, and the row
 * still answers which token was outstanding because the fingerprint is derived
 * from it and is reproducible by the service.
 *
 * @param input - The authorized run and the service-clock stamp.
 * @returns The recovery, or `null` when the run is not past its deadline.
 */
function recoverLateResult(input: { readonly run: Run; readonly now: string }): PlannedRecovery | null {
    const { run, now } = input;
    const { reservation } = run;
    if (reservation === null || Date.parse(reservation.resultDeadlineAt) > Date.parse(now)) {
        return null;
    }

    const wedged = wedgeUnconfirmed({ run, now });
    if (wedged === null) {
        return null;
    }

    const reason = `no dispatch result by ${reservation.resultDeadlineAt}`;
    const details = {
        priorState: run.state,
        attempt: run.attempt,
        dispatchTokenFingerprint: buildDispatchTokenFingerprint(reservation.dispatchToken),
        deadline: reservation.resultDeadlineAt,
    };

    return {
        run: wedged,
        recovery: {
            run: wedged,
            eventType: 'dispatch.unconfirmed',
            priorState: run.state,
            reason,
            details,
            intent: {
                eventType: 'dispatch.unconfirmed',
                correlationId: wedged.correlationId,
                decision: 'unconfirmed',
                reason,
                details,
                sequence: `${run.attempt}:${reservation.resultDeadlineAt}`,
            },
        },
    };
}

/**
 * Decide every recovery one pass makes, without writing anything.
 *
 * @param input - The document and the service-clock stamp.
 * @returns The document to persist plus the recoveries to log and audit.
 */
export function planSweep(input: {
    /** Document as stored, before this pass. */
    readonly document: RunsDocument;
    /** Service-clock stamp for the whole pass. */
    readonly now: string;
}): { readonly document: RunsDocument; readonly recoveries: readonly SweepRecovery[] } {
    const runs = [...input.document.runs];
    const recoveries: SweepRecovery[] = [];

    for (const [index, run] of runs.entries()) {
        const planned = run.state === 'claimed'
            ? recoverExpiredLease({ run, now: input.now })
            : recoverLateResult({ run, now: input.now });
        if (planned === null) {
            continue;
        }

        runs[index] = planned.run;
        recoveries.push(planned.recovery);
    }

    return { document: { ...input.document, runs }, recoveries };
}

/**
 * Append one lifecycle row; a failure never undoes the recovery.
 *
 * The row is built from the recovery's own intent through the outbox's shared
 * builder, so the row this pass writes and the row a replay would write are the
 * same bytes — which is what lets the outbox retire this intent by matching it
 * rather than appending the same recovery twice (T-040b).
 */
async function appendSweepAudit(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The recovery to record. */
    readonly recovery: SweepRecovery;
}): Promise<boolean> {
    const { recovery } = input;
    try {
        await appendAudit(input.store, sweepAuditRow(recovery.intent));

        return true;
    } catch (cause) {
        input.log.warn('dispatch sweep audit row could not be appended', {
            correlationId: recovery.run.correlationId,
            eventType: recovery.eventType,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return false;
    }
}

/**
 * Add the durable intents for a pass's recoveries to the document it persists.
 *
 * The intents travel in the **same atomic write** as the state change they
 * describe, so a crash between the recovery and its row leaves the row owed
 * rather than lost — the same durability the enqueue path gets
 * outbox, reused rather than reinvented.
 *
 * @param input - The document to persist and the recoveries it owes rows for.
 * @returns The document with its intents appended.
 */
function withIntents(input: {
    /** The document the pass decided on. */
    readonly document: RunsDocument;
    /** The recoveries the pass made. */
    readonly recoveries: readonly SweepRecovery[];
}): RunsDocument {
    return {
        ...input.document,
        auditIntents: [...(input.document.auditIntents ?? []), ...input.recoveries.map((entry) => entry.intent)],
    };
}

/**
 * Run one sweep pass: recover every expired lease and every late result.
 *
 * The durable write comes first — state **and** the intents for its rows — and
 * the audit rows follow, so a row that cannot be appended is retried by the
 * outbox on the next read rather than rolled back (FR-063, T-040b).
 *
 * @param input - Store, logger, and an injectable service-clock stamp.
 * @returns The recoveries this pass made and whether their rows reached the trail.
 * @throws {StorageUnavailableError} When the store cannot be read or written.
 */
export async function sweepOnce(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Service-clock stamp for the pass; injectable so tests never sleep. */
    readonly now?: string;
}): Promise<SweepOutcome> {
    const now = input.now ?? nowIso();
    const planned = await inQueueChain(async () => {
        // The pass adopts under *this* stamp: a boot pass that triggers the
        // first-read adoption must judge the lease it just minted with the
        // same clock sample, or a millisecond tick between the two reads makes
        // an already-expired migration lease look live and defers the one-shot
        // recovery to a later pass.
        const document = await readRunsDocument({ ...input, now });
        const outcome = planSweep({ document, now });
        if (outcome.recoveries.length === 0) {
            return outcome;
        }

        return {
            ...outcome,
            document: await writeRunsDocument({ ...input, document: withIntents(outcome) }),
        };
    });

    const written: boolean[] = [];
    for (const recovery of planned.recoveries) {
        input.log.info('dispatch sweep recovered a run', {
            correlationId: recovery.run.correlationId,
            eventType: recovery.eventType,
            priorState: recovery.priorState,
            newState: recovery.run.state,
        });
        written.push(await appendSweepAudit({ ...input, recovery }));
    }

    return { recoveries: planned.recoveries, auditWritten: written.every(Boolean) };
}
