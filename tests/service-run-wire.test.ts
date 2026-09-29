/**
 * The run-scoped **wire**: what the eight `/v1/events/:correlationId/*` routes
 * actually answer over HTTP (003 T-042d; T-043 extends this file).
 *
 * The route table suite proves each path is reachable; the operation suites
 * prove each verdict is right. What neither proved is that the *envelopes* reach
 * the transport: every wire-level assertion in the older suites was a `401`,
 * `404`, `405`, or `422`, so `runOutcomeResponse`, `runAnswer`'s field mapping,
 * `handleReserve`'s `dispatchToken`/`tokenExpiresAt`, `REFUSAL_STATUS`, and the
 * route-level FR-063 warn had never executed against a real socket. This suite
 * closes that gap, starting with the refusal T-042d adds:
 *
 * - **A resolve may not name a session and ask for none.** `no-session` is the
 *   only path that authorizes a second dispatch for an `unconfirmed` run, so a
 *   body carrying a session id *with* it would buy a fresh authorization for a
 *   run whose session it just reported. The route refuses `422` naming the field
 *   rather than resolving the ambiguity by a precedence rule.
 *
 * Offline: a temp data directory per instance, runs seeded through the operation
 * modules, the service clock injected wherever a route judges one, no sleeping,
 * no network, no host.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nowIso } from '../src/ids.ts';
import { createEvent } from '../service/poll/events.ts';
import { buildDispatchToken } from '../service/poll/run-key.ts';
import { emptyRunsDocument, readRunsDocument, writeRunsDocument } from '../service/poll/runs.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { createLogger } from '../service/log.ts';
import { RESOLVE_PATH } from '../service/routes/run-ops.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { DispatchAttempt, Run } from '../service/poll/runs-types.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** The header carrying a JSON body, spelled as HTTP requires it. */
const CONTENT_TYPE_HEADER = 'content-type';

/** Headers for a request carrying a JSON body. */
function jsonHeaders(): Record<string, string> {
    return { [CONTENT_TYPE_HEADER]: 'application/json' };
}

/** The session a seeded dispatched run records, for a body that must not name it. */
const SEEDED_SESSION = 'ses_wire_seeded';

/** The wire code `422` answers with, also written on the refusal row. */
const VALIDATION = 'validation';

/** The fixture binding the detections name. */
const BINDING_ID = 'bnd-wire';

/** The fixture repository the detections name. */
const REPOSITORY = 'acme/wire';

/** The fixture account the detections name. */
const ACCOUNT_ID = '77331';

const LOG_LINES: string[] = [];
const LOGGER: ServiceLogger = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let store: ServiceStore;
let running: TestService | null = null;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-wire-'));
    LOG_LINES.length = 0;
    running = null;
});

afterEach(async () => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    await rm(tempRoot, { recursive: true, force: true });
});

/** Build an assignment detection for one issue. */
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
        detectedAt: nowIso(),
    };
}

/**
 * Start a service against a fresh temp store and register it for cleanup.
 *
 * @returns The running instance, with its store handle open for seeding.
 */
async function startSeededService(): Promise<TestService> {
    const service = await startTestService();
    running = service;
    const seeded = service.handle.store;
    if (seeded === null) {
        throw new Error('the harness store is unavailable');
    }

    store = seeded;

    return service;
}

/**
 * The outcome a seeded attempt record carries for its state.
 *
 * @param input - The state and the session the fixture reports.
 * @returns The outcome, agreeing with the state the parser cross-checks.
 */
function seededOutcome(input: {
    /** State the run is seeded in. */
    readonly state: Run['state'];
    /** Session the fixture says the run produced, else `null`. */
    readonly sessionId: string | null;
}): DispatchAttempt['outcome'] {
    if (input.sessionId !== null) {
        return 'dispatched';
    }

    return input.state === 'failed' ? 'failed' : null;
}

/**
 * The attempt record a seeded run's state implies.
 *
 * @param input - The state, the session the fixture reports, and whether the
 *   state holds an authorization.
 * @returns The record, agreeing with the state the store's parser cross-checks.
 */
function seededAttempt(input: {
    /** State the run is seeded in. */
    readonly state: Run['state'];
    /** Session the fixture says the run produced, else `null`. */
    readonly sessionId: string | null;
    /** Whether the state holds an authorization. */
    readonly holdsReservation: boolean;
    /** The token attempt 1 of this run key mints, when the state authorizes. */
    readonly dispatchToken: string;
}): DispatchAttempt {
    const closed = input.state === 'dispatched' || input.state === 'failed';
    const reportedAt = input.sessionId !== null || closed ? nowIso() : null;

    return {
        attempt: 1,
        dispatchToken: input.holdsReservation ? input.dispatchToken : null,
        reservedAt: input.holdsReservation ? nowIso() : null,
        outcome: seededOutcome(input),
        sessionId: input.sessionId,
        reason: input.state === 'failed' ? 'bootstrap-failed' : null,
        resultReportedAt: reportedAt,
    };
}

