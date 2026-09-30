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
    it('puts the name and id in the label and the directory in the hint', () => {
        const option = projectOption({ id: PROJECT_ID, name: 'widget', directory: '/srv/widget' });

        expect(option.id).toBe(PROJECT_ID);
        expect(option.label).toBe(`widget · ${PROJECT_ID}`);
        expect(option.hint).toBe('/srv/widget');
    });

    it('offers no option until the host reports a ready list', () => {
        expect(pickerOptions(picker())).toEqual([]);
        expect(pickerOptions(picker({ status: 'loading' }))).toEqual([]);
        expect(pickerOptions(picker({ status: 'error', projects: PROJECTS.projects }))).toEqual([]);
        expect(pickerOptions(picker({ status: 'ready' }))).toEqual([]);
    });

    it('renders every project of a ready list', () => {
        const options = pickerOptions(picker({ status: 'ready', projects: TWO_PROJECTS.projects }));

        expect(options.map((option) => option.id)).toEqual([PROJECT_ID, OTHER_ID]);
    });
});

describe('picker status line and placeholder', () => {
    it('derives a line from the status when nothing dynamic happened', () => {
        expect(pickerNote(picker())).toMatch(/not been loaded/);
        expect(pickerNote(picker({ status: 'loading' }))).toMatch(/Loading/);
        expect(pickerNote(picker({ status: 'error' }))).toMatch(/unavailable/);
        expect(pickerNote(picker({ status: 'ready' }))).toMatch(/No projects/);
        expect(pickerNote(picker({ status: 'ready', projects: TWO_PROJECTS.projects }))).toBe('2 projects available.');
    });

    it('prefers a dynamic note over the derived one', () => {
        const note = 'Copied prj_42 to the clipboard.';

        expect(pickerNote(picker({ status: 'ready', note }))).toBe(note);
    });

    it('keeps the placeholder short and status-shaped', () => {
        expect(pickerPlaceholder(picker())).toBe('Select a project');
        expect(pickerPlaceholder(picker({ status: 'loading' }))).toMatch(/Loading/);
        expect(pickerPlaceholder(picker({ status: 'error' }))).toMatch(/unavailable/);
        expect(pickerPlaceholder(picker({ status: 'ready' }))).toMatch(/No projects/);
        expect(pickerPlaceholder(picker({ status: 'ready', projects: PROJECTS.projects }))).toBe('Select a project');
    });
});

describe('selection guards', () => {
    it('accepts only ids the ready list contains', () => {
        const loaded = picker({ status: 'ready', projects: TWO_PROJECTS.projects });

        expect(isSelectableProject(loaded, OTHER_ID)).toBe(true);
        expect(isSelectableProject(loaded, 'prj_invented')).toBe(false);
        expect(isSelectableProject(picker({ status: 'error', projects: TWO_PROJECTS.projects }), OTHER_ID)).toBe(false);
        expect(isSelectableProject(picker(), OTHER_ID)).toBe(false);
    });

    it('resolves the effective id from the panel selection first', () => {
        const { state } = createTestRuntime(fakeHost());
        state.config = testConfig();
        expect(selectedProjectId(state)).toBe(PROJECT_ID);

        state.projectSelection = OTHER_ID;
        expect(selectedProjectId(state)).toBe(OTHER_ID);

        state.config = null;
        expect(selectedProjectId(state)).toBe(OTHER_ID);

        state.projectSelection = null;
        expect(selectedProjectId(state)).toBeNull();
    });

    it('names the source of the effective selection', () => {
        const { state } = createPanelRuntime(fakeHost(), fakeWindow().window);
        expect(describeProjectSelection(state)).toMatch(/dispatch stays blocked/);

        state.config = testConfig();
        expect(describeProjectSelection(state)).toMatch(/integration setting/);

        state.projectSelection = OTHER_ID;
        expect(describeProjectSelection(state)).toContain(OTHER_ID);
        expect(describeProjectSelection(state)).toMatch(/panel picker/);
    });
});

