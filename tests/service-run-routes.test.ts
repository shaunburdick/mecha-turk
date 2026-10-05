/**
 * The route table after 003 Wave 3 (T-015).
 *
 * Eight new operations were registered under the shared `/v1/events/:correlationId/`
 * prefix, and a route that exists but is unreachable is worse than one that does
 * not exist: a panel would see `404` for a capability the contract promises and
 * have no way to tell a wiring gap from a stale run. So this suite asserts the
 * table from **outside**, through the real loopback service, on four properties:
 *
 * - **Every registered path answers its own method** — not `404`, not `405`,
 *   and never a `500` from a route that threw on a path it does not handle.
 *   Each probe carries the body that operation's contract section names, so the
 *   handler actually runs: a well-formed id plus an under-specified body would
 *   answer `422` and prove only that the body was rejected.
 * - **A wrong method is `405` with an `Allow` header** covering the declared
 *   method, which is what the pipeline's exact-before-parameterised matching buys.
 * - **An unknown path is `404 not-found`**, and a path that looks like a run path
 *   but carries a non-minted id is `404 unknown-run` — a distinct code, because
 *   "this run is gone" and "no such route" are different facts for the operator.
 * - **Authentication runs before routing, unchanged.** A missing or wrong bearer
 *   is the same byte-identical `401` on a real path and an invented one, so no
 *   registered route can be probed for existence without the token (contract §3
 *   invariant 1).
 *
 * Offline: a temp data directory per instance, no network, no host, no sleeping.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ABANDON_PATH, BLOCKED_PATH, DISPATCHED_PATH, RESERVE_PATH } from '../service/routes/dispatch.ts';
import {
    REQUEUE_PATH,
    RESOLVE_PATH,
    RETRY_PATH,
    VERIFICATION_PATH,
} from '../service/routes/run-ops.ts';
import { EVENTS_PATH, EVENTS_PENDING_PATH } from '../service/routes/events.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { blockDispatch } from '../service/poll/dispatch-block.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import { requeueDispatch, resolveDispatch, retryDispatch } from '../service/poll/run-operate.ts';
import { recordVerification } from '../service/poll/run-verify.ts';
import { createLogger } from '../service/log.ts';
import { openStore } from '../service/store/index.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Bearer prefix every request below carries. */
const BEARER = 'Bearer ';

/** A method no route declares, for the `405` assertions. */
const WRONG_METHOD = 'PATCH';

/**
 * A correlation id in the shape this build mints — 24 hex characters after the
 * `mt-run-` prefix — with no such run seeded behind it.
 *
 * The length matters more than it looks: `pathCorrelationId` refuses anything
 * that is not exactly this shape *before* the route runs, so a longer id would
 * turn every probe below into an assertion about the path guard rather than
 * about the route table this suite exists to check.
 */
const RUN_ID = 'mt-run-0f1e2d3c4b5a69788796a5b4';

/** A different run in the same shape, for the echo-contradiction probe. */
const OTHER_RUN_ID = `mt-run-${'1'.repeat(24)}`;

/** A well-formed lease id, for the operations that take one. */
const FIXTURE_LEASE = `lse-${'a'.repeat(24)}`;

/** A well-formed dispatch token, for the operations that take one. */
const FIXTURE_TOKEN = `dtk-${'a'.repeat(32)}`;

/** The agent name every verification probe reports, matching or not. */
const PROBE_AGENT = 'project-manager';

/** The code a run-scoped route answers for an id this service does not hold. */
const UNKNOWN_RUN = 'unknown-run';

/** The code a missing route answers with, which is a different fact. */
const NOT_FOUND = 'not-found';

/** The header carrying a JSON body, spelled as HTTP requires it. */
const CONTENT_TYPE_HEADER = 'content-type';

/** Headers for a request carrying a JSON body. */
function jsonHeaders(): Record<string, string> {
    return { [CONTENT_TYPE_HEADER]: 'application/json' };
}

/**
 * Read the code out of a response's documented error envelope, without trusting it.
 *
 * @param response - Response whose body should be read.
 * @returns The envelope's code, or an empty string when it carries none.
 */
async function codeOf(response: Response): Promise<string> {
    const body = (await response.json()) as { error?: { code?: string } };

    return body.error?.code ?? '';
}

/** One Wave-3 operation: its name, its path, and the body its contract names. */
interface OperationFixture {
    /** The operation's name, for the test title and the failure message. */
    readonly name: string;
    /** The route's declared pattern. */
    readonly path: string;
    /** A body that gets this operation past its own validation. */
    readonly body: Readonly<Record<string, unknown>>;
}

