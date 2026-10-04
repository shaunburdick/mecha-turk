import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GuestProjectsSnapshot } from '@openchamber/sdk';
import { createPanelRuntime } from '../src/panel-state.ts';
import type { PanelRuntime, ProjectPickerState } from '../src/panel-state.ts';
import {
    NOT_LISTED_LABEL,
    PROJECT_REGISTRATION_ROUTES,
    applyProjectSnapshot,
    describeProjectSelection,
    isSelectableProject,
    notListedGuidance,
    pickerNote,
    pickerOptions,
    pickerPlaceholder,
    projectOption,
    selectedProjectId,
} from '../src/project-picker.ts';
import {
    PROJECT_STORAGE_KEY,
    copyProjectId,
    loadProjects,
    readStoredSelection,
    rejectProjectSelection,
    restoreProjectSelection,
    selectBindingProject,
    storeProjectSelection,
} from '../src/project-actions.ts';
import { readDraft } from '../src/bindings.ts';
import { byText } from './support/sort.ts';
import {
    PROJECTS,
    PROJECT_ID,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
    fakeWindow,
    testConfig,
} from './support/panel.ts';

/** A second project used to prove list rendering and selection precedence. */
const OTHER_ID = 'prj_7';

/** Error message the storage doubles fail with. */
const STORAGE_FAILURE = 'storage offline';

/** Snapshot holding two registered projects. */
const TWO_PROJECTS: GuestProjectsSnapshot = {
    kind: 'projects',
    state: 'ready',
    projects: [
        { id: PROJECT_ID, name: 'widget', directory: '/home/agent/acme/widget' },
        { id: OTHER_ID, name: 'gadget', directory: '/home/agent/acme/gadget' },
    ],
};

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Source and bundle directories the project-creation scan reads (AC-121). */
const SCANNED_DIRS: readonly string[] = ['src', 'panel', 'service'];

/** Storage double whose reads always fail. */
function failingStorage(): Parameters<typeof readStoredSelection>[0]['storage'] {
    return {
        ...createStorageDouble().storage,
        get: async () => {
            throw new Error(STORAGE_FAILURE);
        },
    };
}

/** Storage double whose writes always fail. */
function refusingStorage(): Parameters<typeof storeProjectSelection>[0]['storage'] {
    return {
        ...createStorageDouble().storage,
        set: async () => {
            throw new Error('quota exceeded');
        },
    };
}

/**
 * Build a picker in a specific state.
 *
 * @param overrides - Members to replace in the initial picker state.
 * @returns The picker state under test.
 */
function picker(overrides: Partial<ProjectPickerState> = {}): ProjectPickerState {
    return { status: 'idle', projects: [], note: '', ...overrides };
}

describe('project option rendering', () => {
    it('labels a project with name and id, and offers options only for a ready list', () => {
        const option = projectOption({ id: PROJECT_ID, name: 'widget', directory: '/srv/widget' });

        expect(option.id).toBe(PROJECT_ID);
        expect(option.label).toBe(`widget · ${PROJECT_ID}`);
        expect(option.hint).toBe('/srv/widget');

        expect(pickerOptions(picker()), 'idle').toEqual([]);
        expect(pickerOptions(picker({ status: 'loading' })), 'loading').toEqual([]);
        expect(pickerOptions(picker({ status: 'error', projects: PROJECTS.projects })), 'error').toEqual([]);
        expect(pickerOptions(picker({ status: 'ready' })), 'ready but empty').toEqual([]);

        const options = pickerOptions(picker({ status: 'ready', projects: TWO_PROJECTS.projects }));
        expect(options.map((rendered) => rendered.id)).toEqual([PROJECT_ID, OTHER_ID]);
    });
});

