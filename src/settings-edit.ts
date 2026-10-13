/**
 * The Settings draft/save state machine — pure by design: no host, no DOM, no
 * clock, so every rule the edit surface obeys is a testable function call.
 * The draft is *last-read document ∪ projection defaults ∪ edits*; no
 * baseline means no save; one save is one call, refused by the busy gate
 * rather than queued, and nothing flips optimistically — `saved` only ever
 * arrives from the configuration the service returned. Pending markers
 * describe the boundary, not the save: retired only by a later *read*, never
 * by the save that created them. Text stays text until the document is
 * built, so a value out of range reaches the service and is refused there —
 * the panel applies no gate of its own.
 */

import type { ConfigIssueView } from './service-envelope.ts';
import type { SettingsConfirmation } from './settings-confirm.ts';
import type { ConfigEnvelope, ConfigValue, FieldDescriptor, TakeEffectClass } from './settings-schema.ts';

export type SaveState = 'idle' | 'editing' | 'saving' | 'saved' | 'refused' | 'failed';

/**
 * The four causes a configuration write can fail with. The panel never guesses
 * which one it met: each member names a documented answer (`503
 * storage-unavailable`, `401`, a transport failure, and anything the service
 * did not document), so the copy each one gets is the copy that cause owes
 * rather than one generic sentence for all four.
 */
export type SettingsFailureCause = 'store' | 'unauthorised' | 'transport' | 'unexpected';

export interface SettingsFailure {
    readonly cause: SettingsFailureCause;
    readonly problem: string;
    readonly correlationId: string | null;
}

export interface PendingField {
    readonly field: string;
    readonly boundary: TakeEffectClass;
}

export interface SettingsEdit {
    readonly draft: Readonly<Record<string, string>>;
    readonly dirty: readonly string[];
    readonly saveState: SaveState;
    readonly blocked: string | null;
    readonly issues: readonly ConfigIssueView[];
    readonly problem: string | null;
    readonly pending: readonly PendingField[];
    readonly reverted: readonly string[];
    /**
     * The confirmation this write is armed behind, or `null`.
     * Set only by the arming actions; every path that moves the
     * baseline — a landed read, an edit, a discard, any answer — clears it,
     * because an arm describes **one** document and that document just moved.
     */
    readonly confirm: SettingsConfirmation | null;
    /**
     * The failed write's cause, its problem, and its correlation id, or `null`
     * when the last write did not fail. `problem` stays on
     * its own because that is the string the failure line has always named.
     */
    readonly failure: SettingsFailure | null;
    /**
     * The audit outcome of the last **accepted** write: `false` is the service
     * saying the configuration changed but its `config.changed` row did not
     * reach the trail; `null` means no accepted write has answered since the
     * last read — *not* a claim either way, because the panel never implies
     * traceability it does not have.
     */
    readonly auditWritten: boolean | null;
}

export const NO_BASELINE_REASON =
    'no configuration has been read yet, so there is no document to send';

export const UNDISPLAYED_REASON =
    'the document carries a field this version does not show; sending it would drop that field';

export const READ_FAILED_REASON =
    'the latest read did not land, so there is no current document to send';

export const BUSY_REASON = 'a save is already in flight';

/**
 * Build the empty edit state, before the first read.
 */
export function emptyEdit(): SettingsEdit {
    return {
        draft: {},
        dirty: [],
        saveState: 'idle',
        blocked: NO_BASELINE_REASON,
        issues: [],
        problem: null,
        failure: null,
        pending: [],
        reverted: [],
        confirm: null,
        auditWritten: null,
    };
}

/**
 * The baseline value of one field: the document's, else the descriptor's
 * default for a key the document lacked.
 *
 * @returns The baseline text, or `null` when neither carries it.
 */
function baselineOf(envelope: ConfigEnvelope, name: string): string | null {
    const value = envelope.config[name];
    if (value !== undefined) {
        return String(value);
    }

    const descriptor = envelope.fields.find((candidate) => candidate.name === name);

    return descriptor === undefined ? null : String(descriptor.default);
}

/**
 * Build the initial draft from a read: every descriptor's baseline value.
 */
