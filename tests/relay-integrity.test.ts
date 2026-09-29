/**
 * Relay integrity tests (003 T-021: US1/US3, FR-028, FR-034, FR-035, FR-042).
 *
 * The relay is where "a second session for one run is impossible" stops being
 * a service-side property and becomes a construction the panel also enforces,
 * so these tests drive the real relay against a recorded double and assert the
 * *order* of what it does, not only the fact that it did something:
 *
 * 1. a successful attempt reserves, starts, **records**, reports, acknowledges,
 *    and only then reads the agent back — the record write precedes the result
 *    POST, which is FR-024's whole guarantee;
 * 2. a refused reserve never reaches `host.startSession()` (FR-028);
 * 3. a guard refusal posts `blocked` and never posts a result (FR-042);
 * 4. the handled list is keyed `correlationId#attempt`, so a failed report does
 *    not authorize a re-dispatch while a genuine new attempt does (FR-034);
 * 5. an offer this build cannot read — no lease, or a state other than the one
 *    it was offered in — dispatches nothing at all (FR-035).
 *
 * Offline only: a fake host, a storage double, and a route table. No service,
 * no network, no sleeps.
 */

import { describe, expect, it } from 'vitest';
import type {
    GuestProject,
    GuestRequest,
    GuestRequestResult,
    JsonValue,
    SessionSnapshot,
    StartSessionResult,
} from '@openchamber/sdk';
import { dispatchClaimedRun, handledKey, pollRelay } from '../src/relay.ts';
import { parsePendingBody } from '../src/claim-service.ts';
import type { ClaimedRun } from '../src/claim-service.ts';
import { DISPATCH_STORAGE_KEY } from '../src/dispatch-record.ts';
import type { PanelBinding } from '../src/repos-service.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { SpikeHost } from '../src/session.ts';
import {
    DEFAULT_STATUS,
    FIXTURE_TIMESTAMP,
    IDLE_UNSUBSCRIBE,
    LOGIN,
    PROJECT_ID,
    PROJECTS,
    SESSION_CREATED,
    SESSION_ID,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
} from './support/panel.ts';

/** Correlation id every fixture run shares. */
const CORRELATION = 'mt-run-0123456789abcdef01234567';

/** Lease id the fixture claim carries. */
const LEASE_ID = 'lse-0123456789abcdef01234567';

/** Single-use token the fixture reserve answers with. */
const TOKEN = `dtk-${'a1b2c3d4'.repeat(4)}`;

/** The run-scoped prefix every operation shares. */
const RUN_PATH = `/v1/events/${CORRELATION}`;

/** `GET /v1/events/pending`, the claim the relay ticks on. */
const PENDING_GET = 'GET /v1/events/pending';

/** `GET /v1/events`, the runs-history read that follows every report. */
const HISTORY_GET = 'GET /v1/events';

/** Agent the fixture read-back reports; matches the panel's default expectation. */
const EXPECTED_AGENT = 'project-manager';

/** One answer in the service-double route table. */
interface RouteAnswer {
    /** HTTP status the service answers with. */
    readonly status: number;
    /** Response body text, or a reader that echoes the request the route got. */
    readonly body: string | ((requestBody: string) => string);
}

/** Route table keyed by `METHOD path`. */
type RouteTable = Readonly<Record<string, RouteAnswer>>;

/**
 * Build one offered run.
 *
 * @param overrides - Fields the test changes.
 * @returns A complete, parseable offer.
 */
