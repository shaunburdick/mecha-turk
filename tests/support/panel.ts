/**
 * Shared doubles for the panel tests.
 *
 * The spike's panel runs inside an OpenChamber iframe, so the tests drive the
 * documented host surface through a neutral double instead of a real host:
 * every default answers in the least surprising way and each test overrides
 * only what it deliberately changes. Keeping one double here means a change to
 * the documented surface is fixed once instead of once per test file.
 *
 * Nothing in this module talks to a network, a filesystem, or a real host.
 */

import type {
    GuestProjectsSnapshot,
    GuestRequest,
    GuestRequestResult,
    GuestSessionsSnapshot,
    GuestWorktreesSnapshot,
    JsonValue,
    StartSessionResult,
} from '@openchamber/sdk';
import type { SpikeConfig } from '../../extension/src/config.ts';
import type { SpikeEvidence } from '../../extension/src/evidence.ts';
import { createPanelRuntime } from '../../extension/src/panel-state.ts';
import type { PanelRuntime } from '../../extension/src/panel-state.ts';
import type { SpikeHost } from '../../extension/src/session.ts';

/** Project id every panel test dispatches against. */
export const PROJECT_ID = 'prj_42';

/** Directory the fixture project reports. */
export const PROJECT_DIR = '/home/agent/acme/widget';

/** Name of the worktree the fixture host reports. */
export const WORKTREE_NAME = 'spike';

/** Login of the authenticated machine account. */
export const LOGIN = 'mecha-bot';

/** Repository polled by the fixture configuration. */
export const REPOSITORY = 'acme/widget';

/** Canonical URL of the fixture issue. */
export const ISSUE_URL = 'https://github.com/acme/widget/issues/7';

/** Session id reported by the successful dispatch fixture. */
export const SESSION_ID = 'ses_1';

/** Poll interval used by the fixture configuration. */
export const INTERVAL_MS = 60_000;

/** RFC 3339 timestamp stamped on fixture records. */
export const FIXTURE_TIMESTAMP = '2026-09-26T12:00:00.000Z';

/** Correlation identifier stamped on the fixture evidence record. */
export const FIXTURE_CORRELATION = '7b3e2d5a-1c4b-4e8f-9d0a-5c6b7a8f9e01';

/** Status the request double answers with when a test does not override it. */
export const DEFAULT_STATUS = 404;

/** Body the request double answers with when a test does not override it. */
export const DEFAULT_BODY = '{"message":"unconfigured"}';

/** Unsubscribe double: the base host registers nothing, so nothing is released. */
export const IDLE_UNSUBSCRIBE = (): boolean => false;

/** Result double for `startSession` when a test does not exercise dispatch. */
export const NO_SESSION: StartSessionResult = {
    sessionId: null,
    sent: 'skipped',
    directory: PROJECT_DIR,
    worktree: { directory: PROJECT_DIR, name: 'none', branch: 'none', status: 'missing' },
    failure: 'session-create-failed',
};

/** Result double for a `startSession` call that created a session. */
export const SESSION_CREATED: StartSessionResult = {
    sessionId: SESSION_ID,
    sent: 'sent',
    directory: PROJECT_DIR,
    linked: true,
};

/** A project snapshot with one registered project. */
export const PROJECTS: GuestProjectsSnapshot = {
    kind: 'projects',
    state: 'ready',
    projects: [{ id: PROJECT_ID, name: 'widget', directory: PROJECT_DIR }],
};

/** A worktree snapshot reporting one generated worktree. */
export const WORKTREES: GuestWorktreesSnapshot = {
    kind: 'worktrees',
    projectId: PROJECT_ID,
    state: 'ready',
    worktrees: [
        {
            directory: `${PROJECT_DIR}/.worktrees/${WORKTREE_NAME}`,
            name: WORKTREE_NAME,
            branch: WORKTREE_NAME,
            status: 'ready',
        },
    ],
};

/** A sessions snapshot with no sessions yet. */
export const SESSIONS: GuestSessionsSnapshot = {
    kind: 'sessions',
    projectId: PROJECT_ID,
    state: 'ready',
    coverage: [],
    sessions: [],
};

/** Documented `GET /user` path used to discover the machine identity. */
export const USER_PATH = '/user';

/** Documented issue-list path for the fixture repository. */
export const ISSUE_LIST_PATH = '/repos/acme/widget/issues';

/** Documented issue-detail path for the fixture issue. */
export const ISSUE_DETAIL_PATH = '/repos/acme/widget/issues/7';

/** Response body for `GET /user`, built from the fixture login. */
export const USER_RESPONSE = JSON.stringify({ login: LOGIN });

/** HTTP status the fixture endpoints answer with on success. */
const HTTP_OK = 200;

