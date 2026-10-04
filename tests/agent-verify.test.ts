/**
 * Agent-verification tests (M9) — warn, never block.
 *
 * The read-back is the product's core PM-leads requirement and the one part
 * of the loop nobody had exercised live: the panel subscribes to
 * `onSession`, opens the dispatched session through `openSession`, and
 * judges the `agent` the snapshot reports against the baseline it reads from
 * `GET /v1/config` (002 FR-029 — the card carries no settings since 002
 * FR-041). These tests drive that flow through a host double that records
 * the order of the two calls (the subscription must land first — the host
 * replays its current snapshot to a late subscriber, so subscribing second
 * would be a race), then covers the five outcomes: match, mismatch, absent
 * agent, timeout, and the *uncompared* read-back a blank baseline produces,
 * plus the "the session could not be opened at all" branch, plus the
 * three-way baseline provenance (configured vs defaulted vs unset). The
 * recorder and the relay wiring are asserted end to end so the
 * warning a live dispatch shows cannot silently go missing.
 */

import { describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@openchamber/sdk';
import { DEFAULT_CONFIG } from '../service/config.ts';
import {
    AGENT_VERIFY_TIMEOUT_MS,
    drainVerifications,
    verifyAgentAfterDispatch,
    verifySessionAgent,
} from '../src/agent-verify.ts';
import { verificationNotice } from '../src/agent-verify-copy.ts';
import { dispatchClaimedRun } from '../src/relay.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { PanelHost } from '../src/session.ts';
import type { ClaimedRun } from '../src/claim-service.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import {
    FIXTURE_TIMESTAMP,
    IDLE_UNSUBSCRIBE,
    ISSUE_URL,
    LOGIN,
    PROJECT_ID,
    SESSION_CREATED,
    SESSION_ID,
    createTestRuntime,
    fakeHost,
} from './support/panel.ts';

/** Session id the fixture dispatch created. */
const SESSION = SESSION_ID;

/** Agent the fixture baseline expects (the documented 002 FR-029 default). */
const EXPECTED_AGENT = 'project-manager';

/** Deliberately tiny wait budget so the timeout path stays fast in tests. */
const TEST_TIMEOUT_MS = 20;

/** The configuration route every baseline read goes through. */
const CONFIG_ROUTE = '/v1/config';

/**
 * Build a session snapshot for the fixture session.
 *
 * @param agent - Agent the snapshot reports; omit to model a session that
 *   reports none at all (the SDK's "when the session has them" wording).
 * @returns The snapshot for {@link verifySessionAgent}.
 */
function snapshot(agent?: string): SessionSnapshot {
    return {
        id: SESSION,
        title: 'Fix the flaky test',
        busy: false,
        ...(agent === undefined ? {} : { agent }),
    };
}

/** Host double for the read-back: records call order and replays on demand. */
interface VerifyHostDouble {
    /** The host surface the verification under test receives. */
    readonly host: Pick<PanelHost, 'onSession' | 'openSession'>;
    /** Calls observed, in order, as `onSession` / `openSession:<id>`. */
    readonly calls: readonly string[];
    /** How often the panel released its subscription. */
    readonly unsubscribes: () => number;
}

/**
 * Build the verification host double.
 *
 * @param input - The snapshot to deliver when the surface opens (or nothing)
 *   and an optional error `openSession` should fail with.
 * @returns The double.
 */
function verifyHost(input: {
    /** Snapshot delivered when the session opens; `null`/omitted sends none. */
    readonly onOpen?: SessionSnapshot | null;
    /** Error `openSession` should reject with. */
    readonly openError?: Error;
    /** Model a host whose `openSession` answers only long after the budget. */
    readonly hangOpen?: boolean;
} = {}): VerifyHostDouble {
    const calls: string[] = [];
    let listener: ((value: SessionSnapshot | null) => void) | null = null;

    return {
        calls,
        unsubscribes: () => calls.filter((call) => call === 'unsubscribe').length,
        host: {
            onSession: (next) => {
                calls.push('onSession');
                listener = next;

                return () => {
                    calls.push('unsubscribe');
                };
            },
            openSession: async (id) => {
                calls.push(`openSession:${id}`);
                if (input.openError !== undefined) {
                    throw input.openError;
                }

                if (input.hangOpen === true) {
                    await new Promise((resolve) => {
                        setTimeout(resolve, TEST_TIMEOUT_MS * 5);
                    });
                }

                if (input.onOpen !== undefined && input.onOpen !== null && listener !== null) {
                    listener(input.onOpen);
                }
            },
        },
    };
}

