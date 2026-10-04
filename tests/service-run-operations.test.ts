/**
 * The run operations: retry, return-to-waiting, resolve, and the verification
 * report (003 FR-027, FR-033, FR-041, FR-043;
 * `contracts/dispatch-authorization.md` §5–§8; T-014).
 *
 * These four are the **only** paths that move a stuck run, and every one of them
 * is a human decision. The suite asserts what could silently betray that:
 *
 * - **Each refusal is distinct.** FR-041 requires `pending`, `dispatched`, and
 *   `unconfirmed` to answer differently, and adds `claimed`/`starting` and
 *   `dead-lettered` on top. They are asserted **separately** rather than as one
 *   "409" because a generic refusal would satisfy the code while failing the
 *   requirement, and because 005 renders these strings verbatim.
 * - **Attempt discipline is exact.** Retry and resolve-*no-session* increment
 *   once; verification increments nothing and changes no state; the dead-letter
 *   return resets both counters (contract invariant 5).
 * - **The service corroborates what it can and records what it cannot.** A
 *   `blocked:binding-missing` run is re-checked against the live binding table;
 *   a `blocked:project-missing` run depends on the panel's report, and the row
 *   says `reported` rather than claiming a verification the service never ran.
 * - **No audit row carries a token value.** The fingerprint rule from T-040c is
 *   re-checked across this wave's rows, not only the sweep's.
 *
 * Offline and deterministic: temp stores, injected service-clock stamps, no
 * sleeping, no network, no host.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { writeBindings } from '../service/bindings.ts';
import { createLogger } from '../service/log.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import { createEvent } from '../service/poll/events.ts';
import { buildDispatchToken } from '../service/poll/run-key.ts';
import {
    requeueDispatch,
    resolveDispatch,
    retryDispatch,
} from '../service/poll/run-operate.ts';
import { recordVerification } from '../service/poll/run-verify.ts';
import { deadLetterRun, emptyRunsDocument, readRunsDocument, writeRunsDocument } from '../service/poll/runs.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { openStore } from '../service/store/index.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { DispatchAttempt, Run, RunState } from '../service/poll/runs-types.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { writeOpenBinding } from './support/binding-fixture.ts';

/** Stamp every fixture uses; no test ever waits on a clock. */
const STAMP = '2026-09-28T09:00:00.000Z';
/** Later than every fixture's lease, so a "live lease" fixture stays live. */
const NOW = '2026-09-28T09:00:10.000Z';
const BINDING_ID = 'bnd-ops';
const REPOSITORY = 'acme/widget';
const ACCOUNT_ID = '77331';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'debug', sink: (line) => LOG_LINES.push(line) });

/** The state word the distinct retry refusals all carry as their wire code. */
const INVALID_TRANSITION = 'invalid-transition';
/** The wire code a superseded attempt answers with, wherever one is validated. */
const STALE_LEASE = 'stale-lease';
/** A lease id in the shape this build mints, for a hand-built fixture (T-040e). */
const SEEDED_LEASE = `lse-${'a'.repeat(24)}`;
/** A dispatch token in the shape this build mints; only fixtures ever store this value. */
const SEEDED_TOKEN = 'dtk-0123456789abcdef0123456789abcdef';
/** The failure a seeded `failed` run records as its cause. */
const SEEDED_FAILURE = 'bootstrap-failed';
/** The cause-clearing verdict only a service-side re-check may write. */
const CORROBORATED = 'corroborated';
/** The cause-clearing verdict a panel's own report may write. */
const REPORTED = 'reported';
/** The agent every fixture pins, so a mismatch fixture is unmistakable. */
const EXPECTED_AGENT = 'project-manager';
/** The state a successful dispatch lands in. */
const DISPATCHED = 'dispatched';
/** The state an authorized run holds while its token is live and unspent. */
const STARTING = 'starting';
/** The terminal state only the dead-letter return-to-waiting leaves. */
const DEAD_LETTERED = 'dead-lettered';
/** The one resolution that authorises a re-dispatch (FR-027). */
const NO_SESSION = 'no-session';
/** The note a resolve fixture records, so three assertions read one string. */
const RESOLVE_NOTE = 'found by attachment id';
/** The guidance a resolve fixture says the operator was shown. */
const RESOLVE_GUIDANCE = 'project prj_42, worktree none';
/** The observed agent a mismatch fixture reads back. */
const SPACE_BUNNY = 'space-bunny';
/** The lifecycle rows this suite counts, one vocabulary entry each (AC-115). */
const RETRY_ROW = 'dispatch.retry';
const RESOLVED_ROW = 'dispatch.resolved';
const REFUSED_ROW = 'dispatch.refused';
const VERIFIED_ROW = 'agent.verified';
const MISMATCH_ROW = 'agent.mismatch';
const UNCOMPARED_ROW = 'agent.uncompared';

let tempRoot = '';
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-runops-'));
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    // The gate reads `bindings.json` at authorization and denies when it cannot
    // (003 FR-076); the open policy keeps every retry assertion here testing the
    // retry path rather than the allow-list (002 FR-047).
    await writeOpenBinding({
        store,
        bindingId: BINDING_ID,
        options: { repository: REPOSITORY, accountNumericUserId: ACCOUNT_ID },
    });
    LOG_LINES.length = 0;
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

