/**
 * T026: the mandated pre-mortem table — one row per distinct final-word
 * outcome, each asserting the **final operator-visible word/state** through
 * the whole chain: service classification → persisted engine member →
 * projection member → panel rendering, driven through the panel's own entry
 * points (`followUpRowView` and the reason map in `src/dispatches-detail.ts`,
 * plus `waitingFollowUps` and `dispatchRow`) against the T001 fake, the real
 * service pass, and the fake host in one loop (009 AC-050/AC-051 as amended;
 * FR-104, FR-105; constitution IV). The test fails if any link of the
 * classification→word chain breaks.
 *
 * Offline by construction: a temp store, the fake OpenCode over loopback, the
 * fake panel host, no clock the test waits on (AGENTS.md).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GuestRequest, GuestRequestResult, JsonValue, SessionSnapshot } from '@openchamber/sdk';
import { createEvent, enqueueEvents, readEvents } from '../service/poll/events.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { MANAGED_REGISTRY_ENV } from '../service/engine/discovery.ts';
import { PASSWORD_ENV } from '../service/engine/token.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import { runEngineDeliveryPass } from '../service/poll/engine-delivery.ts';
import { projectRunHistory } from '../service/poll/run-history-project.ts';
import { previewRunsDocument } from '../service/poll/runs-document.ts';
import { createLogger } from '../service/log.ts';
import { openStore } from '../service/store/index.ts';
import type { QueuedEvent } from '../service/poll/events.ts';
import type { EngineDeliveryDeps } from '../service/poll/engine-delivery.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { dispatchRow } from '../src/dispatches-rows.ts';
import { followUpRowView, reofferableFollowUps, waitingFollowUps } from '../src/dispatches-detail.ts';
import { readDispatchRecord } from '../src/dispatch-record.ts';
import type { FollowUpDeliveryRecord } from '../src/dispatch-record.ts';
import { pollRelay } from '../src/relay.ts';
import { trackCurrentSession } from '../src/follow-up.ts';
import { parseEventRows } from '../src/dispatches-service.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import type { PanelHost } from '../src/session.ts';
import { makeTempTree, removeTempTree } from './support/temp-tree.ts';
import { startFakeOpenCode, writeManagedRegistry } from './support/opencode-engine.ts';
import { assignmentSnapshot } from './support/event-snapshot.ts';
import { writeOpenBinding } from './support/binding-fixture.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';
import type { FakeOpenCode, PromptOutcome } from './support/opencode-engine.ts';

/** Binding id every fixture detection names. */
const BINDING_ID = 'bnd-pre-mortem';

/** Repository every fixture detection names. */
const REPOSITORY = 'acme/engine';

/** Account every fixture detection is about. */
const ACCOUNT_ID = '77331';

/** Session the seeded run's dispatch produced — and the panel target. */
const SESSION_ID = 'ses_pre_mortem';

/** A session nothing targets: the non-current half of the fallback gate. */
const OTHER_SESSION = 'ses_elsewhere';

/** The dispatch-reported directory the run persists and the pre-check compares. */
const SESSION_DIR = '/workspace/checkouts/acme-engine';

/** Detection stamp every fixture carries. */
const STAMP = '2026-10-10T00:00:00.000Z';

/** The injected clock every intent stamp takes. */
const FIXED_NOW_MS = 1_760_000_000_000;

/** How one panel probe's prompt behaves. */
type PanelPrompt = 'sent' | 'no-session';

/** One table row: the engine outcome, and the final word the operator reads. */
interface PremortemCase {
    /** The engine-side outcome the row starts from. */
    readonly outcome: PromptOutcome | 'refused';
    /** The final operator-visible word/state this row must render. */
    readonly finalWord: string;
    /** The stored engine member the service must have persisted. */
    readonly storedEngine: Readonly<Record<string, unknown>>;
    /** Whether the stored member carries no `cause` member at all. */
    readonly storedCauseFree?: boolean;
    /** The projected member the panel must have parsed. */
    readonly projectedEngine: Readonly<Record<string, unknown>>;
    /** The session the panel's host reports as current. */
    readonly currentSession: string;
    /** How the panel's prompt behaves. */
    readonly prompt: PanelPrompt;
    /** How many fallback prompts this row owes. */
    readonly prompts: number;
    /** `followUpRowView`'s counts, as the operator's surfaces read them. */
    readonly view: {
        readonly delivered: number;
        readonly waiting: number;
        readonly engineQueued: number;
        readonly unconfirmed: number;
    };
    /** The durable record the panel's attempt must leave behind, or `null` for no write. */
    readonly record: Readonly<Record<string, unknown>> | null;
    /** Substrings the run row's follow-up line must carry — the final word. */
    readonly subtitle: readonly string[];
    /** The re-offer's offer for this row, or `null` when it offers none. */
    readonly offered: 'unconfirmed' | 'parked' | null;
}

