/**
 * The run-scoped **wire**: what the eight `/v1/events/:correlationId/*` routes
 * actually answer over HTTP (003 T-042d, T-043).
 *
 * The route table suite proves each path is reachable; the operation suites
 * prove each verdict is right. What neither proved is that the *envelopes* reach
 * the transport: every wire-level assertion in the older suites was a `401`,
 * `404`, `405`, or `422`, so `runOutcomeResponse`, `runAnswer`'s field mapping,
 * `handleReserve`'s `dispatchToken`/`tokenExpiresAt`, `REFUSAL_STATUS`, and the
 * route-level FR-063 warn had never executed against a real socket. This suite
 * owns that gap, clause by clause:
 *
 * - **T-042d** — a resolve may not name a session and ask for `no-session`.
 * - **T-043a** — one `200` (the reserve envelope, member by member) and one
 *   `409` for every refusal code the catalog defines. States are **reached
 *   through the operation modules**, never hand-written, so each verdict comes
 *   from the real judge rather than from a fixture the store merely accepts.
 * - **T-043b** — a failed `dispatch.refused` append is warned about on a
 *   refusal exactly as on a success (FR-063).
 * - **T-043c** — a `422` about a run that exists writes its row; `404
 *   unknown-run` stays row-free.
 * - **T-043e/f** — an over-long optional free-text member, and a `sessionId`
 *   outside the host's own shape, are `422`s naming the field rather than silent
 *   gaps.
 * - **T-043g** — the second, un-routed minting site is gone from the sources.
 * - **T-043h** — §7 and §8 never require `attempt`, pinned so a future change to
 *   `readRunScopeBody` fails the suite instead of quietly widening the wire.
 *
 * Offline: a temp data directory per instance, runs reached through the real
 * operations with injected service-clock stamps, no sleeping, no network, no
 * host.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { nowIso } from '../src/ids.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { blockDispatch } from '../service/poll/dispatch-block.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import { sweepOnce } from '../service/poll/sweep.ts';
import { buildDispatchToken } from '../service/poll/run-key.ts';
import { emptyRunsDocument, readRunsDocument } from '../service/poll/runs.ts';
import { createPollingView } from '../service/poll/view.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { createLogger } from '../service/log.ts';
import { createVerifyThrottle } from '../service/throttle.ts';
import { refuse } from '../service/poll/run-refusal.ts';
import { runAnswer, runOutcomeResponse } from '../service/routes/run-answer.ts';
import { BLOCKED_PATH, DISPATCHED_PATH, RESERVE_PATH } from '../service/routes/dispatch.ts';
import { REQUEUE_PATH, RESOLVE_PATH, RETRY_PATH, VERIFICATION_PATH } from '../service/routes/run-ops.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { RunRefused } from '../service/poll/run-refusal.ts';
import type { Run } from '../service/poll/runs-types.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import type { RouteContext } from '../service/routes/types.ts';
import { offlineVerifier } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';
import { writeOpenBinding } from './support/binding-fixture.ts';

/** The header carrying a JSON body, spelled as HTTP requires it. */
const CONTENT_TYPE_HEADER = 'content-type';

/** Headers for a request carrying a JSON body. */
function jsonHeaders(): Record<string, string> {
    return { [CONTENT_TYPE_HEADER]: 'application/json' };
}

/** The session a dispatched fixture records, so a refusal can name it. */
const SEEDED_SESSION = 'ses_wire_seeded';

/** The agent every verification body reports, matching or not. */
const PROBE_AGENT = 'project-manager';

/** The failure a `failed` fixture reports as its cause. */
const SEEDED_FAILURE = 'bootstrap-failed';

/** The holder every fixture claim takes, so lease verdicts read one name. */
const HOLDER = 'panel-wire';

/** The default lease and result deadline, in milliseconds (config bounds). */
const DEFAULT_WINDOW_MS = 120_000;

/** Offset past both windows, so an injected stamp is genuinely past them. */
const PAST_BOTH_WINDOWS_MS = DEFAULT_WINDOW_MS + 1_000;

