import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuestProjectsSnapshot, JsonValue } from '@openchamber/sdk';
import {
    applySettings,
    handleConnection,
    handlePagehide,
    loadLedger,
    selectProject,
    teardown,
} from '../src/app.ts';
import { loadInitialBindings } from '../src/bindings-mode.ts';
import { drainVerifications } from '../src/agent-verify.ts';
import { dispatchClaimedRun } from '../src/relay.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import { ACCOUNTS_PATH, BINDINGS_PATH } from '../src/service-calls.ts';
import { EVIDENCE_STORAGE_KEY, serializeEvidence } from '../src/evidence.ts';
import { parseJsonValue } from '../src/json.ts';
import { LEDGER_STORAGE_KEY, readLedger } from '../src/ledger.ts';
import { startPolling } from '../src/panel-actions.ts';
import { createPanelRuntime } from '../src/panel-state.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { PROJECT_STORAGE_KEY } from '../src/project-actions.ts';
import { selectedProjectId } from '../src/project-picker.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import type { ClaimedRun } from '../src/claim-service.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import { fakeDom } from './support/dom.ts';
import {
    FIXTURE_TIMESTAMP,
    ISSUE_URL,
    LOGIN,
    PROJECT_DIR,
    PROJECT_ID,
    REPOSITORY,
    SESSION_CREATED,
    SESSION_ID,
    USER_PATH,
    USER_RESPONSE,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
    fakeWindow,
    requestDouble,
    testConfig,
    testEvidence,
    tick,
} from './support/panel.ts';

/**
 * Paint and dispose counts for the SDK primitives this file stubs (FR-017).
 *
 * The relay-ownership test mounts the real six-tab shell against the panel's
 * DOM double, where there is no document for the real primitives to build in —
 * so every SDK `mount*` becomes a counting handle instead. Counting rather
 * than no-oping keeps "mounted" distinguishable from "constructed".
 */
const sdkPaints = vi.hoisted(() => ({ paints: 0, disposes: 0 }));

/**
 * One stubbed SDK handle: it counts instead of painting a real node.
 *
 * A function declaration rather than an arrow inside the mock factory, so the
 * factory can call it while the module graph is still being evaluated.
 *
 * @returns The handle every `mount*` primitive answers with here.
 */
function sdkHandle(): { update: () => void; dispose: () => void } {
    return {
        update: () => {
            sdkPaints.paints += 1;
        },
        dispose: () => {
            sdkPaints.disposes += 1;
        },
    };
}

/** Counts an inert picker callback so no stub body is ever empty. */
function inertHandler(): void {
    sdkPaints.paints += 1;
}

/** Count one released host subscription; the double never really holds one. */
function countRelease(): void {
    sdkPaints.disposes += 1;
}

/** Count one opened session context switch. */
async function countOpen(): Promise<void> {
    sdkPaints.paints += 1;
}

/**
 * Replace every SDK `mount*` primitive with a counting handle.
 *
 * Everything else on the module passes through, so the rest of this file —
 * which never mounts a body — sees the real exports it already asserts on.
 */
vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = sdkHandle;
        }
    }

    return stubbed;
});

/** Second registered project used by the picker tests. */
const OTHER_ID = 'prj_7';

/** Banner a panel with no dispatch context shows (002 FR-041). */
const WAITING_FOR_BINDING = 'Waiting for a binding';

/**
 * Collect every panel-source line that *calls* a retired single-repo poll starter.
 *
 * `startPolling` and `restartPolling` stay exported machinery that the tests
 * drive, but no production line may call one: `ensureIdentity` was their only
 * caller, and 005 T-035 restored the card's identity diagnostic **without**
 * its poll start (005 T-011, 002 FR-011(b)). The declaration line itself does
 * not count — a definition is not a call site.
 *
 * @returns One `file: line` entry per call site found under `src/`.
 */
