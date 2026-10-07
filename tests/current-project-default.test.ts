/**
 * The current-project default (002 v1.14.0 → v1.15.0, FR-095 – FR-099;
 * GitHub issues #21 and #39).
 *
 * The feature's safety property is an *absence*: no directory subscription,
 * no new host surface, no stored pick — v1.15.0 removed the panel-level
 * picker and with it the `mecha-turk:project` key — and no third control.
 * An absence proved after the feature code exists proves the feature rather
 * than the absence, so this file opens with the static block alone — green
 * on a tree that has no default at all (plan J9; Gate-2 assumption "write
 * the scan before the feature code"). The fixtures and the cross-surface
 * proofs arrive in later tasks against the same file.
 *
 * Everything here is offline: source and bundle files are read from disk,
 * the manifest and route table are parsed, and no host, PAT, or network is
 * involved (AGENTS.md testing philosophy).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GuestProjectsSnapshot } from '@openchamber/sdk';
import type { BindingContext } from '../src/config.ts';
import { ROUTES } from '../service/routes/index.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import { startEditingBinding, startNewBinding } from '../src/bindings-edit.ts';
import { bindRepository, readDraft } from '../src/bindings.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { LEDGER_STORAGE_KEY } from '../src/ledger.ts';
import { refresh } from '../src/panel-ui.ts';
import { createPanelRuntime } from '../src/panel-state.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import {
    loadProjects,
    recordHostDirectory,
} from '../src/project-actions.ts';
import {
    applyProjectSnapshot,
    currentProjectDefault,
} from '../src/project-picker.ts';
import { stopRelayPolling } from '../src/relay.ts';
import { BINDINGS_PATH } from '../src/service-calls.ts';
import type { PanelHost } from '../src/session.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { fakeDom } from './support/dom.ts';
import { fakeGitHub, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';
import { byText } from './support/sort.ts';
import {
    PROJECT_DIR,
    PROJECT_ID,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
    fakeWindow,
    testConfig,
    tick,
} from './support/panel.ts';

/**
 * The recording double one stubbed `mount*` primitive answers with.
 *
 * A named type rather than an inline object: the mock factory and the panel
 * both pass this across a module boundary, so the shape has to be readable
 * on its own.
 */
interface RecorderHandle {
    /** Record one repaint and hand it to the control. */
    readonly update: (next?: unknown) => void;
    /** Release the control; a no-op here, since there is no DOM. */
    readonly dispose: () => void;
    /** The props the control mounted with. */
    readonly mounted: () => Record<string, unknown>;
    /** The props the most recent repaint handed it. */
    readonly painted: () => Record<string, unknown>;
}

/**
 * Every SDK mount, and what each handle was last painted with.
 *
 * The panel's controls are read through the handles it stores
 * (`rt.bindingsUi`), so the recorder lives on the handle rather than only in
 * a flat log: that is what lets an assertion name *which* select it is
 * reading instead of inferring it from mount order. The log is kept too, for
 * the counts — a control mounted twice would otherwise be invisible to a
 * props assertion that reads whichever handle the panel kept.
 */
const sdk = vi.hoisted(() => {
    const log: { readonly key: string; readonly props: Record<string, unknown> }[] = [];

    return {
        log,
        /** Build the recording double one `mount*` primitive answers with. */
        handle(key: string, mounted: unknown): RecorderHandle {
            const mountProps = { ...(mounted as Record<string, unknown>) };
            let painted = mountProps;
            log.push({ key, props: mountProps });

            return {
                update: (next?: unknown): void => {
                    painted = { ...(next as Record<string, unknown>) };
                    log.push({ key: `${key}:update`, props: painted });
                },
                dispose: (): void => undefined,
                mounted: (): Record<string, unknown> => mountProps,
                painted: (): Record<string, unknown> => painted,
            };
        },
    };
});

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): RecorderHandle => sdk.handle(key, props);
        }
    }

    return stubbed;
});

/** The two reads a recorded handle answers with. */
interface RecordedHandle {
    /** Props the control mounted with. */
    readonly mounted: () => Record<string, unknown>;
    /** Props the most recent repaint handed it. */
    readonly painted: () => Record<string, unknown>;
}

/**
 * Read the recorder off a handle the panel stores.
 *
 * The SDK handle type carries only `update`/`dispose`, so the recorder is
 * read structurally — the import-adapter shape `tests/support/ui-stubs.ts`
 * already uses — and a handle that did not come through the double throws
 * here rather than answering `undefined`.
 *
 * @returns The handle's mount and paint readers.
 */
function recorded(handle: unknown): RecordedHandle {
    const candidate = handle as Partial<RecordedHandle>;
    if (typeof candidate.mounted !== 'function' || typeof candidate.painted !== 'function') {
        throw new TypeError('this handle was not mounted through the recording SDK double');
    }

    return candidate as RecordedHandle;
}

/** How often a pattern occurs in one source string. */
function occurrences(source: string, pattern: RegExp): number {
    return [...source.matchAll(pattern)].length;
}

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/**
 * Source and bundle directories the scan reads.
 *
 * `panel/` and `service/` are here for the committed bundles: OpenChamber
 * loads those as-is, so an absence that holds only over the TypeScript
 * sources says nothing about what ships.
 */