describe('verifySessionAgent (documented read-back, research §R3)', () => {
    it('subscribes before it opens the session, then releases the subscription', async () => {
        {
            const double = verifyHost({ onOpen: snapshot(EXPECTED_AGENT) });

            const result = await verifySessionAgent({
                host: double.host,
                sessionId: SESSION,
                expected: EXPECTED_AGENT,
            });

            // The subscription must be registered first: `onSession` replays the
            // host's current snapshot to a late subscriber, so a snapshot that
            // arrived between the two calls would be missed otherwise. The
            // trailing `unsubscribe` is the release after the read-back.
            expect(double.calls).toEqual(['onSession', `openSession:${SESSION}`, 'unsubscribe']);
            expect(result.status).toBe('match');
            expect(double.unsubscribes()).toBe(1);
        }
        {
            const double = verifyHost({ onOpen: snapshot(EXPECTED_AGENT) });

            const result = await verifySessionAgent({
                host: double.host,
                sessionId: SESSION,
                expected: EXPECTED_AGENT,
            });

            expect(result).toEqual({ status: 'match', agent: EXPECTED_AGENT, expected: EXPECTED_AGENT });
        }
        {
            const double = verifyHost({ onOpen: snapshot('executor') });

            const result = await verifySessionAgent({
                host: double.host,
                sessionId: SESSION,
                expected: EXPECTED_AGENT,
            });

            expect(result).toEqual({ status: 'mismatch', agent: 'executor', expected: EXPECTED_AGENT });
            expect(double.unsubscribes()).toBe(1);
        }
        {
            const double = verifyHost({ onOpen: snapshot() });

            const result = await verifySessionAgent({
                host: double.host,
                sessionId: SESSION,
                expected: EXPECTED_AGENT,
            });

            expect(result).toEqual({ status: 'mismatch', agent: null, expected: EXPECTED_AGENT });
        }
        {
            const otherSession: SessionSnapshot = { id: 'ses_other', title: 'elsewhere', busy: false, agent: 'nobody' };
            const double = verifyHost({ onOpen: otherSession });

            const result = await verifySessionAgent({
                host: double.host,
                sessionId: SESSION,
                expected: EXPECTED_AGENT,
                timeoutMs: TEST_TIMEOUT_MS,
            });

            expect(result).toEqual({ status: 'timeout', expected: EXPECTED_AGENT, timeoutMs: TEST_TIMEOUT_MS });
            expect(double.unsubscribes()).toBe(1);
        }
        {
            const double = verifyHost({ openError: new Error('HOST_REJECTED') });

            const result = await verifySessionAgent({
                host: double.host,
                sessionId: SESSION,
                expected: EXPECTED_AGENT,
                timeoutMs: TEST_TIMEOUT_MS,
            });

            expect(result.status).toBe('unavailable');
            if (result.status === 'unavailable') {
                expect(result.problem).toContain('HOST_REJECTED');
                expect(result.expected).toBe(EXPECTED_AGENT);
            }

            expect(double.unsubscribes()).toBe(1);
        }
    });

    it('defaults its budget to the documented 15 seconds', async () => {
        {
            expect(AGENT_VERIFY_TIMEOUT_MS).toBe(15_000);
        }
        {
            // The read-back shares the relay's dispatch slot: an unanswered
            // context switch must cost the budget, not the whole loop.
            const double = verifyHost({ onOpen: snapshot(EXPECTED_AGENT), hangOpen: true });

            const result = await verifySessionAgent({
                host: double.host,
                sessionId: SESSION,
                expected: EXPECTED_AGENT,
                timeoutMs: TEST_TIMEOUT_MS,
            });

            expect(result.status).toBe('timeout');
            expect(double.unsubscribes()).toBe(1);
        }
    });
});

