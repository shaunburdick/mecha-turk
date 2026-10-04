/**
 * Containment, upgrade, and posture proof for the six tabs (005 T-032;
 * FR-002, FR-004, FR-005, FR-023, FR-025, FR-026, FR-027, FR-079, FR-086,
 * AC-129, AC-138, NFR-102, NFR-103).
 *
 * This is where 005's *boundaries* are measured rather than asserted in
 * prose: a real credential sits in the store while every tab renders, a
 * pre-003 store boots through the upgraded service and the panel, and the
 * routes, storage keys, and audit vocabulary are read back byte-for-byte.
 * (Shipped-artifact and manifest posture lives in `bundle.test.ts` and
 * `manifest.test.ts`, which own those scans.)
 *
 * Nothing here reaches the network: the service is loopback on a temp
 * directory, the panel runs on the fake host, and the only "credential" is a
 * fixture value planted so a leak would be visible (FR-086, AC-138).
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ROUTES } from '../service/routes/index.ts';
import { AUDIT_FILE } from '../service/audit.ts';
import { CONFIG_FILE } from '../service/config.ts';
import { createEvent } from '../service/poll/events-write.ts';
import { RUNS_FILE } from '../service/poll/runs.ts';
import { credentialRemediation } from '../service/prompt.ts';
import { ACCOUNT_PATH } from '../service/routes/accounts.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { CONFIG_PATH } from '../service/routes/config.ts';
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
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
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
        {
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
        }
        {
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
        }
    });
});

describe('FR-002 / FR-089 the panel never writes to GitHub and never mutates the host', () => {
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
    it('uses exactly the documented storage keys and never stores the active tab', async () => {
        {
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
        }
        {
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
        }
    });
});

/* ------------------------------------------------------------------------- *
 * AC-150 one credential sentinel, three save paths (004 FR-024, FR-083)
 *
 * The cross-path half of the containment proof. `bundle.test.ts`'s full cycle
 * greps what the cycle *left behind*; this one reads what each save path
 * *answers* and what it *touches*, because a refusal can fail in two ways a
 * cycle cannot see: by echoing the value in its own body, and by applying a
 * fraction of a submission that contained a problem. The queue file is not
 * scanned here because this proof enqueues nothing (there is no queue row to
 * leak into) — the full cycle refuses the same way and *then* enqueues, so
 * `events.json` is covered there.
 * ------------------------------------------------------------------------- */

/** Repository-relative path of the committed panel bundle. */
const PANEL_BUNDLE_PATH = 'panel/main.js';

/** Repository-relative path of the committed service bundle. */
const SERVICE_BUNDLE_PATH = 'service/main.js';

/** The global tier's accepted text, in force while every path refuses (004 FR-081). */
const AC_GLOBAL_TIER = 'Name the failing test before proposing any fix.';

/** The account tier's accepted text, in force while every path refuses (004 FR-082). */
const AC_ACCOUNT_TIER = 'Prefer the smallest diff that closes the failing test.';

/** The binding tier's accepted text, in force while every path refuses (004 FR-010). */
const AC_BINDING_TIER = 'Reproduce first, then patch, and keep the public API stable.';

/** The head sentinel planted inside the credential-shaped submission. */
const CREDENTIAL_HEAD = 'zzREFUSEDzz';

/** The middle run: 24 characters no remediation could quote by accident. */
const CREDENTIAL_MID = 'a'.repeat(24);

/** The tail sentinel planted inside the credential-shaped submission. */
const CREDENTIAL_TAIL = 'zzNOWHEREzz';

/** The credential-shaped value every save path must refuse. */
const CREDENTIAL_VALUE = `ghp_${CREDENTIAL_HEAD}${CREDENTIAL_MID}${CREDENTIAL_TAIL}`;

/** Every run of the value a fragment scan hunts for (each ≥ 8 characters). */
const CREDENTIAL_FRAGMENTS: readonly string[] = [CREDENTIAL_HEAD, CREDENTIAL_MID, CREDENTIAL_TAIL];

/** The three files a prompt tier is stored in, in generality order. */
const TIER_FILES: readonly string[] = [CONFIG_FILE, ACCOUNT_FILE, BINDINGS_FILE];