function draftOf(envelope: ConfigEnvelope): Record<string, string> {
    const draft: Record<string, string> = {};
    for (const descriptor of envelope.fields) {
        const baseline = baselineOf(envelope, descriptor.name);
        if (baseline !== null) {
            draft[descriptor.name] = baseline;
        }
    }

    return draft;
}

/**
 * The fields whose draft differs from the last-read document.
 *
 * @returns The dirty field names, in descriptor order.
 */
export function dirtyFields(
    draft: Readonly<Record<string, string>>,
    envelope: ConfigEnvelope | null,
): readonly string[] {
    if (envelope === null) {
        return [];
    }

    return envelope.fields
        .map((descriptor) => descriptor.name)
        .filter((name) => (draft[name] ?? '') !== (baselineOf(envelope, name) ?? ''));
}

/**
 * Why no save is offered right now, or `null` when one is.
 */
export function blockedReason(envelope: ConfigEnvelope | null): string | null {
    if (envelope === null) {
        return NO_BASELINE_REASON;
    }

    return envelope.undisplayed.length > 0 ? UNDISPLAYED_REASON : null;
}

/**
 * Adopt a read: it becomes the baseline, so nothing is dirty any more.
 *
 * @returns The state after the read; a failed read keeps the previous draft
 *   and its dirty set, only re-evaluating the reason no save is offered.
 */
export function loadEdit(edit: SettingsEdit, envelope: ConfigEnvelope | null): SettingsEdit {
    if (envelope === null) {
        return {
            ...edit,
            blocked: READ_FAILED_REASON,
            issues: [],
            saveState: edit.saveState === 'saving' ? 'saving' : 'idle',
            confirm: null,
            // A read retires both answers: the failure was about a write this
            // baseline has now superseded, and the audit outcome belongs to a
            // document the panel is no longer showing.
            failure: null,
            auditWritten: null,
        };
    }

    const draft = draftOf(envelope);

    return {
        ...edit,
        draft,
        dirty: [],
        saveState: 'idle',
        blocked: blockedReason(envelope),
        issues: [],
        problem: null,
        failure: null,
        reverted: [],
        confirm: null,
        auditWritten: null,
    };
}

/**
 * Apply one field edit — the only writes are whole-document ones, so
 * this changes the draft and nothing else.
 */
export function editField(input: {
    readonly edit: SettingsEdit;
    readonly envelope: ConfigEnvelope;
    readonly field: string;
    readonly value: string;
}): SettingsEdit {
    const { edit, envelope, field, value } = input;
    const draft = { ...edit.draft, [field]: value };
    const dirty = dirtyFields(draft, envelope);

    return {
        ...edit,
        draft,
        dirty,
        saveState: dirty.length === 0 ? 'idle' : 'editing',
        issues: [],
        problem: null,
        failure: null,
        reverted: [],
        // An arm describes the document as it stood when it was raised; an
        // edit moves that document, so the confirmation it authorised is
        // retired rather than re-pointed at a write nobody read.
        confirm: null,
    };
}

/**
 * Discard the unsaved edits: the draft goes back to the baseline and the tab
 * says what reverted.
 *
 * @returns The state after the discard.
 */
export function discard(edit: SettingsEdit, envelope: ConfigEnvelope): SettingsEdit {
    const reverted = edit.dirty;

    return {
        ...edit,
        draft: draftOf(envelope),
        dirty: [],
        saveState: 'idle',
        issues: [],
        problem: null,
        failure: null,
        reverted,
        // Discard and cancel are the same retreat: the fields go back to the
        // last-read values, so the arm they were armed for goes with them.
        confirm: null,
    };
}

export type SaveAttempt =
    | { readonly ok: true; readonly document: Readonly<Record<string, ConfigValue>> }
    | { readonly ok: false; readonly reason: string };

/**
 * Translate one draft value onto the wire, without guessing at its type.
 *
 * @returns The number when the text is an integer, otherwise the text itself.
 */
function valueFor(descriptor: FieldDescriptor, text: string): ConfigValue {
    if (descriptor.kind !== 'integer') {
        return text;
    }

    return /^-?[0-9]+$/.test(text.trim()) ? Number(text.trim()) : text;
}