/** A service-clock stamp `offsetMs` ahead of now; tests never wait on it. */
function stamp(offsetMs: number): string {
    return new Date(Date.now() + offsetMs).toISOString();
}

/** The wire code `422` answers with, also written on the refusal row. */
const VALIDATION = 'validation';

/** The wire code a lease or token staleness verdict carries. */
const STALE_LEASE = 'stale-lease';

/** The wire code a second authorization on a live run carries. */
const ALREADY_RESERVED = 'already-reserved';

/** The wire code a session-bearing run answers a reserve with (FR-022, AC-112). */
const ALREADY_DISPATCHED = 'already-dispatched';

/** The wire code every state verdict carries. */
const INVALID_TRANSITION = 'invalid-transition';

/** The wire code a blocked retry whose cause has not cleared carries. */
const CAUSE_NOT_CLEARED = 'cause-not-cleared';

/** The one state a dead-lettered fixture must reach before it can requeue. */
const DEAD_LETTERED = 'dead-lettered';

/** The one resolution that authorises a re-dispatch (FR-027). */
const NO_SESSION = 'no-session';

/** The lifecycle row every refusal this suite reaches owes (FR-003). */
const REFUSED_ROW = 'dispatch.refused';

/** A well-formed lease no run ever held, for the staleness verdict. */
const UNKNOWN_LEASE = `lse-${'d'.repeat(24)}`;

/** A well-formed token no run ever recorded, for the staleness verdict. */
const UNKNOWN_TOKEN = `dtk-${'e'.repeat(32)}`;

/** A well-formed run id with no run behind it, for the row-free `404`. */
const UNSEEDED_RUN_ID = `mt-run-${'f'.repeat(24)}`;

/** One character past the bound on an optional free-text member (T-043e). */
const OVER_LONG_TEXT = 'x'.repeat(1_001);

/** A `sessionId` in no shape the host mints (T-043f). */
const UNHOSTLY_SESSION = 'not-a-session';

/** The fixture binding the detections name. */
const BINDING_ID = 'bnd-wire';

/** The fixture repository the detections name. */
const REPOSITORY = 'acme/wire';

/** The fixture account the detections name. */
const ACCOUNT_ID = '77331';

const LOG_LINES: string[] = [];
const LOGGER: ServiceLogger = createLogger({ level: 'error', sink: (line) => void LOG_LINES.push(line) });

let tempRoot = '';
let store: ServiceStore;
let running: TestService | null = null;

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-wire-'));
    LOG_LINES.length = 0;
    running = null;
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
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
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
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
    // The gate reads `bindings.json` at authorization and denies when it cannot
    // (003 FR-076); the open policy keeps every wire assertion here about the
    // wire (002 FR-047).
    await writeOpenBinding({
        store,
        bindingId: BINDING_ID,
        options: { repository: REPOSITORY, projectId: 'prj_42' },
    });

    return service;
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
 * The lease a claimed run carries, or the fixture's own failure when it has none.
 *
 * @param run - The claimed run.
 * @returns The lease id the claim minted.
 */
function leaseOf(run: Run): string {
    if (run.lease === null) {
        throw new Error('the fixture run carries no lease');
    }

    return run.lease.leaseId;
}

/**
 * Authorize one claimed run through the real reserve.
 *
 * @param run - The claimed run.
 * @returns The run as it stands in `starting`.
 */
async function authorize(run: Run): Promise<Run> {
    const reserved = await reserveDispatch({
        store,
        log: LOGGER,
        correlationId: run.correlationId,
        leaseId: leaseOf(run),
        attempt: 1,
        now: stamp(0),
    });
    if (reserved.status !== 'applied') {
        throw new Error(`the fixture reserve did not apply: ${reserved.status}`);
    }

    return await readRun(run.correlationId);
}

/**
 * Spend one authorization through the real result report.
 *
 * @param run - The `starting` run.
 * @param sessionId - The session the fixture says it created, else `null`.
 * @returns The run as it stands afterwards.
 */