function claimedRun(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
    return {
        correlationId: CORRELATION,
        runKey: 'github|77331|acme/widget|issue|7|0',
        ordinal: 0,
        attempt: 1,
        lease: {
            leaseId: LEASE_ID,
            attempt: 1,
            holder: 'mount-relay',
            issuedAt: FIXTURE_TIMESTAMP,
            expiresAt: FIXTURE_TIMESTAMP,
        },
        state: 'pending',
        stateReason: 'waiting for a panel',
        bindingId: 'bnd-relay-1',
        repository: 'acme/widget',
        accountLogin: LOGIN,
        projectId: PROJECT_ID,
        worktreeOption: 'generated',
        subjectType: 'issue',
        issueNumber: 7,
        issueTitle: 'Fix the flaky test',
        issueUrl: 'https://github.com/acme/widget/issues/7',
        headSha: null,
        baseRef: null,
        attachmentId: CORRELATION,
        sourceReferences: [],
        referenceCount: 0,
        referencesNotRetained: 0,
        referencesTruncated: false,
        issueBodyExcerpt: '',
        detectedAt: FIXTURE_TIMESTAMP,
        ...overrides,
    };
}

/**
 * Serialize one claim answer.
 *
 * @param runs - The runs the service offers.
 * @param auditWritten - What FR-063's member reports.
 * @returns The body.
 */
function claimBody(runs: readonly ClaimedRun[], auditWritten = true): string {
    return JSON.stringify({ events: runs, status: [], auditWritten });
}

/** The routes a fully co-operative service answers with. */
const OK_ROUTES: RouteTable = {
    [PENDING_GET]: { status: 200, body: claimBody([claimedRun()]) },
    [HISTORY_GET]: { status: 200, body: '{"events":[]}' },
    // The reserve answer echoes whatever the panel asked to authorize, so a
    // second attempt of the same run still reads as an authorization for it.
    [`POST ${RUN_PATH}/reserve`]: {
        status: 200,
        body: (requestBody: string) => {
            const asked = JSON.parse(requestBody) as { correlationId?: unknown; attempt?: unknown };

            return JSON.stringify({
                correlationId: asked.correlationId,
                attempt: asked.attempt,
                dispatchToken: TOKEN,
                tokenExpiresAt: FIXTURE_TIMESTAMP,
                resultDeadlineAt: FIXTURE_TIMESTAMP,
                state: 'starting',
                auditWritten: true,
            });
        },
    },
    [`POST ${RUN_PATH}/dispatched`]: {
        status: 200,
        body: JSON.stringify({ correlationId: CORRELATION, attempt: 1, state: 'dispatched', auditWritten: true }),
    },
    [`POST ${RUN_PATH}/blocked`]: {
        status: 200,
        body: JSON.stringify({ correlationId: CORRELATION, attempt: 1, state: 'blocked:binding-missing' }),
    },
};

/** One enabled binding row, exactly as the service stores it. */
function activeBinding(): PanelBinding {
    return {
        bindingId: 'bnd-relay-1',
        accountNumericUserId: '77331',
        accountLogin: LOGIN,
        repository: 'acme/widget',
        projectId: PROJECT_ID,
        worktreeOption: 'generated',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
    };
}

/**
 * Whether a value written to the dispatch record already carries an
 * acknowledgement, so the timeline can tell the two writes apart.
 *
 * @param value - Value the panel stored.
 * @returns `true` once any stored attempt is acknowledged.
 */
function writesAcknowledgement(value: JsonValue): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const { attempts } = value;
    if (!Array.isArray(attempts)) {
        return false;
    }

    return attempts.some((entry) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry) && entry.acknowledged === true);
}

/** The session snapshot the read-back receives for the fixture session. */
function sessionSnapshot(): SessionSnapshot {
    return { id: SESSION_ID, title: 'Fix the flaky test', busy: false, agent: EXPECTED_AGENT };
}

/** What one mounted relay double recorded. */
interface Harness {
    /** Runtime under test, with one enabled binding already in state. */
    readonly rt: PanelRuntime;
    /** Everything the double observed, in order: `METHOD path`, `record`, `ack`, `startSession:<id>`. */
    readonly timeline: readonly string[];
    /** Body the panel sent for each `METHOD path` it called. */
    readonly sent: Readonly<Record<string, string>>;
    /** Replace the route table, modelling the service's answer changing. */
    setRoutes: (table: RouteTable) => void;
}

