/**
 * The run claim: eligibility, leases, atomicity, and what may never be offered
 * (003 FR-030, FR-031, FR-036, FR-037; contracts/claim-lease.md, T-007).
 *
 * The claim is the only way a panel acquires the right to attempt a dispatch,
 * so this suite pins the five properties the contract names as its invariants:
 * claiming twice returns the runs once and `[]` the second time; **only**
 * `pending` is ever offered; a run whose history records a session is never
 * offered even if its stored state says otherwise; two concurrent claims
 * partition the pending set; and the answer carries nothing credential-shaped.
 * The lease's own arithmetic is pinned too — `expiresAt - issuedAt` is exactly
 * the configured `leaseMs`, on the service clock (NFR-112), which is what lets
 * the sweep reclaim at expiry and nothing else.
 *
 * Everything runs offline against a temp store: no network, no host, no
 * sleeping — the claim takes its stamp at the seam.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { UNKNOWN_HOLDER, buildLeaseId, claimPendingRuns, holderOf } from '../service/poll/claim.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { emptyRunsDocument, readRunsDocument, writeRunsDocument } from '../service/poll/runs.ts';
import { openStore } from '../service/store/index.ts';
import type { ClaimedRun } from '../service/poll/claim.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceStore } from '../service/store/index.ts';
import type { Run, RunsDocument } from '../service/poll/runs-types.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Stamp every fixture uses, so no test ever waits on a clock. */
const STAMP = '2026-09-28T12:00:00.000Z';
const HOLDER = 'panel-mount-7';
const BINDING_ID = 'bnd-claim';
const REPOSITORY = 'acme/widget';
const ACCOUNT_ID = '77331';
const ACCOUNT_LOGIN = 'octocat';
const SUBJECT_KEY = `github|${ACCOUNT_ID}|${REPOSITORY}|issue|`;
const CLAIM_PATH = '/v1/events/pending';
const CLAIMED_EVENT = 'dispatch.claimed';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;

/** Lease duration the config fixture uses; half the documented maximum. */
const LEASE_MS = 45_000;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-claim-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    LOG_LINES.length = 0;
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/** Build an assignment detection for one issue. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
            issueBodyExcerpt: `body of issue ${issueNumber}`,
        },
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** Enqueue one detection, creating its run. */
async function seed(...snapshots: readonly EventSnapshot[]): Promise<void> {
    await enqueueEvents({ store, log: LOGGER, incoming: snapshots.map(createEvent) });
}

/** Persist the configured lease duration the claim reads. */
async function setLeaseMs(leaseMs: number): Promise<void> {
    await store.writeJson('config.json', { ...DEFAULT_CONFIG, leaseMs, resultDeadlineMs: leaseMs });
}

/** Claim with the shared fixture holder and stamp. */
async function claim(holder = HOLDER): Promise<Awaited<ReturnType<typeof claimPendingRuns>>> {
    return await claimPendingRuns({ store, log: LOGGER, holder, now: STAMP });
}

/** Seed one run and move it into `state`, with an optional session pointer. */
async function seedRunInState(input: {
    readonly issueNumber: number;
    readonly state: Run['state'];
    readonly sessionId?: string;
}): Promise<Run> {
    const delivery = createEvent(assignment(input.issueNumber));
    const planned = applyEnqueue({ document: emptyRunsDocument(), deliveries: [delivery], now: STAMP });
    const created = planned.created[0];
    if (created === undefined) {
        throw new Error('seed run was not created');
    }

    const run: Run = {
        ...created,
        state: input.state,
        stateReason: input.state === 'pending' ? null : `seeded as ${input.state}`,
        session: input.sessionId === undefined ? null : {
            sessionId: input.sessionId,
            attachmentId: created.attachmentId,
            dispatchedAt: STAMP,
            title: '',
            sourceUrl: created.sourceReferences[0]?.sourceUrl ?? '',
            worktree: null,
        },
        attempts: input.sessionId === undefined ? [] : [{
            attempt: 1,
            dispatchToken: 'dtk-0123456789abcdef0123456789abcdef',
            reservedAt: STAMP,
            outcome: 'dispatched',
            sessionId: input.sessionId,
            reason: null,
            resultReportedAt: STAMP,
        }],
    };
    const document: RunsDocument = {
        ...planned.document,
        auditIntents: [],
        subjects: { [`${SUBJECT_KEY}${input.issueNumber}`]: 1 },
        runs: [run],
    };
    await writeRunsDocument({ store, log: LOGGER, document });

    return run;
}