describe('picker status line and placeholder', () => {
    it('derives the line and placeholder from the status, and prefers a dynamic note', () => {
        expect(pickerNote(picker())).toMatch(/not been loaded/);
        expect(pickerNote(picker({ status: 'loading' }))).toMatch(/Loading/);
        expect(pickerNote(picker({ status: 'error' }))).toMatch(/unavailable/);
        expect(pickerNote(picker({ status: 'ready' }))).toMatch(/No projects/);
        expect(pickerNote(picker({ status: 'ready', projects: TWO_PROJECTS.projects }))).toBe('2 projects available.');

        const note = 'Copied prj_42 to the clipboard.';
        expect(pickerNote(picker({ status: 'ready', note })), 'a dynamic note').toBe(note);

        expect(pickerPlaceholder(picker({ status: 'loading' }))).toMatch(/Loading/);
        expect(pickerPlaceholder(picker({ status: 'error' }))).toMatch(/unavailable/);
        expect(pickerPlaceholder(picker({ status: 'ready' }))).toMatch(/No projects/);
    });
});

describe('selection guards', () => {
    it('accepts only loaded ids, and resolves and names the effective selection', () => {
        const loaded = picker({ status: 'ready', projects: TWO_PROJECTS.projects });

        expect(isSelectableProject(loaded, OTHER_ID)).toBe(true);
        expect(isSelectableProject(loaded, 'prj_invented')).toBe(false);
        expect(isSelectableProject(picker({ status: 'error', projects: TWO_PROJECTS.projects }), OTHER_ID))
            .toBe(false);
        expect(isSelectableProject(picker(), OTHER_ID)).toBe(false);

        const { state } = createTestRuntime(fakeHost());
        state.config = testConfig();
        expect(selectedProjectId(state)).toBe(PROJECT_ID);

        state.projectSelection = OTHER_ID;
        expect(selectedProjectId(state)).toBe(OTHER_ID);

        state.config = null;
        expect(selectedProjectId(state)).toBe(OTHER_ID);

        state.projectSelection = null;
        expect(selectedProjectId(state)).toBeNull();

        const fresh = createPanelRuntime(fakeHost(), fakeWindow().window);
        expect(describeProjectSelection(fresh.state)).toMatch(/dispatch stays blocked/);

        fresh.state.config = testConfig();
        expect(describeProjectSelection(fresh.state)).toMatch(/binding/);

        fresh.state.projectSelection = OTHER_ID;
        expect(describeProjectSelection(fresh.state)).toContain(OTHER_ID);
        expect(describeProjectSelection(fresh.state)).toMatch(/panel picker/);
    });
});

describe('applyProjectSnapshot', () => {
    it('replaces the list on ready, and retains it on error or loading', () => {
        const replaced = picker({ status: 'error', note: 'stale note', projects: PROJECTS.projects });
        applyProjectSnapshot(replaced, TWO_PROJECTS);
        expect(replaced.status).toBe('ready');
        expect(replaced.projects.map((project) => project.id)).toEqual([PROJECT_ID, OTHER_ID]);
        expect(replaced.note).toBe('');

        const errored = picker({ status: 'ready', projects: PROJECTS.projects });
        applyProjectSnapshot(errored, { ...PROJECTS, state: 'error' });
        expect(errored.status).toBe('error');
        expect(errored.projects).toEqual(PROJECTS.projects);

        const loading = picker({ status: 'ready', note: 'copied', projects: PROJECTS.projects });
        applyProjectSnapshot(loading, { ...PROJECTS, state: 'loading' });
        expect(loading.status).toBe('loading');
        expect(loading.projects).toEqual(PROJECTS.projects);
    });
});

describe('readStoredSelection', () => {
    it('returns the stored id, reads unusable values as nothing, and surfaces a refusal', async () => {
        const read = await readStoredSelection({
            storage: createStorageDouble({ [PROJECT_STORAGE_KEY]: PROJECT_ID }).storage,
        });
        expect(read).toEqual({ ok: true, projectId: PROJECT_ID });

        const missing = await readStoredSelection({ storage: createStorageDouble().storage });
        const wrongType = await readStoredSelection({
            storage: createStorageDouble({ [PROJECT_STORAGE_KEY]: 42 }).storage,
        });
        const malformed = await readStoredSelection({
            storage: createStorageDouble({ [PROJECT_STORAGE_KEY]: '  ' }).storage,
        });
        expect(missing, 'an absent key').toEqual({ ok: true, projectId: null });
        expect(wrongType, 'a non-text value').toEqual({ ok: true, projectId: null });
        expect(malformed, 'a malformed value').toEqual({ ok: true, projectId: null });

        const refused = await readStoredSelection({ storage: failingStorage() });
        expect(refused.ok, 'a refused read').toBe(false);
        if (!refused.ok) {
            expect(refused.problem).toContain(STORAGE_FAILURE);
        }
    });
});

