/**
 * The runs-history routes (Slice 2): `GET /v1/events` and
 * `POST /v1/events/:id/retry`.
 *
 * The read side is what M8's runs list will render, so it is asserted from
 * the outside — the real loopback service answering the real request — on
 * the three things that could silently betray that UI: the projection (only
 * the documented fields, no account identity beyond the id, and never a
 * credential even though one is registered in the same store), the ordering
 * (newest detected first) and its cap, and the retry state machine
 * (`pending`/`in-flight` answer `200` and end up pending again;
 * `dispatched` is terminal and answers `409`).
 *
 * The planted queue rows are the writer's own detection bytes plus the four
 * lifecycle stamps the shipped build wrote (`createEvent`), so the service
 * reads exactly what an upgraded store already holds.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../src/consent.ts';
import { EVENTS_FILE, createEvent } from '../service/poll/events.ts';
import { EVENTS_PATH, EVENTS_PENDING_PATH, EVENT_RETRY_PATH } from '../service/routes/events.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import type { EventSnapshot, QueuedEvent } from '../service/poll/events.ts';
import { fakeGitHub, userBody } from './support/github.ts';
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

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Fields the projection may answer with, in row order (before the optional pair). */
const PROJECTED_FIELDS = [
    'id',
    'kind',
    'repository',
    'issueNumber',
    'issueTitle',
    'issueUrl',
    'state',
    'detectedAt',
    'claimedAt',
    'dispatchedAt',
    'dispatchResult',
    'bindingId',
] as const;

/** Build a header map without writing HTTP header names as object keys. */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the routes that take a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

afterEach(async () => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
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
        body: JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: CONSENT_VERSION }),
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
 * @param input - Issue number, detection stamp, and trigger kind.
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
        triggerNote: `${input.kind} fixture`,
        detectedAt: input.detectedAt,
    };
    if (input.kind === 'review') {
        return {
            ...base,
            kind: 'review',
            headSha: 'deadbeefcafe000000000000000000000000beef',
            baseRef: 'main',
        };
    }

    if (input.kind === 'mention') {
        return { ...base, kind: 'mention', origin: 'comment', commentId: 4242 };
    }

    return { ...base, kind: 'assignment' };
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
 * @param input - Issue number, detection stamp, and trigger kind.
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
 * Stamp one fixture event into another queue state.
 *
 * @param event - The event to move.
 * @param patch - The state fields to overwrite.
 * @returns The event as it should be planted.
 */
function inState(event: QueuedEvent, patch: Partial<QueuedEvent>): QueuedEvent {
    return { ...event, ...patch };
}

/**
 * Build a strictly increasing detection stamp for one cap-fixture event.
 *
 * @param issueNumber - Issue number, which the stamp orders by.
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
 * @param rows - Rows to plant as the `events.json` array.
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
 * Post one retry request for an event id.
 *
 * @param service - Harness instance.
 * @param eventId - Id on the retry path.
 * @returns The response.
 */
async function postRetry(service: TestService, eventId: string): Promise<Response> {
    return await service.call(EVENT_RETRY_PATH.replace(':eventId', eventId), { method: 'POST' });
}