/**
 * Build a recorded double for one mounted relay.
 *
 * @param routes - Initial route table; defaults to the co-operative service.
 * @param options - Host overrides: the project list `resolveProject` sees.
 * @returns The runtime, the timeline, and the route-swap control.
 */
function harness(
    routes: RouteTable = OK_ROUTES,
    options: { readonly projects?: readonly GuestProject[] } = {},
): Harness {
    const timeline: string[] = [];
    const sent: Record<string, string> = {};
    let table = routes;
    const storage = createStorageDouble();

    const host: SpikeHost = fakeHost({
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            const key = `${request.method} ${request.path}`;
            timeline.push(key);
            sent[key] = request.body ?? '';

            const answer = table[key] ?? { status: DEFAULT_STATUS, body: '{"error":{"code":"not-found"}}' };

            return {
                status: answer.status,
                body: typeof answer.body === 'function' ? answer.body(sent[key] ?? '') : answer.body,
            };
        },
        startSession: async (request): Promise<StartSessionResult> => {
            // The attachment id is the run's correlation id (FR-029), so the
            // timeline records exactly what the host was asked to create.
            timeline.push(`startSession:${request.id}`);

            return SESSION_CREATED;
        },
        listProjects: async () => ({
            kind: 'projects',
            state: 'ready',
            projects: [...(options.projects ?? PROJECTS.projects)],
        }),
        onSession: (listener) => {
            listener(sessionSnapshot());

            return IDLE_UNSUBSCRIBE;
        },
        openSession: async (sessionId) => {
            timeline.push(`openSession:${sessionId}`);
        },
        storage: {
            ...storage.storage,
            set: async (key, value) => {
                if (key === DISPATCH_STORAGE_KEY) {
                    timeline.push(writesAcknowledgement(value) ? 'ack' : 'record');
                }

                await storage.storage.set(key, value);
            },
        },
    });
    const rt = createTestRuntime(host);
    rt.state.repos.bindings = [activeBinding()];

    return {
        rt,
        timeline,
        sent,
        setRoutes: (next) => {
            table = next;
        },
    };
}

/**
 * The timeline entries that make up the dispatch contract itself.
 *
 * The runs-history refresh (M8) rides along after every successful report, so
 * it is filtered out: it is a display read, not part of what the contract
 * orders, and asserting it would couple these tests to the Runs section.
 *
 * @param timeline - Everything the double observed.
 * @returns The dispatch-contract entries, in order.
 */
function dispatchTimeline(timeline: readonly string[]): string[] {
    return timeline.filter((entry) => entry !== HISTORY_GET);
}

/**
 * The body the panel sent to one path, failing loudly when it sent none.
 *
 * @param relay - The recorded double.
 * @param key - `METHOD path` the assertion is about.
 * @returns The body text.
 */
function bodyOf(relay: Harness, key: string): string {
    const body = relay.sent[key];
    if (body === undefined) {
        throw new Error(`the panel never posted ${key}`);
    }

    return body;
}