async function settle(run: Run, sessionId: string | null): Promise<Run> {
    const reported = await reportDispatch({
        store,
        log: LOGGER,
        correlationId: run.correlationId,
        dispatchToken: run.reservation?.dispatchToken ?? '',
        attempt: 1,
        operation: 'result',
        outcome: sessionId === null
            ? { attemptOutcome: 'failed', sessionId: null, reason: SEEDED_FAILURE }
            : { attemptOutcome: 'dispatched', sessionId, reason: null },
        now: stamp(0),
    });
    if (reported.status !== 'applied') {
        throw new Error(`the fixture report did not apply: ${reported.status}`);
    }

    return await readRun(run.correlationId);
}

/**
 * Burn the automatic requeue budget with the sweep until the run parks.
 *
 * Three requeues, then the park — asserted by looping rather than by a count so
 * the fixture follows whatever AC-106 pins instead of restating it.
 *
 * @returns The `dead-lettered` run.
 */
async function driveToDeadLetter(correlationId: string): Promise<Run> {
    let run = await readRun(correlationId);
    for (let cycle = 0; cycle < 6 && run.state !== DEAD_LETTERED; cycle += 1) {
        await claimPendingRuns({ store, log: LOGGER, holder: `${HOLDER}-${cycle}`, now: stamp(0) });
        await sweepOnce({ store, log: LOGGER, now: stamp(PAST_BOTH_WINDOWS_MS) });
        run = await readRun(correlationId);
    }

    if (run.state !== DEAD_LETTERED) {
        throw new Error('the fixture run never dead-lettered');
    }

    return run;
}

/**
 * Reach one run state by driving the real operations (T-043a's own instruction).
 *
 * Nothing here writes `runs.json` directly: the state under test is what a
 * route's *judge* is about, and a fixture the store merely accepts would let a
 * verdict pass against a shape the product can never produce.
 *
 * @returns The run as it stands in that state.
 */
async function driveTo(issueNumber: number, target: Run['state']): Promise<Run> {
    // The run this call created, not merely the first one in the document: a
    // fixture may hold several runs by the time a later `driveTo` runs.
    const prior = await readRunsDocument({ store, log: LOGGER });
    const before = new Set(prior.runs.map((run) => run.correlationId));
    await enqueueEvents({ store, log: LOGGER, incoming: [createEvent(assignment(issueNumber))] });
    const seeded = await readRunsDocument({ store, log: LOGGER });
    const first = seeded.runs.find((run) => !before.has(run.correlationId));
    if (first === undefined) {
        throw new Error('the fixture run was not enqueued');
    }

    if (target === 'pending') {
        return first;
    }

    await claimPendingRuns({ store, log: LOGGER, holder: HOLDER, now: stamp(0) });
    const claimed = await readRun(first.correlationId);
    if (target === 'claimed') {
        return claimed;
    }

    if (target.startsWith('blocked:')) {
        const blocked = await blockDispatch({
            store,
            log: LOGGER,
            correlationId: claimed.correlationId,
            leaseId: leaseOf(claimed),
            attempt: 1,
            blockedReason: 'project-missing',
            detail: 'prj_42 is not registered in OpenChamber',
            guidance: 'register the project in OpenChamber, then retry',
            now: stamp(0),
        });
        if (blocked.status !== 'applied') {
            throw new Error(`the fixture block did not apply: ${blocked.status}`);
        }

        return await readRun(claimed.correlationId);
    }

    if (target === DEAD_LETTERED) {
        return await driveToDeadLetter(claimed.correlationId);
    }

    const authorized = await authorize(claimed);
    if (target === 'starting') {
        return authorized;
    }

    if (target === 'unconfirmed') {
        // The deadline is armed from the reserve's own stamp, so a sweep stamped
        // past both windows wedges it without waiting for a clock (FR-023).
        await sweepOnce({ store, log: LOGGER, now: stamp(PAST_BOTH_WINDOWS_MS) });

        return await readRun(authorized.correlationId);
    }

    return await settle(authorized, target === 'dispatched' ? SEEDED_SESSION : null);
}

