/**
 * The run state machine: CRUD, coalescing effects, and every transition
 * (003 data-model §2.2–§2.4, T-003).
 *
 * This module is the run layer's façade — the one import path `events.ts`,
 * the routes, and the sweep take — and the home of its domain logic. The
 * mechanical halves live beside it because the 500-line gate will not hold
 * types, validators, persistence, coalescing, *and* a state machine in one
 * file, and because each has one responsibility:
 *
 * - [`runs-document.ts`](./runs-document.ts) — the shared queue+run chain,
 *   the atomic write with its terminal-run eviction, and the one-shot
 *   adoption pass (FR-005);
 * - [`runs-join.ts`](./runs-join.ts) — folding deliveries into runs (FR-011);
 * - [`runs-transitions.ts`](./runs-transitions.ts) — the pure state
 *   transitions themselves, shared with the batch claim and the sweep;
 * - [`runs-parse.ts`](./runs-parse.ts) / [`runs-types.ts`](./runs-types.ts) /
 *   [`runs-parts-parse.ts`](./runs-parts-parse.ts) / [`run-key.ts`](./run-key.ts)
 *   — schema, validation, and identity derivation.
 *
 * Every mutation below serializes onto the one chain both stores share, and
 * **none of them writes an audit row**: the operation that performs a
 * transition appends its row after this call returns, so a failed audit can
 * never roll back a durable state change (FR-063's posture, data-model §4.3).
 * Refusals answer {@link RunChange} with the run's current state, so a caller
 * can name the exact cause in its `dispatch.refused` row (FR-003).
 */

import { nowIso } from '../../src/ids.ts';
import {
    attemptHistory,
    currentAttempt,
    inQueueChain,
    readRunsDocument,
    writeRunsDocument,
} from './runs-document.ts';
import { buildDispatchToken } from './run-key.ts';
import { isRunState } from './runs-parse.ts';
import { leaseRun, parkRun } from './runs-transitions.ts';
import type { RunChange, RunTransitionInput } from './runs-document.ts';
import type { LeaseCoordinates } from './runs-transitions.ts';
import type { Run, SessionRef } from './runs-types.ts';

/** Re-exported: the run store stays the one import path for run plumbing. */
export {
    MAX_TERMINAL_RUNS,
    RUNS_FILE,
    attemptHistory,
    currentAttempt,
    emptyRunsDocument,
    ensureRunsAdopted,
    inQueueChain,
    isTerminalRun,
    openedHistory,
    readRunsDocument,
    runHistoryIndicatesSession,
    writeRunsDocument,
} from './runs-document.ts';
export { applyEnqueue } from './runs-join.ts';
export { MAX_AUTO_REQUEUES, expireLease, leaseRun, parkRun, wedgeUnconfirmed } from './runs-transitions.ts';
export type { LeaseCoordinates } from './runs-transitions.ts';
export type { EnqueueJoin, EnqueueOutcome } from './runs-join.ts';
export { MAX_ATTEMPT_RECORDS, MAX_SOURCE_REFERENCES } from './runs-parse.ts';
export type { AdoptionOutcome, RunChange, RunTransitionInput, RunsStoreInput } from './runs-document.ts';

/** Extra input one transition needs beyond {@link RunTransitionInput}. */
interface ClaimInput extends RunTransitionInput {
    /** Opaque mount id taking the lease (FR-030). */
    readonly holder: string;
    /** Lease identifier to record. */
    readonly leaseId: string;
    /** Lease issue stamp. */
    readonly issuedAt: string;
    /** Lease expiry the sweep compares to the service clock. */
    readonly expiresAt: string;
}

/** Project one claim input's lease fields onto the shared lease shape. */
function leaseCoordinatesOf(input: ClaimInput): LeaseCoordinates {
    return {
        holder: input.holder,
        leaseId: input.leaseId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        provenance: 'panel',
    };
}

/** Extra input one transition needs beyond {@link RunTransitionInput}. */
interface ReserveInput extends RunTransitionInput {
    /** Lease identifier the reservation must be made under. */
    readonly leaseId: string;
    /** Result deadline that arms `unconfirmed` if no result arrives. */
    readonly resultDeadlineAt: string;
}

/** Extra input one transition needs beyond {@link RunTransitionInput}. */
interface ResultInput extends RunTransitionInput {
    /** Session the dispatch created, or `null` when it created none. */
    readonly sessionId: string | null;
    /** Failure text for a dispatch that created no session. */
    readonly problem: string | null;
}

/**
 * Apply one state change to one run, serialized onto the shared chain.
 *
 * @param input - Store, logger, correlation id, and stamp.
 * @param apply - The transition; returns `null` to refuse it (the run is not
 *   in a state this transition accepts) without writing anything.
 * @returns What the transition did.
 */
