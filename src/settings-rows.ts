/**
 * The Settings tab's row builder (006 T-018; FR-014, FR-022, FR-027, FR-030).
 *
 * **005's stand-in is retired.** This file used to carry a panel-side copy of
 * the service's bounds, defaults, and enum set — a declaration that had to be
 * cross-checked against `service/config.ts` on every run because it *would*
 * drift, and that `tests/settings-rows.test.ts` has now reversed into
 * AC-106's zero-literals scan: the panel source carries no bound, unit,
 * default, accepted-value, or take-effect literal of its own (plan X7's single
 * documented exception is `DEFAULT_EXPECTED_AGENT`, pinned to
 * `DEFAULT_CONFIG.expectedAgent` by test).
 *
 * What is here now is the projection-driven half: one row per descriptor the
 * service sent, plus a row for any `config` member it sent **no** descriptor
 * for. Three rules the rows obey (FR-014, FR-027, NFR-112):
 *
 * 1. **Every attribute comes from the wire** — name, unit-or-*none*,
 *    bounds-or-format, value, and the class the service declared. Nothing here
 *    knows a number the service did not send.
 * 2. **A value the build cannot type renders *unreadable*** with a remediation
 *    derived from the descriptor, and **never** a default in its place
 *    (AC-116, FR-028).
 * 3. **A member with no descriptor renders *field this version does not
 *    show***, with no borrowed bound and no promised effect (AC-115, FR-027).
 *
 * The take-effect *words* are panel copy — the service sends the class token,
 * and FR-030 requires the product's own words beside the field — so the map
 * below is keyed by the service's vocabulary and names no field: it claims
 * nothing about any particular row, which is exactly the line AC-106 draws.
 */

import { mountSelect, mountText, mountTextField } from '@openchamber/sdk/ui';
import type { SelectHandle, TextHandle, TextFieldHandle } from '@openchamber/sdk/ui';
import type { ConfigEnvelope, FieldDescriptor, TakeEffectClass } from './settings-schema.ts';

/** One rendered row: the member it belongs to and the line the tab paints. */
export interface SettingsRow {
    /** Document member this row renders (a descriptor name, or an extra key). */
    readonly field: string;
    /** The painted line: value, unit-or-none, bounds-or-format, and class (FR-014). */
    readonly text: string;
    /** The control's accessible name: name, unit, and the boundary (FR-018, FR-039). */
    readonly label: string;
    /** The presentation affordance: bounds or format, plus the default (FR-023). */
    readonly helper: string;
    /** Whether this member gets a control; an undocumented member does not (FR-027). */
    readonly editable: boolean;
}

/**
 * The product's words for each class the service may declare (FR-030).
 *
 * An if-chain rather than an object literal keyed by the vocabulary, for the
 * same reason every other panel module spells these tokens as comparisons:
 * the class token is the **service's**, and this function only ever translates
 * the class it is handed — it never decides which class a field has (AC-106).
 * `none` and `restart` are covered because the vocabulary is closed (FR-021);
 * no field in this feature declares either.
 *
 * @param takesEffect - The class the descriptor carried.
 * @returns The words to print beside the field.
 */
export function takeEffectWords(takesEffect: TakeEffectClass): string {
    if (takesEffect === 'immediate') {
        return 'takes effect immediately, with no restart';
    }

    if (takesEffect === 'next-cycle') {
        return 'in effect from the next poll';
    }

    if (takesEffect === 'next-dispatch') {
        return 'in effect from the next dispatch';
    }

    if (takesEffect === 'restart') {
        return 'in effect after a service restart';
    }

    return 'no take-effect boundary declared';
}

/**
 * The value segment of a readable row: the value, its unit or the explicit
 * absence of one, and the shape the service declared (FR-014).
 *
 * @param descriptor - The field's descriptor.
 * @param value - Its value as read from the document.
 * @returns The value segment.
 */
function valuePart(descriptor: FieldDescriptor, value: number | string): string {
    if (descriptor.kind === 'integer') {
        return `${value} ${descriptor.unit} · bounds ${descriptor.min}–${descriptor.max}`;
    }

    if (descriptor.kind === 'enum') {
        return `${value} (unit none) · accepted: ${descriptor.values.join(', ')}`;
    }

    return `${value} (unit none) · format: ${descriptor.format}, max ${descriptor.maxLength} characters`;
}

/**
 * The remediation for a value that does not match its descriptor.
 *
 * Built from the descriptor, never from a literal, so an operator who sees it
 * here and in a `422` reads the same sentence the service would have sent
 * (FR-024's spirit on the read path).
 *
 * @param descriptor - The field's descriptor.
 * @returns The action that would make the row render as configured.
 */
function shapeRemediation(descriptor: FieldDescriptor): string {
    if (descriptor.kind === 'integer') {
        const { min, max, unit } = descriptor;

        return `set ${descriptor.name} to an integer between ${min} and ${max} ${unit}`;
    }

    if (descriptor.kind === 'enum') {
        return `set ${descriptor.name} to one of ${descriptor.values.join(', ')}`;
    }

    return `set ${descriptor.name} to text matching ${descriptor.format}`;
}

