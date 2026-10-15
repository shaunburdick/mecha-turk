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