function legacyPollCallers(): readonly string[] {
    const root = resolvePath(import.meta.dirname, '..');
    const callSite = /(^|\s)(?:startPolling|restartPolling)\s*\(/;
    const declaration = /export function (?:startPolling|restartPolling)\s*\(/;
    const modules = readdirSync(resolvePath(root, 'src'), { recursive: true }).map(String);
    const callers: string[] = [];
    for (const name of modules.filter((entry) => entry.endsWith('.ts'))) {
        const lines = readFileSync(resolvePath(root, 'src', name), 'utf8').split('\n');
        for (const line of lines) {
            if (callSite.test(line) && !declaration.test(line)) {
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
 * @param entries - Setting id and value pairs, if any.
 * @returns A settings record ready for {@link applySettings}.
 */
function settingsOf(entries: readonly (readonly [string, string])[] = []): Readonly<Record<string, string>> {
    return Object.fromEntries(entries);
}

/**
 * Build one enabled service binding, as `GET /v1/bindings` answers.
 *
 * @returns A binding row matching the panel test fixtures.
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
    it('records the snapshot and waits for a binding when none is active', () => {
        const runtime = createTestRuntime(fakeHost());

        applySettings(runtime, settingsOf());

        // 002 FR-041: the card declares zero settings, so the snapshot is a
        // readiness marker and never a configuration source.
        expect(runtime.state.settings).toEqual({});
        expect(runtime.state.config).toBeNull();
        expect(runtime.state.status.tone).toBe('info');
        expect(runtime.state.status.title).toBe(WAITING_FOR_BINDING);
        expect(runtime.state.status.body).toContain('integration card declares no settings');
    });

    it('takes no configuration from a record that still carries the card ids', () => {
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
    });

    it('does not block while a binding is active', () => {
        const runtime = createTestRuntime(fakeHost());
        runtime.state.bindings.bindings = [activeBinding()];
        runtime.state.bindingsActive = 1;

        // No `repository` setting at all: the retired legacy parse would have
        // refused with "repository must be owner/name…", but the binding is
        // authoritative and always was.
        applySettings(runtime, settingsOf([['project-id', PROJECT_ID]]));

        expect(runtime.state.status.tone).toBe('info');
        expect(runtime.state.status.title).toBe('Bindings active');
        expect(runtime.state.status.body).toBe('1 binding(s) active; legacy single-repo settings ignored');
        expect(runtime.state.config).not.toBeNull();
        expect(runtime.state.config?.repository).toEqual({ owner: 'acme', name: 'widget' });
        expect(runtime.state.config?.projectId).toBe(PROJECT_ID);
        expect(runtime.state.config?.worktree).toEqual({ kind: 'generated' });
    });
});

describe('handleConnection (FR-011 optional integration card)', () => {
    it('steers the unconnected banner to the service-account flow, not the integration card', () => {
        const runtime = createTestRuntime(fakeHost());

        handleConnection(runtime, false);

        // The card is optional, non-authoritative, and (since 002 FR-041)
        // declares no settings at all: the banner stops any lingering poll
        // timer, points at the account flow the product actually polls under,
        // and does not steer the operator toward a credential surface.
        expect(runtime.state.connected).toBe(false);
        expect(runtime.pollTimer).toBeNull();
        expect(runtime.state.status.tone).toBe('warning');
        expect(runtime.state.status.title).toBe('No account connected');
        expect(runtime.state.status.body).toContain('Accounts');
        expect(runtime.state.status.body).toContain('Bindings → Poll as account');
        expect(runtime.state.status.body).toContain('optional GitHub (token) integration card');
        expect(runtime.state.status.body).not.toContain('Settings → Integrations');
    });

    it('arms no single-repo poll when a card is connected but no binding exists', () => {
        const runtime = createTestRuntime(fakeHost());
        // Mount state: no binding has answered yet, so no dispatch context.
        runtime.state.config = null;

        handleConnection(runtime, true);

        expect(runtime.state.connected).toBe(true);
        expect(runtime.state.config).toBeNull();
        expect(runtime.pollTimer).toBeNull();
        expect(runtime.state.status.tone).toBe('info');
        expect(runtime.state.status.title).toBe('Connected');
        expect(runtime.state.status.body).toContain(WAITING_FOR_BINDING);
    });

    it('runs the card’s read-only identity diagnostic on connect and reports its outcome', async () => {
        const runtime = createTestRuntime(fakeHost({ request: requestDouble({ [USER_PATH]: USER_RESPONSE }) }));
        runtime.state.config = null;
        runtime.state.login = null;

        handleConnection(runtime, true);
        await tick();

        expect(runtime.state.login).toBe(LOGIN);
        expect(runtime.state.status.tone).toBe('info');
        expect(runtime.state.status.title).toBe('Authenticated');
        expect(runtime.state.status.body).toBe(`Machine account: ${LOGIN}`);
        expect(runtime.state.ledger.entries.at(-1)?.kind).toBe('identity');
        // 002 FR-011(b) makes the diagnostic *read-only*: restoring it (005
        // T-035) must leave the retired single-repo arming path unreachable.
        expect(runtime.pollTimer).toBeNull();
        expect(runtime.state.config).toBeNull();
    });

    it('lands a refused identity read on the banner without arming a poll', async () => {
        // The default host double answers every path 404, which is what an
        // unconfigured integration card looks like to `/user`.
        const runtime = createTestRuntime(fakeHost());
        runtime.state.config = null;
        runtime.state.login = null;

        handleConnection(runtime, true);
        await tick();

        expect(runtime.state.login).toBeNull();
        expect(runtime.state.status.tone).toBe('error');
        expect(runtime.state.status.title).toBe('Request failed');
        expect(runtime.pollTimer).toBeNull();
    });

    it('keeps the retired poll starters unreachable from panel source (T-011 stands)', () => {
        expect(legacyPollCallers()).toEqual([]);
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
 * Mark the picker list as loaded, with the host's settings snapshot recorded.
 *
 * @param runtime - Runtime under test.
 */
function configureWithLoadedProjects(runtime: PanelRuntime): void {
    applySettings(runtime, settingsOf());
    runtime.state.projects.status = 'ready';
    runtime.state.projects.projects = TWO_PROJECTS.projects;
}

describe('project selection', () => {
    it('records the restored panel selection as this mount’s choice', () => {
        const runtime = createTestRuntime(fakeHost());
        runtime.state.projectSelection = OTHER_ID;

        applySettings(runtime, settingsOf());

        expect(runtime.state.projectSelection).toBe(OTHER_ID);
        expect(selectedProjectId(runtime.state)).toBe(OTHER_ID);
        // 002 FR-041: settings resolve nothing, so no config appears from one.
        expect(runtime.state.config).toBeNull();
    });

    it('adopts a pick and stores it', async () => {
        const storage = createStorageDouble();
        const runtime = createTestRuntime(
            fakeHost({ storage: storage.storage, listProjects: async () => TWO_PROJECTS }),
        );
        configureWithLoadedProjects(runtime);

        await selectProject(runtime, OTHER_ID);

        expect(runtime.state.projectSelection).toBe(OTHER_ID);
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
        expect(runtime.state.projects.note).toContain('for this session only');
    });
});

describe('relay ownership across a tab switch (005 T-019, FR-018, AC-136, SC-108)', () => {
    /** Correlation identifier the fixture dispatch carries. */
    const CORRELATION = 'mt-run-0123456789abcdef01234567';

    /** Single-use dispatch token the reserve answers with. */
    const TOKEN = `dtk-${'f00df00d'.repeat(4)}`;

    /** Lease identifier the claim carries. */
    const LEASE_ID = 'lease_fixture';

    /** Correlation identifier every test in this suite asserts on. */
    const RUN_KEY = 'github|77331|acme/widget|issue|7|0';

    /**
     * The one claimed run the mid-flight dispatch drives.
     *
     * @returns The claim, keyed to the fixture binding the gate requires.
     */
    function claim(): ClaimedRun {
        return {
            correlationId: CORRELATION,
            runKey: RUN_KEY,
            ordinal: 0,
            attempt: 1,
            lease: {
                leaseId: LEASE_ID,
                attempt: 1,
                holder: 'mount-relay',
                issuedAt: FIXTURE_TIMESTAMP,
                expiresAt: FIXTURE_TIMESTAMP,
            },
            state: 'pending',
            stateReason: 'waiting for a panel',
            bindingId: 'bnd-fixture-1',
            repository: REPOSITORY,
            accountLogin: LOGIN,
            projectId: PROJECT_ID,
            worktreeOption: 'generated',
            subjectType: 'issue',
            issueNumber: 7,
            issueTitle: 'Fix the flaky test',
            issueUrl: ISSUE_URL,
            headSha: null,
            baseRef: null,
            attachmentId: CORRELATION,
            sourceReferences: [],
            referenceCount: 0,
            referencesNotRetained: 0,
            referencesTruncated: false,
            issueBodyExcerpt: '',
            detectedAt: FIXTURE_TIMESTAMP,
            promptPresent: false,
            promptFingerprint: null,
            promptLength: null,
            promptText: null,
        };
    }

    /** Picker and copy callbacks the shell's Bindings body needs (all inert here). */
    const inertHandlers: PanelHandlers = {
        refreshProjects: inertHandler,
        selectProject: inertHandler,
        copyProjectId: inertHandler,
    };

    it('arms one loop at the root, survives a mid-flight switch, and stops at teardown', async () => {
        let starts = 0;
        const gate: { release: (() => void) | null } = { release: null };
        const held = new Promise<void>((resolve) => {
            gate.release = resolve;
        });
        const host = fakeHost({
            listProjects: async () => TWO_PROJECTS,
            onSession: (listener) => {
                listener({
                    id: SESSION_ID,
                    title: 'Fix the flaky test',
                    busy: false,
                });

                return countRelease;
            },
            openSession: countOpen,
            startSession: async () => {
                starts += 1;
                await held;

                return SESSION_CREATED;
            },
            serviceRequest: async (request) => {
                const { path } = request;
                if (path === BINDINGS_PATH) {
                    return {
                        status: 200,
                        body: JSON.stringify({ bindings: [activeBinding()] }),
                    };
                }

                if (path === ACCOUNTS_PATH) {
                    return { status: 200, body: '{"accounts":[]}' };
                }

                if (path.endsWith('/reserve')) {
                    return {
                        status: 200,
                        body: JSON.stringify({
                            correlationId: CORRELATION,
                            attempt: 1,
                            dispatchToken: TOKEN,
                            tokenExpiresAt: FIXTURE_TIMESTAMP,
                            resultDeadlineAt: FIXTURE_TIMESTAMP,
                            state: 'starting',
                            auditWritten: true,
                        }),
                    };
                }

                if (path.endsWith('/dispatched')) {
                    return { status: 200, body: '{"done":true}' };
                }

                if (path === '/v1/config') {
                    return { status: 200, body: '{"config":{}}' };
                }

                return { status: 200, body: '{}' };
            },
        });
        const runtime = createTestRuntime(host);
        const dom = fakeDom();
        mountTabShell({
            rt: runtime,
            root: dom.root,
            specs: tabSpecs(runtime, inertHandlers),
        });

        // Root-owned arming (plan D2): the successful bindings read arms the
        // loop, and it is the only thing that arms it.
        await loadInitialBindings(runtime);
        expect(runtime.relayArmed).toBe(true);
        const armed = runtime.state.relay.timer;
        expect(armed).not.toBeNull();

        // A switch during an in-flight dispatch: the shell mounts two more
        // bodies and repaints, and none of that may touch the loop.
        const inFlight = dispatchClaimedRun(runtime, claim());
        runtime.shell?.activate('bindings');
        runtime.shell?.activate('dispatches');
        gate.release?.();
        await inFlight;
        await drainVerifications(runtime);

        expect(starts).toBe(1);
        expect(runtime.relayArmed).toBe(true);
        expect(runtime.state.relay.timer).toBe(armed);
        expect(runtime.state.dispatches.rows).toHaveLength(0);

        teardown(runtime);

        expect(runtime.relayArmed).toBe(false);
        expect(runtime.state.relay.timer).toBeNull();
        expect(runtime.disposed).toBe(true);
        expect(sdkPaints.disposes).toBeGreaterThan(0);
    });
});