/** One Wave-3 operation bound to the unreadable store, for the `503` probes. */
interface StorageProbe {
    /** The operation's name, for the failure message. */
    readonly name: string;
    /** The call itself. */
    readonly run: () => Promise<unknown>;
}

/** The eight run-scoped operations Wave 3 registered, in contract order. */
const RUN_OPERATIONS: readonly OperationFixture[] = [
    { name: 'reserve', path: RESERVE_PATH, body: { leaseId: FIXTURE_LEASE } },
    { name: 'result', path: DISPATCHED_PATH, body: { dispatchToken: FIXTURE_TOKEN, sessionId: 'ses_probe' } },
    { name: 'abandon', path: ABANDON_PATH, body: { dispatchToken: FIXTURE_TOKEN, reason: 'probe' } },
    {
        name: 'block report',
        path: BLOCKED_PATH,
        body: { leaseId: FIXTURE_LEASE, blockedReason: 'project-missing', detail: 'probe' },
    },
    { name: 'retry', path: RETRY_PATH, body: {} },
    { name: 'requeue', path: REQUEUE_PATH, body: { confirm: true } },
    { name: 'resolve', path: RESOLVE_PATH, body: { decision: 'no-session' } },
    {
        name: 'verification',
        path: VERIFICATION_PATH,
        body: { sessionId: 'ses_probe', expectedAgent: PROBE_AGENT, baselineProvenance: 'configured' },
    },
];

/** The read-only routes a panel polls, kept here so the table reads whole. */
const READ_ROUTES: readonly { readonly name: string; readonly method: string; readonly path: string }[] = [
    { name: 'events history', method: 'GET', path: EVENTS_PATH },
    { name: 'claim', method: 'GET', path: EVENTS_PENDING_PATH },
    { name: 'audit read', method: 'GET', path: AUDIT_PATH },
];

/**
 * Every Wave-3 operation, bound to one store handle and logger.
 *
 * Each is invoked once so the `503` assertion covers all eight rather than
 * proving the first and inferring the rest: the storage requirement is a
 * property of the read every operation performs, and "the others do too" is the
 * assumption this list exists to remove. The callables take the store and the
 * logger as arguments rather than closing over module state, so this fixture
 * reads the same way before and after the suites that start a service.
 *
 * @param store - The store holding the unreadable run document.
 * @param log - Logger the operations report through.
 * @returns The bound operations.
 */
function storageProbes(store: ServiceStore, log: ServiceLogger): readonly StorageProbe[] {
    const base = { store, log, correlationId: RUN_ID };

    return [
        { name: 'reserve', run: () => reserveDispatch({ ...base, leaseId: FIXTURE_LEASE, attempt: 1 }) },
        {
            name: 'result',
            run: () => reportDispatch({
                ...base,
                dispatchToken: FIXTURE_TOKEN,
                attempt: 1,
                operation: 'result',
                outcome: { attemptOutcome: 'dispatched', sessionId: 'ses_probe', reason: null },
            }),
        },
        {
            name: 'abandon',
            run: () => reportDispatch({
                ...base,
                dispatchToken: FIXTURE_TOKEN,
                attempt: 1,
                operation: 'abandon',
                outcome: { attemptOutcome: 'abandoned', sessionId: null, reason: 'probe' },
            }),
        },
        {
            name: 'block',
            run: () => blockDispatch({
                ...base,
                leaseId: FIXTURE_LEASE,
                attempt: 1,
                blockedReason: 'project-missing',
                detail: 'probe',
                guidance: null,
            }),
        },
        {
            name: 'retry',
            run: () => retryDispatch({ ...base, attempt: 1, causeCleared: true, causeReport: null }),
        },
        { name: 'requeue', run: () => requeueDispatch(base) },
        {
            name: 'resolve',
            run: () => resolveDispatch({
                ...base,
                decision: 'no-session',
                sessionId: null,
                note: null,
                guidance: null,
            }),
        },
        {
            name: 'verification',
            run: () => recordVerification({
                ...base,
                attempt: 1,
                sessionId: 'ses_probe',
                observedAgent: PROBE_AGENT,
                expectedAgent: PROBE_AGENT,
                baselineProvenance: 'configured',
                ok: true,
                note: null,
            }),
        },
    ];
}

let running: TestService | null = null;

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    if (running === null) {
        return;
    }

    await running.shutdown();
    running = null;
});