describe('GET /v1/events (runs history)', () => {
    it('projects every event newest-detected-first, field set exactly as documented', async () => {
        const service = await startEmpty();
        await plantQueue(service, [
            fixtureEvent({ issueNumber: 1, detectedAt: '2026-09-27T00:01:00.000Z', kind: 'assignment' }),
            fixtureEvent({ issueNumber: 3, detectedAt: '2026-09-27T00:03:00.000Z', kind: 'review' }),
            fixtureEvent({ issueNumber: 2, detectedAt: '2026-09-27T00:02:00.000Z', kind: 'mention' }),
        ]);

        const response = await service.call(EVENTS_PATH);
        expect(response.status).toBe(200);

        const body = (await response.json()) as { events: Record<string, unknown>[] };
        expect(body.events.map((row) => row.issueNumber)).toEqual([3, 2, 1]);
        expect(body.events.map((row) => row.kind)).toEqual(['review', 'mention', 'assignment']);
        // The projection carries the documented fields and nothing else: the
        // review row adds the optional PR coordinates, the other two do not.
        expect(body.events.map((row) => Object.keys(row))).toEqual([
            [...PROJECTED_FIELDS, 'headSha', 'baseRef'],
            [...PROJECTED_FIELDS],
            [...PROJECTED_FIELDS],
        ]);
        expect(body.events[0]?.headSha).toBe('deadbeefcafe000000000000000000000000beef');
        expect(body.events[0]?.baseRef).toBe('main');
        // The claim never runs on this route: every row stays as it was.
        expect(body.events.every((row) => row.state === 'pending')).toBe(true);
    });

    it('caps the history at 100 rows, dropping the oldest detections', async () => {
        const service = await startEmpty();
        const rows: QueuedEvent[] = [];
        for (let issueNumber = 1; issueNumber <= 105; issueNumber += 1) {
            rows.push(fixtureEvent({ issueNumber, detectedAt: detectionStamp(issueNumber), kind: 'assignment' }));
        }

        await plantQueue(service, rows);

        const response = await service.call(EVENTS_PATH);
        expect(response.status).toBe(200);

        const body = (await response.json()) as { events: Record<string, unknown>[] };
        expect(body.events).toHaveLength(100);
        expect(body.events[0]?.issueNumber).toBe(105);
        expect(body.events.at(-1)?.issueNumber).toBe(6);
    });

    it('keeps the claim route reachable beside the new literal route', async () => {
        // A legacy row has to be in the store *before* the service adopts it,
        // because adoption is one-shot per store handle by design (FR-005), so
        // the fixture seeds a data directory and starts the service on it.
        const dataDir = join(await mkdtemp(join(tmpdir(), 'mecha-turk-claim-route-')), 'store');
        await mkdir(dataDir, { recursive: true });
        await writeFile(
            join(dataDir, EVENTS_FILE),
            JSON.stringify([fixtureEvent({ issueNumber: 8, detectedAt: STAMP, kind: 'assignment' })]),
            'utf8',
        );
        const service = await startTestService({ dataDir });
        running.push(service);

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
    });

    it('keeps the registered credential and the account login out of the answer', async () => {
        const service = await startWithAccount();
        await plantQueue(service, [
            fixtureEvent({ issueNumber: 7, detectedAt: '2026-09-27T00:07:00.000Z', kind: 'mention' }),
        ]);

        const response = await service.call(EVENTS_PATH);
        expect(response.status).toBe(200);

        const text = await response.text();
        expect(text).not.toContain(REGISTERED_TOKEN);
        expect(text).not.toContain(ACCOUNT_LOGIN);
    });
});

describe('POST /v1/events/:id/retry', () => {
    it('returns an in-flight event to pending and clears its claim stamp', async () => {
        const service = await startEmpty();
        const claimed = inState(fixtureEvent({ issueNumber: 4, detectedAt: STAMP, kind: 'assignment' }), {
            state: 'in-flight',
            claimedAt: STAMP,
        });
        await plantQueue(service, [claimed]);

        const response = await postRetry(service, claimed.id);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ retried: true });

        const stored = await storedQueue(service);
        expect(stored[0]?.state).toBe('pending');
        expect(stored[0]?.claimedAt).toBeNull();
        expect(stored[0]?.dispatchedAt).toBeNull();
    });

    it('answers 200 for an event already pending, changing nothing', async () => {
        const service = await startEmpty();
        const pending = fixtureEvent({ issueNumber: 5, detectedAt: STAMP, kind: 'assignment' });
        await plantQueue(service, [pending]);

        const response = await postRetry(service, pending.id);

        expect(response.status).toBe(200);
        expect(await storedQueue(service)).toEqual([pending as unknown as Record<string, unknown>]);
    });

    it('refuses a dispatched event with 409 invalid-transition', async () => {
        const service = await startEmpty();
        const dispatched = inState(fixtureEvent({ issueNumber: 6, detectedAt: STAMP, kind: 'assignment' }), {
            state: 'dispatched',
            dispatchedAt: STAMP,
            dispatchResult: 'ses_fixture',
        });
        await plantQueue(service, [dispatched]);

        const response = await postRetry(service, dispatched.id);

        expect(response.status).toBe(409);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe('invalid-transition');

        // The terminal row is untouched: the retry did not reopen it.
        const stored = await storedQueue(service);
        expect(stored[0]?.state).toBe('dispatched');
        expect(stored[0]?.dispatchResult).toBe('ses_fixture');
    });

    it('answers 404 for an id the queue never held', async () => {
        const service = await startEmpty();
        await plantQueue(service, []);

        const response = await postRetry(service, 'evt-acme~widget~9~77331');

        expect(response.status).toBe(404);
        const body = (await response.json()) as { error: { code: string } };
        expect(body.error.code).toBe('not-found');
    });
});
