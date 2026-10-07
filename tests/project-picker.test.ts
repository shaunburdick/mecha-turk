import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GuestProjectsSnapshot } from '@openchamber/sdk';
import { createPanelRuntime } from '../src/panel-state.ts';
import type { PanelRuntime, PanelState, ProjectPickerState } from '../src/panel-state.ts';
import type { BindingContext } from '../src/config.ts';
import {
    NOT_LISTED_LABEL,
    PROJECT_REGISTRATION_ROUTES,
    applyProjectSnapshot,
    currentProjectDefault,
    describeProjectSelection,
    displayedProjectId,
    isSelectableProject,
    notListedGuidance,
    pickerNote,
    pickerOptions,
    pickerPlaceholder,
    projectOption,
    projectSelectionSource,
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

/** How often a pattern occurs in one source string. */
function occurrences(source: string, pattern: RegExp): number {
    return [...source.matchAll(pattern)].length;
}

/**
 * A *write* of the panel's pick key, in call form.
 *
 * The `host.storage.set(` prefix is what makes this the key's write path
 * rather than any mention of the constant: a reader (`storage.get`) or a
 * prose reference is not a write, and AC-047's closing clause closes the
 * write path specifically.
 */
const PROJECT_KEY_WRITE = /host\.storage\.set\(\s*PROJECT_STORAGE_KEY/gu;

/**
 * The panel's whole button-mounting surface, closed (AC-047: "no … second
 * button … exists anywhere in the panel").
 *
 * A census over *every* `mountButton` would be red on arrival — the panel
 * mounts 32 buttons across ten modules and only two of them are this
 * feature's subject — so the surface is stated as this enumerated record:
 * which files mount a button, and how many times each does today. A button
 * added anywhere, in any module, is then a reported change to a closed set
 * rather than a judgement call, which is the same discipline `PanelHost`'s
 * Pick list applies to the host surface.
 */
const BUTTON_MOUNT_SITES: Readonly<Record<string, number>> = {
    'src/about-tab.ts': 2,
    'src/accounts-detail.ts': 3,
    'src/accounts-tab.ts': 1,
    'src/bindings-body.ts': 1,
    'src/bindings-editor.ts': 5,
    'src/dispatches-controls.ts': 5,
    'src/dispatches-ui.ts': 7,
    'src/panel-ui.ts': 2,
    'src/settings-mount.ts': 5,
    'src/status-tab.ts': 1,
};

/** Buttons the picker group mounts, in label order — exactly two (AC-047). */
const PICKER_GROUP_BUTTONS: readonly string[] = ['Copy project id', 'Reload projects'].toSorted(byText);

/**
 * Count `mountButton(` call sites per file.
 *
 * One primitive shared by the real census and its bite-check, so the check
 * proves the very function that judged the tree.
 *
 * @returns The count for every file that mounts at least one button.
 */
function buttonMountSites(files: readonly ScannedFile[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const file of files) {
        const count = occurrences(file.text, /mountButton\(/gu);
        if (count > 0) {
            counts[file.path] = count;
        }
    }

    return counts;
}

/** Quote characters a balance-walker must skip over rather than count. */
const QUOTES = new Set(["'", '"', '`']);

/**
 * Index just past the string literal that starts at `start`.
 *
 * @returns The index after the closing quote (or the end of the source).
 */
function skipString(source: string, start: number, quote: string): number {
    let index = start + 1;
    while (index < source.length) {
        const character = source[index] ?? '';
        if (character === '\\') {
            index += 2;
        } else if (character === quote) {
            return index + 1;
        } else {
            index += 1;
        }
    }

    return index;
}

/**
 * Index just past the line comment that starts at `start`.
 *
 * @returns The index of the newline (or the end of the source).
 */
function skipLine(source: string, start: number): number {
    const lineEnd = source.indexOf('\n', start);

    return lineEnd === -1 ? source.length : lineEnd + 1;
}

/**
 * Walk a balanced open/close pair from its opening index.
 *
 * String literals and line comments are skipped, so a parenthesis or brace
 * inside one cannot unbalance the walk.
 *
 * @param open - Index of the opening character.
 * @returns The index just past the matching closing character.
 * @throws {Error} When the pair never closes.
 */
function walkBalanced(source: string, open: number, opener: string, closer: string): number {
    let depth = 0;
    let index = open;
    while (index < source.length) {
        const character = source[index] ?? '';
        if (character === '/' && source[index + 1] === '/') {
            index = skipLine(source, index);
            continue;
        }

        if (QUOTES.has(character)) {
            index = skipString(source, index, character);
            continue;
        }

        if (character === opener) {
            depth += 1;
            index += 1;
            continue;
        }

        if (character === closer) {
            depth -= 1;
            if (depth === 0) {
                return index + 1;
            }
        }

        index += 1;
    }

    throw new Error(`the ${opener}${closer} pair opened at ${open} never closed`);
}

/**
 * Extract one function's brace-balanced body from a source string.
 *
 * The parameter list is walked first, because a signature such as
 * `mountProjectPicker(input: { … })` opens a brace *before* the body does —
 * balancing from the first `{` would return the parameter type.
 *
 * @returns The body text, braces included.
 * @throws {Error} When the function is not declared or has no body.
 */
function functionBody(source: string, name: string): string {
    const declaration = source.indexOf(`function ${name}(`);
    if (declaration === -1) {
        throw new Error(`no function ${name} declared here`);
    }

    const signature = walkBalanced(source, source.indexOf('(', declaration), '(', ')');
    const open = source.indexOf('{', signature);
    if (open === -1) {
        throw new Error(`function ${name} has no body`);
    }

    return source.slice(open, walkBalanced(source, open, '{', '}'));
}

/**
 * Read one `mountButton` call's label from its argument text.
 *
 * Only string literals are resolved; a `SOME_LABEL` constant reads as its own
 * identifier, which is enough for the claim this serves — that no button
 * anywhere carries a pin-style label.
 *
 * @returns The label, or `(unlabelled)` when the call names none.
 */
function labelOf(args: string): string {
    const literal = /label:\s*'([^']*)'/u.exec(args);
    if (literal?.[1] !== undefined) {
        return literal[1];
    }

    return /label:\s*([A-Za-z_$][\w$]*)/u.exec(args)?.[1] ?? '(unlabelled)';
}

/**
 * Read the `label:` each `mountButton` call in a source was given.
 *
 * @returns The labels, in call order.
 */
function buttonLabels(source: string): readonly string[] {
    const labels: string[] = [];
    for (const match of source.matchAll(/mountButton\s*\(/gu)) {
        const open = match.index + match[0].length - 1;
        const args = source.slice(open + 1, walkBalanced(source, open, '(', ')') - 1);
        labels.push(labelOf(args));
    }

    return labels;
}

describe('the pick key has exactly one write path (FR-096(a), AC-047)', () => {
    it('counts one host.storage.set(PROJECT_STORAGE_KEY) in src, reached only from the explicit pick', () => {
        const sources = scanProjectCreationSurface().filter((file) => file.path.startsWith('src/'));
        const writeSites = sources.filter((file) => occurrences(file.text, PROJECT_KEY_WRITE) > 0);

        expect(writeSites.map((file) => file.path)).toEqual(['src/project-actions.ts']);
        for (const file of writeSites) {
            expect(occurrences(file.text, PROJECT_KEY_WRITE), `${file.path} must hold the only write`).toBe(1);
        }

        // The one write is `storeProjectSelection`, and the picker's explicit
        // pick in `app.ts` is its only caller: a second caller would be a
        // second way to reach the key even if the `set` stayed singular.
        const storeCallers = sources.filter(
            (file) => occurrences(file.text, /(?<!function )\bstoreProjectSelection\s*\(/gu) > 0,
        );
        expect(storeCallers.map((file) => file.path)).toEqual(['src/app.ts']);
        const appSource = storeCallers[0]?.text ?? '';
        expect(occurrences(appSource, /(?<!function )\bstoreProjectSelection\s*\(/gu)).toBe(1);
        const selectProject = functionBody(appSource, 'selectProject');
        expect(selectProject).toContain('storeProjectSelection(');

        // Bite-check: the same census has to report a planted second write.
        const projectActions = sources.find((file) => file.path === 'src/project-actions.ts');
        expect(projectActions, 'the write site still exists').toBeDefined();
        const planted = `${projectActions?.text ?? ''}\nhost.storage.set(PROJECT_STORAGE_KEY, planted);\n`;
        expect(occurrences(planted, PROJECT_KEY_WRITE), 'a planted second write is reported').toBe(2);
    });
});

describe('no third button, no Pin, and no second write path anywhere in the panel (AC-047)', () => {
    it('enumerates the panel button-mount surface as a closed record', () => {
        const sources = scanProjectCreationSurface().filter((file) => file.path.startsWith('src/'));

        expect(buttonMountSites(sources)).toEqual(BUTTON_MOUNT_SITES);
        const total = Object.values(BUTTON_MOUNT_SITES).reduce((sum, count) => sum + count, 0);
        expect(total).toBe(32);

        // Bite-check, on the same counting function: a planted third button
        // inside the picker group is reported, so a green census above is a
        // fact about the tree rather than about a pattern that cannot fail.
        const panelUi = sources.find((file) => file.path === 'src/panel-ui.ts');
        expect(panelUi, 'the picker module exists').toBeDefined();
        const pickerBody = functionBody(panelUi?.text ?? '', 'mountProjectPicker');
        expect(occurrences(pickerBody, /mountButton\(/gu)).toBe(2);
        const planted = `${pickerBody}\nmountButton(row, { label: 'Pin project', variant: 'outline' });\n`;
        expect(occurrences(planted, /mountButton\(/gu), 'a planted third button is counted').toBe(3);

        const plantedSites = buttonMountSites([
            ...(panelUi === undefined ? [] : [{ path: panelUi.path, text: planted }]),
        ]);
        expect(plantedSites['src/panel-ui.ts'], 'the census reports it, not the closed record').toBe(3);
    });

    it('mounts exactly two labelled buttons in the picker group, and no button beside the form select', () => {
        const sources = scanProjectCreationSurface().filter((file) => file.path.startsWith('src/'));
        const panelUi = sources.find((file) => file.path === 'src/panel-ui.ts');
        const bindingsBody = sources.find((file) => file.path === 'src/bindings-body.ts');
        expect(panelUi, 'the picker module exists').toBeDefined();
        expect(bindingsBody, 'the bindings body exists').toBeDefined();

        const pickerBody = functionBody(panelUi?.text ?? '', 'mountProjectPicker');
        expect(buttonLabels(pickerBody).toSorted(byText)).toEqual(PICKER_GROUP_BUTTONS);

        // The form's Dispatch project select is the other surface a Pin
        // could be bolted onto; it mounts a select and no button at all.
        const selectBody = functionBody(bindingsBody?.text ?? '', 'mountProjectSelect');
        expect(occurrences(selectBody, /mountButton\(/gu)).toBe(0);
        expect(selectBody).toContain('mountSelect(');
        expect(selectBody).toContain("label: 'Dispatch project'");

        // Every button the panel mounts, anywhere, carries a readable label
        // and none of them is a pin-style control (G3-2's one-line
        // broadening of this census).
        const labels = sources.flatMap((file) => buttonLabels(file.text));
        expect(labels).toHaveLength(32);
        expect(labels.filter((label) => /\bpin\b/iu.test(label))).toEqual([]);
    });
});

/* ------------------------------------------------------------------ *
 * 002 v1.14.0: resolution, display, and the four strings (E-5).
 * ------------------------------------------------------------------ */

/** Project the current-project default resolves to in these cases. */
const DEFAULT_ID = 'prj_current';

/** Directory only {@link DEFAULT_ID} sits on — the host's current directory. */
const DEFAULT_DIRECTORY = '/home/agent/acme/current';

/** Ready list holding the default's project beside a second, unrelated one. */
const RESOLUTION_SNAPSHOT: GuestProjectsSnapshot = {
    kind: 'projects',
    state: 'ready',
    projects: [
        { id: DEFAULT_ID, name: 'current', directory: DEFAULT_DIRECTORY },
        { id: OTHER_ID, name: 'gadget', directory: '/home/agent/acme/gadget' },
    ],
};

/** Ready list whose two projects share one directory — ambiguous. */
const COLLIDING_SNAPSHOT: GuestProjectsSnapshot = {
    kind: 'projects',
    state: 'ready',
    projects: [
        { id: 'prj_left', name: 'left', directory: DEFAULT_DIRECTORY },
        { id: 'prj_right', name: 'right', directory: DEFAULT_DIRECTORY },
    ],
};

/**
 * Panel state arranged for one resolution case (002 FR-095).
 *
 * Everything starts at its initial value and only the named facts are set,
 * so a case cannot inherit an answer from a fixture it never mentioned.
 *
 * @returns The state under test.
 */
function resolutionState(input: {
    /** The directory recorded at load; absent means none was. */
    readonly hostDirectory?: string | null;
    /** The project list, as `loadProjects` would fold it in. */
    readonly snapshot?: GuestProjectsSnapshot;
    /** The stored manual pick; absent means none is stored. */
    readonly projectSelection?: string | null;
    /** The binding context; absent means no enabled binding supplies one. */
    readonly config?: BindingContext | null;
} = {}): PanelState {
    const { state } = createPanelRuntime(fakeHost(), fakeWindow().window);
    state.hostDirectory = input.hostDirectory ?? null;
    if (input.snapshot !== undefined) {
        applyProjectSnapshot(state.projects, input.snapshot);
    }

    state.projectSelection = input.projectSelection ?? null;
    state.config = input.config ?? null;

    return state;
}

describe('the current-project default resolves one ordered rule (FR-095, FR-097)', () => {
    it('resolves stored, derived, binding, none in order — and displays only the first two', () => {
        const config = testConfig();

        // (1) the stored pick, never displaced by a default, on this load
        // and every later one (AC-044's A case).
        const stored = resolutionState({
            hostDirectory: DEFAULT_DIRECTORY,
            snapshot: RESOLUTION_SNAPSHOT,
            projectSelection: PROJECT_ID,
            config,
        });
        expect(selectedProjectId(stored)).toBe(PROJECT_ID);
        expect(displayedProjectId(stored)).toBe(PROJECT_ID);
        expect(projectSelectionSource(stored)).toBe('picker');

        // (2) the derived default while nothing is stored.
        const derived = resolutionState({
            hostDirectory: DEFAULT_DIRECTORY,
            snapshot: RESOLUTION_SNAPSHOT,
            config,
        });
        expect(selectedProjectId(derived)).toBe(DEFAULT_ID);
        expect(displayedProjectId(derived)).toBe(DEFAULT_ID);
        expect(projectSelectionSource(derived)).toBe('default');

        // (3) the binding context when no default resolves: the detail line
        // reports it, and no control ever displays it (FR-097(a)/(b)).
        const bindingOnly = resolutionState({ snapshot: RESOLUTION_SNAPSHOT, config });
        expect(selectedProjectId(bindingOnly)).toBe(PROJECT_ID);
        expect(displayedProjectId(bindingOnly), 'a control never displays the binding term').toBeNull();
        expect(projectSelectionSource(bindingOnly)).toBe('binding');

        // (4) nothing resolves.
        const none = resolutionState({ snapshot: RESOLUTION_SNAPSHOT });
        expect(selectedProjectId(none)).toBeNull();
        expect(displayedProjectId(none)).toBeNull();
        expect(projectSelectionSource(none)).toBe('none');
    });

    it('derives nothing in every state FR-096(b) refuses, falling through byte-identically', () => {
        const config = testConfig();
        const cases: readonly (readonly [string, PanelState])[] = [
            ['a null directory', resolutionState({ snapshot: RESOLUTION_SNAPSHOT, config })],
            [
                'a directory no project matches',
                resolutionState({ hostDirectory: '/elsewhere', snapshot: RESOLUTION_SNAPSHOT, config }),
            ],
            [
                'two projects sharing one directory',
                resolutionState({ hostDirectory: DEFAULT_DIRECTORY, snapshot: COLLIDING_SNAPSHOT, config }),
            ],
            [
                'a list still loading',
                resolutionState({
                    hostDirectory: DEFAULT_DIRECTORY,
                    snapshot: { ...RESOLUTION_SNAPSHOT, state: 'loading' },
                    config,
                }),
            ],
            [
                'an error snapshot',
                resolutionState({
                    hostDirectory: DEFAULT_DIRECTORY,
                    snapshot: { ...RESOLUTION_SNAPSHOT, state: 'error' },
                    config,
                }),
            ],
            ['a list that was never loaded', resolutionState({ hostDirectory: DEFAULT_DIRECTORY, config })],
        ];

        for (const [label, state] of cases) {
            expect(currentProjectDefault(state), label).toBeNull();
            // The pre-amendment rule, byte for byte: resolution falls to the
            // binding term, the controls stay empty, and the line keeps the
            // string it has always rendered.
            expect(selectedProjectId(state), label).toBe(PROJECT_ID);
            expect(displayedProjectId(state), label).toBeNull();
            expect(describeProjectSelection(state), label).toBe(
                `Selected project: ${PROJECT_ID} (from the binding).`,
            );
        }

        const unconfigured = resolutionState({
            hostDirectory: DEFAULT_DIRECTORY,
            snapshot: COLLIDING_SNAPSHOT,
        });
        expect(describeProjectSelection(unconfigured)).toBe(
            'No project selected — dispatch stays blocked until one is.',
        );
    });

    it("renders exactly FR-098's four strings, chosen by the producing term", () => {
        const config = testConfig();

        expect(
            describeProjectSelection(
                resolutionState({
                    hostDirectory: DEFAULT_DIRECTORY,
                    snapshot: RESOLUTION_SNAPSHOT,
                    projectSelection: PROJECT_ID,
                    config,
                }),
            ),
        ).toBe(`Selected project: ${PROJECT_ID} (from the panel picker).`);

        expect(
            describeProjectSelection(
                resolutionState({ hostDirectory: DEFAULT_DIRECTORY, snapshot: RESOLUTION_SNAPSHOT, config }),
            ),
        ).toBe(`Selected project: ${DEFAULT_ID} (current project — not saved as a pick).`);

        expect(
            describeProjectSelection(resolutionState({ snapshot: RESOLUTION_SNAPSHOT, config })),
        ).toBe(`Selected project: ${PROJECT_ID} (from the binding).`);

        expect(describeProjectSelection(resolutionState({ snapshot: RESOLUTION_SNAPSHOT }))).toBe(
            'No project selected — dispatch stays blocked until one is.',
        );

        // The combined state — no stored pick, a derived default, and a
        // binding context all in force — asserted by exact equality, because
        // the branch this replaced rendered the binding string here and
        // credited the binding with an id it does not hold (ledger Q2b,
        // AC-047).
        const combined = resolutionState({
            hostDirectory: DEFAULT_DIRECTORY,
            snapshot: RESOLUTION_SNAPSHOT,
            config,
        });
        const line = describeProjectSelection(combined);
        expect(line).toBe(`Selected project: ${DEFAULT_ID} (current project — not saved as a pick).`);
        expect(line).not.toContain('(from the binding).');
        expect(line).not.toContain('panel picker');
    });
});
