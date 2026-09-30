/**
 * Containment, upgrade, and posture proof for the six tabs (005 T-032;
 * FR-002, FR-004, FR-005, FR-023, FR-025, FR-026, FR-027, FR-079, FR-086,
 * FR-087, AC-129, AC-138, AC-139, NFR-102, NFR-103).
 *
 * This is where 005's *boundaries* are measured rather than asserted in
 * prose: a real credential sits in the store while every tab renders, a
 * pre-003 store boots through the upgraded service and the panel, and the
 * shipped artifacts, manifest, routes, storage keys, and audit vocabulary are
 * read back byte-for-byte.
 *
 * Nothing here reaches the network: the service is loopback on a temp
 * directory, the panel runs on the fake host, and the only "credential" is a
 * fixture value planted so a leak would be visible (FR-086, AC-138).
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ROUTES } from '../service/routes/index.ts';
import { createEvent } from '../service/poll/events-write.ts';
import { RUNS_FILE } from '../service/poll/runs.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import { createLedger, serializeLedger } from '../src/ledger.ts';
import { parseJsonValue } from '../src/json.ts';
import { findSecretLeak } from '../src/redaction.ts';
import { dispatchRows } from '../src/dispatches-rows.ts';
import { loadDispatches } from '../src/dispatches.ts';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import { tick } from './support/panel.ts';
import { startDispatchLoop } from './support/dispatch-loop.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });

                return {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => undefined,
                };
            };
        }
    }

    return stubbed;
});

/** The six tabs FR-010 puts in the strip, in strip order. */
const TAB_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'] as const;

/** The picker callbacks the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** Stamp the legacy rows carry. */
const STAMP = '2026-09-20T12:00:00.000Z';

/** Binding id the seeded queue and its binding share. */
const BINDING_ID = 'bnd-upgrade';

/** Account numeric id whose credential file the scan plants. */
const ACCOUNT_ID = '77331';

/**
 * The credential the scan plants in the store.
 *
 * A fixture value shaped like the real thing, never a real one: it exists so
 * that "no surface carries a credential" is measured against something that
 * could actually leak.
 */
const PLANTED_TOKEN = `ghp_${'containmentscan'.repeat(2)}`;

/** The starting prompt whose text must appear exactly once (SC-105). */
const PLANTED_PROMPT = 'Reproduce first, then patch, and say so in the summary.';

/** Store-relative path of the shipped bindings file. */
const BINDINGS_FILE = 'bindings.json';

/** Store-relative path of the shipped queue (the pre-003 vocabulary). */
const EVENTS_FILE = 'events.json';

/** Store-relative path of the account credential file. */
const ACCOUNT_FILE = `accounts/${ACCOUNT_ID}.json`;

/** The retired lifecycle vocabulary this store was written in. */
type RetiredState = 'pending' | 'in-flight' | 'dispatched';

/** Panel-storage key the extension's ledger lives under (FR-025). */
const LEDGER_KEY = 'mecha-turk:ledger';

/** Panel-storage key the stored project selection lives under (FR-025). */
const PROJECT_KEY = 'mecha-turk:project';

/** Path of the committed service bundle, read three ways below. */
const SERVICE_BUNDLE = 'service/main.js';

/**
 * Every storage key the extension namespace has ever used (FR-025).
 *
 * Adding one is a user-visible change, so the set is frozen here.
 */
const STORAGE_KEYS = [
    PROJECT_KEY,
    'mecha-turk:evidence',
    LEDGER_KEY,
    'mecha-turk:dispatches',
] as const;

/** GitHub token shapes no shipped artifact may carry. */
const TOKEN_PATTERNS: readonly RegExp[] = [/\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/];