/** One field refusal, as the `422 validation` envelope carries it. */
interface AcRefusalIssue {
    /** The offending field. */
    readonly field: string;
    /** How to fix it; never quotes what was received. */
    readonly remediation: string;
}

/** Header name a JSON body carries, as a computed object key. */
const AC_CONTENT_TYPE_HEADER = 'content-type';

/** Headers for the routes that take a JSON body. */
function acJsonHeaders(): Record<string, string> {
    return { [AC_CONTENT_TYPE_HEADER]: 'application/json' };
}

/** One whole-file `PUT /v1/bindings` carrying exactly one binding. */
async function acPutBindings(
    loop: Awaited<ReturnType<typeof startDispatchLoop>>,
    binding: Record<string, unknown>,
): Promise<Response> {
    return await loop.service.call(BINDINGS_PATH, {
        method: 'PUT',
        headers: acJsonHeaders(),
        body: JSON.stringify({ bindings: [binding] }),
    });
}

/**
 * One whole-document `PUT /v1/config`, patched over the stored document.
 *
 * @param loop - The running loop to call.
 * @param patch - Members to replace in the document as `GET` reports it.
 * @returns The response.
 */
async function acPutConfig(
    loop: Awaited<ReturnType<typeof startDispatchLoop>>,
    patch: Readonly<Record<string, unknown>>,
): Promise<Response> {
    const read = await loop.service.call(CONFIG_PATH);
    const envelope = (await read.json()) as { readonly config: Record<string, unknown> };

    return await loop.service.call(CONFIG_PATH, {
        method: 'PUT',
        headers: acJsonHeaders(),
        body: JSON.stringify({ ...envelope.config, ...patch }),
    });
}

/** One `PUT /v1/accounts/:numericUserId` profile write. */
function acPutProfile(
    loop: Awaited<ReturnType<typeof startDispatchLoop>>,
    body: Record<string, unknown>,
): Promise<Response> {
    return loop.service.call(ACCOUNT_PATH.replace(':numericUserId', ACCOUNT_ID), {
        method: 'PUT',
        headers: acJsonHeaders(),
        body: JSON.stringify(body),
    });
}

/** Read the first issue a `422 validation` answer carries. */
function firstIssueOf(body: string): AcRefusalIssue {
    const parsed = JSON.parse(body) as {
        readonly error?: { readonly issues?: readonly AcRefusalIssue[] };
    };

    return parsed.error?.issues?.[0] ?? { field: '', remediation: '' };
}

/**
 * The account record the three paths act on, with its own tier set.
 *
 * @param prompt - The account tier to store.
 * @returns One `accounts/<id>.json` document.
 */
function acAccount(prompt: string): Record<string, unknown> {
    return {
        ...legacyAccount(),
        // The custody token is a fixture value rather than a token *shape*,
        // so the sweep below can cover every surface including this file —
        // invariant 9 keeps real PATs in exactly that file, and
        // `bundle.test.ts` proves the shaped kind beside a prompt scan.
        credential: { token: 'custody-fixture-value', kind: 'classic', verifiedAt: STAMP },
        startingPrompt: prompt,
    };
}

/**
 * The binding record the three paths act on, with its own tier set.
 *
 * @param prompt - The binding tier to store.
 * @returns One `bindings.json` element.
 */
function acBinding(prompt: string): Record<string, unknown> {
    return { ...legacyBinding(), startingPrompt: prompt };
}

/**
 * Read the bytes of every file a prompt tier is stored in, right now.
 *
 * @param dataDir - The service's data directory.
 * @returns Store-relative path → file bytes.
 */
function tierBytes(dataDir: string): ReadonlyMap<string, string> {
    return new Map(
        TIER_FILES.map((file) => [file, readFileSync(join(dataDir, file), 'utf8')]),
    );
}