/** Build an assignment detection for one issue on the fixture binding. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${issueNumber}`,
            issueBodyExcerpt: `body ${issueNumber}`,
        },
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** One stored binding record. */
function binding(bindingId: string): BindingRecord {
    return {
        bindingId,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        repository: REPOSITORY,
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: true, reviewRequest: true },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/**
 * Persist the bindings the corroboration re-check reads.
 *
 * @param ids - One binding id, optionally with its own allow-list — a policy
 *   this suite's gate cases set directly.
 * @returns A promise that settles once the document is durable.
 */
async function storeBindings(...ids: readonly (string | [string, readonly string[]])[]): Promise<void> {
    await writeBindings({
        store,
        bindings: ids.map((entry) => typeof entry === 'string' ? binding(entry) : {
            ...binding(entry[0]),
            allowedUsers: entry[1],
        }),
    });
}

/** The retry code a blocked cause that has not cleared answers with (FR-041). */
const CAUSE_NOT_CLEARED = 'cause-not-cleared';

/** The fifth declared blocked cause the actor-policy gate parks a run in (003 FR-078). */
const ACTOR_BLOCKED_STATE: RunState = 'blocked:actor-not-allowed';

/**
 * The login the gate fixtures permit, and the list form `storeBindings` takes.
 *
 * Seeded runs are attributed to `alice`, so a list naming that login is exactly
 * the widened policy 003 AC-131's second half describes.
 */
const PERMITTED_LOGIN = 'alice';

/**
 * {@link PERMITTED_LOGIN} as the reader's list, named once so the two halves of
 * AC-131 differ by exactly one thing: whether this list names the run's actor.
 */
const PERMITTED_LOGIN_LIST: readonly string[] = [PERMITTED_LOGIN];

/** A populated list naming somebody who never triggered this run. */
const UNRELATED_LOGIN_LIST: readonly string[] = ['someone-else'];

/**
 * The outcome an attempt record must carry for the state it is seeded in.
 *
 * @param state - State the run is seeded in.
 * @param sessionId - Session the fixture says the run produced, else `null`.
 * @returns The stored outcome, or `null` for a still-open attempt.
 */
function seededOutcome(state: RunState, sessionId: string | null): DispatchAttempt['outcome'] {
    if (sessionId !== null) {
        return DISPATCHED;
    }

    if (state === 'unconfirmed') {
        return 'unconfirmed';
    }

    return state === 'failed' ? 'failed' : null;
}

/** The lease a seeded in-flight run carries: the shape the real claim mints (T-040e). */
function seededLease(attempt: number): NonNullable<Run['lease']> {
    return {
        leaseId: SEEDED_LEASE,
        attempt,
        holder: 'panel-fixture',
        issuedAt: STAMP,
        expiresAt: '2026-09-28T10:00:00.000Z',
        provenance: 'panel',
    };
}

/** The reservation a seeded authorized run carries; always unconsumed (a late report may still apply). */
function seededReservation(attempt: number): NonNullable<Run['reservation']> {
    return {
        dispatchToken: SEEDED_TOKEN,
        attempt,
        reservedAt: STAMP,
        resultDeadlineAt: '2026-09-28T09:01:00.000Z',
        consumed: false,
    };
}

/**
 * The session pointer a seeded dispatched run records.
 *
 * @param run - The run as `applyEnqueue` created it, for the attachment id.
 * @param sessionId - The session the fixture says it produced.
 * @returns The reference stored on the run.
 */
function seededSession(run: Run, sessionId: string): NonNullable<Run['session']> {
    return {
        sessionId,
        attachmentId: run.attachmentId,
        dispatchedAt: STAMP,
        title: '',
        sourceUrl: run.sourceReferences[0]?.sourceUrl ?? '',
        worktree: null,
    };
}

/**
 * The attempt record the seed writes, so the state and its history agree.
 *
 * Written as its own step rather than as a nested expression inside `seedRun`
 * because the outcome is the one member the store's parser cross-checks against
 * the run's state (T-037): a session implies `dispatched`, and a `failed` or
 * `unconfirmed` state implies its own outcome, with nothing in between.
 *
 * @param input - The attempt number, the state, the session, and whether the
 *   state holds a reservation.
 * @returns The record for that attempt.
 */
function seededAttempt(input: {
    /** Attempt the record is for. */
    readonly attempt: number;
    /** State the run is seeded in. */
    readonly state: RunState;
    /** Session the fixture says the run produced, else `null`. */
    readonly sessionId: string | null;
    /** Whether the state holds an authorization. */
    readonly holdsReservation: boolean;
}): DispatchAttempt {
    const { attempt, sessionId, holdsReservation } = input;

    return {
        attempt,
        dispatchToken: holdsReservation ? SEEDED_TOKEN : null,
        reservedAt: holdsReservation ? STAMP : null,
        outcome: seededOutcome(input.state, sessionId),
        sessionId,
        reason: input.state === 'failed' ? SEEDED_FAILURE : null,
        resultReportedAt: sessionId === null ? null : STAMP,
    };
}

/**
 * Seed one run directly in `state`, with the attempt record that state implies.
 *
 * Driving the real claim and reserve for every fixture would make these tests
 * assert the transitions rather than the *judgement* each operation applies to a
 * run it finds — and the judgement is what this wave's requirements are about.
 * The lease and reservation are still minted by the real builders, because the
 * store's parser (rightly) refuses an id or attempt this build could not have
 * written (T-040e, T-037).
 *
 * @param input - The state to seed and, where the state implies one, a session.
 * @returns The seeded run.
 */
async function seedRun(input: {
    readonly issueNumber: number;
    readonly state: RunState;
    readonly sessionId?: string;
    readonly attempt?: number;
    readonly requeuesUsed?: number;
}): Promise<Run> {
    const delivery = createEvent(assignment(input.issueNumber));
    const planned = applyEnqueue({ document: emptyRunsDocument(), deliveries: [delivery], now: STAMP });
    const created = planned.created[0];
    if (created === undefined) {
        throw new Error('seed run was not created');
    }

    const attempt = input.attempt ?? 1;
    const sessionId = input.sessionId ?? null;
    const holdsLease = input.state === 'claimed' || input.state === 'starting';
    const holdsReservation = input.state === 'starting' || input.state === 'unconfirmed';

    const run: Run = {
        ...created,
        state: input.state,
        stateReason: `seeded as ${input.state}`,
        attempt,
        requeuesUsed: input.requeuesUsed ?? 0,
        lease: holdsLease ? seededLease(attempt) : null,
        reservation: holdsReservation ? seededReservation(attempt) : null,
        session: sessionId === null ? null : seededSession(created, sessionId),
        attempts: [seededAttempt({ attempt, state: input.state, sessionId, holdsReservation })],
    };

    await writeRunsDocument({
        store,
        log: LOGGER,
        document: {
            ...planned.document,
            subjects: { [`github|${ACCOUNT_ID}|${REPOSITORY}|issue|${input.issueNumber}`]: 1 },
            runs: [run],
        },
    });

    return run;
}

/** Read one stored run back. */
async function readRun(correlationId: string): Promise<Run> {
    const document = await readRunsDocument({ store, log: LOGGER });
    const run = document.runs.find((candidate) => candidate.correlationId === correlationId);
    if (run === undefined) {
        throw new Error('run is no longer stored');
    }

    return run;
}

/**
 * Give a run the record of an earlier chain that already spent attempt 1's token.
 *
 * A dead-letter reset deliberately keeps attempt history (plan D6), and that
 * history is the only record left which can tell chain 1's bytes from the chain-2
 * reservation a later reserve re-mints from them — so a fixture asserting the
 * difference has to carry it. The record is written the way
 * `reportDispatch` writes it: the token, the outcome, and the stamp that closes
 * it.
 *
 * @param run - The run whose history gains the closed record.
 * @returns The token attempt 1 of this run's key mints.
 */
async function recordEarlierChain(run: Run): Promise<string> {
    const dispatchToken = buildDispatchToken(run.runKey, 1);
    const earlier: DispatchAttempt = {
        attempt: 1,
        dispatchToken,
        reservedAt: STAMP,
        outcome: 'failed',
        sessionId: null,
        reason: SEEDED_FAILURE,
        resultReportedAt: STAMP,
    };
    const document = await readRunsDocument({ store, log: LOGGER });
    const runs = document.runs.map((candidate) => candidate.correlationId === run.correlationId
        ? { ...candidate, attempts: [earlier, ...candidate.attempts] }
        : candidate);
    await writeRunsDocument({ store, log: LOGGER, document: { ...document, runs } });

    return dispatchToken;
}

/** Claim one waiting run and answer the lease the claim minted for it. */
async function claimLeaseOf(correlationId: string, holder: string): Promise<string> {
    const claimed = await claimPendingRuns({ store, log: LOGGER, holder, now: NOW });
    const run = claimed.runs.find((candidate) => candidate.correlationId === correlationId);
    if (run === undefined) {
        throw new Error('the run was not claimable');
    }

    return run.lease.leaseId;
}

/**
 * Drive one run through the crash permutation the audit replayed, end to end.
 *
 * `reserve → failed → retry → dead-letter → requeue → claim → reserve`. Every
 * step is the routed operation rather than a hand-written document, because the
 * property under test *is* what those operations record: FR-020 pins the token to
 * `sha256(runKey|attempt)`, so the reset at step five returns the run to attempt
 * 1 and the reserve at step seven re-mints attempt 1's exact bytes.
 *
 * @param issueNumber - Issue to build the run from.
 * @returns The run's identity, both chains' tokens, and the second claim's lease.
 */
async function crashPermutation(issueNumber: number): Promise<{
    /** The run every step acted on. */
    readonly correlationId: string;
    /** The run key both chains derive from. */
    readonly runKey: string;
    /** Token chain 1 minted and then spent. */
    readonly chainOneToken: string;
    /** Token chain 2 minted after the reset. */
    readonly chainTwoToken: string;
    /** Lease chain 2's reserve was made under. */
    readonly leaseId: string;
}> {
    const seeded = await seedRun({ issueNumber, state: 'pending' });
    const { correlationId } = seeded;

    const firstLease = await claimLeaseOf(correlationId, 'panel-chain-1');
    const authorized = await reserveDispatch({
        store, log: LOGGER, correlationId, leaseId: firstLease, attempt: 1, now: NOW,
    });
    if (authorized.status !== 'applied') {
        throw new Error('chain 1 did not authorize');
    }

    const chainOneToken = authorized.dispatchToken;
    const reported = await reportDispatch({
        store,
        log: LOGGER,
        correlationId,
        dispatchToken: chainOneToken,
        attempt: 1,
        operation: 'result',
        outcome: { attemptOutcome: 'failed', sessionId: null, reason: SEEDED_FAILURE },
        now: NOW,
    });
    if (reported.status !== 'applied') {
        throw new Error('chain 1 did not report');
    }

    const retried = await retryDispatch({
        store, log: LOGGER, correlationId, attempt: 1, causeCleared: true, causeReport: null, now: NOW,
    });
    if (retried.status !== 'applied') {
        throw new Error('the retry did not apply');
    }

    const parked = await deadLetterRun({
        store,
        log: LOGGER,
        correlationId,
        reason: 'requeue budget exhausted',
        now: NOW,
    });
    if (parked.status !== 'applied') {
        throw new Error('the run did not dead-letter');
    }

    const requeued = await requeueDispatch({ store, log: LOGGER, correlationId, now: NOW });
    if (requeued.status !== 'applied') {
        throw new Error('the return-to-waiting did not apply');
    }

    const leaseId = await claimLeaseOf(correlationId, 'panel-chain-2');
    const reauthorized = await reserveDispatch({
        store, log: LOGGER, correlationId, leaseId, attempt: 1, now: NOW,
    });
    if (reauthorized.status !== 'applied') {
        throw new Error('the post-reset reserve did not apply');
    }

    return { correlationId, runKey: seeded.runKey, chainOneToken, chainTwoToken: reauthorized.dispatchToken, leaseId };
}

/**
 * Read every audit row the trail holds, in order, with seeding settled.
 *
 * `seedRun` writes the run through `writeRunsDocument`, which leaves the
 * creation row owed in the durable outbox (T-037); the next *read* of the
 * document is what drains it. A snapshot taken before that read would count the
 * `run.created` row as part of whatever the test under assert wrote, which is
 * exactly the kind of off-by-one that makes a "writes exactly one row"
 * assertion meaningless.
 *
 * @returns Every row the trail holds, in order.
 */
async function trail(): Promise<ReturnType<typeof readAuditEntries>> {
    await readRunsDocument({ store, log: LOGGER });

    return await readAuditEntries(store);
}

/** The rows of one event type, for a vocabulary assertion. */
async function rowsOf(eventType: string): Promise<readonly Record<string, unknown>[]> {
    const entries = await trail();

    return entries.filter((entry) => entry.eventType === eventType).map((entry) => entry.details);
}

describe('T-014 retry (FR-041) — attempt discipline', () => {
    it('returns a failed run to waiting with the attempt incremented exactly once', async () => {
        {
            const run = await seedRun({ issueNumber: 1, state: 'failed' });

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe('pending');
            expect(stored.attempt).toBe(2);
            expect(stored.lease).toBeNull();
            expect(stored.reservation).toBeNull();
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 2, state: 'failed', attempt: 3 });

            await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 3,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            const stored = await readRun(run.correlationId);
            // Same run key, same references, same history: a retry never opens a new
            // run (FR-041), so nothing about the run's identity moves.
            expect(stored.runKey).toBe(run.runKey);
            expect(stored.correlationId).toBe(run.correlationId);
            expect(stored.sourceReferences).toEqual(run.sourceReferences);
            expect(stored.attempts).toEqual(run.attempts);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 3, state: 'failed', requeuesUsed: 2 });

            await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            // Plan D5: only an expired claim spends budget; an operator retry must
            // not inflate it or reset it.
            const stored = await readRun(run.correlationId);
            expect(stored.requeuesUsed).toBe(2);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 4, state: 'failed' });

            await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: 'panel rechecked the project',
                now: NOW,
            });

            const [row] = await rowsOf(RETRY_ROW);
            expect(row).toMatchObject({ priorState: 'failed', attemptBefore: 1, attemptAfter: 2 });
            const rows = await trail();
            expect(rows.filter((entry) => entry.eventType === RETRY_ROW)).toHaveLength(1);
        }
    });
});

