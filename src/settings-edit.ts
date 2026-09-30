/**
 * The Settings draft/save state machine (006 T-019; FR-012, FR-013, FR-015,
 * FR-038, FR-041, FR-042, FR-046, FR-049; AC-105, AC-122 – AC-126, NFR-104).
 *
 * Pure by design: this module holds no host, no DOM, and no clock, so every
 * rule the edit surface has to obey is a function call a test can make
 * directly. What it encodes, in order of how easy each is to get wrong:
 *
 * - **The draft** is *last-read document ∪ projection defaults for keys it
 *   lacks ∪ edits* (FR-041). A save therefore sends the whole document the
 *   service reported, with the operator's changes applied — never a partial
 *   one, and never one assembled from values the panel never read.
 * - **No baseline, no save** (FR-042, AC-124): with no read, or with a member
 *   this version cannot show, `blocked` names the reason and `beginSave`
 *   refuses *before* anything could be sent.
 * - **One save, one call** (FR-046, AC-126): a second activation while one is
 *   in flight is refused by the busy gate rather than queued, and nothing in
 *   this module flips a value optimistically — `saved` only ever arrives from
 *   the configuration the service returned (FR-044, AC-125).
 * - **Pending is a claim about the boundary, not about the save** (FR-038,
 *   AC-105): an accepted save marks each changed field whose class is not
 *   `immediate` as pending, naming the class that governs it, and the marker
 *   is retired only by a later *read* — never by the save that created it.
 *
 * Text is kept as text until the document is built: an input's contents become
 * an integer only when they parse as one, so a value the operator typed out of
 * range or out of shape reaches the service **and is refused there** — the
 * panel applies no gate of its own (FR-023, AC-110).
 */

import type { ConfigIssueView } from './service-envelope.ts';
import type { ConfigEnvelope, ConfigValue, FieldDescriptor, TakeEffectClass } from './settings-schema.ts';

/** Where one save stands (006 FR-013). */
export type SaveState = 'idle' | 'editing' | 'saving' | 'saved' | 'refused' | 'failed';

/** One field saved but not yet observed as effective (006 FR-038). */
export interface PendingField {
    /** Document member the marker belongs to. */
    readonly field: string;
    /** The class that governs when it catches up, for the marker's words. */
    readonly boundary: TakeEffectClass;
}

/** The editable state the Settings body holds (pure; no host, no DOM). */
export interface SettingsEdit {
    /** What the inputs show, keyed by field name. */
    readonly draft: Readonly<Record<string, string>>;
    /** Fields whose draft differs from the last-read document. */
    readonly dirty: readonly string[];
    /** Where the save stands. */
    readonly saveState: SaveState;
    /** Why no save is offered; `null` when one is (FR-042). */
    readonly blocked: string | null;
    /** Issues the last refusal answered with, in the service's order. */
    readonly issues: readonly ConfigIssueView[];
    /** Problem the last failed write reported; `null` when none. */
    readonly problem: string | null;
    /** Fields saved but not yet observed effective, with their boundary. */
    readonly pending: readonly PendingField[];
    /** What the last discard reverted, so the tab can say it out loud (AC-122). */
    readonly reverted: readonly string[];
}

/** Why a save is not offered when nothing has ever been read (AC-124). */
export const NO_BASELINE_REASON =
    'no configuration has been read yet, so there is no document to send';

/** Why a save is not offered while the document carries a member we cannot show (AC-115). */
export const UNDISPLAYED_REASON =
    'the document carries a field this version does not show; sending it would drop that field';

/** Why a save is not offered when the latest read failed (FR-042's third case). */
export const READ_FAILED_REASON =
    'the latest read did not land, so there is no current document to send';

/** Why a second save activation is refused rather than queued (AC-126). */
export const BUSY_REASON = 'a save is already in flight';

/**
 * Build the empty edit state, before the first read.
 *
 * @returns The state a fresh mount starts in.
 */
export function emptyEdit(): SettingsEdit {
    return {
        draft: {},
        dirty: [],
        saveState: 'idle',
        blocked: NO_BASELINE_REASON,
        issues: [],
        problem: null,
        pending: [],
        reverted: [],
    };
}

/**
 * The baseline value of one field: the document's, else the descriptor's
 * default for a key the document lacked (FR-041).
 *
 * @param envelope - The last read.
 * @param name - Field to look up.
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
 *
 * @param envelope - The last read.
 * @returns The draft the inputs start with.
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
 * @param draft - The current draft.
 * @param envelope - The baseline it was built from.
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
 * Why no save is offered right now, or `null` when one is (FR-042, AC-115).
 *
 * @param envelope - The last read, or `null` when there has been none.
 * @returns The reason, named for the operator; `null` when a save may run.
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
 * @param edit - Current state.
 * @param envelope - The read that just landed, or `null` when it failed.
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
        reverted: [],
    };
}

/**
 * Apply one field edit (FR-012: the only writes are whole-document ones, so
 * this changes the draft and nothing else).
 *
 * @param input - The state, the baseline the dirty set is measured against,
 *   and the field/text the operator entered.
 * @returns The state after the edit.
 */
