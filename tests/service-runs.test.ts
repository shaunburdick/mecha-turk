/**
 * The runs-history route: `GET /v1/events`, plus the wire delta its retry
 * sibling went through in 003.
 *
 * The read side is what M8's runs list will render, so it is asserted from
 * the outside — the real loopback service answering the real request — on
 * the things that could silently betray that UI: the projection (contract §1's
 * members plus the shipped row's own, no account identity, and never a
 * credential even though one is registered in the same store) and the
 * ordering (newest detected first) with its cap.
 *
 * 003 also changed the retry operation from delivery-scoped to run-scoped
 * (`contracts/dispatch-authorization.md`), which this file records from the
 * delivery side: a delivery id is no longer addressable at all. The run-scoped
 * behaviour itself is covered by `tests/service-run-operations.test.ts`.
 *
 * The planted queue rows are the writer's own detection bytes plus the four
 * lifecycle stamps the shipped build wrote (`createEvent`), so the service
 * reads exactly what an upgraded store already holds — and the history answers
 * with the **runs** those rows adopt into (T-016, FR-005), which is why every
 * fixture that expects rows on disk plants them before the service starts.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENTS_FILE, createEvent, enqueueEvents } from '../service/poll/events.ts';
import { readRunsDocument } from '../service/poll/runs.ts';
import { createPollingView } from '../service/poll/view.ts';
import { RETRY_PATH } from '../service/routes/run-ops.ts';
import { EVENTS_PATH, EVENTS_PENDING_PATH, eventHistoryRoute } from '../service/routes/events.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import { createLogger } from '../service/log.ts';
import { createVerifyThrottle } from '../service/throttle.ts';
import type { EventSnapshot, QueuedEvent } from '../service/poll/events.ts';
import type { Run } from '../service/poll/runs-types.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import type { RouteContext } from '../service/routes/types.ts';
import { fakeGitHub, offlineVerifier, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Credential registered with this suite; never appears in any answer. */
const REGISTERED_TOKEN = `runs-history-credential-${'q'.repeat(32)}`;

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = '77331';

/** Login the fixture token belongs to; the projection must not carry it. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Stamp the fixture bindings and events carry. */
const STAMP = '2026-09-27T00:00:00.000Z';

/** A data directory the fixture never opens; its context carries no store. */
const UNUSABLE_DATA_DIR = '/nonexistent/mecha-turk-history';

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Fields the projection may answer with, in row order (before the optional pair). */
const PROJECTED_FIELDS = [
    'id',
    'state',
    'stateReason',
    'runKey',
    'ordinal',
    'attempt',
    'correlationId',
    'attachmentId',
    'projectId',
    'worktreeOption',
    'leaseExpiresAt',
    'resultDeadlineAt',
    'sourceReferences',
    'referenceCount',
    'referencesTruncated',
    'referencesNotRetained',
    'session',
    'verification',
    'kind',
    'repository',
    'issueNumber',
    'issueTitle',
    'issueUrl',
    'detectedAt',
    'bindingId',
    'dispatchResult',
    'claimedAt',
    'dispatchedAt',
    'promptPresent',
    'promptFingerprint',
    'promptLength',
    'promptSources',
    // The **shape** of the binding's allow-list at authorization, never a login
    // (003 FR-079, NFR-113). Present on every row, including `null` for a run no
    // gate has judged yet, so a reader never has to default it.
    'actorPolicy',
] as const;

/** Build a header map without writing HTTP header names as object keys. */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the routes that take a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

/** Data directories this suite planted outside the harness's own temp home. */
const plantedRoots: string[] = [];

/** Log lines the direct store calls in this suite keep out of the test output. */
const SEED_LOG_LINES: string[] = [];

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    SEED_LOG_LINES.length = 0;

    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }

    while (plantedRoots.length > 0) {
        const root = plantedRoots.pop();
        if (root !== undefined) {
            await rm(root, { recursive: true, force: true });
        }
    }
});

/**
 * Start the service and register the fixture account, so a real credential
 * sits in the same store the projection reads.
 *
 * @returns The running harness instance.
 */