describe('applyProjectSnapshot', () => {
    it('replaces the list on a ready snapshot and clears the note', () => {
        const target = picker({ status: 'error', note: 'stale note', projects: PROJECTS.projects });

        applyProjectSnapshot(target, TWO_PROJECTS);

        expect(target.status).toBe('ready');
        expect(target.projects.map((project) => project.id)).toEqual([PROJECT_ID, OTHER_ID]);
        expect(target.note).toBe('');
    });

    it('retains the previous list when the host reports an error', () => {
        const target = picker({ status: 'ready', projects: PROJECTS.projects });

        applyProjectSnapshot(target, { ...PROJECTS, state: 'error' });

        expect(target.status).toBe('error');
        expect(target.projects).toEqual(PROJECTS.projects);
    });

    it('stays loading without dropping what the list already held', () => {
        const target = picker({ status: 'ready', note: 'copied', projects: PROJECTS.projects });

        applyProjectSnapshot(target, { ...PROJECTS, state: 'loading' });

        expect(target.status).toBe('loading');
        expect(target.projects).toEqual(PROJECTS.projects);
    });
});

describe('readStoredSelection', () => {
    it('returns the stored id', async () => {
        const storage = createStorageDouble({ [PROJECT_STORAGE_KEY]: PROJECT_ID });

        const read = await readStoredSelection({ storage: storage.storage });

        expect(read).toEqual({ ok: true, projectId: PROJECT_ID });
    });

    it('reports nothing stored when the key is absent or not a string', async () => {
        const missing = await readStoredSelection({ storage: createStorageDouble().storage });
        const wrongType = await readStoredSelection({
            storage: createStorageDouble({ [PROJECT_STORAGE_KEY]: 42 }).storage,
        });

        expect(missing).toEqual({ ok: true, projectId: null });
        expect(wrongType).toEqual({ ok: true, projectId: null });
    });

    it('treats a malformed stored value as nothing stored', async () => {
        const storage = createStorageDouble({ [PROJECT_STORAGE_KEY]: '  ' });

        const read = await readStoredSelection({ storage: storage.storage });

        expect(read).toEqual({ ok: true, projectId: null });
    });

    it('surfaces a refused read instead of swallowing it', async () => {
        const read = await readStoredSelection({ storage: failingStorage() });

        expect(read.ok).toBe(false);
        if (!read.ok) {
            expect(read.problem).toContain(STORAGE_FAILURE);
        }
    });
});

describe('storeProjectSelection', () => {
    it('writes the id under the extension-namespaced key', async () => {
        const storage = createStorageDouble();

        const write = await storeProjectSelection({ storage: storage.storage }, PROJECT_ID);

        expect(write).toEqual({ ok: true });
        expect(storage.operations).toEqual([`set:${PROJECT_STORAGE_KEY}`]);
        expect(storage.values.get(PROJECT_STORAGE_KEY)).toBe(PROJECT_ID);
    });

    it('refuses an invalid id without touching storage', async () => {
        const storage = createStorageDouble();

        const write = await storeProjectSelection({ storage: storage.storage }, '   ');

        expect(write.ok).toBe(false);
        expect(storage.operations).toEqual([]);
    });

    it('reports a refused write rather than pretending it landed', async () => {
        const write = await storeProjectSelection({ storage: refusingStorage() }, PROJECT_ID);

        expect(write.ok).toBe(false);
        if (!write.ok) {
            expect(write.problem).toContain('quota exceeded');
        }
    });
});

describe('restoreProjectSelection', () => {
    it('puts the stored selection on the runtime', async () => {
        const storage = createStorageDouble({ [PROJECT_STORAGE_KEY]: OTHER_ID });
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));

        await restoreProjectSelection(runtime);

        expect(runtime.state.projectSelection).toBe(OTHER_ID);
    });

    it('leaves the selection empty when nothing usable is stored', async () => {
        const runtime = createTestRuntime(fakeHost({ storage: createStorageDouble().storage }));

        await restoreProjectSelection(runtime);

        expect(runtime.state.projectSelection).toBeNull();
    });

    it('keeps the selection empty and explains a refused read', async () => {
        const runtime = createTestRuntime(fakeHost({ storage: failingStorage() }));

        await restoreProjectSelection(runtime);

        expect(runtime.state.projectSelection).toBeNull();
        expect(runtime.state.projects.note).toContain(STORAGE_FAILURE);
    });

    it('writes nothing to state after teardown', async () => {
        const storage = createStorageDouble({ [PROJECT_STORAGE_KEY]: OTHER_ID });
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));
        const pending = restoreProjectSelection(runtime);
        runtime.disposed = true;

        await pending;

        expect(runtime.state.projectSelection).toBeNull();
    });
});