describe('verificationNotice (warn-only copy)', () => {
    it('shows a success banner for a match', () => {
        {
            const notice = verificationNotice({ status: 'match', agent: EXPECTED_AGENT, expected: EXPECTED_AGENT });

            expect(notice.tone).toBe('success');
            expect(notice.body).toContain(EXPECTED_AGENT);
        }
        {
            const notice = verificationNotice({ status: 'mismatch', agent: 'executor', expected: EXPECTED_AGENT });

            expect(notice.tone).toBe('warning');
            expect(notice.body).toContain("session agent was 'executor'");
            expect(notice.body).toContain(`expected '${EXPECTED_AGENT}'`);
        }
        {
            const notice = verificationNotice({ status: 'timeout', expected: EXPECTED_AGENT, timeoutMs: 15_000 });

            expect(notice.tone).toBe('warning');
            expect(notice.body).toContain('within 15s');
        }
        {
            const notice = verificationNotice({
                status: 'unavailable',
                expected: EXPECTED_AGENT,
                problem: 'HOST_REJECTED ghp_abcdefghijklmnopqrstuvwx',
            });

            expect(notice.tone).toBe('warning');
            expect(notice.body).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
            expect(notice.body).toContain('[redacted:github-token-classic]');
        }
        {
            // 002 FR-029 as amended: the mismatch warning fires only when a real
            // baseline exists and differs, so a blank one is plain information.
            const notice = verificationNotice({ status: 'uncompared', agent: 'executor', expected: '' });

            expect(notice.tone).toBe('info');
            expect(notice.title).toContain('not compared');
            expect(notice.body).toContain("runs on 'executor'");
            expect(notice.body).toContain('no comparison baseline is configured');
            expect(notice.body).not.toContain('mismatch');
        }
        {
            const notice = verificationNotice({ status: 'uncompared', agent: null, expected: '' });

            expect(notice.tone).toBe('info');
            expect(notice.body).toContain('reported no agent');
            expect(notice.body).not.toContain("expected '");
        }
        {
            const notice = verificationNotice({ status: 'timeout', expected: '', timeoutMs: 15_000 });

            expect(notice.tone).toBe('warning');
            expect(notice.body).toContain('within 15s.');
            expect(notice.body).not.toContain("expected '");
        }
    });
});

/** Correlation id of the run the fixture dispatch produces. */
const CORRELATION = 'mt-run-aaaabbbbccccddddeeeeffff';

/** Lease id the fixture claim carries. */
const LEASE_ID = 'lse-aaaabbbbccccddddeeeeffff';

/** Single-use token the fixture reserve answers with. */
const TOKEN = `dtk-${'a1b2c3d4'.repeat(4)}`;

/** The run the service offers this mount, in the claimed state. */
const CLAIM: ClaimedRun = {
    correlationId: CORRELATION,
    runKey: 'github|77331|acme/widget|issue|7|0',
    ordinal: 0,
    attempt: 1,
    lease: {
        leaseId: LEASE_ID,
        attempt: 1,
        holder: 'mount-verify',
        issuedAt: FIXTURE_TIMESTAMP,
        expiresAt: FIXTURE_TIMESTAMP,
    },
    state: 'pending',
    stateReason: 'waiting for a panel',
    bindingId: 'bnd-verify-1',
    repository: 'acme/widget',
    accountLogin: LOGIN,
    projectId: PROJECT_ID,
    worktreeOption: 'generated',
    subjectType: 'issue',
    issueNumber: 7,
    issueTitle: 'Fix the flaky test',
    issueUrl: ISSUE_URL,
    headSha: null,
    baseRef: null,
    attachmentId: CORRELATION,
    sourceReferences: [],
    referenceCount: 0,
    referencesNotRetained: 0,
    referencesTruncated: false,
    issueBodyExcerpt: '',
    detectedAt: FIXTURE_TIMESTAMP,
    promptPresent: false,
    promptFingerprint: null,
    promptLength: null,
    promptSources: null,
    promptText: null,
};

/** The `page` label the history read carries (005 contract §2). */
const HISTORY_PAGE = {
    limit: 25,
    nextCursor: null,
    hasMore: false,
    total: 1,
    snapshotAt: FIXTURE_TIMESTAMP,
    filter: { bindingId: null, state: null },
};

