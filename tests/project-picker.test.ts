import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GuestProjectsSnapshot } from '@openchamber/sdk';
import { createPanelRuntime } from '../src/panel-state.ts';
import type { PanelRuntime, PanelState, ProjectPickerState } from '../src/panel-state.ts';
import {
    NOT_LISTED_LABEL,
    PROJECT_REGISTRATION_ROUTES,
    applyProjectSnapshot,
    currentProjectDefault,
    formProjectOptions,
    isSelectableProject,
    notListedGuidance,
    pickerNote,
} from '../src/project-picker.ts';
import { loadProjects, selectBindingProject } from '../src/project-actions.ts';
import { readDraft } from '../src/bindings.ts';
import { byText } from './support/sort.ts';
import {
    PROJECTS,
    PROJECT_ID,
    createTestRuntime,
    fakeHost,
    fakeWindow,
    testConfig,
} from './support/panel.ts';

/** A second project used to prove list rendering and selection precedence. */
const OTHER_ID = 'prj_7';

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
        expect(formProjectOptions(picker()), 'idle').toEqual([]);
        expect(formProjectOptions(picker({ status: 'loading' })), 'loading').toEqual([]);
        expect(formProjectOptions(picker({ status: 'error', projects: PROJECTS.projects })), 'error').toEqual([]);
        expect(formProjectOptions(picker({ status: 'ready' })), 'ready but empty').toEqual([]);

        const options = formProjectOptions(picker({ status: 'ready', projects: TWO_PROJECTS.projects }));
        expect(options.map((rendered) => rendered.id)).toEqual([PROJECT_ID, OTHER_ID]);
        expect(options.map((rendered) => rendered.label)).toEqual([
            `widget · ${PROJECT_ID}`,
            `gadget · ${OTHER_ID}`,
        ]);
    });
});

describe('project list status line', () => {
    it('derives the line from the status, and prefers a dynamic note', () => {
        expect(pickerNote(picker())).toMatch(/not been loaded/);
        expect(pickerNote(picker({ status: 'loading' }))).toMatch(/Loading/);
        expect(pickerNote(picker({ status: 'error' }))).toMatch(/unavailable/);
        expect(pickerNote(picker({ status: 'ready' }))).toMatch(/No projects/);
        expect(pickerNote(picker({ status: 'ready', projects: TWO_PROJECTS.projects }))).toBe('2 projects available.');

        const note = 'Project list unavailable: host offline';
        expect(pickerNote(picker({ status: 'ready', note })), 'a dynamic note').toBe(note);
    });
});

describe('selection guards', () => {
    it('accepts only loaded ids', () => {
        const loaded = picker({ status: 'ready', projects: TWO_PROJECTS.projects });

        expect(isSelectableProject(loaded, OTHER_ID)).toBe(true);
        expect(isSelectableProject(loaded, 'prj_invented')).toBe(false);
        expect(isSelectableProject(picker({ status: 'error', projects: TWO_PROJECTS.projects }), OTHER_ID))
            .toBe(false);
        expect(isSelectableProject(picker(), OTHER_ID)).toBe(false);
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

        const loading = picker({ status: 'ready', note: 'a refusal', projects: PROJECTS.projects });
        applyProjectSnapshot(loading, { ...PROJECTS, state: 'loading' });
        expect(loading.status).toBe('loading');
        expect(loading.projects).toEqual(PROJECTS.projects);
    });
});

describe('loadProjects', () => {
    it('renders ready and empty lists, fails closed on a refused list, and lands nothing after teardown', async () => {
        const ready = createTestRuntime(fakeHost({ listProjects: async () => TWO_PROJECTS }));
        await loadProjects(ready);
        expect(ready.state.projects.status).toBe('ready');
        expect(ready.state.projects.projects).toHaveLength(2);
        expect(formProjectOptions(ready.state.projects)).toHaveLength(2);

        const none = createTestRuntime(fakeHost({ listProjects: async () => ({ ...PROJECTS, projects: [] }) }));
        await loadProjects(none);
        expect(none.state.projects.status, 'an empty ready list').toBe('ready');
        expect(pickerNote(none.state.projects)).toMatch(/No projects/);
        expect(formProjectOptions(none.state.projects)).toEqual([]);

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
        expect(formProjectOptions(errored.state.projects), 'an error snapshot offers nothing').toEqual([]);
        expect(isSelectableProject(errored.state.projects, PROJECT_ID)).toBe(false);

        const late = createTestRuntime(fakeHost());
        const pending = loadProjects(late);
        late.disposed = true;
        await pending;
        expect(late.state.projects.status, 'nothing lands after teardown').toBe('loading');
        expect(late.state.projects.projects).toEqual([]);
    });
});

