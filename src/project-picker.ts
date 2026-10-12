/**
 * Pure helpers behind the panel's project list and the binding form's
 * project select.
 *
 * The operator has no Settings surface that prints OpenChamber project ids,
 * so the panel lists what `host.listProjects()` reports and the binding form
 * picks from that list. Every function in this module is a function of the
 * project-list state or panel state alone — no host calls, no timers, no DOM
 * — which is what makes the loading, error, empty, and default behaviours
 * unit-testable without an iframe.
 *
 * Project ids and directories are operator-visible configuration rather than
 * secrets; they still only ever reach the UI through these helpers, so no
 * host payload is ever rendered verbatim.
 */

import type { GuestProject, GuestProjectsSnapshot } from '@openchamber/sdk';
import type { SelectOption } from '@openchamber/sdk/ui';
import type { PanelState } from './panel-state.ts';

/** Lifecycle of the project-list load the form's select and status line read. */
export type ProjectPickerStatus =
    /** Nothing requested yet; the status line shows the idle text. */
    | 'idle'
    /** `host.listProjects()` is in flight. */
    | 'loading'
    /** The host answered with a usable snapshot. */
    | 'ready'
    /** The host refused, failed, or reported an error snapshot. */
    | 'error';

/** Project-list state carried by the panel runtime. */
export interface ProjectPickerState {
    /** Where the last `host.listProjects()` call got to. */
    status: ProjectPickerStatus;
    /** Projects the host reported; retained across a failed refresh. */
    projects: readonly GuestProject[];
    /** Operator-facing note about the list, already redacted. */
    note: string;
}

/**
 * Create the empty picker state shown before the first `listProjects()` call.
 *
 * Lives with the picker rather than with the shared runtime state because it
 * *is* picker state: the lifecycle above, the retained list, and the note are
 * what `pickerNote` and `applyProjectSnapshot` read.
 *
 * @returns The initial project picker state.
 */
export function initialProjectPicker(): ProjectPickerState {
    return { status: 'idle', projects: [], note: '' };
}

/** Note shown before the first `host.listProjects()` call. */
const IDLE_NOTE = 'Projects have not been loaded yet.';

/** Note shown while `host.listProjects()` is in flight. */
const LOADING_NOTE = 'Loading the project list from OpenChamber…';

/** Note shown when the host refused or failed the list request. */
const ERROR_NOTE = 'Project list unavailable; use Reload projects to retry.';

/** Note shown when the host reports a ready but empty project list. */
const EMPTY_NOTE = 'No projects are registered in OpenChamber yet.';

/** Label of the "not listed" affordance (002 FR-014, 003 FR-070). */
export const NOT_LISTED_LABEL = 'Not listed?';

/**
 * The manual ways OpenChamber registers a project, in the order the operator
 * meets them.
 *
 * The extension has no project-creation call anywhere, so
 * these three routes are the *only* way a project comes to exist — naming
 * them is the whole affordance.
 */
export const PROJECT_REGISTRATION_ROUTES: readonly string[] = [
    'command palette → Add project',
    'the sidebar + button',
    'the folder browser',
];

/**
 * Build the binding form's project options for the current list.
 *
 * Only a `ready` snapshot produces options — a loading or failed list would
 * offer projects the host may no longer hold. Every label carries the name
 * and the id, because the closed trigger only ever renders the label: an
 * operator must be able to read the id without opening the list.
 *
 * @returns The options, only when a ready list is loaded.
 */
export function formProjectOptions(picker: ProjectPickerState): SelectOption[] {
    if (picker.status !== 'ready') {
        return [];
    }

    return picker.projects.map((project) => ({
        id: project.id,
        label: `${project.name} · ${project.id}`,
    }));
}

/**
 * Derive the project list's status line.
 *
 * A dynamic note (the failure detail a refusal or a failed read left
 * behind) wins over the text derived from the status, so the last thing
 * that happened stays visible.
 *
 * @returns The operator-facing line for the list.
 */