const SCANNED_DIRS: readonly string[] = ['src', 'panel', 'service'];

/** One file the source-and-bundle scan read. */
interface ScannedFile {
    /** Repository-relative path, for the failure message. */
    readonly path: string;
    /** File text, scanned as written (bundles included). */
    readonly text: string;
}

/**
 * Read every scanned source and bundle once.
 *
 * @returns The path and text of each `.ts`/`.js` file under {@link SCANNED_DIRS}.
 */
function scanPanelSurface(): readonly ScannedFile[] {
    const files: ScannedFile[] = [];
    for (const dir of SCANNED_DIRS) {
        const entries = readdirSync(resolve(ROOT, dir), { recursive: true }).map(String);
        for (const entry of entries) {
            if (!entry.endsWith('.ts') && !entry.endsWith('.js')) {
                continue;
            }

            files.push({ path: `${dir}/${entry}`, text: readFileSync(resolve(ROOT, dir, entry), 'utf8') });
        }
    }

    return files;
}

/**
 * A *registration* of the host's directory listener, in call form.
 *
 * The trailing `(\s*(` — the same rule `PROJECT_CREATE_CALL` follows — is what
 * keeps the bundled SDK's own `onDirectory:` property definition out of
 * reach: `panel/main.js:31` carries the host client's method name as text,
 * which is a definition rather than a registration *by construction*, so
 * this scan reads green over it rather than being granted an allowance for
 * it. Prose naming the API is out of reach for the same reason.
 */