async function startWithAccount(): Promise<TestService> {
    const github = fakeGitHub({
        user: {
            body: userBody({ id: Number(ACCOUNT_ID), login: ACCOUNT_LOGIN }),
            headers: headerMap([['x-oauth-sopes', 'repo, user']]),
        },
    });
    const service = await startTestService({ github: github.verifier });
    running.push(service);
    await service.handle.reconciled;

    const registered = await service.call(VERIFY_PATH, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ token: REGISTERED_TOKEN }),
    });
    expect(registered.status).toBe(201);

    return service;
}

/**
 * Start the service with no account registered (the projection needs none).
 *
 * @returns The running harness instance.
 */
async function startEmpty(): Promise<TestService> {
    const service = await startTestService();
    running.push(service);
    await service.handle.reconciled;

    return service;
}

/**
 * Build the snapshot one fixture event is assembled from.
 *
 * @returns A complete event snapshot.
 */
function snapshotOf(input: {
    readonly issueNumber: number;
    readonly detectedAt: string;
    readonly kind: EventSnapshot['kind'];
}): EventSnapshot {
    const base = {
        bindingId: 'bnd-runs',
        repository: 'acme/widget',
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: 'prj_42',
        worktreeOption: 'none',
        issue: {
            issueNumber: input.issueNumber,
            issueTitle: `Ticket #${input.issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${input.issueNumber}`,
            issueBodyExcerpt: '',
        },
        actorLogin: 'alice',
        triggerNote: `${input.kind} fixture`,
        detectedAt: input.detectedAt,
    };
    // The basis is per trigger kind, not per fixture: a comment mention names
    // its own author directly, while an assignment and a review request are
    // attributed to the subject's author as a documented proxy (002 FR-044).
    if (input.kind === 'review') {
        return {
            ...base,
            kind: 'review',
            actorAttribution: 'subject-author',
            headSha: 'deadbeefcafe000000000000000000000000beef',
            baseRef: 'main',
        };
    }

    if (input.kind === 'mention') {
        return { ...base, kind: 'mention', actorAttribution: 'direct', origin: 'comment', commentId: 4_242 };
    }

    return { ...base, kind: 'assignment', actorAttribution: 'subject-author' };
}

/**
 * Build one fixture event in the **shipped** vocabulary.
 *
 * The planted rows stand for what an upgraded store already holds: the
 * writer's own detection bytes plus the four lifecycle stamps the shipped
 * build wrote and 003 stops writing. The runs history still projects those
 * rows and the legacy claim still answers them (FR-005), so the suite seeds
 * the shape those paths were written against.
 *
 * @returns The queued event.
 */
function fixtureEvent(input: {
    readonly issueNumber: number;
    readonly detectedAt: string;
    readonly kind: EventSnapshot['kind'];
}): QueuedEvent {
    return {
        ...createEvent(snapshotOf(input)),
        state: 'pending',
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
    };
}

/**
 * Build a strictly increasing detection stamp for one cap-fixture event.
 *
 * @returns An RFC 3339 stamp, one minute apart from its neighbours.
 */
function detectionStamp(issueNumber: number): string {
    const hour = String(Math.floor(issueNumber / 60)).padStart(2, '0');
    const minute = String(issueNumber % 60).padStart(2, '0');

    return `2026-09-27T${hour}:${minute}:00.000Z`;
}

/**
 * Write the queue document straight into the service's data directory.
 *
 * @param service - Harness instance owning the data directory.
 */
async function plantQueue(service: TestService, rows: readonly QueuedEvent[]): Promise<void> {
    await writeFile(join(service.dataDir, EVENTS_FILE), JSON.stringify(rows), 'utf8');
}

/**
 * Read the planted queue back after a route has run.
 *
 * @param service - Harness instance owning the data directory.
 * @returns Every stored row, as parsed JSON.
 */
async function storedQueue(service: TestService): Promise<readonly Record<string, unknown>[]> {
    const text = await readFile(join(service.dataDir, EVENTS_FILE), 'utf8');

    return JSON.parse(text) as readonly Record<string, unknown>[];
}