/**
 * Start a service instance and register it for cleanup.
 *
 * @returns The running harness instance.
 */
async function startServiceForTest(): Promise<TestService> {
    const service = await startTestService();
    running = service;

    return service;
}

/**
 * The concrete path one run-scoped operation answers on.
 *
 * @returns The same path with the parameter bound to {@link RUN_ID}.
 */
function bound(pattern: string): string {
    return pattern.replace(':correlationId', () => RUN_ID);
}

/**
 * The body one operation's handler needs, plus the shared run identity.
 *
 * @param operation - The operation whose contract section supplies the members.
 * @returns The body to post to {@link bound}'s path.
 */
function bodyFor(operation: OperationFixture): Record<string, unknown> {
    return { correlationId: RUN_ID, attempt: 1, ...operation.body };
}

describe('T-015 every wave-3 route is registered and answers its method', () => {
    it('serves every operation on its own path, and refuses a wrong method with 405 and Allow', async () => {
        {
            const service = await startServiceForTest();

            for (const operation of RUN_OPERATIONS) {
                // Not 404 (unregistered), not 405 (wrong method), not 422 (a body
                // that never reached the operation), and not 500 (a handler that
                // threw on a path it does not own). The body is the one §1–§8 name
                // for this operation, so the handler runs to its own first verdict:
                // the route exists, the run does not, and `404 unknown-run` is the
                // honest answer the contract names.
                const served = await service.call(bound(operation.path), {
                    method: 'POST',
                    headers: jsonHeaders(),
                    body: JSON.stringify(bodyFor(operation)),
                });
                expect(served.status, `${operation.name} must answer POST on ${operation.path}`).toBe(404);
                expect(await codeOf(served), `${operation.name} must answer unknown-run`).toBe(UNKNOWN_RUN);

                const wrong = await service.call(bound(operation.path), { method: WRONG_METHOD });
                expect(wrong.status, `${operation.name} must refuse ${WRONG_METHOD} with 405`).toBe(405);
                expect(wrong.headers.get('allow'), `${operation.name} Allow header`).toBe('POST');
                expect(await codeOf(wrong), `${operation.name} must answer method-not-allowed`)
                    .toBe('method-not-allowed');
            }
        }
    });

    it('runs every handler, not just the path guard', async () => {
        {
            const service = await startServiceForTest();

            // The decisive signal that a route is wired to a real handler: with a
            // well-formed path id whose body echo *contradicts* it, the shared
            // run-scope validation answers `422` naming `correlationId`. The path
            // guard would have answered `404 unknown-run` before ever reading the
            // body, so this cannot pass on a registration gap.
            for (const operation of RUN_OPERATIONS) {
                const response = await service.call(bound(operation.path), {
                    method: 'POST',
                    headers: jsonHeaders(),
                    body: JSON.stringify({ ...bodyFor(operation), correlationId: OTHER_RUN_ID }),
                });
                const body = (await response.json()) as {
                    error?: { code?: string; issues?: readonly { readonly field?: string }[] };
                };

                expect(response.status, `${operation.name} must reach its own validation`).toBe(422);
                expect(body.error?.code).toBe('validation');
                expect(body.error?.issues?.map((issue) => issue.field)).toContain('correlationId');
            }
        }
    });

    it('still serves the read-only event routes after the wave-3 registrations', async () => {
        {
            const service = await startServiceForTest();

            for (const route of READ_ROUTES) {
                const response = await service.call(route.path, { method: route.method });

                expect(response.status, `${route.name} must still answer`).toBe(200);
            }
        }
    });

    it('keeps a wrong method on a literal route answered by its own methods', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call(EVENTS_PATH, { method: WRONG_METHOD });

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET');
        }
    });

    it('prefers a literal route over a parameterised sibling', async () => {
        {
            const service = await startServiceForTest();

            // `/v1/events/pending` is a literal GET; the run-scoped patterns are
            // three segments deep and cannot match it. This asserts the collision the
            // pipeline's exact-before-parameterised rule exists to prevent.
            const response = await service.call(EVENTS_PENDING_PATH, { method: 'GET' });

            expect(response.status).toBe(200);
        }
    });

});