describe('relay dispatch order (FR-024, FR-028)', () => {
    it('reserves, starts, records, reports, acknowledges, then reads the agent back', async () => {
        const relay = harness();

        await dispatchClaimedRun(relay.rt, claimedRun());

        expect(dispatchTimeline(relay.timeline)).toEqual([
            `POST ${RUN_PATH}/reserve`,
            `startSession:${CORRELATION}`,
            'record',
            `POST ${RUN_PATH}/dispatched`,
            'ack',
            `openSession:${SESSION_ID}`,
        ]);
    });

    it('reports exactly one result carrying the token, the attempt, and the session', async () => {
        const relay = harness();

        await dispatchClaimedRun(relay.rt, claimedRun());

        const body = JSON.parse(bodyOf(relay, `POST ${RUN_PATH}/dispatched`)) as Record<string, unknown>;
        expect(body).toEqual({
            correlationId: CORRELATION,
            attempt: 1,
            dispatchToken: TOKEN,
            sessionId: SESSION_ID,
        });
    });

    it('never reaches the host when the service refuses the reserve', async () => {
        const relay = harness({
            ...OK_ROUTES,
            [`POST ${RUN_PATH}/reserve`]: {
                status: 409,
                body: JSON.stringify({ error: { code: 'stale-lease', message: 'lease expired' } }),
            },
        });

        await dispatchClaimedRun(relay.rt, claimedRun());

        expect(relay.timeline).toEqual([`POST ${RUN_PATH}/reserve`]);
        expect(relay.rt.state.repos.note).toContain('not authorized to start');
        expect(relay.rt.state.repos.note).toContain('stale-lease');
    });

    it('never reaches the host when the service answers an unreadable authorization', async () => {
        const relay = harness({
            ...OK_ROUTES,
            [`POST ${RUN_PATH}/reserve`]: { status: 200, body: '{"correlationId":"mt-run-ffffffffffffffffffffffff"}' },
        });

        await dispatchClaimedRun(relay.rt, claimedRun());

        expect(relay.timeline).toEqual([`POST ${RUN_PATH}/reserve`]);
        expect(relay.rt.state.repos.note).toContain('could not be read');
    });
});

describe('guard refusals are reported, never dispatched (FR-042)', () => {
    it('posts blocked with the lease and the declared reason, and no result', async () => {
        const relay = harness();
        relay.rt.state.repos.bindings = [];

        await dispatchClaimedRun(relay.rt, claimedRun());

        expect(relay.timeline).toEqual([`POST ${RUN_PATH}/blocked`]);
        const body = JSON.parse(bodyOf(relay, `POST ${RUN_PATH}/blocked`)) as Record<string, unknown>;
        expect(body).toEqual({
            correlationId: CORRELATION,
            leaseId: LEASE_ID,
            attempt: 1,
            blockedReason: 'binding-missing',
            detail: 'binding "bnd-relay-1" is no longer in this tab',
            guidance: 're-create the repository binding, then retry',
        });
        expect(relay.rt.state.repos.note).toContain('was not started');
    });

    it('reports a disabled binding rather than treating it as dispatchable', async () => {
        const relay = harness();
        relay.rt.state.repos.bindings = [{ ...activeBinding(), state: 'disabled' }];

        await dispatchClaimedRun(relay.rt, claimedRun());

        expect(relay.timeline).toEqual([`POST ${RUN_PATH}/blocked`]);
        const body = JSON.parse(bodyOf(relay, `POST ${RUN_PATH}/blocked`)) as Record<string, unknown>;
        expect(body.detail).toContain('disabled');
    });

    it('posts blocked for a project the host will not resolve', async () => {
        const relay = harness(OK_ROUTES, { projects: [] });

        await dispatchClaimedRun(relay.rt, claimedRun());

        expect(relay.timeline).toEqual([`POST ${RUN_PATH}/blocked`]);
        const body = JSON.parse(bodyOf(relay, `POST ${RUN_PATH}/blocked`)) as Record<string, unknown>;
        expect(body.blockedReason).toBe('project-missing');
        expect(String(body.detail)).toContain('not registered');
        expect(body.guidance).toContain('register the project');
    });
});

