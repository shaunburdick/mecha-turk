/**
 * T014: the engine-delivery pass end to end against the T001 fake —
 * admission, the closed classification, the ladder and its no-rung classes,
 * the intent→receipt write order, restart reconciliation, the invariant-10
 * request log, and the SessionRef.directory store round trip (009 FR-104
 * span C; FR-105 spans D/E).
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BEGIN_UNTRUSTED, END_UNTRUSTED } from '../src/context-blocks.ts';
import { CONTEXT_MAX_CHARS } from '../src/session.ts';
import { readAuditEntries } from '../service/audit.ts';
import { EVENTS_FILE, createEvent, enqueueEvents, readEvents } from '../service/poll/events.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { MANAGED_REGISTRY_ENV } from '../service/engine/discovery.ts';
import { PASSWORD_ENV } from '../service/engine/token.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import { appendEngineAuditRow, runEngineDeliveryPass } from '../service/poll/engine-delivery.ts';
import { writeEngineMember } from '../service/poll/engine-state.ts';
import { projectRunHistory } from '../service/poll/run-history-project.ts';
import { parseSession } from '../service/poll/runs-parts-parse.ts';
import { RUNS_FILE, previewRunsDocument } from '../service/poll/runs-document.ts';
import { createLogger } from '../service/log.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot, QueuedEvent } from '../service/poll/events.ts';
import type { EngineDeliveryDeps } from '../service/poll/engine-delivery.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { Run } from '../service/poll/runs-types.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { makeTempTree, removeTempTree } from './support/temp-tree.ts';
import { startFakeOpenCode, writeManagedRegistry } from './support/opencode-engine.ts';
import { assignmentSnapshot } from './support/event-snapshot.ts';
import { writeOpenBinding } from './support/binding-fixture.ts';
import type { FakeOpenCode, PromptOutcome, SessionFixture } from './support/opencode-engine.ts';

/** Binding id every fixture detection names. */
const BINDING_ID = 'bnd-engine';

/** Repository every fixture detection names. */
const REPOSITORY = 'acme/engine';

/** Account every fixture detection is about. */
const ACCOUNT_ID = '77331';

/** Session the seeded run's dispatch produced. */
const SESSION_ID = 'ses_engine_delivery';

/** The dispatch-reported directory the run persists and the pre-check compares. */
const SESSION_DIR = '/workspace/checkouts/acme-engine';

/** Detection stamp every fixture carries. */
const STAMP = '2026-10-10T00:00:00.000Z';

/** The injected clock every intent stamp takes. */
const FIXED_NOW_MS = 1_760_000_000_000;

/** The engine fixture carrying both pre-check members. */
function ownedSession(): SessionFixture {
    return {
        id: SESSION_ID,
        location: { directory: SESSION_DIR },
        metadata: { openchamber: { provider: 'openchamber' } },
    };
}

