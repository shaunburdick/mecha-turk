/**
 * The operator operations: retry, return-to-waiting, and resolve (003
 * FR-027, FR-033, FR-041; contract §6–§8). The verification report lives
 * in `run-verify.ts`.
 */

import { readBindings } from '../bindings-read.ts';
import type { BindingRecord } from '../bindings.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { appendRunRow, resolvedRow, retryRow } from './dispatch-audit.ts';
import {
    CAUSE_NOT_CLEARED,
    CORROBORATED_BLOCKED_REASONS,
    CORROBORATED_BINDING_REASON,
    judgeActorCause,
} from './run-corroborate.ts';
import { appendRefusalRow, operateRun, sessionRefOf } from './run-chain.ts';
import { STALE_LEASE_CODE, refuse, staleAttemptMessage } from './run-refusal.ts';
import type { CauseSource } from './run-corroborate.ts';
import type { RunApplied, RunNotFound, RunRefused, RunRefusal } from './run-refusal.ts';
import { attemptHistory, currentAttempt, runHistoryIndicatesSession } from './runs-document.ts';
import type { Run, RunState } from './runs-types.ts';

// The corroboration split — which blocked causes the service can re-check
// itself, and how — lives in `run-corroborate.ts`, extracted for the size bound.
export { CAUSE_NOT_CLEARED, judgeActorCause } from './run-corroborate.ts';

/** The two explicit resolutions of an `unconfirmed` run. */
export type ResolveDecision = 'session-created' | 'no-session';

/**
 * The operations this family names in a refusal row.
 *
 * `verification` lives in [`run-verify.ts`](./run-verify.ts) — split out for the
 * size bound — and borrows this module's refusal writer, which is why the name
 * stays in the union.
 */
export type OperateName = 'retry' | 'requeue' | 'resolve' | 'verification';

/** The wire code every state verdict in this module carries. */
const INVALID_TRANSITION = 'invalid-transition';

/** What a run operation answered, including the "no such run" case. */
export type OperationResult = RunApplied | RunRefused | RunNotFound;

/** The operation's store and logger, shared by every refusal helper. */
export interface RefusalTarget {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}

/**
 * The distinct verdict each refusing state gets (FR-041, contract §6).
 *
 * Written as a table rather than composed from a template because the whole
 * point of the requirement is that these read differently: "already waiting"
 * tells the operator nothing is wrong, "a dispatched run cannot be retried"
 * tells them the opposite, and a generic refusal would collapse them into one.
 */
function invalidTransition(state: RunState): RunRefusal {
    const messages: ReadonlyMap<RunState, string> = new Map<RunState, string>([
        ['pending', 'this run is already waiting for a panel'],
        ['dispatched', 'this run is already dispatched; a dispatched run cannot be retried'],
        ['unconfirmed', 'this run is unconfirmed; resolve it instead, a retry would discard the evidence'],
        ['claimed', 'an attempt is in flight; this run holds a live claim'],
        ['starting', 'an attempt is in flight; this run is already authorized to start'],
        ['dead-lettered', 'this run is dead-lettered; use return-to-waiting, which resets the attempt count'],
    ]);

    return refuse(INVALID_TRANSITION, messages.get(state) ?? `this run is ${state}; it cannot be retried`);
}

/**
 * Answer a refused operator call with its one `dispatch.refused` row.
 *
 * Exported because [`run-verify.ts`](./run-verify.ts) answers its own refusals
 * the same way: one writer for the family is what keeps "every refusal writes
 * exactly one row naming its cause" true across all five operations.
 */
export async function refused(input: RefusalTarget & {
    readonly run: Run;
    /** Which operation the caller attempted. */
    readonly operation: OperateName;
    readonly refusal: RunRefusal;
}): Promise<RunRefused> {
    const { run, operation, refusal, store, log } = input;

    return {
        status: 'refused',
        refusal,
        run,
        auditWritten: await appendRefusalRow({
            store,
            log,
            refusal: { run, operation, refusal, attempt: run.attempt },
        }),
    };
}

/**
 * Judge a retry (contract §6). The presented attempt is checked **before**
 * the state: §6's body carries it, and the contract's common-body rule is
 * that a mismatch is a refusal rather than a partial apply — a retry judged
 * against a state the run has already left would increment a counter the
 * caller never saw, which is precisely the half-apply that rule exists to
 * prevent.
 */