describe('loadProjects', () => {
    it('renders a ready list on mount', async () => {
        const runtime = createTestRuntime(fakeHost({ listProjects: async () => TWO_PROJECTS }));

        await loadProjects(runtime);

        expect(runtime.state.projects.status).toBe('ready');
        expect(runtime.state.projects.projects).toHaveLength(2);
        expect(pickerOptions(runtime.state.projects)).toHaveLength(2);
    });

    it('records an empty ready list as an empty state, not a failure', async () => {
        const runtime = createTestRuntime(fakeHost({ listProjects: async () => ({ ...PROJECTS, projects: [] }) }));

        await loadProjects(runtime);

        expect(runtime.state.projects.status).toBe('ready');
        expect(pickerNote(runtime.state.projects)).toMatch(/No projects/);
        expect(pickerOptions(runtime.state.projects)).toEqual([]);
    });

    it('fails closed: a refused list leaves config, dispatch state, and the ledger alone', async () => {
        const runtime = createTestRuntime(
            fakeHost({
                listProjects: async () => {
                    throw new Error('host offline');
                },
            }),
        );
        const before = runtime.state.ledger.entries.length;

        await expect(loadProjects(runtime)).resolves.toBeUndefined();

        expect(runtime.state.projects.status).toBe('error');
        expect(runtime.state.projects.note).toContain('host offline');
        expect(runtime.state.config).toEqual(testConfig());
        expect(runtime.state.ledger.entries).toHaveLength(before);
        expect(runtime.state.evidence).toBeNull();
    });

    it('keeps an error snapshot from offering stale projects', async () => {
        const runtime = createTestRuntime(fakeHost({ listProjects: async () => ({ ...PROJECTS, state: 'error' }) }));

        await loadProjects(runtime);

        expect(runtime.state.projects.status).toBe('error');
        expect(pickerOptions(runtime.state.projects)).toEqual([]);
        expect(isSelectableProject(runtime.state.projects, PROJECT_ID)).toBe(false);
    });

    it('applies no snapshot after teardown', async () => {
        const runtime = createTestRuntime(fakeHost());
        const pending = loadProjects(runtime);
        runtime.disposed = true;

        await pending;

        expect(runtime.state.projects.status).toBe('loading');
        expect(runtime.state.projects.projects).toEqual([]);
    });
});

describe('copyProjectId', () => {
    it('copies the effective id to the host clipboard', async () => {
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
    });

    it('says so instead of copying nothing', async () => {
        const copied: string[] = [];
        const runtime = createPanelRuntime(
            fakeHost({
                writeClipboard: async (text) => {
                    copied.push(text);
                },
            }),
            fakeWindow().window,
        );

        await copyProjectId(runtime);

        expect(copied).toEqual([]);
        expect(runtime.state.projects.note).toMatch(/no project is selected/);
    });

    it('reports a refused copy without throwing', async () => {
        const runtime = createTestRuntime(
            fakeHost({
                writeClipboard: async () => {
                    throw new Error('clipboard denied');
                },
            }),
        );

        await expect(copyProjectId(runtime)).resolves.toBeUndefined();

        expect(runtime.state.projects.note).toContain('clipboard denied');
    });
});

describe('rejectProjectSelection', () => {
    it('changes nothing and explains a pick from outside the loaded list', () => {
        const runtime = createTestRuntime(fakeHost({ listProjects: async () => TWO_PROJECTS }));
        runtime.state.projects.status = 'ready';
        runtime.state.projects.projects = TWO_PROJECTS.projects;

        rejectProjectSelection(runtime, 'prj_invented');

        expect(runtime.state.projectSelection).toBeNull();
        expect(runtime.state.config?.projectId).toBe(PROJECT_ID);
        expect(runtime.state.projects.note).toContain('prj_invented');
        expect(runtime.state.projects.note).toMatch(/not in the loaded list/);
    });

    it('explains an unloaded list differently from a stale pick', () => {
        const runtime = createTestRuntime(fakeHost());

        rejectProjectSelection(runtime, PROJECT_ID);

        expect(runtime.state.projects.note).toMatch(/No project list is loaded/);
    });
});

