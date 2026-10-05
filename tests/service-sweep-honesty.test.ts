/**
 * The honesty, durability, and footgun properties the Wave 2 review found in
 * the claim/sweep path (003 T-040).
 *
 * These are the findings a green suite would not have caught — each one is a
 * behaviour that was *wrong*, not a crash:
 *
 * - **(a) `pendingCount` grew with finished work.** It counted delivery rows,
 *   and a post-003 delivery carries no lifecycle state of its own, so every
 *   completed run's deliveries kept counting and the number never fell below
 *   the truth. Now derived from `runs.json`, which is what the contract
 *   already promised (005 pins the value in AC-104).
 * - **(b) FR-063 had no mechanism outside the result route.** The claim answer
 *   now carries `auditWritten`, and the sweep's rows are backed by the durable
 *   intent outbox, so a failed append is retried rather than lost — the sweep
 *   has no caller to answer, so its trail is the only record it has.
 * - **(c) `dispatch.unconfirmed` wrote a live authorization into a retained,
 *   operator-facing file.** An unconsumed dispatch token is exactly what FR-061
 *   forbids, and the project's secret guard cannot see it because `dtk-` is not
 *   a credential shape. A service-derived fingerprint replaces it, and a scan
 *   asserts **no** audit row anywhere carries a `dtk-` value.
 * - **(d) The claim's read occupied the exclusive chain even when it leased
 *   nothing** — a poll from every panel queueing behind a no-op.
 * - **(e) Migration provenance was a `migration-` id prefix** the parser
 *   accepted as any non-empty string, so a stored value no build could mint
 *   decided the sweep's budget accounting. Now a typed member, with the parser
 *   tightened to the two legal id shapes.
 * - **(f) The first sweep tick was armed from the default config**, so an
 *   operator whose `leaseMs` sat at its 30,000 ms minimum waited 60,000 ms for
 *   the first pass — the recovery arriving later than the lease it recovers.
 * - **(g) `requeueExpiredRun` was an uncalled wrapper that charged the budget
 *   and never dead-lettered**: a Wave 3 author reaching for it would requeue a
 *   run forever. Deleted, with the sweep named as the only caller.
 * - **(h) A quarantined `runs.json` surfaced as `500 internal`.** Now the
 *   documented `503 storage-unavailable` the transport already maps.
 *
 * Everything runs offline against temp stores with injected stamps: no host, no
 * network, and no sleeping on a timer.
 */

import { writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import type { AuditEntry } from '../service/audit.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { buildDispatchToken } from '../service/poll/run-key.ts';
import { readRunsDocument, writeRunsDocument } from '../service/poll/runs.ts';
import { readSweepDurations, sweepIntervalMs, sweepOnce } from '../service/poll/sweep.ts';
import { parseRunAuditIntents } from '../service/poll/runs-audit-parse.ts';
import { readBindings } from '../service/bindings-read.ts';
import { writeBindings } from '../service/bindings.ts';
import { readStatusRows } from '../service/routes/events.ts';
import { openStore } from '../service/store/index.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { Run } from '../service/poll/runs-types.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { makeStoreTree, removeTempTree } from './support/temp-tree.ts';

const DETECTED_AT = '2026-09-28T12:00:00.000Z';
const ONE_HOUR_LATER = '2026-09-28T13:00:00.000Z';
/** Past `LAPSED_LEASE`, before a 600,000 ms lease issued at `DETECTED_AT`. */
const WITHIN_LEASE = '2026-09-28T12:05:00.000Z';
const RESULT_DEADLINE = '2026-09-28T12:02:00.000Z';
const LAPSED_LEASE = '2026-09-28T12:01:00.000Z';
const HOLDER = 'panel-honesty';
const BINDING_ID = 'bnd-honesty';
const OTHER_BINDING_ID = 'bnd-other';
const REPOSITORY = 'acme/widget';
const ACCOUNT_ID = '77331';
const RUNS_FILE = 'runs.json';
/** The one audit row the lease-expiry recovery writes. */
const LEASE_EXPIRED = 'dispatch.lease-expired';
/** The one audit row the deadline wedge writes. */
const UNCONFIRMED = 'dispatch.unconfirmed';
/** The one audit row the budget exhaustion writes. */
const DEAD_LETTERED = 'run.dead_lettered';
/** A stored dispatch token, used only where a run must record having reserved. */
const FIXTURE_DISPATCH_TOKEN = 'dtk-0123456789abcdef0123456789abcdef';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'debug', sink: (line) => void LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    ({ root: tempRoot, dataDir } = await makeStoreTree('honesty'));
    store = await openStore({ dataDir });
    LOG_LINES.length = 0;
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    await removeTempTree(tempRoot);
});

