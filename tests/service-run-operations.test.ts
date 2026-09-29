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
import { emptyRunsDocument, readRunsDocument, writeRunsDocument } from '../service/poll/runs.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { openStore } from '../service/store/index.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { DispatchAttempt, Run, RunState } from '../service/poll/runs-types.ts';
import type { ServiceStore } from '../service/store/index.ts';

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

let tempRoot = '';
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-runops-'));
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    LOG_LINES.length = 0;
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

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

/** Persist the bindings the corroboration re-check reads. */
async function storeBindings(...ids: readonly string[]): Promise<void> {
    await writeBindings({ store, bindings: ids.map(binding) });
}

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
    });

    it('preserves the source references and every prior attempt record', async () => {
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
    });

    it('does not touch the automatic requeue budget', async () => {
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
    });

    it('writes one dispatch.retry row naming the prior state and both attempts', async () => {
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
    });
});

describe('T-014 retry refusals are distinct (FR-041, AC-113)', () => {
    it('names each refusing state in its own words', async () => {
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
    });

    it('moves nothing and writes exactly one refusal row per refused retry', async () => {
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
    });

    it('refuses a retry whose attempt does not match the run it names', async () => {
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
    });
});

describe('T-014 retry corroborates a blocked cause only where it can (FR-042, contract §6)', () => {
    it('refuses a binding-missing retry while the binding is still absent', async () => {
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
        expect(refusal?.code).toBe('cause-not-cleared');
        expect(refusal?.message).toContain(BINDING_ID);
    });

    it('accepts a binding-missing retry once the binding is back, as corroborated', async () => {
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
    });

    it('records a project-missing retry as reported, never corroborated', async () => {
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
        expect(row?.causeReport).toBe('listProjects resolves it now');
    });

    it('refuses a blocked retry whose cause the operator has not reported cleared', async () => {
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
        expect(outcome.status === 'refused' ? outcome.refusal.code : '').toBe('cause-not-cleared');
    });
});

describe('T-014 return-to-waiting resets both counters (FR-033)', () => {
    it('returns a dead-lettered run to pending with attempt and budget reset', async () => {
        const run = await seedRun({ issueNumber: 30, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });

        const outcome = await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

        expect(outcome.status).toBe('applied');
        const stored = await readRun(run.correlationId);
        expect(stored.state).toBe('pending');
        expect(stored.attempt).toBe(1);
        expect(stored.requeuesUsed).toBe(0);
    });

    it('keeps the source references and attempt history across the reset', async () => {
        const run = await seedRun({ issueNumber: 31, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });

        await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

        const stored = await readRun(run.correlationId);
        expect(stored.attempts).toEqual(run.attempts);
        expect(stored.sourceReferences).toEqual(run.sourceReferences);
    });

    it('names the reset in its dispatch.retry row', async () => {
        const run = await seedRun({ issueNumber: 32, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });

        await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

        const [row] = await rowsOf(RETRY_ROW);
        expect(row).toMatchObject({ priorState: DEAD_LETTERED, attemptBefore: 4, attemptAfter: 1, attemptReset: true });
    });

    it('refuses every state that is not dead-lettered', async () => {
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
    });
});

describe('T-014 resolve is the only path out of unconfirmed (FR-027)', () => {
    it('records the session the operator named, terminally, in one write', async () => {
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
    });

    it('returns to pending with the attempt incremented for no-session', async () => {
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
    });

    it('re-dispatches a resolved no-session run through a brand-new token', async () => {
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
    });

    it('writes a dispatch.resolved row naming the decision, prior state, and guidance', async () => {
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
    });

    it('refuses every state that is not unconfirmed', async () => {
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
    });

    it('never lets a resolution re-dispatch a run that already has a session', async () => {
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
    });
});