describe('the handled list is keyed correlationId#attempt (FR-034)', () => {
    it('keys one attempt and never re-dispatches it within the mount', async () => {
        const relay = harness();
        const run = claimedRun();

        expect(handledKey(run)).toBe(`${CORRELATION}#1`);
        await dispatchClaimedRun(relay.rt, run);
        await dispatchClaimedRun(relay.rt, run);

        expect(relay.timeline.filter((entry) => entry.startsWith('startSession'))).toHaveLength(1);
        expect(relay.rt.state.relay.handled).toEqual([`${CORRELATION}#1`]);
    });

    it('dispatches the same run again once the service hands it back on a new attempt', async () => {
        const relay = harness();
        await dispatchClaimedRun(relay.rt, claimedRun());

        const reissued = claimedRun({
            attempt: 2,
            lease: { ...claimedRun().lease, attempt: 2, leaseId: 'lse-89abcdef89abcdef89abcdef' },
        });
        await dispatchClaimedRun(relay.rt, reissued);

        expect(relay.timeline.filter((entry) => entry.startsWith('startSession'))).toHaveLength(2);
        expect(relay.rt.state.relay.handled).toEqual([`${CORRELATION}#1`, `${CORRELATION}#2`]);
    });

    it('does not authorize a re-dispatch when the result report fails (FR-034)', async () => {
        const relay = harness({
            ...OK_ROUTES,
            [`POST ${RUN_PATH}/dispatched`]: {
                status: 503,
                body: JSON.stringify({ error: { code: 'storage-unavailable', message: 'store down' } }),
            },
        });

        await dispatchClaimedRun(relay.rt, claimedRun());
        await dispatchClaimedRun(relay.rt, claimedRun());

        expect(relay.timeline.filter((entry) => entry.startsWith('startSession'))).toHaveLength(1);
        expect(relay.rt.state.repos.note).toContain('report was refused');
        expect(relay.rt.state.repos.note).toContain('reconciled on the next mount');
    });
});

describe('the relay dispatches only what it was offered, leased (FR-035)', () => {
    it('dispatches nothing and says so when the offer carries no lease', async () => {
        const offer = JSON.parse(JSON.stringify(claimedRun())) as Record<string, unknown>;
        delete offer.lease;
        const relay = harness({
            [PENDING_GET]: {
                status: 200,
                body: JSON.stringify({ events: [offer], status: [], auditWritten: true }),
            },
        });

        await pollRelay(relay.rt);

        expect(relay.timeline.filter((entry) => entry.startsWith('startSession'))).toHaveLength(0);
        expect(relay.timeline.filter((entry) => entry === `POST ${RUN_PATH}/reserve`)).toHaveLength(0);
        expect(relay.rt.state.repos.note).toContain('could not read');
    });

    it('dispatches nothing when an offered run is not in the state it was offered in', async () => {
        const offer = JSON.parse(JSON.stringify(claimedRun())) as Record<string, unknown>;
        offer.state = 'claimed';
        const relay = harness({
            [PENDING_GET]: {
                status: 200,
                body: JSON.stringify({ events: [offer], status: [], auditWritten: true }),
            },
        });

        await pollRelay(relay.rt);

        expect(relay.timeline).toEqual([PENDING_GET]);
        expect(relay.rt.state.repos.note).toContain('could not read');
    });

    it('dispatches an empty offer without touching the host', async () => {
        const relay = harness({ [PENDING_GET]: { status: 200, body: claimBody([]) } });

        await pollRelay(relay.rt);

        expect(relay.timeline).toEqual([PENDING_GET]);
        expect(relay.rt.state.relay.lastPollAt).not.toBeNull();
    });

    it('surfaces a degraded claim trail instead of implying one exists (FR-063)', async () => {
        const relay = harness({
            ...OK_ROUTES,
            [PENDING_GET]: { status: 200, body: claimBody([claimedRun()], false) },
        });

        await pollRelay(relay.rt);

        expect(relay.rt.state.repos.note).toContain('could not record every claim row');
        expect(relay.timeline.filter((entry) => entry.startsWith('startSession'))).toHaveLength(1);
    });

    it('reads a well-formed offer end to end through the parser', () => {
        const parsed = parsePendingBody(claimBody([claimedRun()]));

        expect(parsed?.runs).toHaveLength(1);
        expect(parsed?.runs[0]?.lease.leaseId).toBe(LEASE_ID);
        expect(parsed?.auditWritten).toBe(true);
    });
});