/** Inputs for {@link githubIssuePayload}. */
export interface IssuePayloadInput {
    /** Issue number; defaults to the fixture issue. */
    readonly issueNumber?: number;
    /** Logins the issue is assigned to; empty means "unassigned". */
    readonly assignees: readonly string[];
    /** Repository state of the issue. */
    readonly state?: string;
}

/** Default issue number used by {@link githubIssuePayload}. */
const DEFAULT_ISSUE_NUMBER = 7;

/** Repository state of the fixture issue. */
const OPEN_STATE = 'open';

/**
 * Serialize a GitHub issue the way the REST API returns it.
 *
 * The payload is deliberately minimal but complete: the normalisation layer
 * fails closed on missing fields, so a fixture that omits one would only test
 * the normaliser, not the panel. It is written as a JSON document rather than
 * an object literal because the provider's own field names (`number`,
 * `html_url`) are not this codebase's naming conventions — the same reason
 * `extension/src/github.ts` reads them through string keys.
 *
 * @param input - Issue number, assignees, and repository state.
 * @returns The response body for a `host.request` double.
 */
export function githubIssuePayload(input: IssuePayloadInput): string {
    const issueNumber = input.issueNumber ?? DEFAULT_ISSUE_NUMBER;
    const url = `https://github.com/acme/widget/issues/${issueNumber}`;
    const state = input.state ?? OPEN_STATE;
    const assignees = JSON.stringify(input.assignees.map((login) => ({ login })));

    return [
        `{"number":${issueNumber},"title":"Fix the flaky test","html_url":"${url}",`,
        `"state":"${state}","body":"It fails once in ten runs.","assignees":${assignees}}`,
    ].join('');
}

/**
 * Build a `host.request` double over a path-to-body table.
 *
 * The table is read on every call, so a test can change a payload between two
 * polls without rebuilding the host. Paths without an answer get the neutral
 * 404 default, which is exactly how an unconfigured host behaves.
 *
 * @param answers - Response body per documented path.
 * @returns The request double for {@link fakeHost}.
 */
export function requestDouble(
    answers: Readonly<Record<string, string>>,
): (request: GuestRequest) => Promise<GuestRequestResult> {
    return async (request) => {
        const body = answers[request.path];
        if (body === undefined) {
            return { status: DEFAULT_STATUS, body: DEFAULT_BODY };
        }

        return { status: HTTP_OK, body };
    };
}

/** Empty issue window: no issue matches the configured rule. */
export const NO_ISSUES = '[]';

/** A request double plus a reader for how often it was called. */
export interface CountingRequest {
    /** The `host.request` member for {@link fakeHost}. */
    readonly request: (request: GuestRequest) => Promise<GuestRequestResult>;
    /** Number of requests observed so far. */
    readonly calls: () => number;
}

/**
 * Count the requests a host answers.
 *
 * @param answers - Path-to-body table handed to the request double.
 * @returns The request double plus its call counter.
 */
export function countingRequest(answers: Readonly<Record<string, string>>): CountingRequest {
    let calls = 0;
    const answer = requestDouble(answers);

    return {
        request: (request) => {
            calls += 1;
            return answer(request);
        },
        calls: () => calls,
    };
}

/**
 * Build a host double; only the members a test exercises need overriding.
 *
 * Every default is a neutral, type-correct answer rather than a throw, so a
 * test only fails where it genuinely diverges from the documented behaviour.
 *
 * @param overrides - Members to replace with test behaviour.
 * @returns A complete {@link SpikeHost}.
 */
export function fakeHost(overrides: Partial<SpikeHost> = {}): SpikeHost {
    return {
        request: async () => ({ status: DEFAULT_STATUS, body: DEFAULT_BODY }),
        serviceRequest: async () => ({ status: DEFAULT_STATUS, body: DEFAULT_BODY }),
        storage: {
            get: async () => null,
            set: () => Promise.resolve(),
            delete: () => Promise.resolve(),
            keys: async () => [],
        },
        openUrl: () => Promise.resolve(),
        writeClipboard: () => Promise.resolve(),
        startSession: async () => NO_SESSION,
        openSession: () => Promise.resolve(),
        listProjects: async () => PROJECTS,
        listWorktrees: async () => WORKTREES,
        listSessions: async () => SESSIONS,
        onProjects: async () => IDLE_UNSUBSCRIBE,
        onWorktrees: async () => IDLE_UNSUBSCRIBE,
        onSessions: async () => IDLE_UNSUBSCRIBE,
        onSession: () => IDLE_UNSUBSCRIBE,
        onSessionLifecycle: () => IDLE_UNSUBSCRIBE,
        onReady: () => IDLE_UNSUBSCRIBE,
        onSettings: () => IDLE_UNSUBSCRIBE,
        onConnection: () => IDLE_UNSUBSCRIBE,
        dispose: IDLE_UNSUBSCRIBE,
        ...overrides,
    };
}