const DIRECTORY_REGISTRATION = /onDirectory\s*\(/;

/**
 * Every member `PanelHost`'s Pick list declares — the panel's whole callable
 * host surface, pinned as a closed set (002 AC-045: "no host method it did
 * not call at v1.13.3").
 *
 * A grep only proves today's spelling of a call; pinning the list proves the
 * negative about the *set*, so widening it becomes a visible edit to this
 * array instead of a silent new capability.
 */
const PANEL_HOST_MEMBERS: readonly string[] = [
    'dispose',
    'listProjects',
    'listSessions',
    'listWorktrees',
    'onConnection',
    'onProjects',
    'onReady',
    'onSession',
    'onSessionLifecycle',
    'onSessions',
    'onSettings',
    'onWorktrees',
    'openSession',
    'openUrl',
    'request',
    'serviceRequest',
    'startSession',
    'storage',
    'writeClipboard',
].toSorted(byText);

/**
 * The namespaced `host.storage` keys the extension has ever used (AC-045).
 *
 * Frozen as a set: a key added or renamed is a user-visible storage-namespace
 * change (AGENTS.md invariant 4), and the fourth key of the namespace —
 * `accounts`, deliberately unprefixed — is asserted by name below rather than
 * discovered by a looser pattern. `mecha-turk:project` left this set at
 * v1.15.0 (issue #39): nothing stores a project pick any more, so the key
 * has no writer and no reader.
 */
const NAMESPACED_STORAGE_KEYS: readonly string[] = [
    'mecha-turk:dispatches',
    'mecha-turk:evidence',
    'mecha-turk:ledger',
].toSorted(byText);

/** Every path the service's route table answers, in declaration order. */
const ROUTE_PATHS: readonly string[] = [
    '/health',
    '/v1/config',
    '/v1/config',
    '/v1/status',
    '/v1/accounts',
    '/v1/bindings',
    '/v1/bindings',
    '/v1/events',
    '/v1/events/pending',
    '/v1/audit',
    '/v1/accounts/verify',
    '/v1/accounts/:numericUserId/token',
    '/v1/accounts/:numericUserId',
    '/v1/accounts/:numericUserId',
    '/v1/events/:correlationId/reserve',
    '/v1/events/:correlationId/dispatched',
    '/v1/events/:correlationId/abandon',
    '/v1/events/:correlationId/blocked',
    '/v1/events/:correlationId/retry',
    '/v1/events/:correlationId/requeue',
    '/v1/events/:correlationId/resolve',
    '/v1/events/:correlationId/verification',
];

/** Every file under the shipped contract record (AC-045 byte parity). */
const CONTRACT_FILES: readonly string[] = [
    'README.md',
    'binding-allow-list.md',
    'binding-history-scope.md',
    'events-carry-forward.md',
    'panel-service.md',
    'token-handoff.md',
].toSorted(byText);

describe('no directory listener is registered anywhere (FR-095, AC-045, FR-096(c))', () => {
    it('finds no registration across source and bundles, and the matcher bites both ways', () => {
        const files = scanPanelSurface();
        expect(files.length).toBeGreaterThan(50);
        expect(files.some((file) => file.path === 'panel/main.js')).toBe(true);
        expect(files.some((file) => file.path === 'service/main.js')).toBe(true);

        // The recorded baseline (Gate-3 G3-1): the bundle carries the SDK's
        // own `onDirectory:` name as text, which the call-form matcher cannot
        // reach — asserted present so a future bundler change that dropped it
        // does not quietly weaken what this scan proves.
        const panelBundle = files.find((file) => file.path === 'panel/main.js');
        expect(panelBundle, 'the panel bundle exists').toBeDefined();
        expect(panelBundle?.text).toContain('onDirectory:');

        // The scan has to bite, in both directions: a pattern that matches
        // nothing would read as green while proving nothing about the code
        // above it, and one that matched the name text would be red by
        // construction rather than by finding.
        expect(DIRECTORY_REGISTRATION.test('host.onDirectory(() => {})')).toBe(true);
        expect(DIRECTORY_REGISTRATION.test('host.onDirectory\n(() => {})')).toBe(true);
        expect(DIRECTORY_REGISTRATION.test('onDirectory:')).toBe(false);
        expect(DIRECTORY_REGISTRATION.test('// the panel could register onDirectory')).toBe(false);

        for (const file of files) {
            expect(file.text, `${file.path} must not register a directory listener`).not.toMatch(
                DIRECTORY_REGISTRATION,
            );
        }
    });
});

describe("the panel's host surface is a closed Pick list (AC-045)", () => {
    it('pins PanelHost to its exact v1.13.3 member set', () => {
        const session = readFileSync(resolve(ROOT, 'src/session.ts'), 'utf8');
        const pick = session.match(/export type PanelHost = Pick<\s*HostClient,\s*([\s\S]*?)\s*>/);
        expect(pick, 'PanelHost is still the Pick form the panel builds from').not.toBeNull();

        const members = [...(pick?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');

        expect(members.toSorted(byText)).toEqual(PANEL_HOST_MEMBERS);
        // Belt and braces on the count: a member spelled twice in the list
        // would otherwise pass a set comparison while reading as present.
        expect(members).toHaveLength(PANEL_HOST_MEMBERS.length);
    });
});

describe("AC-045's closed enumeration, restated once", () => {
    it('pins the manifest contributes block: panel id, capabilities, service without permissions', () => {
        const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
            openchamber?: {
                contributes?: {
                    panel?: { id?: string };
                    capabilities?: string[];
                    service?: Record<string, unknown>;
                };
            };
        };
        const contributes = manifest.openchamber?.contributes;
        expect(contributes, 'the manifest still contributes a panel').toBeDefined();
        expect(contributes?.panel?.id).toBe('mecha-turk');
        expect(contributes?.capabilities).toEqual(['sessions', 'prompt']);
        const service = contributes?.service;
        expect(service, 'the service contribution exists').toBeDefined();
        expect(service !== undefined && 'permissions' in service, 'service carries no permissions').toBe(false);
    });

    it('pins the storage-key set, the route table, and the shipped contracts', () => {
        const source = scanPanelSurface()
            .filter((file) => file.path.startsWith('src/'))
            .map((file) => file.text)
            .join('\n');
        const namespaced = [...source.matchAll(/'(mecha-turk:[a-z-]+)'/g)]
            .map((match) => match[1] ?? '')
            .toSorted(byText);
        expect([...new Set(namespaced)]).toEqual(NAMESPACED_STORAGE_KEYS);
        // The fourth key of the namespace carries no prefix at all (AGENTS.md
        // invariant 4), so a separate, exact assertion is the only way to
        // pin it.
        expect(/export const ACCOUNTS_STORAGE_KEY = 'accounts';/u.test(source)).toBe(true);

        expect(ROUTES.map((route) => route.path)).toEqual(ROUTE_PATHS);

        const contracts = readdirSync(resolve(ROOT, 'specs/002-agent-event-extension/contracts')).map(String);
        expect(contracts.toSorted(byText)).toEqual(CONTRACT_FILES);
    });
});

/* ------------------------------------------------------------------ *
 * Fixtures (E-3): the ready snapshots and inputs every later case
 * arranges from. Pure data — this section compiles and passes with no
 * feature code present, which is what keeps a fixture quietly normalised
 * later from making an exact-equality case pass vacuously (the guard
 * below is the proof of that).
 * ------------------------------------------------------------------ */

/** Directory the host's ready context reports as the current project's. */
const HOST_DIRECTORY = '/dir';

/** Project id the derived default names (FR-095's default term). */
const DERIVED_ID = 'prj_derived';

/** Project id only the binding context names (never preselected: FR-097(b)). */
const BINDING_CONTEXT_ID = 'prj_binding';

/**
 * Build a ready snapshot from bare id/directory pairs.
 *
 * @returns A `ready` snapshot as `host.listProjects()` reports one.
 */
function readySnapshot(...projects: readonly (readonly [string, string])[]): GuestProjectsSnapshot {
    return {
        kind: 'projects',
        state: 'ready',
        projects: projects.map(([id, directory]) => ({ id, name: id, directory })),
    };
}

/** Host directory matches exactly one registered project. */
const MATCHING_SNAPSHOT = readySnapshot([DERIVED_ID, HOST_DIRECTORY] as const);

/** Host directory `/dir` against a project at `/dir/` — the near miss. */
const NEAR_MISS_SNAPSHOT = readySnapshot(['prj_near', `${HOST_DIRECTORY}/`] as const);

/** Host directory against a project differing only in letter case. */
const CASE_MISS_SNAPSHOT = readySnapshot(['prj_case', HOST_DIRECTORY.toUpperCase()] as const);

/** Two registered projects sharing one directory — ambiguous, so no default. */
const COLLIDING_SNAPSHOT = readySnapshot(
    ['prj_left', HOST_DIRECTORY] as const,
    ['prj_right', HOST_DIRECTORY] as const,
);

/** Snapshot holding the two projects the resolution cases name. */
const TWO_PROJECTS_SNAPSHOT = readySnapshot(
    [DERIVED_ID, HOST_DIRECTORY] as const,
    [BINDING_CONTEXT_ID, '/projects/binding'] as const,
);

/** A list still in flight: options and derivation both unavailable. */
const LOADING_SNAPSHOT: GuestProjectsSnapshot = { ...MATCHING_SNAPSHOT, state: 'loading' };

/** A failed list read: today's honest error state, and no default. */
const ERROR_SNAPSHOT: GuestProjectsSnapshot = { ...MATCHING_SNAPSHOT, state: 'error' };

/**
 * The `listProjects()` rejection: today's error path, and no default.
 *
 * @returns A `host.listProjects` override that always rejects.
 */
async function rejectingListProjects(): Promise<GuestProjectsSnapshot> {
    throw new Error('host offline');
}

/** The binding-context input: one enabled binding carrying {@link BINDING_CONTEXT_ID}. */
function bindingContext(): BindingContext {
    return { ...testConfig(), projectId: BINDING_CONTEXT_ID };
}

describe('the wave fixtures say what they claim (AC-046)', () => {
    it('keeps the near-miss and case pairs differing by one property, and the collision pair sharing', async () => {
        const near = NEAR_MISS_SNAPSHOT.projects[0]?.directory ?? '';
        expect(near).not.toBe(HOST_DIRECTORY);
        expect(near.slice(0, -1), 'differs only by its trailing slash').toBe(HOST_DIRECTORY);

        const cased = CASE_MISS_SNAPSHOT.projects[0]?.directory ?? '';
        expect(cased).not.toBe(HOST_DIRECTORY);
        expect(cased.toLowerCase(), 'differs only in case').toBe(HOST_DIRECTORY.toLowerCase());

        const directories = COLLIDING_SNAPSHOT.projects.map((project) => project.directory);
        expect(directories).toHaveLength(2);
        expect(new Set(directories).size, 'the collision pair really shares a directory').toBe(1);
        expect(new Set(COLLIDING_SNAPSHOT.projects.map((project) => project.id)).size).toBe(2);

        // The positive control: the matching pair is exact, so a derivation
        // that passes on it is not passing on a normalisation.
        expect(MATCHING_SNAPSHOT.projects[0]?.directory).toBe(HOST_DIRECTORY);

        await expect(rejectingListProjects()).rejects.toThrow('host offline');
    });

    it('keeps the two remaining terms naming two different projects, only one on the host directory', () => {
        expect([DERIVED_ID, bindingContext().projectId]).toEqual([DERIVED_ID, BINDING_CONTEXT_ID]);
        expect(new Set([DERIVED_ID, BINDING_CONTEXT_ID]).size, 'two distinct terms').toBe(2);

        // Exactly one of them sits on the host's directory, so a precedence
        // case built from this snapshot cannot be decided by accident: the
        // derived term is the only one that can resolve.
        const onHostDirectory = TWO_PROJECTS_SNAPSHOT.projects.filter(
            (project) => project.directory === HOST_DIRECTORY,
        );
        expect(onHostDirectory.map((project) => project.id)).toEqual([DERIVED_ID]);
        expect(LOADING_SNAPSHOT.state).toBe('loading');
        expect(ERROR_SNAPSHOT.state).toBe('error');
        expect(LOADING_SNAPSHOT.projects, 'the loading double keeps the same list').toEqual(MATCHING_SNAPSHOT.projects);
        expect(ERROR_SNAPSHOT.projects, 'the error double keeps the same list').toEqual(MATCHING_SNAPSHOT.projects);
    });
});

/* ------------------------------------------------------------------ *
 * E-8 — the cross-surface proof, offline (AC-044 – AC-047, SC-014).
 *
 * Everything below drives panel state and the *mounted* bodies against the
 * fake host and the loopback service on a temp dir: no live OpenChamber, no
 * real PAT, no network (AGENTS.md testing philosophy).
 * ------------------------------------------------------------------ */

/** What the mounted form project controls currently show, read through their own handles. */
interface RenderedProjectControls {
    /** Value the select control displays. */
    readonly value: unknown;
    /** Whether the select is disabled. */
    readonly disabled: unknown;
    /** Placeholder the select mounted with (constant since mount). */
    readonly placeholder: unknown;
    /** How many options the select offers. */
    readonly optionCount: number;
    /** The project list's status line beside the select. */
    readonly note: unknown;
}

/**
 * Mount the Bindings tab — the tab that owns the project select, its reload
 * button, and the list's status line — against a fixture runtime.
 *
 * @returns The runtime and the disposer that releases the mounted handles.
 */
function mountTab(input: {
    /** Arrange the state the case renders, before anything mounts. */
    readonly arrange?: (rt: PanelRuntime) => void;
    /** Host double the runtime mounts against. */
    readonly host?: PanelHost;
} = {}): { readonly rt: PanelRuntime; readonly dispose: () => void } {
    sdk.log.length = 0;
    // The fixture list answers every `loadProjects`, so Reload projects
    // re-lists the same projects rather than the harness's own.
    const host = input.host ?? fakeHost({ listProjects: async () => TWO_PROJECTS_SNAPSHOT });
    const rt = createPanelRuntime(host, fakeWindow().window);
    rt.state.config = testConfig();
    // The bindings list has landed, so the form's select is enabled the way
    // it is for an operator whose panel has read its bindings.
    rt.state.bindings.status = 'ready';
    input.arrange?.(rt);
    const dom = fakeDom();
    const spec = tabSpecs(rt).find((entry) => entry.id === 'bindings');
    if (spec === undefined) {
        throw new Error('the Bindings tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the Bindings body mounted no disposer');
    }

    // The mount repaints the pane; the form's project controls repaint
    // through the panel's own `refresh`, which is what every action calls.
    refresh(rt);

    return { rt, dispose };
}

/**
 * Read what the mounted form's project controls render right now.
 *
 * @param rt - Runtime whose bindings pane is mounted.
 * @returns The select's props and the list's status line.
 */
function rendered(rt: PanelRuntime): RenderedProjectControls {
    const selectHandle = recorded(rt.bindingsUi?.projectSelect);
    const select = selectHandle.painted();
    const { options } = select;
    const mounted = selectHandle.mounted();

    return {
        value: select.value,
        disabled: select.disabled,
        placeholder: mounted.placeholder,
        optionCount: Array.isArray(options) ? options.length : -1,
        note: recorded(rt.bindingsUi?.projectStatus).painted().text,
    };
}

/**
 * Read the project id one select paint displayed, decoding the prop.
 *
 * @param props - The props a select was last painted with.
 * @returns The displayed id, `null` when the control shows nothing.
 */
function projectIdOf(props: Record<string, unknown>): string | null {
    const { value } = props;
    if (value === null || typeof value === 'string') {
        return value;
    }

    return value === undefined ? null : String(value);
}

/**
 * Read what the binding form's Dispatch project select shows.
 *
 * @param rt - Runtime whose bindings pane is mounted.
 * @returns The form select's displayed id, or `null`.
 */
function formValue(rt: PanelRuntime): string | null {
    return projectIdOf(recorded(rt.bindingsUi?.projectSelect).painted());
}

describe('the form preselects the current-project default under one rule (AC-044)', () => {
    it('prefills the derived default, and a later list reload never displaces it', async () => {
        const { rt, dispose } = mountTab({
            arrange: (runtime) => {
                runtime.state.hostDirectory = HOST_DIRECTORY;
                applyProjectSnapshot(runtime.state.projects, TWO_PROJECTS_SNAPSHOT);
                runtime.state.config = bindingContext();
            },
        });
        try {
            expect(currentProjectDefault(rt.state), 'the default resolves').toBe(DERIVED_ID);
            startNewBinding(rt);
            expect(formValue(rt), 'the form').toBe(DERIVED_ID);
            expect(rendered(rt).value, 'repainted with it').toBe(DERIVED_ID);

            // Reload projects: the rule runs again over a fresh list, and the
            // draft keeps the default it arrived with (AC-044's "every later
            // one"). The reload button beside the select is the retry a failed
            // list read leaves behind (issue #39).
            await loadProjects(rt);
            expect(formValue(rt)).toBe(DERIVED_ID);
            expect(rendered(rt).note, 'the reload reported its own state').toMatch(/2 projects available/);
        } finally {
            dispose();
        }
    });

    it('prefers the default over the binding context when both are in force', () => {
        const { rt, dispose } = mountTab({
            arrange: (runtime) => {
                runtime.state.hostDirectory = HOST_DIRECTORY;
                applyProjectSnapshot(runtime.state.projects, TWO_PROJECTS_SNAPSHOT);
                runtime.state.config = bindingContext();
            },
        });
        try {
            expect(rt.state.config?.projectId, 'a binding context is in force').toBe(BINDING_CONTEXT_ID);
            startNewBinding(rt);
            expect(formValue(rt), 'the default wins the preselect').toBe(DERIVED_ID);
            expect(formValue(rt), 'the binding term is never preselected').not.toBe(BINDING_CONTEXT_ID);
        } finally {
            dispose();
        }
    });

    it('opens empty when only a binding context resolves — the binding term is never preselected', () => {
        const { rt, dispose } = mountTab({
            arrange: (runtime) => {
                runtime.state.hostDirectory = null;
                applyProjectSnapshot(runtime.state.projects, TWO_PROJECTS_SNAPSHOT);
                runtime.state.config = bindingContext();
            },
        });
        try {
            startNewBinding(rt);
            expect(formValue(rt), 'no directory, no default').toBeNull();
            expect(rendered(rt).value).toBeNull();
        } finally {
            dispose();
        }
    });

    it('opens the editor on the stored row even with a default in force', () => {
        const { rt, dispose } = mountTab({
            arrange: (runtime) => {
                runtime.state.hostDirectory = HOST_DIRECTORY;
                applyProjectSnapshot(runtime.state.projects, TWO_PROJECTS_SNAPSHOT);
                runtime.state.config = bindingContext();
                runtime.state.bindings.status = 'ready';
                runtime.state.bindings.bindings = [
                    {
                        bindingId: 'bnd-edit-case',
                        accountNumericUserId: '77331',
                        accountLogin: 'octocat',
                        repository: 'acme/widget',
                        projectId: BINDING_CONTEXT_ID,
                        worktreeOption: 'none',
                        triggers: { assignment: true, mention: false, reviewRequest: true },
                        state: 'active',
                        createdAt: '2026-10-06T00:00:00.000Z',
                        updatedAt: '2026-10-06T00:00:00.000Z',
                    },
                ];
                runtime.state.bindings.selectedBinding = 'bnd-edit-case';
            },
        });
        try {
            expect(currentProjectDefault(rt.state), 'a default is in force').toBe(DERIVED_ID);
            startEditingBinding(rt);
            expect(rt.state.bindings.editing).toBe(true);
            expect(rt.state.bindings.repoProjectSelection, "the row's own project").toBe(BINDING_CONTEXT_ID);
        } finally {
            dispose();
        }
    });
});

describe('the mounted control displays the default, so the SDK skip applies (FR-099, G2-1)', () => {
    it('repaints the form select on the derived id, with one project select and no storage write', async () => {
        const storage = createStorageDouble();
        const { rt, dispose } = mountTab({
            host: fakeHost({
                storage: storage.storage,
                listProjects: async () => TWO_PROJECTS_SNAPSHOT,
            }),
            arrange: (runtime) => {
                runtime.state.hostDirectory = HOST_DIRECTORY;
                applyProjectSnapshot(runtime.state.projects, TWO_PROJECTS_SNAPSHOT);
                runtime.state.config = bindingContext();
            },
        });
        try {
            // The load-bearing assertion (Gate-2 G2-1): the **repainted**
            // select's `value:` *is* the derived id, while no stored pick
            // exists anywhere to have produced it — issue #39 removed the
            // pick key and its machinery, so the default is the only source
            // left. That is the fact which makes the SDK's verified
            // same-value `onChange` skip apply when a click re-selects it.
            startNewBinding(rt);
            const select = recorded(rt.bindingsUi?.projectSelect);
            expect(select.painted().value, 'repainted props').toBe(DERIVED_ID);
            expect(rt.state.bindings.repoProjectSelection, 'the draft holds it too').toBe(DERIVED_ID);

            // Exactly one project select is on screen: the form's *Dispatch
            // project* field. The panel-level *OpenChamber project* picker
            // (issue #39) is gone rather than second.
            const projectSelects = sdk.log.filter(
                (entry) => entry.key === 'mountSelect' && entry.props.label === 'Dispatch project',
            );
            expect(projectSelects).toHaveLength(1);
            const retiredSelects = sdk.log.filter(
                (entry) => entry.key === 'mountSelect' && entry.props.label === 'OpenChamber project',
            );
            expect(retiredSelects, 'the panel-level picker no longer mounts').toEqual([]);

            // A click matching the displayed value fires no change event
            // (the SDK's same-value skip), so it reaches no handler — and
            // with the pick machinery gone there is no write path left for
            // any of these flows to reach.
            await loadProjects(rt);
            startNewBinding(rt);
            await tick();
            expect(storage.operations, 'no storage write of any kind').toEqual([]);
        } finally {
            dispose();
        }
    });
});

/** One of AC-046's refusals: a list arrangement and the directory beside it. */
interface FailClosedCase {
    /** The state, named for the failure message. */
    readonly name: string;
    /** The directory the feature-on run records; `null` is the first state. */
    readonly directory: string | null;
    /** The snapshot (or rejection) the list answers with. */
    readonly snapshot: GuestProjectsSnapshot | 'rejection';
}

/** What one fail-closed run rendered, and what it resolved. */
interface FailClosedRun {
    /** What the mounted picker showed. */
    readonly rendered: RenderedProjectControls;
    /** What the default resolved to — always `null` for these cases. */
    readonly resolved: string | null;
}

/**
 * Mount one AC-046 state and read it back.
 *
 * The list is loaded through the real `loadProjects`, so the rejection case
 * is an actual rejected `listProjects()` folded into state rather than a
 * hand-written end state.
 *
 * @returns The rendered control and the resolved default.
 */
async function failClosedRun(input: {
    /** The state's directory, recorded as the mount would record it. */
    readonly directory: string | null;
    /** The snapshot (or rejection) the list answers with. */
    readonly snapshot: GuestProjectsSnapshot | 'rejection';
}): Promise<FailClosedRun> {
    const { snapshot } = input;
    const answer: () => Promise<GuestProjectsSnapshot> =
        snapshot === 'rejection' ? rejectingListProjects : async () => snapshot;
    const { rt, dispose } = mountTab({
        host: fakeHost({ listProjects: answer }),
        arrange: (runtime) => recordHostDirectory(runtime, input.directory),
    });
    try {
        await loadProjects(rt);
        refresh(rt);
        // The form is the only project control left, so the case reads what
        // it shows once a draft is open — which is where the default lands.
        startNewBinding(rt);

        return { rendered: rendered(rt), resolved: currentProjectDefault(rt.state) };
    } finally {
        dispose();
    }
}

describe('nothing resolves in any state FR-096(b) refuses, and no control is affected (AC-046)', () => {
    it('holds the six named states to the output they have with no directory in force', async () => {
        const cases: readonly FailClosedCase[] = [
            { name: 'a null ready-context directory', directory: null, snapshot: MATCHING_SNAPSHOT },
            { name: 'a directory no project matches', directory: '/nowhere', snapshot: MATCHING_SNAPSHOT },
            { name: 'two projects sharing one directory', directory: HOST_DIRECTORY, snapshot: COLLIDING_SNAPSHOT },
            { name: 'a list still loading', directory: HOST_DIRECTORY, snapshot: LOADING_SNAPSHOT },
            { name: 'an error snapshot', directory: HOST_DIRECTORY, snapshot: ERROR_SNAPSHOT },
            { name: 'a listProjects() rejection', directory: HOST_DIRECTORY, snapshot: 'rejection' },
        ];

        for (const entry of cases) {
            const feature = await failClosedRun({ directory: entry.directory, snapshot: entry.snapshot });
            const control = await failClosedRun({ directory: null, snapshot: entry.snapshot });

            expect(feature.resolved, `${entry.name}: no default`).toBeNull();
            expect(feature.rendered, `${entry.name}: no control is disabled, delayed or invalidated`)
                .toEqual(control.rendered);
        }

        // The null-directory state *is* the control, so its own props are
        // asserted here rather than left to pass by self-comparison: a
        // ready list still offers its one option and paints today's note,
        // with no default in force.
        const baseline = await failClosedRun({ directory: null, snapshot: MATCHING_SNAPSHOT });
        expect(baseline.resolved, 'no directory, no default').toBeNull();
        expect(baseline.rendered).toMatchObject({
            value: null,
            disabled: false,
            placeholder: 'Pick a project',
            optionCount: 1,
            note: '1 project available.',
        });
    });

    it('folds nothing: /dir against /dir/, and a case-only difference, both yield no default', async () => {
        const near = await failClosedRun({ directory: HOST_DIRECTORY, snapshot: NEAR_MISS_SNAPSHOT });
        expect(near.resolved).toBeNull();
        expect(near.rendered.value).toBeNull();

        const cased = await failClosedRun({ directory: HOST_DIRECTORY, snapshot: CASE_MISS_SNAPSHOT });
        expect(cased.resolved).toBeNull();
        expect(cased.rendered.value).toBeNull();

        // Positive control: the exact pair under the same directory does
        // resolve, so the two refusals above are refusing a match rather
        // than passing because nothing resolves at all.
        const exact = await failClosedRun({ directory: HOST_DIRECTORY, snapshot: MATCHING_SNAPSHOT });
        expect(exact.resolved).toBe(DERIVED_ID);
        expect(exact.rendered.value).toBe(DERIVED_ID);
    });
});

describe('a directory change while the panel is open changes nothing (AC-045)', () => {
    it('keeps the recorded snapshot, the rendered value and the draft, and registers no listener', async () => {
        const { rt, dispose } = mountTab({
            arrange: (runtime) => {
                runtime.state.hostDirectory = HOST_DIRECTORY;
                applyProjectSnapshot(runtime.state.projects, TWO_PROJECTS_SNAPSHOT);
                runtime.state.config = bindingContext();
            },
        });
        try {
            startNewBinding(rt);
            const before = rendered(rt);
            expect(before.value).toBe(DERIVED_ID);

            // Every path the panel drives while open: a repaint, the Reload
            // projects button, and the bindings Refresh's own read.
            refresh(rt);
            await loadProjects(rt);
            await Promise.resolve();

            expect(rt.state.hostDirectory, 'the recorded snapshot is untouched').toBe(HOST_DIRECTORY);
            expect(rendered(rt), 'no value and no control moved').toEqual(before);
            expect(rt.state.bindings.repoProjectSelection, 'no draft moved').toBe(DERIVED_ID);
            expect(rt.unsubscribes, 'the mounted body registers no listener').toHaveLength(0);

            // And there is nothing anywhere that *could* learn of the change:
            // the mount's record is the panel's only write of the directory.
            const appSource = readFileSync(resolve(ROOT, 'src/app.ts'), 'utf8');
            expect(occurrences(appSource, /(?<!function )\brecordHostDirectory\s*\(/gu), 'one writer').toBe(1);
            for (const file of scanPanelSurface()) {
                expect(file.text, `${file.path} registers no directory listener`).not.toMatch(
                    DIRECTORY_REGISTRATION,
                );
            }
        } finally {
            dispose();
        }
    });
});

/* ------------------------------------------------------------------ *
 * The loopback half: the untouched save, the zero-write count, and the
 * storage-key census (FR-097(d), FR-096(a), SC-014).
 * ------------------------------------------------------------------ */

/** Credential registered with this suite; never appears in any answer. */
const REGISTERED_TOKEN = `current-project-credential-${'p'.repeat(32)}`;

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = '77331';

/** Login the fixture token belongs to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Repository the untouched add-form save binds. */
const ADD_REPOSITORY = 'acme/current-default';

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    while (running.length > 0) {
        await running.pop()?.shutdown();
    }
});

/** Build a header map without writing HTTP header names as object keys. */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** Headers for the routes that take a JSON body. */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

/**
 * Start the real service on a temp dir against a fake GitHub, and register
 * the fixture account so the bindings route will accept a grant.
 *
 * @returns The loopback service this suite drives.
 */
async function startWithAccount(): Promise<TestService> {
    const github = fakeGitHub({
        user: {
            body: userBody({ id: Number(ACCOUNT_ID), login: ACCOUNT_LOGIN }),
            headers: headerMap([['x-oauth-sopes', 'repo, user']]),
        },
    });
    const service = await startTestService({ github: github.verifier });
    running.push(service);
    await service.handle.reconciled;

    const registered = await service.call(VERIFY_PATH, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ token: REGISTERED_TOKEN }),
    });
    expect(registered.status).toBe(201);

    return service;
}

