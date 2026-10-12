import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@openchamber/sdk';
import {
    applySettings,
    handlePagehide,
    loadLedger,
    teardown,
} from '../src/app.ts';
import { loadInitialBindings } from '../src/bindings-mode.ts';
import { EVIDENCE_STORAGE_KEY, serializeEvidence } from '../src/evidence.ts';
import { parseJsonValue } from '../src/json.ts';
import { LEDGER_STORAGE_KEY, readLedger } from '../src/ledger.ts';
import { createPanelRuntime } from '../src/panel-state.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import {
    FIXTURE_TIMESTAMP,
    hasNothingToRelease,
    LOGIN,
    PROJECT_ID,
    REPOSITORY,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
    fakeWindow,
    testConfig,
    testEvidence,
    tick,
} from './support/panel.ts';

/** Banner a panel with no dispatch context shows (002 FR-041). */
const WAITING_FOR_BINDING = 'Waiting for a binding';

/**
 * Collect every panel-source line that still *calls* machinery the
 * product-owner sweep retired (2026-09-30): the single-repo poll starters,
 * the poll itself, the integration card's `/user` identity diagnostic, and
 * the connection handler that drove them. The card, its badge, and its
 * diagnostic are gone, so any call site here is a regression rather than a
 * dormant path — the identifiers no longer even exist to be called.
 *
 * @returns One `file: line` entry per call site found under `src/`.
 */
function retiredSpikeCallers(): readonly string[] {
    const root = resolvePath(import.meta.dirname, '..');
    const callSite = /\b(?:startPolling|restartPolling|runPoll|ensureIdentity|handleConnection|onConnection)\s*\(/;
    const modules = readdirSync(resolvePath(root, 'src'), { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith('.ts'));
    const callers: string[] = [];
    for (const name of modules) {
        const lines = readFileSync(resolvePath(root, 'src', name), 'utf8').split('\n');
        for (const line of lines) {
            if (callSite.test(line)) {
                callers.push(`${name}: ${line.trim()}`);
            }
        }
    }

    return callers;
}

/**
 * Build a settings record.
 *
 * The manifest declares zero settings (002 FR-041), so a record is an inert
 * snapshot: it exists on the runtime only as the "the host is ready" marker
 * prerequisites reads. These helpers keep that fact visible in the tests that
 * feed one.
 *
 * @returns A settings record ready for {@link applySettings}.
 */
function settingsOf(entries: readonly (readonly [string, string])[] = []): Readonly<Record<string, string>> {
    return Object.fromEntries(entries);
}

/**
 * Build one enabled service binding, as `GET /v1/bindings` answers.
 */
function activeBinding(): PanelBinding {
    return {
        bindingId: 'bnd-fixture-1',
        accountNumericUserId: '77331',
        accountLogin: LOGIN,
        repository: REPOSITORY,
        projectId: PROJECT_ID,
        worktreeOption: 'generated',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
    };
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
        // The one loop the panel owns at teardown is the relay's (FR-018);
        // arm it by hand so "no timer survives teardown" is about the loop
        // that actually exists rather than a retired one.
        runtime.state.relay.timer = setInterval(hasNothingToRelease, 60_000);
        const fired: string[] = [];
        runtime.pagehideListener = () => {
            fired.push('pagehide');
        };
        const released: string[] = [];
        runtime.unsubscribes.push(
            () => void released.push('projects'),
            () => void released.push('sessions'),
        );

        teardown(runtime);
        teardown(runtime);

        expect(released).toEqual(['projects', 'sessions']);
        expect(fired).toHaveLength(0);
        expect(runtime.unsubscribes).toHaveLength(0);
        expect(runtime.state.relay.timer).toBeNull();
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
    it('records the snapshot and waits for a binding when none is active', () => {
        {
            const runtime = createTestRuntime(fakeHost());

            applySettings(runtime, settingsOf());

            // 002 FR-041: the card declares zero settings, so the snapshot is a
            // readiness marker and never a configuration source.
            expect(runtime.state.settings).toEqual({});
            expect(runtime.state.config).toBeNull();
            expect(runtime.state.status.tone).toBe('info');
            expect(runtime.state.status.title).toBe(WAITING_FOR_BINDING);
        }
        {
            const runtime = createTestRuntime(fakeHost());
            const cardShaped = settingsOf([
                ['repository', REPOSITORY],
                ['project-id', PROJECT_ID],
                ['worktree-option', 'generated'],
                ['poll-interval-ms', '45000'],
                ['expected-login', LOGIN],
                ['expected-agent', 'planner'],
            ]);

            applySettings(runtime, cardShaped);

            expect(runtime.state.config).toBeNull();
            expect(runtime.state.status.title).toBe(WAITING_FOR_BINDING);
        }
        {
            const runtime = createTestRuntime(fakeHost());
            runtime.state.bindings.bindings = [activeBinding()];
            runtime.state.bindingsActive = 1;

            // No `repository` setting at all: the retired legacy parse would have
            // refused with "repository must be owner/name…", but the binding is
            // authoritative and always was.
            applySettings(runtime, settingsOf([['project-id', PROJECT_ID]]));

            expect(runtime.state.status.tone).toBe('info');
            expect(runtime.state.status.body).toBe('1 binding(s) active; legacy single-repo settings ignored');
            expect(runtime.state.config).not.toBeNull();
            expect(runtime.state.config?.repository).toEqual({ owner: 'acme', name: 'widget' });
            expect(runtime.state.config?.projectId).toBe(PROJECT_ID);
            expect(runtime.state.config?.worktree).toEqual({ kind: 'generated' });
        }
    });
});

describe('the install-time GitHub card is retired, not dormant (owner order 2026-09-30)', () => {
    it('keeps the retired card, poll, and connection machinery unreachable from panel source', async () => {
        {
            expect(retiredSpikeCallers()).toEqual([]);
        }
    });

    it('arms the relay from the bindings read, which needs no connection event', async () => {
        {
            const runtime = createTestRuntime(fakeHost());
            runtime.state.bindings.bindings = [activeBinding()];
            runtime.state.bindings.status = 'ready';

            await loadInitialBindings(runtime);
            await tick();

            expect(runtime.relayArmed).toBe(true);
            expect(runtime.state.relay.timer).not.toBeNull();
        }
    });

});

describe('loadLedger on remount', () => {
    it('restores the stored evidence record so a reopened panel can dispatch', async () => {
        {
            const evidence = serializeEvidence(testEvidence());
            const storage = createStorageDouble({ [EVIDENCE_STORAGE_KEY]: parseJsonValue(evidence) });
            const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));
            expect(runtime.state.evidence).toBeNull();

            await loadLedger(runtime, FIXTURE_TIMESTAMP);

            expect(runtime.state.evidence).toEqual(testEvidence());
            expect(runtime.state.ledger.panelGeneration).toBe(1);
            expect(runtime.state.ledger.entries.at(-1)?.phase).toBe('mounted');
            expect(storage.values.has(LEDGER_STORAGE_KEY)).toBe(true);
        }
    });

    it('refuses a stored evidence record that does not match the contract', async () => {
        {
            const broken: JsonValue = { schemaVersion: 'extension-spike-1', repository: 42 };
            const storage = createStorageDouble({ [EVIDENCE_STORAGE_KEY]: broken });
            const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));

            await loadLedger(runtime, FIXTURE_TIMESTAMP);

            expect(runtime.state.evidence).toBeNull();
            expect(runtime.state.ledger.entries.at(-1)?.phase).toBe('mounted');
        }
    });

});
