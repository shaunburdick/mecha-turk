/**
 * The Settings tab's actions: the read, the write, and the two draft
 * mutations (006 T-019, T-020; FR-015, FR-016, FR-040 – FR-049).
 *
 * Split from [`settings-tab.ts`](./settings-tab.ts) so the view keeps the
 * mount/repaint/dispose and this module keeps the effects: each action takes
 * the repaint it should trigger rather than importing it, which is what keeps
 * the two from importing each other. Every action is the same three steps —
 * decide (through the pure machine in `settings-edit.ts`), talk to the host
 * through the one wrapper set, then record what came back as fact:
 *
 * - **A read adopts the document and re-evaluates the markers** — a failure
 *   keeps the last document, marks it stale, and *blocks* any save (FR-019,
 *   FR-042), because a save with no current baseline sends a document the
 *   panel cannot stand behind.
 * - **A save is one activation, one whole-document write** (FR-046): the busy
 *   gate refuses a second activation instead of queueing it, the refusal path
 *   keeps the service's issues in the service's order (FR-024), and the
 *   success path adopts the configuration the **service returned** (FR-044).
 * - **Discard and restore-defaults touch the draft only** — no write, ever
 *   (FR-015, FR-049; the restore's two-step confirmation is T-022's).
 */

import { nowIso } from './ids.ts';
import { redact } from './redaction.ts';
import { CONFIG_PATH, serviceGet, servicePutConfig } from './service-calls.ts';
import { parseConfigEnvelope } from './settings-schema.ts';
import {
    beginSave,
    discard,
    editField,
    loadEdit,
    recordFailed,
    recordRefused,
    recordSaved,
    reconcilePending,
} from './settings-edit.ts';
import type { PanelRuntime } from './panel-state.ts';

/** What an action calls when its state has changed. */
export type Repaint = (rt: PanelRuntime) => void;

/**
 * Whether the runtime has been torn down while a request was in flight.
 *
 * A function call rather than a bare `rt.disposed` read: the analyzer narrows
 * that property across the first `await` and then reports a later direct
 * check as unreachable, while the frame really can go away between two awaits
 * (the same shape the Status tab's read has).
 *
 * @param rt - Panel runtime.
 * @returns `true` once the mount has been torn down.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/**
 * Retire the pending markers a landed read has caught up with (FR-038).
 *
 * This tab reads no status projection, so it has no effective value to compare
 * against: a marker survives the save that created it and is retired by this
 * read rather than by an optimistic claim — which is the whole of "not cleared
 * on save" (AC-105).
 *
 * @param rt - Panel runtime, whose edit state is updated in place.
 */
function retirePending(rt: PanelRuntime): void {
    const slice = rt.state.settingsTab;
    if (slice.doc === null) {
        return;
    }

    slice.edit = {
        ...slice.edit,
        pending: reconcilePending({
            pending: slice.edit.pending,
            configured: slice.doc.config,
            effective: {},
            reread: true,
        }),
    };
}

/**
 * Read `GET /v1/config` once and record what it answered (FR-014, FR-049).
 *
 * @param rt - Panel runtime.
 * @param repaint - What repaints the tab after the state moves.
 * @returns Resolves once the answer has been applied.
 */
export async function applyConfigRead(rt: PanelRuntime, repaint: Repaint): Promise<void> {
    const slice = rt.state.settingsTab;
    if (rt.disposed || slice.phase === 'loading') {
        return;
    }

    slice.phase = 'loading';
    repaint(rt);

    const answer = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: CONFIG_PATH });
    if (tornDown(rt)) {
        return;
    }

    const doc = answer.ok ? parseConfigEnvelope(answer.body) : null;
    if (doc === null) {
        slice.phase = 'failed';
        slice.problem = redact(
            answer.ok ? 'the service answered a configuration document the panel could not read' : answer.problem,
        );
        slice.stale = slice.doc !== null;
        slice.edit = loadEdit(slice.edit, null);
        repaint(rt);

        return;
    }

    slice.doc = doc;
    slice.phase = 'loaded';
    slice.problem = null;
    slice.stale = false;
    slice.at = nowIso();
    slice.edit = loadEdit(slice.edit, doc);
    retirePending(rt);
    rt.shell?.noteRead('settings', slice.at);
    repaint(rt);
}