/**
 * Start the service against a data directory whose queue was planted **first**.
 *
 * Adoption is one-shot per store handle and runs on the first read of the run
 * document — the boot sweep performs that read before the listener binds — so a
 * legacy row can only be adopted when it is already on disk when the service
 * starts. That is also the real upgrade shape: the operator's existing queue is
 * there when the new build first runs (FR-005, AC-126).
 *
 * @returns The running harness instance, registered for cleanup with its root.
 */
async function startWithQueue(rows: readonly QueuedEvent[]): Promise<TestService> {
    const root = await mkdtemp(join(tmpdir(), 'mecha-turk-history-'));
    plantedRoots.push(root);
    const dataDir = join(root, 'store');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, EVENTS_FILE), JSON.stringify(rows), 'utf8');
    const service = await startTestService({ dataDir });
    running.push(service);
    await service.handle.reconciled;

    return service;
}

/**
 * The harness's open store, which the seeding helpers need non-null.
 *
 * @returns The handle every direct store call in this suite uses.
 */
function storeOf(service: TestService): ServiceStore {
    if (service.handle.store === null) {
        throw new Error('the harness store is unavailable');
    }

    return service.handle.store;
}

/**
 * The harness's own logger, for the direct store calls seeding a run.
 *
 * @returns A logger that keeps its lines out of the test output.
 */
function suiteLogger(): ServiceLogger {
    return createLogger({ level: 'error', sink: (line) => void SEED_LOG_LINES.push(line) });
}

/**
 * The runs as the service's own document holds them, for read-side assertions.
 *
 * @returns Every retained run, in creation order.
 * @throws {StorageUnavailableError} When the run document cannot be read.
 */
async function readStoredRuns(service: TestService): Promise<readonly Run[]> {
    const document = await readRunsDocument({ store: storeOf(service), log: suiteLogger() });

    return document.runs;
}

/** One `GET /v1/events` answer, with the 005 paging member beside the rows. */
interface HistoryAnswer {
    /** The page's rows, newest detected first. */
    readonly events: Record<string, unknown>[];
    /** The paging member the route now answers with (005 FR-042). */
    readonly page: {
        /** Effective page size. */
        readonly limit: number;
        /** Boundary token for the next page, or `null` at the end. */
        readonly nextCursor: string | null;
        /** Whether a further page exists. */
        readonly hasMore: boolean;
        /** Size of the filtered set. */
        readonly total: number | null;
        /** Stamp this read carries. */
        readonly snapshotAt: string;
        /** Echo of the applied filters. */
        readonly filter: { readonly bindingId: string | null; readonly state: string | null };
    };
}

