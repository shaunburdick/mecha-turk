import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@openchamber/sdk';
import { applySettings, handlePagehide, loadLedger, teardown } from '../extension/src/app.ts';
import { EVIDENCE_STORAGE_KEY, serializeEvidence } from '../extension/src/evidence.ts';
import { parseJsonValue } from '../extension/src/json.ts';
import { LEDGER_STORAGE_KEY, readLedger } from '../extension/src/ledger.ts';
import { startPolling, stopPolling } from '../extension/src/panel-actions.ts';
import { createPanelRuntime } from '../extension/src/panel-state.ts';
import {
    FIXTURE_TIMESTAMP,
    ISSUE_LIST_PATH,
    LOGIN,
    NO_ISSUES,
    PROJECT_ID,
    REPOSITORY,
    countingRequest,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
    fakeWindow,
    testConfig,
    testEvidence,
} from './support/panel.ts';

/** Interval a settings change switches the running poll timer to. */
const SHORT_INTERVAL_MS = 30_000;

/**
 * Build the complete settings record the spike accepts.
 *
 * The manifest's setting ids are kebab-case, so they travel as string values
 * in a tuple list rather than as object property names — the same convention
 * `tests/config.test.ts` uses.
 *
 * @param intervalMs - Poll interval to publish.
 * @returns Settings ready for {@link applySettings}.
 */
function completeSettings(intervalMs: number): Readonly<Record<string, string>> {
    const entries: readonly (readonly [string, string])[] = [
        ['repository', REPOSITORY],
        ['project-id', PROJECT_ID],
        ['worktree-option', 'generated'],
        ['poll-interval-ms', String(intervalMs)],
    ];

    return Object.fromEntries(entries);
}

describe('teardown', () => {
    it('releases every subscription, the timer, and the host exactly once', () => {
        const frame = fakeWindow();
        let disposes = 0;
        const host = fakeHost({
            dispose: () => {
                disposes += 1;
            },
        });
        const runtime = createPanelRuntime(host, frame.window);
        runtime.state.config = testConfig();
        runtime.state.login = LOGIN;
        const fired: string[] = [];
        runtime.pagehideListener = () => {
            fired.push('pagehide');
        };
        const released: string[] = [];
        runtime.unsubscribes.push(
            () => released.push('projects'),
            () => released.push('sessions'),
        );
        startPolling(runtime);
        expect(runtime.pollTimer).not.toBeNull();

        teardown(runtime);
        teardown(runtime);

        expect(released).toEqual(['projects', 'sessions']);
        expect(fired).toHaveLength(0);
        expect(runtime.unsubscribes).toHaveLength(0);
        expect(runtime.pollTimer).toBeNull();
        expect(runtime.pagehideListener).toBeNull();
        expect(runtime.disposed).toBe(true);
        expect(frame.removed).toEqual(['remove:pagehide']);
        expect(disposes).toBe(1);
    });
});

describe('handlePagehide', () => {
    it('persists the closed phase before tearing the panel down', () => {
        const events: string[] = [];
        const storage = createStorageDouble();
        const frame = fakeWindow();
        const host = fakeHost({
            storage: {
                ...storage.storage,
                set: async (key, value) => {
                    events.push(`set:${key}`);
                    await storage.storage.set(key, value);
                },
            },
            dispose: () => {
                events.push('dispose');
            },
        });
        const runtime = createPanelRuntime(host, frame.window);
        const fired: string[] = [];
        runtime.pagehideListener = () => {
            fired.push('pagehide');
        };

        handlePagehide(runtime);

        expect(events).toEqual([`set:${LEDGER_STORAGE_KEY}`, 'dispose']);
        expect(fired).toHaveLength(0);
        expect(runtime.disposed).toBe(true);
        const stored = readLedger(storage.values.get(LEDGER_STORAGE_KEY));
        expect(stored?.entries.at(-1)?.phase).toBe('closed');
        expect(frame.removed).toEqual(['remove:pagehide']);
    });
});

describe('applySettings', () => {
    it('stops a running poll loop when the settings are incomplete', async () => {
        vi.useFakeTimers();
        const counting = countingRequest({ [ISSUE_LIST_PATH]: NO_ISSUES });
        const runtime = createTestRuntime(fakeHost({ request: counting.request }));

        try {
            startPolling(runtime);
            await vi.advanceTimersByTimeAsync(0);
            expect(runtime.pollTimer).not.toBeNull();

            applySettings(runtime, { repository: '' });

            expect(runtime.state.config).toBeNull();
            expect(runtime.pollTimer).toBeNull();
            expect(runtime.state.status.title).toBe('Configuration incomplete');
        } finally {
            stopPolling(runtime);
            vi.useRealTimers();
        }
    });

    it('restarts a running poll loop when the interval changes', async () => {
        vi.useFakeTimers();
        const counting = countingRequest({ [ISSUE_LIST_PATH]: NO_ISSUES });
        const runtime = createTestRuntime(fakeHost({ request: counting.request }));

        try {
            startPolling(runtime);
            await vi.advanceTimersByTimeAsync(0);
            expect(counting.calls()).toBe(1);

            applySettings(runtime, completeSettings(SHORT_INTERVAL_MS));

            expect(runtime.state.config?.pollIntervalMs).toBe(SHORT_INTERVAL_MS);
            await vi.advanceTimersByTimeAsync(SHORT_INTERVAL_MS);
            expect(counting.calls()).toBe(2);
            await vi.advanceTimersByTimeAsync(SHORT_INTERVAL_MS);
            expect(counting.calls()).toBe(3);
        } finally {
            stopPolling(runtime);
            vi.useRealTimers();
        }
    });
});

describe('loadLedger on remount', () => {
    it('restores the stored evidence record so a reopened panel can dispatch', async () => {
        const evidence = serializeEvidence(testEvidence());
        const storage = createStorageDouble({ [EVIDENCE_STORAGE_KEY]: parseJsonValue(evidence) });
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));
        expect(runtime.state.evidence).toBeNull();

        await loadLedger(runtime, FIXTURE_TIMESTAMP);

        expect(runtime.state.evidence).toEqual(testEvidence());
        expect(runtime.state.ledger.panelGeneration).toBe(1);
        expect(runtime.state.ledger.entries.at(-1)?.phase).toBe('mounted');
        expect(storage.values.has(LEDGER_STORAGE_KEY)).toBe(true);
    });

    it('refuses a stored evidence record that does not match the contract', async () => {
        const broken: JsonValue = { schemaVersion: 'extension-spike-1', repository: 42 };
        const storage = createStorageDouble({ [EVIDENCE_STORAGE_KEY]: broken });
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));

        await loadLedger(runtime, FIXTURE_TIMESTAMP);

        expect(runtime.state.evidence).toBeNull();
        expect(runtime.state.ledger.entries.at(-1)?.phase).toBe('mounted');
    });
});
