/**
 * The lease/deadline sweep (003 FR-032, FR-033, FR-023, FR-036; T-009).
 *
 * The sweep's whole contract is a *boundary*: two conditions recover, every
 * other state is left byte-identical, and no recovery may ever create a second
 * session. This suite pins both halves —
 *
 * - `claimed` + no reservation + expired lease → requeue with the attempt and
 *   the requeue budget both incremented, one `dispatch.lease-expired` row
 *   carrying the attempt before and after; the fourth expiry parks the run
 *   with `run.dead_lettered` and its attempts consumed (AC-106);
 * - `starting` past its result deadline → `unconfirmed` with one
 *   `dispatch.unconfirmed` row, and ten further passes leave it untouched
 *   (AC-107);
 * - `pending` burns nothing across repeated passes (AC-108), and a run whose
 *   history records a session is never requeued (FR-028);
 * - a migrated claim recovers **once**, as migration recovery, without
 *   consuming budget (data-model §1).
 *
 * No test waits on a clock: `sweepOnce` takes its stamp at the seam, which is
 * also the only way NFR-112's "service clock only" stays an executable
 * property rather than a comment.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import type { AuditEntry } from '../service/audit.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { buildDispatchTokenFingerprint } from '../service/poll/run-key.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { buildMigrationLeaseId } from '../service/poll/runs-adopt.ts';
import { readRunsDocument, writeRunsDocument } from '../service/poll/runs.ts';
import { sweepIntervalMs, sweepOnce } from '../service/poll/sweep.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { DispatchAttempt, Run, RunsDocument } from '../service/poll/runs-types.ts';
import type { ServiceStore } from '../service/store/index.ts';
import type { SweepOutcome } from '../service/poll/sweep.ts';
import { byText } from './support/sort.ts';

/** Detections use this stamp; the sweep uses whatever the test injects. */
const DETECTED_AT = '2026-09-28T12:00:00.000Z';

/** One hour after detection: past any default lease, before any deadline. */
const ONE_HOUR_LATER = '2026-09-28T13:00:00.000Z';

/** Deadline the reserved fixture is armed with. */
const RESULT_DEADLINE = '2026-09-28T12:02:00.000Z';

/** A lease that has already lapsed by the time the sweep runs. */
const LAPSED_LEASE = '2026-09-28T12:01:00.000Z';

/** A lease still live when the sweep runs. */
const LIVE_LEASE = '2026-09-28T13:30:00.000Z';

const HOLDER = 'panel-sweep';
const MIGRATION_HOLDER = 'migration';
const CLAIMED = 'claimed';
const DISPATCH_TOKEN = 'dtk-0123456789abcdef0123456789abcdef';
const FIXTURE_LEASE_ID = `lse-${'0'.repeat(24)}`;
const FORGED_SESSION_ID = 'ses_claimed';
const RUNS_FILE = 'runs.json';
const LEASE_EXPIRED = 'dispatch.lease-expired';
const DEAD_LETTERED = 'run.dead_lettered';
const UNCONFIRMED = 'dispatch.unconfirmed';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'debug', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-sweep-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    LOG_LINES.length = 0;
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

/** Build an assignment detection for one issue. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: 'bnd-sweep',
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
            issueBodyExcerpt: '',
        },
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
        triggerNote: 'assigned',
        detectedAt: DETECTED_AT,
    };
}

/** An attempt record as a claim leaves it: open, no token, no outcome. */
function openAttempt(attempt: number): DispatchAttempt {
    return {
        attempt,
        dispatchToken: null,
        reservedAt: null,
        outcome: null,
        sessionId: null,
        reason: null,
        resultReportedAt: null,
    };
}

/** The attempt record a reservation leaves behind. */
function reservedAttempt(attempt: number): DispatchAttempt {
    return { ...openAttempt(attempt), dispatchToken: DISPATCH_TOKEN, reservedAt: DETECTED_AT };
}

