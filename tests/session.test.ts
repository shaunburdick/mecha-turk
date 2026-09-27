import { describe, expect, it } from 'vitest';
import type {
    GuestProjectsSnapshot,
    GuestSessionsSnapshot,
    GuestWorktreesSnapshot,
    StartSessionResult,
} from '@openchamber/sdk';
import type { SpikeConfig } from '../extension/src/config.ts';
import type { SpikeEvidence } from '../extension/src/evidence.ts';
import type { GitHubIssue } from '../extension/src/github.ts';
import { summarizeHostVerification, verifyHostState } from '../extension/src/host-verify.ts';
import { appendEntry, createLedger } from '../extension/src/ledger.ts';
import type { SpikeLedger } from '../extension/src/ledger.ts';
import {
    CONTEXT_MAX_CHARS,
    buildBoundedContext,
    buildStartSessionRequest,
    findDispatchForIssue,
    resolveProject,
    summarizeStartSessionResult,
} from '../extension/src/session.ts';
import type { SpikeHost } from '../extension/src/session.ts';

/** Project id the spike configuration targets. */
const PROJECT_ID = 'prj_42';

/** Name of the generated worktree the host reports. */
const WORKTREE_NAME = 'spike';

/** Directory of the project the host reports. */
const PROJECT_DIR = '/home/agent/acme/widget';

/** Login used as the authenticated machine account. */
const LOGIN = 'mecha-bot';

/** Canonical URL of the matched issue. */
const ISSUE_URL = 'https://github.com/acme/widget/issues/7';

/** Number of milliseconds each subscription probe waits in tests. */
const PROBE_WAIT_MS = 1;

/** Repository string shared by the configuration and the context assertions. */
const REPOSITORY = 'acme/widget';

/** Correlation id used by the bounded-context assertions. */
const CONTEXT_CORRELATION = 'abc-123';

/** The bounded context text used when no issue detail matters. */
const CONTEXT_TEXT = 'bounded context';

/** Session id returned by the successful dispatch fixture. */
const SESSION_ID = 'ses_1';

/** Timestamp used by the fixture records. */
const T0 = '2026-09-26T12:00:00.000Z';

/** Default poll interval used by the configuration fixture. */
const DEFAULT_INTERVAL_MS = 60000;

/** Documented character cap for `title` on `startSession`. */
const CLAMPED_TITLE = 200;

/** Title length used to prove the clamp. */
const LONG_TITLE = 400;

/** A project snapshot with one registered project. */
const PROJECTS: GuestProjectsSnapshot = {
    kind: 'projects',
    state: 'ready',
    projects: [{ id: PROJECT_ID, name: 'widget', directory: PROJECT_DIR }],
};