/**
 * Enqueue one issue and claim it, for the verdicts a lease decides.
 *
 * @returns The claimed run and the lease the claim minted for it.
 */
async function driveAndClaim(issueNumber: number): Promise<{ readonly run: Run; readonly leaseId: string }> {
    const run = await driveTo(issueNumber, 'claimed');

    return { run, leaseId: leaseOf(run) };
}

/**
 * The concrete path one run-scoped route answers on, bound to a run id.
 *
 * @returns The same path with its parameter bound.
 */
function bound(pattern: string, correlationId: string): string {
    return pattern.replace(':correlationId', () => correlationId);
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

/**
 * The rows of one event type across the whole trail.
 *
 * The document read first drains the durable outbox (T-037), so a count taken
 * without it is one row short of what the operations actually owed.
 *
 * @returns That row type's `details`, in trail order.
 */
async function rowsOf(eventType: string): Promise<readonly Record<string, unknown>[]> {
    await readRunsDocument({ store, log: LOGGER });
    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === eventType).map((entry) => entry.details);
}

/**
 * A route context for the one test that exercises the answer mapping directly.
 *
 * @param sink - Collects every line the context's logger writes.
 * @returns A context with the store the mapping never reads.
 */
function answerContext(sink: (line: string) => void): RouteContext {
    return {
        store: null,
        dataDir: tempRoot,
        startedAt: Date.now(),
        log: createLogger({ level: 'debug', sink }),
        schemaVersion: 1,
        github: offlineVerifier(),
        throttle: createVerifyThrottle(),
        polling: createPollingView().view,
    };
}

/** One run, built without a store, for the answer-mapping test. */
async function detachedRun(issueNumber: number): Promise<Run> {
    const planned = applyEnqueue({
        document: emptyRunsDocument(),
        deliveries: [createEvent(assignment(issueNumber))],
        now: nowIso(),
    });
    const [created] = planned.created;
    if (created === undefined) {
        throw new Error('the detached fixture run was not created');
    }

    return created;
}

describe('T-042d a resolve may not name a session and ask for none', () => {
    it('refuses 422 naming sessionId instead of re-dispatching a run it just reported', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(1, 'unconfirmed');

            const result = await post(service, {
                path: bound(RESOLVE_PATH, run.correlationId),
                body: {
                    correlationId: run.correlationId,
                    decision: NO_SESSION,
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
        }
    });

    it('still accepts the same body without sessionId, which is the documented shape', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(2, 'unconfirmed');

            const result = await post(service, {
                path: bound(RESOLVE_PATH, run.correlationId),
                body: { correlationId: run.correlationId, decision: NO_SESSION, note: 'checked the session list' },
            });

            expect(result.status).toBe(200);
            expect(result.json.state).toBe('pending');
            expect(await readRun(run.correlationId).then((found) => found.attempt)).toBe(2);
        }
    });

});

describe('T-043a the reserve 200 carries every member the panel acts on', () => {
    it('answers the token, both deadlines, the state, and auditWritten', async () => {
        const service = await startSeededService();
        const { run, leaseId } = await driveAndClaim(10);

        const result = await post(service, {
            path: bound(RESERVE_PATH, run.correlationId),
            body: { correlationId: run.correlationId, attempt: 1, leaseId },
        });

        expect(result.status).toBe(200);
        expect(result.json.state).toBe('starting');
        expect(result.json.attempt).toBe(1);
        expect(result.json.auditWritten).toBe(true);
        // The wire hands back exactly what FR-020's derivation produces, so the
        // panel's copy and the run's record can never be two different bytes.
        expect(result.json.dispatchToken).toBe(buildDispatchToken(run.runKey, 1));
        expect(String(result.json.dispatchToken)).toMatch(/^dtk-[0-9a-f]{32}$/);
        // Both deadlines are live and mean different things: the lease says when
        // the *claim* dies, the result deadline says when the *authorization* is
        // reported or wedged (T-043d). A panel reading only the first would skip
        // its report and strand the run in `unconfirmed`.
        for (const member of ['tokenExpiresAt', 'resultDeadlineAt'] as const) {
            const parsed = Date.parse(String(result.json[member]));
            expect(Number.isNaN(parsed), `${member} must be an RFC 3339 stamp`).toBe(false);
            expect(parsed).toBeGreaterThan(Date.now());
        }

        expect(await rowsOf('dispatch.reserved')).toHaveLength(1);
    });
});

