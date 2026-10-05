/**
 * Pure helpers behind the panel's project picker.
 *
 * The operator has no Settings surface that prints OpenChamber project ids,
 * so the panel lists what `host.listProjects()` reports and remembers the
 * choice. Every function in this module is a function of picker state or
 * panel state alone — no host calls, no timers, no DOM — which is what makes
 * the loading, error, empty, and selection behaviours unit-testable without
 * an iframe.
 *
 * Project ids and directories are operator-visible configuration rather than
 * secrets; they still only ever reach the UI through these helpers, so no
 * host payload is ever rendered verbatim.
 */

import type { GuestProject, GuestProjectsSnapshot } from '@openchamber/sdk';
import type { SelectOption } from '@openchamber/sdk/ui';
import type { PanelState } from './panel-state.ts';

/** Lifecycle of the project picker's project list. */
export type ProjectPickerStatus =
    /** Nothing requested yet; the picker shows its idle text. */
    | 'idle'
    /** `host.listProjects()` is in flight. */
    | 'loading'
    /** The host answered with a usable snapshot. */
    | 'ready'
    /** The host refused, failed, or reported an error snapshot. */
    | 'error';

/** Project picker state carried by the panel runtime. */
export interface ProjectPickerState {
    /** Where the last `host.listProjects()` call got to. */
    status: ProjectPickerStatus;
    /** Projects the host reported; retained across a failed refresh. */
    projects: readonly GuestProject[];
    /** Operator-facing note about the picker, already redacted. */
    note: string;
}

/**
 * Create the empty picker state shown before the first `listProjects()` call.
 *
 * Lives with the picker rather than with the shared runtime state because it
 * *is* picker state: the lifecycle above, the retained list, and the note are
 * what `pickerNote`, `pickerPlaceholder`, and `applyProjectSnapshot` read.
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

/** Trigger text shown when the picker cannot offer a selection. */
const UNAVAILABLE_PLACEHOLDER = 'Projects unavailable';

/** Trigger text shown before any project list has been requested. */
const SELECT_PLACEHOLDER = 'Select a project';

/** Label of the picker's "not listed" affordance (002 FR-014, 003 FR-070). */
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
 * Describe one host project as a picker option.
 *
 * The label carries the name and the id, because the closed trigger only ever
 * renders the label: an operator must be able to read the id without opening
 * the list. The directory goes in the hint slot, where it is still visible in
 * the popup without crowding the trigger.
 *
 * @returns The option rendered by the SDK select.
 */
export function projectOption(project: GuestProject): SelectOption {
    return {
        id: project.id,
        label: `${project.name} · ${project.id}`,
        hint: project.directory,
    };
}

/**
 * Build the picker options for the current list.
 *
 * Only a `ready` snapshot produces options: a loading or failed list may
 * retain stale projects internally, and offering those would let the operator
 * pick a project the host did not just confirm.
 *
 * @returns The options to render, empty when no list is usable.
 */
export function pickerOptions(picker: ProjectPickerState): SelectOption[] {
    if (picker.status !== 'ready') {
        return [];
    }

    return picker.projects.map((project) => projectOption(project));
}

/**
 * Narrow the picker's options for the binding form's project select.
 *
 * Only a `ready` snapshot produces options — a loading or failed list would
 * offer projects the host may no longer hold. Unlike {@link pickerOptions}
 * these carry no directory hint, because the form's row already names the
 * repository and the id.
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
 * Derive the picker's status line.
 *
 * A dynamic note (a failure detail, a copy confirmation) wins over the text
 * derived from the status, so the last thing that happened stays visible.
 *
 * @returns The operator-facing line for the picker.
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
 * Derive the placeholder rendered inside the picker trigger.
 *
 * @returns Text shown when the current value has no option to match it.
 */
export function pickerPlaceholder(picker: ProjectPickerState): string {
    if (picker.status === 'loading') {
        return LOADING_NOTE;
    }

    if (picker.status === 'error') {
        return UNAVAILABLE_PLACEHOLDER;
    }

    if (picker.status === 'ready' && picker.projects.length === 0) {
        return EMPTY_NOTE;
    }

    return SELECT_PLACEHOLDER;
}

/**
 * Explain why a selection outside the loaded list was refused.
 *
 * One wording for both pickers (the dispatch target and the binding
 * form's dispatch project), so an operator who sees the line once recognises
 * it the second time. Nothing changes when a selection is refused: without a
 * confirmed id the dispatch — and the binding draft — stay exactly as they
 * were, which is what keeps a binding in its recoverable `project_missing`
 * state until a registered project is chosen.
 *
 * @returns The operator-facing refusal line.
 */
export function projectRefusalReason(picker: ProjectPickerState, id: string): string {
    return picker.status === 'ready' && picker.projects.length > 0
        ? `Project "${id}" is not in the loaded list; reload the projects and pick again.`
        : 'No project list is loaded; reload the projects and pick one.';
}

/**
 * The "Not listed?" guidance the pickers show.
 *
 * Rendered as ordinary text inside the panel, so the routes are reachable
 * without leaving the panel — the operator reads them at the moment they
 * discover the gap instead of being sent to a document. The copy states the
 * three registration routes, that the extension never creates a project, and
 * what stays recoverable in the meantime.
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
 * or hostile value can never become the dispatch target: dispatch additionally
 * re-resolves the id against `host.listProjects()` before it sends.
 *
 * @returns `true` when the id comes from the currently loaded list.
 */
export function isSelectableProject(picker: ProjectPickerState, id: string): boolean {
    return picker.status === 'ready' && picker.projects.some((project) => project.id === id);
}

/**
 * The project id the panel currently resolves.
 *
 * The picker's stored selection wins; otherwise the binding-derived dispatch
 * context supplies one. Since 002 FR-041 there is no third source.
 *
 * @returns The panel-picker selection, else the binding's id, else `null`.
 */
export function selectedProjectId(state: PanelState): string | null {
    return state.projectSelection ?? state.config?.projectId ?? null;
}

/**
 * Render the selected project id and where it came from.
 *
 * The id is shown verbatim so the operator can read it back into the
 * binding's project field; the source line makes the precedence visible
 * instead of surprising. Since 002 FR-041 emptied the integration card there
 * are exactly two answers: the operator's own picker selection, or the
 * binding that already carries a project.
 */
export function describeProjectSelection(state: PanelState): string {
    const selected = selectedProjectId(state);
    if (selected === null) {
        return 'No project selected — dispatch stays blocked until one is.';
    }

    const source = state.projectSelection === null ? 'binding' : 'panel picker';
    return `Selected project: ${selected} (from the ${source}).`;
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
