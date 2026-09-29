/**
 * The lease/deadline sweep (003 FR-032, FR-033, FR-023, FR-036; T-009).
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
 */

import { nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import { CONFIG_FILE, DEFAULT_CONFIG, configFromStore, parseStoredConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { isMigrationLease } from './runs-adopt.ts';
import { inQueueChain, readRunsDocument, writeRunsDocument } from './runs-document.ts';
import { MAX_AUTO_REQUEUES, expireLease, parkRun, wedgeUnconfirmed } from './runs-transitions.ts';
import type { Run, RunLease, RunState, RunsDocument } from './runs-types.ts';

/** The two durations the sweep reads; also the knobs it reschedules on. */
interface SweepDurations {
    /** Lease duration in milliseconds. */
    readonly leaseMs: number;
    /** Result deadline in milliseconds. */
    readonly resultDeadlineMs: number;
}

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
}

/** What one sweep pass changed. */
export interface SweepOutcome {
    /** Every recovery this pass made, in run order. */
    readonly recoveries: readonly SweepRecovery[];
}

/** One run's recovery, before it is written. */
interface PlannedRecovery {
    /** The run as it will stand. */
    readonly run: Run;
    /** The row this pass owes it. */
    readonly recovery: SweepRecovery;
}

/**
 * The automatic requeue budget, as a secret-free reason line (FR-033).
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
 * that would exceed it stops moving and waits for an operator (FR-033). The
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

    return {
        run: parked,
        recovery: {
            run: parked,
            eventType: 'run.dead_lettered',
            priorState: run.state,
            reason: budgetReason(run.requeuesUsed),
            details: {
                priorState: run.state,
                leaseId: lease.leaseId,
                leaseExpiry: lease.expiresAt,
                attemptBefore: run.attempt,
                attemptAfter: parked.attempt,
                requeuesUsed: run.requeuesUsed,
                budget: MAX_AUTO_REQUEUES,
            },
        },
    };
}

/**
 * Recover one run whose lease expired with no reservation (FR-032).
 *
 * A **migrated** claim — the synthetic lease adoption mints for a legacy
 * `in-flight` row — is recovered once as migration recovery and is *not*
 * charged to the budget (data-model §1, plan migration table): the budget
 * bounds a crashed-panel loop, and a one-shot adoption cannot loop.
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

    const migration = isMigrationLease(lease.leaseId);
    const requeued = expireLease({ run, now, chargeBudget: !migration });
    if (requeued === null) {
        return null;
    }

    if (!migration) {
        const parked = parkExhaustedRun({ run, lease, now });
        if (parked !== null) {
            return parked;
        }
    }

    return {
        run: requeued,
        recovery: {
            run: requeued,
            eventType: 'dispatch.lease-expired',
            priorState: run.state,
            reason: migration ? MIGRATION_RECOVERY_REASON : LEASE_EXPIRED_REASON,
            details: {
                priorState: run.state,
                leaseId: lease.leaseId,
                leaseExpiry: lease.expiresAt,
                attemptBefore: run.attempt,
                attemptAfter: requeued.attempt,
                requeuesBefore: run.requeuesUsed,
                requeuesAfter: requeued.requeuesUsed,
                budget: MAX_AUTO_REQUEUES,
                migrationRecovery: migration,
            },
        },
    };
}

/**
 * Wedge one run whose result never arrived (FR-023).
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

    return {
        run: wedged,
        recovery: {
            run: wedged,
            eventType: 'dispatch.unconfirmed',
            priorState: run.state,
            reason: `no dispatch result by ${reservation.resultDeadlineAt}`,
            details: {
                priorState: run.state,
                attempt: run.attempt,
                dispatchToken: reservation.dispatchToken,
                deadline: reservation.resultDeadlineAt,
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
 * The decision each sweep row records (003 `## Audit Vocabulary`).
 *
 * @param recovery - The recovery being written.
 * @returns `requeued`, `dead-lettered`, or `unconfirmed`.
 */
function decisionFor(recovery: SweepRecovery): string {
    if (recovery.eventType === 'run.dead_lettered') {
        return 'dead-lettered';
    }

    return recovery.eventType === 'dispatch.unconfirmed' ? 'unconfirmed' : 'requeued';
}

/** Append one lifecycle row; a failure never undoes the recovery. */
async function appendSweepAudit(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The recovery to record. */
    readonly recovery: SweepRecovery;
}): Promise<void> {
    const { recovery } = input;
    try {
        await appendAudit(input.store, {
            eventType: recovery.eventType,
            actorSource: 'service',
            entity: { kind: 'run', id: recovery.run.correlationId },
            correlationId: recovery.run.correlationId,
            decision: decisionFor(recovery),
            reason: recovery.reason,
            details: recovery.details,
        });
    } catch (cause) {
        input.log.warn('dispatch sweep audit row could not be appended', {
            correlationId: recovery.run.correlationId,
            eventType: recovery.eventType,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    }
}

/**
 * Run one sweep pass: recover every expired lease and every late result.
 *
 * The durable write comes first and the audit rows follow, so a row that
 * cannot be appended is logged and surfaced rather than rolling a recovery
 * back (FR-063).
 *
 * @param input - Store, logger, and an injectable service-clock stamp.
 * @returns The recoveries this pass made; empty when there was nothing to do.
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
        const document = await readRunsDocument(input);
        const outcome = planSweep({ document, now });
        if (outcome.recoveries.length === 0) {
            return outcome;
        }

        return { ...outcome, document: await writeRunsDocument({ ...input, document: outcome.document }) };
    });

    for (const recovery of planned.recoveries) {
        input.log.info('dispatch sweep recovered a run', {
            correlationId: recovery.run.correlationId,
            eventType: recovery.eventType,
            priorState: recovery.priorState,
            newState: recovery.run.state,
        });
        await appendSweepAudit({ ...input, recovery });
    }

    return { recoveries: planned.recoveries };
}

/** Read the two sweep durations, answering the defaults when unreadable. */
async function readDurations(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
}): Promise<SweepDurations> {
    try {
        const stored = await input.store.readJson(CONFIG_FILE, parseStoredConfig);
        const config = configFromStore(stored, input.log);

        return { leaseMs: config.leaseMs, resultDeadlineMs: config.resultDeadlineMs };
    } catch (cause) {
        input.log.warn('sweep cadence read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return { leaseMs: DEFAULT_CONFIG.leaseMs, resultDeadlineMs: DEFAULT_CONFIG.resultDeadlineMs };
    }
}

/**
 * The cadence one tick waits before the next: half the shorter of the two
 * durations, so every lease and every result deadline is examined at least
 * twice inside its own window (FR-032's "at least once per lease duration"),
 * independently of the poll interval — a 300 s poll cadence must not push the
 * lease sweep past its own bound.
 *
 * @param durations - The configured lease and result deadline.
 * @returns Milliseconds between ticks.
 */
export function sweepIntervalMs(durations: SweepDurations): number {
    return Math.floor(Math.min(durations.leaseMs, durations.resultDeadlineMs) / 2);
}

/** A running sweep, stopped on shutdown. */
export interface SweepLoop {
    /** Cancel the pending tick; a pass in flight finishes on its own. */
    stop(): void;
}

/**
 * Start the periodic sweep on its own unref'd timer.
 *
 * The timer is unref'd so it never keeps an idle process alive, and each tick
 * re-reads the configured durations, so `PUT /v1/config` retunes the cadence
 * without a restart. A tick still running when the next one fires is skipped,
 * never overlapped: the sweep is a chain task, and two passes would only
 * contend for the same lock.
 *
 * @param input - Store and logger.
 * @returns A handle that stops the timer.
 */
export function startSweep(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
}): SweepLoop {
    const state = { timer: null as NodeJS.Timeout | null, stopped: false, inFlight: false };

    /** Read through a function so the compiler cannot narrow the flag away. */
    const halted = (): boolean => state.stopped;

    const cycle = async (): Promise<void> => {
        if (halted() || state.inFlight) {
            return;
        }

        state.inFlight = true;
        const durations = await readDurations(input);
        try {
            await sweepOnce(input);
        } catch (cause) {
            input.log.warn('dispatch sweep pass failed', {
                errorKind: cause instanceof Error ? cause.name : typeof cause,
            });
        } finally {
            state.inFlight = false;
        }

        // A shutdown that landed mid-pass must not re-arm the timer.
        if (!halted()) {
            state.timer = setTimeout(() => {
                state.timer = null;
                void cycle();
            }, sweepIntervalMs(durations));
            state.timer.unref();
        }
    };

    state.timer = setTimeout(() => {
        state.timer = null;
        void cycle();
    }, sweepIntervalMs(DEFAULT_CONFIG));
    state.timer.unref();

    return {
        stop: (): void => {
            state.stopped = true;
            if (state.timer !== null) {
                clearTimeout(state.timer);
                state.timer = null;
            }
        },
    };
}