describe('T-043a every refusal code reaches the transport as 409', () => {
    it('answers stale-lease for a lease the run never held', async () => {
        {
            const service = await startSeededService();
            const { run } = await driveAndClaim(11);

            const result = await post(service, {
                path: bound(RESERVE_PATH, run.correlationId),
                body: { correlationId: run.correlationId, attempt: 1, leaseId: UNKNOWN_LEASE },
            });

            expect(result.status).toBe(409);
            expect(errorOf(result.json).code).toBe(STALE_LEASE);
            expect(errorOf(result.json).message).toContain('lease');
        }
    });

    it('answers already-reserved for a second authorization on one live run', async () => {
        {
            const service = await startSeededService();
            const { run, leaseId } = await driveAndClaim(12);
            const path = bound(RESERVE_PATH, run.correlationId);
            const first = await post(service, { path, body: {
                correlationId: run.correlationId, attempt: 1, leaseId } });
            expect(first.status).toBe(200);

            const second = await post(service, { path, body: {
                correlationId: run.correlationId, attempt: 1, leaseId } });

            expect(second.status).toBe(409);
            expect(errorOf(second.json).code).toBe(ALREADY_RESERVED);
            // FR-022: the refusal names the authorization that is already outstanding.
            expect(errorOf(second.json).message).toContain('attempt 1');
            expect(errorOf(second.json).message).toContain(String(first.json.resultDeadlineAt));
        }
    });

    it('answers already-dispatched naming the session a leaseless run recorded', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(13, 'dispatched');
            expect(run.lease).toBeNull();

            const result = await post(service, {
                path: bound(RESERVE_PATH, run.correlationId),
                body: { correlationId: run.correlationId, attempt: 1, leaseId: UNKNOWN_LEASE },
            });

            expect(result.status).toBe(409);
            expect(errorOf(result.json).code).toBe(ALREADY_DISPATCHED);
            expect(errorOf(result.json).message).toContain(SEEDED_SESSION);
        }
    });

    it('answers invalid-transition naming the state for a retry that cannot run', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(14, 'pending');

            const result = await post(service, {
                path: bound(RETRY_PATH, run.correlationId),
                body: { correlationId: run.correlationId, attempt: 1 },
            });

            expect(result.status).toBe(409);
            expect(errorOf(result.json).code).toBe(INVALID_TRANSITION);
        }
    });

    it('answers cause-not-cleared when only the panel can check the cause', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(15, 'blocked:project-missing');

            const result = await post(service, {
                path: bound(RETRY_PATH, run.correlationId),
                body: { correlationId: run.correlationId, attempt: 1, causeCleared: false },
            });

            expect(result.status).toBe(409);
            expect(errorOf(result.json).code).toBe(CAUSE_NOT_CLEARED);
            expect(await readRun(run.correlationId).then((found) => found.state)).toBe('blocked:project-missing');
        }
    });

});