/** Build an assignment detection for one issue on the fixture binding. */
function assignment(issueNumber: number, bindingId = BINDING_ID): EventSnapshot {
    return {
        bindingId,
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
        detectedAt: DETECTED_AT,
    };
}

/** Enqueue detections, one per issue. */
async function seed(...snapshots: readonly EventSnapshot[]): Promise<void> {
    await enqueueEvents({ store, log: LOGGER, incoming: snapshots.map((snapshot) => createEvent(snapshot)) });
}

/** One stored binding record for the status-row reader. */
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
        createdAt: DETECTED_AT,
        updatedAt: DETECTED_AT,
    };
}

/** Persist the bindings the status reader is given, so the store agrees. */
async function storeBindings(...ids: readonly string[]): Promise<void> {
    await writeBindings({ store, bindings: ids.map((id) => binding(id)) });
}

/** Claim with the shared fixture holder and stamp. */
async function claim(): ReturnType<typeof claimPendingRuns> {
    return await claimPendingRuns({ store, log: LOGGER, holder: HOLDER, now: DETECTED_AT });
}

/** Read the bindings the store holds, the way a route would before a status read. */
async function storedBindings(): Promise<readonly BindingRecord[]> {
    return await readBindings({ store, log: LOGGER });
}

/** Read one stored run back, failing the test if it is gone. */
async function readRun(correlationId: string): Promise<Run> {
    const document = await readRunsDocument({ store, log: LOGGER });
    const run = document.runs.find((candidate) => candidate.correlationId === correlationId);
    if (run === undefined) {
        throw new Error('run is no longer stored');
    }

    return run;
}

/**
 * Read the run document's durable audit outbox straight off disk.
 *
 * Deliberately bypasses `readRunsDocument`, which drains the outbox as a side
 * effect — the point of these tests is to observe the intents *between* a sweep
 * and the next reader.
 *
 * @returns The stored intents, or `null` when the outbox does not parse.
 */
async function storedIntents(): Promise<readonly unknown[] | null> {
    const stored = await store.readJson(RUNS_FILE, (raw) => raw);
    if (stored.status !== 'ok' || typeof stored.value !== 'object' || stored.value === null) {
        return null;
    }

    return parseRunAuditIntents((stored.value as { auditIntents?: unknown }).auditIntents);
}

/**
 * Push one run's live lease into the past, as a crashed panel leaves it.
 *
 * The lease itself is always minted by the real claim — a hand-written one
 * would not carry the run's current attempt, which the store's parser (rightly)
 * refuses — so only the expiry is moved.
 *
 * @returns The run as it now stands.
 */
async function lapseLeaseOf(correlationId: string): Promise<Run> {
    const document = await readRunsDocument({ store, log: LOGGER });
    await writeRunsDocument({
        store,
        log: LOGGER,
        document: {
            ...document,
            runs: document.runs.map((run) => (run.correlationId === correlationId && run.lease !== null
                ? { ...run, lease: { ...run.lease, expiresAt: LAPSED_LEASE } }
                : run)),
        },
    });

    return await readRun(correlationId);
}

/** Claim the run waiting for one issue, as the panel would. */
async function claimRun(issueNumber: number): Promise<string> {
    const result = await claim();
    const claimed = result.runs.find((run) => run.issueNumber === issueNumber);
    if (claimed === undefined) {
        throw new Error(`the run for issue ${issueNumber} was not claimed`);
    }

    return claimed.correlationId;
}

/** Move one run into `claimed` with a lapsed lease, as a crashed panel leaves it. */
async function strandClaim(issueNumber: number): Promise<Run> {
    await seed(assignment(issueNumber));

    return await lapseLeaseOf(await claimRun(issueNumber));
}