/** Seed one run, accumulating into whatever the store already holds. */
async function seedRun(issueNumber: number): Promise<Run> {
    const stored = await readRunsDocument({ store, log: LOGGER });
    const planned = applyEnqueue({
        document: { ...stored, auditIntents: [] },
        deliveries: [createEvent(assignment(issueNumber))],
        now: DETECTED_AT,
    });
    const created = planned.created[0];
    if (created === undefined) {
        throw new Error('seed run was not created');
    }

    await writeRunsDocument({ store, log: LOGGER, document: planned.document });

    return created;
}

/**
 * Rewrite one stored run through the store's own writer.
 *
 * @param correlationId - The run to patch.
 * @param patch - The new row, given the one being replaced.
 * @returns Nothing; the caller reads the run back with {@link readRun}.
 */
async function patchRun(correlationId: string, patch: (run: Run) => Run): Promise<void> {
    const document = await readRunsDocument({ store, log: LOGGER });
    const runs = document.runs.map((candidate) => (candidate.correlationId === correlationId
        ? patch(candidate)
        : candidate));
    if (runs.every((candidate) => candidate.correlationId !== correlationId)) {
        throw new Error('patched run is no longer stored');
    }

    await writeRunsDocument({ store, log: LOGGER, document: { ...document, runs } });
}

/**
 * Lease one seeded run, exactly as the claim route would.
 *
 * The sweep's fixtures are therefore the records the claim writes — a lease
 * id, holder, issue stamp, and expiry — not a hand-made approximation.
 */
async function claimSeeded(run: Run, expiresAt: string): Promise<void> {
    await patchRun(run.correlationId, (candidate) => ({
        ...candidate,
        state: CLAIMED,
        stateReason: `lease held by ${HOLDER} until ${expiresAt}`,
        lease: {
            leaseId: FIXTURE_LEASE_ID,
            attempt: candidate.attempt,
            holder: HOLDER,
            issuedAt: DETECTED_AT,
            expiresAt,
            provenance: 'panel',
        },
        attempts: [openAttempt(candidate.attempt)],
    }));
}

/** Replace the fixture lease with the synthetic one adoption mints. */
async function adoptAsMigrationClaim(run: Run, expiresAt: string): Promise<void> {
    await patchRun(run.correlationId, (candidate) => {
        const { lease } = candidate;
        if (lease === null) {
            throw new Error('seeded run holds no lease');
        }

        return {
            ...candidate,
            lease: {
                ...lease,
                leaseId: buildMigrationLeaseId(candidate.correlationId),
                holder: MIGRATION_HOLDER,
                expiresAt,
                provenance: 'migration',
            },
        };
    });
}

/** Reserve one run, arming the result deadline it must answer. */
async function reserveSeeded(run: Run): Promise<void> {
    await patchRun(run.correlationId, (candidate) => ({
        ...candidate,
        state: 'starting',
        stateReason: `authorized; result due by ${RESULT_DEADLINE}`,
        reservation: {
            dispatchToken: DISPATCH_TOKEN,
            attempt: candidate.attempt,
            reservedAt: DETECTED_AT,
            resultDeadlineAt: RESULT_DEADLINE,
            consumed: false,
        },
        attempts: [reservedAttempt(candidate.attempt)],
    }));
}

/** Read one run back out of the store. */
async function readRun(correlationId: string): Promise<Run> {
    const document = await readRunsDocument({ store, log: LOGGER });
    const run = document.runs.find((candidate) => candidate.correlationId === correlationId);
    if (run === undefined) {
        throw new Error('run is no longer stored');
    }

    return run;
}

/** Sweep with the shared logger and an injected stamp. */
async function sweep(now: string): Promise<SweepOutcome> {
    return await sweepOnce({ store, log: LOGGER, now });
}

/** Audit rows of one type, in the order they were written. */
async function rowsOf(eventType: string): Promise<readonly AuditEntry[]> {
    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === eventType);
}