describe('T-043b a degraded trail warns on a refusal too (FR-063)', () => {
    it('names the run and the operation when the refusal row failed to append', async () => {
        {
            const run = await detachedRun(90);
            const lines: string[] = [];
            const refused: RunRefused = {
                status: 'refused',
                refusal: refuse(STALE_LEASE, 'the lease is expired or does not match this run'),
                run,
                auditWritten: false,
            };

            const response = runOutcomeResponse({
                context: answerContext((line) => void lines.push(line)),
                operation: 'reserve',
                outcome: refused,
                success: (found, auditWritten) =>
                    runAnswer({ correlationId: run.correlationId, run: found, auditWritten }),
            });

            // The warn is additive: the panel already has to act on a `409`, and
            // surfacing the degradation must not change that answer.
            expect(response.status).toBe(409);
            const warnings = lines.filter((line) => line.includes('could not record its row'));
            expect(warnings).toHaveLength(1);
            expect(warnings.join('\n')).toContain(run.correlationId);
            expect(warnings.join('\n')).toContain('reserve');
        }
    });

    it('says nothing when the refusal row did land', async () => {
        {
            const run = await detachedRun(91);
            const lines: string[] = [];
            const refused: RunRefused = {
                status: 'refused',
                refusal: refuse(INVALID_TRANSITION, 'this run is pending'),
                run,
                auditWritten: true,
            };

            runOutcomeResponse({
                context: answerContext((line) => void lines.push(line)),
                operation: 'retry',
                outcome: refused,
                success: (found, auditWritten) =>
                    runAnswer({ correlationId: run.correlationId, run: found, auditWritten }),
            });

            expect(lines.filter((line) => line.includes('could not record its row'))).toHaveLength(0);
        }
    });

});

describe('T-043c a 422 about a run that exists writes its refusal row', () => {
    it('records the operation, code, prior state, and attempt for a malformed body', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(30, 'pending');

            const result = await post(service, {
                path: bound(RETRY_PATH, run.correlationId),
                // The shared `attempt` member is missing, so the body never reaches
                // the operation — which is exactly why the row is this module's job.
                body: { correlationId: run.correlationId },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).code).toBe(VALIDATION);
            const refusals = await rowsOf(REFUSED_ROW);
            expect(refusals).toHaveLength(1);
            expect(refusals[0]).toMatchObject({
                operation: 'retry',
                code: VALIDATION,
                priorState: 'pending',
                attempt: 1,
            });
        }
    });

    it('keeps 404 unknown-run row-free, because there is no run to name', async () => {
        {
            const service = await startSeededService();

            const result = await post(service, {
                path: bound(RETRY_PATH, UNSEEDED_RUN_ID),
                body: { correlationId: UNSEEDED_RUN_ID, attempt: 1 },
            });

            expect(result.status).toBe(404);
            expect(errorOf(result.json).code).toBe('unknown-run');
            expect(await rowsOf(REFUSED_ROW)).toHaveLength(0);
        }
    });

});

describe('T-043h §7 and §8 never require attempt', () => {
    it('accepts a requeue and a resolve whose bodies omit it', async () => {
        const service = await startSeededService();
        const dead = await driveTo(50, DEAD_LETTERED);
        const wedged = await driveTo(51, 'unconfirmed');

        const requeue = await post(service, {
            path: bound(REQUEUE_PATH, dead.correlationId),
            body: { correlationId: dead.correlationId, confirm: true },
        });
        const resolve = await post(service, {
            path: bound(RESOLVE_PATH, wedged.correlationId),
            body: { correlationId: wedged.correlationId, decision: NO_SESSION, note: 'checked the session list' },
        });

        // Contract §7 and §8 write neither request shape with an attempt member;
        // requiring one would be a wire change the contract does not ask for.
        expect(requeue.status).not.toBe(422);
        expect(resolve.status).not.toBe(422);
        expect(requeue.status).toBe(200);
        expect(resolve.status).toBe(200);
    });
});

