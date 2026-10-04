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
 * - **A destructive save arms before it writes** (FR-051, T-022): lowering a
 *   retention knob, and restoring defaults, raise the confirmation built by
 *   `settings-confirm.ts` on the first activation and perform exactly one
 *   write on the second — the first activation issues **no** request at all.
 * - **Discard and cancel touch the draft only** — no write, ever (FR-015,
 *   FR-049, FR-054).
 */

import { nowIso } from './ids.ts';
import { redact } from './redaction.ts';
import { CONFIG_PATH, serviceGet, servicePutConfig } from './service-calls.ts';
import type { ServiceConfigPutResult } from './service-calls.ts';
import { parseConfigEnvelope, parseConfigWriteAnswer } from './settings-schema.ts';
import { restoreConfirmation, saveConfirmation } from './settings-confirm.ts';
import { writeFailure } from './settings-state.ts';
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

/** What an answer the panel cannot read as a document is reported as. */
const UNREADABLE_ANSWER = 'the service answered a document the panel could not read';

/** What a refusal whose baseline is gone is reported as. */
const UNREADABLE_REREAD = 'the configuration could not be re-read after the refusal';

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
 * Retire the pending markers a landed read has caught up with.
 *
 * This tab reads no status projection, so it has no effective value to compare
 * against: a marker survives the save that created it and is retired by this
 * read rather than by an optimistic claim — which is the whole of "not cleared
 * on save".
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
 * Read `GET /v1/config` once and record what it answered.
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
 * Record an accepted write: the document the service returned, and the audit
 * outcome it reported with it.
 *
 * @param input - The runtime, the repaint, the answer body, and the fields
 *   the write changed.
 */
function recordAcceptedWrite(input: {
    /** Panel runtime whose state moves. */
    readonly rt: PanelRuntime;
    /** What repaints the tab after the state moves. */
    readonly repaint: Repaint;
    /** The answer body. */
    readonly body: string;
    /** The fields the write changed, as the tab knew them going in. */
    readonly changed: readonly string[];
}): void {
    const { rt, repaint, body, changed } = input;
    const slice = rt.state.settingsTab;
    const parsed = slice.doc === null ? null : parseConfigWriteAnswer({ body, previous: slice.doc });
    if (parsed === null) {
        slice.edit = recordFailed(slice.edit, writeFailure({
            code: null,
            problem: UNREADABLE_ANSWER,
            correlationId: null,
        }));
        repaint(rt);

        return;
    }

    slice.doc = parsed.returned;
    slice.edit = recordSaved({
        edit: slice.edit,
        returned: parsed.returned,
        changed,
        auditWritten: parsed.auditWritten,
    });
    repaint(rt);
}

/**
 * Apply one write's answer to the state: the document it returned, the
 * refusal it issued, or the cause it failed with (FR-044, FR-061 – FR-064).
 *
 * Split out of {@link performWrite} so each answer path stays small enough to
 * read on its own — the three are genuinely different kinds of fact, and
 * conflating the last two is exactly how a `503` comes to look like a refusal
 * of the operator's values.
 *
 * @param input - The runtime, the repaint, the answer, and the changed fields.
 */
function applyWriteAnswer(input: {
    /** Panel runtime whose state moves. */
    readonly rt: PanelRuntime;
    /** What repaints the tab after the state moves. */
    readonly repaint: Repaint;
    /** The answer the wrapper produced. */
    readonly answer: ServiceConfigPutResult;
    /** The fields the write changed, as the tab knew them going in. */
    readonly changed: readonly string[];
}): void {
    const { rt, repaint, answer, changed } = input;
    const slice = rt.state.settingsTab;

    if (answer.ok) {
        recordAcceptedWrite({ rt, repaint, body: answer.body, changed });

        return;
    }

    if (answer.code === 'validation') {
        const current = slice.doc;
        slice.edit = current === null
            ? recordFailed(slice.edit, writeFailure({
                code: null,
                problem: UNREADABLE_REREAD,
                correlationId: null,
            }))
            : recordRefused({ edit: slice.edit, envelope: current, issues: answer.issues });
        repaint(rt);

        return;
    }

    // Not a refusal of these values: a store the service cannot write, a
    // missing grant, a transport failure, or something it did not document —
    // each reaches the operator as its own cause, never as "the service
    // refused your values".
    slice.edit = recordFailed(slice.edit, writeFailure({
        code: answer.code,
        problem: redact(answer.problem),
        correlationId: answer.correlationId,
    }));
    repaint(rt);
}

