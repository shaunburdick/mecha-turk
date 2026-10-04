/**
 * Authorize one dispatch: mint the single-use token (003 FR-020, FR-021;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md) §1).
 *
 * This is the **only** place a dispatch token is minted, and the one operation
 * whose whole job is to decide whether a run may be authorized at all. The shape
 * — decide, apply, record, inside one chain task — lives in
 * [`run-chain.ts`](./run-chain.ts); what is here is the decision and the
 * transition it applies.
 *
 * Three properties the transition owes beyond "the state is right":
 *
 * - **The authorization and the state move in the same write.** A reserve that
 *   recorded the reservation but left the run `claimed` would match *neither*
 *   sweep rule — not the lease-expiry requeue, which skips a run holding a
 *   reservation, nor the deadline wedge, which only reads `starting` — and the
 *   run would strand with no recovery path. 003 exists to make that shape
 *   impossible, so the reservation and the state change are one atomic write.
 * - **Nothing is minted before the verdict.** A refused reserve leaves no
 *   reservation, no token, and no `dispatch.reserved` row — only the one
 *   `dispatch.refused` row (contract §1).
 * - **The actor allow-list is judged here, and only here** (FR-076 – FR-080).
 *   The decision itself lives in
 *   [`dispatch-actor-gate.ts`](./dispatch-actor-gate.ts) — the split the
 *   file-length gate forces and the one this feature wants, since that module
 *   owns the predicate alone and the retry path re-runs the *same* predicate
 *   against its own live read (FR-078). It sits *after* `judgeReserve` has
 *   answered `null` and *before* any token is derived, so
 *   `already-dispatched` (which names the session) and `stale-lease` stay
 *   reachable on their own paths, and a refusal mints nothing at all. The
 *   binding's `allowedUsers` is read **inside this same chain task**, from the
 *   live document, so a tightened list takes effect on the next authorization
 *   with no re-scan and no restart; and the `PUT /v1/bindings` write joins that
 *   **same** chain (`routes/bindings.ts`), so an operator's tightening can never
 *   land between this read and the reservation below — the read → mint →
 *   persist sequence and the policy change it judges are one serialized pair,
 *   not two racing writers.
 * - **The session check runs first**, before the lease check, inverting the
 *   order the contract's prose listed. Read lease-first, a `dispatched` run —
 *   which holds no lease by construction — would always answer `stale-lease`
 *   and the session-naming refusal could never be reached: the store's parser
 *   only accepts a recorded session on a run that is `dispatched`, so the
 *   verdict that *can* name it has to be asked first. FR-022, AC-112, and the
 *   contract's own refusal table all require that name. The reservation check
 *   sits ahead of the state check for the same reason, which keeps
 *   `already-reserved` reachable for a `starting` run; `invalid-transition`
 *   remains the answer for every other live-lease state.
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
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The run to authorize, by correlation id. */
    readonly correlationId: string;
    /** Lease the panel holds and is reserving under. */
    readonly leaseId: string;
    /** Attempt the panel believes is current. */
    readonly attempt: number;
    /** Service-clock stamp; injectable so tests never sleep (NFR-112). */
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
 * the session (FR-022, AC-112) cannot name one it cannot find.
 *
 * @param run - The run being refused on.
 * @returns The session id, or `null` when the run records none.
 */
export function sessionIdOf(run: Run): string | null {
    if (run.session !== null) {
        return run.session.sessionId;
    }

    return run.attempts.find((attempt) => attempt.sessionId !== null)?.sessionId ?? null;
}

/**
 * Judge the lease a request presented.
 *
 * A lease is a fencing token, not a capability: it authorizes nothing, and this
 * exists only to answer "is this the attempt that currently owns the run", which
 * is the coordination question the claim and the sweep also ask. The guard
 * operations share it because a guard runs in the same window — it holds a live
 * claim and has made no authorization (contract §4).
 *
 * @param input - The run, the lease the caller presented, the attempt it claims
 *   to be made under, and the service clock.
 * @returns The refusal, or `null` when the lease is live and current.
 */
export function judgeLease(input: {
    /** The run the request addresses. */
    readonly run: Run;
    /** Lease id the caller presented. */
    readonly leaseId: string;
    /** Attempt the caller claims to be acting under. */
    readonly attempt: number;
    /** Service-clock stamp expiry is judged against (NFR-112). */
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
 * Judge a reserve (contract §1).
 *
 * The four checks run **most specific first**: recorded session, lease,
 * reservation, state. The order is load-bearing twice over. Reading the lease
 * before the session would answer `stale-lease` for a `dispatched` run — which
 * holds no lease by construction — and make FR-022's "the refusal MUST name the
 * existing session" (AC-112) unreachable on the natural path. Reading the state
 * before the reservation would answer `invalid-transition` for a `starting` run
 * and make `already-reserved` unreachable instead. Both verdicts exist because
 * the contract's table names them, so the order is the one in which both stay
 * reachable, and contract §1's prose states exactly this.
 *
 * @param input - The run, the lease, the attempt, and the service clock.
 * @returns The refusal, or `null` when this run may be authorized now.
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
        return refuse(
            'already-reserved',
            `this run is already authorized: attempt ${reservation.attempt} must report by `
            + `${reservation.resultDeadlineAt}`,
        );
    }

    return run.state === 'claimed'
        ? null
        : refuse(INVALID_TRANSITION, `this run is ${run.state}; only a claimed run can be authorized`);
}

/**
 * Build the run an authorized reserve produces.
 *
 * Pure, so the write is the only side effect the caller has to reason about and
 * the attempt record cannot drift from the reservation it belongs to.
 *
 * `actorPolicy` is snapshotted **here, from the gate's own read** (FR-079, plan
 * D16) — not re-read per row builder — so `dispatch.reserved` and
 * `dispatch.result` provably describe the same policy even though the result
 * report happens after an operator may have changed the list.
 *
 * @param input - The claimed run, the token, the deadline, the policy shape the
 *   gate decided on, and the stamp.
 * @returns The `starting` run.
 */
function reservedRun(input: {
    /** The claimed run. */
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
 *
 * @param store - Open store.
 * @param log - Logger used when the configuration cannot be read.
 * @returns Milliseconds a reservation's result deadline sits ahead.
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
 * Answer a refused reserve with its one `dispatch.refused` row (FR-003).
 *
 * @param input - The reserve's own input, the run, and the verdict.
 * @returns The refusal, carrying whether its row reached the trail.
 */
async function refusedReserve(input: {
    /** The reserve's own input. */
    readonly call: ReserveInput;
    /** The run as it stands. */
    readonly run: Run;
    /** The verdict. */
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
                ...(actor === undefined ? {} : { actor }),
            },
        }),
    };
}

/**
 * Authorize one dispatch: mint the single-use token and move the run to
 * `starting` (FR-020, FR-021).
 *
 * @param input - Store, logger, the run, the lease, the attempt, and an
 *   injectable service clock.
 * @returns The authorized run with its token, or why nothing was authorized.
 * @throws {StorageUnavailableError} When the run document cannot be read or written.
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
            // the reservation, not the claim (plan D7), so a panel told only
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