/**
 * The table, one row per distinct final-word outcome (Gate 2 round 2):
 * connection-refused after ladder exhaustion, the `unknown` class by one
 * representative (timeout — T014 covers each cause), the no-rung `unavailable`
 * class by one representative (401), and the 404's first-refusal park.
 */
const TABLE: readonly PremortemCase[] = [
    {
        outcome: 'refused',
        finalWord: 'follow-ups: 1 waiting',
        storedEngine: { state: 'unavailable' },
        storedCauseFree: true,
        projectedEngine: { state: 'unavailable' },
        currentSession: OTHER_SESSION,
        prompt: 'sent',
        prompts: 0,
        view: { delivered: 0, waiting: 1, engineQueued: 0, unconfirmed: 0 },
        record: { parked: false, reason: 'session-busy', delivered: false },
        subtitle: ['follow-ups: 1 waiting'],
        offered: null,
    },
    {
        outcome: 'stall',
        finalWord: 'follow-ups: 1 waiting · 1 unconfirmed',
        storedEngine: { state: 'unknown', intentAtMs: FIXED_NOW_MS, cause: 'timeout' },
        projectedEngine: { state: 'unknown' },
        currentSession: SESSION_ID,
        prompt: 'sent',
        prompts: 0,
        view: { delivered: 0, waiting: 1, engineQueued: 0, unconfirmed: 1 },
        record: null,
        subtitle: ['follow-ups: 1 waiting · 1 unconfirmed'],
        offered: 'unconfirmed',
    },
    {
        outcome: '401',
        finalWord: 'follow-ups: 1 delivered',
        storedEngine: { state: 'unavailable' },
        storedCauseFree: true,
        projectedEngine: { state: 'unavailable' },
        currentSession: SESSION_ID,
        prompt: 'sent',
        prompts: 1,
        view: { delivered: 1, waiting: 0, engineQueued: 0, unconfirmed: 0 },
        record: { delivered: true, parked: false, reason: null },
        subtitle: ['follow-ups: 1 delivered'],
        offered: null,
    },
    {
        outcome: '404',
        finalWord: 'parked: no session was open for the run',
        storedEngine: { state: 'unavailable' },
        storedCauseFree: true,
        projectedEngine: { state: 'unavailable' },
        currentSession: SESSION_ID,
        prompt: 'no-session',
        prompts: 1,
        view: { delivered: 0, waiting: 0, engineQueued: 0, unconfirmed: 0 },
        record: { parked: true, reason: 'no-session', delivered: false },
        subtitle: ['parked: no session was open for the run'],
        offered: 'parked',
    },
];

let tempRoot = '';
let registryDir = '';
let store: ServiceStore;
let log: ServiceLogger;
let logLines: string[];
let sleeps: number[];
let issueCounter = 700;
let fakes: FakeOpenCode[];

beforeEach(async () => {
    tempRoot = await makeTempTree('engine-pre-mortem');
    store = await openStore({ dataDir: join(tempRoot, 'store') });
    logLines = [];
    sleeps = [];
    fakes = [];
    issueCounter = 700;
    log = createLogger({ level: 'error', sink: (line) => void logLines.push(line) });
    await writeOpenBinding({
        store,
        bindingId: BINDING_ID,
        options: { repository: REPOSITORY, accountNumericUserId: ACCOUNT_ID },
    });
    registryDir = await mkdtemp(join(tmpdir(), 'mecha-turk-pre-mortem-registry-'));
});

afterEach(async () => {
    for (const fake of fakes) {
        await fake.shutdown();
    }

    await rm(registryDir, { recursive: true, force: true });
    await removeTempTree(tempRoot);
});