/**
 * The `GET /v1/config` answer a configured baseline arrives in.
 *
 * @param expectedAgent - The baseline the document carries.
 * @returns The response body, shaped the way the service sends it.
 */
function baselineBody(expectedAgent: string): string {
    return JSON.stringify({ config: { ...DEFAULT_CONFIG, expectedAgent } });
}

/**
 * Run {@link verifyAgentAfterDispatch} against a host reporting one agent.
 *
 * @param agent - Agent the session reports; omit to report none.
 * @param configBody - Body `GET /v1/config` answers with; omit it to model a
 *   service that carries no usable baseline (002 FR-029 case (ii)).
 * @returns The runtime the verification recorded into.
 */
async function recordedVerification(agent?: string, configBody?: string): Promise<PanelRuntime> {
    const double = verifyHost({ onOpen: snapshot(agent) });
    const rt = createTestRuntime(
        fakeHost({
            onSession: double.host.onSession,
            openSession: double.host.openSession,
            serviceRequest: async (request) => {
                if (request.method === 'GET' && request.path === CONFIG_ROUTE) {
                    return configBody === undefined ? { status: 404, body: '{}' } : { status: 200, body: configBody };
                }

                return { status: 200, body: '{"verification":{"ok":true}}' };
            },
        }),
    );

    await verifyAgentAfterDispatch({ rt, correlationId: CORRELATION, attempt: 1, sessionId: SESSION });

    return rt;
}

describe('verifyAgentAfterDispatch (ledger + runs-area banner)', () => {
    it('records agentVerified with the observed agent on a match', async () => {
        {
            const rt = await recordedVerification(EXPECTED_AGENT, baselineBody(EXPECTED_AGENT));
            const entry = rt.state.ledger.entries.at(-1);

            expect(entry?.kind).toBe('session');
            expect(entry?.correlationId).toBe(CORRELATION);
            expect(entry?.detail.agentVerified).toBe(true);
            expect(entry?.detail.observedAgent).toBe(EXPECTED_AGENT);
            expect(entry?.detail.verification).toBe('match');
            expect(entry?.detail.baselineProvenance).toBe('configured');
            expect(rt.state.dispatches.agentNotice?.tone).toBe('success');
        }
        {
            const rt = await recordedVerification('executor', baselineBody(EXPECTED_AGENT));
            const entry = rt.state.ledger.entries.at(-1);

            expect(entry?.detail.agentVerified).toBe(false);
            expect(entry?.detail.observedAgent).toBe('executor');
            expect(entry?.detail.verification).toBe('mismatch');
            expect(rt.state.dispatches.agentNotice?.tone).toBe('warning');
            expect(rt.state.dispatches.agentNotice?.body).toContain("session agent was 'executor'");
            // M9 is warn-only: the copy must say the session keeps running.
        }
        {
            // 002 FR-029 as amended: a blank or unreadable baseline means there
            // is nothing to compare against, so the read-back still reports the
            // observed agent and its provenance — and claims no mismatch from
            // an absence.
            const rt = await recordedVerification(EXPECTED_AGENT);
            const entry = rt.state.ledger.entries.at(-1);

            expect(entry?.kind).toBe('session');
            expect(entry?.detail.agentVerified).toBe(false);
            expect(entry?.detail.observedAgent).toBe(EXPECTED_AGENT);
            expect(entry?.detail.expectedAgent).toBe('');
            expect(entry?.detail.verification).toBe('uncompared');
            expect(entry?.detail.baselineProvenance).toBe('defaulted');
            expect(rt.state.dispatches.agentNotice?.tone).toBe('info');
            expect(rt.state.dispatches.agentNotice?.title).toContain('not compared');
            expect(rt.state.dispatches.agentNotice?.body).not.toContain('mismatch');
        }
    });
});

