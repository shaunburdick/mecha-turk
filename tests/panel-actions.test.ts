import { describe, expect, it, vi } from 'vitest';
import { EVIDENCE_STORAGE_KEY, EvidenceError } from '../extension/src/evidence.ts';
import { appendEntry, LEDGER_STORAGE_KEY, readLedger } from '../extension/src/ledger.ts';
import {
    ensureIdentity,
    persistLedger,
    recordFailure,
    restartPolling,
    runPoll,
    startPolling,
    stopPolling,
} from '../extension/src/panel-actions.ts';
import { RedactionError } from '../extension/src/redaction.ts';
import {
    FIXTURE_TIMESTAMP,
    ISSUE_LIST_PATH,
    ISSUE_URL,
    LOGIN,
    NO_ISSUES,
    USER_PATH,
    USER_RESPONSE,
    countingRequest,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
    githubIssuePayload,
    requestDouble,
    testConfig,
    tick,
} from './support/panel.ts';

/** Correlation identifier used by the direct `recordFailure` calls. */
const CORRELATION = '9c1f1f0a-0d2e-4a4e-9a0a-1d2b3c4d5e6f';

/** Correlation identifier used by the ledger fixtures in this file. */
const LEDGER_CORRELATION = '2f6a4f0e-1e4c-4a6f-8a3a-0b1c2d3e4f50';

/** Poll interval the timer tests start polling with. */
const START_INTERVAL_MS = 60_000;

/** Poll interval a settings change switches the running timer to. */
const NEW_INTERVAL_MS = 30_000;

/**
 * Wrap serialized issues in the JSON array the list endpoint returns.
 *
 * @param payloads - Serialized issue documents.
 * @returns The response body for the issue-list endpoint.
 */
function issueListBody(payloads: readonly string[]): string {
    return `[${payloads.join(',')}]`;
}

describe('runPoll', () => {
    it('ignores a second poll while one is in flight', async () => {
        const counting = countingRequest({ [ISSUE_LIST_PATH]: NO_ISSUES });
        const runtime = createTestRuntime(fakeHost({ request: counting.request }));

        await Promise.all([runPoll(runtime), runPoll(runtime)]);
        await tick();

        expect(counting.calls()).toBe(1);
        expect(runtime.pollInFlight).toBe(false);
        const polls = runtime.state.ledger.entries.filter((entry) => entry.kind === 'poll');
        expect(polls).toHaveLength(1);
    });

    it('records a failed poll as a poll entry instead of throwing', async () => {
        const runtime = createTestRuntime(fakeHost());

        await expect(runPoll(runtime)).resolves.toBeUndefined();
        await tick();

        expect(runtime.pollInFlight).toBe(false);
        expect(runtime.state.status.title).toBe('Request failed');
        const last = runtime.state.ledger.entries.at(-1);
        expect(last?.kind).toBe('poll');
        expect(last?.detail.httpStatus).toBe(404);
        expect(String(last?.detail.error)).toContain('GitHubApiError');
    });

    it('accepts exactly one matching issue and records its evidence', async () => {
        const answers = { [ISSUE_LIST_PATH]: issueListBody([githubIssuePayload({ assignees: [LOGIN] })]) };
        const storage = createStorageDouble();
        const runtime = createTestRuntime(fakeHost({ request: requestDouble(answers), storage: storage.storage }));

        await runPoll(runtime);
        await tick();

        expect(runtime.state.match?.issueNumber).toBe(7);
        expect(runtime.state.evidence?.issueUrl).toBe(ISSUE_URL);
        expect(runtime.state.status.title).toBe('Matched issue');
        expect(storage.values.has(EVIDENCE_STORAGE_KEY)).toBe(true);

        const evidenceEntry = runtime.state.ledger.entries.find((entry) => entry.kind === 'evidence');
        expect(evidenceEntry?.detail.issueUrl).toBe(ISSUE_URL);
    });

    it('refuses an ambiguous window without recording evidence', async () => {
        const answers = {
            [ISSUE_LIST_PATH]: issueListBody([
                githubIssuePayload({ assignees: [LOGIN] }),
                githubIssuePayload({ issueNumber: 8, assignees: [LOGIN] }),
            ]),
        };
        const storage = createStorageDouble();
        const runtime = createTestRuntime(fakeHost({ request: requestDouble(answers), storage: storage.storage }));

        await runPoll(runtime);
        await tick();

        expect(runtime.state.match).toBeNull();
        expect(runtime.state.status.title).toBe('Ambiguous match');
        expect(storage.values.has(EVIDENCE_STORAGE_KEY)).toBe(false);

        const poll = runtime.state.ledger.entries.find((entry) => entry.kind === 'poll');
        expect(poll?.detail.matched).toBe(2);
        const ambiguous = runtime.state.ledger.entries.find((entry) => entry.kind === 'match');
        expect(ambiguous?.detail.problem).toBe('ambiguous-match');
    });

    it('leaves the panel without evidence when the evidence write fails', async () => {
        const answers = { [ISSUE_LIST_PATH]: issueListBody([githubIssuePayload({ assignees: [LOGIN] })]) };
        const storage = createStorageDouble();
        const guarded: typeof storage.storage = {
            ...storage.storage,
            set: async (key, value) => {
                if (key === EVIDENCE_STORAGE_KEY) {
                    throw new Error('STORAGE_FULL');
                }

                await storage.storage.set(key, value);
            },
        };
        const runtime = createTestRuntime(fakeHost({ request: requestDouble(answers), storage: guarded }));

        await runPoll(runtime);
        await tick();

        expect(runtime.state.evidence).toBeNull();
        expect(runtime.state.match).toBeNull();
        expect(runtime.state.status.title).toBe('Evidence write failed');
    });
});