/**
 * Send the one write a save activation authorises: one `PUT`, the whole
 * document, issued only after every gate has passed.
 *
 * Extracted from {@link applySave} so the two arming actions — a save that
 * lowered a retention knob, and a confirmed restore — perform **exactly** the
 * same write from the same place, rather than each growing a copy of it.
 *
 * @param rt - Panel runtime.
 * @param repaint - What repaints the tab after the state moves.
 * @returns Resolves once the answer has been applied.
 */
async function performWrite(rt: PanelRuntime, repaint: Repaint): Promise<void> {
    const slice = rt.state.settingsTab;
    const attempt = beginSave(slice.edit, slice.doc);
    if (!attempt.ok) {
        // Nothing is sent: the reason the tab renders is the only effect
        // (AC-124 — no request at all, AC-126 — the second activation).
        repaint(rt);

        return;
    }

    const changed = [...slice.edit.dirty];
    slice.edit = {
        ...slice.edit,
        saveState: 'saving',
        issues: [],
        problem: null,
        confirm: null,
        failure: null,
        auditWritten: null,
    };
    repaint(rt);

    const answer = await servicePutConfig({
        serviceRequest: rt.host.serviceRequest,
        body: JSON.stringify(attempt.document),
    });
    if (tornDown(rt)) {
        return;
    }

    applyWriteAnswer({ rt, repaint, answer, changed });
}

/**
 * Save the draft: one activation, one whole-document write — unless the write
 * would delete history, in which case the first activation arms the
 * confirmation and sends nothing.
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

    const armed = slice.edit.confirm;
    if (armed !== null) {
        // A restore is armed: only its own control confirms it, so Save
        // neither arms nor writes while that confirmation stands — a
        // confirmation the wrong button could complete would not be one
        // (FR-051's two steps are two activations of *the* control).
        if (armed.action !== 'save') {
            repaint(rt);

            return;
        }
    } else if (slice.doc !== null && slice.edit.blocked === null) {
        const confirmation = saveConfirmation({ envelope: slice.doc, draft: slice.edit.draft });
        if (confirmation !== null) {
            slice.edit = { ...slice.edit, confirm: confirmation };
            repaint(rt);

            return;
        }
    }

    await performWrite(rt, repaint);
}

/**
 * Discard the unsaved edits, naming what reverted.
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
 * Restore the declared defaults — two steps, no write without the
 * confirmation.
 *
 * The first activation stages the service's own defaults into the draft and
 * arms a confirmation that names **every** field the write will change, with
 * its current → default value; the second one writes the whole document.
 * Nothing is written by staging alone, so an operator who changes their mind
 * at the armed step cancels back to the last-read values.
 *
 * @param rt - Panel runtime.
 * @param repaint - What repaints the tab after the state moves.
 * @returns Resolves once a confirmed write has been applied.
 */
export async function applyStageDefaults(rt: PanelRuntime, repaint: Repaint): Promise<void> {
    const slice = rt.state.settingsTab;
    if (rt.disposed || slice.doc === null || slice.edit.saveState === 'saving' || slice.edit.blocked !== null) {
        return;
    }

    const baseline = slice.doc;
    if (slice.edit.confirm?.action !== 'restore') {
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

        slice.edit = { ...slice.edit, confirm: restoreConfirmation({ envelope: baseline, draft: slice.edit.draft }) };
        repaint(rt);

        return;
    }

    await performWrite(rt, repaint);
}

/**
 * Disarm the confirmation: nothing is written, and every field returns to the
 * last-read value.
 *
 * @param rt - Panel runtime.
 * @param repaint - What repaints the tab after the state moves.
 */
export function applyConfirmCancel(rt: PanelRuntime, repaint: Repaint): void {
    const slice = rt.state.settingsTab;
    if (rt.disposed || slice.doc === null || slice.edit.confirm === null || slice.edit.saveState === 'saving') {
        return;
    }

    // Discard *is* the retreat: it restores the baseline draft, reports what
    // reverted, and clears the arm — one rule rather than two that could
    // drift apart about where the fields end up.
    slice.edit = discard(slice.edit, slice.doc);
    repaint(rt);
}