/** A follow-up comment detection on a subject whose run already exists. */
function followUpComment(issueNumber: number, commentId: number, title = `Issue ${issueNumber}`): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'mention',
        followUp: 'comment',
        commentId,
        subjectType: 'issue',
        issue: {
            issueNumber,
            issueTitle: title,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${issueNumber}`,
            issueBodyExcerpt: `a new comment arrived on issue ${issueNumber}`,
        },
        actorLogin: 'bob',
        actorAttribution: 'direct',
        triggerNote: 'comment fixture',
        detectedAt: STAMP,
    };
}

let tempRoot = '';
let registryDir = '';
let store: ServiceStore;
let log: ServiceLogger;
let logLines: string[];
let sleeps: number[];
let issueCounter = 500;
let fakes: FakeOpenCode[];

beforeEach(async () => {
    tempRoot = await makeTempTree('engine-delivery');
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    logLines = [];
    sleeps = [];
    fakes = [];
    issueCounter = 500;
    log = createLogger({ level: 'debug', sink: (line) => void logLines.push(line) });
    await writeOpenBinding({
        store,
        bindingId: BINDING_ID,
        options: { repository: REPOSITORY, accountNumericUserId: ACCOUNT_ID },
    });
    registryDir = await mkdtemp(join(tmpdir(), 'mecha-turk-engine-registry-'));
});

afterEach(async () => {
    for (const fake of fakes) {
        await fake.shutdown();
    }

    await rm(registryDir, { recursive: true, force: true });
    await removeTempTree(tempRoot);
});

/** Start a fake, track it for teardown, point the discovery seam at it, and seed the owned session. */
async function engine(options: Parameters<typeof startFakeOpenCode>[0] = {}): Promise<{ fake: FakeOpenCode }> {
    const fake = await startFakeOpenCode({ sessions: [ownedSession()], ...options });
    fakes.push(fake);
    await writeManagedRegistry(registryDir, fake.registryEntry());

    return { fake };
}

/** The environment one pass runs under: the registry override plus the engine password. */
function engineEnv(fake: FakeOpenCode): Readonly<Record<string, string | undefined>> {
    return { [MANAGED_REGISTRY_ENV]: registryDir, [PASSWORD_ENV]: fake.password };
}

/** The pass's default deps; a test overrides only what it subjects. */
function passDeps(
    env: Readonly<Record<string, string | undefined>>,
    over: Partial<EngineDeliveryDeps> = {},
): EngineDeliveryDeps {
    return {
        store,
        log,
        retry: { maxAttempts: 3, baseMs: 1, maxMs: 4 },
        env,
        sleep: async () => void sleeps.push(1),
        timeoutMs: 200,
        now: () => FIXED_NOW_MS,
        ...over,
    };
}

/** One seeded run with a session and one follow-up row linked to it. */
async function seedDispatchedFollowUp(
    directory?: string,
    title?: string,
): Promise<{ correlationId: string; deliveryId: string }> {
    const issueNumber = issueCounter;
    issueCounter += 1;
    await enqueueEvents({
        store,
        log,
        incoming: [createEvent(assignmentSnapshot(issueNumber, {
            bindingId: BINDING_ID,
            repository: REPOSITORY,
            accountNumericUserId: ACCOUNT_ID,
        }))],
    });
    const claimed = await claimPendingRuns({ store, log, holder: 'harness' });
    const offered = claimed.runs[0];
    if (offered === undefined) {
        throw new Error('the seeded run was not claimable');
    }

    const reserved = await reserveDispatch({
        store,
        log,
        correlationId: offered.correlationId,
        leaseId: offered.lease.leaseId,
        attempt: offered.attempt,
    });
    if (reserved.status !== 'applied') {
        throw new Error(`reserve answered ${reserved.status}`);
    }

    const reported = await reportDispatch({
        store,
        log,
        correlationId: offered.correlationId,
        dispatchToken: reserved.dispatchToken,
        attempt: offered.attempt,
        operation: 'result',
        outcome: {
            attemptOutcome: 'dispatched',
            sessionId: SESSION_ID,
            reason: null,
            ...(directory !== undefined && { directory }),
        },
    });
    if (reported.status !== 'applied') {
        throw new Error(`result report answered ${reported.status}`);
    }

    const followUp = createEvent(followUpComment(issueNumber, 9_000 + issueNumber, title));
    await enqueueEvents({ store, log, incoming: [followUp] });

    return { correlationId: offered.correlationId, deliveryId: followUp.id };
}

/** The stored queue row one delivery owns, or `null` when the queue lost it. */
async function queuedRow(deliveryId: string): Promise<QueuedEvent | null> {
    const queue = await readEvents({ store, log });

    return queue.find((row) => row.id === deliveryId) ?? null;
}

/** The audit rows one event type recorded, in file order. */
async function auditRowsOf(eventType: string): Promise<readonly AuditEntry[]> {
    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === eventType);
}

/** How many prompt requests reached the fake. */
function promptRequests(fake: FakeOpenCode): number {
    return fake.requests.filter((request) => request.method === 'POST').length;
}

/** The runs document as stored, for the projection and the directory round trip. */
async function storedRuns(): Promise<readonly Run[]> {
    const document = await previewRunsDocument({ store, log });

    return document.runs;
}

/** One stored run by correlation id, or `null` when the document lost it. */
async function storedRunOf(correlationId: string): Promise<Run | null> {
    const runs = await storedRuns();

    return runs.find((run) => run.correlationId === correlationId) ?? null;
}

describe('the engine path admits one follow-up, exactly once (AC-050 engine span)', () => {
    it('one pre-check GET, one admission POST, the receipt persisted, and the row projects engine-queued', async () => {
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts).toEqual({ considered: 1, admitted: 1, unavailable: 0, unknown: 0 });
        expect(fake.requests.filter((request) => request.path.startsWith('/api/session/'))).toHaveLength(2);
        expect(promptRequests(fake), 'exactly one admission POST').toBe(1);
        const prompt = fake.requests.find((request) => request.method === 'POST');
        const body = JSON.parse(prompt?.body ?? '{}') as Record<string, unknown>;
        expect(body.delivery, 'the flat body carries the queue mode').toBe('queue');
        expect(typeof body.text).toBe('string');

        const row = await queuedRow(seeded.deliveryId);
        expect(row?.engine).toEqual({ state: 'admitted', messageId: fake.messages[0]?.id });

        const runs = await storedRuns();
        const queue = await readEvents({ store, log });
        const projected = projectRunHistory({
            runs,
            deliveries: new Map(queue.map((entry) => [entry.id, entry])),
            cap: runs.length,
            followUpsFrom: null,
        }).find((historyRow) => historyRow.id === seeded.correlationId);
        expect(projected?.followUps?.[0]?.engine).toEqual({ state: 'queued', messageId: fake.messages[0]?.id });
    });

    it('the engine-posted payload carries the attribution header, the delimiters, and the correlation id', async () => {
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);

        await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        const message = fake.messages[0];
        expect(message?.text).toContain('Mecha Turk follow-up (automated');
        expect(message?.text).toContain(BEGIN_UNTRUSTED);
        expect(message?.text).toContain(END_UNTRUSTED);
        expect(message?.text).toContain(`Correlation: ${seeded.correlationId}`);
        expect(message?.sessionId).toBe(SESSION_ID);
    });

    it('the admission row is credential-free and records the receipt', async () => {
        const { fake } = await engine();
        await seedDispatchedFollowUp(SESSION_DIR);

        await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        const [row] = await auditRowsOf('follow_up.engine_admitted');
        expect(row?.entity).toEqual({ kind: 'delivery', id: expect.any(String) });
        expect(row?.details.messageId).toBe(fake.messages[0]?.id);
        expect(row?.redaction.redacted).toBe(false);
        expect(JSON.stringify(row), 'an audit row carried the engine password').not.toContain(fake.password);
    });

    it('the admission succeeds whatever the session fixture carries: turn state is never consulted', async () => {
        // The engine admits into a busy or an idle session alike (research
        // §2.1, live-confirmed); the pass consults no lifecycle surface at all,
        // which the invariant-10 request log proves below.
        const { fake } = await engine({ sessions: [{ ...ownedSession(), time: { created: 1, updated: 2 } }] });
        await seedDispatchedFollowUp(SESSION_DIR);

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts.admitted).toBe(1);
        expect(promptRequests(fake)).toBe(1);
    });

    it('persists the intent before the POST and the receipt after it', async () => {
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);
        const engineWrites: unknown[] = [];
        const spy: ServiceStore = {
            ...store,
            writeJson: async (path, value) => {
                if (path === EVENTS_FILE) {
                    engineWrites.push(structuredClone(value));
                }

                await store.writeJson(path, value);
            },
        };

        await runEngineDeliveryPass(passDeps(engineEnv(fake), { store: spy }));

        const states = engineWrites.map((document) => {
            const rows = document as QueuedEvent[];

            return rows.find((entry) => entry.id === seeded.deliveryId)?.engine?.state ?? 'absent';
        });
        expect(states).toEqual(['unknown', 'admitted']);
        const intents = engineWrites.map((document) => {
            const rows = document as QueuedEvent[];

            return rows.find((entry) => entry.id === seeded.deliveryId)?.engine;
        });
        expect(intents[0]).toEqual({ state: 'unknown', intentAtMs: FIXED_NOW_MS, cause: 'intent' });
    });

    it('an admitted row stays in the queue carrying its state — the service never prunes (span B)', async () => {
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);

        await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        const row = await queuedRow(seeded.deliveryId);
        expect(row, 'the admitted row was pruned from the queue').not.toBeNull();
        expect(row?.engine?.state).toBe('admitted');
    });
});

describe('invariant 10 and the zero-steer bar (Gate 2 L8)', () => {
    it('the request log names only the three adapter routes — no creates, deletes, or steer', async () => {
        const { fake } = await engine();
        await seedDispatchedFollowUp(SESSION_DIR);

        await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        const named = /^\/api\/(info|session\/[^/]+(\/prompt)?)$/u;
        for (const request of fake.requests) {
            expect(named.test(request.path), `unexpected request: ${request.method} ${request.path}`).toBe(true);
            expect(request.method === 'DELETE', 'a session delete was issued').toBe(false);
            const body = request.body === ''
                ? {}
                : (JSON.parse(request.body) as Record<string, unknown>);
            const delivery = request.method === 'POST' ? body.delivery : 'queue';
            expect(delivery, 'the admission body names a mode other than queue').toBe('queue');
        }
    });

    it('the shipped service bundle carries no steer anywhere', () => {
        const bundle = readFileSync(resolve(import.meta.dirname, '..', 'service', 'main.js'), 'utf8');

        expect(bundle).not.toContain('steer');
    });
});

describe('the unknown class is terminal: zero re-POSTs, ever (Gate 2 M4)', () => {
    const cases: readonly (readonly [PromptOutcome, string])[] = [
        ['5xx', 'server-failure'],
        ['malformed-200', 'malformed-receipt'],
        ['stall', 'timeout'],
    ];

    for (const [outcome, cause] of cases) {
        it(`a ${outcome} admission settles unknown (${cause}) and is never re-sent`, async () => {
            const { fake } = await engine({ promptOutcome: outcome });
            const seeded = await seedDispatchedFollowUp(SESSION_DIR);

            const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

            expect(counts).toEqual({ considered: 1, admitted: 0, unavailable: 0, unknown: 1 });
            expect(promptRequests(fake), 'the unknown class consumed the only POST').toBe(1);
            expect(sleeps, 'an unknown outcome never runs the ladder').toHaveLength(0);
            const row = await queuedRow(seeded.deliveryId);
            expect(row?.engine).toEqual({
                state: 'unknown',
                intentAtMs: FIXED_NOW_MS,
                cause,
            });

            // Restarting the pass over the settled row changes nothing at all.
            const again = await runEngineDeliveryPass(passDeps(engineEnv(fake)));
            expect(again.considered).toBe(0);
            expect(promptRequests(fake)).toBe(1);
            expect(fake.messages, 'a duplicate message reached the session').toHaveLength(1);

            const [audit] = await auditRowsOf('follow_up.engine_unknown');
            expect(audit?.details.cause).toBe(cause);
        });
    }

    it('a permission or form stall after admission prompts nothing: the pass only ever POSTs /prompt', async () => {
        const { fake } = await engine();
        await seedDispatchedFollowUp(SESSION_DIR);

        await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        // Admission is delivery; execution is observation. Nothing is ever
        // auto-approved, so no approve/resolve-shaped call can exist — the
        // log carries exactly the three named routes and nothing else.
        const paths = fake.requests.map((request) => request.path);
        expect(paths.every((path) => /^\/api\/(info|session\/[^/]+(\/prompt)?)$/u.test(path))).toBe(true);
    });
});

describe('the closed failure classes settle exactly as classified (FR-105 span D)', () => {
    it('401 marks unavailable at once: one POST, no ladder, no token retries', async () => {
        const { fake } = await engine({ promptOutcome: '401' });
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts.unavailable).toBe(1);
        expect(promptRequests(fake)).toBe(1);
        expect(sleeps).toHaveLength(0);
        const row = await queuedRow(seeded.deliveryId);
        expect(row?.engine).toEqual({ state: 'unavailable' });
        const [audit] = await auditRowsOf('follow_up.engine_unavailable');
        expect(audit?.details.cause).toBe('unauthorized');
        expect(audit?.details.stage).toBe('prompt');
    });

    it('404 records no-session on the audit row, consumes no rung, and writes no cause member (pin 4)', async () => {
        const { fake } = await engine({ promptOutcome: '404' });
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts.unavailable).toBe(1);
        expect(promptRequests(fake), 'the 404 parks on the first refusal').toBe(1);
        expect(sleeps, 'a 404 consumes no ladder rung').toHaveLength(0);
        const storedRow = await queuedRow(seeded.deliveryId);
        const storedEngine = storedRow?.engine;
        expect(storedEngine).toEqual({ state: 'unavailable' });
        expect(Object.hasOwn(storedEngine ?? {}, 'cause'), 'the unavailable member carries no cause').toBe(false);
        const [row] = await auditRowsOf('follow_up.engine_unavailable');
        expect(row?.details.cause).toBe('no-session');
    });

    it('connection-refused runs the existing ladder, then marks unavailable — zero parks', async () => {
        const dead = await startFakeOpenCode();
        const deadPort = dead.port;
        await dead.shutdown();
        await writeManagedRegistry(registryDir, { pid: process.pid, ownerPid: process.pid, port: deadPort });
        const fake = await startFakeOpenCode({ sessions: [ownedSession()] });
        fakes.push(fake);
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts.unavailable).toBe(1);
        expect(sleeps, 'three attempts owe two waits').toHaveLength(2);
        const row = await queuedRow(seeded.deliveryId);
        expect(row?.engine).toEqual({ state: 'unavailable' });
        expect(row, 'engine-caused unavailability never parks a row out of the queue').not.toBeNull();
        const [audit] = await auditRowsOf('follow_up.engine_unavailable');
        expect(audit?.details.stage).toBe('ladder');
        expect(audit?.details.cause).toBe('connection-refused');
    });

    it('re-discovers per attempt: a connect failure invalidates the port mid-ladder', async () => {
        const dead = await startFakeOpenCode();
        const deadPort = dead.port;
        await dead.shutdown();
        await writeManagedRegistry(registryDir, { pid: process.pid, ownerPid: process.pid, port: deadPort });
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);
        // The wait between rungs is exactly when a restarted engine's new
        // per-boot port can appear; the next attempt must discover it.
        const heal = async (): Promise<void> => {
            await writeManagedRegistry(registryDir, fake.registryEntry());
        };

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake), { sleep: heal }));

        expect(counts.admitted).toBe(1);
        expect(promptRequests(fake)).toBe(1);
        const row = await queuedRow(seeded.deliveryId);
        expect(row?.engine?.state).toBe('admitted');
    });

    const noRung: readonly (readonly [string, () => Promise<{ fake: FakeOpenCode }>])[] = [
        ['a pid cross-check mismatch', async () => {
            const { fake } = await engine();
            fake.setInfo({ pid: process.pid + 2 });

            return { fake };
        }],
        ['a version outside the pin', async () => {
            const { fake } = await engine();
            fake.setInfo({ version: '1.9.9' });

            return { fake };
        }],
        ['a discovery failure', async () => {
            const { fake } = await engine();
            await rm(registryDir, { recursive: true, force: true });

            return { fake };
        }],
        ['a failed ownership pre-check', async () => {
            const foreign = { ...ownedSession(), location: { directory: '/somewhere/else' } };
            const { fake } = await engine({ sessions: [foreign] });

            return { fake };
        }],
    ];

    for (const [name, setup] of noRung) {
        it(`${name} settles unavailable with zero rungs and zero parks (Gate 2 M6)`, async () => {
            const { fake } = await setup();
            const seeded = await seedDispatchedFollowUp(SESSION_DIR);

            const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

            expect(counts.unavailable, `${name} did not settle unavailable`).toBe(1);
            expect(sleeps, `${name} consumed a ladder rung`).toHaveLength(0);
            expect(promptRequests(fake), `${name} reached an admission POST`).toBe(0);
            const row = await queuedRow(seeded.deliveryId);
            expect(row?.engine, `${name} did not carry the mark`).toEqual({ state: 'unavailable' });
            expect(row, `${name} parked the row`).not.toBeNull();
        });
    }

    it('an absent dispatch-reported directory fails safe to the fallback before any request', async () => {
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp();

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts.unavailable).toBe(1);
        expect(
            fake.requests.filter((request) => request.path !== '/api/info'),
            'the pass asked past the identity probe although it had nothing to compare',
        ).toHaveLength(0);
        const row = await queuedRow(seeded.deliveryId);
        expect(row?.engine).toEqual({ state: 'unavailable' });
        const [audit] = await auditRowsOf('follow_up.engine_unavailable');
        expect(audit?.details.stage).toBe('pre-check');
        expect(audit?.details.cause).toBe('directory-absent');
    });

    it('an over-budget composition settles compose-stage with zero engine requests (span A/E order)', async () => {
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp(SESSION_DIR, 'x'.repeat(CONTEXT_MAX_CHARS));

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts.unavailable).toBe(1);
        expect(fake.requests, 'the over-budget composition issued an engine request').toHaveLength(0);
        expect(sleeps, 'the over-budget composition consumed a ladder rung').toHaveLength(0);
        const row = await queuedRow(seeded.deliveryId);
        expect(row?.engine).toEqual({ state: 'unavailable' });
        const [audit] = await auditRowsOf('follow_up.engine_unavailable');
        expect(audit?.details.stage).toBe('compose');
        expect(audit?.details.cause).toBe('over-budget');
    });

    for (const outcome of ['400', '3xx'] as const) {
        it(`a ${outcome} admission answer is rejected-class: unavailable, one POST, no rung, audit row`, async () => {
            const { fake } = await engine({ promptOutcome: outcome });
            const seeded = await seedDispatchedFollowUp(SESSION_DIR);

            const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

            expect(counts.unavailable).toBe(1);
            expect(promptRequests(fake), `the ${outcome} answer was not the first refusal`).toBe(1);
            expect(sleeps, `the ${outcome} answer consumed a ladder rung`).toHaveLength(0);
            const row = await queuedRow(seeded.deliveryId);
            expect(row?.engine).toEqual({ state: 'unavailable' });
            const [audit] = await auditRowsOf('follow_up.engine_unavailable');
            expect(audit?.details.stage).toBe('prompt');
            expect(audit?.details.cause).toBe('rejected');
        });
    }
});

describe('restart reconciliation (FR-105 span E)', () => {
    it('an intent-without-receipt row is left unknown with zero automatic re-POSTs', async () => {
        const { fake } = await engine();
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);
        const parked = { state: 'unknown', intentAtMs: FIXED_NOW_MS, cause: 'timeout' } as const;
        await writeEngineMember({ store, deliveryId: seeded.deliveryId, engine: parked });

        const counts = await runEngineDeliveryPass(passDeps(engineEnv(fake)));

        expect(counts).toEqual({ considered: 0, admitted: 0, unavailable: 0, unknown: 0 });
        expect(fake.requests, 'a restart re-POSTed an unknown delivery').toHaveLength(0);
        const row = await queuedRow(seeded.deliveryId);
        expect(row?.engine).toEqual(parked);
    });
});

describe('the SessionRef.directory store round trip (Gate 2 HIGH A)', () => {
    it('written → re-parsed → present, absent → absent, malformed → treated absent', async () => {
        const seeded = await seedDispatchedFollowUp(SESSION_DIR);
        const present = await storedRunOf(seeded.correlationId);
        expect(present?.session?.directory, 'the written directory did not survive the re-read').toBe(SESSION_DIR);

        const absent = await seedDispatchedFollowUp();
        const withoutDirectory = await storedRunOf(absent.correlationId);
        expect(withoutDirectory?.session?.directory).toBeUndefined();
        expect(withoutDirectory?.session?.sessionId, 'the absent member must not refuse the run').toBe(SESSION_ID);

        // The regression this pins: the fixed-shape read must not silently drop
        // the key, and a malformed value must fail safe rather than quarantine.
        const raw = JSON.parse(await readFile(join(store.dataDir, RUNS_FILE), 'utf8')) as {
            readonly runs: readonly { readonly session?: Record<string, unknown> }[];
        };
        const rewritten = {
            ...raw,
            runs: raw.runs.map((run, index) => {
                if (index === 0 && run.session !== undefined) {
                    return { ...run, session: { ...run.session, directory: 42 } };
                }

                return run;
            }),
        };
        await store.writeJson(RUNS_FILE, rewritten);

        const malformed = await storedRunOf(seeded.correlationId);
        expect(malformed?.session?.directory, 'a malformed directory must read as absent').toBeUndefined();
        expect(malformed?.session?.sessionId, 'a malformed directory must not quarantine the run').toBe(SESSION_ID);
    });

    it('parseSession reads the member fail-closed on its own terms', () => {
        const base = {
            sessionId: SESSION_ID,
            attachmentId: 'mt-run-0123456789abcdef01234567',
            dispatchedAt: STAMP,
            title: '',
            sourceUrl: 'https://github.com/acme/engine/issues/1',
            worktree: null,
        };

        expect(parseSession({ ...base, directory: SESSION_DIR })?.directory).toBe(SESSION_DIR);
        expect(parseSession(base)?.directory).toBeUndefined();
        expect(parseSession({ ...base, directory: 42 })?.directory).toBeUndefined();
        expect(parseSession({ ...base, directory: null })?.directory).toBeUndefined();
    });
});

describe('the audit writer refuses secret-shaped rows (invariant 9; T015)', () => {
    it('a redaction refusal blocks the write instead of logging through it', async () => {
        const isRefused = await appendEngineAuditRow({
            store,
            log,
            correlationId: 'mt-run-0123456789abcdef01234567',
            deliveryId: 'evt-acme~engine~501~77331~followup~9501',
            eventType: 'follow_up.engine_unavailable',
            decision: 'unavailable',
            reason: 'poisoned row',
            details: { note: 'OPENCODE_SERVER_PASSWORD=canary-value-abcdef' },
        });

        expect(isRefused).toBe(false);
        const entries = await readAuditEntries(store);
        expect(entries, 'a refused row still reached the trail').toHaveLength(0);
        expect(logLines.join('\n'), 'the refusal logged the poisoned value').not.toContain('canary-value-abcdef');
        expect(logLines.join('\n')).toContain('secret-shaped content');
    });

    it('a clean row appends normally', async () => {
        const isAppended = await appendEngineAuditRow({
            store,
            log,
            correlationId: 'mt-run-0123456789abcdef01234567',
            deliveryId: 'evt-acme~engine~502~77331~followup~9502',
            eventType: 'follow_up.engine_admitted',
            decision: 'admitted',
            reason: 'receipt recorded',
            details: { messageId: 'msg_deadbeef' },
        });

        expect(isAppended).toBe(true);
        const [row] = await readAuditEntries(store);
        expect(row?.eventType).toBe('follow_up.engine_admitted');
    });
});