async function changeRun(
    input: RunTransitionInput,
    apply: (run: Run, now: string) => Run | null,
): Promise<RunChange> {
    const now = input.now ?? nowIso();

    return await inQueueChain(async (): Promise<RunChange> => {
        const document = await readRunsDocument(input);
        const index = document.runs.findIndex((run) => run.correlationId === input.correlationId);
        const current = document.runs[index];
        if (current === undefined) {
            return { status: 'not-found' };
        }

        const next = apply(current, now);
        if (next === null) {
            return { status: 'refused', state: current.state };
        }

        const runs = [...document.runs];
        runs[index] = next;
        await writeRunsDocument({ store: input.store, log: input.log, document: { ...document, runs } });

        return { status: 'applied', run: next };
    });
}

/**
 * Claim one waiting run for one panel: lease issued, attempt opened (FR-030).
 *
 * @param input - Lease coordinates plus the run being claimed.
 * @returns The claimed run, or why it was not claimable.
 */
export async function claimRun(input: ClaimInput): Promise<RunChange> {
    return await changeRun(input, (run, now) => leaseRun({
        run,
        lease: leaseCoordinatesOf(input),
        now,
    }));
}

/**
 * Reserve one dispatch: single-use token minted, state moves to `starting`
 * (FR-020, FR-021). Minted **only** here — never at claim (plan D4).
 *
 * @param input - The lease the reservation is made under and its deadline.
 * @returns The starting run, or why nothing was authorized.
 */
export async function reserveRun(input: ReserveInput): Promise<RunChange> {
    return await changeRun(input, (run, now) => {
        if (run.state !== 'claimed' || run.lease?.leaseId !== input.leaseId) {
            return null;
        }

        if (run.reservation !== null || run.session !== null) {
            return null;
        }

        const dispatchToken = buildDispatchToken(run.runKey, run.attempt);

        return {
            ...run,
            state: 'starting',
            stateReason: `authorized at ${now}; result due by ${input.resultDeadlineAt}`,
            reservation: {
                dispatchToken,
                attempt: run.attempt,
                reservedAt: now,
                resultDeadlineAt: input.resultDeadlineAt,
                consumed: false,
            },
            attempts: attemptHistory(run, { ...currentAttempt(run), dispatchToken, reservedAt: now }),
            updatedAt: now,
        };
    });
}

/**
 * Build the session pointer a dispatch result records (002 Key Entities:
 * SessionRef). The run keeps the pointer only — OpenChamber owns the session.
 *
 * @param input - The run that produced the session, its id, and the stamp.
 * @returns The reference stored on the run.
 */
function sessionRefOf(input: { readonly run: Run; readonly sessionId: string; readonly now: string }): SessionRef {
    return {
        sessionId: input.sessionId,
        attachmentId: input.run.attachmentId,
        dispatchedAt: input.now,
        title: '',
        sourceUrl: input.run.sourceReferences[0]?.sourceUrl ?? '',
        worktree: null,
    };
}

/**
 * Classify one reported result: a session id is `dispatched`, its absence is
 * `failed` — the distinction FR-040 exists to keep visible.
 *
 * @param input - The result being applied.
 * @returns The outcome the attempt record carries.
 */
function outcomeOf(input: ResultInput): 'dispatched' | 'failed' {
    return input.sessionId === null ? 'failed' : 'dispatched';
}

/**
 * Record the outcome of an authorized attempt: a session makes the run
 * `dispatched`, its absence makes it `failed` — never `dispatched` (FR-040).
 *
 * @param input - The session the dispatch created, or its failure text.
 * @returns The terminal run, or why the report was refused.
 */
export async function applyResult(input: ResultInput): Promise<RunChange> {
    return await changeRun(input, (run, now) => {
        if (run.state !== 'starting' && run.state !== 'unconfirmed') {
            return null;
        }

        if (run.session !== null || run.reservation === null || run.reservation.consumed) {
            return null;
        }

        const reservation = { ...run.reservation, consumed: true };
        const attempts = attemptHistory(run, {
            ...currentAttempt(run),
            outcome: outcomeOf(input),
            sessionId: input.sessionId,
            reason: input.problem,
            resultReportedAt: now,
        });

        if (input.sessionId === null) {
            return {
                ...run,
                state: 'failed',
                stateReason: input.problem ?? 'dispatch produced no session',
                reservation,
                attempts,
                updatedAt: now,
            };
        }

        return {
            ...run,
            state: 'dispatched',
            stateReason: `session ${input.sessionId} created`,
            reservation,
            attempts,
            session: sessionRefOf({ run, sessionId: input.sessionId, now }),
            updatedAt: now,
        };
    });
}

/**
 * Record an honest abandonment: a reserved attempt that created no session
 * becomes retryable `failed`, never `unconfirmed` (FR-026).
 *
 * @param input - The reason the panel could not start a session.
 * @returns The failed run, or why the report was refused.
 */
