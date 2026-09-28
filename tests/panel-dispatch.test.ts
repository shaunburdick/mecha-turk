import { describe, expect, it } from 'vitest';
import type { StartSessionRequest, StartSessionResult } from '@openchamber/sdk';
import { LEDGER_STORAGE_KEY } from '../src/ledger.ts';
import { startDispatch } from '../src/panel-dispatch.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { findDispatchForIssue } from '../src/session.ts';
import {
    ISSUE_DETAIL_PATH,
    LOGIN,
    PROJECTS,
    SESSION_CREATED,
    SESSION_ID,
    createStorageDouble,
    createDispatchRuntime,
    fakeHost,
    githubIssuePayload,
    requestDouble,
    tick,
} from './support/panel.ts';

/** Banner title the panel shows after `startSession` created a session. */
const STARTED_TITLE = 'Session started';

/**
 * Build a path-to-body table whose issue source still matches the rule.
 *
 * @returns Answers for the fixture issue's detail endpoint.
 */
function matchingAnswers(): Record<string, string> {
    return { [ISSUE_DETAIL_PATH]: githubIssuePayload({ assignees: [LOGIN] }) };
}

/** Counter plus the `startSession` double the dispatch tests assert on. */
interface DispatchCounter {
    /** Host member that records how often a session was requested. */
    readonly startSession: (request: StartSessionRequest) => Promise<StartSessionResult>;
    /** Number of `host.startSession()` calls observed so far. */
    readonly calls: () => number;
}

/**
 * Build a `startSession` double that always creates the fixture session.
 *
 * @returns The double plus a reader for its call count.
 */
function sessionCounter(): DispatchCounter {
    let calls = 0;

    return {
        startSession: async () => {
            calls += 1;
            return SESSION_CREATED;
        },
        calls: () => calls,
    };
}

/**
 * Wait for the dispatch and the fire-and-forget ledger write to settle.
 *
 * @param runtime - Runtime the dispatch ran against.
 * @param attempts - Number of dispatch attempts to run.
 */
async function dispatchAndSettle(runtime: PanelRuntime, attempts: number): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        await startDispatch(runtime);
        await tick();
    }
}

describe('dispatch idempotency', () => {
    it('project unresolved then retry succeeds', async () => {
        let registered = false;
        const counter = sessionCounter();
        const storage = createStorageDouble();
        const host = fakeHost({
            listProjects: async () => (registered ? PROJECTS : { ...PROJECTS, projects: [] }),
            request: requestDouble(matchingAnswers()),
            startSession: counter.startSession,
            storage: storage.storage,
        });
        const runtime = createDispatchRuntime(host);

        await dispatchAndSettle(runtime, 1);

        expect(counter.calls()).toBe(0);
        expect(runtime.state.status.title).toBe('Project unresolved');
        expect(findDispatchForIssue(runtime.state.ledger, '7')).toBe(false);

        registered = true;
        await dispatchAndSettle(runtime, 1);

        expect(counter.calls()).toBe(1);
        expect(findDispatchForIssue(runtime.state.ledger, '7')).toBe(true);
        expect(runtime.state.status.title).toBe(STARTED_TITLE);
        expect(storage.values.has(LEDGER_STORAGE_KEY)).toBe(true);
    });

    it('source-changed then re-match dispatches', async () => {
        const answers = { [ISSUE_DETAIL_PATH]: githubIssuePayload({ assignees: [] }) };
        const counter = sessionCounter();
        const host = fakeHost({
            request: requestDouble(answers),
            startSession: counter.startSession,
        });
        const runtime = createDispatchRuntime(host);

        await dispatchAndSettle(runtime, 1);

        expect(counter.calls()).toBe(0);
        expect(runtime.state.status.title).toBe('Source changed');
        expect(findDispatchForIssue(runtime.state.ledger, '7')).toBe(false);

        answers[ISSUE_DETAIL_PATH] = githubIssuePayload({ assignees: [LOGIN] });
        await dispatchAndSettle(runtime, 1);

        expect(counter.calls()).toBe(1);
        expect(findDispatchForIssue(runtime.state.ledger, '7')).toBe(true);
        expect(runtime.state.status.title).toBe(STARTED_TITLE);
    });

    it('records a failed startSession without blocking the next attempt', async () => {
        const failure: StartSessionResult = {
            sessionId: null,
            sent: 'skipped',
            directory: '/tmp/left-behind',
            worktree: { directory: '/tmp/left-behind', name: 'spike', branch: 'spike', status: 'pending' },
            failure: 'bootstrap-failed',
        };
        let calls = 0;
        const host = fakeHost({
            request: requestDouble(matchingAnswers()),
            startSession: async () => {
                calls += 1;
                return calls === 1 ? failure : SESSION_CREATED;
            },
        });
        const runtime = createDispatchRuntime(host);

        await dispatchAndSettle(runtime, 1);

        expect(calls).toBe(1);
        expect(findDispatchForIssue(runtime.state.ledger, '7')).toBe(false);
        expect(runtime.state.status.title).toBe('Session not created');

        await dispatchAndSettle(runtime, 1);

        expect(calls).toBe(2);
        expect(findDispatchForIssue(runtime.state.ledger, '7')).toBe(true);
        expect(runtime.state.status.title).toBe(STARTED_TITLE);
    });

    it('refuses a second dispatch once the session exists', async () => {
        const counter = sessionCounter();
        const host = fakeHost({
            request: requestDouble(matchingAnswers()),
            startSession: counter.startSession,
        });
        const runtime = createDispatchRuntime(host);

        await dispatchAndSettle(runtime, 2);

        expect(counter.calls()).toBe(1);
        expect(runtime.state.status.title).toBe('Already dispatched');
        expect(findDispatchForIssue(runtime.state.ledger, '7')).toBe(true);
        expect(runtime.state.ledger.entries.at(-1)?.detail.sessionId).toBe(SESSION_ID);
    });
});
