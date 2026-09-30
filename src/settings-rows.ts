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

import type { ConfigEnvelope, FieldDescriptor, TakeEffectClass } from './settings-schema.ts';

/** One rendered row: the member it belongs to and the line the tab paints. */
export interface SettingsRow {
    /** Document member this row renders (a descriptor name, or an extra key). */
    readonly field: string;
    /** The painted line: value, unit-or-none, bounds-or-format, and class (FR-014). */
    readonly text: string;
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
function takeEffectWords(takesEffect: TakeEffectClass): string {
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
 * Build the row for a member the service declared.
 *
 * @param envelope - The parsed document.
 * @param descriptor - The member's descriptor.
 * @returns The painted line, or the unreadable line when its value did not fit.
 */
function descriptorRow(envelope: ConfigEnvelope, descriptor: FieldDescriptor): SettingsRow {
    const filled = envelope.defaultsApplied.includes(descriptor.name);
    const suffix = filled ? ' · reads as default' : '';
    const words = takeEffectWords(descriptor.takesEffect);
    const value = envelope.config[descriptor.name];
    if (value === undefined) {
        return {
            field: descriptor.name,
            text: `${descriptor.name}: unreadable — ${shapeRemediation(descriptor)} · ${words}`,
        };
    }

    const marked = `${descriptor.name}: ${valuePart(descriptor, value)} · default ${descriptor.default}` +
        `${suffix} · ${words}`;

    return { field: descriptor.name, text: marked };
}

/**
 * Build the row for a member the service sent no descriptor for (AC-115).
 *
 * It borrows no bound and promises no effect: this build has nothing to say
 * about a field it does not know beyond naming it and showing what arrived.
 *
 * @param envelope - The parsed document.
 * @param name - The member's name.
 * @returns The painted line.
 */
function undisplayedRow(envelope: ConfigEnvelope, name: string): SettingsRow {
    if (envelope.unreadable.includes(name)) {
        return { field: name, text: `${name}: unreadable — this version cannot read its value` };
    }

    const value = envelope.config[name];

    return {
        field: name,
        text: `${name}: ${String(value)} · field this version does not show`,
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