describe('T-014 verification is warn-only and changes no state (FR-043, AC-125)', () => {
    it('records a matching read-back without moving the run', async () => {
        const run = await seedRun({ issueNumber: 50, state: DISPATCHED, sessionId: 'ses_v1' });

        const outcome = await recordVerification({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            attempt: 1,
            sessionId: 'ses_v1',
            observedAgent: EXPECTED_AGENT,
            expectedAgent: EXPECTED_AGENT,
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
    });

    it('records a mismatch visibly and leaves the run untouched', async () => {
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
        expect(mismatch).toMatchObject({ observedAgent: SPACE_BUNNY });
    });

    it('records an unreadable read-back as a mismatch, not a success', async () => {
        const run = await seedRun({ issueNumber: 52, state: DISPATCHED, sessionId: 'ses_v3' });

        await recordVerification({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            attempt: 1,
            sessionId: 'ses_v3',
            observedAgent: null,
            expectedAgent: EXPECTED_AGENT,
            ok: false,
            note: 'the read-back timed out',
            now: NOW,
        });

        const [unreadable] = await rowsOf(MISMATCH_ROW);
        expect(unreadable).toMatchObject({ observedAgent: null, note: 'the read-back timed out' });
        expect(await rowsOf(VERIFIED_ROW)).toEqual([]);
    });

    it('refuses a read-back for a session this run does not record', async () => {
        const run = await seedRun({ issueNumber: 53, state: DISPATCHED, sessionId: 'ses_v4' });

        const outcome = await recordVerification({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            attempt: 1,
            sessionId: 'ses_someone_else',
            observedAgent: EXPECTED_AGENT,
            expectedAgent: EXPECTED_AGENT,
            ok: true,
            note: null,
            now: NOW,
        });

        expect(outcome.status).toBe('refused');
        const stored = await readRun(run.correlationId);
        expect(stored.verification).toBeNull();
    });

    it('refuses a read-back for a run with no session at all', async () => {
        const run = await seedRun({ issueNumber: 54, state: 'failed' });

        const outcome = await recordVerification({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            attempt: 1,
            sessionId: 'ses_none',
            observedAgent: EXPECTED_AGENT,
            expectedAgent: EXPECTED_AGENT,
            ok: true,
            note: null,
            now: NOW,
        });

        expect(outcome.status).toBe('refused');
        expect(await rowsOf(VERIFIED_ROW)).toEqual([]);
    });
});

describe('T-014 the token chain across a dead-letter reset (plan D6, research §R3)', () => {
    it('returns the run to waiting on attempt 1, which is a fresh token chain', async () => {
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
    });

    it('leaves the reset run claimable, so a new token chain can start', async () => {
        const run = await seedRun({ issueNumber: 61, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });
        await requeueDispatch({ store, log: LOGGER, correlationId: run.correlationId, now: NOW });

        const claimed = await claimPendingRuns({ store, log: LOGGER, holder: 'panel-after-reset', now: NOW });

        expect(claimed.runs.map((candidate) => candidate.correlationId)).toEqual([run.correlationId]);
    });

    it('never offers a reset-path run that already recorded a session', async () => {
        const run = await seedRun({ issueNumber: 62, state: DISPATCHED, sessionId: 'ses_reset' });

        const claimed = await claimPendingRuns({ store, log: LOGGER, holder: 'panel-x', now: NOW });

        // FR-037's "under any condition" clause, exercised through the reset path
        // the plan D6 tension created.
        expect(claimed.runs.some((candidate) => candidate.correlationId === run.correlationId)).toBe(false);
    });

    it('reserves a fresh token after the reset and refuses the earlier chain\'s token', async () => {
        // plan D6's two halves, asserted together: the reset must make a reserve
        // possible again (otherwise a dead-lettered run is unrecoverable), and it
        // must not resurrect a token an earlier attempt already spent (otherwise
        // FR-022's single-use rule leaks across the boundary the reset draws).
        const run = await seedRun({ issueNumber: 64, state: DEAD_LETTERED, attempt: 4, requeuesUsed: 3 });
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
        // token than the one attempt 4 would have minted.
        expect(reserved.dispatchToken).toBe(buildDispatchToken(run.runKey, 1));

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
        const stored = await readRun(run.correlationId);
        expect(stored.state).toBe('starting');
        expect(stored.session).toBeNull();
        expect(stored.reservation?.dispatchToken).toBe(reserved.dispatchToken);
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