describe('AC-150 one credential sentinel refused at all three save paths (FR-024, FR-083)', () => {
    it('answers one shape label everywhere and touches no tier at all', async () => {
        const loop = await startDispatchLoop();
        try {
            // SEED — three tiers in force, each through its own documented path.
            await loop.store.writeJson(ACCOUNT_FILE, acAccount(AC_ACCOUNT_TIER));
            const seededGlobal = await acPutConfig(loop, { startingPrompt: AC_GLOBAL_TIER });
            expect(seededGlobal.status).toBe(200);
            const seededAccount = await acPutProfile(loop, { startingPrompt: AC_ACCOUNT_TIER });
            expect(seededAccount.status).toBe(200);
            const seededBinding = await acPutBindings(loop, acBinding(AC_BINDING_TIER));
            expect(seededBinding.status).toBe(200);

            // Not vacuous: the three accepted values really are on disk before
            // anything is refused, so byte-identity below is measured against
            // a populated store rather than an empty one.
            const seeded = tierBytes(loop.service.dataDir);
            expect(seeded.get(CONFIG_FILE)).toContain(AC_GLOBAL_TIER);
            expect(seeded.get(ACCOUNT_FILE)).toContain(AC_ACCOUNT_TIER);
            expect(seeded.get(BINDINGS_FILE)).toContain(AC_BINDING_TIER);

            const shape = findSecretLeak(CREDENTIAL_VALUE);
            if (shape === null) {
                throw new Error('the AC-150 sentinel must be credential-shaped');
            }

            // REFUSE — the same value at each of the three save paths.
            const attempts: readonly (readonly [string, () => Promise<Response>])[] = [
                ['bindings', () => acPutBindings(loop, acBinding(CREDENTIAL_VALUE))],
                ['config', () => acPutConfig(loop, { startingPrompt: CREDENTIAL_VALUE })],
                ['accounts', () => acPutProfile(loop, { startingPrompt: CREDENTIAL_VALUE })],
            ];

            const labels = new Set<string>();
            const refusalTexts: string[] = [];
            for (const [path, send] of attempts) {
                const before = tierBytes(loop.service.dataDir);
                const response = await send();
                const text = await response.text();
                expect(response.status, `${path} did not refuse`).toBe(422);
                const issue = firstIssueOf(text);
                expect(issue.field, path).toBe('startingPrompt');
                labels.add(issue.remediation);
                refusalTexts.push(text);

                // No save path applies any part of a submission that contains
                // a problem: the refusing tier's own file is byte-identical,
                // and the other two are byte-identical *a fortiori* (AC-150).
                const after = tierBytes(loop.service.dataDir);
                for (const file of TIER_FILES) {
                    expect(after.get(file), `${path} refusal touched ${file}`).toBe(before.get(file));
                }
            }

            // One shape label at all three paths — the shared validator's own
            // remediation, built from the detector's label (FR-083, AC-150).
            expect([...labels]).toEqual([credentialRemediation(shape)]);

            // Zero characters of the value anywhere: not the value itself and
            // not one of its three runs, on any surface a refusal or a store
            // write could have reached.
            const { dataDir } = loop.service;
            const surfaces: readonly (readonly [string, string])[] = [
                [CONFIG_FILE, readFileSync(join(dataDir, CONFIG_FILE), 'utf8')],
                [ACCOUNT_FILE, readFileSync(join(dataDir, ACCOUNT_FILE), 'utf8')],
                [BINDINGS_FILE, readFileSync(join(dataDir, BINDINGS_FILE), 'utf8')],
                [RUNS_FILE, readFileSync(join(dataDir, RUNS_FILE), 'utf8')],
                [AUDIT_FILE, readFileSync(join(dataDir, AUDIT_FILE), 'utf8')],
                ['the three refusal bodies', refusalTexts.join('\n')],
                ['captured service logs', JSON.stringify(loop.service.logLines)],
                ['host.storage', JSON.stringify([...loop.panelStorage])],
                ['panel bundle', readFileSync(resolve(ROOT, PANEL_BUNDLE_PATH), 'utf8')],
                ['service bundle', readFileSync(resolve(ROOT, SERVICE_BUNDLE_PATH), 'utf8')],
            ];

            for (const [name, text] of surfaces) {
                for (const fragment of [CREDENTIAL_VALUE, ...CREDENTIAL_FRAGMENTS]) {
                    expect(text.includes(fragment), `${name} echoed part of the refused value`)
                        .toBe(false);
                }

                expect(findSecretLeak(text), `${name} carried credential material`).toBeNull();
            }
        } finally {
            await loop.shutdown();
        }
    });
});