function judgeRetry(input: {
    /** The run the operator acted on. */
    readonly run: Run;
    /** Attempt the operator's request names. */
    readonly attempt: number;
    /** Whether the operator reported the cause cleared. */
    readonly causeCleared: boolean;
    readonly bindings: readonly BindingRecord[];
}): RunRefusal | CauseSource {
    const { run, causeCleared, bindings } = input;
    if (input.attempt !== run.attempt) {
        return refuse(STALE_LEASE_CODE, staleAttemptMessage(input.attempt, run.attempt));
    }

    if (run.state === 'failed') {
        return null;
    }

    if (!run.state.startsWith('blocked:')) {
        return invalidTransition(run.state);
    }

    const blockedReason = run.state.slice('blocked:'.length);
    if (!CORROBORATED_BLOCKED_REASONS.has(blockedReason)) {
        // Not a cause the service can check itself: the panel's same-mount check
        // is the only evidence, and it is audited as *reported* (constitution IV).
        return causeCleared
            ? 'reported'
            : refuse(
                CAUSE_NOT_CLEARED,
                `the cause has not cleared: report the ${blockedReason} cause as cleared once it is, so this `
                + 'row records what was checked',
            );
    }

    if (blockedReason === CORROBORATED_BINDING_REASON) {
        return bindings.some((binding) => binding.bindingId === run.bindingId)
            ? 'corroborated'
            : refuse(CAUSE_NOT_CLEARED, `the cause has not cleared: the binding ${run.bindingId} is still absent`);
    }

    return judgeActorCause({ run, bindings });
}

/**
 * Build the waiting run a retry produces.
 */
function waitingRun(input: { readonly run: Run; readonly now: string }): Run {
    const { run, now } = input;

    return {
        ...run,
        state: 'pending',
        stateReason: null,
        attempt: run.attempt + 1,
        lease: null,
        reservation: null,
        updatedAt: now,
    };
}

/** What one `dispatch.retry` row records, for either shape of the action. */
interface RetryRowInput {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The waiting run as it now stands. */
    readonly run: Run;
    /** The state the operator acted on. */
    readonly priorState: RunState;
    /** Attempt before the operator's action. */
    readonly attemptBefore: number;
    /** Whether the operator reported the cause cleared, else `null`. */
    readonly causeReportedCleared: boolean | null;
    /** Whether the service corroborated it, the panel reported it, or neither. */
    readonly causeClearedSource: CauseSource;
    /** Whether this action reset the attempt chain. */
    readonly reset: boolean;
    /** The operator's or panel's own words about the cause. */
    readonly causeReport: string | null;
}

/**
 * Write one `dispatch.retry` row, covering both shapes FR-041 and FR-033 require.
 *
 * `reset` is what makes the dead-letter return legible in the trail, because it
 * is the action that starts a fresh token-consumption chain.
 */
async function appendRetryRow(input: RetryRowInput): Promise<boolean> {
    const { run, store, log, ...rest } = input;

    return await appendRunRow({
        store,
        log,
        correlationId: run.correlationId,
        row: retryRow({
            run,
            ...rest,
            attemptAfter: run.attempt,
        }),
    });
}

/**
 * Return a `failed` or `blocked:*` run to waiting under the same run key.
 *
 * The run keeps its source references and every prior attempt's record, and the
 * automatic requeue budget is untouched: only an expired claim consumes it.
 *
 * @returns The waiting run, or the distinct refusal naming why it did not move.
 */
export async function retryDispatch(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The run to retry, by correlation id. */
    readonly correlationId: string;
    /** Attempt the operator believes is current. */
    readonly attempt: number;
    /** Whether the operator reported the cause cleared. */
    readonly causeCleared: boolean;
    /** The operator's own words about the cause. */
    readonly causeReport: string | null;
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}): Promise<OperationResult> {
    const bindings = await readBindings({ store: input.store, log: input.log });

    return await operateRun(input, async ({ run, now, persist }): Promise<OperationResult> => {
        const verdict = judgeRetry({
            run,
            attempt: input.attempt,
            causeCleared: input.causeCleared,
            bindings,
        });
        if (verdict !== null && typeof verdict === 'object') {
            return await refused({ ...input, run, operation: 'retry', refusal: verdict });
        }

        const source: CauseSource = verdict;
        const priorState = run.state;
        const attemptBefore = run.attempt;
        const retried = waitingRun({ run, now });
        await persist(retried);

        return { status: 'applied', run: retried, auditWritten: await appendRetryRow({
            store: input.store,
            log: input.log,
            run: retried,
            priorState,
            attemptBefore,
            causeReportedCleared: priorState.startsWith('blocked:') ? input.causeCleared : null,
            causeClearedSource: source,
            reset: false,
            causeReport: input.causeReport,
        }) };
    });
}

/**
 * Return a dead-lettered run to waiting with the attempt and requeue
 * counters reset — the single control that resolves it. The reset is also
 * what starts a fresh token-consumption chain: consumption is scoped per
 * attempt, and `attempt = 1` re-derives a token no earlier report could
 * have consumed. The history rows survive untouched, which is what makes
 * the boundary legible to an operator reading the trail.
 */