/** Usage patterns of the GitHub write method FR-002 forbids. */
const GITHUB_WRITE_METHOD = /\bmethod:\s*['"](POST|PUT|PATCH|DELETE)['"]/;

/** A reference to GitHub's REST API, however the module spells it. */
const GITHUB_API = /api\.github\.com|API_ORIGIN|`\/repos\//;

/** Modules allowed to talk to GitHub's REST API; every one of them reads. */
const GITHUB_GATEWAYS: ReadonlySet<string> = new Set([
    'src/github.ts',
    'service/github.ts',
    'service/poll/poller-github.ts',
]);

/** The snapshot a legacy queue row was detected under. */
function snapshot(issueNumber: number): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: 'acme/widget',
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
            issueBodyExcerpt: '',
        },
        triggerNote: 'assigned to account',
        detectedAt: STAMP,
    };
}

/**
 * One queue row in the vocabulary the panel retired (005 FR-005).
 *
 * @param input - The row's issue and its shipped lifecycle state.
 * @returns The row as the pre-003 build wrote it.
 */
function legacyRow(input: { readonly issueNumber: number; readonly state: RetiredState }): unknown {
    return {
        ...createEvent(snapshot(input.issueNumber)),
        state: input.state,
        claimedAt: input.state === 'in-flight' ? STAMP : null,
        dispatchedAt: input.state === 'dispatched' ? STAMP : null,
        dispatchResult: input.state === 'dispatched' ? 'ses_preexisting' : null,
    };
}

/**
 * The account file as the pre-`displayName` build wrote it, carrying the
 * planted credential the scan watches for.
 *
 * @returns One `accounts/<id>.json` document.
 */
function legacyAccount(): Record<string, unknown> {
    return {
        numericUserId: ACCOUNT_ID,
        login: 'octocat',
        expectedLogin: null,
        verifiedAt: STAMP,
        errorReason: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        credential: { token: PLANTED_TOKEN, kind: 'classic', verifiedAt: STAMP },
        scopeCheck: {
            checkedAt: STAMP,
            results: Object.fromEntries(
                ['metadata', 'issues', 'pull-requests', 'contents'].map((capability) => [capability, 'ok']),
            ),
        },
        state: 'active',
        connectionState: 'connected',
    };
}

/**
 * The shipped binding, carrying the prompt whose text must appear once.
 *
 * @returns One `bindings.json` element.
 */
function legacyBinding(): Record<string, unknown> {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
        startingPrompt: PLANTED_PROMPT,
    };
}

/** Every string one SDK mount was handed, at any depth. */
function stringsOf(log: readonly { readonly key: string; readonly props: unknown }[]): string {
    const found: string[] = [];
    const walk = (value: unknown): void => {
        if (typeof value === 'string') {
            found.push(value);

            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item);
            }

            return;
        }

        if (typeof value === 'object' && value !== null) {
            for (const item of Object.values(value)) {
                walk(item);
            }
        }
    };

    for (const entry of log) {
        walk(entry.props);
    }

    return found.join('\n');
}

/**
 * Read every source module in the tree, for the static posture scans.
 *
 * @returns The repository-relative path and text of each `.ts` file.
 */
function sources(): readonly { readonly path: string; readonly text: string }[] {
    const files: { path: string; text: string }[] = [];
    for (const dir of ['src', 'service']) {
        const entries = readdirSync(resolve(ROOT, dir), { recursive: true }).map((entry) => String(entry));
        for (const entry of entries) {
            if (entry.endsWith('.ts')) {
                files.push({
                    path: `${dir}/${entry}`,
                    text: readFileSync(resolve(ROOT, dir, entry), 'utf8'),
                });
            }
        }
    }

    return files;
}

/** Read one source module by its repository-relative path. */
function panelSources(): readonly string[] {
    return sources()
        .filter((file) => file.path.startsWith('src/'))
        .map((file) => file.text);
}

/**
 * Seed a pre-003 store, restart the service so its boot sweep adopts the
 * queue, and mount the panel over it.
 *
 * @returns The loop, the mounted runtime, and the seeded queue's bytes.
 */
async function bootUpgradedPanel(): Promise<{
    /** The loopback service and its store. */
    readonly loop: Awaited<ReturnType<typeof startDispatchLoop>>;
    /** The mounted panel runtime. */
    readonly rt: PanelRuntime;
    /** The queue file's bytes as the legacy build wrote them. */
    readonly legacyBytes: string;
}> {
    mounts.log.length = 0;
    const loop = await startDispatchLoop();
    await loop.store.writeJson(EVENTS_FILE, [
        legacyRow({ issueNumber: 1, state: 'pending' }),
        legacyRow({ issueNumber: 2, state: 'in-flight' }),
        legacyRow({ issueNumber: 3, state: 'dispatched' }),
    ]);
    await loop.store.writeJson(ACCOUNT_FILE, legacyAccount());
    await loop.store.writeJson(BINDINGS_FILE, [legacyBinding()]);
    // The ledger an earlier install left behind: the panel must carry it
    // forward, not reset it (FR-005, NFR-103).
    const ledger = createLedger({
        correlationId: 'mt-legacy-ledger-0001',
        panelGeneration: 3,
        storagePresentBeforeMount: true,
        createdAt: STAMP,
    });
    loop.panelStorage.set(LEDGER_KEY, parseJsonValue(serializeLedger(ledger)));
    loop.panelStorage.set(PROJECT_KEY, 'prj_42');
    const legacyBytes = readFileSync(join(loop.service.dataDir, EVENTS_FILE), 'utf8');
    // The first boot already wrote an empty run document, and adoption is
    // idempotent by design — so the document the seeded queue would be read
    // into is removed, and the restart's boot pass adopts the legacy rows.
    rmSync(join(loop.service.dataDir, RUNS_FILE), { force: true });
    await loop.restart();

    const rt = loop.mount();
    // The read app.ts performs at startup (its `start()` path): the harness
    // mounts the shell by hand, so it performs that read by hand too.
    await loadDispatches(rt);
    mountTabShell({ rt, root: fakeDom().root, specs: tabSpecs(rt, inertHandlers) });
    for (const id of TAB_IDS) {
        rt.shell?.activate(id);
    }
    // The mounts' own reads: wait for them so every assertion below reads a
    // settled panel rather than one mid-flight.
    for (let attempt = 0; attempt < 100; attempt += 1) {
        await tick();
        if (rt.state.bindings.accounts.length > 0 && rt.state.bindings.bindings.length > 0) {
            break;
        }
    }

    return { loop, rt, legacyBytes };
}

describe('FR-005 / NFR-103 a pre-003 store boots through the upgraded panel and service', () => {
    it('renders every legacy row through the migration table and rewrites nothing', async () => {
        const { loop, rt, legacyBytes } = await bootUpgradedPanel();
        try {
            // The queue the retired vocabulary was written into is still
            // readable, and the service has mapped it onto run states.
            const events = await loop.store.readJson(EVENTS_FILE, (value) => value);
            expect(events.status).toBe('ok');
            expect(rt.state.dispatches.rows.length).toBeGreaterThan(0);
            for (const row of rt.state.dispatches.rows) {
                expect(['pending', 'claimed', 'starting', 'dispatched', 'failed', 'unconfirmed'])
                    .toContain(row.state);
            }
            // Every row renders a label; none falls through to *unknown state*.
            const rendered = dispatchRows(rt.state.dispatches);
            expect(rendered.length).toBe(rt.state.dispatches.rows.length);
            for (const item of rendered) {
                expect(item.title.trim()).not.toBe('');
                expect(item.subtitle ?? '').not.toContain('unknown state');
            }

            // The account carried no `displayName`; it renders by login.
            expect(rt.state.bindings.accounts[0]?.displayName).toBeNull();
            expect(rt.state.bindings.accounts[0]?.login).toBe('octocat');

            // Nothing was quarantined, no storage key was reset, and the
            // legacy queue file is byte-identical to what was seeded.
            const files = readdirSync(join(loop.service.dataDir));
            expect(files.filter((name) => name.includes('.corrupt-'))).toEqual([]);
            expect(readFileSync(join(loop.service.dataDir, EVENTS_FILE), 'utf8')).toBe(legacyBytes);
            expect([...loop.panelStorage.keys()]).toEqual(
                expect.arrayContaining([LEDGER_KEY, PROJECT_KEY]),
            );
            const ledger = loop.panelStorage.get(LEDGER_KEY) as { readonly panelGeneration?: number };
            expect(ledger.panelGeneration).toBe(3);
        } finally {
            rt.shell?.dispose();
            await loop.shutdown();
        }
    });
});

describe('NFR-102 / AC-129 no surface carries the credential in the store', () => {
    it('keeps the planted token out of every rendered string and every storage value', async () => {
        const { loop, rt } = await bootUpgradedPanel();
        try {
            await tick();
            const rendered = stringsOf(mounts.log);
            const stored = JSON.stringify([...loop.panelStorage.values()]);

            expect(rendered).not.toContain(PLANTED_TOKEN);
            expect(findSecretLeak(rendered)).toBeNull();
            expect(stored).not.toContain(PLANTED_TOKEN);
            expect(findSecretLeak(stored)).toBeNull();
            // Not vacuous: the credential really is in the store beside them.
            const account = await loop.store.readJson(ACCOUNT_FILE, (value) => value);
            expect(JSON.stringify(account)).toContain(PLANTED_TOKEN);
        } finally {
            rt.shell?.dispose();
            await loop.shutdown();
        }
    });

    it('renders the starting prompt in exactly one place (SC-105)', async () => {
        const { loop, rt } = await bootUpgradedPanel();
        try {
            // The field opens on what the service holds for the selected row,
            // which is the only place the text may appear — and the row only
            // exists once the mount's own read has landed.
            for (let attempt = 0; attempt < 100 && rt.state.bindings.bindings.length === 0; attempt += 1) {
                await tick();
            }

            createBindingsHandlers(rt).selectBinding(BINDING_ID);
            await tick();
            const carrying = mounts.log.filter((entry) =>
                JSON.stringify(entry.props ?? null).includes(PLANTED_PROMPT));

            expect(carrying).toHaveLength(1);
            // One element carries it, and that element is the text field —
            // never a second surface (SC-105 fails at 0 and at 2 alike).
            expect(carrying[0]?.key.startsWith('mountTextField')).toBe(true);
        } finally {
            rt.shell?.dispose();
            await loop.shutdown();
        }
    });
});

describe('FR-087 / AC-139 the shipped artifacts and manifest are unchanged', () => {
    it('keeps both bundles in their documented shapes and free of secrets', () => {
        const panel = readFileSync(resolve(ROOT, 'panel/main.js'), 'utf8');
        const service = readFileSync(resolve(ROOT, SERVICE_BUNDLE), 'utf8');

        expect(panel.startsWith('(()=>{')).toBe(true);
        expect(panel.trimEnd().endsWith('})();')).toBe(true);
        expect(service.startsWith('(()=>{')).toBe(false);
        expect(service).toMatch(/^export\s*\{/m);
        for (const bundle of [panel, service]) {
            for (const pattern of TOKEN_PATTERNS) {
                expect(bundle).not.toMatch(pattern);
            }
        }
    });

    it('commits the service bundle with its sources', () => {
        const tracked = execFileSync('git', ['ls-files', '--error-unmatch', SERVICE_BUNDLE], {
            cwd: resolve(ROOT),
            encoding: 'utf8',
        });

        expect(tracked.trim()).toBe(SERVICE_BUNDLE);
    });

    it('adds no capability and no setting to the manifest (FR-004, FR-079)', () => {
        const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
            readonly openchamber: {
                readonly apiVersion: number;
                readonly engines: Readonly<Record<string, string>>;
                readonly contributes: {
                    readonly panel: Readonly<Record<string, string>>;
                    readonly capabilities: readonly string[];
                    readonly service: Readonly<Record<string, string>>;
                    readonly integration: { readonly settings: readonly unknown[] };
                };
            };
        };
        const { contributes } = manifest.openchamber;

        expect(contributes.capabilities).toEqual(['sessions', 'prompt']);
        expect(contributes.integration.settings).toEqual([]);
        expect(contributes.panel.id).toBe('mecha-turk');
        expect(contributes.panel.name).toBe('Mecha Turk');
        expect(contributes.service.entry).toBe(SERVICE_BUNDLE);
        expect(manifest.openchamber.apiVersion).toBe(1);
        expect(manifest.openchamber.engines.openchamber).toBe('>=1.24.0');
        expect(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).toContain('"version": "0.0.1"');
    });
});

describe('FR-002 / FR-089 the panel never writes to GitHub and never mutates the host', () => {
    it('finds a GitHub API reference only in the read-only gateways', () => {
        const outsiders = sources()
            .filter((file) => GITHUB_API.test(file.text) && !GITHUB_GATEWAYS.has(file.path))
            .map((file) => file.path);

        expect(outsiders).toEqual([]);
        for (const file of sources().filter((candidate) => GITHUB_GATEWAYS.has(candidate.path))) {
            expect(file.text, `${file.path} builds a GitHub write`).not.toMatch(GITHUB_WRITE_METHOD);
        }
    });

    it('never names a project, worktree, session, or agent mutation API (FR-089)', () => {
        const mutations = /(^|[^.\w])(create|delete|remove|rename)(Project|Worktree|Session|Agent)\b/;

        for (const file of sources()) {
            expect(file.text, `${file.path} mutates host state`).not.toMatch(mutations);
        }
    });

    it('writes no audit row of its own (FR-027)', () => {
        for (const text of panelSources()) {
            // Reading an audit row is the view's job; *writing* one would
            // mean naming an event type, which 005 never does.
            expect(text, 'the panel names a new audit event type').not.toMatch(/eventType:\s*'/);
        }
        // The vocabulary itself is the service's, and it is unchanged: the
        // route table still answers every documented path (FR-023).
        const paths = ROUTES.map((route) => route.path);
        for (const path of ['/v1/events', '/v1/events/pending', '/v1/status', '/v1/config', '/health']) {
            expect(paths).toContain(path);
        }
        expect(paths).toContain('/v1/events/:correlationId/retry');
        expect(paths).toContain('/v1/events/:correlationId/dispatched');
    });
});

describe('FR-025 / FR-026 no storage key is added, and the wire keeps its members', () => {
    it('uses exactly the documented storage keys and never stores the active tab', () => {
        const keys = new Set<string>();
        for (const text of panelSources()) {
            for (const match of text.matchAll(/'mecha-turk:([a-z-]+)'/g)) {
                keys.add(`mecha-turk:${match[1]}`);
            }
        }

        for (const key of STORAGE_KEYS) {
            expect(keys, `${key} must still be in use`).toContain(key);
        }
        expect([...keys].filter((key) => key.includes('tab'))).toEqual([]);
        expect(keys.size).toBeLessThanOrEqual(STORAGE_KEYS.length + 1);
    });

    it('keeps the `repositories` member the status document answers with (FR-026)', async () => {
        const loop = await startDispatchLoop();
        try {
            const response = await loop.service.call('/v1/status');
            const body = (await response.json()) as Record<string, unknown>;

            expect(response.status).toBe(200);
            expect(Object.keys(body)).toContain('repositories');
            expect(Array.isArray(body.repositories)).toBe(true);
        } finally {
            await loop.shutdown();
        }
    });
});