/** Move one run into `starting` with a reservation and a live token. */
async function reserveAndAbandon(issueNumber: number): Promise<Run> {
    const claimed = await strandClaim(issueNumber);
    const document = await readRunsDocument({ store, log: LOGGER });
    const dispatchToken = buildDispatchToken(claimed.runKey, claimed.attempt);
    await writeRunsDocument({
        store,
        log: LOGGER,
        document: {
            ...document,
            runs: document.runs.map((run) => (run.correlationId === claimed.correlationId
                ? {
                    ...run,
                    state: 'starting' as const,
                    stateReason: 'authorized; the panel never reported a result',
                    reservation: {
                        dispatchToken,
                        attempt: run.attempt,
                        reservedAt: DETECTED_AT,
                        resultDeadlineAt: RESULT_DEADLINE,
                        consumed: false,
                    },
                }
                : run)),
        },
    });

    return await readRun(claimed.correlationId);
}

describe('T-040a pendingCount counts waiting runs, not deliveries', () => {
    it('counts only waiting runs, never claimed or dispatched ones', async () => {
        {
            // The longest documented lease, so a claim at DETECTED_AT stays live
            // until 12:10:00 and the sweep can requeue exactly the lease this test
            // lapses by hand.
            await store.writeJson('config.json', { ...DEFAULT_CONFIG, leaseMs: 600_000, resultDeadlineMs: 600_000 });
            await storeBindings(BINDING_ID);
            await seed(assignment(1), assignment(2), assignment(3));
            const before = await readStatusRows({
                store,
                log: LOGGER,
                bindings: await storedBindings(),
            });

            // Three waiting runs. The old implementation counted the three delivery
            // rows and would keep reporting 3 through the rest of this test.
            expect(before[0]?.pendingCount).toBe(3);

            const claimed = await claim();
            expect(claimed.runs).toHaveLength(3);
            const afterClaim = await readStatusRows({
                store,
                log: LOGGER,
                bindings: await storedBindings(),
            });
            // All three are leased, so none is waiting — the count has to fall, not
            // stay where the delivery count left it.
            expect(afterClaim[0]?.pendingCount).toBe(0);

            // One lease lapses and the sweep requeues it, one reports a session, and
            // the third stays claimed: exactly one run is waiting.
            const [requeued, dispatched] = claimed.runs;
            await lapseLeaseOf(requeued?.correlationId ?? '');
            await sweepOnce({ store, log: LOGGER, now: WITHIN_LEASE });
            const document = await readRunsDocument({ store, log: LOGGER });
            await writeRunsDocument({
                store,
                log: LOGGER,
                document: {
                    ...document,
                    runs: document.runs.map((run) => (run.correlationId === dispatched?.correlationId
                        ? {
                            ...run,
                            state: 'dispatched' as const,
                            stateReason: 'session ses_done created',
                            lease: null,
                            attempts: [{
                                attempt: run.attempt,
                                dispatchToken: FIXTURE_DISPATCH_TOKEN,
                                reservedAt: DETECTED_AT,
                                outcome: 'dispatched' as const,
                                sessionId: 'ses_done',
                                reason: null,
                                resultReportedAt: DETECTED_AT,
                            }],
                            session: {
                                sessionId: 'ses_done',
                                attachmentId: run.attachmentId,
                                dispatchedAt: DETECTED_AT,
                                title: '',
                                sourceUrl: run.sourceReferences[0]?.sourceUrl ?? '',
                                worktree: null,
                            },
                        }
                        : run)),
                },
            });
            const settled = await readStatusRows({
                store,
                log: LOGGER,
                bindings: await storedBindings(),
            });

            // One requeued run waiting; one dispatched run and one still-claimed run
            // are not waiting, so neither counts.
            expect(settled[0]?.pendingCount).toBe(1);
        }
    });

    it('keys the count per binding, so one binding work is not another', async () => {
        {
            await storeBindings(BINDING_ID, OTHER_BINDING_ID);
            await seed(assignment(1, BINDING_ID), assignment(2, BINDING_ID), assignment(3, OTHER_BINDING_ID));
            const rows = await readStatusRows({
                store,
                log: LOGGER,
                bindings: await storedBindings(),
            });

            expect(rows.find((row) => row.bindingId === BINDING_ID)?.pendingCount).toBe(2);
            expect(rows.find((row) => row.bindingId === OTHER_BINDING_ID)?.pendingCount).toBe(1);
        }
    });

    it('reports zero for a binding with no runs at all', async () => {
        {
            await storeBindings(BINDING_ID);
            const rows = await readStatusRows({ store, log: LOGGER, bindings: await readBindings({
                store, log: LOGGER }) });

            expect(rows[0]?.pendingCount).toBe(0);
        }
    });

});