describe('T-043e an over-long optional free-text member is refused, not dropped', () => {
    it('refuses an over-long causeReport on a retry, naming the field', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(40, 'failed');

            const result = await post(service, {
                path: bound(RETRY_PATH, run.correlationId),
                body: { correlationId: run.correlationId, attempt: 1, causeCleared: true, causeReport: OVER_LONG_TEXT },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).message).toContain('causeReport');
            // A truncation stored as the whole cause is the dishonest direction:
            // nothing moved, and the panel is told which member was too long.
            expect(await readRun(run.correlationId).then((found) => found.state)).toBe('failed');
        }
    });

    it('refuses an over-long note on a resolve, naming the field', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(41, 'unconfirmed');

            const result = await post(service, {
                path: bound(RESOLVE_PATH, run.correlationId),
                body: { correlationId: run.correlationId, decision: NO_SESSION, note: OVER_LONG_TEXT },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).message).toContain('note');
            expect(await readRun(run.correlationId).then((found) => found.state)).toBe('unconfirmed');
        }
    });

    it('refuses over-long guidance on a block report, naming the field', async () => {
        {
            const service = await startSeededService();
            const { run, leaseId } = await driveAndClaim(42);

            const result = await post(service, {
                path: bound(BLOCKED_PATH, run.correlationId),
                body: {
                    correlationId: run.correlationId,
                    attempt: 1,
                    leaseId,
                    blockedReason: 'project-missing',
                    detail: 'prj_42 is not registered',
                    guidance: OVER_LONG_TEXT,
                },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).message).toContain('guidance');
            expect(await readRun(run.correlationId).then((found) => found.state)).toBe('claimed');
        }
    });

    it('refuses an over-long observedAgent on a verification, naming the field', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(43, 'dispatched');

            const result = await post(service, {
                path: bound(VERIFICATION_PATH, run.correlationId),
                body: {
                    correlationId: run.correlationId,
                    attempt: 1,
                    sessionId: SEEDED_SESSION,
                    expectedAgent: PROBE_AGENT,
                    observedAgent: OVER_LONG_TEXT,
                    baselineProvenance: 'configured',
                },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).message).toContain('observedAgent');
        }
    });

    it('accepts a blank baseline, and still refuses an absent one (002 FR-029 as amended)', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(48, 'dispatched');

            const blank = await post(service, {
                path: bound(VERIFICATION_PATH, run.correlationId),
                body: {
                    correlationId: run.correlationId,
                    attempt: 1,
                    sessionId: SEEDED_SESSION,
                    expectedAgent: '',
                    observedAgent: PROBE_AGENT,
                    baselineProvenance: 'unset',
                    ok: false,
                    note: 'no baseline is configured, so nothing was compared',
                },
            });

            // A blank baseline is a real answer — *no baseline configured* — so
            // the report files with the absence stored instead of being refused
            // as a missing member.
            expect(blank.status).toBe(200);
            expect(await readRun(run.correlationId).then((found) => found.verification)).toMatchObject({
                observedAgent: PROBE_AGENT,
                expectedAgent: '',
                ok: false,
            });

            const missing = await post(service, {
                path: bound(VERIFICATION_PATH, run.correlationId),
                body: { correlationId: run.correlationId, attempt: 1, sessionId: SEEDED_SESSION },
            });

            // The member itself stays required: the whole-document rule 006
            // FR-100(b) states for the config is the same rule the body keeps.
            expect(missing.status).toBe(422);
            expect(errorOf(missing.json).message).toContain('expectedAgent');
        }
    });

    it('refuses a baseline provenance that is missing or contradicts its own baseline', async () => {
        {
            // The provenance is the reason an `agent.uncompared` row can say
            // *why* nothing was compared (002 FR-029 case (ii); contract §5 as
            // 003 v1.7.0 widens it), so a report that skips it — or that sends
            // one its own `expectedAgent` disproves — is refused naming the
            // field rather than filed with a plausible-looking guess.
            const service = await startSeededService();
            const run = await driveTo(49, 'dispatched');
            const common = { correlationId: run.correlationId, attempt: 1, sessionId: SEEDED_SESSION };
            const path = bound(VERIFICATION_PATH, run.correlationId);

            const absent = await post(service, {
                path,
                body: { ...common, expectedAgent: '', observedAgent: PROBE_AGENT, ok: false },
            });

            expect(absent.status).toBe(422);
            expect(errorOf(absent.json).message).toContain('baselineProvenance');

            const contradicted = await post(service, {
                path,
                body: {
                    ...common,
                    expectedAgent: '',
                    observedAgent: PROBE_AGENT,
                    baselineProvenance: 'configured',
                    ok: false,
                },
            });

            expect(contradicted.status).toBe(422);
            expect(errorOf(contradicted.json).message).toContain('baselineProvenance');
            // Neither report half-applied: nothing was recorded at all.
            expect(await readRun(run.correlationId).then((found) => found.verification)).toBeNull();
        }
    });

});