export async function requeueDispatch(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The run to return to waiting, by correlation id. */
    readonly correlationId: string;
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}): Promise<OperationResult> {
    return await operateRun(input, async ({ run, now, persist }): Promise<OperationResult> => {
        if (run.state !== 'dead-lettered') {
            return await refused({
                ...input,
                run,
                operation: 'requeue',
                refusal: refuse(
                    INVALID_TRANSITION,
                    `this run is ${run.state}; only a dead-lettered run can be returned to waiting`,
                ),
            });
        }

        const attemptBefore = run.attempt;
        const waiting: Run = {
            ...run,
            state: 'pending',
            stateReason: null,
            attempt: 1,
            requeuesUsed: 0,
            lease: null,
            reservation: null,
            updatedAt: now,
        };
        await persist(waiting);

        return { status: 'applied', run: waiting, auditWritten: await appendRetryRow({
            store: input.store,
            log: input.log,
            run: waiting,
            priorState: run.state,
            attemptBefore,
            causeReportedCleared: null,
            causeClearedSource: null,
            reset: true,
            causeReport: null,
        }) };
    });
}

/**
 * Judge a resolve (contract §8).
 *
 * @returns The refusal, or `null` when this `unconfirmed` run may be resolved.
 */
function judgeResolve(input: { readonly run: Run }): RunRefusal | null {
    const { run } = input;
    if (run.state === 'unconfirmed') {
        return runHistoryIndicatesSession(run)
            ? refuse(INVALID_TRANSITION, 'this run already records a session and cannot be resolved')
            : null;
    }

    return refuse(INVALID_TRANSITION, `this run is ${run.state}; only an unconfirmed run can be resolved`);
}

/**
 * Build the run an operator's resolution produces.
 *
 * `sessionId` is terminal and stores the session the operator named, with the
 * attempt record naming it **in the same write** — the store's parser refuses a
 * session on a run that is not `dispatched`, so a split write would produce a
 * document this build could not read back. `null` returns the run to waiting with
 * the attempt incremented and is **the only path that re-dispatches an
 * `unconfirmed` run**, ever.
 */
function resolvedRun(input: {
    /** The `unconfirmed` run. */
    readonly run: Run;
    /** The session the operator confirmed, or `null`. */
    readonly sessionId: string | null;
    /** Service-clock stamp. */
    readonly now: string;
}): Run {
    const { run, sessionId, now } = input;
    if (sessionId === null) {
        return {
            ...run,
            state: 'pending',
            stateReason: null,
            attempt: run.attempt + 1,
            lease: null,
            // **Cleared, not consumed**: the attempt moved on, and the store's
            // parser requires a reservation to carry the run's *current* attempt.
            // A consumed-but-retained reservation for the previous attempt would
            // make the document unreadable — the fail-closed direction that reads
            // as "the store is broken". Clearing is also the honest statement: the
            // next attempt mints a new token, so the old authorization is spent.
            reservation: null,
            updatedAt: now,
        };
    }

    return {
        ...run,
        state: 'dispatched',
        stateReason: `operator confirmed session ${sessionId}`,
        // The attempt did *not* move, so the consumed reservation stays and keeps
        // naming the attempt it authorized.
        reservation: run.reservation === null ? null : { ...run.reservation, consumed: true },
        attempts: attemptHistory(run, {
            ...currentAttempt(run),
            outcome: 'dispatched',
            sessionId,
            resultReportedAt: now,
        }),
        session: sessionRefOf({ run, sessionId, now }),
        updatedAt: now,
    };
}

/**
 * Resolve an `unconfirmed` run on the operator's explicit word.
 *
 * @returns The resolved run, or the refusal naming why it did not move.
 */
export async function resolveDispatch(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The run to resolve, by correlation id. */
    readonly correlationId: string;
    /** Which of the two explicit resolutions the operator chose. */
    readonly decision: ResolveDecision;
    /** The session the operator confirmed exists, required for `session-created`. */
    readonly sessionId: string | null;
    /** The operator's note about what they verified. */
    readonly note: string | null;
    /** The guidance the operator was shown before deciding. */
    readonly guidance: string | null;
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}): Promise<OperationResult> {
    return await operateRun(input, async ({ run, now, persist }): Promise<OperationResult> => {
        const refusal = judgeResolve({ run });
        if (refusal !== null) {
            return await refused({ ...input, run, operation: 'resolve', refusal });
        }

        const priorState = run.state;
        const resolved = resolvedRun({ run, sessionId: input.sessionId, now });
        await persist(resolved);

        return {
            status: 'applied',
            run: resolved,
            auditWritten: await appendRunRow({
                store: input.store,
                log: input.log,
                correlationId: resolved.correlationId,
                row: resolvedRow({
                    run: resolved,
                    priorState,
                    decision: input.sessionId === null ? 'no-session' : 'dispatched',
                    note: input.note,
                    guidance: input.guidance,
                }),
            }),
        };
    });
}
