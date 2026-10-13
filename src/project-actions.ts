/**
 * Host-facing actions behind the project list: `host.listProjects()` seeds the form.
 * Nothing stores a pick (#39): the `mecha-turk:project` key is dead.
 */

import {
    applyProjectSnapshot,
    isSelectableProject,
    projectRefusalReason,
} from './project-picker.ts';
import { refresh } from './panel-ui.ts';
import type { PanelRuntime } from './panel-state.ts';
import { parseProjectId } from './config.ts';
import { redact } from './redaction.ts';
import { repaintStatusTab } from './status-tab.ts';
import { describeError } from './session.ts';

/**
 * Record the ready snapshot's project directory for this mount (002 FR-095).
 * `hostDirectory`'s only write; exported so mount-by-hand tests can drive it.
 */
export function recordHostDirectory(rt: PanelRuntime, directory: string | null): void {
    rt.state.hostDirectory = directory;
}

/**
 * Load the project list the binding form picks from.
 *
 * Never rejects: an unreachable host, a refused request, or an error snapshot
 * all land in the list's own status line with the panel otherwise untouched,
 * and dispatch stays blocked exactly as it was — fail closed, never fail open.
 */
export async function loadProjects(rt: PanelRuntime): Promise<void> {
    const { projects } = rt.state;
    projects.status = 'loading';
    projects.note = '';
    refresh(rt);

    try {
        const snapshot = await rt.host.listProjects();
        if (!rt.disposed) {
            applyProjectSnapshot(projects, snapshot);
        }
    } catch (cause) {
        if (!rt.disposed) {
            projects.status = 'error';
            projects.note = redact(`Project list unavailable: ${describeError(cause)}`);
        }
    }

    refresh(rt);
    // FR-038's Status guidance reads this list, and the Status tab repaints
    // only on its own reads — so a list that lands after the status document
    // refreshes that one line as well.
    repaintStatusTab(rt);
}

/**
 * Adopt the project the operator picked for a binding's draft, or refuse it:
 * the binding form is where FR-070's recoverable state lives — the draft only
 * ever holds an id the *currently loaded* list contains, so a stale option, a
 * scripted click, or a list that has not arrived yet can never become a
 * binding's dispatch target. A refusal changes nothing: the draft keeps
 * whatever registered project it already held, `readDraft` therefore keeps
 * refusing to submit, and the binding never leaves the recoverable
 * `project_missing` path for a project the host did not confirm.
 */
export function selectBindingProject(rt: PanelRuntime, id: string): void {
    const { bindings, projects } = rt.state;
    const candidate = parseProjectId(id);
    if (candidate === null || !isSelectableProject(projects, candidate)) {
        bindings.note = redact(projectRefusalReason(projects, id));
        refresh(rt);
        return;
    }

    bindings.repoProjectSelection = candidate;
    bindings.note = '';
    refresh(rt);
}