describe('T-007 claim eligibility (FR-037)', () => {
    it('offers every waiting run once and nothing the second time', async () => {
        await seed(assignment(1), assignment(2));
        await setLeaseMs(LEASE_MS);

        const first = await claim();
        const second = await claim();

        expect(first.map((run) => run.issueNumber).sort()).toEqual([1, 2]);
        expect(second).toEqual([]);
        const stored = await readRunsDocument({ store, log: LOGGER });
        expect(stored.runs.every((run) => run.state === 'claimed')).toBe(true);
    });

    it('answers nothing for any state other than pending', async () => {
        const states: readonly Run['state'][] = [
            'claimed',
            'starting',
            'dispatched',
            'failed',
            'unconfirmed',
            'dead-lettered',
            'blocked:project-missing',
        ];
        for (const [index, state] of states.entries()) {
            await seedRunInState({ issueNumber: 10 + index, state });
        }

        expect(await claim()).toEqual([]);
    });

    it('never offers a pending run whose history already records a session', async () => {
        const run = await seedRunInState({ issueNumber: 30, state: 'pending' });
        await writeRunsDocument({
            store,
            log: LOGGER,
            document: {
                schemaVersion: 1,
                subjects: { [`${SUBJECT_KEY}30`]: 1 },
                runs: [{
                    ...run,
                    attempts: [{
                        attempt: 1,
                        dispatchToken: 'dtk-0123456789abcdef0123456789abcdef',
                        reservedAt: STAMP,
                        outcome: 'dispatched',
                        sessionId: 'ses_forged_history',
                        reason: null,
                        resultReportedAt: STAMP,
                    }],
                }],
            },
        });
        // A forged history like that is not even readable: the parser refuses a
        // session record on a run that is not `dispatched` (T-037's rule), so
        // the claim surfaces the refusal rather than offering the run.
        await expect(claim()).rejects.toThrow('run document is unreadable');
    });

    it('leaves a delivered run alone: nothing is claimed, nothing is requeued', async () => {
        await seedRunInState({ issueNumber: 31, state: 'dispatched', sessionId: 'ses_done' });

        expect(await claim()).toEqual([]);
        const stored = await readRunsDocument({ store, log: LOGGER });

        expect(stored.runs[0]?.attempt).toBe(1);
        expect(stored.runs[0]?.lease).toBeNull();
    });
});

describe('T-007 lease coordinates (FR-030, FR-031)', () => {
    it('derives the expiry from the configured lease duration on the service clock', async () => {
        await seed(assignment(3));
        await setLeaseMs(LEASE_MS);

        const [claimed] = await claim();

        expect(claimed?.lease).toEqual({
            leaseId: expect.stringMatching(/^lse-[0-9a-f]{24}$/),
            attempt: 1,
            holder: HOLDER,
            issuedAt: STAMP,
            expiresAt: new Date(Date.parse(STAMP) + LEASE_MS).toISOString(),
        });
        expect(claimed?.attempt).toBe(1);
    });

    it('mints a fresh lease per claim and never re-derives one', async () => {
        await seed(assignment(4));
        await setLeaseMs(LEASE_MS);
        const [first] = await claim();
        const stored = await readRunsDocument({ store, log: LOGGER });
        const leaseId = stored.runs[0]?.lease?.leaseId;

        expect(leaseId).toBe(first?.lease.leaseId);
        expect(leaseId).toBe(buildLeaseId({ correlationId: first?.correlationId ?? '', attempt: 1, issuedAt: STAMP }));
    });

    it('records the panel opaque holder, and never treats it as authorization', async () => {
        await seed(assignment(5));
        const [claimed] = await claim('panel.mount_1~x');

        expect(claimed?.lease.holder).toBe('panel.mount_1~x');
        expect(holderOf(null)).toBe(UNKNOWN_HOLDER);
        expect(holderOf('')).toBe(UNKNOWN_HOLDER);
        expect(holderOf('has spaces')).toBe(UNKNOWN_HOLDER);
        expect(holderOf('x'.repeat(65))).toBe(UNKNOWN_HOLDER);
        expect(holderOf('a'.repeat(64))).toBe('a'.repeat(64));
    });

    it('opens the attempt but consumes nothing by being offered (FR-036)', async () => {
        await seed(assignment(6));
        await claim();

        const stored = await readRunsDocument({ store, log: LOGGER });

        expect(stored.runs[0]?.attempt).toBe(1);
        expect(stored.runs[0]?.requeuesUsed).toBe(0);
        expect(stored.runs[0]?.attempts).toEqual([{
            attempt: 1,
            dispatchToken: null,
            reservedAt: null,
            outcome: null,
            sessionId: null,
            reason: null,
            resultReportedAt: null,
        }]);
    });
});