/**
 * Bridge one panel runtime onto the loopback service, with its own storage
 * double so every storage write can be counted.
 *
 * @returns The host double the runtime runs against.
 */
function bridgedHost(service: TestService, storage: PanelHost['storage']): PanelHost {
    return fakeHost({
        storage,
        serviceRequest: async (request) => {
            const init: RequestInit = { method: request.method };
            if (request.body !== undefined) {
                init.headers = jsonHeaders();
                init.body = request.body;
            }

            const response = await service.call(request.path, init);

            return { status: response.status, body: await response.text() };
        },
    });
}

/**
 * Read the bindings back **out of the service**, never out of panel state.
 *
 * @returns The stored rows, as the panel's own parser reads them.
 */
async function storedBindings(service: TestService): Promise<readonly PanelBinding[]> {
    const response = await service.call(BINDINGS_PATH);
    expect(response.status).toBe(200);
    const parsed = parseBindingsBody(await response.text());
    expect(parsed).not.toBeNull();

    return parsed?.bindings ?? [];
}

/** Complete an add-mode draft so only the project step can decide it. */
function completeDraft(rt: PanelRuntime): void {
    rt.state.bindings.repoInput = ADD_REPOSITORY;
    rt.state.bindings.accounts = [
        { numericUserId: ACCOUNT_ID, login: ACCOUNT_LOGIN, displayName: null, usable: true },
    ];
    rt.state.bindings.accountSelection = ACCOUNT_ID;
}

