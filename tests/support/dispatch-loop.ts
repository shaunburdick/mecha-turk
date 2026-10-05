/**
 * The loop: one panel runtime wired to one running service (003 T-031, T-032,
 * T-036).
 *
 * Every crash permutation this wave asserts is a statement about *both* halves
 * at once — what the panel did before it "died", and what the service did with
 * what it was told — so the fixtures need the real pair rather than a route
 * table: `host.serviceRequest` forwards to the loopback service, `store` is the
 * service's own handle, and `sessions` records every `host.startSession()` call
 * the fake host received, keyed by attachment id (= the run's correlation id,
 * FR-029). That last list is what AC-110 measures: **sessions created per run
 * identifier, never more than one.**
 *
 * Offline by construction: a temp data directory, the real loopback service
 * with no bindings to poll (so the scan cycle never reaches GitHub), and sweep
 * stamps the caller injects — no test ever waits on a clock (NFR-112).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    GuestProjectsSnapshot,
    GuestRequest,
    GuestRequestResult,
    JsonValue,
    SessionSnapshot,
    StartSessionRequest,
    StartSessionResult,
} from '@openchamber/sdk';
import { drainVerifications } from '../../src/agent-verify.ts';
import { DISPATCH_STORAGE_KEY } from '../../src/dispatch-record.ts';
import { parsePendingBody } from '../../src/claim-service.ts';
import { EVENTS_PENDING_PATH, serviceGet } from '../../src/service-calls.ts';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../../service/config.ts';
import { createLogger } from '../../service/log.ts';
import { readRunsDocument } from '../../service/poll/runs.ts';
import { writeRunsDocument } from '../../service/poll/runs-document.ts';
import { sweepOnce } from '../../service/poll/sweep.ts';
import type { ClaimedRun } from '../../src/claim-service.ts';
import type { PanelRuntime } from '../../src/panel-state.ts';
import type { PanelBinding } from '../../src/bindings-service.ts';
import type { PanelHost } from '../../src/session.ts';
import type { GitHubIssuePoller } from '../../service/poll/poller-github.ts';
import type { ServiceLogger } from '../../service/log.ts';
import type { ServiceStore } from '../../service/store/index.ts';
import {
    ACCOUNT_ID,
    ACCOUNT_LOGIN,
    BINDING_ID,
    FIXTURE_STAMP,
    REPOSITORY,
    WORKTREE_OPTION,
    bindEnqueue,
} from './fixture-enqueue.ts';
import type { EnqueueInput } from './fixture-enqueue.ts';
import { offlinePoller } from './github.ts';
import {
    hasNothingToRelease,
    PROJECT_ID,
    PROJECTS,
    SESSION_CREATED,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
} from './panel.ts';
import type { StorageDouble } from './panel.ts';
import { startTestService } from './service.ts';
import type { TestService } from './service.ts';
import { writeLoopBinding } from './binding-fixture.ts';

/** Prefix under the system temp directory for one loop. */
const TEMP_PREFIX = 'mecha-turk-loop-';

/**
 * Poller every loop instance's background scan runs under.
 *
 * The rationale — why the background scan must not reach GitHub from a fixture
 * that seeds a binding, and why empty answers keep it on the test's own clock —
 * lives with the double itself in `support/github.ts`, beside the offline
 * verifier it answers the same question for the credential side.
 */
const OFFLINE_POLLER: GitHubIssuePoller = offlinePoller();

/**
 * Removal attempts for one loop's temp root while a straggler write lands.
 *
 * Each retry waits a multiple of {@link ROOT_REMOVE_RETRY_MS} longer than the
 * last, and Node re-lists the directory on every attempt, so a straggler's file
 * is collected by the next pass instead of failing the removal.
 */
const ROOT_REMOVE_RETRIES = 10;

/** Base delay between removal attempts, in milliseconds. */
const ROOT_REMOVE_RETRY_MS = 50;

/** Stamp a fixture-aged lease reads as expired against (the service's clock). */
const EXPIRED_LEASE_STAMP = '2000-01-01T00:00:00.000Z';

/** Agent the fixture host's read-back reports; the loop's config pins it as the baseline. */
export const EXPECTED_AGENT = 'project-manager';

/** Header name a forwarded JSON body carries, as a computed object key. */
const CONTENT_TYPE_HEADER = 'content-type';

/** Error body a lost report answers with (contract §1 envelope). */
const LOST_REPORT_BODY = JSON.stringify({ error: { code: 'storage-unavailable', message: 'store down' } });

/** HTTP status a lost report answers with. */
const LOST_REPORT_STATUS = 503;

/** Log lines the loop keeps out of the test output. */
const LOG_LINES: string[] = [];

/** Logger every direct store call in the loop reports through. */
const LOOP_LOGGER: ServiceLogger = createLogger({ level: 'error', sink: (line) => void LOG_LINES.push(line) });