export async function abandonRun(input: RunTransitionInput & { readonly reason: string }): Promise<RunChange> {
    return await changeRun(input, (run, now) => {
        if (run.state !== 'starting' || run.session !== null || run.reservation === null) {
            return null;
        }

        return {
            ...run,
            state: 'failed',
            stateReason: input.reason,
            reservation: { ...run.reservation, consumed: true },
            attempts: attemptHistory(run, {
                ...currentAttempt(run),
                outcome: 'abandoned',
                reason: input.reason,
                resultReportedAt: now,
            }),
            updatedAt: now,
        };
    });
}

/**
 * Hold a claimed run in `blocked:<reason>` after a fail-closed guard refused
 * before any host call (FR-042). No attempt is consumed: a guard refusal
 * burns neither attempt nor requeue budget.
 *
 * @param input - The blocked state to hold and the cause to record.
 * @returns The blocked run, or why the report was refused.
 */
export async function blockRun(
    input: RunTransitionInput & { readonly blockedState: string; readonly reason: string },
): Promise<RunChange> {
    return await changeRun(input, (run, now) => {
        if (run.state !== 'claimed' || run.session !== null || !isRunState(input.blockedState)) {
            return null;
        }

        if (!input.blockedState.startsWith('blocked:')) {
            return null;
        }

        return {
            ...run,
            state: input.blockedState,
            stateReason: input.reason,
            lease: null,
            attempts: attemptHistory(run, {
                ...currentAttempt(run),
                outcome: 'blocked',
                reason: input.reason,
                resultReportedAt: now,
            }),
            updatedAt: now,
        };
    });
}

/**
 * Return a `failed` or `blocked:*` run to waiting under the same run key with
 * the attempt incremented (FR-041). The automatic requeue budget is untouched:
 * only an expired claim consumes it (plan D5).
 *
 * @param input - The run to retry.
 * @returns The waiting run, or why the retry was refused.
 */
export async function retryRun(input: RunTransitionInput): Promise<RunChange> {
    return await changeRun(input, (run, now) => {
        const retryable = run.state === 'failed' || run.state.startsWith('blocked:');
        if (!retryable || run.session !== null) {
            return null;
        }

        return {
            ...run,
            state: 'pending',
            stateReason: null,
            attempt: run.attempt + 1,
            lease: null,
            reservation: null,
            updatedAt: now,
        };
    });
}

/**
 * Return a dead-lettered run to waiting with the attempt and requeue counters
 * reset — the explicit operator action FR-033 requires (plan D6: the reset
 * also clears attempt-scoped token consumption; history rows survive).
 *
 * @param input - The run to return to waiting.
 * @returns The waiting run, or why the requeue was refused.
 */
export async function requeueRun(input: RunTransitionInput): Promise<RunChange> {
    return await changeRun(input, (run, now) => {
        if (run.state !== 'dead-lettered') {
            return null;
        }

        return {
            ...run,
            state: 'pending',
            stateReason: null,
            attempt: 1,
            requeuesUsed: 0,
            lease: null,
            reservation: null,
            updatedAt: now,
        };
    });
}

/**
 * Resolve an `unconfirmed` run on the operator's explicit word (FR-027):
 * `sessionId` names the session that exists, `null` states none was created
 * — the only path that re-dispatches an unconfirmed run.
 *
 * @param input - The session the operator confirmed, or `null`.
 * @returns The resolved run, or why the resolution was refused.
 */
export async function resolveRun(
    input: RunTransitionInput & { readonly sessionId: string | null },
): Promise<RunChange> {
    return await changeRun(input, (run, now) => {
        if (run.state !== 'unconfirmed' || run.session !== null) {
            return null;
        }

        const reservation = run.reservation === null ? null : { ...run.reservation, consumed: true };
        if (input.sessionId === null) {
            return {
                ...run,
                state: 'pending',
                stateReason: null,
                attempt: run.attempt + 1,
                lease: null,
                reservation,
                updatedAt: now,
            };
        }

        return {
            ...run,
            state: 'dispatched',
            stateReason: `operator confirmed session ${input.sessionId}`,
            reservation,
            attempts: attemptHistory(run, {
                ...currentAttempt(run),
                outcome: 'dispatched',
                sessionId: input.sessionId,
                resultReportedAt: now,
            }),
            session: sessionRefOf({ run, sessionId: input.sessionId, now }),
            updatedAt: now,
        };
    });
}

/**
 * Park a run in `dead-lettered`: the requeue budget is exhausted, or the
 * operator parked it. Terminal runs and runs that already produced a session
 * are never parked (FR-028, FR-033).
 *
 * @param input - The run to park and the cause to record.
 * @returns The parked run, or why the park was refused.
 */
export async function deadLetterRun(input: RunTransitionInput & { readonly reason: string }): Promise<RunChange> {
    return await changeRun(input, (run, now) => parkRun({ run, now, reason: input.reason }));
}