describe('an untouched add-mode save writes the default into that binding, and never the key', () => {
    it('saves the default after the ready snapshot, refuses before it, and never writes the key (SC-014)', async () => {
        const service = await startWithAccount();
        const storage = createStorageDouble({ [LEDGER_STORAGE_KEY]: [] });

        // A form opened **after** the ready snapshot: the mount records the
        // directory, the list lands, and the draft arrives prefilled.
        const late = createTestRuntime(bridgedHost(service, storage.storage));
        recordHostDirectory(late, PROJECT_DIR);
        await loadProjects(late);
        expect(currentProjectDefault(late.state), 'the default resolves').toBe(PROJECT_ID);

        // Reload projects — the second derivation moment (plan J8).
        await loadProjects(late);

        startNewBinding(late);
        expect(late.state.bindings.repoProjectSelection).toBe(PROJECT_ID);
        completeDraft(late);
        await bindRepository(late);
        stopRelayPolling(late);

        const afterSave = await storedBindings(service);
        expect(afterSave).toHaveLength(1);
        expect(afterSave[0]?.repository, 'that binding').toBe(ADD_REPOSITORY);
        expect(afterSave[0]?.projectId, 'the default, saved as the binding own project').toBe(PROJECT_ID);

        // A form opened **before** the first ready snapshot: it opens empty,
        // does not fill when the list lands, and an untouched save is today's
        // refusal at the project step (FR-097(d)'s own last clause).
        const early = createTestRuntime(bridgedHost(service, storage.storage));
        recordHostDirectory(early, PROJECT_DIR);
        startNewBinding(early);
        expect(early.state.bindings.repoProjectSelection, 'nothing resolves yet').toBeNull();
        await loadProjects(early);
        expect(early.state.bindings.repoProjectSelection, 'no retroactive fill').toBeNull();
        completeDraft(early);
        await bindRepository(early);
        stopRelayPolling(early);

        expect(readDraft(early.state.bindings), 'the draft still refuses').toBeNull();
        expect(early.state.bindings.note).toBe('Pick the OpenChamber project the dispatch opens in.');
        expect(await storedBindings(service), 'the refusal wrote nothing').toHaveLength(1);

        // Zero writes to the retired pick key across every enumerated
        // moment, and the key's count among `host.storage` keys is
        // unchanged — v1.15.0 removed the key with the panel-level picker
        // (issue #39), so this is a write no code can make any more.
        expect(
            storage.operations.filter((operation) => operation === 'set:mecha-turk:project'),
            'the default is never stored',
        ).toEqual([]);
        expect([...(await storage.storage.keys())].toSorted(byText), 'the key set never gains a member')
            .toEqual([LEDGER_STORAGE_KEY]);
    });
});
