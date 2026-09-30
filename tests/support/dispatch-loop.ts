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

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import { createEvent, enqueueEvents } from '../../service/poll/events.ts';
import { createLogger } from '../../service/log.ts';
import { readRunsDocument } from '../../service/poll/runs.ts';
import { writeRunsDocument } from '../../service/poll/runs-document.ts';
import { sweepOnce } from '../../service/poll/sweep.ts';
import { promptSnapshotOf } from '../../service/prompt.ts';
import type { EventSnapshot } from '../../service/poll/events.ts';
import type { ClaimedRun } from '../../src/claim-service.ts';
import type { PanelRuntime } from '../../src/panel-state.ts';
import type { PanelBinding } from '../../src/bindings-service.ts';
import type { SpikeHost } from '../../src/session.ts';
import type { ServiceLogger } from '../../service/log.ts';
import type { ServiceStore } from '../../service/store/index.ts';
import {
    IDLE_UNSUBSCRIBE,
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

/** Trigger shapes the loop's fixtures enqueue. */
export type FixtureTrigger = 'assignment' | 'comment-mention' | 'body-mention';

/** Binding every fixture detection names; the mounts install it as active. */
const BINDING_ID = 'bnd-loop';

/** Repository every fixture detection names. */
const REPOSITORY = 'acme/loop';

/** Account every fixture detection is about. */
const ACCOUNT_ID = '77331';

/** Login every fixture detection carries. */
const ACCOUNT_LOGIN = 'octocat';

/** Worktree option every fixture binding dispatches with. */
const WORKTREE_OPTION = 'none';

/** Prefix under the system temp directory for one loop. */
const TEMP_PREFIX = 'mecha-turk-loop-';

/** Stamp every fixture detection carries unless a test overrides it. */
export const FIXTURE_STAMP = '2026-09-20T00:00:00.000Z';

/** Stamp a fixture-aged lease reads as expired against (the service's clock). */
const EXPIRED_LEASE_STAMP = '2000-01-01T00:00:00.000Z';

/** Agent the fixture host's read-back reports, matching the panel's default. */
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
const LOOP_LOGGER: ServiceLogger = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

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

/** Inputs for {@link DispatchLoop.enqueue}. */
export interface EnqueueInput {
    /** Issue the triggers are about. */
    readonly issueNumber: number;
    /** Triggers detected for that issue; defaults to one assignment. */
    readonly triggers?: readonly FixtureTrigger[];
    /** Detection stamp; defaults to {@link FIXTURE_STAMP}. */
    readonly detectedAt?: string;
    /** The binding's prompt at detection, snapshotted onto the run (004 FR-015). */
    readonly prompt?: string;
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

/** Build the detection one fixture trigger maps onto. */
function detection(input: {
    /** Issue the detection is about. */
    readonly issueNumber: number;
    /** Which trigger fired. */
    readonly trigger: FixtureTrigger;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
}): EventSnapshot {
    const base = {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        projectId: PROJECT_ID,
        worktreeOption: WORKTREE_OPTION,
        issue: {
            issueNumber: input.issueNumber,
            issueTitle: `Issue ${input.issueNumber}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${input.issueNumber}`,
            issueBodyExcerpt: '',
        },
        triggerNote: `${input.trigger} fixture`,
        detectedAt: input.detectedAt,
    };

    if (input.trigger === 'assignment') {
        return { ...base, kind: 'assignment' };
    }

    if (input.trigger === 'body-mention') {
        return { ...base, kind: 'mention', origin: 'body' };
    }

    return { ...base, kind: 'mention', origin: 'comment', commentId: 4_000 + input.issueNumber };
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
    if (options.loseFirstReport === true && isResult && !lost.value) {
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
    readonly storage: SpikeHost['storage'];
    /** Whether this mount has already lost its report. */
    readonly lost: { value: boolean };
}): SpikeHost {
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

            return IDLE_UNSUBSCRIBE;
        },
        storage,
    });
}

/** Close one mount the way the panel's teardown does. */
function stopMount(rt: PanelRuntime): void {
    rt.disposed = true;
    rt.relayArmed = false;
    if (rt.state.relay.timer !== null) {
        clearInterval(rt.state.relay.timer);
        rt.state.relay.timer = null;
    }
}

/** Enqueue one subject's fixture deliveries through the real coalescing path. */
async function enqueueTriggers(input: {
    /** Open store to write through. */
    readonly store: ServiceStore;
    /** Issue the triggers are about. */
    readonly issueNumber: number;
    /** Which triggers fired; one assignment when absent. */
    readonly triggers: readonly FixtureTrigger[] | undefined;
    /** Detection stamp; the fixture stamp when absent. */
    readonly detectedAt: string | undefined;
    /** The binding's prompt at detection, or `undefined` for none. */
    readonly prompt: string | undefined;
}): Promise<void> {
    const triggers: readonly FixtureTrigger[] = input.triggers ?? ['assignment'];
    const incoming = triggers.map((trigger) => createEvent(detection({
        issueNumber: input.issueNumber,
        trigger,
        detectedAt: input.detectedAt ?? FIXTURE_STAMP,
    })));
    const snapshot = input.prompt === undefined ? null : promptSnapshotOf({ startingPrompt: input.prompt });
    const queued = { store: input.store, log: LOOP_LOGGER, incoming };
    await enqueueEvents(snapshot === null ? queued : { ...queued, prompt: snapshot });
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
        if (rt !== undefined) {
            stopMount(rt);
            if (rt.pendingVerifications.length > 0) {
                await drainVerifications(rt);
            }
        }
    }

    await input.service.shutdown();
    await rm(input.root, { recursive: true, force: true });
    LOG_LINES.length = 0;
}

/**
 * Age every stored lease so it reads as expired to whatever clock judges it next.
 *
 * The boot sweep reads the *real* clock (NFR-112), so "the lease outlived the
 * outage" cannot be modelled by waiting — the fixture moves the stored expiry
 * instead, which is the same state a long downtime leaves behind.
 *
 * @param input - The open store to age in place.
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
 * @param input - The storage double to wrap and the timeline to record on.
 * @returns The storage surface every mount runs on.
 */
function sharedStorageFor(input: {
    /** Storage double whose map the loop exposes. */
    readonly storage: StorageDouble;
    /** Timeline every record/ack flip is appended to. */
    readonly timeline: string[];
}): SpikeHost['storage'] {
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
 * @param service - The running instance.
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
 * @param input - Instance, mount options, counters, storage, and the list to
 *   collect the mount on.
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
    readonly storage: SpikeHost['storage'];
    /** Mounts collected for teardown. */
    readonly mounts: PanelRuntime[];
}): PanelRuntime {
    const rt = createTestRuntime(buildHost({ ...input, lost: { value: false } }));
    rt.state.bindings.bindings = [loopBinding()];
    input.mounts.push(rt);

    return rt;
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

    let service = await startTestService({ dataDir });
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
        enqueue: async (input) =>
            await enqueueTriggers({
                store: loop.store,
                issueNumber: input.issueNumber,
                triggers: input.triggers,
                detectedAt: input.detectedAt,
                prompt: input.prompt,
            }),
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
            service = await startTestService({ dataDir });
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
        throw new Error(`not an RFC 3339 stamp: ${stamp}`);
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