describe('T-014 retry refusals are distinct (FR-041, AC-113)', () => {
    it('names each refusing state in its own words', async () => {
        {
            const cases: readonly { readonly state: RunState; readonly issue: number; readonly fragment: string }[] = [
                { state: 'pending', issue: 10, fragment: 'already waiting' },
                { state: DISPATCHED, issue: 11, fragment: 'already dispatched' },
                { state: 'unconfirmed', issue: 12, fragment: 'resolve it instead' },
                { state: 'claimed', issue: 13, fragment: 'attempt is in flight' },
                { state: 'starting', issue: 14, fragment: 'attempt is in flight' },
                { state: DEAD_LETTERED, issue: 15, fragment: 'use return-to-waiting' },
            ];

            for (const entry of cases) {
                const run = await seedRun({
                    issueNumber: entry.issue,
                    state: entry.state,
                    ...(entry.state === DISPATCHED ? { sessionId: 'ses_done' } : {}),
                });

                const outcome = await retryDispatch({
                    store,
                    log: LOGGER,
                    correlationId: run.correlationId,
                    attempt: 1,
                    causeCleared: true,
                    causeReport: null,
                    now: NOW,
                });

                expect(outcome.status, `${entry.state} must be refused`).toBe('refused');
                const refusal = outcome.status === 'refused' ? outcome.refusal : null;
                expect(refusal?.code).toBe(INVALID_TRANSITION);
                expect(refusal?.message).toContain(entry.fragment);
            }
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 16, state: 'pending' });
            const before = await trail();

            await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe('pending');
            expect(stored.attempt).toBe(1);

            const after = await trail();
            const added = after.slice(before.length);
            expect(added.map((entry) => entry.eventType)).toEqual([REFUSED_ROW]);
            expect(added[0]?.details).toMatchObject({
                operation: 'retry',
                code: INVALID_TRANSITION,
                priorState: 'pending',
                attempt: 1,
            });
            expect(added[0]?.correlationId).toBe(run.correlationId);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 17, state: 'failed', attempt: 4 });
            const before = await trail();

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 2,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            // Contract, common body fields: §6's body carries `attempt`, and a
            // mismatch of a declared member is a refusal, never a partial apply. A
            // retry judged against a state the run has already left would increment
            // a counter the caller never saw — which is the half-apply the rule
            // exists to prevent, and why staleness is read before the state verdict.
            expect(outcome.status).toBe('refused');
            const refusal = outcome.status === 'refused' ? outcome.refusal : null;
            expect(refusal?.code).toBe(STALE_LEASE);
            expect(refusal?.message).toContain('attempt 4');

            const stored = await readRun(run.correlationId);
            expect(stored.attempt).toBe(4);
            expect(stored.state).toBe('failed');

            const after = await trail();
            expect(after.slice(before.length).map((entry) => entry.eventType)).toEqual([REFUSED_ROW]);
        }
    });
});

