/**
 * The Settings row builder: every attribute from the wire; no bound, unit or default literal in the panel source.
 */

import { mountSelect, mountText, mountTextField } from '@openchamber/sdk/ui';
import type { SelectHandle, SelectProps, TextHandle, TextFieldHandle, TextFieldProps } from '@openchamber/sdk/ui';
import type {
    ConfigEnvelope,
    EnumDescriptor,
    FieldDescriptor,
    IntegerDescriptor,
    StringDescriptor,
    TakeEffectClass,
} from './settings-schema.ts';

export interface SettingsRow {
    readonly field: string;
    readonly text: string;
    readonly label: string;
    readonly helper: string;
    readonly editable: boolean;
}

/**
 * The product's words for each class the service may declare. An if-chain
 * rather than an object literal keyed by the vocabulary, for the same reason
 * every other panel module spells these tokens as comparisons: the class token
 * is the **service's** and this function only ever translates the class it is
 * handed — it never decides which class a field has. `none` and `restart` are
 * covered because the vocabulary is closed; no field declares either.
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
 * The word an empty string field shows in its value slot.
 *
 * Panel copy rather than a descriptor member, because it reports a *state* —
 * this field is not set — and a declaration cannot describe its own absence.
 * It is the one sentence this module composes that names no bound, unit,
 * default, accepted value, or boundary, so the zero-literals scan still
 * holds: everything printed beside the word is the service's own.
 */
const NOT_SET_WORD = 'not set';

/**
 * How tall a descriptor-declared textarea renders (owner ruling, PR #12).
 * Panel copy rather than a wire member: the same presentation constant the
 * account tier (`accounts-tab.ts`) and the binding tier
 * (`bindings-prompt.ts`) already render with, and unlike a bound, a default,
 * or an accepted value it claims nothing about the configuration — the
 * zero-literals scan looks for declarations of value, which this is not.
 * *Whether* a row is multiline is the descriptor's; *how many rows* is the
 * panel's.
 */
const MULTILINE_ROWS = 4;

/**
 * The value segment of a readable row: the value, its unit or the explicit
 * absence of one, and the shape the service declared.
 *
 * An empty string is not printed as an empty slot: it prints the not-set word
 * while the format guidance beside it stays the descriptor's own text, so the
 * row reads as an honest state rather than a gap.
 */
function valuePart(descriptor: FieldDescriptor, value: number | string): string {
    if (descriptor.kind === 'integer') {
        return `${value} ${descriptor.unit} · bounds ${descriptor.min}–${descriptor.max}`;
    }

    if (descriptor.kind === 'enum') {
        return `${value} (unit none) · accepted: ${descriptor.values.join(', ')}`;
    }

    const shown = value === '' ? NOT_SET_WORD : value;

    return `${shown} (unit none) · format: ${descriptor.format}, max ${descriptor.maxLength} characters`;
}

/**
 * The remediation for a value that does not match its descriptor.
 *
 * Built from the descriptor, never from a literal, so an operator who sees it
 * here and in a `422` reads the same sentence the service would have sent.
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
 * absence), and the boundary in the product's words.
 */
function labelOf(descriptor: FieldDescriptor): string {
    const unit = descriptor.kind === 'integer' ? descriptor.unit : 'unit none';

    return `${descriptor.name} (${unit}) — ${takeEffectWords(descriptor.takesEffect)}`;
}

/**
 * The presentation affordance: what the service declares about the shape of
 * the value, plus its default — these shape the control and the hint and
 * nothing else; the service remains the only validator.
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
 */