/** The read-back snapshot the fixture host replays to the verifier. */
const SESSION_SNAPSHOT: SessionSnapshot = {
    id: SESSION_CREATED.sessionId ?? 'ses_loop',
    title: 'Fix the flaky test',
    busy: false,
    agent: EXPECTED_AGENT,
};

/** How one mount differs from the default panel. */
export interface MountOptions {
    /**
     * Replace the host's `startSession`.
     *
     * Defaults to recording the call in the loop's session list and answering
     * `SESSION_CREATED`, which is what makes "sessions per run id" measurable.
     */
    readonly startSession?: (request: StartSessionRequest) => Promise<StartSessionResult>;
    /**
     * Fail this mount's **first** result report with a `503`.
     *
     * Models the lost report of FR-024: the panel recorded the outcome, the
     * service never heard it.
     */
    readonly loseFirstReport?: boolean;
    /** Project snapshot the host answers with; defaults to the fixture projects. */
    readonly listProjects?: () => Promise<GuestProjectsSnapshot>;
}

/** One panel wired to one service, with the evidence a permutation asserts over. */
export interface DispatchLoop {
    /** The running instance (reassigned by {@link DispatchLoop.restart}). */
    readonly service: TestService;
    /** The running instance's open store. */
    readonly store: ServiceStore;
    /** Attachment id of every `host.startSession()` call this loop ever saw. */
    readonly sessions: readonly string[];
    /** Everything the mounted panel did, in order: `METHOD path`, `record`, `ack`, `startSession:<id>`. */
    readonly timeline: string[];
    /** The shared `host.storage` values every mount reads and writes. */
    readonly panelStorage: Map<string, JsonValue>;
    /** Enqueue fixture deliveries through the real coalescing path. */
    enqueue(input: EnqueueInput): Promise<void>;
    /**
     * Enqueue many subjects' fixture deliveries through **one** real
     * `enqueueEvents` call — a scan-sized batch, exactly how the production
     * loop hands one binding's scan to the queue (`service/poll/loop.ts`).
     */
    enqueueScan(inputs: readonly EnqueueInput[]): Promise<void>;
    /** Mount a panel on this loop; the caller unmounts or lets it die. */
    mount(options?: MountOptions): PanelRuntime;
    /** Tear a mount down the way closing the panel does. */
    unmount(rt: PanelRuntime): void;
    /** Run one sweep pass at an injected stamp (NFR-112 — never a sleep). */
    sweepAt(stamp: string): Promise<void>;
    /** Age every stored lease so the next boot's sweep reads it as expired. */
    ageLeases(): Promise<void>;
    /** Drain the instance and start a new one on the same data directory. */
    restart(): Promise<void>;
    /** Drain every mount and the instance, then remove the temp root. */
    shutdown(): Promise<void>;
}

/** The one active binding the mounts install, matching the fixture runs. */
function loopBinding(): PanelBinding {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: REPOSITORY,
        projectId: PROJECT_ID,
        worktreeOption: WORKTREE_OPTION,
        triggers: { assignment: true, mention: true, reviewRequest: false },
        state: 'active',
        createdAt: FIXTURE_STAMP,
        updatedAt: FIXTURE_STAMP,
    };
}

/** Forward one panel request to whichever instance is running. */
async function forward(input: {
    /** The running instance to call. */
    readonly service: TestService;
    /** The request the panel issued. */
    readonly request: GuestRequest;
    /** Mount whose first report is the one that gets lost. */
    readonly options: MountOptions;
    /** Whether this mount has already lost its report. */
    readonly lost: { value: boolean };
    /** Timeline every call is recorded on. */
    readonly timeline: string[];
}): Promise<GuestRequestResult> {
    const { service, request, options, lost, timeline } = input;
    timeline.push(`${request.method} ${request.path}`);
    const isResult = request.method === 'POST' && request.path.endsWith('/dispatched');
    if (isResult && !lost.value && options.loseFirstReport === true) {
        lost.value = true;

        return { status: LOST_REPORT_STATUS, body: LOST_REPORT_BODY };
    }

    const init: RequestInit = { method: request.method };
    if (request.body !== undefined) {
        init.headers = { [CONTENT_TYPE_HEADER]: 'application/json' };
        init.body = request.body;
    }
    const response = await service.call(request.path, init);

    return { status: response.status, body: await response.text() };
}

/**
 * Whether a value written to the dispatch record already carries an
 * acknowledgement, so the timeline can tell the record write from the flip.
 *
 * @param value - Value the panel stored.
 * @returns `true` once any stored attempt is acknowledged.
 */