describe('T-014 retry corroborates a blocked cause only where it can (FR-042, contract §6)', () => {
    it('refuses a binding-missing retry while the binding is still absent', async () => {
        {
            const run = await seedRun({ issueNumber: 20, state: 'blocked:binding-missing' });
            await storeBindings();

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: 'the panel thinks the binding came back',
                now: NOW,
            });

            expect(outcome.status).toBe('refused');
            const refusal = outcome.status === 'refused' ? outcome.refusal : null;
            expect(refusal?.code).toBe(CAUSE_NOT_CLEARED);
            expect(refusal?.message).toContain(BINDING_ID);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 21, state: 'blocked:binding-missing' });
            await storeBindings(BINDING_ID);

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const [row] = await rowsOf(RETRY_ROW);
            // `corroborated` is the honest word: the service re-read the table.
            expect(row?.causeClearedSource).toBe(CORROBORATED);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 22, state: 'blocked:project-missing' });
            await storeBindings(BINDING_ID);

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: 'listProjects resolves it now',
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const [row] = await rowsOf(RETRY_ROW);
            // The service cannot call host APIs (002's architecture), so the panel's
            // same-mount check is the evidence and is audited as evidence.
            expect(row?.causeClearedSource).toBe(REPORTED);
            expect(row?.causeReportedCleared).toBe(true);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 23, state: 'blocked:project-missing' });
            await storeBindings(BINDING_ID);

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: false,
                causeReport: null,
                now: NOW,
            });

            expect(outcome.status).toBe('refused');
            expect(outcome.status === 'refused' ? outcome.refusal.code : '').toBe(CAUSE_NOT_CLEARED);
        }
    });
});