/**
 * Seed one run directly in a state, with the lease that state implies.
 *
 * The state under test is what the route's *judge* is about, so the fixture
 * writes it rather than driving a dozen operations to reach it. Everything the
 * store validates is still written the way the real transitions write it.
 *
 * @param input - Issue to build the run from, the state to seed it in, and
 *   whether it should hold a session.
 * @returns The seeded run.
 */
async function seedRun(input: {
    /** Issue to build the run from. */
    readonly issueNumber: number;
    /** State to seed. */
    readonly state: Run['state'];
    /** Session the fixture says the run produced, else `null`. */
    readonly sessionId?: string | null;
}): Promise<Run> {
    const delivery = createEvent(assignment(input.issueNumber));
    const planned = applyEnqueue({ document: emptyRunsDocument(), deliveries: [delivery], now: nowIso() });
    const created = planned.created[0];
    if (created === undefined) {
        throw new Error('seed run was not created');
    }

    const sessionId = input.sessionId ?? null;
    const holdsReservation = input.state === 'starting' || input.state === 'unconfirmed';
    const dispatchToken = buildDispatchToken(created.runKey, 1);
    const run: Run = {
        ...created,
        state: input.state,
        stateReason: `seeded as ${input.state}`,
        attempt: 1,
        lease: null,
        reservation: holdsReservation
            ? {
                dispatchToken,
                attempt: 1,
                reservedAt: nowIso(),
                // Live for the whole suite: the routes judge against the real
                // service clock, and a fixture that expires mid-run would turn
                // this into an expiry test rather than the verdict test it is.
                resultDeadlineAt: new Date(Date.now() + 300_000).toISOString(),
                consumed: false,
            }
            : null,
        session: sessionId === null
            ? null
            : {
                sessionId,
                attachmentId: created.attachmentId,
                dispatchedAt: nowIso(),
                title: '',
                sourceUrl: created.sourceReferences[0]?.sourceUrl ?? '',
                worktree: null,
            },
        attempts: [seededAttempt({ state: input.state, sessionId, holdsReservation, dispatchToken })],
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
 * The concrete path one run-scoped route answers on, bound to a run id.
 *
 * @param pattern - The route's declared pattern.
 * @param correlationId - The run the path should name.
 * @returns The same path with its parameter bound.
 */
function bound(pattern: string, correlationId: string): string {
    return pattern.replace(':correlationId', correlationId);
}

/** One response, with its status and parsed body. */
interface WireAnswer {
    /** HTTP status. */
    readonly status: number;
    /** Parsed body, read as an untrusted record. */
    readonly json: Record<string, unknown>;
}

/**
 * POST one run-scoped body over the loopback service.
 *
 * @param service - The running instance to call.
 * @param request - The concrete path and the body to post.
 * @returns The status and the parsed body.
 */
async function post(
    service: TestService,
    request: { readonly path: string; readonly body: Readonly<Record<string, unknown>> },
): Promise<WireAnswer> {
    const response = await service.call(request.path, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(request.body),
    });

    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/**
 * The code and message of a failure envelope, read without trusting its shape.
 *
 * @param body - The response body.
 * @returns The envelope's code and message, or empty strings when it carries none.
 */
function errorOf(body: Record<string, unknown>): { readonly code: string; readonly message: string } {
    const { error } = body;
    if (typeof error !== 'object' || error === null) {
        return { code: '', message: '' };
    }

    const envelope = error as { code?: unknown; message?: unknown };

    return {
        code: typeof envelope.code === 'string' ? envelope.code : '',
        message: typeof envelope.message === 'string' ? envelope.message : '',
    };
}

describe('T-042d a resolve may not name a session and ask for none', () => {
    it('refuses 422 naming sessionId instead of re-dispatching a run it just reported', async () => {
        const service = await startSeededService();
        const run = await seedRun({ issueNumber: 1, state: 'unconfirmed' });

        const result = await post(service, {
            path: bound(RESOLVE_PATH, run.correlationId),
            body: {
                correlationId: run.correlationId,
                decision: 'no-session',
                sessionId: SEEDED_SESSION,
                note: 'no session with that attachment id',
            },
        });

        expect(result.status).toBe(422);
        expect(errorOf(result.json).code).toBe(VALIDATION);
        // The refusal names the field that made the body ambiguous.
        expect(errorOf(result.json).message).toContain('sessionId');
        // Nothing moved: the run is still wedged, still holding its own token.
        const stored = await readRun(run.correlationId);
        expect(stored.state).toBe('unconfirmed');
        expect(stored.attempt).toBe(1);
        expect(stored.session).toBeNull();
        expect(stored.reservation?.consumed).toBe(false);
    });

    it('still accepts the same body without sessionId, which is the documented shape', async () => {
        const service = await startSeededService();
        const run = await seedRun({ issueNumber: 2, state: 'unconfirmed' });

        const result = await post(service, {
            path: bound(RESOLVE_PATH, run.correlationId),
            body: {
                correlationId: run.correlationId,
                decision: 'no-session',
                note: 'no session with that attachment id',
            },
        });

        expect(result.status).toBe(200);
        expect(result.json.state).toBe('pending');
        expect(await readRun(run.correlationId).then((found) => found.attempt)).toBe(2);
    });
});