/**
 * The control's accessible name: the documented name, its unit (or its
 * absence), and the boundary in the product's words (FR-018, FR-030, FR-039).
 *
 * @param descriptor - The field's descriptor.
 * @returns The label the control is mounted with.
 */
function labelOf(descriptor: FieldDescriptor): string {
    const unit = descriptor.kind === 'integer' ? descriptor.unit : 'unit none';

    return `${descriptor.name} (${unit}) — ${takeEffectWords(descriptor.takesEffect)}`;
}

/**
 * The presentation affordance: what the service declares about the shape of
 * the value, plus its default (FR-023 — these shape the control and the hint
 * and nothing else; the service remains the only validator).
 *
 * @param descriptor - The field's descriptor.
 * @returns The helper text the control carries.
 */
function helperOf(descriptor: FieldDescriptor): string {
    if (descriptor.kind === 'integer') {
        return `bounds ${descriptor.min}–${descriptor.max} · default ${descriptor.default}`;
    }

    if (descriptor.kind === 'enum') {
        return `accepted: ${descriptor.values.join(', ')} · default ${descriptor.default}`;
    }

    return `format: ${descriptor.format}, max ${descriptor.maxLength} characters · default ${descriptor.default}`;
}

/**
 * Build the row for a member the service declared.
 *
 * @param envelope - The parsed document.
 * @param descriptor - The member's descriptor.
 * @returns The row: its painted line, its control's name, and its affordance.
 */
function descriptorRow(envelope: ConfigEnvelope, descriptor: FieldDescriptor): SettingsRow {
    const filled = envelope.defaultsApplied.includes(descriptor.name);
    const suffix = filled ? ' · reads as default' : '';
    const words = takeEffectWords(descriptor.takesEffect);
    const value = envelope.config[descriptor.name];
    const label = labelOf(descriptor);
    const helper = `${helperOf(descriptor)}${suffix}`;
    if (value === undefined) {
        return {
            field: descriptor.name,
            text: `${descriptor.name}: unreadable — ${shapeRemediation(descriptor)} · ${words}`,
            label,
            helper,
            editable: true,
        };
    }

    const marked = `${descriptor.name}: ${valuePart(descriptor, value)} · default ${descriptor.default}` +
        `${suffix} · ${words}`;

    return { field: descriptor.name, text: marked, label, helper, editable: true };
}

/**
 * Build the row for a member the service sent no descriptor for (AC-115).
 *
 * It borrows no bound and promises no effect: this build has nothing to say
 * about a field it does not know beyond naming it and showing what arrived —
 * and it gets **no affordance**, because a control here could not be wired to
 * a declaration the service never made (FR-027).
 *
 * @param envelope - The parsed document.
 * @param name - The member's name.
 * @returns The row, which is never editable.
 */
function undisplayedRow(envelope: ConfigEnvelope, name: string): SettingsRow {
    if (envelope.unreadable.includes(name)) {
        return {
            field: name,
            text: `${name}: unreadable — this version cannot read its value`,
            label: name,
            helper: '',
            editable: false,
        };
    }

    const value = envelope.config[name];

    return {
        field: name,
        text: `${name}: ${String(value)} · field this version does not show`,
        label: name,
        helper: '',
        editable: false,
    };
}

/**
 * Build every row the tab paints: one per descriptor in the service's order,
 * then one per member it declared nothing for (FR-014, FR-027).
 *
 * The count is derived, never asserted from a literal: eleven against an
 * 006-only projection, thirteen once 003's two fields are in it, and one more
 * for every key the service sent without a descriptor (AC-101, SC-102).
 *
 * @param envelope - The parsed `GET /v1/config` answer.
 * @returns The rows, in paint order.
 */
export function settingsRows(envelope: ConfigEnvelope): readonly SettingsRow[] {
    const rows: SettingsRow[] = envelope.fields.map((descriptor) => descriptorRow(envelope, descriptor));
    for (const name of envelope.undisplayed) {
        rows.push(undisplayedRow(envelope, name));
    }

    return rows;
}

/** One mounted row: a control for a declared member, or a line for the rest. */
export type SettingsRowHandle =
    /** A member this build declares no control for (AC-115: no affordance). */
    | { readonly field: string; readonly kind: 'text'; readonly handle: TextHandle }
    /** A declared enum member, edited through the accepted set. */
    | { readonly field: string; readonly kind: 'enum'; readonly handle: SelectHandle }
    /** A declared numeric or text member, edited as text — never gated here. */
    | { readonly field: string; readonly kind: 'value'; readonly handle: TextFieldHandle };

/** The mounted rows, plus the field list they were built from. */
export interface SettingsRowsUi {
    /** Handles, in paint order. */
    readonly handles: readonly SettingsRowHandle[];
    /** The members the handles were built for; a different list means rebuild. */
    readonly fields: readonly string[];
    /** Remove every node and handle this mount created. */
    readonly dispose: () => void;
}