describe('"Not listed?" guidance (FR-070, AC-121)', () => {
    it('names all three manual routes for registering a project', () => {
        const guidance = notListedGuidance();

        expect(guidance.startsWith(NOT_LISTED_LABEL)).toBe(true);
        expect(PROJECT_REGISTRATION_ROUTES).toHaveLength(3);
        expect(guidance).toContain('command palette');
        expect(guidance).toContain('Add project');
        expect(guidance).toContain('sidebar +');
        expect(guidance).toContain('folder browser');
    });

    it('states the never-creates rule and what stays recoverable meanwhile', () => {
        const guidance = notListedGuidance();

        expect(guidance).toMatch(/never creates/);
        expect(guidance).toContain('project_missing');
    });

    it('is painted by both pickers, so the routes need no navigation away', () => {
        const bindingPicker = readFileSync(resolve(ROOT, 'src/bindings-ui.ts'), 'utf8');
        const spikePicker = readFileSync(resolve(ROOT, 'src/panel-ui.ts'), 'utf8');

        expect(bindingPicker).toContain('notListedGuidance()');
        expect(spikePicker).toContain('notListedGuidance()');
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
    rt.state.bindings.accounts = [{ numericUserId: '77331', login: 'acme-bot', usable: true }];
    rt.state.bindings.accountSelection = '77331';

    return rt;
}

describe('binding picker selection guard (FR-070)', () => {
    it('refuses a selection the loaded list does not contain, keeping the draft recoverable', () => {
        const rt = loadedBindingDraft();

        selectBindingProject(rt, 'prj_not_registered');

        expect(rt.state.bindings.repoProjectSelection).toBeNull();
        expect(rt.state.bindings.note).toMatch(/not in the loaded list/);
        // No draft becomes a binding, so the service's own `project_missing`
        // path is untouched until a registered project is chosen.
        expect(readDraft(rt.state.bindings)).toBeNull();
        expect(rt.state.bindings.note).toMatch(/Pick the OpenChamber project/);
    });

    it('refuses before the list is loaded instead of trusting the value', () => {
        const rt = createTestRuntime(fakeHost());

        selectBindingProject(rt, PROJECT_ID);

        expect(rt.state.bindings.repoProjectSelection).toBeNull();
        expect(rt.state.bindings.note).toMatch(/No project list is loaded/);
        expect(readDraft(rt.state.bindings)).toBeNull();
    });

    it('adopts an id the loaded list contains, and only one it contains', () => {
        const rt = loadedBindingDraft();

        selectBindingProject(rt, PROJECT_ID);

        expect(rt.state.bindings.repoProjectSelection).toBe(PROJECT_ID);
        expect(rt.state.bindings.note).toBe('');
        expect(readDraft(rt.state.bindings)?.projectId).toBe(PROJECT_ID);
    });

    it('keeps the registered selection a later refusal did not replace', () => {
        const rt = loadedBindingDraft();
        selectBindingProject(rt, PROJECT_ID);

        selectBindingProject(rt, 'prj_not_registered');

        expect(rt.state.bindings.repoProjectSelection).toBe(PROJECT_ID);
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
    it('reads the real sources and built bundles rather than an empty directory', () => {
        const files = scanProjectCreationSurface();

        expect(files.length).toBeGreaterThan(50);
        expect(files.some((file) => file.path === 'panel/main.js')).toBe(true);
        expect(files.some((file) => file.path === 'service/main.js')).toBe(true);
    });

    it('finds no call and no endpoint that creates a project', () => {
        // The scan has to bite: a pattern that matches nothing would read as
        // green while proving nothing about the code above it.
        expect(PROJECT_CREATE_CALL.test('host.createProject()')).toBe(true);
        expect(PROJECT_ENDPOINT.test("path: '/repos/acme/widget/projects'")).toBe(true);

        for (const file of scanProjectCreationSurface()) {
            expect(file.text, `${file.path} must not call a project-creation method`).not.toMatch(
                PROJECT_CREATE_CALL,
            );
            expect(file.text, `${file.path} must not address a projects endpoint`).not.toMatch(PROJECT_ENDPOINT);
        }
    });

    it('exposes no project-writing member on the documented host surface', () => {
        const session = readFileSync(resolve(ROOT, 'src/session.ts'), 'utf8');
        // The Pick list itself, not every quoted word in the file's docs:
        // this is the surface a future module has to widen to reach a host
        // project-creation call, so it is the list that has to stay read-only.
        const pick = session.match(/export type SpikeHost = Pick<\s*HostClient,\s*([\s\S]*?)\s*>/);
        expect(pick).not.toBeNull();

        const members = [...(pick?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
        const projectMembers = members.filter((member) => member.includes('Project')).sort();

        expect(projectMembers).toEqual(['listProjects', 'onProjects']);
    });
});