describe('T-040b the sweep owes a durable, recoverable audit trail (FR-063)', () => {
    it('reports auditWritten true when every row landed', async () => {
        {
            await strandClaim(31);

            const outcome = await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });

            expect(outcome.recoveries).toHaveLength(1);
            expect(outcome.auditWritten).toBe(true);
        }
    });

    it('backs each owed row with an intent the next read drains', async () => {
        {
            const run = await strandClaim(32);
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });

            // The intent survives in `runs.json` until a reader retires it, and is
            // byte-parsable by the strict outbox parser.
            const intents = await storedIntents();
            expect(intents).toHaveLength(1);
            expect(intents?.[0]).toMatchObject({
                eventType: 'dispatch.lease-expired',
                correlationId: run.correlationId,
                decision: 'requeued',
            });
        }
    });

    it('retires the intent once the row is durable, writing no second row', async () => {
        {
            await strandClaim(33);
            const first = await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            const firstEntries = await readAuditEntries(store);
            const rowsAfterFirst = firstEntries.filter((entry) => entry.eventType === LEASE_EXPIRED);

            expect(rowsAfterFirst).toHaveLength(1);

            // Any later read drains the outbox; the row must not be duplicated.
            await readRunsDocument({ store, log: LOGGER });
            const drained = await readAuditEntries(store);
            const rowsAfterDrain = drained.filter((entry) => entry.eventType === LEASE_EXPIRED);

            expect(rowsAfterDrain).toHaveLength(1);
            expect(await storedIntents()).toEqual([]);
            expect(first.auditWritten).toBe(true);
        }
    });

    it('distinguishes a second recovery of the same run from the first', async () => {
        {
            const first = await strandClaim(34);
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            const firstEntries = await readAuditEntries(store);
            const rowsAfterFirst = firstEntries.filter((entry) => entry.eventType === LEASE_EXPIRED);

            // Re-claim and expire again: the same run, the same event type, one more
            // row. A matcher that compared only the event type would retire this
            // intent against the first row and never write it.
            await lapseLeaseOf(await claimRun(34));
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            const secondEntries = await readAuditEntries(store);
            const rowsAfterSecond = secondEntries.filter((entry) => entry.eventType === LEASE_EXPIRED);

            expect(rowsAfterFirst).toHaveLength(1);
            expect(rowsAfterSecond).toHaveLength(2);
            expect(rowsAfterSecond[1]?.details.attemptAfter).toBe(3);
            expect(first.correlationId).toBe(rowsAfterSecond[1]?.correlationId);
        }
    });

});