/** Everything one mount or update of the rows needs from the tab. */
export interface RowsContext {
    /** Rows, in paint order. */
    readonly rows: readonly SettingsRow[];
    /** Descriptors, so a control can be shaped from its own. */
    readonly descriptors: readonly FieldDescriptor[];
    /** What each input should show: the draft, keyed by field. */
    readonly values: Readonly<Record<string, string>>;
    /** The service's remediation per field, for the field's own error slot. */
    readonly issues: Readonly<Record<string, string>>;
    /** Extra helper text per field, such as the pending marker (FR-038). */
    readonly notes: Readonly<Record<string, string>>;
    /** Whether every control is currently disabled (no save, or a write in flight). */
    readonly disabled: boolean;
    /** What an input change does: it edits the draft, and nothing else. */
    readonly onChange: (field: string, value: string) => void;
}

/**
 * The enum control's options, taken from the descriptor's accepted values.
 *
 * @param descriptor - The enum descriptor.
 * @returns The options, verbatim (an unknown value renders as itself).
 */
function optionsFor(descriptor: FieldDescriptor): readonly { readonly id: string; readonly label: string }[] {
    return descriptor.kind === 'enum' ? descriptor.values.map((value) => ({ id: value, label: value })) : [];
}

/**
 * Mount one row's control (or its line) into the rows region.
 *
 * @param input - The container, the row, and everything the control reads.
 * @returns The handle, tagged with what kind it is.
 */
function mountRow(input: {
    /** Container the row mounts into. */
    readonly box: HTMLElement;
    /** The row to mount. */
    readonly row: SettingsRow;
    /** Everything the control reads. */
    readonly context: RowsContext;
}): SettingsRowHandle {
    const { box, row, context } = input;
    if (!row.editable) {
        return { field: row.field, kind: 'text', handle: mountText(box, { text: row.text }) };
    }

    const descriptor = context.descriptors.find((candidate) => candidate.name === row.field);
    if (descriptor === undefined) {
        // Unreachable: an editable row exists only because a descriptor does.
        // Falling back to the line means a future mismatch fails loudly in a
        // test rather than mounting a control with no declaration behind it.
        return { field: row.field, kind: 'text', handle: mountText(box, { text: row.text }) };
    }

    const helper = `${row.helper}${context.notes[row.field] === undefined ? '' : ` · ${context.notes[row.field]}`}`;
    const error = context.issues[row.field];
    const shared = {
        label: row.label,
        disabled: context.disabled,
        onChange: (value: string): void => context.onChange(row.field, value),
    };
    if (descriptor.kind === 'enum') {
        return {
            field: row.field,
            kind: 'enum',
            handle: mountSelect(box, {
                ...shared,
                value: context.values[row.field] ?? null,
                options: [...optionsFor(descriptor)],
            }),
        };
    }

    return {
        field: row.field,
        kind: 'value',
        handle: mountTextField(box, {
            ...shared,
            value: context.values[row.field] ?? '',
            helper,
            ...(error === undefined ? {} : { error }),
        }),
    };
}

/**
 * Mount the whole rows region.
 *
 * @param input - The container, and everything the controls read.
 * @returns The mounted rows, plus the field list they were built from.
 */
export function mountSettingsRows(input: {
    /** Container the rows mount into. */
    readonly box: HTMLElement;
    /** Everything the controls read. */
    readonly context: RowsContext;
}): SettingsRowsUi {
    const handles = input.context.rows.map((row) => mountRow({ box: input.box, row, context: input.context }));

    return {
        handles,
        fields: input.context.rows.map((row) => row.field),
        dispose: (): void => {
            for (const handle of handles) {
                handle.handle.dispose();
            }
        },
    };
}

/**
 * Patch the mounted rows for a repaint — no rebuild, so an input keeps its
 * focus and the operator's typing survives every state change.
 *
 * @param ui - The mounted rows.
 * @param context - Everything the controls read.
 */
export function updateSettingsRows(ui: SettingsRowsUi, context: RowsContext): void {
    for (const handle of ui.handles) {
        const row = context.rows.find((candidate) => candidate.field === handle.field);
        if (row === undefined) {
            continue;
        }

        if (handle.kind === 'text') {
            handle.handle.update({ text: row.text });
            continue;
        }

        if (handle.kind === 'enum') {
            handle.handle.update({
                value: context.values[handle.field] ?? null,
                disabled: context.disabled,
            });
            continue;
        }

        const helper = `${row.helper}${context.notes[handle.field] === undefined
            ? ''
            : ` · ${context.notes[handle.field]}`}`;
        const error = context.issues[handle.field];
        handle.handle.update({
            value: context.values[handle.field] ?? '',
            helper,
            disabled: context.disabled,
            ...(error === undefined ? {} : { error }),
        });
    }
}