export function editField(input: {
    /** Current state. */
    readonly edit: SettingsEdit;
    /** The baseline the dirty set is measured against. */
    readonly envelope: ConfigEnvelope;
    /** Field the operator touched. */
    readonly field: string;
    /** The input's text, kept as text (FR-023). */
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
        reverted: [],
    };
}

/**
 * Discard the unsaved edits: the draft goes back to the baseline and the tab
 * says what reverted (FR-015, AC-122).
 *
 * @param edit - Current state.
 * @param envelope - The baseline to restore.
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
        reverted,
    };
}

/** Why one save activation was refused, or the document it would send. */
export type SaveAttempt =
    /** The write may be sent. */
    | { readonly ok: true; readonly document: Readonly<Record<string, ConfigValue>> }
    /** Nothing is sent; the reason is the tab's to render. */
    | { readonly ok: false; readonly reason: string };

/**
 * Translate one draft value onto the wire, without guessing at its type.
 *
 * @param descriptor - The field's descriptor.
 * @param text - The input's text.
 * @returns The number when the text is an integer, otherwise the text itself.
 */
function valueFor(descriptor: FieldDescriptor, text: string): ConfigValue {
    if (descriptor.kind !== 'integer') {
        return text;
    }

    return /^-?[0-9]+$/.test(text.trim()) ? Number(text.trim()) : text;
}

/**
 * The whole document a save sends: the baseline with the draft applied
 * (FR-040, FR-041).
 *
 * An input's text becomes an integer **only** when it parses as one — an
 * out-of-range number or a stray word is sent as it stands, so the service
 * refuses it in its own words rather than the panel quietly reshaping it
 * (FR-023, AC-110).
 *
 * @param envelope - The baseline document.
 * @param draft - The current draft.
 * @returns The complete document to PUT.
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
 * Try to begin a save: the busy gate, then the baseline gate (FR-042, FR-046).
 *
 * @param edit - Current state.
 * @param envelope - The baseline a save would be built from.
 * @returns The document to PUT, or the reason nothing was sent.
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
 * Record an accepted write, from the configuration the **service** returned
 * (FR-044, AC-125), and mark what it changed as pending (FR-038).
 *
 * @param input - The state, the returned configuration, and the changed fields.
 * @returns The state after the answer.
 */
export function recordSaved(input: {
    /** Current state. */
    readonly edit: SettingsEdit;
    /** The configuration the answer carried (FR-044). */
    readonly returned: ConfigEnvelope;
    /** The fields the write changed, as the service reported them. */
    readonly changed: readonly string[];
}): SettingsEdit {
    const { edit, returned, changed } = input;
    const draft = draftOf(returned);
    const pending = [...edit.pending];
    for (const name of changed) {
        const descriptor = returned.fields.find((candidate) => candidate.name === name);
        if (descriptor === undefined || descriptor.takesEffect === 'immediate') {
            continue;
        }

        if (!pending.some((entry) => entry.field === name)) {
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
        pending,
        reverted: [],
    };
}

/**
 * Record a refusal with the service's own issues, in the service's order
 * (FR-024, AC-107), and put every field back to the last configuration the
 * service reported (FR-025, AC-109): after a refusal the form shows what is
 * in force, not what was typed, so no optimistic local value survives the
 * answer.
 *
 * @param input - The state, the baseline to restore, and the issues.
 * @returns The state after the refusal.
 */
export function recordRefused(input: {
    /** Current state. */
    readonly edit: SettingsEdit;
    /** The last configuration the service reported. */
    readonly envelope: ConfigEnvelope;
    /** Every issue the refusal answered with. */
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
        reverted: [],
    };
}

/**
 * Record a write that could not be completed (FR-063).
 *
 * @param edit - Current state.
 * @param problem - The transport or store cause, as the wrapper reported it.
 * @returns The state after the failure.
 */
export function recordFailed(edit: SettingsEdit, problem: string): SettingsEdit {
    return { ...edit, saveState: 'failed', issues: [], problem };
}

/**
 * Retire the pending markers a read has caught up with (FR-038).
 *
 * The marker is cleared **only** by a read: an entry whose field the status
 * projection carries disappears once the two halves agree, and an entry for a
 * field the projection cannot speak about is retired by a later configuration
 * read — because the panel has no way to observe that boundary, and claiming
 * one would be exactly the optimism FR-038 forbids.
 *
 * @param input - The markers, the freshly read document, and the effective
 *   values a status read reported (empty when none has landed).
 * @returns The markers still worth showing.
 */
export function reconcilePending(input: {
    /** Markers to re-evaluate. */
    readonly pending: readonly PendingField[];
    /** The configuration as it now stands. */
    readonly configured: Readonly<Record<string, ConfigValue>>;
    /** Effective values from a status read, by field; empty when unread. */
    readonly effective: Readonly<Record<string, ConfigValue>>;
    /** Whether a configuration read has landed since the save. */
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