describe('ensureIdentity', () => {
    it('blocks on an identity that does not match the expectation', async () => {
        const host = fakeHost({ request: requestDouble({ [USER_PATH]: USER_RESPONSE }) });
        const runtime = createTestRuntime(host);
        runtime.state.login = null;
        runtime.state.config = testConfig({ expectedLogin: 'someone-else' });

        await ensureIdentity(runtime);
        await tick();

        expect(runtime.state.login).toBeNull();
        expect(runtime.state.status.title).toBe('Identity check failed');
        expect(runtime.pollTimer).toBeNull();
        const identity = runtime.state.ledger.entries.at(-1);
        expect(identity?.kind).toBe('identity');
        expect(String(identity?.detail.problem)).toContain('does not match');
    });

    it('records the machine account and starts polling when it matches', async () => {
        const answers = { [USER_PATH]: USER_RESPONSE, [ISSUE_LIST_PATH]: NO_ISSUES };
        const runtime = createTestRuntime(fakeHost({ request: requestDouble(answers) }));
        runtime.state.login = null;

        try {
            await ensureIdentity(runtime);

            expect(runtime.state.login).toBe(LOGIN);
            expect(runtime.state.status.title).toBe('Authenticated');
            expect(runtime.pollTimer).not.toBeNull();
            const identity = runtime.state.ledger.entries.at(-1);
            expect(identity?.kind).toBe('identity');
            expect(identity?.detail.authenticatedLogin).toBe(LOGIN);
        } finally {
            stopPolling(runtime);
        }
    });
});

describe('poll timer', () => {
    it('re-arms a running timer when the interval setting changes', async () => {
        vi.useFakeTimers();
        const counting = countingRequest({ [ISSUE_LIST_PATH]: NO_ISSUES });
        const runtime = createTestRuntime(fakeHost({ request: counting.request }));
        runtime.state.config = testConfig({ pollIntervalMs: START_INTERVAL_MS });

        try {
            expect(restartPolling(runtime)).toBe(false);

            startPolling(runtime);
            await vi.advanceTimersByTimeAsync(0);
            expect(counting.calls()).toBe(1);

            runtime.state.config = testConfig({ pollIntervalMs: NEW_INTERVAL_MS });
            expect(restartPolling(runtime)).toBe(true);

            await vi.advanceTimersByTimeAsync(NEW_INTERVAL_MS);
            expect(counting.calls()).toBe(2);
            await vi.advanceTimersByTimeAsync(NEW_INTERVAL_MS);
            expect(counting.calls()).toBe(3);
        } finally {
            stopPolling(runtime);
            vi.useRealTimers();
        }
    });
});

describe('persistLedger recovery', () => {
    it('quarantines a secret-shaped entry and keeps the ledger writable', async () => {
        const token = `ghp_${'a'.repeat(40)}`;
        const storage = createStorageDouble();
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));
        runtime.state.ledger = appendEntry(runtime.state.ledger, {
            at: FIXTURE_TIMESTAMP,
            kind: 'error',
            correlationId: LEDGER_CORRELATION,
            detail: { note: token },
        });

        await persistLedger(runtime);
        await tick();

        expect(runtime.state.status.title).toBe('Ledger repaired');
        const stored = readLedger(storage.values.get(LEDGER_STORAGE_KEY));
        expect(stored?.entries.at(-1)?.detail.note).toBe('[redacted:github-token-classic]');
        expect(JSON.stringify(stored)).not.toContain(token);

        runtime.state.ledger = appendEntry(runtime.state.ledger, {
            at: FIXTURE_TIMESTAMP,
            kind: 'poll',
            correlationId: LEDGER_CORRELATION,
            detail: { inspected: 1 },
        });
        await persistLedger(runtime);
        await tick();

        const after = readLedger(storage.values.get(LEDGER_STORAGE_KEY));
        expect(after?.entries.at(-1)?.kind).toBe('poll');
        expect(after?.entries).toHaveLength(runtime.state.ledger.entries.length);
    });
});

describe('recordFailure', () => {
    it('names evidence and redaction failures instead of blaming the request', () => {
        const storage = createStorageDouble();
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));

        recordFailure(runtime, { kind: 'match', cause: new EvidenceError('bad evidence'), correlationId: CORRELATION });
        expect(runtime.state.status.title).toBe('Evidence rejected');

        const refusal = new RedactionError('ledger', 'github-token-classic');
        recordFailure(runtime, { kind: 'session', cause: refusal, correlationId: CORRELATION });
        expect(runtime.state.status.title).toBe('Redaction refused the write');

        recordFailure(runtime, { kind: 'poll', cause: new Error('boom'), correlationId: CORRELATION });
        expect(runtime.state.status.title).toBe('Request failed');
    });

    it('keeps the recorded detail redacted for every failure kind', async () => {
        const storage = createStorageDouble();
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));

        recordFailure(runtime, { kind: 'poll', cause: new Error('boom'), correlationId: CORRELATION });
        await tick();

        const stored = readLedger(storage.values.get(LEDGER_STORAGE_KEY));
        expect(stored?.entries.at(-1)?.detail.correlationId).toBe(CORRELATION);
    });
});