describe('T-014 return-to-waiting resets both counters (FR-033)', () => {
    it('returns a dead-lettered run to pending with attempt and budget reset', async () => {
        {
            const run = await seedRun({ issueNumber: 30, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });

            const outcome = await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe('pending');
            expect(stored.attempt).toBe(1);
            expect(stored.requeuesUsed).toBe(0);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 31, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });

            await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

            const stored = await readRun(run.correlationId);
            expect(stored.attempts).toEqual(run.attempts);
            expect(stored.sourceReferences).toEqual(run.sourceReferences);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 32, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });

            await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

            const [row] = await rowsOf(RETRY_ROW);
            expect(row).toMatchObject({
                priorState: DEAD_LETTERED, attemptBefore: 4, attemptAfter: 1, attemptReset: true });
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            for (const [index, state] of (['pending', 'claimed', 'unconfirmed'] as const).entries()) {
                const run = await seedRun({ issueNumber: 33 + index, state });

                const outcome = await requeueDispatch({
                    store,
                    log: LOGGER,
                    correlationId: run.correlationId,
                    now: NOW,
                });

                expect(outcome.status, `${state} must be refused`).toBe('refused');
                expect(outcome.status === 'refused' ? outcome.refusal.code : '').toBe(INVALID_TRANSITION);
                const stored = await readRun(run.correlationId);
                expect(stored.state).toBe(state);
            }
        }
    });
});

describe('T-014 resolve is the only path out of unconfirmed (FR-027)', () => {
    it('records the session the operator named, terminally, in one write', async () => {
        {
            const run = await seedRun({ issueNumber: 40, state: 'unconfirmed' });

            const outcome = await resolveDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                decision: 'session-created',
                sessionId: 'ses_found',
                note: RESOLVE_NOTE,
                guidance: RESOLVE_GUIDANCE,
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe(DISPATCHED);
            expect(stored.session?.sessionId).toBe('ses_found');
            expect(stored.reservation?.consumed).toBe(true);
            // T-037's invariant, from the other side: the attempt record naming the
            // session must be in the same write as the terminal state, or the
            // document would not parse back.
            expect(stored.attempts.at(-1)).toMatchObject({ outcome: DISPATCHED, sessionId: 'ses_found' });
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 41, state: 'unconfirmed', attempt: 2 });

            const outcome = await resolveDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                decision: NO_SESSION,
                sessionId: null,
                note: 'no session with that attachment id',
                guidance: null,
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe('pending');
            expect(stored.attempt).toBe(3);
            expect(stored.lease).toBeNull();
            // The reservation is **cleared**, not left spent. The attempt moved on,
            // and a reservation the parser reads as belonging to the run's current
            // attempt could not be retained across the increment at all — and the old
            // token must be dead rather than merely spent, since a retained one would
            // still name an attempt that no longer exists.
            expect(stored.reservation).toBeNull();
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 47, state: 'unconfirmed', attempt: 2 });
            await resolveDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                decision: NO_SESSION,
                sessionId: null,
                note: null,
                guidance: null,
                now: NOW,
            });

            const claimed = await claimPendingRuns({ store, log: LOGGER, holder: 'panel-after-resolve', now: NOW });
            const [reclaimed] = claimed.runs.filter((candidate) => candidate.correlationId === run.correlationId);

            expect(reclaimed?.attempt).toBe(3);
            expect(reclaimed?.state).toBe('pending');
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 42, state: 'unconfirmed' });

            await resolveDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                decision: 'session-created',
                sessionId: 'ses_found',
                note: RESOLVE_NOTE,
                guidance: RESOLVE_GUIDANCE,
                now: NOW,
            });

            const [row] = await rowsOf(RESOLVED_ROW);
            expect(row).toMatchObject({
                priorState: 'unconfirmed',
                note: RESOLVE_NOTE,
                guidance: RESOLVE_GUIDANCE,
            });
            const entries = await trail();
            const resolved = entries.find((entry) => entry.eventType === RESOLVED_ROW);
            expect(resolved?.decision).toBe(DISPATCHED);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            for (const [index, state] of (['pending', 'claimed', DEAD_LETTERED] as const).entries()) {
                const run = await seedRun({ issueNumber: 43 + index, state });

                const outcome = await resolveDispatch({
                    store,
                    log: LOGGER,
                    correlationId: run.correlationId,
                    decision: NO_SESSION,
                    sessionId: null,
                    note: null,
                    guidance: null,
                    now: NOW,
                });

                expect(outcome.status, `${state} must be refused`).toBe('refused');
                const stored = await readRun(run.correlationId);
                expect(stored.state).toBe(state);
            }
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 46, state: DISPATCHED, sessionId: 'ses_existing' });

            const outcome = await resolveDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                decision: NO_SESSION,
                sessionId: null,
                note: null,
                guidance: null,
                now: NOW,
            });

            expect(outcome.status).toBe('refused');
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe(DISPATCHED);
            expect(stored.session?.sessionId).toBe('ses_existing');
        }
    });
});