describe('storeProjectSelection', () => {
    it('writes the id under the namespaced key, and refuses bad ids and failed writes', async () => {
        const storage = createStorageDouble();
        const write = await storeProjectSelection({ storage: storage.storage }, PROJECT_ID);

        expect(write).toEqual({ ok: true });
        expect(storage.operations).toEqual([`set:${PROJECT_STORAGE_KEY}`]);
        expect(storage.values.get(PROJECT_STORAGE_KEY)).toBe(PROJECT_ID);

        const untouched = createStorageDouble();
        const refusedId = await storeProjectSelection({ storage: untouched.storage }, ' '.repeat(3));
        expect(refusedId.ok, 'an invalid id').toBe(false);
        expect(untouched.operations, 'an invalid id must not touch storage').toEqual([]);

        const failed = await storeProjectSelection({ storage: refusingStorage() }, PROJECT_ID);
        expect(failed.ok, 'a refused write').toBe(false);
    });
});

describe('restoreProjectSelection', () => {
    it('restores the stored selection, and explains or drops what it cannot read', async () => {
        const stored = createTestRuntime(fakeHost({
            storage: createStorageDouble({ [PROJECT_STORAGE_KEY]: OTHER_ID }).storage,
        }));
        await restoreProjectSelection(stored);
        expect(stored.state.projectSelection).toBe(OTHER_ID);

        const empty = createTestRuntime(fakeHost({ storage: createStorageDouble().storage }));
        await restoreProjectSelection(empty);
        expect(empty.state.projectSelection, 'nothing usable is stored').toBeNull();

        const failed = createTestRuntime(fakeHost({ storage: failingStorage() }));
        await restoreProjectSelection(failed);
        expect(failed.state.projectSelection, 'a refused read').toBeNull();
        expect(failed.state.projects.note).toContain(STORAGE_FAILURE);

        const late = createTestRuntime(fakeHost({
            storage: createStorageDouble({ [PROJECT_STORAGE_KEY]: OTHER_ID }).storage,
        }));
        const pending = restoreProjectSelection(late);
        late.disposed = true;
        await pending;
        expect(late.state.projectSelection, 'nothing lands after teardown').toBeNull();
    });
});

describe('loadProjects', () => {
    it('renders ready and empty lists, fails closed on a refused list, and lands nothing after teardown', async () => {
        const ready = createTestRuntime(fakeHost({ listProjects: async () => TWO_PROJECTS }));
        await loadProjects(ready);
        expect(ready.state.projects.status).toBe('ready');
        expect(ready.state.projects.projects).toHaveLength(2);
        expect(pickerOptions(ready.state.projects)).toHaveLength(2);

        const none = createTestRuntime(fakeHost({ listProjects: async () => ({ ...PROJECTS, projects: [] }) }));
        await loadProjects(none);
        expect(none.state.projects.status, 'an empty ready list').toBe('ready');
        expect(pickerNote(none.state.projects)).toMatch(/No projects/);
        expect(pickerOptions(none.state.projects)).toEqual([]);

        const refused = createTestRuntime(
            fakeHost({
                listProjects: async () => {
                    throw new Error('host offline');
                },
            }),
        );
        const before = refused.state.ledger.entries.length;
        await expect(loadProjects(refused)).resolves.toBeUndefined();
        expect(refused.state.projects.status).toBe('error');
        expect(refused.state.config).toEqual(testConfig());
        expect(refused.state.ledger.entries).toHaveLength(before);
        expect(refused.state.evidence).toBeNull();

        const errored = createTestRuntime(fakeHost({ listProjects: async () => ({ ...PROJECTS, state: 'error' }) }));
        await loadProjects(errored);
        expect(errored.state.projects.status).toBe('error');
        expect(pickerOptions(errored.state.projects), 'an error snapshot offers nothing').toEqual([]);
        expect(isSelectableProject(errored.state.projects, PROJECT_ID)).toBe(false);

        const late = createTestRuntime(fakeHost());
        const pending = loadProjects(late);
        late.disposed = true;
        await pending;
        expect(late.state.projects.status, 'nothing lands after teardown').toBe('loading');
        expect(late.state.projects.projects).toEqual([]);
    });
});