describe('GET /v1/events (runs history)', () => {
    it('projects every run newest-detected-first, field set exactly as documented', async () => {
        {
            const service = await startWithQueue([
                fixtureEvent({ issueNumber: 1, detectedAt: '2026-09-27T00:01:00.000Z', kind: 'assignment' }),
                fixtureEvent({ issueNumber: 3, detectedAt: '2026-09-27T00:03:00.000Z', kind: 'review' }),
                fixtureEvent({ issueNumber: 2, detectedAt: '2026-09-27T00:02:00.000Z', kind: 'mention' }),
            ]);

            const response = await service.call(EVENTS_PATH);
            expect(response.status).toBe(200);

            const body = (await response.json()) as { events: Record<string, unknown>[] };
            expect(body.events.map((row) => row.issueNumber)).toEqual([3, 2, 1]);
            expect(body.events.map((row) => row.kind)).toEqual(['review', 'mention', 'assignment']);
            // The projection carries the contract's members and the shipped row's
            // own, in one documented order: the review row adds the optional PR
            // coordinates, the other two do not (contract §1).
            expect(body.events.map((row) => Object.keys(row))).toEqual([
                [...PROJECTED_FIELDS, 'headSha', 'baseRef'],
                [...PROJECTED_FIELDS],
                [...PROJECTED_FIELDS],
            ]);
            expect(body.events[0]?.headSha).toBe('deadbeefcafe000000000000000000000000beef');
            expect(body.events[0]?.baseRef).toBe('main');
            // The row *is* the run: one service-minted id is the row key, the
            // correlation id, and the attachment id (FR-029, FR-050), and a
            // freshly adopted legacy row is waiting under attempt 1 (FR-005).
            expect(body.events.every((row) => row.state === 'pending')).toBe(true);
            expect(body.events.every((row) => row.id === row.correlationId && row.id === row.attachmentId)).toBe(true);
            expect(body.events.every((row) => row.attempt === 1)).toBe(true);
            expect(String(body.events[0]?.runKey)).toContain('acme/widget');
            // The read claims nothing: the runs it projected are still waiting.
            const stored = await readStoredRuns(service);
            expect(stored.every((run) => run.state === 'pending')).toBe(true);
            expect(stored.every((run) => run.lease === null)).toBe(true);
        }
    });

    it('pages the history: 25 by default, 100 at most, and the oldest still reachable', async () => {
        {
            const rows: QueuedEvent[] = [];
            for (let issueNumber = 1; issueNumber <= 105; issueNumber += 1) {
                rows.push(fixtureEvent({ issueNumber, detectedAt: detectionStamp(issueNumber), kind: 'assignment' }));
            }

            const service = await startWithQueue(rows);

            const first = await service.call(EVENTS_PATH);
            expect(first.status).toBe(200);
            const pageOne = (await first.json()) as HistoryAnswer;
            // The default page is 25, and the total is the set — never the page.
            expect(pageOne.events).toHaveLength(25);
            expect(pageOne.page.limit).toBe(25);
            expect(pageOne.page.total).toBe(105);
            expect(pageOne.page.hasMore).toBe(true);
            expect(pageOne.page.nextCursor).not.toBeNull();
            expect(pageOne.page.filter).toEqual({ bindingId: null, state: null });
            expect(pageOne.page.snapshotAt).not.toBe('');
            expect(pageOne.events[0]?.issueNumber).toBe(105);

            // The shipped 100-row cap is the maximum page size, not a wall.
            const capped = await service.call(`${EVENTS_PATH}?limit=100`);
            const capAnswer = (await capped.json()) as HistoryAnswer;
            expect(capAnswer.events).toHaveLength(100);
            expect(capAnswer.page.limit).toBe(100);
            expect(capAnswer.page.total).toBe(105);
            expect(capAnswer.events[0]?.issueNumber).toBe(105);
            expect(capAnswer.events.at(-1)?.issueNumber).toBe(6);

            // …so the 101st row is reachable through the boundary token.
            const cursor = capAnswer.page.nextCursor;
            expect(cursor).not.toBeNull();
            const tail = await service.call(`${EVENTS_PATH}?limit=100&cursor=${encodeURIComponent(cursor ?? '')}`);
            const tailAnswer = (await tail.json()) as HistoryAnswer;
            expect(tailAnswer.events).toHaveLength(5);
            expect(tailAnswer.events[0]?.issueNumber).toBe(5);
            expect(tailAnswer.events.at(-1)?.issueNumber).toBe(1);
            expect(tailAnswer.page.hasMore).toBe(false);
            expect(tailAnswer.page.nextCursor).toBeNull();
            expect(tailAnswer.page.total).toBe(105);

            // No duplicate and no gap across the boundary (AC-121).
            const seen = new Set([
                ...capAnswer.events.map((row) => String(row.correlationId)),
                ...tailAnswer.events.map((row) => String(row.correlationId)),
            ]);
            expect(seen.size).toBe(105);
        }
    });

    it('keeps the claim route reachable beside the new literal route', async () => {
        {
            // A legacy row has to be in the store *before* the service adopts it,
            // because adoption is one-shot per store handle by design (FR-005), so
            // the fixture seeds a data directory and starts the service on it.
            const service = await startWithQueue([
                fixtureEvent({ issueNumber: 8, detectedAt: STAMP, kind: 'assignment' }),
            ]);

            // `/v1/events` and `/v1/events/pending` are both literal routes; the
            // runs history must not have shadowed the relay's claim. The answer is
            // the adopted run, offered under a lease (T-007).
            const response = await service.call(EVENTS_PENDING_PATH);

            expect(response.status).toBe(200);
            const body = (await response.json()) as { events: Record<string, unknown>[] };
            expect(body.events).toHaveLength(1);
            expect(body.events[0]?.state).toBe('pending');
            expect(body.events[0]?.issueNumber).toBe(8);
            expect(body.events[0]?.lease).toMatchObject({ holder: 'unknown' });
        }
    });

    it('keeps the registered credential and the account login out of the answer', async () => {
        {
            const service = await startWithAccount();
            // A run of this suite's own making, so the answer is non-empty and the
            // scan below reads a real projection rather than an empty list.
            const appended = await enqueueEvents({
                store: storeOf(service),
                log: suiteLogger(),
                incoming: [createEvent(snapshotOf({
                    issueNumber: 7,
                    detectedAt: '2026-09-27T00:07:00.000Z',
                    kind: 'mention',
                }))],
            });
            expect(appended).toHaveLength(1);

            const response = await service.call(EVENTS_PATH);
            expect(response.status).toBe(200);

            const text = await response.text();
            const body = JSON.parse(text) as { events: Record<string, unknown>[] };
            expect(body.events).toHaveLength(1);
            expect(text).not.toContain(REGISTERED_TOKEN);
            expect(text).not.toContain(ACCOUNT_LOGIN);
            // A dispatch token is an authorization, not history: the row says a
            // reservation exists and when it dies, never what it is (NFR-106).
            expect(text).not.toMatch(/dtk-[0-9a-f]{8,}/);
        }
    });

});