/**
 * The whole document a save sends: the baseline with the draft applied. An
 * input's text becomes an integer **only** when it parses as one — an
 * out-of-range number or a stray word is sent as it stands, so the service
 * refuses it in its own words rather than the panel quietly reshaping it.
 */
function documentFor(
    envelope: ConfigEnvelope,
    draft: Readonly<Record<string, string>>,
): Readonly<Record<string, ConfigValue>> {
    const document: Record<string, ConfigValue> = {};
    for (const descriptor of envelope.fields) {
        document[descriptor.name] = valueFor(descriptor, draft[descriptor.name] ?? '');
    }

    return document;
}

/**
 * Try to begin a save: the busy gate, then the baseline gate.
 */
export function beginSave(edit: SettingsEdit, envelope: ConfigEnvelope | null): SaveAttempt {
    if (edit.saveState === 'saving') {
        return { ok: false, reason: BUSY_REASON };
    }

    const blocked = blockedReason(envelope);
    if (blocked !== null || envelope === null) {
        return { ok: false, reason: blocked ?? NO_BASELINE_REASON };
    }

    return { ok: true, document: documentFor(envelope, edit.draft) };
}

/**
 * Record an accepted write, from the configuration the **service** returned,
 * and mark what it changed as pending.
 */
export function recordSaved(input: {
    readonly edit: SettingsEdit;
    readonly returned: ConfigEnvelope;
    readonly changed: readonly string[];
    readonly auditWritten: boolean | null;
}): SettingsEdit {
    const { edit, returned, changed, auditWritten } = input;
    const draft = draftOf(returned);
    const pending = [...edit.pending];
    for (const name of changed) {
        const descriptor = returned.fields.find((candidate) => candidate.name === name);
        if (descriptor === undefined || descriptor.takesEffect === 'immediate') {
            continue;
        }

        if (pending.every((entry) => entry.field !== name)) {
            pending.push({ field: name, boundary: descriptor.takesEffect });
        }
    }

    return {
        ...edit,
        draft,
        dirty: [],
        saveState: 'saved',
        blocked: blockedReason(returned),
        issues: [],
        problem: null,
        failure: null,
        pending,
        reverted: [],
        confirm: null,
        auditWritten,
    };
}

/**
 * Record a refusal with the service's own issues, in the service's order, and
 * put every field back to the last configuration the service reported: after
 * a refusal the form shows what is in force, not what was typed, so no
 * optimistic local value survives the answer.
 */
export function recordRefused(input: {
    readonly edit: SettingsEdit;
    readonly envelope: ConfigEnvelope;
    readonly issues: readonly ConfigIssueView[];
}): SettingsEdit {
    const { edit, envelope, issues } = input;

    return {
        ...edit,
        draft: draftOf(envelope),
        dirty: [],
        saveState: 'refused',
        issues,
        problem: null,
        failure: null,
        reverted: [],
        confirm: null,
        auditWritten: null,
    };
}

/**
 * Record a write that could not be completed. The failure carries its
 * **cause** as well as the service's own words, so the tab can say which of
 * the four documented reasons it met instead of one generic sentence — and it
 * keeps the envelope's correlation identifier when one came, the only
 * identifier an unexpected failure can be traced by.
 */
export function recordFailed(edit: SettingsEdit, failure: SettingsFailure): SettingsEdit {
    return {
        ...edit,
        saveState: 'failed',
        issues: [],
        problem: failure.problem,
        failure,
        confirm: null,
        auditWritten: null,
    };
}

/**
 * Retire the pending markers a read has caught up with. The marker is cleared
 * **only** by a read: an entry whose field the status projection carries
 * disappears once the two halves agree, and an entry for a field the
 * projection cannot speak about is retired by a later configuration read —
 * because the panel has no way to observe that boundary, and claiming one
 * would be exactly the optimism the pending marker forbids.
 */
export function reconcilePending(input: {
    readonly pending: readonly PendingField[];
    readonly configured: Readonly<Record<string, ConfigValue>>;
    readonly effective: Readonly<Record<string, ConfigValue>>;
    readonly reread: boolean;
}): readonly PendingField[] {
    return input.pending.filter((entry) => {
        const effective = input.effective[entry.field];
        if (effective !== undefined) {
            return input.configured[entry.field] !== effective;
        }

        return !input.reread;
    });
}