describe('copyProjectId', () => {
    it('copies the effective id, says so when none is selected, and reports a refusal', async () => {
        const copied: string[] = [];
        const runtime = createTestRuntime(
            fakeHost({
                writeClipboard: async (text) => {
                    copied.push(text);
                },
            }),
        );
        await copyProjectId(runtime);
        expect(copied).toEqual([PROJECT_ID]);
        expect(runtime.state.projects.note).toContain(PROJECT_ID);

        const noneCopied: string[] = [];
        const empty = createPanelRuntime(
            fakeHost({
                writeClipboard: async (text) => {
                    noneCopied.push(text);
                },
            }),
            fakeWindow().window,
        );
        await copyProjectId(empty);
        expect(noneCopied, 'nothing is copied with no selection').toEqual([]);
        expect(empty.state.projects.note).toMatch(/no project is selected/);

        const refused = createTestRuntime(
            fakeHost({
                writeClipboard: async () => {
                    throw new Error('clipboard denied');
                },
            }),
        );
        await expect(copyProjectId(refused)).resolves.toBeUndefined();
    });
});

describe('rejectProjectSelection', () => {
    it('changes nothing and explains a stale pick, naming an unloaded list separately', () => {
        const runtime = createTestRuntime(fakeHost({ listProjects: async () => TWO_PROJECTS }));
        runtime.state.projects.status = 'ready';
        runtime.state.projects.projects = TWO_PROJECTS.projects;

        rejectProjectSelection(runtime, 'prj_invented');

        expect(runtime.state.projectSelection).toBeNull();
        expect(runtime.state.config?.projectId).toBe(PROJECT_ID);
        expect(runtime.state.projects.note).toContain('prj_invented');
        expect(runtime.state.projects.note).toMatch(/not in the loaded list/);

        const unloaded = createTestRuntime(fakeHost());
        rejectProjectSelection(unloaded, PROJECT_ID);
        expect(unloaded.state.projects.note).toMatch(/No project list is loaded/);
    });
});

describe('"Not listed?" guidance (FR-070, AC-121)', () => {
    it('names all three routes, states the never-creates rule, and paints from both pickers', () => {
        const guidance = notListedGuidance();

        expect(guidance.startsWith(NOT_LISTED_LABEL)).toBe(true);
        expect(PROJECT_REGISTRATION_ROUTES).toHaveLength(3);
        expect(guidance).toMatch(/never creates/);
        expect(guidance).toContain('project_missing');

        // The Bindings pane's mount moved into `bindings-body.ts` with the
        // 2026-10-01 editor re-cut; the guidance still paints from there.
        const bindingPicker = readFileSync(resolve(ROOT, 'src/bindings-body.ts'), 'utf8');
        const panelUiSource = readFileSync(resolve(ROOT, 'src/panel-ui.ts'), 'utf8');

        expect(bindingPicker).toContain('notListedGuidance()');
        expect(panelUiSource).toContain('notListedGuidance()');
    });
});

/**
 * Build a runtime whose project list is loaded and whose add form is
 * otherwise complete, so only the project step can decide the outcome.
 *
 * @returns A runtime ready for one project selection.
 */
function loadedBindingDraft(): PanelRuntime {
    const rt = createTestRuntime(fakeHost());
    rt.state.projects.status = 'ready';
    rt.state.projects.projects = PROJECTS.projects;
    rt.state.bindings.repoInput = 'acme/widget';
    rt.state.bindings.accounts = [{ numericUserId: '77331', login: 'acme-bot', displayName: null, usable: true }];
    rt.state.bindings.accountSelection = '77331';

    return rt;
}