describe('T-043f sessionId takes only the host-shaped, bounded form', () => {
    it('refuses a result whose sessionId is not a host id', async () => {
        {
            const service = await startSeededService();
            const { run } = await driveAndClaim(44);

            const result = await post(service, {
                path: bound(DISPATCHED_PATH, run.correlationId),
                body: {
                    correlationId: run.correlationId,
                    attempt: 1,
                    dispatchToken: UNKNOWN_TOKEN,
                    sessionId: UNHOSTLY_SESSION,
                },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).message).toContain('sessionId');
            // The id is echoed into the run's state reason, its attempt record, and
            // audit details, so it is refused where it enters rather than stored.
            expect(await readRun(run.correlationId).then((found) => found.state)).toBe('claimed');
            expect(await readRun(run.correlationId).then((found) => found.session)).toBeNull();
        }
    });

    it('refuses a resolve naming a session the host would never mint', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(45, 'unconfirmed');

            const result = await post(service, {
                path: bound(RESOLVE_PATH, run.correlationId),
                body: { correlationId: run.correlationId, decision: 'session-created', sessionId: UNHOSTLY_SESSION },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).message).toContain('sessionId');
            expect(await readRun(run.correlationId).then((found) => found.state)).toBe('unconfirmed');
        }
    });

    it('refuses a verification whose sessionId is well-formed but unbounded', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(46, 'dispatched');

            const result = await post(service, {
                path: bound(VERIFICATION_PATH, run.correlationId),
                body: {
                    correlationId: run.correlationId,
                    attempt: 1,
                    sessionId: `ses_${'x'.repeat(200)}`,
                    expectedAgent: PROBE_AGENT,
                },
            });

            expect(result.status).toBe(422);
            expect(errorOf(result.json).message).toContain('sessionId');
        }
    });

    it('accepts the host-shaped id the read-back actually carries', async () => {
        {
            const service = await startSeededService();
            const run = await driveTo(47, 'dispatched');

            const result = await post(service, {
                path: bound(VERIFICATION_PATH, run.correlationId),
                body: {
                    correlationId: run.correlationId,
                    attempt: 1,
                    sessionId: SEEDED_SESSION,
                    expectedAgent: PROBE_AGENT,
                    observedAgent: PROBE_AGENT,
                    baselineProvenance: 'configured',
                    ok: true,
                },
            });

            expect(result.status).toBe(200);
            expect(result.json.auditWritten).toBe(true);
            expect(result.json.state).toBe('dispatched');
        }
    });

});

describe('T-043g the only authorization path left is the routed one', () => {
    it('keeps the run store free of token minting and terminal transitions', async () => {
        {
            const source = await readFile(new URL('../service/poll/runs.ts', import.meta.url), 'utf8');

            // The un-routed second minting site this wave deleted: one import away
            // from re-creating the bypass, and `applyResult` there had no token
            // check at all.
            expect(source).not.toMatch(
                /export async function (reserveRun|applyResult|abandonRun|blockRun|retryRun|requeueRun|resolveRun)\b/,
            );
            expect(source).not.toMatch(/from '\.\/run-key\.ts'/);
        }
    });

    it('retires the legacy queue mutations the run routes replaced', async () => {
        {
            const source = await readFile(new URL('../service/poll/events.ts', import.meta.url), 'utf8');

            expect(source).not.toMatch(/export async function (markEventDispatched|retryEvent)\b/);
        }
    });

});