describe('T-014 verification is warn-only and changes no state (FR-043, AC-125)', () => {
    it('records a matching read-back without moving the run', async () => {
        {
            const run = await seedRun({ issueNumber: 50, state: DISPATCHED, sessionId: 'ses_v1' });

            const outcome = await recordVerification({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                sessionId: 'ses_v1',
                observedAgent: EXPECTED_AGENT,
                expectedAgent: EXPECTED_AGENT,
                baselineProvenance: 'configured',
                ok: true,
                note: null,
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe(DISPATCHED);
            expect(stored.attempt).toBe(1);
            expect(stored.verification).toMatchObject({ observedAgent: EXPECTED_AGENT, ok: true });
            const [verified] = await rowsOf(VERIFIED_ROW);
            expect(verified).toMatchObject({
                sessionId: 'ses_v1',
                observedAgent: EXPECTED_AGENT,
                expectedAgent: EXPECTED_AGENT,
            });
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 51, state: DISPATCHED, sessionId: 'ses_v2' });
            const before = await readRun(run.correlationId);

            const outcome = await recordVerification({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                sessionId: 'ses_v2',
                observedAgent: SPACE_BUNNY,
                expectedAgent: EXPECTED_AGENT,
                baselineProvenance: 'configured',
                ok: false,
                note: 'agent differs from the expected baseline',
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            // Warn-only: the mismatch is visible on the row and changes nothing.
            expect(stored.state).toBe(before.state);
            expect(stored.attempt).toBe(before.attempt);
            expect(stored.reservation).toBeNull();
            expect(stored.verification).toMatchObject({ observedAgent: SPACE_BUNNY, ok: false });
            const [mismatch] = await rowsOf(MISMATCH_ROW);
            if (mismatch === undefined) {
                throw new Error('the trail carries no agent.mismatch row for a baseline that differed');
            }

            expect(mismatch).toMatchObject({
                observedAgent: SPACE_BUNNY,
                expectedAgent: EXPECTED_AGENT,
            });
            // A compared row owes no provenance — only `agent.uncompared`
            // records one — and this mismatch is not that row wearing a
            // verdict it did not earn.
            expect(Object.hasOwn(mismatch, 'baselineProvenance')).toBe(false);
            expect(await rowsOf(UNCOMPARED_ROW)).toEqual([]);
            const entries = await trail();
            const [warned] = entries.filter((entry) => entry.eventType === MISMATCH_ROW);
            expect(warned?.decision).toBe('warn');
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 52, state: DISPATCHED, sessionId: 'ses_v3' });

            await recordVerification({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                sessionId: 'ses_v3',
                observedAgent: null,
                expectedAgent: EXPECTED_AGENT,
                baselineProvenance: 'configured',
                ok: false,
                note: 'the read-back timed out',
                now: NOW,
            });

            const [unreadable] = await rowsOf(MISMATCH_ROW);
            expect(unreadable).toMatchObject({ observedAgent: null, note: 'the read-back timed out' });
            expect(await rowsOf(VERIFIED_ROW)).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 53, state: DISPATCHED, sessionId: 'ses_v4' });

            const outcome = await recordVerification({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                sessionId: 'ses_someone_else',
                observedAgent: EXPECTED_AGENT,
                expectedAgent: EXPECTED_AGENT,
                baselineProvenance: 'configured',
                ok: true,
                note: null,
                now: NOW,
            });

            expect(outcome.status).toBe('refused');
            const stored = await readRun(run.correlationId);
            expect(stored.verification).toBeNull();
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 54, state: 'failed' });

            const outcome = await recordVerification({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                sessionId: 'ses_none',
                observedAgent: EXPECTED_AGENT,
                expectedAgent: EXPECTED_AGENT,
                baselineProvenance: 'configured',
                ok: true,
                note: null,
                now: NOW,
            });

            expect(outcome.status).toBe('refused');
            expect(await rowsOf(VERIFIED_ROW)).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            // `expectedAgent: ''` is 002 FR-029's *no baseline configured*: the
            // read-back still files — the observation is evidence — but nothing
            // was compared, so the row is `agent.uncompared` with decision
            // `observed`, the empty baseline, and the provenance that says why
            // (003 v1.7.0). `agent.mismatch` would claim a difference nobody
            // configured, which is exactly what the third type exists to stop.
            const run = await seedRun({ issueNumber: 55, state: DISPATCHED, sessionId: 'ses_v5' });
            const before = await readRun(run.correlationId);

            const outcome = await recordVerification({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                sessionId: 'ses_v5',
                observedAgent: EXPECTED_AGENT,
                expectedAgent: '',
                baselineProvenance: 'unset',
                ok: false,
                note: 'no baseline is configured, so nothing was compared',
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe(before.state);
            expect(stored.verification).toMatchObject({
                observedAgent: EXPECTED_AGENT,
                expectedAgent: '',
                ok: false,
                note: 'no baseline is configured, so nothing was compared',
            });
            const entries = await trail();
            const [row] = entries.filter((entry) => entry.eventType === UNCOMPARED_ROW);
            if (row === undefined) {
                throw new Error('the trail carries no agent.uncompared row for the blank baseline');
            }

            expect(row.decision).toBe('observed');
            expect(row.actorSource).toBe('panel');
            expect(row.correlationId).toBe(run.correlationId);
            expect(row.details).toMatchObject({
                observedAgent: EXPECTED_AGENT,
                expectedAgent: '',
                baselineProvenance: 'unset',
            });
            // The two proofs this case owes: no comparison happened, so no
            // verdict row may exist beside the observation.
            expect(await rowsOf(MISMATCH_ROW)).toEqual([]);
            expect(await rowsOf(VERIFIED_ROW)).toEqual([]);
        }
    });
});