/** One runs-history row as the service would project the fixture event. */
const RUN_ROW: RunRow = {
    id: CORRELATION,
    correlationId: CORRELATION,
    kind: 'assignment',
    repository: CLAIM.repository,
    issueNumber: CLAIM.issueNumber,
    issueTitle: CLAIM.issueTitle,
    issueUrl: CLAIM.issueUrl,
    state: 'dispatched',
    stateReason: `session ${SESSION} created`,
    runKey: 'github|77331|acme/widget|issue|7|0',
    ordinal: 0,
    attempt: 1,
    attachmentId: CORRELATION,
    projectId: PROJECT_ID,
    worktreeOption: 'generated',
    leaseExpiresAt: null,
    resultDeadlineAt: null,
    sourceReferences: [],
    referenceCount: 0,
    referencesTruncated: false,
    referencesNotRetained: 0,
    session: { sessionId: SESSION, attachmentId: CORRELATION, dispatchedAt: FIXTURE_TIMESTAMP },
    verification: null,
    detectedAt: CLAIM.detectedAt,
    claimedAt: FIXTURE_TIMESTAMP,
    dispatchedAt: FIXTURE_TIMESTAMP,
    dispatchResult: SESSION,
    bindingId: CLAIM.bindingId,
    headSha: null,
    baseRef: null,
    promptPresent: false,
    promptFingerprint: null,
    promptLength: null,
    promptSources: null,
    // No gate has judged this run yet (003 FR-079), so no policy shape exists.
    actorPolicy: null,
};

describe('relay dispatch → verification wiring (M9 in the real path)', () => {
    it('reports the dispatch first, then verifies, then refreshes the runs list', async () => {
        const calls: string[] = [];
        const host = fakeHost({
            startSession: async () => SESSION_CREATED,
            openSession: async (id) => {
                calls.push(`openSession:${id}`);
            },
            onSession: (listener) => {
                listener(snapshot('executor'));

                return IDLE_UNSUBSCRIBE;
            },
            serviceRequest: async (request) => {
                calls.push(`${request.method} ${request.path}`);
                // A configured baseline, so this read-back is a real
                // comparison: 'executor' then mismatches it and warns (002 FR-029).
                if (request.method === 'GET' && request.path === CONFIG_ROUTE) {
                    return { status: 200, body: baselineBody(EXPECTED_AGENT) };
                }

                if (request.method === 'GET' && request.path === '/v1/events/pending') {
                    return {
                        status: 200,
                        body: JSON.stringify({ events: [CLAIM], status: [], auditWritten: true }),
                    };
                }

                if (request.method === 'POST' && request.path === `/v1/events/${CORRELATION}/reserve`) {
                    return {
                        status: 200,
                        body: JSON.stringify({
                            correlationId: CORRELATION,
                            attempt: 1,
                            dispatchToken: TOKEN,
                            tokenExpiresAt: FIXTURE_TIMESTAMP,
                            resultDeadlineAt: FIXTURE_TIMESTAMP,
                            state: 'starting',
                            auditWritten: true,
                        }),
                    };
                }

                if (request.method === 'POST' && request.path === `/v1/events/${CORRELATION}/dispatched`) {
                    return { status: 200, body: '{"done":true}' };
                }

                if (request.method === 'GET' && request.path.startsWith('/v1/events?')) {
                    return { status: 200, body: JSON.stringify({ events: [RUN_ROW], page: HISTORY_PAGE }) };
                }

                return { status: 404, body: '{}' };
            },
        });
        const rt = createTestRuntime(host);
        rt.state.bindings.bindings = [
            {
                bindingId: CLAIM.bindingId,
                accountNumericUserId: '77331',
                accountLogin: LOGIN,
                repository: CLAIM.repository,
                projectId: PROJECT_ID,
                worktreeOption: 'generated',
                triggers: { assignment: true, mention: false, reviewRequest: false },
                state: 'active',
                createdAt: FIXTURE_TIMESTAMP,
                updatedAt: FIXTURE_TIMESTAMP,
            },
        ];

        await dispatchClaimedRun(rt, CLAIM);
        // The read-back is detached from the tick (AC-125), so the assertions
        // below drain it instead of racing the host.
        await drainVerifications(rt);

        const dispatched = calls.indexOf(`POST /v1/events/${CORRELATION}/dispatched`);
        const opened = calls.indexOf(`openSession:${SESSION}`);
        const runsRead = calls.indexOf('GET /v1/events?limit=25');
        // The service hears about the dispatch before the UI context switch.
        expect(dispatched).toBeGreaterThanOrEqual(0);
        expect(opened).toBeGreaterThan(dispatched);
        expect(runsRead).toBeGreaterThan(dispatched);

        const entry = rt.state.ledger.entries.at(-1);
        expect(entry?.detail.agentVerified).toBe(false);
        expect(entry?.detail.observedAgent).toBe('executor');
        expect(rt.state.dispatches.agentNotice?.tone).toBe('warning');
        expect(rt.state.dispatches.rows).toHaveLength(1);
        expect(rt.state.dispatches.rows[0]?.state).toBe('dispatched');
    });
});