describe('binding picker selection guard (FR-070)', () => {
    it('refuses unregistered and unloaded picks, and adopts only an id the list contains', () => {
        const refused = loadedBindingDraft();
        selectBindingProject(refused, 'prj_not_registered');
        expect(refused.state.bindings.repoProjectSelection).toBeNull();
        expect(refused.state.bindings.note).toMatch(/not in the loaded list/);
        // No draft becomes a binding, so the service's own `project_missing`
        // path is untouched until a registered project is chosen.
        expect(readDraft(refused.state.bindings)).toBeNull();
        expect(refused.state.bindings.note).toMatch(/Pick the OpenChamber project/);

        const unloaded = createTestRuntime(fakeHost());
        selectBindingProject(unloaded, PROJECT_ID);
        expect(unloaded.state.bindings.repoProjectSelection, 'no list is loaded').toBeNull();
        expect(unloaded.state.bindings.note).toMatch(/No project list is loaded/);
        expect(readDraft(unloaded.state.bindings)).toBeNull();

        const adopted = loadedBindingDraft();
        selectBindingProject(adopted, PROJECT_ID);
        expect(adopted.state.bindings.repoProjectSelection).toBe(PROJECT_ID);
        expect(adopted.state.bindings.note).toBe('');
        expect(readDraft(adopted.state.bindings)?.projectId).toBe(PROJECT_ID);

        selectBindingProject(adopted, 'prj_not_registered');
        expect(adopted.state.bindings.repoProjectSelection, 'a later refusal changes nothing')
            .toBe(PROJECT_ID);
    });
});

/**
 * A *call* that would create a project, in whichever spelling it uses.
 *
 * The trailing `(` is what keeps `createProjectGroup` — a DOM helper in
 * `panel-ui.ts` that builds a `<div>` for the picker — out of the scan:
 * `Project` there is followed by `Group`, so the boundary before the call
 * parenthesis never holds. Prose is out of reach too, because the pattern
 * admits no space between the verb and the noun ("Add project", the route
 * the guidance names, is a different string entirely).
 */
const PROJECT_CREATE_CALL = /\b(?:create|add|register|insert|spawn)[-_]?[Pp]roject\s*\(/;

/** A REST path addressing projects — the only way to create one over HTTP. */
const PROJECT_ENDPOINT = /\/projects?(?:\/|['"]|$)/;

/** One file the project-creation scan read. */
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
function scanProjectCreationSurface(): readonly ScannedFile[] {
    const files: ScannedFile[] = [];
    for (const dir of SCANNED_DIRS) {
        const entries = readdirSync(resolve(ROOT, dir), { recursive: true }).map((entry) => String(entry));
        for (const entry of entries) {
            if (!entry.endsWith('.ts') && !entry.endsWith('.js')) {
                continue;
            }

            files.push({ path: `${dir}/${entry}`, text: readFileSync(resolve(ROOT, dir, entry), 'utf8') });
        }
    }

    return files;
}

describe('no project-creation call exists anywhere (AC-121)', () => {
    it('reads the real sources and bundles, finds no creation call or endpoint, and keeps the host read-only', () => {
        const files = scanProjectCreationSurface();
        expect(files.length).toBeGreaterThan(50);
        expect(files.some((file) => file.path === 'panel/main.js')).toBe(true);
        expect(files.some((file) => file.path === 'service/main.js')).toBe(true);

        // The scan has to bite: a pattern that matches nothing would read as
        // green while proving nothing about the code above it.
        expect(PROJECT_CREATE_CALL.test('host.createProject()')).toBe(true);
        expect(PROJECT_ENDPOINT.test("path: '/repos/acme/widget/projects'")).toBe(true);

        for (const file of files) {
            expect(file.text, `${file.path} must not call a project-creation method`).not.toMatch(
                PROJECT_CREATE_CALL,
            );
            expect(file.text, `${file.path} must not address a projects endpoint`).not.toMatch(PROJECT_ENDPOINT);
        }

        const session = readFileSync(resolve(ROOT, 'src/session.ts'), 'utf8');
        // The Pick list itself, not every quoted word in the file's docs:
        // this is the surface a future module has to widen to reach a host
        // project-creation call, so it is the list that has to stay read-only.
        const pick = session.match(/export type PanelHost = Pick<\s*HostClient,\s*([\s\S]*?)\s*>/);
        expect(pick).not.toBeNull();

        const members = [...(pick?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
        const projectMembers = members.filter((member) => member.includes('Project')).toSorted(byText);

        expect(projectMembers).toEqual(['listProjects', 'onProjects']);
    });
});