describe('T-014 the token chain across a dead-letter reset (plan D6, research §R3)', () => {
    it('returns the run to waiting on attempt 1, which is a fresh token chain', async () => {
        {
            // The tension plan D6 resolves: `token = f(runKey, attempt)` plus
            // "reset the attempt count" would re-derive a token an earlier report had
            // already consumed, and FR-022 would then refuse it forever. The reset is
            // therefore an explicit, audited operator action rather than an implicit
            // one — this asserts the reset half of that answer.
            const run = await seedRun({ issueNumber: 60, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });

            const outcome = await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

            expect(outcome.status).toBe('applied');
            const stored = await readRun(run.correlationId);
            expect(stored.attempt).toBe(1);
            expect(stored.state).toBe('pending');
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 61, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });
            await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

            const claimed = await claimPendingRuns({ store, log: LOGGER, holder: 'panel-after-reset', now: NOW });

            expect(claimed.runs.map((candidate) => candidate.correlationId)).toEqual([run.correlationId]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 62, state: DISPATCHED, sessionId: 'ses_reset' });

            const claimed = await claimPendingRuns({ store, log: LOGGER, holder: 'panel-x', now: NOW });

            // FR-037's "under any condition" clause, exercised through the reset path
            // the plan D6 tension created.
            expect(claimed.runs.some((candidate) => candidate.correlationId === run.correlationId)).toBe(false);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            // plan D6's two halves, asserted together: the reset must make a reserve
            // possible again (otherwise a dead-lettered run is unrecoverable), and it
            // must not resurrect a token an earlier attempt already spent (otherwise
            // FR-022's single-use rule leaks across the boundary the reset draws).
            //
            // Both chains are replayed, not only attempt 4's: the reset re-mints
            // attempt **1**, so attempt 4's token is the easy refusal (the live
            // reservation never held it) and attempt 1's is the one that matters —
            // it is byte-identical to the authorization chain 2 now holds.
            const run = await seedRun({ issueNumber: 64, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });
            const chainOneToken = await recordEarlierChain(run);
            await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

            const claimed = await claimPendingRuns({ store, log: LOGGER, holder: 'panel-token-chain', now: NOW });
            const [reclaimed] = claimed.runs.filter((candidate) => candidate.correlationId === run.correlationId);
            if (reclaimed === undefined) {
                throw new Error('the reset run was not claimable');
            }

            const reserved = await reserveDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                leaseId: reclaimed.lease.leaseId,
                attempt: reclaimed.attempt,
                now: NOW,
            });

            expect(reserved.status).toBe('applied');
            if (reserved.status !== 'applied') {
                throw new Error('a reserve after the reset must apply');
            }
            // The new chain is derived from the reset attempt, so it is a different
            // token than the one attempt 4 would have minted — and the byte-identical
            // one to the token attempt 1 already spent.
            expect(reserved.dispatchToken).toBe(buildDispatchToken(run.runKey, 1));
            expect(reserved.dispatchToken).toBe(chainOneToken);

            const stale = await reportDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                dispatchToken: buildDispatchToken(run.runKey, 4),
                attempt: 4,
                operation: 'result',
                outcome: { attemptOutcome: 'dispatched', sessionId: 'ses_stale_chain', reason: null },
                now: NOW,
            });

            expect(stale.status).toBe('refused');

            // The replay the derivation makes possible: chain 1's spent token, which
            // chain 2's live reservation now carries byte for byte.
            const replay = await reportDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                dispatchToken: chainOneToken,
                attempt: 1,
                operation: 'result',
                outcome: { attemptOutcome: 'dispatched', sessionId: 'ses_wrong_chain', reason: null },
                now: NOW,
            });

            expect(replay.status).toBe('refused');
            expect(replay.status === 'refused' ? replay.refusal.code : '').toBe(STALE_LEASE);
            const stored = await readRun(run.correlationId);
            expect(stored.state).toBe('starting');
            expect(stored.session).toBeNull();
            expect(stored.reservation?.dispatchToken).toBe(reserved.dispatchToken);
        }
    });
});

describe('T-042 a token the attempt history closed never authorizes a report (FR-020, FR-028, AC-110)', () => {
    it('re-mints byte-identical bytes across a dead-letter reset, so history is the only guard', async () => {
        {
            // The reproduction the audit ran, asserted as a fact about the
            // derivation rather than as a bug report: FR-020 pins the token to
            // sha256(runKey|attempt) and FR-033's reset returns the run to attempt 1,
            // so the collision is structural. Contract §9's "two attempts of one run
            // mint two different tokens" holds *within* a chain and is false across a
            // reset — which is exactly why T-044 corrects it and this suite fences it.
            const permutation = await crashPermutation(80);

            expect(permutation.chainTwoToken).toBe(permutation.chainOneToken);
            expect(permutation.chainOneToken).toBe(buildDispatchToken(permutation.runKey, 1));
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const permutation = await crashPermutation(81);
            const before = await readRun(permutation.correlationId);
            expect(before.state).toBe(STARTING);

            const replay = await reportDispatch({
                store,
                log: LOGGER,
                correlationId: permutation.correlationId,
                dispatchToken: permutation.chainOneToken,
                attempt: 1,
                operation: 'result',
                outcome: { attemptOutcome: 'dispatched', sessionId: 'ses_late', reason: null },
                now: NOW,
            });

            expect(replay.status).toBe('refused');
            expect(replay.status === 'refused' ? replay.refusal.code : '').toBe(STALE_LEASE);
            // The whole point: chain 2's honest session is not displaced, and no
            // session exists for this run at all (FR-025, FR-028, AC-110, NFR-102).
            const stored = await readRun(permutation.correlationId);
            expect(stored.state).toBe(STARTING);
            expect(stored.session).toBeNull();
            expect(stored.attempt).toBe(1);
            expect(stored.reservation?.consumed).toBe(false);
            expect(stored.reservation?.dispatchToken).toBe(permutation.chainTwoToken);

            const refusals = await rowsOf(REFUSED_ROW);
            expect(refusals).toHaveLength(1);
            expect(refusals[0]).toMatchObject({ operation: 'result', code: STALE_LEASE, attempt: 1 });
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            // The standing assertion the auditor asked for, stated generally: walk
            // every record *outside the live reservation's own* that the history
            // already closed and replay its token. Each one must be refused, whatever
            // the live reservation happens to say. The reservation's record is
            // governed by `reservation.consumed` instead — which is what keeps the
            // sweep's `unconfirmed` wedge reconcilable (AC-111, asserted separately
            // in the authorize suite).
            const permutation = await crashPermutation(82);
            const stored = await readRun(permutation.correlationId);
            // Resolved independently of the implementation's own helper: the record
            // the live reservation stands on is the *last* one for the current attempt.
            let liveIndex = -1;
            for (const [index, record] of stored.attempts.entries()) {
                if (record.attempt === stored.attempt) {
                    liveIndex = index;
                }
            }
            const closed = stored.attempts.filter((record, index) => index !== liveIndex
                && record.dispatchToken !== null
                && (record.resultReportedAt !== null || record.outcome !== null));
            expect(closed.length).toBeGreaterThan(0);

            for (const record of closed) {
                const replay = await reportDispatch({
                    store,
                    log: LOGGER,
                    correlationId: permutation.correlationId,
                    dispatchToken: record.dispatchToken ?? '',
                    attempt: record.attempt,
                    operation: 'result',
                    outcome: { attemptOutcome: 'dispatched', sessionId: 'ses_replay', reason: null },
                    now: NOW,
                });

                expect(replay.status, `attempt ${record.attempt}'s closed token was applied`).toBe('refused');
                expect(replay.status === 'refused' ? replay.refusal.code : '').toBe(STALE_LEASE);
            }

            const after = await readRun(permutation.correlationId);
            expect(after.session).toBeNull();
            expect(after.state).toBe(STARTING);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            // The other half of the ruling: the spend check reads history only where
            // a *report* is being judged. Reserve consults no history, so an operator
            // returning a run to waiting can always obtain a fresh authorization and
            // the run is recoverable rather than wedged by its own past.
            const run = await seedRun({ issueNumber: 83, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });
            await recordEarlierChain(run);
            await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });
            const leaseId = await claimLeaseOf(run.correlationId, 'panel-recoverable');

            const reserved = await reserveDispatch({
                store, log: LOGGER, correlationId: run.correlationId, leaseId, attempt: 1, now: NOW,
            });

            expect(reserved.status).toBe('applied');
        }
    });
});

