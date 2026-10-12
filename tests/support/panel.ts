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
    GuestSessionsSnapshot,
    GuestWorktreesSnapshot,
    JsonValue,
    StartSessionResult,
} from '@openchamber/sdk';
import type { BindingContext } from '../../src/config.ts';
import type { PanelEvidence } from '../../src/evidence.ts';
import { createPanelRuntime } from '../../src/panel-state.ts';
import type { PanelRuntime } from '../../src/panel-state.ts';
import type { PanelHost } from '../../src/session.ts';

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

/** Dispose double: the base host registers nothing, so there is nothing to release. */
export function hasNothingToRelease(): boolean {
    return false;
}

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

/**
 * Build a host double; only the members a test exercises need overriding.
 *
 * Every default is a neutral, type-correct answer rather than a throw, so a
 * test only fails where it genuinely diverges from the documented behaviour.
 */
export function fakeHost(overrides: Partial<PanelHost> = {}): PanelHost {
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
        prompt: async () => ({ sent: 'sent' }),
        listProjects: async () => PROJECTS,
        listWorktrees: async () => WORKTREES,
        listSessions: async () => SESSIONS,
        onProjects: async () => hasNothingToRelease,
        onWorktrees: async () => hasNothingToRelease,
        onSessions: async () => hasNothingToRelease,
        onSession: () => hasNothingToRelease,
        onSessionLifecycle: () => hasNothingToRelease,
        onReady: () => hasNothingToRelease,
        onSettings: () => hasNothingToRelease,
        onConnection: () => hasNothingToRelease,
        dispose: hasNothingToRelease,
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
 */
export function testConfig(overrides: Partial<BindingContext> = {}): BindingContext {
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
 * @returns A valid evidence record.
 */
export function testEvidence(overrides: Partial<PanelEvidence> = {}): PanelEvidence {
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
 * Build a runtime that is configured and ready to act.
 *
 * The UI is left unmounted (`ui === null`): these tests exercise the
 * orchestration layer, and every action repaints through `refresh`, which is a
 * no-op until a UI is mounted. No evidence is set — a fresh runtime has not
 * matched anything yet.
 *
 * @param panelWindow - Frame window; defaults to {@link fakeWindow}.
 * @returns A runtime with the fixture dispatch context.
 */
export function createTestRuntime(
    host: PanelHost,
    panelWindow: ReturnType<typeof fakeWindow>['window'] = fakeWindow().window,
): PanelRuntime {
    const runtime = createPanelRuntime(host, panelWindow);
    runtime.state.config = testConfig();

    return runtime;
}

/** Storage double that records what the panel reads and writes. */
export interface StorageDouble {
    /** The documented storage surface handed to {@link fakeHost}. */
    readonly storage: PanelHost['storage'];
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