describe('T-040c no audit row ever carries a dispatch token value (FR-061)', () => {
    it('names the outstanding token by fingerprint only', async () => {
        {
            const reserved = await reserveAndAbandon(41);
            const token = reserved.reservation?.dispatchToken ?? '';
            expect(token).toMatch(/^dtk-[0-9a-f]{32}$/);

            const outcome = await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            const entries = await readAuditEntries(store);
            const unconfirmed = entries.find((entry) => entry.eventType === UNCONFIRMED);
            const details = unconfirmed?.details as Record<string, unknown>;

            expect(outcome.recoveries[0]?.eventType).toBe('dispatch.unconfirmed');
            expect(details.dispatchTokenFingerprint).toMatch(/^tokfp-[0-9a-f]{16}$/);
            expect(details.dispatchToken).toBeUndefined();
            // The row is the only place the token could have leaked, so the whole
            // row is scanned rather than just the member the fix changed.
            expect(JSON.stringify(unconfirmed)).not.toContain(token);
        }
    });

    it('produces a different fingerprint for each outstanding authorization', async () => {
        {
            const first = await reserveAndAbandon(42);
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            const second = await reserveAndAbandon(43);
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            const rows = await readAuditEntries(store);
            const fingerprints = rows
                .filter((entry) => entry.eventType === UNCONFIRMED)
                .map((entry) => (entry.details as Record<string, unknown>).dispatchTokenFingerprint);

            // Two runs, two tokens: the fingerprint identifies which authorization
            // was outstanding without carrying it.
            expect(fingerprints).toHaveLength(2);
            expect(new Set(fingerprints).size).toBe(2);
            expect(first.reservation?.dispatchToken).not.toBe(second.reservation?.dispatchToken);
        }
    });

    it('scans every audit row the service wrote for a token-shaped value', async () => {
        {
            // The strongest form of the assertion: drive the paths that write
            // lifecycle rows, then scan the entire trail — not one row, not one
            // event type — for the token prefix.
            await strandClaim(44);
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            await reserveAndAbandon(45);
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
            await seed(assignment(46));
            await claim();
            await readStatusRows({ store, log: LOGGER, bindings: await readBindings({ store, log: LOGGER }) });

            const entries: readonly AuditEntry[] = await readAuditEntries(store);
            expect(entries.length).toBeGreaterThan(0);
            for (const entry of entries) {
                const row = JSON.stringify(entry);
                expect(row, `${entry.eventType} carried a dispatch token`).not.toMatch(/dtk-[0-9a-f]{8,}/);
            }
        }
    });

    it('leaves the project secret guard alone: a token is not a credential shape', async () => {
        {
            // `SECRET_PATTERNS` deliberately does NOT include `dtk-`: 003 T-019
            // legitimately stores tokens in panel storage, so a guard that refused
            // them would break the feature. The defence is this scan, not redaction.
            const { findSecretLeak } = await import('../src/redaction.ts');
            expect(findSecretLeak('dtk-0123456789abcdef0123456789abcdef')).toBeNull();
        }
    });

});

describe('T-040d the claim reads outside the chain and writes only when needed', () => {
    it('writes nothing at all when no run is waiting', async () => {
        const writes: string[] = [];
        const watched = {
            ...store,
            writeJson: async (path: string, value: unknown): Promise<void> => {
                writes.push(path);
                await store.writeJson(path, value);
            },
        };

        await seed(assignment(51));
        await claimPendingRuns({
            store: watched,
            log: LOGGER,
            holder: HOLDER,
            now: DETECTED_AT,
        });
        writes.length = 0;

        const second = await claimPendingRuns({
            store: watched,
            log: LOGGER,
            holder: HOLDER,
            now: DETECTED_AT,
        });

        expect(second.runs).toEqual([]);
        expect(second.deferred).toBe(0);
        expect(writes).toEqual([]);
    });
});

describe('T-040e lease provenance is typed, and the parser refuses anything else', () => {
    it('records adoption provenance as a member, not an id prefix alone', async () => {
        {
            const run = await strandClaim(61);

            expect(run.lease?.provenance).toBe('panel');

            const document = await readRunsDocument({ store, log: LOGGER });
            const stored = JSON.stringify(document.runs[0]?.lease);
            expect(stored).toContain('"provenance":"panel"');
        }
    });

    it('refuses a lease whose id is neither of the two shapes this build mints', async () => {
        {
            const run = await strandClaim(62);
            const document = await readRunsDocument({ store, log: LOGGER });
            await store.writeJson(RUNS_FILE, {
                ...document,
                runs: document.runs.map((candidate) => (candidate.correlationId === run.correlationId
                    ? { ...candidate, lease: { ...candidate.lease, leaseId: 'lease-anything-at-all' } }
                    : candidate)),
            });

            // A quarantined document is refused rather than served (constitution II).
            const reopened = await openStore({ dataDir });
            await expect(readRunsDocument({ store: reopened, log: LOGGER })).rejects.toThrow('run document');
        }
    });

    it('refuses a lease with no provenance member at all', async () => {
        {
            const run = await strandClaim(63);
            const document = await readRunsDocument({ store, log: LOGGER });
            await store.writeJson(RUNS_FILE, {
                ...document,
                runs: document.runs.map((candidate) => {
                    if (candidate.correlationId !== run.correlationId || candidate.lease === null) {
                        return candidate;
                    }
                    const lease = Object.fromEntries(
                        Object.entries(candidate.lease).filter(([key]) => key !== 'provenance'),
                    );

                    return { ...candidate, lease };
                }),
            });

            const reopened = await openStore({ dataDir });
            await expect(readRunsDocument({ store: reopened, log: LOGGER })).rejects.toThrow('run document');
        }
    });

    it('accepts both legal shapes, so adoption recovery still works', async () => {
        {
            const run = await strandClaim(64);
            const document = await readRunsDocument({ store, log: LOGGER });
            await store.writeJson(RUNS_FILE, {
                ...document,
                runs: document.runs.map((candidate) => (candidate.correlationId === run.correlationId
                    ? {
                        ...candidate,
                        lease: candidate.lease === null
                            ? null
                            : {
                                ...candidate.lease,
                                leaseId: `migration-${candidate.correlationId}`,
                                provenance: 'migration',
                            },
                    }
                    : candidate)),
            });
            const reopened = await openStore({ dataDir });
            const migrated = await readRunsDocument({ store: reopened, log: LOGGER });
            const lease = migrated.runs[0]?.lease;

            expect(lease?.leaseId).toBe(`migration-${run.correlationId}`);
            expect(lease?.provenance).toBe('migration');
        }
    });

});