describe('"Not listed?" guidance (FR-070, AC-121)', () => {
    it('names all three routes, states the never-creates rule, and paints from the add form once', () => {
        const guidance = notListedGuidance();

        expect(guidance.startsWith(NOT_LISTED_LABEL)).toBe(true);
        expect(PROJECT_REGISTRATION_ROUTES).toHaveLength(3);
        expect(guidance).toMatch(/never creates/);
        expect(guidance).toContain('project_missing');

        // The form's mount is the guidance's only home: issue #39 removed
        // the panel-level picker's second copy, so the line an operator
        // reads exists exactly once.
        const bindingBody = readFileSync(resolve(ROOT, 'src/bindings-body.ts'), 'utf8');
        const panelUiSource = readFileSync(resolve(ROOT, 'src/panel-ui.ts'), 'utf8');

        expect(bindingBody).toContain('notListedGuidance()');
        expect(panelUiSource).not.toContain('notListedGuidance');
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
 * The trailing `(` is what keeps ordinary identifiers that merely contain
 * the noun out of the scan, and prose is out of reach too, because the
 * pattern admits no space between the verb and the noun ("Add project", the
 * route the guidance names, is a different string entirely).
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
 * The panel's whole button-mounting surface, closed (AC-047: "no … second
 * button … exists anywhere in the panel").
 *
 * A census over *every* `mountButton` would be red on arrival — the panel
 * mounts 31 buttons across nine modules — so the surface is stated as this
 * enumerated record: which files mount a button, and how many times each
 * does today. A button added anywhere, in any module, is then a reported
 * change to a closed set rather than a judgement call, which is the same
 * discipline `PanelHost`'s Pick list applies to the host surface.
 */
const BUTTON_MOUNT_SITES: Readonly<Record<string, number>> = {
    'src/about-tab.ts': 2,
    'src/accounts-detail.ts': 3,
    'src/accounts-tab.ts': 1,
    'src/bindings-body.ts': 2,
    'src/bindings-editor.ts': 5,
    'src/dispatches-controls.ts': 5,
    'src/dispatches-ui.ts': 7,
    'src/settings-mount.ts': 5,
    'src/status-tab.ts': 1,
};

/** Buttons beside the form's project select — exactly one (AC-047). */
const FORM_PROJECT_BUTTONS: readonly string[] = ['Reload projects'];

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
 * `mountBindingsBody(input: { … })` opens a brace *before* the body does —
 * balancing from the first `{` would return the parameter type. A return
 * type spelled as an inline object literal would break the same way, which
 * is why the mounts this serves declare an interface instead.
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

describe('the panel-level picker is gone and no second button took its place (AC-047)', () => {
    it('enumerates the panel button-mount surface as a closed record', () => {
        const sources = scanProjectCreationSurface().filter((file) => file.path.startsWith('src/'));

        expect(buttonMountSites(sources)).toEqual(BUTTON_MOUNT_SITES);
        const total = Object.values(BUTTON_MOUNT_SITES).reduce((sum, count) => sum + count, 0);
        expect(total).toBe(31);

        // Bite-check, on the same counting function: a planted second button
        // beside the form's project controls is reported, so a green census
        // above is a fact about the tree rather than about a pattern that
        // cannot fail.
        const bindingsBody = sources.find((file) => file.path === 'src/bindings-body.ts');
        expect(bindingsBody, 'the bindings body exists').toBeDefined();
        const selectBody = functionBody(bindingsBody?.text ?? '', 'mountProjectSelect');
        expect(occurrences(selectBody, /mountButton\(/gu)).toBe(1);
        const planted = `${selectBody}\nmountButton(row, { label: 'Pin project', variant: 'outline' });\n`;
        expect(occurrences(planted, /mountButton\(/gu), 'a planted second button is counted').toBe(2);

        const plantedSites = buttonMountSites([
            ...(bindingsBody === undefined ? [] : [{ path: bindingsBody.path, text: planted }]),
        ]);
        expect(plantedSites['src/bindings-body.ts'], 'the census reports it, not the closed record').toBe(2);
    });

    it('mounts exactly one button beside the form select, and no panel-level picker', () => {
        const sources = scanProjectCreationSurface().filter((file) => file.path.startsWith('src/'));
        const panelUi = sources.find((file) => file.path === 'src/panel-ui.ts');
        const bindingsBody = sources.find((file) => file.path === 'src/bindings-body.ts');
        expect(panelUi, 'the panel-rendering module exists').toBeDefined();
        expect(bindingsBody, 'the bindings body exists').toBeDefined();

        // Issue #39 removed the panel-level picker: no *OpenChamber project*
        // select and no *Copy project id* button is mounted anywhere.
        expect(panelUi?.text ?? '').not.toContain('mountSelect(');
        expect(panelUi?.text ?? '').not.toContain("'Copy project id'");

        const selectBody = functionBody(bindingsBody?.text ?? '', 'mountProjectSelect');
        expect(buttonLabels(selectBody).toSorted(byText)).toEqual(FORM_PROJECT_BUTTONS);
        expect(selectBody).toContain('mountSelect(');
        expect(selectBody).toContain("label: 'Dispatch project'");

        // Every button the panel mounts, anywhere, carries a readable label
        // and none of them is a pin-style control (G3-2's one-line
        // broadening of this census).
        const labels = sources.flatMap((file) => buttonLabels(file.text));
        expect(labels).toHaveLength(31);
        expect(labels.filter((label) => /\bpin\b/iu.test(label))).toEqual([]);
    });
});

/* ------------------------------------------------------------------ *
 * 002 v1.14.0 / v1.15.0: the default's own resolution (E-5).
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
} = {}): PanelState {
    const { state } = createPanelRuntime(fakeHost(), fakeWindow().window);
    state.hostDirectory = input.hostDirectory ?? null;
    if (input.snapshot !== undefined) {
        applyProjectSnapshot(state.projects, input.snapshot);
    }

    return state;
}

describe('the current-project default resolves one ordered rule (FR-095, FR-097)', () => {
    it('resolves the default when the directory matches exactly, and never from the binding term', () => {
        // The only term left (issue #39 removed the stored pick): the
        // directory recorded at load against a ready list.
        const derived = resolutionState({
            hostDirectory: DEFAULT_DIRECTORY,
            snapshot: RESOLUTION_SNAPSHOT,
        });
        expect(currentProjectDefault(derived)).toBe(DEFAULT_ID);

        // The binding-context term is dispatch context, not a choice: with
        // no directory recorded the form's field preselects nothing
        // (FR-097(b)) — the draft opens empty exactly as it always did.
        const bindingOnly = resolutionState({ snapshot: RESOLUTION_SNAPSHOT });
        expect(currentProjectDefault(bindingOnly), 'no directory, no default').toBeNull();
    });

    it('derives nothing in every state FR-096(b) refuses', () => {
        const cases: readonly (readonly [string, PanelState])[] = [
            ['a null directory', resolutionState({ snapshot: RESOLUTION_SNAPSHOT })],
            [
                'a directory no project matches',
                resolutionState({ hostDirectory: '/elsewhere', snapshot: RESOLUTION_SNAPSHOT }),
            ],
            [
                'two projects sharing one directory',
                resolutionState({ hostDirectory: DEFAULT_DIRECTORY, snapshot: COLLIDING_SNAPSHOT }),
            ],
            [
                'a list still loading',
                resolutionState({
                    hostDirectory: DEFAULT_DIRECTORY,
                    snapshot: { ...RESOLUTION_SNAPSHOT, state: 'loading' },
                }),
            ],
            [
                'an error snapshot',
                resolutionState({
                    hostDirectory: DEFAULT_DIRECTORY,
                    snapshot: { ...RESOLUTION_SNAPSHOT, state: 'error' },
                }),
            ],
            ['a list that was never loaded', resolutionState({ hostDirectory: DEFAULT_DIRECTORY })],
        ];

        for (const [label, state] of cases) {
            expect(currentProjectDefault(state), label).toBeNull();
        }

        // The positive control: the exact pair under the same directory
        // resolves, so the refusals above are refusing a match rather than
        // passing because nothing ever resolves.
        const exact = resolutionState({
            hostDirectory: DEFAULT_DIRECTORY,
            snapshot: RESOLUTION_SNAPSHOT,
        });
        expect(currentProjectDefault(exact)).toBe(DEFAULT_ID);
    });
});