describe('POST /v1/events/:correlationId/retry (wire delta from 003)', () => {
    it('is addressed by the run, not the delivery, and refuses a delivery id', async () => {
        // 003's wire delta replaced the delivery-scoped retry outright: a
        // post-003 delivery carries no lifecycle state of its own, so there was
        // nothing at the delivery layer for a retry to reset. The path segment is
        // now the run's correlation id, and a delivery id is not one.
        const service = await startEmpty();
        await plantQueue(service, [fixtureEvent({ issueNumber: 4, detectedAt: STAMP, kind: 'assignment' })]);

        const response = await service.call(
            RETRY_PATH.replace(':correlationId', 'evt-acme~widget~4~77331'),
            { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ attempt: 1 }) },
        );
        const body = (await response.json()) as { error: { code: string } };

        expect(response.status).toBe(404);
        expect(body.error.code).toBe('unknown-run');
        // The delivery row is byte-identical: a refusal moves nothing.
        expect(await storedQueue(service)).toEqual([{ ...fixtureEvent({
            issueNumber: 4,
            detectedAt: STAMP,
            kind: 'assignment',
        }) }]);
    });
});

/**
 * A route context whose data directory is unusable — the `store: null` the
 * harness only produces when the directory cannot be opened at all.
 *
 * @returns A context with every member the route table shares, and no store.
 */
function noStoreContext(): RouteContext {
    return {
        store: null,
        dataDir: UNUSABLE_DATA_DIR,
        startedAt: 0,
        log: suiteLogger(),
        schemaVersion: 1,
        github: offlineVerifier(),
        throttle: createVerifyThrottle(),
        polling: createPollingView().view,
    };
}

/**
 * The code out of a response body's documented error envelope.
 *
 * @param body - The response body, read as an untrusted record.
 * @returns The code, or an empty string when the envelope carries none.
 */
function errorCodeOf(body: unknown): string {
    if (typeof body !== 'object' || body === null) {
        return '';
    }

    const { error } = body as { error?: unknown };
    if (typeof error !== 'object' || error === null) {
        return '';
    }

    const { code } = error as { code?: unknown };

    return typeof code === 'string' ? code : '';
}

describe('GET /v1/events refusal surface (contract §1)', () => {
    it('answers 503 storage-unavailable, and claims nothing while refusing', async () => {
        // §1's Refusals row is one line: `503 storage-unavailable` only — a read
        // claims nothing and can refuse nothing else. The guard that produces it
        // is this route's own; the pipeline's mapping of a thrown
        // `StorageUnavailableError` onto the same code is asserted for every
        // run-scoped operation in `tests/service-run-routes.test.ts`.
        const response = await eventHistoryRoute.handler(noStoreContext(), {
            method: 'GET',
            url: new URL(`http://127.0.0.1${EVENTS_PATH}`),
            body: undefined,
            params: {},
        });

        expect(response.status).toBe(503);
        expect(errorCodeOf(response.body)).toBe('storage-unavailable');
    });
});
