/**
 * Pure helpers behind the spike panel's project picker.
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
import type { PanelState, ProjectPickerState } from './panel-state.ts';

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

/**
 * Describe one host project as a picker option.
 *
 * The label carries the name and the id, because the closed trigger only ever
 * renders the label: an operator must be able to read the id without opening
 * the list. The directory goes in the hint slot, where it is still visible in
 * the popup without crowding the trigger.
 *
 * @param project - Project reported by `host.listProjects()`.
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
 * @param picker - Project picker state.
 * @returns The options to render, empty when no list is usable.
 */
export function pickerOptions(picker: ProjectPickerState): SelectOption[] {
    if (picker.status !== 'ready') {
        return [];
    }

    return picker.projects.map(projectOption);
}

/**
 * Derive the picker's status line.
 *
 * A dynamic note (a failure detail, a copy confirmation) wins over the text
 * derived from the status, so the last thing that happened stays visible.
 *
 * @param picker - Project picker state.
 * @returns The operator-facing line for the picker.
 */
export function pickerNote(picker: ProjectPickerState): string {
    if (picker.note !== '') {
        return picker.note;
    }

    switch (picker.status) {
        case 'loading':
            return LOADING_NOTE;
        case 'error':
            return ERROR_NOTE;
        case 'ready': {
            const count = picker.projects.length;
            return count === 0 ? EMPTY_NOTE : `${count} project${count === 1 ? '' : 's'} available.`;
        }
        case 'idle':
            return IDLE_NOTE;
    }
}

/**
 * Derive the placeholder rendered inside the picker trigger.
 *
 * @param picker - Project picker state.
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
 * Decide whether an id may be selected right now.
 *
 * Selection requires a `ready` list that actually contains the id, so a stale
 * or hostile value can never become the dispatch target: dispatch additionally
 * re-resolves the id against `host.listProjects()` before it sends.
 *
 * @param picker - Project picker state.
 * @param id - Candidate project id.
 * @returns `true` when the id comes from the currently loaded list.
 */
export function isSelectableProject(picker: ProjectPickerState, id: string): boolean {
    return picker.status === 'ready' && picker.projects.some((project) => project.id === id);
}

/**
 * The project id the panel currently resolves, from either source.
 *
 * @param state - Panel state.
 * @returns The panel-picker selection, else the configured id, else `null`.
 */
export function selectedProjectId(state: PanelState): string | null {
    return state.projectSelection ?? state.config?.projectId ?? null;
}

/**
 * Render the selected project id and where it came from.
 *
 * The id is shown verbatim so the operator can read it back into the
 * `project-id` integration setting if they configure the spike that way;
 * the source line makes the precedence rule visible instead of surprising.
 *
 * @param state - Panel state.
 * @returns One line describing the effective selection.
 */
export function describeProjectSelection(state: PanelState): string {
    const selected = selectedProjectId(state);
    if (selected === null) {
        return 'No project selected — dispatch stays blocked until one is.';
    }

    const source = state.projectSelection !== null ? 'panel picker' : 'integration setting';
    return `Selected project: ${selected} (from the ${source}).`;
}

/**
 * Fold a `host.listProjects()` snapshot into the picker state.
 *
 * Only `ready` establishes complete success: `loading` keeps whatever the list
 * held before, and `error` reports the failure while retaining the previous
 * projects so a transient blip does not erase the operator's context.
 *
 * @param picker - Picker state to update in place.
 * @param snapshot - Snapshot returned by the host.
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