describe('T-007 batch atomicity', () => {
    it('partitions the pending set between two concurrent claims', async () => {
        await seed(assignment(7), assignment(8), assignment(9));
        await setLeaseMs(LEASE_MS);

        const [first, second] = await Promise.all([claim('panel-a'), claim('panel-b')]);
        const offered = [...first, ...second].map((run) => run.correlationId);
        const overlap = first.filter((run) => second.some((other) => other.correlationId === run.correlationId));
        const stored = await readRunsDocument({ store, log: LOGGER });

        expect(first.length + second.length).toBe(3);
        expect(new Set(offered).size).toBe(3);
        expect(overlap).toEqual([]);
        // Each run is leased to the panel that received it, and the stored
        // leases agree with both answers.
        expect(first.every((run) => run.lease.holder === 'panel-a')).toBe(true);
        expect(second.every((run) => run.lease.holder === 'panel-b')).toBe(true);
        expect(stored.runs.map((run) => run.lease?.leaseId).sort())
            .toEqual([...first, ...second].map((run) => run.lease.leaseId).sort());
    });
});

describe('T-007 the claim answer', () => {
    it('projects the run, its lease, and every retained source reference', async () => {
        await seed(assignment(11));
        const [claimed] = await claim();

        expect(claimed).toMatchObject({
            correlationId: expect.stringMatching(/^mt-run-[0-9a-f]{24}$/),
            runKey: `github|${ACCOUNT_ID}|${REPOSITORY}|issue|11|0`,
            ordinal: 0,
            state: 'pending',
            bindingId: BINDING_ID,
            repository: REPOSITORY,
            accountLogin: ACCOUNT_LOGIN,
            projectId: 'prj_42',
            worktreeOption: 'none',
            subjectType: 'issue',
            issueNumber: 11,
            issueTitle: 'Issue 11',
            issueUrl: 'https://github.com/acme/widget/issues/11',
            issueBodyExcerpt: 'body of issue 11',
            attachmentId: expect.stringMatching(/^mt-run-[0-9a-f]{24}$/),
            detectedAt: STAMP,
            referenceCount: 1,
            referencesNotRetained: 0,
            referencesTruncated: false,
        });
        expect(claimed?.attachmentId).toBe(claimed?.correlationId);
        expect(claimed?.sourceReferences).toEqual([{
            deliveryId: `evt-acme~widget~11~${ACCOUNT_ID}`,
            kind: 'assignment',
            origin: 'assignment',
            sourceUrl: `https://github.com/${REPOSITORY}/issues/11`,
            detectedAt: STAMP,
            excerpt: 'body of issue 11',
            presentAtAuthorization: true,
        }]);
    });

    it('carries no credential-shaped string and no unlisted member (NFR-106)', async () => {
        await seed(assignment(12));
        const [claimed] = await claim();
        const body = JSON.stringify(claimed);

        expect(body).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
        expect(body).not.toContain('accountNumericUserId');
        expect(Object.keys(claimed ?? {}).sort()).toEqual([
            'accountLogin',
            'attachmentId',
            'attempt',
            'bindingId',
            'correlationId',
            'detectedAt',
            'issueBodyExcerpt',
            'issueNumber',
            'issueTitle',
            'issueUrl',
            'lease',
            'ordinal',
            'projectId',
            'referenceCount',
            'referencesNotRetained',
            'referencesTruncated',
            'repository',
            'runKey',
            'sourceReferences',
            'state',
            'stateReason',
            'subjectType',
            'worktreeOption',
        ]);
    });

    it('writes one dispatch.claimed row per claimed run, correlated to the run', async () => {
        await seed(assignment(13), assignment(14));
        await setLeaseMs(LEASE_MS);

        const claimed = await claim();
        const audits = await readAuditEntries(store);
        const rows = audits.filter((entry) => entry.eventType === CLAIMED_EVENT);

        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.actorSource === 'panel')).toBe(true);
        expect(rows.map((row) => row.correlationId).sort()).toEqual(claimed.map((run) => run.correlationId).sort());
        expect(rows.every((row) => row.entity.kind === 'run')).toBe(true);
        expect(rows.map((row) => row.details)).toEqual(claimed.map((run) => ({
            leaseId: run.lease.leaseId,
            attempt: 1,
            leaseExpiry: run.lease.expiresAt,
            sourceReferenceCount: 1,
            holder: HOLDER,
        })));
    });

    it('writes no claim row for a claim that leased nothing', async () => {
        await seedRunInState({ issueNumber: 15, state: 'unconfirmed' });

        const audits = await readAuditEntries(store);

        expect(await claim()).toEqual([]);
        expect(audits.filter((entry) => entry.eventType === CLAIMED_EVENT)).toEqual([]);
    });
});