/**
 * Apply one field edit to the draft (FR-012: this is not a write).
 *
 * @param input - The runtime, the repaint to trigger, and the field/text the
 *   operator entered.
 */
export function applyFieldEdit(input: {
    /** Panel runtime whose state moves. */
    readonly rt: PanelRuntime;
    /** What repaints the tab after the state moves. */
    readonly repaint: Repaint;
    /** The field the operator touched. */
    readonly field: string;
    /** The input's text, kept as text (FR-023). */
    readonly value: string;
}): void {
    const { rt, repaint, field, value } = input;
    const slice = rt.state.settingsTab;
    if (rt.disposed || slice.doc === null || slice.edit.saveState === 'saving') {
        return;
    }

    slice.edit = editField({ edit: slice.edit, envelope: slice.doc, field, value });
    repaint(rt);
}

/**
 * Save the draft: one activation, one whole-document write (FR-040, FR-046).
 *
 * @param rt - Panel runtime.
 * @param repaint - What repaints the tab after the state moves.
 * @returns Resolves once the answer has been applied.
 */
export async function applySave(rt: PanelRuntime, repaint: Repaint): Promise<void> {
    const slice = rt.state.settingsTab;
    if (rt.disposed) {
        return;
    }

    const attempt = beginSave(slice.edit, slice.doc);
    if (!attempt.ok) {
        // Nothing is sent: the reason the tab renders is the only effect
        // (AC-124 — no request at all, AC-126 — the second activation).
        repaint(rt);

        return;
    }

    const changed = [...slice.edit.dirty];
    slice.edit = { ...slice.edit, saveState: 'saving', issues: [], problem: null };
    repaint(rt);

    const answer = await servicePutConfig({
        serviceRequest: rt.host.serviceRequest,
        body: JSON.stringify(attempt.document),
    });
    if (tornDown(rt)) {
        return;
    }

    if (answer.ok) {
        const returned = parseConfigEnvelope(answer.body);
        slice.doc = returned;
        slice.edit = returned === null
            ? recordFailed(slice.edit, 'the service answered a document the panel could not read')
            : recordSaved({ edit: slice.edit, returned, changed });
        repaint(rt);

        return;
    }

    if (answer.code === 'validation') {
        const current = slice.doc;
        slice.edit = current === null
            ? recordFailed(slice.edit, 'the configuration could not be re-read after the refusal')
            : recordRefused({ edit: slice.edit, envelope: current, issues: answer.issues });
        repaint(rt);

        return;
    }

    // Not a refusal of these values: a store the service cannot write, a
    // missing grant, or a transport failure — each reaches the operator as
    // itself, never as "the service refused your values" (FR-061, FR-063).
    slice.edit = recordFailed(slice.edit, answer.problem);
    repaint(rt);
}

/**
 * Discard the unsaved edits, naming what reverted (FR-015, AC-122).
 *
 * @param rt - Panel runtime.
 * @param repaint - What repaints the tab after the state moves.
 */
export function applyDiscard(rt: PanelRuntime, repaint: Repaint): void {
    const slice = rt.state.settingsTab;
    if (rt.disposed || slice.doc === null || slice.edit.dirty.length === 0) {
        return;
    }

    slice.edit = discard(slice.edit, slice.doc);
    repaint(rt);
}

/**
 * Stage the service's declared defaults in the draft — a draft change, never a
 * write (FR-016, FR-049).
 *
 * The two-step confirmation and the one-activation write this control will
 * drive arrive with the destructive-confirmation task (006 T-022); until then
 * staging the defaults is the honest extent of what it can do, because a
 * restore that skipped FR-051's confirmation would be the exact affordance the
 * spec forbids.
 *
 * @param rt - Panel runtime.
 * @param repaint - What repaints the tab after the state moves.
 */
export function applyStageDefaults(rt: PanelRuntime, repaint: Repaint): void {
    const slice = rt.state.settingsTab;
    if (rt.disposed || slice.doc === null || slice.edit.saveState === 'saving') {
        return;
    }

    const baseline = slice.doc;
    for (const descriptor of baseline.fields) {
        const staged = String(descriptor.default);
        if (staged !== (slice.edit.draft[descriptor.name] ?? '')) {
            slice.edit = editField({
                edit: slice.edit,
                envelope: baseline,
                field: descriptor.name,
                value: staged,
            });
        }
    }

    repaint(rt);
}
