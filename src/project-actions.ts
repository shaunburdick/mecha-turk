/**
 * Host-facing actions behind the panel's project picker.
 *
 * Two documented calls do the work: `host.listProjects()` (covered by the
 * declared `sessions` capability) renders the choices, and `host.storage`
 * remembers the one the operator picked.
 *
 * The selection lives in storage because integration settings are read-only
 * from the panel: SDK 1.24.2 exposes `host.onSettings()` as a host→guest push
 * with no setter, so the panel cannot write the `project-id` field. Storage is
 * extension-namespaced, needs no extra capability, and lets configuration
 * resolution prefer the panel's selection over that setting.
 *
 * Nothing here writes to the ledger and nothing here throws: a failed list or
 * a refused write is reported on the picker's own status line, so the poll,
 * the dispatch, and the audit trail are untouched. Every rendered string
 * passes through `redact()` first.
 */

import type { JsonValue } from '@openchamber/sdk';
import { parseProjectId } from './config.ts';
import {
    applyProjectSnapshot,
    isSelectableProject,
    projectRefusalReason,
    selectedProjectId,
} from './project-picker.ts';
import { refresh } from './panel-ui.ts';
import type { PanelRuntime } from './panel-state.ts';
import { redact } from './redaction.ts';
import { repaintStatusTab } from './status-tab.ts';
import { describeError } from './session.ts';
import type { PanelHost } from './session.ts';

/**
 * Storage key holding the panel's project selection.
 *
 * Namespaced like the ledger and evidence keys; the value is a plain project
 * id, which is operator-visible configuration rather than a secret.
 */
export const PROJECT_STORAGE_KEY = 'mecha-turk:project';

/** Outcome of reading the stored project selection. */
export type StoredSelectionRead =
    /** The key was read; `projectId` is `null` when nothing is stored. */
    | { readonly ok: true; readonly projectId: string | null }
    /** The host refused the read; the panel keeps the in-memory selection and reports why. */
    | { readonly ok: false; readonly problem: string };

/** Outcome of writing the project selection to extension storage. */
export type StoredSelectionWrite =
    /** The selection is durable. */
    | { readonly ok: true }
    /** The write failed; the selection still holds for this mount. */
    | { readonly ok: false; readonly problem: string };

/**
 * Read the panel's stored project selection.
 *
 * Anything the host cannot confirm — a refusal, a non-string value, an id
 * that fails {@link parseProjectId} — reads as "no selection", which keeps
 * configuration resolution honest instead of trusting an unreadable value.
 * The card's `project-id` setting is gone (002 FR-041), so a null here is
 * genuinely "no project chosen" and the panel says so rather than falling
 * back to a setting that no longer exists.
 *
 * @returns The stored id, `null` when none is stored, or the read problem.
 */
export async function readStoredSelection(host: Pick<PanelHost, 'storage'>): Promise<StoredSelectionRead> {
    try {
        const stored: JsonValue | undefined = await host.storage.get(PROJECT_STORAGE_KEY);
        if (typeof stored !== 'string') {
            return { ok: true, projectId: null };
        }

        return { ok: true, projectId: parseProjectId(stored) };
    } catch (cause) {
        return { ok: false, problem: describeError(cause) };
    }
}

/**
 * Write the panel's project selection to extension storage.
 *
 * @returns `{ ok: true }` when the value is durable, otherwise the problem.
 */
export async function storeProjectSelection(
    host: Pick<PanelHost, 'storage'>,
    projectId: string,
): Promise<StoredSelectionWrite> {
    const valid = parseProjectId(projectId);
    if (valid === null) {
        return { ok: false, problem: 'projectId is not a valid project id' };
    }

    try {
        await host.storage.set(PROJECT_STORAGE_KEY, valid);
        return { ok: true };
    } catch (cause) {
        return { ok: false, problem: describeError(cause) };
    }
}

/**
 * Restore the stored selection onto the runtime before settings are parsed.
 *
 * Called once per mount, ahead of the first `applySettings`, so a panel that
 * was closed and reopened still dispatches to the project the operator picked.
 *
 */
export async function restoreProjectSelection(rt: PanelRuntime): Promise<void> {
    const read = await readStoredSelection(rt.host);
    if (rt.disposed) {
        return;
    }

    if (!read.ok) {
        rt.state.projects.note = redact(`Stored project selection unreadable: ${read.problem}`);
        return;
    }

    rt.state.projectSelection = read.projectId;
    if (read.projectId !== null) {
        rt.state.projects.note = `Restored project selection ${read.projectId}.`;
    }
}

/**
 * Load the project list for the picker.
 *
 * Never rejects: an unreachable host, a refused request, or an error snapshot
 * all land in the picker's own status line with the panel otherwise untouched,
 * and dispatch stays blocked exactly as it was — fail closed, never fail open.
 *
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
 * Copy the effective project id to the host clipboard.
 *
 * The panel has no settings write API, so this is how an operator takes the
 * id over to a binding's project field when they would rather paste it.
 *
 */
export async function copyProjectId(rt: PanelRuntime): Promise<void> {
    const selected = selectedProjectId(rt.state);
    if (selected === null) {
        rt.state.projects.note = 'Nothing to copy: no project is selected.';
        refresh(rt);
        return;
    }

    try {
        await rt.host.writeClipboard(selected);
        if (!rt.disposed) {
            rt.state.projects.note = `Copied ${selected} to the clipboard.`;
        }
    } catch (cause) {
        if (!rt.disposed) {
            rt.state.projects.note = redact(`Copy failed: ${describeError(cause)}`);
        }
    }

    refresh(rt);
}

/**
 * Report a refused selection on the picker line.
 *
 * The picker only ever offers ids from the loaded list, so a refusal here
 * means the value arrived from somewhere else (a stale option, a scripted
 * click) or no list is loaded at all. Nothing changes: without a confirmed id
 * the dispatch stays blocked.
 *
 * @param id - Project id the caller asked to select.
 */
export function rejectProjectSelection(rt: PanelRuntime, id: string): void {
    rt.state.projects.note = redact(projectRefusalReason(rt.state.projects, id));
    refresh(rt);
}

/**
 * Adopt the project the operator picked for a binding's draft, or refuse it.
 *
 * The binding form is where FR-070's recoverable state lives: the draft only
 * ever holds an id the *currently loaded* list contains, so a stale option, a
 * scripted click, or a list that has not arrived yet can never become a
 * binding's dispatch target. A refusal changes nothing — the draft keeps
 * whatever registered project it already held (usually none), `readDraft`
 * therefore keeps refusing to submit, and the binding never leaves the
 * recoverable `project_missing` path for a project the host did not confirm.
 *
 * @param id - Project id the select reported.
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