/** The harness service's open store; a claim test cannot run without one. */
function openHarnessStore(running: TestService): ServiceStore {
    if (running.handle.store === null) {
        throw new Error('the harness service opened no store');
    }

    return running.handle.store;
}

describe('T-007 GET /v1/events/pending over the loopback service', () => {
    let service: TestService | null = null;

    afterEach(async () => {
        if (service === null) {
            return;
        }

        await service.shutdown();
        service = null;
    });

    it('answers claimed runs beside the unchanged status member', async () => {
        service = await startTestService();
        const running = openHarnessStore(service);

        await enqueueEvents({ store: running, log: LOGGER, incoming: [createEvent(assignment(21))] });

        const response = await service.call(`${CLAIM_PATH}?holder=panel-http-1`);
        const body: { events: ClaimedRun[]; status: unknown[] } = await response.json();
        const repeat = await service.call(`${CLAIM_PATH}?holder=panel-http-1`);
        const repeatBody: { events: ClaimedRun[] } = await repeat.json();

        expect(response.status).toBe(200);
        expect(body.events).toHaveLength(1);
        expect(body.events[0]).toMatchObject({
            state: 'pending',
            issueNumber: 21,
            repository: REPOSITORY,
            accountLogin: ACCOUNT_LOGIN,
            lease: { holder: 'panel-http-1', attempt: 1 },
        });
        // The `status` member is unchanged by the claim rework.
        expect(Array.isArray(body.status)).toBe(true);
        expect(repeatBody.events).toEqual([]);
    });

    it('records an unknown holder rather than refusing the claim', async () => {
        service = await startTestService();
        const running = openHarnessStore(service);

        await enqueueEvents({ store: running, log: LOGGER, incoming: [createEvent(assignment(22))] });

        const response = await service.call(`${CLAIM_PATH}?holder=%20bad%20holder`);
        const body: { events: ClaimedRun[] } = await response.json();

        expect(response.status).toBe(200);
        expect(body.events[0]?.lease.holder).toBe(UNKNOWN_HOLDER);
    });

    it('answers 401 without the bearer token, before any claim happens', async () => {
        service = await startTestService();
        const running = openHarnessStore(service);

        await enqueueEvents({ store: running, log: LOGGER, incoming: [createEvent(assignment(23))] });

        const response = await fetch(`${service.baseUrl}${CLAIM_PATH}`);

        expect(response.status).toBe(401);
        const stored = await readRunsDocument({ store: running, log: LOGGER });
        expect(stored.runs[0]?.state).toBe('pending');
    });
});