export function pickerNote(picker: ProjectPickerState): string {
    if (picker.note !== '') {
        return picker.note;
    }

    switch (picker.status) {
        case 'loading': {
            return LOADING_NOTE;
        }

        case 'error': {
            return ERROR_NOTE;
        }

        case 'ready': {
            const count = picker.projects.length;
            return count === 0 ? EMPTY_NOTE : `${count} project${count === 1 ? '' : 's'} available.`;
        }

        case 'idle': {
            return IDLE_NOTE;
        }
    }
}

/**
 * Explain why a selection outside the loaded list was refused.
 *
 * Nothing changes when a selection is refused: without a confirmed id the
 * binding draft stays exactly as it was, which is what keeps a binding in
 * its recoverable `project_missing` state until a registered project is
 * chosen.
 *
 * @returns The operator-facing refusal line.
 */
export function projectRefusalReason(picker: ProjectPickerState, id: string): string {
    return picker.status === 'ready' && picker.projects.length > 0
        ? `Project "${id}" is not in the loaded list; reload the projects and pick again.`
        : 'No project list is loaded; reload the projects and pick one.';
}

/**
 * The "Not listed?" guidance the binding form shows (002 FR-014).
 *
 * Rendered as ordinary text under the form's project select, so the routes
 * are reachable without leaving the panel — the operator reads them at the
 * moment they discover the gap instead of being sent to a document. The copy
 * states the three registration routes, that the extension never creates a
 * project, and what stays recoverable in the meantime.
 *
 * @returns The guidance line, ending with the never-creates rule.
 */
export function notListedGuidance(): string {
    const routes = PROJECT_REGISTRATION_ROUTES.join(', ');

    return (
        `${NOT_LISTED_LABEL} OpenChamber registers projects, not this extension: ` +
        `${routes} — then reload the projects and pick it here. ` +
        'Until a registered project is chosen the binding stays in its recoverable ' +
        '`project_missing` state; the extension never creates one.'
    );
}

/**
 * Decide whether an id may be selected right now.
 *
 * Selection requires a `ready` list that actually contains the id, so a stale
 * or hostile value can never become the binding draft's dispatch target:
 * dispatch additionally re-resolves the id against `host.listProjects()`
 * before it sends.
 *
 * @returns `true` when the id comes from the currently loaded list.
 */
export function isSelectableProject(picker: ProjectPickerState, id: string): boolean {
    return picker.status === 'ready' && picker.projects.some((project) => project.id === id);
}

/**
 * The project id the binding form's add-mode draft preselects (002 FR-095,
 * FR-097(b)): the current-project default alone — never the binding-context
 * term, which is dispatch context rather than a choice.
 *
 * Fail-closed (FR-096(b)): `null` whenever the default does not resolve, so
 * a draft opens empty rather than guessing.
 */
export function currentProjectDefault(state: PanelState): string | null {
    const directory = state.hostDirectory;
    if (directory === null || state.projects.status !== 'ready') {
        return null;
    }

    const matches = state.projects.projects.filter((project) => project.directory === directory);
    if (matches.length !== 1) {
        return null;
    }

    return matches[0]?.id ?? null;
}

/**
 * Fold a `host.listProjects()` snapshot into the picker state.
 *
 * Only `ready` establishes complete success: `loading` keeps whatever the list
 * held before, and `error` reports the failure while retaining the previous
 * projects so a transient blip does not erase the operator's context.
 */
export function applyProjectSnapshot(picker: ProjectPickerState, snapshot: GuestProjectsSnapshot): void {
    if (snapshot.state === 'error') {
        picker.status = 'error';
        picker.note = '';
        return;
    }

    if (snapshot.state === 'loading') {
        picker.status = 'loading';
        picker.note = '';
        return;
    }

    picker.status = 'ready';
    picker.projects = snapshot.projects;
    picker.note = '';
}