describe('T-015 unknown paths and unrecognised run ids are distinct', () => {
    it('answers an invented path with 404 not-found', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call('/v1/events/does-not-exist', { method: 'POST' });

            expect(response.status).toBe(404);
            expect(await codeOf(response)).toBe(NOT_FOUND);
        }
    });

    it('answers an unknown verb under the run prefix with 404, not 405', async () => {
        {
            const service = await startServiceForTest();

            // Only the eight registered verbs exist under the prefix; an invented one
            // has no route at all, so it is a missing route rather than a wrong method.
            const response = await service.call(`${bound(RESERVE_PATH)}/invented`, { method: 'POST' });

            expect(response.status).toBe(404);
            expect(await codeOf(response)).toBe(NOT_FOUND);
        }
    });

    it('answers a well-formed but unseeded run id with unknown-run, naming the distinction', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call(bound(RETRY_PATH), {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({ correlationId: RUN_ID, attempt: 1 }),
            });

            expect(response.status).toBe(404);
            // Two different 404s: `not-found` means no such route, `unknown-run` means
            // the route ran and the run is gone. Collapsing them would tell a panel
            // its run never existed when it was evicted.
            expect(await codeOf(response)).toBe(UNKNOWN_RUN);
        }
    });

    it('answers a delivery id on a run-scoped path with unknown-run', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call(RETRY_PATH.replace(':correlationId', 'evt-acme~widget~9~77331'), {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({ attempt: 1 }),
            });

            expect(response.status).toBe(404);
            expect(await codeOf(response)).toBe(UNKNOWN_RUN);
        }
    });

});

describe('T-015 authentication runs before routing, unchanged', () => {
    const probes: readonly { readonly name: string; readonly method: string; readonly path: string }[] = [
        ...RUN_OPERATIONS.map((operation) => ({
            name: operation.name,
            method: 'POST',
            path: bound(operation.path),
        })),
        ...READ_ROUTES,
    ];

    it('refuses every run and read route with a missing or wrong token, byte-identically', async () => {
        {
            const service = await startServiceForTest();

            for (const probe of probes) {
                const missing = await fetch(`${service.baseUrl}${probe.path}`, { method: probe.method });
                const wrong = await fetch(`${service.baseUrl}${probe.path}`, {
                    method: probe.method,
                    headers: { authorization: `${BEARER}wrong-wrong-wrong-wrong` },
                });

                expect(missing.status, `${probe.name} must refuse a missing token`).toBe(401);
                expect(wrong.status, `${probe.name} must refuse a wrong token`).toBe(401);
                // Byte-identical across both, and across every route: no route oracle.
                expect(await wrong.text(), `${probe.name} refusal body must match`).toBe(await missing.text());
            }
        }
    });

    it('answers an invented path with the same 401 a real one gets', async () => {
        {
            const service = await startServiceForTest();
            const invented = await fetch(`${service.baseUrl}/v1/events/not-a-route`, { method: 'POST' });
            const real = await fetch(`${service.baseUrl}${bound(RESERVE_PATH)}`, { method: 'POST' });

            expect(invented.status).toBe(401);
            expect(await invented.text()).toBe(await real.text());
        }
    });

});

describe('T-015 an unreadable run document surfaces as storage-unavailable', () => {
    it('raises the store error the pipeline maps to 503, not a 500', async () => {
        // `readRunsDocument` throws `StorageUnavailableError`, which the pipeline
        // maps to `503 storage-unavailable`. The constraint is about the *type*
        // reaching the transport: a `500` would read as "the service is broken"
        // and invite a retry, while this reads as "this store cannot serve run
        // state" — which is the truth, and is why serving `[]` is the answer
        // constitution II forbids.
        //
        // The probe goes through the operation rather than HTTP because the boot
        // sweep reads the document first and *quarantines* the corrupt bytes; a
        // later request then finds a healthy store with nothing in it, which is a
        // different (and correct) answer. The mapping itself is asserted in the
        // pipeline's own suite.
        const root = await mkdtemp(join(tmpdir(), 'mecha-turk-routes-'));
        const dataDir = join(root, 'store');
        await mkdir(dataDir, { recursive: true });
        await writeFile(join(dataDir, 'runs.json'), '{ not json at all', 'utf8');
        const store = await openStore({ dataDir });
        // A sink that keeps what it is given rather than an empty callback, which
        // the lint rules (rightly) refuse to read as deliberate.
        const logLines: string[] = [];
        const log = createLogger({ level: 'error', sink: (line) => void logLines.push(line) });

        for (const probe of storageProbes(store, log)) {
            await expect(
                probe.run(),
                `${probe.name} must refuse an unreadable run document`,
            ).rejects.toMatchObject({ name: 'StorageUnavailableError', code: 'storage-unavailable' });
        }
    });
});