/** A worktree snapshot reporting one generated worktree. */
const WORKTREES: GuestWorktreesSnapshot = {
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
const SESSIONS: GuestSessionsSnapshot = {
    kind: 'sessions',
    projectId: PROJECT_ID,
    state: 'ready',
    coverage: [],
    sessions: [],
};

/** Status the request double answers with when a test does not override it. */
const DEFAULT_STATUS = 404;

/** Body the request double answers with when a test does not override it. */
const DEFAULT_BODY = '{"message":"unconfigured"}';

/** Unsubscribe double: the base host registers nothing, so nothing is released. */
const IDLE_UNSUBSCRIBE = (): boolean => false;

/** Result double for `startSession` when a test does not exercise dispatch. */
const NO_SESSION: StartSessionResult = {
    sessionId: null,
    sent: 'skipped',
    directory: PROJECT_DIR,
    worktree: { directory: PROJECT_DIR, name: 'none', branch: 'none', status: 'missing' },
    failure: 'session-create-failed',
};

/**
 * Build a host double; only the members a test exercises need overriding.
 *
 * Every default is a neutral, type-correct answer rather than a throw, so a
 * test only fails where it genuinely diverges from the documented behaviour.
 *
 * @param overrides - Members to replace with test behaviour.
 * @returns A complete {@link SpikeHost}.
 */
function fakeHost(overrides: Partial<SpikeHost> = {}): SpikeHost {
    return {
        request: async () => ({ status: DEFAULT_STATUS, body: DEFAULT_BODY }),
        storage: {
            get: async () => null,
            set: () => Promise.resolve(),
            delete: () => Promise.resolve(),
            keys: async () => [],
        },
        openUrl: () => Promise.resolve(),
        startSession: async () => NO_SESSION,
        listProjects: async () => PROJECTS,
        listWorktrees: async () => WORKTREES,
        listSessions: async () => SESSIONS,
        onProjects: async () => IDLE_UNSUBSCRIBE,
        onWorktrees: async () => IDLE_UNSUBSCRIBE,
        onSessions: async () => IDLE_UNSUBSCRIBE,
        onSessionLifecycle: () => IDLE_UNSUBSCRIBE,
        onReady: () => IDLE_UNSUBSCRIBE,
        onSettings: () => IDLE_UNSUBSCRIBE,
        onConnection: () => IDLE_UNSUBSCRIBE,
        dispose: IDLE_UNSUBSCRIBE,
        ...overrides,
    };
}

/**
 * A project listing that fails the way a closed host does.
 *
 * @returns Never resolves; always rejects.
 */
async function offlineProjects(): Promise<GuestProjectsSnapshot> {
    throw new Error('HOST_UNAVAILABLE');
}

/**
 * A worktree listing that fails the way a timed-out host does.
 *
 * @returns Never resolves; always rejects.
 */
async function timedOutWorktrees(): Promise<GuestWorktreesSnapshot> {
    throw new Error('HOST_TIMEOUT');
}

/**
 * A session subscription the user has not granted.
 *
 * @returns Never resolves; always rejects.
 */
async function deniedSessions(): Promise<() => void> {
    throw new Error('NOT_GRANTED');
}

/**
 * Build the validated configuration used across these tests.
 *
 * @returns A complete spike configuration.
 */
function config(overrides: Partial<SpikeConfig> = {}): SpikeConfig {
    return {
        repository: { owner: 'acme', name: 'widget' },
        expectedLogin: LOGIN,
        projectId: PROJECT_ID,
        worktree: { kind: 'generated' },
        pollIntervalMs: DEFAULT_INTERVAL_MS,
        ...overrides,
    };
}

/**
 * Build the matched issue used across these tests.
 *
 * @returns A normalised, matching issue.
 */
function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
    return {
        issueNumber: 7,
        title: 'Fix the flaky test',
        url: ISSUE_URL,
        state: 'open',
        body: 'It fails once in ten runs.',
        assignees: [LOGIN],
        isPullRequest: false,
        ...overrides,
    };
}

/**
 * Build the evidence record for the matched issue.
 *
 * @returns A valid evidence record.
 */
function evidence(): SpikeEvidence {
    return {
        schemaVersion: 'extension-spike-1',
        repository: REPOSITORY,
        issueId: '7',
        issueUrl: ISSUE_URL,
        trigger: 'configured-match',
        authenticatedLogin: LOGIN,
        correlationId: '7b3e2d5a-1c4b-4e8f-9d0a-5c6b7a8f9e01',
        detectedAt: T0,
        panelGeneration: 1,
    };
}

/**
 * Build a host whose subscriptions replay once and record their teardown.
 *
 * @param teardowns - Collector the returned unsubscribe handles append to.
 * @returns A host that behaves like a live, subscribed panel.
 */
function recordingHost(teardowns: string[]): SpikeHost {
    const stopProjects = (): number => teardowns.push('projects');
    const stopWorktrees = (): number => teardowns.push('worktrees');
    const stopSessions = (): number => teardowns.push('sessions');
    const stopLifecycle = (): number => teardowns.push('lifecycle');

    return fakeHost({
        onProjects: async (listener) => {
            listener(PROJECTS);
            return stopProjects;
        },
        onWorktrees: async (projectId, listener) => {
            listener({ ...WORKTREES, projectId });
            return stopWorktrees;
        },
        onSessions: async (projectId, listener) => {
            listener({ ...SESSIONS, projectId });
            return stopSessions;
        },
        onSessionLifecycle: (listener) => {
            listener({ sessionId: SESSION_ID, phase: 'started' });
            return stopLifecycle;
        },
    });
}

