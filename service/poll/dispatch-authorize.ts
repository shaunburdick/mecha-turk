/**
 * Authorize one dispatch: mint the single-use token (003 FR-020, FR-021;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md) §1).
 */

import { CONFIG_FILE, DEFAULT_CONFIG, configFromStore, parseStoredConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { appendRunRow, reservedRow } from './dispatch-audit.ts';
import { judgeActorPolicy, readLivePolicy, unreadablePolicyRefusal } from './dispatch-actor-gate.ts';
import { appendRefusalRow, operateRun } from './run-chain.ts';
import { buildDispatchToken } from './run-key.ts';
import { attemptHistory, currentAttempt, runHistoryIndicatesSession } from './runs-document.ts';
import { refuse } from './run-refusal.ts';
import type { RunApplied, RunDuplicate, RunNotFound, RunRefused, RunRefusal } from './run-refusal.ts';
import type { ActorGateRefusal, ActorPolicy, Run, RunLease } from './runs-types.ts';

/** What one reserve answered. */
export type ReserveResult =
    | (RunApplied & {
        readonly dispatchToken: string;
        readonly tokenExpiresAt: string;
        readonly resultDeadlineAt: string;
    })
    | RunDuplicate
    | RunRefused
    | RunNotFound;

/** What one reserve call carries. */
export interface ReserveInput {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The run to authorize, by correlation id. */
    readonly correlationId: string;
    /** Lease the panel holds and is reserving under. */
    readonly leaseId: string;
    /** Attempt the panel believes is current. */
    readonly attempt: number;
    /** Service-clock stamp; injectable so tests never sleep. */
    readonly now?: string | undefined;
}

/** The wire code every lease-versus-state verdict in this module carries. */
const INVALID_TRANSITION = 'invalid-transition';

/** The generic staleness message every lease mismatch carries. */
const STALE_MESSAGE = 'the lease is expired or does not match this run';

/**
 * The session this run produced, from whichever record holds it.
 *
 * The session pointer is the normal home, but an adopted or hand-seeded run can
 * carry the evidence only in its attempt history, and a refusal that must *name*
 * the session cannot name one it cannot find.
 */
export function sessionIdOf(run: Run): string | null {
    if (run.session !== null) {
        return run.session.sessionId;
    }

    return run.attempts.find((attempt) => attempt.sessionId !== null)?.sessionId ?? null;
}

/**
 * Judge the lease a request presented. A lease is a fencing token, not a
 * capability: it authorizes nothing, and this answers *is this the attempt
 * that currently owns the run*, the coordination question the claim and the
 * sweep also ask. The guard operations share it because a guard runs in the
 * same window — it holds a live claim and has made no authorization
 * (contract §4).
 */
export function judgeLease(input: {
    /** The run the request addresses. */
    readonly run: Run;
    /** Lease id the caller presented. */
    readonly leaseId: string;
    /** Attempt the caller claims to be acting under. */
    readonly attempt: number;
    /** Service-clock stamp expiry is judged against. */
    readonly now: string;
}): RunRefusal | null {
    const { run, leaseId, attempt, now } = input;
    const stale = refuse('stale-lease', STALE_MESSAGE);
    if (run.lease?.leaseId !== leaseId) {
        return stale;
    }

    if (attempt !== run.attempt || run.lease.attempt !== run.attempt) {
        return stale;
    }

    return Date.parse(run.lease.expiresAt) <= Date.parse(now) ? stale : null;
}

/**
 * Judge a reserve (contract §1). The four checks run **most specific
 * first** — recorded session, lease, reservation, state — and the order is
 * load-bearing twice: lease-first would answer `stale-lease` for a
 * `dispatched` run, which holds no lease by construction, and make FR-022's
 * *the refusal MUST name the existing session* unreachable; state before
 * reservation would answer `invalid-transition` for a `starting` run and make
 * `already-reserved` unreachable instead. Both verdicts exist because the
 * contract's table names them, so this is the order in which both stay
 * reachable.
 */
function judgeReserve(input: {
    /** The run the request addresses. */
    readonly run: Run;
    /** Lease id the caller presented. */
    readonly leaseId: string;
    /** Attempt the caller claims to be acting under. */
    readonly attempt: number;
    /** Service-clock stamp. */
    readonly now: string;
}): RunRefusal | null {
    const { run } = input;
    if (runHistoryIndicatesSession(run)) {
        const sessionId = sessionIdOf(run);

        return refuse('already-dispatched', sessionId === null
            ? 'this run already produced a session'
            : `a session already exists: ${sessionId}`);
    }

    const lease = judgeLease(input);
    if (lease !== null) {
        return lease;
    }

    const { reservation } = run;
    if (reservation !== null) {
        const { attempt, resultDeadlineAt } = reservation;
        return refuse(
            'already-reserved',
            `this run is already authorized: attempt ${attempt} must report by ${resultDeadlineAt}`,
        );
    }

    return run.state === 'claimed'
        ? null
        : refuse(INVALID_TRANSITION, `this run is ${run.state}; only a claimed run can be authorized`);
}

/**
 * Build the run an authorized reserve produces. Pure, so the write is the
 * only side effect the caller has to reason about and the attempt record
 * cannot drift from the reservation it belongs to. `actorPolicy` is
 * snapshotted **here, from the gate's own read** (FR-079, plan D16) rather
 * than re-read per row builder, so `dispatch.reserved` and `dispatch.result`
 * provably describe the same policy even though an operator may change the
 * list in between.
 */
function reservedRun(input: {
    readonly run: Run;
    /** Token just minted. */
    readonly dispatchToken: string;
    /** RFC 3339 result deadline. */
    readonly resultDeadlineAt: string;
    /** Shape of the allow-list the gate judged. */
    readonly actorPolicy: ActorPolicy;
    /** Service-clock stamp. */
    readonly now: string;
}): Run {
    const { run, dispatchToken, resultDeadlineAt, actorPolicy, now } = input;

    return {
        ...run,
        state: 'starting',
        stateReason: `authorized at ${now}; result due by ${resultDeadlineAt}`,
        actorPolicy,
        reservation: { dispatchToken, attempt: run.attempt, reservedAt: now, resultDeadlineAt, consumed: false },
        attempts: attemptHistory(run, { ...currentAttempt(run), dispatchToken, reservedAt: now }),
        updatedAt: now,
    };
}

/**
 * Read the configured result deadline, answering the default when unreadable.
 *
 * Read before the chain, exactly as the claim reads its lease duration: a
 * configuration the operator cannot read must not fail an authorization, and the
 * default is the documented safe window.
 */
async function readResultDeadlineMs(store: ServiceStore, log: ServiceLogger): Promise<number> {
    try {
        const stored = await store.readJson(CONFIG_FILE, parseStoredConfig);

        return configFromStore(stored, log).config.resultDeadlineMs;
    } catch (cause) {
        log.warn('result deadline read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return DEFAULT_CONFIG.resultDeadlineMs;
    }
}

/**
 * Answer a refused reserve with its one `dispatch.refused` row.
 */
async function refusedReserve(input: {
    /** The reserve's own input. */
    readonly call: ReserveInput;
    readonly run: Run;
    readonly refusal: RunRefusal;
    /** The gate's extra details, on the one refusal that carries them (FR-077). */
    readonly actor?: ActorGateRefusal | undefined;
}): Promise<RunRefused> {
    const { call, run, refusal, actor } = input;

    return {
        status: 'refused',
        refusal,
        run,
        auditWritten: await appendRefusalRow({
            store: call.store,
            log: call.log,
            refusal: {
                run,
                operation: 'reserve',
                refusal,
                attempt: call.attempt,
                leaseId: call.leaseId,
                ...(actor !== undefined && { actor }),
            },
        }),
    };
}

/**
 * Authorize one dispatch: mint the single-use token and move the run to
 * `starting`.
 */
export async function reserveDispatch(input: ReserveInput): Promise<ReserveResult> {
    const deadlineMs = await readResultDeadlineMs(input.store, input.log);

    return await operateRun(input, async ({ run, now, persist }): Promise<ReserveResult> => {
        const refusal = judgeReserve({ run, leaseId: input.leaseId, attempt: input.attempt, now });
        if (refusal !== null) {
            return await refusedReserve({ call: input, run, refusal });
        }

        // The gate runs **after** `judgeReserve` and **before** anything is
        // minted (FR-076, clarification 22). A policy check placed first would
        // pre-empt `already-dispatched` — which names the session FR-022 and
        // AC-112 require — and `stale-lease`, making both unreachable on the
        // paths they exist for.
        const policy = await readLivePolicy({ store: input.store, log: input.log, bindingId: run.bindingId });
        const gate = policy.readable
            ? judgeActorPolicy({ run, allowedUsers: policy.allowedUsers })
            : unreadablePolicyRefusal(run, policy.cause);
        if (!gate.admitted) {
            return await refusedReserve({
                call: input,
                run,
                refusal: gate.refused.refusal,
                actor: gate.refused.actor,
            });
        }

        // `judgeReserve` only answers `null` for a `claimed` run holding this
        // lease, which is the one state that carries a live lease by construction.
        const lease = run.lease as RunLease;
        const dispatchToken = buildDispatchToken(run.runKey, run.attempt);
        const resultDeadlineAt = new Date(Date.parse(now) + deadlineMs).toISOString();
        const starting = reservedRun({ run, dispatchToken, resultDeadlineAt, actorPolicy: gate.policy, now });
        await persist(starting);

        return {
            status: 'applied',
            run: starting,
            dispatchToken,
            tokenExpiresAt: lease.expiresAt,
            // The authorization outlives the lease: a report is judged against
            // the reservation, not the claim, so a panel told only
            // when the lease dies would conclude its token dies there too, skip
            // the report, and strand the run in `unconfirmed` (T-043d).
            resultDeadlineAt,
            auditWritten: await appendRunRow({
                store: input.store,
                log: input.log,
                correlationId: starting.correlationId,
                row: reservedRow({ run: starting, leaseId: lease.leaseId, dispatchToken }),
            }),
        };
    });
}
