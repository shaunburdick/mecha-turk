import { describe, expect, it, vi } from 'vitest';
import type { GuestProjectsSnapshot, JsonValue } from '@openchamber/sdk';
import { applySettings, handlePagehide, loadLedger, selectProject, teardown } from '../extension/src/app.ts';
import { EVIDENCE_STORAGE_KEY, serializeEvidence } from '../extension/src/evidence.ts';
import { parseJsonValue } from '../extension/src/json.ts';
import { LEDGER_STORAGE_KEY, readLedger } from '../extension/src/ledger.ts';
import { startPolling, stopPolling } from '../extension/src/panel-actions.ts';
import { createPanelRuntime } from '../extension/src/panel-state.ts';
import type { PanelRuntime } from '../extension/src/panel-state.ts';
import { PROJECT_STORAGE_KEY } from '../extension/src/project-actions.ts';
import {
    FIXTURE_TIMESTAMP,
    INTERVAL_MS,
    ISSUE_LIST_PATH,
    LOGIN,
    NO_ISSUES,
    PROJECT_DIR,
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

/** Second registered project used by the picker tests. */
const OTHER_ID = 'prj_7';

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

/** Two registered projects, so a pick has somewhere else to go. */
const TWO_PROJECTS: GuestProjectsSnapshot = {
    kind: 'projects',
    state: 'ready',
    projects: [
        { id: PROJECT_ID, name: 'widget', directory: PROJECT_DIR },
        { id: OTHER_ID, name: 'gadget', directory: '/home/agent/acme/gadget' },
    ],
};

/**
 * Load the complete settings record and mark the picker list as loaded.
 *
 * @param runtime - Runtime under test.
 */
function configureWithLoadedProjects(runtime: PanelRuntime): void {
    applySettings(runtime, completeSettings(INTERVAL_MS));
    runtime.state.projects.status = 'ready';
    runtime.state.projects.projects = TWO_PROJECTS.projects;
}

describe('project selection', () => {
    it('resolves the project id from the restored panel selection', () => {
        const runtime = createTestRuntime(fakeHost());
        runtime.state.projectSelection = OTHER_ID;

        applySettings(runtime, completeSettings(INTERVAL_MS));

        expect(runtime.state.config?.projectId).toBe(OTHER_ID);
        expect(runtime.state.status.body).toContain('projectId from the panel picker');
    });

    it('adopts a pick, stores it, and re-resolves the config', async () => {
        const storage = createStorageDouble();
        const runtime = createTestRuntime(
            fakeHost({ storage: storage.storage, listProjects: async () => TWO_PROJECTS }),
        );
        configureWithLoadedProjects(runtime);
        expect(runtime.state.config?.projectId).toBe(PROJECT_ID);

        await selectProject(runtime, OTHER_ID);

        expect(runtime.state.projectSelection).toBe(OTHER_ID);
        expect(runtime.state.config?.projectId).toBe(OTHER_ID);
        expect(storage.values.get(PROJECT_STORAGE_KEY)).toBe(OTHER_ID);
        expect(runtime.state.projects.note).toContain('stored for the next mount');
    });

    it('refuses a pick from outside the loaded list and stores nothing', async () => {
        const storage = createStorageDouble();
        const runtime = createTestRuntime(
            fakeHost({ storage: storage.storage, listProjects: async () => TWO_PROJECTS }),
        );
        configureWithLoadedProjects(runtime);

        await selectProject(runtime, 'prj_invented');

        expect(runtime.state.projectSelection).toBeNull();
        expect(runtime.state.config?.projectId).toBe(PROJECT_ID);
        expect(storage.values.has(PROJECT_STORAGE_KEY)).toBe(false);
        expect(runtime.state.projects.note).toContain('prj_invented');
    });

    it('keeps the pick in memory when the storage write is refused', async () => {
        const storage = createStorageDouble();
        const runtime = createTestRuntime(
            fakeHost({
                storage: {
                    ...storage.storage,
                    set: async () => {
                        throw new Error('storage offline');
                    },
                },
                listProjects: async () => TWO_PROJECTS,
            }),
        );
        configureWithLoadedProjects(runtime);

        await selectProject(runtime, OTHER_ID);

        expect(runtime.state.projectSelection).toBe(OTHER_ID);
        expect(runtime.state.config?.projectId).toBe(OTHER_ID);
        expect(runtime.state.projects.note).toContain('for this session only');
    });
});