function acknowledgesAttempt(value: JsonValue): boolean {
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

/** Build the host one mount runs on: the loopback bridge plus a counting host. */
function buildHost(input: {
    /** The running instance the bridge forwards to. */
    readonly service: TestService;
    /** Mount options this host honours. */
    readonly options: MountOptions;
    /** Session list every default `startSession` appends to. */
    readonly sessions: string[];
    /** Timeline every call and storage flip is recorded on. */
    readonly timeline: string[];
    /** Shared storage every mount reads and writes. */
    readonly storage: PanelHost['storage'];
    /** Whether this mount has already lost its report. */
    readonly lost: { value: boolean };
}): PanelHost {
    const { service, options, sessions, timeline, storage, lost } = input;

    return fakeHost({
        serviceRequest: async (request) => await forward({ service, request, options, lost, timeline }),
        startSession: options.startSession
            ?? (async (request: StartSessionRequest): Promise<StartSessionResult> => {
                sessions.push(request.id);
                timeline.push(`startSession:${request.id}`);

                return SESSION_CREATED;
            }),
        listProjects: options.listProjects ?? (async () => PROJECTS),
        openSession: async (sessionId) => {
            timeline.push(`openSession:${sessionId}`);
        },
        onSession: (listener) => {
            listener(SESSION_SNAPSHOT);

            return hasNothingToRelease;
        },
        storage,
    });
}

/** Close one mount the way the panel's teardown does. */
function stopMount(rt: PanelRuntime): void {
    rt.disposed = true;
    rt.relayArmed = false;
    if (rt.state.relay.timer === null) {
        return;
    }

    clearInterval(rt.state.relay.timer);
    rt.state.relay.timer = null;
}

/** Drain every mount (pending read-backs first) and the instance itself. */
async function drainLoop(input: {
    /** Mounts to close, newest last. */
    readonly mounts: PanelRuntime[];
    /** The running instance to drain. */
    readonly service: TestService;
    /** Temp root to remove. */
    readonly root: string;
}): Promise<void> {
    while (input.mounts.length > 0) {
        const rt = input.mounts.pop();
        if (rt === undefined) {
            continue;
        }

        stopMount(rt);
        if (rt.pendingVerifications.length > 0) {
            await drainVerifications(rt);
        }
    }

    await input.service.shutdown();
    // `shutdown()` drains in-flight requests and stops both schedulers from
    // re-arming, but it does not await a fire-and-forget pass already in
    // flight (the first scan cycle, startup reconciliation). `maxRetries`
    // makes the removal re-list the tree on every ENOTEMPTY instead of
    // failing: a straggler's file is picked up by the next attempt.
    await rm(input.root, {
        recursive: true,
        force: true,
        maxRetries: ROOT_REMOVE_RETRIES,
        retryDelay: ROOT_REMOVE_RETRY_MS,
    });
    LOG_LINES.length = 0;
}

/**
 * Age every stored lease so it reads as expired to whatever clock judges it next.
 *
 * The boot sweep reads the *real* clock (NFR-112), so "the lease outlived the
 * outage" cannot be modelled by waiting — the fixture moves the stored expiry
 * instead, which is the same state a long downtime leaves behind.
 */
async function ageStoredLeases(input: { readonly store: ServiceStore }): Promise<void> {
    const document = await readRunsDocument({ store: input.store, log: LOOP_LOGGER });
    const runs = document.runs.map((run) => run.lease === null
        ? run
        : { ...run, lease: { ...run.lease, expiresAt: EXPIRED_LEASE_STAMP } });
    await writeRunsDocument({
        store: input.store,
        log: LOOP_LOGGER,
        document: { ...document, runs },
    });
}

/**
 * Build the shared `host.storage` the mounts read and write, recording each
 * dispatch-record flip on the loop's timeline.
 *
 * @returns The storage surface every mount runs on.
 */
function sharedStorageFor(input: {
    /** Storage double whose map the loop exposes. */
    readonly storage: StorageDouble;
    /** Timeline every record/ack flip is appended to. */
    readonly timeline: string[];
}): PanelHost['storage'] {
    return {
        ...input.storage.storage,
        set: async (key, value) => {
            if (key === DISPATCH_STORAGE_KEY) {
                input.timeline.push(acknowledgesAttempt(value) ? 'ack' : 'record');
            }

            await input.storage.storage.set(key, value);
        },
    };
}

/**
 * The open store of whichever instance is running, demanded rather than
 * defaulted: a loop that cannot read its runs cannot answer for a dispatch.
 *
 * @returns Its open store.
 * @throws {Error} When the instance opened no store.
 */
function currentStoreOf(service: TestService): ServiceStore {
    const opened = service.handle.store;
    if (opened === null) {
        throw new Error('the loop service opened no store');
    }

    return opened;
}

/**
 * Mount one panel on a loop and collect it for teardown.
 *
 * @returns The mounted runtime, configured with the loop's active binding.
 */
function mountPanel(input: {
    /** The running instance the bridge forwards to. */
    readonly service: TestService;
    /** Mount options this panel honours. */
    readonly options: MountOptions;
    /** Session list every default `startSession` appends to. */
    readonly sessions: string[];
    /** Timeline every call and storage flip is recorded on. */
    readonly timeline: string[];
    /** Shared storage the panel reads and writes. */
    readonly storage: PanelHost['storage'];
    /** Mounts collected for teardown. */
    readonly mounts: PanelRuntime[];
}): PanelRuntime {
    const rt = createTestRuntime(buildHost({ ...input, lost: { value: false } }));
    rt.state.bindings.bindings = [loopBinding()];
    input.mounts.push(rt);

    return rt;
}

/**
 * Start one loop instance: the harness defaults plus the offline poller.
 *
 * @param dataDir - Store directory the instance serves.
 * @returns The running instance.
 */
async function startLoopService(dataDir: string): Promise<TestService> {
    return await startTestService({ dataDir, poller: OFFLINE_POLLER });
}

/**
 * Write the store files one loop starts with, both states an operator could be in.
 *
 * `config.json` pins a **configured** comparison baseline matching the fixture
 * host's session agent — the shipped default is blank (006 v1.5.0), and these
 * suites assert read-backs that verify end to end (002 FR-029).
 * `bindings.json` carries the loop's own binding under the **open** policy
 * (002 FR-047), because the gate denies a run whose binding it cannot read
 * (003 FR-076).
 *
 * @param dataDir - Store directory to seed.
 * @returns A promise that settles once both documents are durable.
 */
async function seedLoopStore(dataDir: string, store: ServiceStore): Promise<void> {
    await writeFile(
        join(dataDir, CONFIG_FILE),
        JSON.stringify({ ...DEFAULT_CONFIG, expectedAgent: EXPECTED_AGENT }),
        'utf8',
    );
    await writeLoopBinding(store);
}

/**
 * Start one loop: a temp store and the real service serving it.
 *
 * @returns The loop, ready for fixtures and mounts.
 */
export async function startDispatchLoop(): Promise<DispatchLoop> {
    const root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    const dataDir = join(root, 'store');
    await mkdir(dataDir, { recursive: true });

    let service = await startLoopService(dataDir);
    await seedLoopStore(dataDir, currentStoreOf(service));
    const sessions: string[] = [];
    const timeline: string[] = [];
    const storage = createStorageDouble();
    const sharedStorage = sharedStorageFor({ storage, timeline });
    const mounts: PanelRuntime[] = [];

    const loop: DispatchLoop = {
        get service(): TestService {
            return service;
        },
        get store(): ServiceStore {
            return currentStoreOf(service);
        },
        sessions,
        timeline,
        panelStorage: storage.values,
        ...bindEnqueue({ storeOf: () => loop.store, log: LOOP_LOGGER }),
        mount: (options = {}) => mountPanel({
            service,
            options,
            sessions,
            timeline,
            storage: sharedStorage,
            mounts,
        }),
        unmount: (rt) => stopMount(rt),
        sweepAt: async (stamp) => {
            await sweepOnce({ store: loop.store, log: LOOP_LOGGER, now: stamp });
        },
        ageLeases: async () => await ageStoredLeases({ store: loop.store }),
        restart: async () => {
            await service.shutdown();
            service = await startLoopService(dataDir);
        },
        shutdown: async () => await drainLoop({ mounts, service, root }),
    };

    return loop;
}

/**
 * Claim every waiting run through one mount's own service bridge.
 *
 * @param rt - The mount whose bridge claims.
 * @returns The offer the service answered with.
 * @throws {Error} When the claim was refused or unreadable.
 */
export async function offerFor(rt: PanelRuntime): Promise<readonly ClaimedRun[]> {
    const fetched = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: EVENTS_PENDING_PATH });
    if (!fetched.ok) {
        throw new Error(`the claim failed: ${fetched.problem}`);
    }

    const parsed = parsePendingBody(fetched.body);
    if (parsed === null) {
        throw new Error('the claim answer could not be read');
    }

    return parsed.runs;
}

/**
 * A stamp one millisecond past a stored expiry, so a sweep judges it expired.
 *
 * @param stamp - RFC 3339 expiry read from the store (never the wall clock).
 * @returns The injecting stamp for `sweepOnce`.
 */
export function justPast(stamp: string): string {
    const parsed = Date.parse(stamp);
    if (Number.isNaN(parsed)) {
        throw new TypeError(`not an RFC 3339 stamp: ${stamp}`);
    }

    return new Date(parsed + 1).toISOString();
}

/**
 * Count how many sessions each run identifier ever produced.
 *
 * @param sessions - Attachment ids of every `host.startSession()` call.
 * @returns Run identifier → sessions created for it.
 */
export function sessionsPerRun(sessions: readonly string[]): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const id of sessions) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    return counts;
}