/** Start a fake, track it for teardown, point the discovery seam at it, and seed the owned session. */
async function engine(options: Parameters<typeof startFakeOpenCode>[0] = {}): Promise<FakeOpenCode> {
    const fake = await startFakeOpenCode({
        sessions: [{
            id: SESSION_ID,
            location: { directory: SESSION_DIR },
            metadata: { openchamber: { provider: 'openchamber' } },
        }],
        ...options,
    });
    fakes.push(fake);
    await writeManagedRegistry(registryDir, fake.registryEntry());

    return fake;
}

/** The environment one pass runs under: the registry override plus the engine password. */
function engineEnv(fake: FakeOpenCode): Readonly<Record<string, string | undefined>> {
    return { [MANAGED_REGISTRY_ENV]: registryDir, [PASSWORD_ENV]: fake.password };
}

/** The pass's deps, under a two-rung ladder so the refused row exhausts it at once. */
function passDeps(env: Readonly<Record<string, string | undefined>>): EngineDeliveryDeps {
    return {
        store,
        log,
        retry: { maxAttempts: 2, baseMs: 1, maxMs: 4 },
        env,
        sleep: async () => void sleeps.push(1),
        timeoutMs: 200,
        now: () => FIXED_NOW_MS,
    };
}

/** One seeded run with a session and one follow-up row linked to it. */
async function seedDispatchedFollowUp(): Promise<{ readonly correlationId: string; readonly deliveryId: string }> {
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
            directory: SESSION_DIR,
        },
    });
    if (reported.status !== 'applied') {
        throw new Error(`result report answered ${reported.status}`);
    }

    const followUp = createEvent({
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'mention',
        followUp: 'comment',
        commentId: 9_000 + issueNumber,
        subjectType: 'issue',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${issueNumber}`,
            issueBodyExcerpt: `a new comment arrived on issue ${issueNumber}`,
        },
        actorLogin: 'bob',
        actorAttribution: 'direct',
        triggerNote: 'comment fixture',
        detectedAt: STAMP,
    });
    await enqueueEvents({ store, log, incoming: [followUp] });

    return { correlationId: offered.correlationId, deliveryId: followUp.id };
}

/** The stored queue row one delivery owns, or `null` when the queue lost it. */
async function queuedRow(deliveryId: string): Promise<QueuedEvent | null> {
    const queue = await readEvents({ store, log });

    return queue.find((row) => row.id === deliveryId) ?? null;
}

/** Releases a host subscription; the fake host registers nothing to release. */
function release(): void {
    // Nothing to release: the double's `onSession` fires once, synchronously.
}

/** The projected run row, round-tripped through the panel's own fail-closed parser. */
async function projectedRow(correlationId: string): Promise<RunRow> {
    const document = await previewRunsDocument({ store, log });
    const queue = await readEvents({ store, log });
    const projected = projectRunHistory({
        runs: document.runs,
        deliveries: new Map(queue.map((entry) => [entry.id, entry])),
        cap: document.runs.length,
        followUpsFrom: null,
    }).find((row) => row.id === correlationId);
    const parsed = parseEventRows([structuredClone(projected)])?.[0];
    if (parsed === undefined) {
        throw new Error('the projected row did not parse as a runs-history row');
    }

    return parsed;
}

/** One panel probe over the fake host: the relay's own view of one projected row. */
function panelProbe(input: {
    readonly row: RunRow;
    readonly currentSession: string;
    readonly prompt: PanelPrompt;
}): {
    readonly rt: PanelRuntime;
    readonly prompts: readonly string[];
    readonly records: () => readonly FollowUpDeliveryRecord[];
} {
    const prompts: string[] = [];
    const values = new Map<string, JsonValue>();
    const host: PanelHost = fakeHost({
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            if (request.path === '/v1/config') {
                return { status: 200, body: '{}' };
            }

            if (request.path === '/v1/events/pending') {
                return { status: 200, body: JSON.stringify({ events: [], status: [], auditWritten: true }) };
            }

            if (request.path.startsWith('/v1/events')) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        events: [structuredClone(input.row)],
                        page: {
                            limit: 100,
                            nextCursor: null,
                            hasMore: false,
                            total: 1,
                            snapshotAt: STAMP,
                            filter: { bindingId: null, state: 'dispatched' },
                        },
                    }),
                };
            }

            return { status: 404, body: '{}' };
        },
        storage: {
            get: async (key: string) => values.get(key),
            set: async (key: string, value: JsonValue) => {
                values.set(key, value);
            },
            delete: async (key: string) => {
                values.delete(key);
            },
            keys: async () => [...values.keys()],
        },
        prompt: async () => {
            prompts.push('prompt');
            if (input.prompt === 'no-session') {
                throw Object.assign(new Error('no session'), { code: 'NO_SESSION' });
            }

            return { sent: 'sent' };
        },
        onSession: (listener: (session: SessionSnapshot | null) => void) => {
            listener({ id: input.currentSession, title: 't', busy: false });

            return release;
        },
    });
    const rt = createTestRuntime(host);
    rt.unsubscribes.push(trackCurrentSession(rt));

    return {
        rt,
        prompts,
        records: () => readDispatchRecord(values.get('mecha-turk:dispatches'))?.followUps ?? [],
    };
}

describe('the pre-mortem table: one row per distinct final-word outcome (Gate 2 mandated)', () => {
    for (const scenario of TABLE) {
        it(`${scenario.outcome} → the operator reads “${scenario.finalWord}”`, async () => {
            // The refused row points discovery at a dead port so the ladder
            // exhausts into the unavailable mark; the live fake only carries
            // the password the token chain must accept on the last rung.
            const fake = await engine(scenario.outcome === 'refused' ? {} : { promptOutcome: scenario.outcome });
            if (scenario.outcome === 'refused') {
                const dead = await startFakeOpenCode();
                const deadPort = dead.port;
                await dead.shutdown();
                await writeManagedRegistry(registryDir, { pid: process.pid, ownerPid: process.pid, port: deadPort });
            }

            const seeded = await seedDispatchedFollowUp();

            await runEngineDeliveryPass(passDeps(engineEnv(fake)));

            // Link 1: the service's classification is the persisted member.
            const stored = await queuedRow(seeded.deliveryId);
            expect(stored?.engine, 'the persisted engine member').toEqual(scenario.storedEngine);
            if (scenario.storedCauseFree === true) {
                expect(Object.hasOwn(stored?.engine ?? {}, 'cause'), 'the unavailable member carries no cause')
                    .toBe(false);
            }

            // Link 2: the persisted member is the projection's source, read
            // back through the panel's own fail-closed parser.
            const row = await projectedRow(seeded.correlationId);
            expect(row.followUps?.[0]?.engine, 'the projected engine member').toEqual(scenario.projectedEngine);

            // Link 3: the panel renders the final word through its own entry
            // points, and its attempt leaves exactly the record the table names.
            const probe = panelProbe({ row, currentSession: scenario.currentSession, prompt: scenario.prompt });
            for (let tickIndex = 0; tickIndex < 2; tickIndex += 1) {
                await pollRelay(probe.rt);
                await tick();
            }

            expect(probe.prompts, 'fallback prompts').toHaveLength(scenario.prompts);
            const records = probe.records();
            if (scenario.record === null) {
                expect(records, 'the panel wrote a record the table did not name').toHaveLength(0);
            } else {
                expect(records.at(0), 'the durable record').toMatchObject(scenario.record);
            }

            const view = followUpRowView(row, records);
            expect(view, 'the row view').toMatchObject(scenario.view);
            // `unconfirmed` counts inside `waiting` (§4's rule 2): the rendered
            // note rides the waiting total, it does not add to it.
            expect(waitingFollowUps([row], records), 'the waiting count').toBe(scenario.view.waiting);
            const subtitle = dispatchRow(row, records).subtitle ?? '';
            for (const fragment of scenario.subtitle) {
                expect(subtitle, 'the run row’s follow-up line').toContain(fragment);
            }

            const offered = reofferableFollowUps(row, records);
            if (scenario.offered === null) {
                expect(offered, 'the re-offer offered a row the table did not name').toEqual([]);
            } else {
                expect(offered.map((entry) => entry.kind), 'the re-offer’s offer').toEqual([scenario.offered]);
            }
        });
    }
});