describe('T-009 lease expiry (FR-032)', () => {
    it('requeues an expired unreserved claim and records the attempt before and after', async () => {
        {
            const run = await seedRun(101);
            await claimSeeded(run, LAPSED_LEASE);

            const outcome = await sweep(ONE_HOUR_LATER);
            const requeued = await readRun(run.correlationId);
            const rows = await rowsOf(LEASE_EXPIRED);

            expect(outcome.recoveries).toHaveLength(1);
            expect(outcome.recoveries[0]?.eventType).toBe(LEASE_EXPIRED);
            expect(requeued.state).toBe('pending');
            expect(requeued.attempt).toBe(2);
            expect(requeued.requeuesUsed).toBe(1);
            expect(requeued.lease).toBeNull();
            expect(requeued.attempts.at(-1)).toMatchObject({ attempt: 1, outcome: 'expired' });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                actorSource: 'service',
                correlationId: run.correlationId,
                decision: 'requeued',
                reason: 'lease expired without a reservation',
                details: { priorState: 'claimed', attemptBefore: 1, attemptAfter: 2, migrationRecovery: false },
            });
            expect(rows[0]?.entity).toEqual({ kind: 'run', id: run.correlationId });
        }
    });

    it('leaves a live lease exactly where it is', async () => {
        {
            const run = await seedRun(102);
            await claimSeeded(run, LIVE_LEASE);

            const outcome = await sweep('2026-09-28T13:00:00.000Z');
            const stillClaimed = await readRun(run.correlationId);

            expect(outcome.recoveries).toEqual([]);
            expect(stillClaimed.state).toBe('claimed');
        }
    });

    it('parks the run once the requeue budget is spent', async () => {
        {
            const run = await seedRun(103);
            await claimSeeded(run, LAPSED_LEASE);

            // Three expiries, each a fresh claim, each consuming one requeue.
            for (let expiry = 1; expiry <= 3; expiry += 1) {
                const current = await readRun(run.correlationId);
                await claimSeeded(current, LAPSED_LEASE);
                await sweep(ONE_HOUR_LATER);
                const requeued = await readRun(run.correlationId);
                expect(requeued.requeuesUsed).toBe(expiry);
            }

            const beforeFourth = await readRun(run.correlationId);
            await claimSeeded(beforeFourth, LAPSED_LEASE);
            const outcome = await sweep(ONE_HOUR_LATER);
            const parked = await readRun(run.correlationId);
            const deadRows = await rowsOf(DEAD_LETTERED);

            expect(outcome.recoveries.map((recovery) => recovery.eventType)).toEqual([DEAD_LETTERED]);
            expect(parked.state).toBe('dead-lettered');
            expect(parked.lease).toBeNull();
            expect(parked.requeuesUsed).toBe(3);
            expect(parked.stateReason).toContain('budget exhausted after 3 requeues');
            expect(deadRows).toHaveLength(1);
            expect(deadRows[0]).toMatchObject({
                decision: 'dead-lettered',
                details: { requeuesUsed: 3, budget: 3, priorState: 'claimed' },
            });
            // A parked run is terminal, so it is never claimed again (FR-037).
            const reclaim = await claimPendingRuns({ store, log: LOGGER, holder: HOLDER, now: ONE_HOUR_LATER });
            expect(reclaim.runs).toEqual([]);
        }
    });

});