describe('T-027 the read-back reaches the service (contract §5)', () => {
    /** The verification report one read-back sent, with where it went. */
    interface ReadBackReport {
        /** Runtime the verification recorded into. */
        readonly rt: PanelRuntime;
        /** `METHOD path` calls the service saw, in order. */
        readonly paths: string[];
        /** Bodies those calls carried, in the same order. */
        readonly bodies: (string | undefined)[];
    }

    /**
     * Run one read-back against a host whose service records the report.
     *
     * The `GET /v1/config` the baseline read performs is answered from
     * `configBody` when one is given, and with a non-2xx otherwise — which is
     * 002 FR-029 case (ii): the field (or the document) is simply not there.
     *
     * @param agent - Agent the session reports; omit to report none.
     * @param configBody - Body `GET /v1/config` should answer with.
     * @returns The runtime plus the report the service received.
     */
    async function reported(agent?: string, configBody?: string): Promise<ReadBackReport> {
        const paths: string[] = [];
        const bodies: (string | undefined)[] = [];
        const double = verifyHost({ onOpen: snapshot(agent) });
        const rt = createTestRuntime(fakeHost({
            onSession: double.host.onSession,
            openSession: double.host.openSession,
            serviceRequest: async (request) => {
                paths.push(`${request.method} ${request.path}`);
                bodies.push(request.body);
                if (request.method === 'GET' && request.path === CONFIG_ROUTE) {
                    return configBody === undefined
                        ? { status: 404, body: '{}' }
                        : { status: 200, body: configBody };
                }

                return { status: 200, body: '{"verification":{"ok":true}}' };
            },
        }));

        await verifyAgentAfterDispatch({ rt, correlationId: CORRELATION, attempt: 1, sessionId: SESSION });

        return { rt, paths, bodies };
    }

    /** The two calls one read-back makes: the baseline read, then the report. */
    const READ_BACK_PATHS = ['GET /v1/config', `POST /v1/events/${CORRELATION}/verification`];

    /** Parse the verification report's body, failing loudly when none arrived. */
    function reportBody(report: ReadBackReport): Record<string, unknown> {
        const index = report.paths.findIndex((path) => path.startsWith('POST '));
        const body = index < 0 ? undefined : report.bodies[index];
        if (body === undefined) {
            throw new Error('the verification never reported to the service');
        }

        return JSON.parse(body) as Record<string, unknown>;
    }

    it('posts a match as evidence with its attempt and the baseline it used', async () => {
        {
            const report = await reported(EXPECTED_AGENT, baselineBody(EXPECTED_AGENT));

            expect(report.paths).toEqual(READ_BACK_PATHS);
            expect(reportBody(report)).toEqual({
                correlationId: CORRELATION,
                attempt: 1,
                sessionId: SESSION,
                observedAgent: EXPECTED_AGENT,
                expectedAgent: EXPECTED_AGENT,
                baselineProvenance: 'configured',
                ok: true,
                note: null,
            });
            expect(report.rt.state.dispatches.agentNotice?.tone).toBe('success');
        }
        {
            const report = await reported('executor', baselineBody(EXPECTED_AGENT));
            const body = reportBody(report);

            expect(body.ok).toBe(false);
            expect(body.observedAgent).toBe('executor');
            expect(report.rt.state.dispatches.agentNotice?.tone).toBe('warning');
            // Warn-only (FR-043): the verification moved no run and armed nothing.
            expect(report.rt.state.dispatches.rows).toEqual([]);
            expect(report.rt.state.dispatches.pendingAction).toBeNull();
            expect(report.rt.state.dispatches.busy).toBe(false);
        }
        {
            const body = reportBody(await reported(undefined, baselineBody(EXPECTED_AGENT)));

            expect(body.ok).toBe(false);
            expect(body.observedAgent).toBeNull();
        }
        {
            const report = await reported('planner', JSON.stringify({ config: { expectedAgent: '  planner  ' } }));

            expect(report.paths).toEqual(READ_BACK_PATHS);
            const body = reportBody(report);
            expect(body.expectedAgent).toBe('planner');
            expect(body.ok).toBe(true);

            const entry = report.rt.state.ledger.entries.at(-1);
            expect(entry?.kind).toBe('session');
            expect(entry?.detail.expectedAgent).toBe('planner');
            expect(entry?.detail.baselineProvenance).toBe('configured');
            expect(entry?.detail.agentVerified).toBe(true);
        }
        {
            // The document was read and the value is blank: the operator's own
            // statement that no baseline is configured (006 FR-100(b) as
            // amended). The report still files — with the observed agent and
            // the absence named — and no mismatch warning fires.
            const report = await reported(EXPECTED_AGENT, baselineBody(''));
            const body = reportBody(report);

            expect(report.paths).toEqual(READ_BACK_PATHS);
            expect(body.expectedAgent).toBe('');
            expect(body.baselineProvenance).toBe('unset');
            expect(body.ok).toBe(false);
            expect(body.observedAgent).toBe(EXPECTED_AGENT);
            expect(body.note).toBe('no baseline is configured, so nothing was compared');

            const entry = report.rt.state.ledger.entries.at(-1);
            expect(entry?.detail.expectedAgent).toBe('');
            expect(entry?.detail.observedAgent).toBe(EXPECTED_AGENT);
            expect(entry?.detail.baselineProvenance).toBe('unset');
            expect(entry?.detail.verification).toBe('uncompared');
            expect(report.rt.state.dispatches.agentNotice?.tone).toBe('info');
        }
        {
            // 002 FR-029 case (ii): the field is absent, the document is
            // unreadable, or the service is unreachable — all three answer the
            // documented (blank) default with `provenance: 'defaulted'`, and the
            // run proceeds to verification comparing nothing.
            const report = await reported(EXPECTED_AGENT);

            expect(report.paths[0]).toBe(READ_BACK_PATHS[0]);
            const body = reportBody(report);
            expect(body.expectedAgent).toBe('');
            expect(body.baselineProvenance).toBe('defaulted');
            expect(body.ok).toBe(false);

            const entry = report.rt.state.ledger.entries.at(-1);
            expect(entry?.detail.expectedAgent).toBe('');
            expect(entry?.detail.baselineProvenance).toBe('defaulted');
            expect(entry?.detail.verification).toBe('uncompared');
        }
        {
            const unusable = [
                '{"config":{}}',
                '{"config":{"expectedAgent":42}}',
                '{"config":"not-an-object"}',
                'not json at all',
            ];

            for (const document of unusable) {
                const report = await reported(EXPECTED_AGENT, document);

                expect(reportBody(report).expectedAgent).toBe('');
                expect(report.rt.state.ledger.entries.at(-1)?.detail.baselineProvenance).toBe('defaulted');
            }

            // A blank *string* member is a value the document really carried, so
            // it reads as `unset` — the operator's own blank — rather than as an
            // unreadable document.
            const blank = await reported(EXPECTED_AGENT, '{"config":{"expectedAgent":"   "}}');
            expect(reportBody(blank).expectedAgent).toBe('');
            expect(blank.rt.state.ledger.entries.at(-1)?.detail.baselineProvenance).toBe('unset');
        }
    });

    it('never blocks, and never claims a mismatch, for the baseline\'s own absence', async () => {
        {
            // AC-023 / 002 FR-029 as amended: a missing baseline alone must not
            // produce `blocked:agent-mismatch` — and it does not even claim a
            // mismatch, because there was nothing to compare against. The
            // read-back reports the observation and the absence instead.
            const report = await reported(EXPECTED_AGENT);
            const body = reportBody(report);

            expect(body.expectedAgent).toBe('');
            expect(body.ok).toBe(false);
            expect(body.observedAgent).toBe(EXPECTED_AGENT);
            expect(report.rt.state.dispatches.agentNotice?.tone).toBe('info');
            expect(report.rt.state.dispatches.agentNotice?.body).not.toContain('mismatch');
            // Warn-only still: the read-back armed nothing and moved no run.
            expect(report.rt.state.dispatches.rows).toEqual([]);
            expect(report.rt.state.dispatches.pendingAction).toBeNull();
        }
        {
            const report = await reported('executor', baselineBody(EXPECTED_AGENT));

            expect(reportBody(report).ok).toBe(false);
            expect(report.rt.state.dispatches.agentNotice?.tone).toBe('warning');
            expect(report.rt.state.ledger.entries.at(-1)?.detail.baselineProvenance).toBe('configured');
        }
        {
            // The host answers every service call but never delivers a session
            // snapshot: an awaited read-back would sit on its 15 s budget here.
            const held: { deliver: (agent: string) => void } = {
                deliver: () => {
                    throw new Error('the read-back never subscribed');
                },
            };
            const calls: string[] = [];
            const host = fakeHost({
                startSession: async () => SESSION_CREATED,
                openSession: async (id) => {
                    calls.push(`openSession:${id}`);
                },
                onSession: (listener) => {
                    held.deliver = (agent) => listener(snapshot(agent));

                    return IDLE_UNSUBSCRIBE;
                },
                serviceRequest: async (request) => {
                    calls.push(`${request.method} ${request.path}`);
                    // A configured baseline, so the delivered 'executor' is a
                    // mismatch the banner warns about (002 FR-029).
                    if (request.method === 'GET' && request.path === CONFIG_ROUTE) {
                        return { status: 200, body: baselineBody(EXPECTED_AGENT) };
                    }

                    if (request.method === 'GET' && request.path === '/v1/events/pending') {
                        return {
                            status: 200,
                            body: JSON.stringify({ events: [CLAIM], status: [], auditWritten: true }),
                        };
                    }

                    if (request.path.endsWith('/reserve')) {
                        return {
                            status: 200,
                            body: JSON.stringify({
                                correlationId: CORRELATION,
                                attempt: 1,
                                dispatchToken: TOKEN,
                                tokenExpiresAt: FIXTURE_TIMESTAMP,
                                resultDeadlineAt: FIXTURE_TIMESTAMP,
                                state: 'starting',
                                auditWritten: true,
                            }),
                        };
                    }

                    if (request.path.endsWith('/dispatched')) {
                        return { status: 200, body: '{"done":true}' };
                    }

                    if (request.method === 'GET' && request.path.startsWith('/v1/events?')) {
                        return { status: 200, body: JSON.stringify({ events: [], page: HISTORY_PAGE }) };
                    }

                    return { status: 200, body: '{"ok":true}' };
                },
            });
            const rt = createTestRuntime(host);
            rt.state.bindings.bindings = [
                {
                    bindingId: CLAIM.bindingId,
                    accountNumericUserId: '77331',
                    accountLogin: LOGIN,
                    repository: CLAIM.repository,
                    projectId: PROJECT_ID,
                    worktreeOption: 'generated',
                    triggers: { assignment: true, mention: false, reviewRequest: false },
                    state: 'active',
                    createdAt: FIXTURE_TIMESTAMP,
                    updatedAt: FIXTURE_TIMESTAMP,
                },
            ];

            await dispatchClaimedRun(rt, CLAIM);

            // The tick returned with the read-back still in flight: the claim slot
            // is free while the host has not answered (AC-125, FR-043).
            expect(rt.pendingVerifications).toHaveLength(1);
            expect(calls).toContain(`openSession:${SESSION}`);
            expect(rt.state.dispatches.rows).toHaveLength(0);

            held.deliver('executor');
            await drainVerifications(rt);

            expect(rt.pendingVerifications).toHaveLength(0);
            expect(rt.state.ledger.entries.at(-1)?.detail.agentVerified).toBe(false);
            expect(rt.state.dispatches.agentNotice?.tone).toBe('warning');
        }
    });
});
