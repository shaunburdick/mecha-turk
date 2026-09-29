/** Durable run allocation, transitions, and coalescing (003 T-003/T-006). */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { createLogger } from '../service/log.ts';
import {
    claimPendingEvents,
    createEvent,
    enqueueEvents,
    readEvents,
} from '../service/poll/events.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import {
    MAX_SOURCE_REFERENCES,
    claimRun,
    emptyRunsDocument,
    readRunsDocument,
    reserveRun,
    applyResult,
    writeRunsDocument,
} from '../service/poll/runs.ts';
import { openStore } from '../service/store/index.ts';
import type { ServiceStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { Run } from '../service/poll/runs-types.ts';

const STAMP = '2026-09-28T12:00:00.000Z';
const HOLDER = 'panel-mount-1';
const LEASE_ID = 'lease-test-1';
const SESSION_ID = 'ses_once';
const RUN_SUBJECT_KEY = 'github|77331|acme/widget|issue|900';
const DELIVERY_DETECTED = 'delivery.detected';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-run-enqueue-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/** Build an assignment fixture for one issue. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: 'bnd-run-tests',
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
            issueBodyExcerpt: 'body excerpt',
        },
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** Build a comment mention fixture, with a unique deterministic delivery id. */
function commentMention(issueNumber: number, commentId: number): EventSnapshot {
    return {
        ...assignment(issueNumber),
        kind: 'mention',
        origin: 'comment',
        commentId,
        triggerNote: `comment ${commentId} mention`,
    };
}

/** Build an issue-body mention fixture with the assignment's same subject. */
function bodyMention(issueNumber: number): EventSnapshot {
    return {
        ...assignment(issueNumber),
        kind: 'mention',
        origin: 'body',
        triggerNote: 'body mention',
    };
}

/** Enqueue a set of snapshots and return the linked rows. */
async function enqueue(snapshots: readonly EventSnapshot[]) {
    return await enqueueEvents({
        store,
        log: LOGGER,
        incoming: snapshots.map(createEvent),
    });
}

/** Create one pending run fixture through the same pure writer as production. */
function runFixture(): Run {
    const row = createEvent(assignment(900));
    const result = applyEnqueue({ document: emptyRunsDocument(), deliveries: [row], now: STAMP });
    const run = result.created[0];
    if (run === undefined) {
        throw new Error('run fixture was not created');
    }

    return run;
}

describe('T-006 run-aware enqueue', () => {
    it('coalesces assignment and body mention from one scan and correlates every audit row', async () => {
        const added = await enqueue([assignment(12), bodyMention(12)]);
        const document = await readRunsDocument({ store, log: LOGGER });
        const audits = await readAuditEntries(store);

        expect(document.runs).toHaveLength(1);
        expect(document.runs[0]?.sourceReferences.map((reference) => reference.kind)).toEqual([
            'assignment',
            'mention',
        ]);
        expect(added).toHaveLength(2);
        expect(added.every((event) => event.runCorrelationId === document.runs[0]?.correlationId)).toBe(true);
        expect(audits.map((entry) => entry.eventType)).toEqual([
            'run.created',
            'run.coalesced',
            DELIVERY_DETECTED,
            DELIVERY_DETECTED,
        ]);
        expect(audits.every((entry) => entry.correlationId === document.runs[0]?.correlationId)).toBe(true);
    });

    it('joins a later-scan comment to the existing non-terminal run', async () => {
        await enqueue([assignment(14)]);
        await enqueue([commentMention(14, 42)]);

        const document = await readRunsDocument({ store, log: LOGGER });
        const queue = await readEvents({ store, log: LOGGER });

        expect(document.runs).toHaveLength(1);
        expect(document.runs[0]?.sourceReferences).toHaveLength(2);
        expect(queue.map((event) => event.runCorrelationId)).toEqual([
            document.runs[0]?.correlationId,
            document.runs[0]?.correlationId,
        ]);
    });

    it('opens the next ordinal after the prior run has a recorded session', async () => {
        const [delivery] = await enqueue([assignment(16)]);
        const first = await readRunsDocument({ store, log: LOGGER });
        const correlationId = first.runs[0]?.correlationId;
        if (correlationId === undefined) {
            throw new Error('first run missing');
        }

        const claim = await claimRun({
            store,
            log: LOGGER,
            correlationId,
            holder: HOLDER,
            leaseId: LEASE_ID,
            issuedAt: STAMP,
            expiresAt: '2026-09-28T12:05:00.000Z',
            now: STAMP,
        });
        expect(claim.status).toBe('applied');
        const reservation = await reserveRun({
            store,
            log: LOGGER,
            correlationId,
            leaseId: LEASE_ID,
            resultDeadlineAt: '2026-09-28T12:10:00.000Z',
            now: STAMP,
        });
        expect(reservation.status).toBe('applied');
        const result = await applyResult({
            store,
            log: LOGGER,
            correlationId,
            sessionId: 'ses_existing',
            problem: null,
            now: STAMP,
        });
        expect(result.status).toBe('applied');

        const second = await enqueue([commentMention(16, 4242)]);
        const document = await readRunsDocument({ store, log: LOGGER });

        expect(delivery?.runCorrelationId).toBe(first.runs[0]?.correlationId);
        expect(second[0]?.runCorrelationId).not.toBe(delivery?.runCorrelationId);
        expect(document.runs.map((run) => run.ordinal)).toEqual([0, 1]);
    });

    it('heals a crash after runs.json by joining the redetected delivery once', async () => {
        let failQueueWrite = true;
        const interruptedStore: ServiceStore = {
            ...store,
            writeJson: async (path, value) => {
                if (path === 'events.json' && failQueueWrite) {
                    failQueueWrite = false;
                    throw new Error('simulated queue write interruption');
                }

                await store.writeJson(path, value);
            },
        };
        const event = createEvent(assignment(18));

        await expect(enqueueEvents({ store: interruptedStore, log: LOGGER, incoming: [event] })).rejects.toThrow(
            'simulated queue write interruption',
        );
        const recovered = await enqueueEvents({ store, log: LOGGER, incoming: [event] });
        const document = await readRunsDocument({ store, log: LOGGER });
        const audits = await readAuditEntries(store);

        expect(recovered).toHaveLength(1);
        expect(document.runs).toHaveLength(1);
        expect(document.runs[0]?.sourceReferences).toHaveLength(1);
        expect(audits.map((entry) => entry.eventType)).toEqual(['run.coalesced', DELIVERY_DETECTED]);
    });

    it('serializes concurrent trigger deliveries on the shared queue/run chain', async () => {
        const scans = Array.from({ length: 10 }, (_unused, index) => enqueue([commentMention(20, index + 1)]));
        const concurrentClaim = claimPendingEvents({ store, log: LOGGER, claimedAt: STAMP });
        const [results, claimed] = await Promise.all([Promise.all(scans), concurrentClaim]);
        const document = await readRunsDocument({ store, log: LOGGER });

        expect(claimed).toEqual([]);
        expect(results.reduce((total, rows) => total + rows.length, 0)).toBe(10);
        expect(document.runs).toHaveLength(1);
        expect(document.runs[0]?.referenceCount).toBe(10);
        expect(document.runs[0]?.sourceReferences).toHaveLength(10);
    });

    it('caps references while retaining total count and truncation state', async () => {
        const manyComments = Array.from(
            { length: MAX_SOURCE_REFERENCES + 5 },
            (_unused, index) => commentMention(22, index + 1),
        );
        await enqueue(manyComments);
        const document = await readRunsDocument({ store, log: LOGGER });
        const run = document.runs[0];

        expect(run?.sourceReferences).toHaveLength(MAX_SOURCE_REFERENCES);
        expect(run?.referenceCount).toBe(MAX_SOURCE_REFERENCES + 5);
        expect(run?.referencesTruncated).toBe(true);
    });
});

describe('T-003 run transition invariants', () => {
    it('permits one lease and one session for a run, refusing competing mutations', async () => {
        const fixture = runFixture();
        await writeRunsDocument({
            store,
            log: LOGGER,
            document: {
                ...emptyRunsDocument(),
                subjects: { [RUN_SUBJECT_KEY]: 1 },
                runs: [fixture],
            },
        });
        const claimInputs = {
            store,
            log: LOGGER,
            correlationId: fixture.correlationId,
            holder: HOLDER,
            leaseId: LEASE_ID,
            issuedAt: STAMP,
            expiresAt: '2026-09-28T12:05:00.000Z',
            now: STAMP,
        };

        const firstClaim = claimRun(claimInputs);
        const competingClaim = claimRun({ ...claimInputs, leaseId: 'lease-test-2' });
        const claims = await Promise.all([firstClaim, competingClaim]);
        expect(claims.filter((result) => result.status === 'applied')).toHaveLength(1);
        expect(claims.filter((result) => result.status === 'refused')).toHaveLength(1);

        const reservationInput = {
            store,
            log: LOGGER,
            correlationId: fixture.correlationId,
            leaseId: LEASE_ID,
            resultDeadlineAt: '2026-09-28T12:10:00.000Z',
            now: STAMP,
        };
        const reservations = await Promise.all([reserveRun(reservationInput), reserveRun(reservationInput)]);
        expect(reservations.filter((result) => result.status === 'applied')).toHaveLength(1);
        expect(reservations.filter((result) => result.status === 'refused')).toHaveLength(1);

        const resultInput = {
            store,
            log: LOGGER,
            correlationId: fixture.correlationId,
            sessionId: SESSION_ID,
            problem: null,
            now: STAMP,
        };
        const results = await Promise.all([applyResult(resultInput), applyResult(resultInput)]);
        expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'refused')).toHaveLength(1);
        const final = await readRunsDocument({ store, log: LOGGER });
        expect(final.runs[0]?.session?.sessionId).toBe(SESSION_ID);
        expect(final.runs[0]?.attempts).toHaveLength(1);
        expect(final.runs[0]?.attempts[0]?.outcome).toBe('dispatched');
        expect(final.runs[0]?.attempts[0]?.dispatchToken).toMatch(/^dtk-[0-9a-f]{32}$/);
    });

    it('never reuses an ordinal after terminal-run retention evicts old rows', async () => {
        let document = emptyRunsDocument();
        for (let ordinal = 0; ordinal < 501; ordinal += 1) {
            const created = applyEnqueue({
                document,
                deliveries: [createEvent(assignment(24))],
                now: STAMP,
            });
            document = {
                ...created.document,
                runs: created.document.runs.map((run) => ({
                    ...run,
                    state: 'dispatched',
                    stateReason: 'session created',
                })),
            };
        }

        await writeRunsDocument({ store, log: LOGGER, document });
        const retained = await readRunsDocument({ store, log: LOGGER });
        const next = applyEnqueue({
            document: retained,
            deliveries: [createEvent(commentMention(24, 777))],
            now: STAMP,
        });

        expect(retained.runs).toHaveLength(500);
        expect(retained.subjects['github|77331|acme/widget|issue|24']).toBe(501);
        expect(next.created[0]?.ordinal).toBe(501);
    });
});