describe('T-009 late dispatch result (FR-023)', () => {
    it('wedges a reserved run whose result never arrived', async () => {
        {
            const run = await seedRun(111);
            await claimSeeded(run, LIVE_LEASE);
            await reserveSeeded(run);

            const outcome = await sweep(ONE_HOUR_LATER);
            const wedged = await readRun(run.correlationId);
            const rows = await rowsOf(UNCONFIRMED);

            expect(outcome.recoveries.map((recovery) => recovery.eventType)).toEqual([UNCONFIRMED]);
            expect(wedged.state).toBe('unconfirmed');
            expect(wedged.stateReason).toContain(RESULT_DEADLINE);
            expect(wedged.attempts.at(-1)).toMatchObject({ outcome: 'unconfirmed' });
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                decision: 'unconfirmed',
                details: {
                    priorState: 'starting',
                    attempt: 1,
                    // The outstanding authorization is named by its fingerprint and
                    // never by its value (T-040c, FR-061).
                    dispatchTokenFingerprint: buildDispatchTokenFingerprint(DISPATCH_TOKEN),
                    deadline: RESULT_DEADLINE,
                },
            });
            expect(JSON.stringify(rows[0])).not.toContain(DISPATCH_TOKEN);
        }
    });

    it('leaves a reserved run alone before its deadline', async () => {
        {
            const run = await seedRun(112);
            await claimSeeded(run, LIVE_LEASE);
            await reserveSeeded(run);

            const outcome = await sweep('2026-09-28T12:01:00.000Z');
            const reserved = await readRun(run.correlationId);

            expect(outcome.recoveries).toEqual([]);
            expect(reserved.state).toBe('starting');
        }
    });

    it('leaves an unconfirmed wedge untouched through ten more passes', async () => {
        {
            const run = await seedRun(113);
            await claimSeeded(run, LIVE_LEASE);
            await reserveSeeded(run);
            await sweep(ONE_HOUR_LATER);
            const wedged = await readRun(run.correlationId);

            for (let pass = 0; pass < 10; pass += 1) {
                const outcome = await sweep(ONE_HOUR_LATER);
                expect(outcome.recoveries).toEqual([]);
            }

            expect(await readRun(run.correlationId)).toEqual(wedged);
            expect(await rowsOf(UNCONFIRMED)).toHaveLength(1);
        }
    });

});

describe('T-009 what the sweep must not touch (FR-036, FR-028)', () => {
    it('burns nothing for a run that is merely waiting', async () => {
        {
            const run = await seedRun(121);

            for (let pass = 0; pass < 5; pass += 1) {
                const outcome = await sweep(ONE_HOUR_LATER);
                expect(outcome.recoveries).toEqual([]);
            }

            const waiting = await readRun(run.correlationId);
            expect(waiting.state).toBe('pending');
            expect(waiting.attempt).toBe(1);
            expect(waiting.requeuesUsed).toBe(0);
            expect(await rowsOf(LEASE_EXPIRED)).toEqual([]);
        }
    });

    it('never requeues a claimed run whose history already records a session', async () => {
        {
            const run = await seedRun(122);
            await claimSeeded(run, LAPSED_LEASE);
            const document = await readRunsDocument({ store, log: LOGGER });
            const claimed = document.runs.find((candidate) => candidate.correlationId === run.correlationId);
            if (claimed === undefined) {
                throw new Error('claimed run is missing');
            }

            // A claimed run that also records a session is unreadable by design
            // (T-037), so the store refuses to serve it rather than requeueing a
            // run a panel may already have dispatched.
            const inconsistent: RunsDocument = {
                ...document,
                runs: document.runs.map((candidate) => (candidate.correlationId === run.correlationId
                    ? {
                        ...candidate,
                        attempts: [{
                            ...openAttempt(candidate.attempt),
                            dispatchToken: DISPATCH_TOKEN,
                            reservedAt: DETECTED_AT,
                            outcome: 'dispatched' as const,
                            sessionId: FORGED_SESSION_ID,
                            resultReportedAt: DETECTED_AT,
                        }],
                    }
                    : candidate)),
            };
            await store.writeJson(RUNS_FILE, inconsistent);
            const restarted = await openStore({ dataDir });

            await expect(sweepOnce({ store: restarted, log: LOGGER, now: ONE_HOUR_LATER })).rejects.toThrow(
                'run document is unreadable',
            );
        }
    });

});

describe('T-009 migration recovery (data-model §1)', () => {
    it('recovers an adopted claim once, without consuming the budget', async () => {
        const run = await seedRun(131);
        await claimSeeded(run, LAPSED_LEASE);
        await adoptAsMigrationClaim(run, LAPSED_LEASE);

        await sweep(ONE_HOUR_LATER);
        const recovered = await readRun(run.correlationId);
        const rows = await rowsOf(LEASE_EXPIRED);

        expect(recovered.state).toBe('pending');
        expect(recovered.attempt).toBe(2);
        expect(recovered.requeuesUsed).toBe(0);
        expect(rows[0]?.details).toMatchObject({ migrationRecovery: true, requeuesBefore: 0, requeuesAfter: 0 });
        // Recovery happened once: the run is waiting again with no lease, so
        // the next pass has nothing to recover.
        const second = await sweep(ONE_HOUR_LATER);
        expect(second.recoveries).toEqual([]);
    });
});