describe('resolveProject', () => {
    it('resolves the configured project id', async () => {
        const result = await resolveProject(fakeHost(), PROJECT_ID);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.project.directory).toBe(PROJECT_DIR);
        }
    });

    it('blocks when the project is not registered', async () => {
        const result = await resolveProject(fakeHost(), 'missing-project');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.problem).toContain('missing-project');
            expect(result.available).toEqual([PROJECT_ID]);
        }
    });

    it('blocks when listProjects fails', async () => {
        const host = fakeHost({ listProjects: offlineProjects });
        const result = await resolveProject(host, PROJECT_ID);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.problem).toContain('HOST_UNAVAILABLE');
        }
    });
});

describe('buildBoundedContext', () => {
    it('includes the correlation id, repository, issue, and rule', () => {
        const context = buildBoundedContext({
            repository: REPOSITORY,
            issue: issue(),
            authenticatedLogin: LOGIN,
            correlationId: CONTEXT_CORRELATION,
        });

        expect(context).toContain(`Correlation: ${CONTEXT_CORRELATION}`);
        expect(context).toContain(`Repository: ${REPOSITORY}`);
        expect(context).toContain('Issue #7');
        expect(context).toContain(`Machine account: ${LOGIN}`);
        expect(context).toContain('configured-match');
    });

    it('delimits untrusted issue text', () => {
        const context = buildBoundedContext({
            repository: REPOSITORY,
            issue: issue(),
            authenticatedLogin: LOGIN,
            correlationId: CONTEXT_CORRELATION,
        });

        expect(context).toContain('BEGIN UNTRUSTED ISSUE TEXT');
        expect(context).toContain('END UNTRUSTED ISSUE TEXT');
        expect(context).toContain('It fails once in ten runs.');
    });

    it('stays inside the documented character budget', () => {
        const huge = issue({ body: 'z'.repeat(CONTEXT_MAX_CHARS * 2) });
        const context = buildBoundedContext({
            repository: REPOSITORY,
            issue: huge,
            authenticatedLogin: LOGIN,
            correlationId: CONTEXT_CORRELATION,
        });

        expect(context.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    });

    it('never carries the token or an Authorization header', () => {
        const context = buildBoundedContext({
            repository: REPOSITORY,
            issue: issue(),
            authenticatedLogin: LOGIN,
            correlationId: CONTEXT_CORRELATION,
        });

        expect(context).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
        expect(context).not.toContain('Authorization');
    });
});

describe('buildStartSessionRequest', () => {
    it('carries the project, issue attachment, worktree option, and context', () => {
        const request = buildStartSessionRequest({
            config: config(),
            evidence: evidence(),
            issue: issue(),
            context: CONTEXT_TEXT,
        });

        expect(request.projectId).toBe(PROJECT_ID);
        expect(request.kind).toBe('issue');
        expect(request.id).toBe('issue-7');
        expect(request.url).toBe(ISSUE_URL);
        expect(request.text).toBe(CONTEXT_TEXT);
        expect(request.worktree).toBe(true);
        expect(request.data).toMatchObject({
            schemaVersion: 'extension-spike-1',
            correlationId: '7b3e2d5a-1c4b-4e8f-9d0a-5c6b7a8f9e01',
            issueId: '7',
        });
    });

    it('omits the worktree option when the operator chose none', () => {
        const request = buildStartSessionRequest({
            config: config({ worktree: { kind: 'none' } }),
            evidence: evidence(),
            issue: issue(),
            context: CONTEXT_TEXT,
        });

        expect('worktree' in request).toBe(false);
    });

    it('asks for a named new worktree when configured', () => {
        const request = buildStartSessionRequest({
            config: config({ worktree: { kind: 'new', name: 'spike/dispatch' } }),
            evidence: evidence(),
            issue: issue(),
            context: CONTEXT_TEXT,
        });

        expect(request.worktree).toEqual({ kind: 'new', name: 'spike/dispatch' });
    });

    it('clamps an over-long title', () => {
        const request = buildStartSessionRequest({
            config: config(),
            evidence: evidence(),
            issue: issue({ title: 'x'.repeat(LONG_TITLE) }),
            context: CONTEXT_TEXT,
        });

        expect(request.title.length).toBe(CLAMPED_TITLE);
    });
});

describe('summarizeStartSessionResult', () => {
    it('records a successful dispatch', () => {
        const result: StartSessionResult = {
            sessionId: SESSION_ID,
            sent: 'sent',
            directory: PROJECT_DIR,
            linked: true,
        };

        expect(summarizeStartSessionResult(result)).toEqual({
            sessionId: SESSION_ID,
            sent: 'sent',
            linked: true,
            directory: PROJECT_DIR,
            failure: null,
            worktreeDirectory: null,
            worktreeBranch: null,
            worktreeStatus: null,
        });
    });

    it('records a partial bootstrap failure with the worktree left behind', () => {
        const result: StartSessionResult = {
            sessionId: null,
            sent: 'skipped',
            directory: PROJECT_DIR,
            worktree: { directory: '/tmp/left-behind', name: 'spike', branch: 'spike', status: 'pending' },
            failure: 'bootstrap-failed',
        };
        const summary = summarizeStartSessionResult(result);

        expect(summary).toEqual({
            sessionId: null,
            sent: 'skipped',
            linked: null,
            directory: PROJECT_DIR,
            failure: 'bootstrap-failed',
            worktreeDirectory: '/tmp/left-behind',
            worktreeBranch: 'spike',
            worktreeStatus: 'pending',
        });
    });
});

describe('findDispatchForIssue', () => {
    it('detects an issue that was already dispatched', () => {
        let ledger: SpikeLedger = createLedger({
            correlationId: 'corr',
            panelGeneration: 1,
            storagePresentBeforeMount: false,
            createdAt: T0,
        });
        ledger = appendEntry(ledger, {
            at: '2026-09-26T12:00:01.000Z',
            kind: 'session',
            detail: { issueId: '7', sessionId: SESSION_ID },
        });

        expect(findDispatchForIssue(ledger, '7')).toBe(true);
        expect(findDispatchForIssue(ledger, '8')).toBe(false);
    });

    it('ignores non-session entries', () => {
        const ledger = createLedger({
            correlationId: 'corr',
            panelGeneration: 1,
            storagePresentBeforeMount: false,
            createdAt: T0,
        });

        expect(findDispatchForIssue(ledger, '7')).toBe(false);
    });
});

describe('verifyHostState', () => {
    it('records lists, subscriptions, and lifecycle phases from the host', async () => {
        const teardowns: string[] = [];
        const host = recordingHost(teardowns);

        const verification = await verifyHostState({ host, projectId: PROJECT_ID, waitMs: PROBE_WAIT_MS });

        expect(verification.projectFound).toBe(true);
        expect(verification.projectDirectory).toBe(PROJECT_DIR);
        expect(verification.worktreeCount).toBe(1);
        expect(verification.sessionCount).toBe(0);
        expect(verification.lifecyclePhases).toEqual(['started']);
        expect(verification.problems).toEqual([]);
        expect(verification.probes).toHaveLength(4);
        for (const probe of verification.probes) {
            expect(probe.registered).toBe(true);
            expect(probe.snapshotReplayed).toBe(true);
        }
        expect(teardowns).toHaveLength(4);
        expect(teardowns).toContain('projects');
    });

    it('records a problem when a list call fails', async () => {
        const host = fakeHost({ listWorktrees: timedOutWorktrees });

        const verification = await verifyHostState({ host, projectId: PROJECT_ID, waitMs: PROBE_WAIT_MS });

        expect(verification.problems.join(' ')).toContain('listWorktrees');
        expect(verification.projectFound).toBe(true);
    });

    it('records a problem when a subscription cannot register', async () => {
        const host = fakeHost({ onSessions: deniedSessions });

        const verification = await verifyHostState({ host, projectId: PROJECT_ID, waitMs: PROBE_WAIT_MS });
        const probe = verification.probes.find((candidate) => candidate.surface === 'sessions');

        expect(probe?.registered).toBe(false);
        expect(probe?.error).toContain('NOT_GRANTED');
        expect(verification.problems.join(' ')).toContain('sessions');
    });

    it('flattens to scalar ledger detail', async () => {
        const host = recordingHost([]);
        const verification = await verifyHostState({ host, projectId: PROJECT_ID, waitMs: PROBE_WAIT_MS });
        const detail = summarizeHostVerification(verification);

        expect(detail.projectFound).toBe(true);
        expect(detail.projectId).toBe(PROJECT_ID);
        expect(detail.probesRegistered).toBe(4);
        expect(detail.probesReplayed).toBe(4);
        expect(typeof detail.worktreeBranches).toBe('string');
        expect(detail.problems).toBe('');
    });
});