describe('T-040f the first sweep tick is armed from the stored durations', () => {
    it('reads the operator minimum rather than the default when arming', async () => {
        {
            await store.writeJson('config.json', {
                ...DEFAULT_CONFIG,
                leaseMs: 30_000,
                resultDeadlineMs: 30_000,
            });
            const stored = await readSweepDurations({ store, log: LOGGER });

            // The defect: arming from DEFAULT_CONFIG would schedule the first pass
            // at 60,000 ms, so a lease expiring at 30,000 ms would wait a whole
            // extra lease duration before anything recovered it.
            expect(sweepIntervalMs(stored)).toBe(15_000);
            expect(sweepIntervalMs(stored)).toBeLessThan(sweepIntervalMs(DEFAULT_CONFIG));
            expect(sweepIntervalMs(DEFAULT_CONFIG)).toBe(60_000);
        }
    });

    it('answers the defaults when the configuration cannot be read', async () => {
        {
            const stored = await readSweepDurations({ store, log: LOGGER });

            expect(stored).toEqual({
                leaseMs: DEFAULT_CONFIG.leaseMs, resultDeadlineMs: DEFAULT_CONFIG.resultDeadlineMs });
        }
    });

});

describe('T-040h a quarantined runs.json answers the documented 503', () => {
    it('raises the store error the transport maps to storage-unavailable', async () => {
        await writeFile(join(dataDir, RUNS_FILE), '{ not json at all', 'utf8');
        const reopened = await openStore({ dataDir });

        // `StorageUnavailableError` carries the wire code, so the route answers
        // `503 storage-unavailable` rather than a misleading `500 internal`.
        await expect(readRunsDocument({ store: reopened, log: LOGGER })).rejects.toMatchObject({
            name: 'StorageUnavailableError',
            code: 'storage-unavailable',
        });
    });
});

describe('T-040g the sweep is the only requeue path', () => {
    it('exports no single-run requeue wrapper that could bypass the budget', async () => {
        {
            // `requeueExpiredRun` charged the requeue budget and never dead-lettered,
            // so a caller reaching for it would requeue a run forever. The sweep's
            // batch planner is the only definition of the transition now.
            const storeModule = await import('../service/poll/runs.ts');
            expect('requeueExpiredRun' in storeModule).toBe(false);
            expect('markUnconfirmed' in storeModule).toBe(false);
        }
    });

    it('still parks a run whose budget is spent, through the sweep alone', async () => {
        {
            const run = await strandClaim(71);

            // Three requeues are consumed, then the fourth expiry parks the run —
            // the exact behaviour the deleted wrapper bypassed.
            for (let round = 1; round <= 3; round += 1) {
                await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });
                await lapseLeaseOf(await claimRun(71));
            }
            await sweepOnce({ store, log: LOGGER, now: ONE_HOUR_LATER });

            const parked = await readRun(run.correlationId);
            const entries = await readAuditEntries(store);
            const rows = entries.filter((entry) => entry.eventType === DEAD_LETTERED);

            expect(parked.state).toBe('dead-lettered');
            expect(parked.requeuesUsed).toBe(3);
            expect(rows).toHaveLength(1);
        }
    });

});