function descriptorRow(envelope: ConfigEnvelope, descriptor: FieldDescriptor): SettingsRow {
    const isFilled = envelope.defaultsApplied.includes(descriptor.name);
    const suffix = isFilled ? ' · reads as default' : '';
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
 * Build the row for a member the service sent no descriptor for: it borrows
 * no bound and promises no effect — this build has nothing to say about a
 * field it does not know beyond naming it and showing what arrived — and it
 * gets **no affordance**, because a control here could not be wired to a
 * declaration the service never made. The row is never editable.
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
 * then one per member it declared nothing for. The count is derived, never
 * asserted from a literal — twelve against an 006-only projection, fourteen
 * once the dispatch fields are in it, plus one for every key the service sent
 * without a descriptor. In paint order.
 */
export function settingsRows(envelope: ConfigEnvelope): readonly SettingsRow[] {
    const rows: SettingsRow[] = envelope.fields.map((descriptor) => descriptorRow(envelope, descriptor));
    for (const name of envelope.undisplayed) {
        rows.push(undisplayedRow(envelope, name));
    }

    return rows;
}

export type SettingsRowHandle =
    | { readonly field: string; readonly kind: 'text'; readonly handle: TextHandle }
    | { readonly field: string; readonly kind: 'enum'; readonly handle: SelectHandle }
    /** A declared numeric or text member, edited as text — never gated here. */
    | { readonly field: string; readonly kind: 'value'; readonly handle: TextFieldHandle };

export interface SettingsRowsUi {
    readonly handles: readonly SettingsRowHandle[];
    readonly fields: readonly string[];
    readonly dispose: () => void;
}

export interface RowsContext {
    readonly rows: readonly SettingsRow[];
    readonly descriptors: readonly FieldDescriptor[];
    readonly values: Readonly<Record<string, string>>;
    readonly issues: Readonly<Record<string, string>>;
    readonly notes: Readonly<Record<string, string>>;
    readonly disabled: boolean;
    readonly onChange: (field: string, value: string) => void;
}

/**
 * The enum control's options, taken from the descriptor's accepted values.
 */
function optionsFor(descriptor: FieldDescriptor): readonly { readonly id: string; readonly label: string }[] {
    return descriptor.kind === 'enum' ? descriptor.values.map((value) => ({ id: value, label: value })) : [];
}

/**
 * The props a declared **enum** member's select mounts with.
 *
 * Every attribute is the descriptor's or the tab's own state: the accepted
 * set verbatim, the label composed upstream from the same declaration, and
 * the service's current value — nothing here decides an option or a class.
 */
function enumFieldProps(input: {
    readonly row: SettingsRow;
    readonly descriptor: EnumDescriptor;
    readonly context: RowsContext;
}): SelectProps {
    const { row, descriptor, context } = input;

    return {
        label: row.label,
        disabled: context.disabled,
        onChange: (value: string): void => context.onChange(row.field, value),
        value: context.values[row.field] ?? null,
        options: [...optionsFor(descriptor)],
    };
}

/**
 * The props a declared **value** member's text control mounts with. Two rules
 * ride the descriptor rather than the field's name: a **string** field shows
 * the honest-absence word in its value slot — an empty box states *not set*
 * instead of reading as an empty instruction, and the word leaves the moment
 * anything is in the field (same input, same keyboard path, same accessible
 * name) — and a descriptor that declares **`multiline`** mounts a textarea
 * (owner ruling, PR #12), so the control's *shape* comes off the wire like
 * every other row attribute. The row count is the shared presentation
 * constant: a height, not a bound.
 */
function valueFieldProps(input: {
    readonly row: SettingsRow;
    readonly descriptor: IntegerDescriptor | StringDescriptor;
    readonly context: RowsContext;
}): TextFieldProps {
    const { row, descriptor, context } = input;
    const helper = `${row.helper}${context.notes[row.field] === undefined ? '' : ` · ${context.notes[row.field]}`}`;
    const error = context.issues[row.field];

    return {
        label: row.label,
        disabled: context.disabled,
        onChange: (value: string): void => context.onChange(row.field, value),
        value: context.values[row.field] ?? '',
        ...(descriptor.kind === 'string' && { placeholder: NOT_SET_WORD }),
        ...(descriptor.kind === 'string' && descriptor.multiline === true && { multiline: true, rows: MULTILINE_ROWS }),
        helper,
        ...(error !== undefined && { error }),
    };
}

/**
 * Mount the control for a member the service declared.
 *
 * The descriptor decides the *shape* — the accepted set, or an input — and
 * nothing else: the label, the affordance, and the value were all composed
 * from the same declaration upstream, and the service stays the only validator.
 */
function mountDeclaredRow(input: {
    readonly box: HTMLElement;
    readonly row: SettingsRow;
    readonly descriptor: FieldDescriptor;
    readonly context: RowsContext;
}): SettingsRowHandle {
    const { box, row, descriptor, context } = input;
    if (descriptor.kind === 'enum') {
        return {
            field: row.field,
            kind: 'enum',
            handle: mountSelect(box, enumFieldProps({ row, descriptor, context })),
        };
    }

    return {
        field: row.field,
        kind: 'value',
        handle: mountTextField(box, valueFieldProps({ row, descriptor, context })),
    };
}

/**
 * Mount one row's control (or its line) into the rows region.
 */
function mountRow(input: {
    readonly box: HTMLElement;
    readonly row: SettingsRow;
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

    return mountDeclaredRow({ box, row, descriptor, context });
}

/**
 * Mount the whole rows region.
 */
export function mountSettingsRows(input: {
    readonly box: HTMLElement;
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
            ...(error !== undefined && { error }),
        });
    }
}