describe('T-009 the sweep pass itself', () => {
    it('writes no row and no log line for a pass with nothing to do', async () => {
        {
            await seedRun(141);

            await sweep(ONE_HOUR_LATER);

            expect(await rowsOf(LEASE_EXPIRED)).toEqual([]);
            expect(await rowsOf(DEAD_LETTERED)).toEqual([]);
            expect(await rowsOf(UNCONFIRMED)).toEqual([]);
            expect(LOG_LINES.filter((line) => line.includes('dispatch sweep recovered a run'))).toEqual([]);
        }
    });

    it('names each recovery in the service log without any secret', async () => {
        {
            const run = await seedRun(142);
            await claimSeeded(run, LAPSED_LEASE);

            await sweep(ONE_HOUR_LATER);

            const lines = LOG_LINES.filter((line) => line.includes('dispatch sweep recovered a run'));
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain(run.correlationId);
            expect(lines[0]).toContain(LEASE_EXPIRED);
            expect(lines[0]).not.toContain('octocat');
            expect(lines[0]).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
        }
    });

    it('recovers several stranded runs in one pass', async () => {
        {
            const first = await seedRun(151);
            const second = await seedRun(152);
            await claimSeeded(first, LAPSED_LEASE);
            await claimSeeded(second, LAPSED_LEASE);

            const outcome = await sweep(ONE_HOUR_LATER);

            expect(outcome.recoveries.map((recovery) => recovery.run.correlationId).toSorted(byText))
                .toEqual([first.correlationId, second.correlationId].toSorted(byText));
            expect(await rowsOf(LEASE_EXPIRED)).toHaveLength(2);
        }
    });

    it('halves the shorter of the two durations for its cadence', async () => {
        {
            expect(sweepIntervalMs({ leaseMs: 120_000, resultDeadlineMs: 120_000 })).toBe(60_000);
            expect(sweepIntervalMs({ leaseMs: 600_000, resultDeadlineMs: 30_000 })).toBe(15_000);
            expect(sweepIntervalMs({ leaseMs: 45_000, resultDeadlineMs: 300_000 })).toBe(22_500);
            expect(sweepIntervalMs(DEFAULT_CONFIG)).toBe(60_000);
        }
    });

});

describe('T-009 the enqueued path still joins an in-flight run', () => {
    it('keeps coalescing into a run the claim leased, without un-claiming it', async () => {
        {
            const run = await seedRun(161);
            await claimSeeded(run, LIVE_LEASE);

            await enqueueEvents({
                store,
                log: LOGGER,
                incoming: [createEvent({ ...assignment(161), kind: 'mention', origin: 'comment', commentId: 4_242 })],
            });
            const joined = await readRun(run.correlationId);
            const document = await readRunsDocument({ store, log: LOGGER });

            expect(document.runs).toHaveLength(1);
            expect(joined.sourceReferences).toHaveLength(2);
            expect(joined.referenceCount).toBe(2);
            expect(joined.state).toBe('claimed');
            expect(joined.lease?.holder).toBe(HOLDER);
            // A delivery that arrives after authorization is marked as such (FR-015).
            expect(joined.sourceReferences.at(-1)?.presentAtAuthorization).toBe(true);
        }
    });

    it('marks a delivery that arrives after the reservation as post-authorization', async () => {
        {
            const run = await seedRun(162);
            await claimSeeded(run, LIVE_LEASE);
            await reserveSeeded(run);

            await enqueueEvents({
                store,
                log: LOGGER,
                incoming: [createEvent({ ...assignment(162), kind: 'mention', origin: 'comment', commentId: 7 })],
            });
            const joined = await readRun(run.correlationId);

            expect(joined.state).toBe('starting');
            expect(joined.sourceReferences.at(-1)?.presentAtAuthorization).toBe(false);
        }
    });

});