/** Frame window double plus the listener registrations it recorded. */
export interface WindowDouble {
    /** The window surface handed to the runtime. */
    readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
    /** `addEventListener` calls, as `add:<type>`. */
    readonly added: string[];
    /** `removeEventListener` calls, as `remove:<type>`. */
    readonly removed: string[];
}

/**
 * Build a frame window double that records listener registration.
 *
 * @returns The window surface plus the listeners added and removed, in order.
 */
export function fakeWindow(): WindowDouble {
    const added: string[] = [];
    const removed: string[] = [];

    return {
        window: {
            addEventListener: (type: string): void => {
                added.push(`add:${type}`);
            },
            removeEventListener: (type: string): void => {
                removed.push(`remove:${type}`);
            },
        },
        added,
        removed,
    };
}

/**
 * Build the validated configuration used across the panel tests.
 *
 * @param overrides - Members to replace with test-specific values.
 * @returns A complete spike configuration.
 */
export function testConfig(overrides: Partial<SpikeConfig> = {}): SpikeConfig {
    return {
        repository: { owner: 'acme', name: 'widget' },
        expectedLogin: LOGIN,
        projectId: PROJECT_ID,
        worktree: { kind: 'generated' },
        pollIntervalMs: INTERVAL_MS,
        ...overrides,
    };
}

/**
 * Build the evidence record for the fixture issue.
 *
 * @param overrides - Members to replace with test-specific values.
 * @returns A valid evidence record.
 */
export function testEvidence(overrides: Partial<SpikeEvidence> = {}): SpikeEvidence {
    return {
        schemaVersion: 'extension-spike-1',
        repository: REPOSITORY,
        issueId: '7',
        issueUrl: ISSUE_URL,
        trigger: 'configured-match',
        authenticatedLogin: LOGIN,
        correlationId: FIXTURE_CORRELATION,
        detectedAt: FIXTURE_TIMESTAMP,
        panelGeneration: 1,
        ...overrides,
    };
}

/**
 * Build a runtime that is configured, authenticated, and ready to act.
 *
 * The UI is left unmounted (`ui === null`): these tests exercise the
 * orchestration layer, and every action repaints through `refresh`, which is a
 * no-op until a UI is mounted. No evidence is set — a fresh runtime has not
 * matched anything yet.
 *
 * @param host - Host double for the runtime.
 * @param panelWindow - Frame window; defaults to {@link fakeWindow}.
 * @returns A runtime with fixture configuration and identity.
 */
export function createTestRuntime(host: SpikeHost, panelWindow = fakeWindow().window): PanelRuntime {
    const runtime = createPanelRuntime(host, panelWindow);
    runtime.state.config = testConfig();
    runtime.state.connected = true;
    runtime.state.login = LOGIN;

    return runtime;
}

/**
 * Build a runtime that is configured, authenticated, and already matched.
 *
 * A dispatch reads the evidence record an earlier poll persisted, so these
 * runtimes start with the fixture evidence in place.
 *
 * @param host - Host double for the runtime.
 * @param panelWindow - Frame window; defaults to {@link fakeWindow}.
 * @returns A runtime ready to dispatch the fixture issue.
 */
export function createDispatchRuntime(host: SpikeHost, panelWindow = fakeWindow().window): PanelRuntime {
    const runtime = createTestRuntime(host, panelWindow);
    runtime.state.evidence = testEvidence();

    return runtime;
}

/** Storage double that records what the panel reads and writes. */
export interface StorageDouble {
    /** The documented storage surface handed to {@link fakeHost}. */
    readonly storage: SpikeHost['storage'];
    /** Last value written per key. */
    readonly values: Map<string, JsonValue>;
    /** Operations observed, in order, as `get:<key>` / `set:<key>`. */
    readonly operations: string[];
}

/**
 * Build a storage double pre-loaded with the given values.
 *
 * @param initial - Values `host.storage.get` should answer with.
 * @returns The double plus the records a test asserts on.
 */
export function createStorageDouble(initial: Readonly<Record<string, JsonValue>> = {}): StorageDouble {
    const values = new Map<string, JsonValue>(Object.entries(initial));
    const operations: string[] = [];

    return {
        values,
        operations,
        storage: {
            get: async (key) => {
                operations.push(`get:${key}`);
                return values.get(key);
            },
            set: async (key, value) => {
                operations.push(`set:${key}`);
                values.set(key, value);
            },
            delete: async (key) => {
                operations.push(`delete:${key}`);
                values.delete(key);
            },
            keys: async () => [...values.keys()],
        },
    };
}

/**
 * Let queued promises and timers settle before the test asserts.
 *
 * Actions record their results through `void`-fire-and-forget persistence, so
 * a test must yield to the event loop once before reading storage or banners.
 *
 * @returns A promise resolved on the next macrotask.
 */
export function tick(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}