describe('T-014 no audit row carries a dispatch token value (FR-061)', () => {
    it('scans every row this wave writes for a token-shaped string', async () => {
        const failed = await seedRun({ issueNumber: 70, state: 'failed' });
        await retryDispatch({
            store,
            log: LOGGER,
            correlationId: failed.correlationId,
            attempt: 1,
            causeCleared: true,
            causeReport: null,
            now: NOW,
        });
        const dispatched = await seedRun({ issueNumber: 71, state: DISPATCHED, sessionId: 'ses_scan' });
        await recordVerification({
            store,
            log: LOGGER,
            correlationId: dispatched.correlationId,
            attempt: 1,
            sessionId: 'ses_scan',
            observedAgent: EXPECTED_AGENT,
            expectedAgent: EXPECTED_AGENT,
            baselineProvenance: 'configured',
            ok: true,
            note: null,
            now: NOW,
        });

        const entries = await trail();
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            expect(JSON.stringify(entry), `${entry.eventType} carried a dispatch token`)
                .not.toMatch(/dtk-[0-9a-f]{8,}/);
        }
    });
});

/* ------------------------------------------------------------------------- *
 * 003 v1.8.0 — the fifth declared cause (FR-078; AC-131)
 *
 * A policy refusal **parks** a run; it never burns it. That is the same treatment
 * every other guard already gets, and the two properties worth proving are that a
 * retry **re-checks the live policy with the gate's own predicate** — so a run
 * cannot be retried into a dispatch the gate would refuse again — and that a
 * refused retry consumes no attempt and no requeue budget.
 * ------------------------------------------------------------------------- */

describe('FR-078 a blocked actor-not-allowed run burns nothing', () => {
    it('re-checks the live policy, and a refused retry consumes nothing (AC-131)', async () => {
        {
            const run = await seedRun({ issueNumber: 40, state: ACTOR_BLOCKED_STATE });
            // A populated list naming a **different** login: the gate would refuse
            // this run again right now, so the retry must refuse too.
            await storeBindings([BINDING_ID, UNRELATED_LOGIN_LIST]);

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: 'I widened the list',
                now: NOW,
            });

            expect(outcome.status).toBe('refused');
            const refusal = outcome.status === 'refused' ? outcome.refusal : null;
            expect(refusal?.code).toBe(CAUSE_NOT_CLEARED);
            // Its own distinct reason, naming the binding whose policy still refuses.
            expect(refusal?.message).toContain(BINDING_ID);
            expect(await rowsOf(RETRY_ROW)).toHaveLength(0);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 41, state: ACTOR_BLOCKED_STATE, requeuesUsed: 2 });
            await storeBindings([BINDING_ID, UNRELATED_LOGIN_LIST]);

            await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            const after = await readRunsDocument({ store, log: LOGGER });
            const stored = after.runs.find((candidate) => candidate.correlationId === run.correlationId);
            expect(stored?.attempt).toBe(1);
            expect(stored?.requeuesUsed).toBe(2);
            expect(stored?.state).toBe(ACTOR_BLOCKED_STATE);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        {
            const run = await seedRun({ issueNumber: 42, state: ACTOR_BLOCKED_STATE, requeuesUsed: 1 });
            await storeBindings([BINDING_ID, PERMITTED_LOGIN_LIST]);

            const outcome = await retryDispatch({
                store,
                log: LOGGER,
                correlationId: run.correlationId,
                attempt: 1,
                causeCleared: true,
                causeReport: null,
                now: NOW,
            });

            expect(outcome.status).toBe('applied');
            // The service re-read the list itself, so `corroborated` is the honest
            // word — the same one `blocked:binding-missing` already earns.
            const rows = await rowsOf(RETRY_ROW);
            expect(rows[0]).toMatchObject({
                causeClearedSource: CORROBORATED,
                priorState: ACTOR_BLOCKED_STATE,
                attemptBefore: 1,
                attemptAfter: 2,
            });
            // The counters move exactly as for any other retry: the attempt moves,
            // the budget does not (FR-041, plan D5).
            const after = await readRunsDocument({ store, log: LOGGER });
            const stored = after.runs.find((candidate) => candidate.correlationId === run.correlationId);
            expect(stored?.attempt).toBe(2);
            expect(stored?.requeuesUsed).toBe(1);
            expect(stored?.state).toBe('pending');
        }
    });
});
