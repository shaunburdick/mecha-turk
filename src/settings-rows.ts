/**
 * The Settings tab's row declaration and row builder (005 T-027).
 *
 * **A stand-in, deliberately.** `GET /v1/config` answers with values only —
 * no units, no bounds, no defaults, no take-effect classes — and 005's own
 * `## Wire Surface Delta` keeps that document unchanged, so FR-071's
 * "each bound is the service's own, not a re-typed copy" cannot be met from
 * the wire yet (research Q1). This file is the panel-side declaration that
 * fills the gap for 005's window, and
 * **`tests/settings-rows.test.ts` cross-checks it against
 * `service/config.ts`'s `NUMERIC_BOUNDS`, `DEFAULT_CONFIG`, and `LOG_LEVELS`
 * on every run**, so a service bound change fails the build instead of
 * printing a stale number to the operator.
 *
 * **006 T-018 deletes this file and that test together** — the projection
 * moves onto the wire, where FR-071's "service's own" rule needs no
 * stand-in. Treat every line here as the temporary surface it is: no control,
 * no write path, no member 006 will not carry.
 *
 * Three rules the rows obey (FR-071, FR-072, NFR-112):
 *
 * 1. **One row per field the document actually carries** — no hard-coded
 *    count; a field this build does not declare still renders (research Q2),
 *    and a declared field the document does not carry renders nothing.
 * 2. **Never a bound the service did not declare** — an undeclared field
 *    says so rather than borrowing a neighbour's numbers.
 * 3. **Never a default presented as a configured value** — an unreadable
 *    field renders *unreadable* with its remediation and no default at all.
 *
 * The take-effect statements name the consumer this build actually has:
 * three fields are read (the poll loop, the claim and sweep, the dispatch
 * authorization) and nine are stored and validated but never consumed here,
 * which is exactly FR-072's "not at all without the write path" case.
 */

import { asRecord, parseJsonObject } from './json.ts';

/** Where a change to one field reaches the service, in this build (FR-072). */
export type TakeEffect =
    /** Read from the document again at the consumer's next scheduling boundary. */
    | 'next-cycle'
    /** Stored and validated, but read by no part of this build. */
    | 'no-effect';

/** Inclusive numeric bounds of one declared field, with the unit they are in. */
export interface DeclaredBounds {
    /** Lowest accepted integer. */
    readonly min: number;
    /** Highest accepted integer. */
    readonly max: number;
    /** The service's own unit phrase (`milliseconds`, `days`, …). */
    readonly unit: string;
}

/** One field of `GET /v1/config`, as this build declares it for the tab. */
export interface SettingsRowDecl {
    /** Document member this row renders. */
    readonly field: string;
    /** Inclusive bounds for a numeric field; `null` for the enum field. */
    readonly bounds: DeclaredBounds | null;
    /** Accepted values for an enum field; `null` for a numeric field. */
    readonly values: readonly string[] | null;
    /** The service's own default, rendered as *default*, never as the value. */
    readonly defaultValue: number | string;
    /** The effect class, for tests and for 006's own cross-check. */
    readonly effect: TakeEffect;
    /** The honest one-line statement of what a change does and when (FR-072). */
    readonly takeEffect: string;
}

/** The effect class for a field this build re-reads on its own boundary. */
const NEXT_CYCLE: TakeEffect = 'next-cycle';

/** Fields 003 added to the document, named once for the shared statement. */
const CONSUMER_READ_STATEMENT =
    'No effect in this build: nothing reads it from this document, so a change takes effect ' +
    'nowhere — not at the next cycle and not on a restart. Editing arrives with feature 006.';

/**
 * The single row declaration: one entry per field `GET /v1/config` carried
 * when this feature was built.
 *
 * Bounds, defaults, and the enum set are the service's own values, pinned by
 * `tests/settings-rows.test.ts` — this array is the copy under test, not the
 * source of truth.
 */
export const SETTINGS_FIELDS: readonly SettingsRowDecl[] = [
    {
        field: 'intervalMs',
        bounds: { min: 15_000, max: 300_000, unit: 'milliseconds' },
        values: null,
        defaultValue: 60_000,
        effect: NEXT_CYCLE,
        takeEffect:
            'Takes effect at the next poll cycle: the loop re-reads the interval from this document ' +
            'before scheduling that cycle, so no restart is needed.',
    },
    {
        field: 'overlapMs',
        bounds: { min: 60_000, max: 7_200_000, unit: 'milliseconds' },
        values: null,
        defaultValue: 600_000,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'perPage',
        bounds: { min: 1, max: 30, unit: 'items per page' },
        values: null,
        defaultValue: 30,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'retryMaxAttempts',
        bounds: { min: 1, max: 10, unit: 'attempts' },
        values: null,
        defaultValue: 5,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'retryBaseMs',
        bounds: { min: 1_000, max: 60_000, unit: 'milliseconds' },
        values: null,
        defaultValue: 5_000,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'retryMaxMs',
        bounds: { min: 5_000, max: 300_000, unit: 'milliseconds' },
        values: null,
        defaultValue: 60_000,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'auditRetentionDays',
        bounds: { min: 7, max: 3_650, unit: 'days' },
        values: null,
        defaultValue: 180,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'auditMaxEntries',
        bounds: { min: 1_000, max: 1_000_000, unit: 'entries' },
        values: null,
        defaultValue: 50_000,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'excerptRetentionDays',
        bounds: { min: 1, max: 365, unit: 'days' },
        values: null,
        defaultValue: 30,
        effect: 'no-effect',
        takeEffect: CONSUMER_READ_STATEMENT,
    },
    {
        field: 'leaseMs',
        bounds: { min: 30_000, max: 600_000, unit: 'milliseconds' },
        values: null,
        defaultValue: 120_000,
        effect: NEXT_CYCLE,
        takeEffect:
            'Takes effect at the next claim and sweep pass: both read this document when they run, ' +
            'so no restart is needed.',
    },
    {
        field: 'resultDeadlineMs',
        bounds: { min: 30_000, max: 600_000, unit: 'milliseconds' },
        values: null,
        defaultValue: 120_000,
        effect: NEXT_CYCLE,
        takeEffect:
            'Takes effect for the next dispatch: the deadline is read from this document when an ' +
            'attempt is reserved, so no restart is needed.',
    },
    {
        field: 'logLevel',
        bounds: null,
        values: ['debug', 'info', 'warn', 'error'],
        defaultValue: 'info',
        effect: 'no-effect',
        takeEffect:
            'No effect in this build: the service logs at the level it started with and never reads ' +
            'this field, so a change takes effect nowhere — editing arrives with feature 006.',
    },
];

/** One field of the configuration document, as the tab can render it. */
export type DocumentField =
    /** A finite number. */
    | { readonly name: string; readonly kind: 'number'; readonly value: number }
    /** A string. */
    | { readonly name: string; readonly kind: 'string'; readonly value: string }
    /** A value the tab refuses to render, with the action that would fix it. */
    | { readonly name: string; readonly kind: 'unreadable'; readonly remediation: string };

/** A parsed `GET /v1/config` answer: every field, in document order. */
export interface ConfigDocument {
    /** The fields the document carried. */
    readonly fields: readonly DocumentField[];
}

/** One rendered row: the field it belongs to and the line the tab paints. */
export interface SettingsRow {
    /** Document member the row renders. */
    readonly field: string;
    /** The painted line: value, unit, bounds, and take-effect (FR-071). */
    readonly text: string;
}

/**
 * Find the declaration for one field.
 *
 * @param name - Document member name.
 * @returns Its declaration, or `null` when this build declares no row for it.
 */
function declarationFor(name: string): SettingsRowDecl | null {
    return SETTINGS_FIELDS.find((candidate) => candidate.field === name) ?? null;
}

/**
 * Read one document field, never echoing what it held.
 *
 * @param name - Document member name.
 * @param value - Value read out of the document.
 * @returns The field, or its remediation when it is not a scalar.
 */
function readField(name: string, value: unknown): DocumentField {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return { name, kind: 'number', value };
    }

    if (typeof value === 'string') {
        return { name, kind: 'string', value };
    }

    return {
        name,
        kind: 'unreadable',
        remediation: `set ${name} to a finite number or a string`,
    };
}

/**
 * Read a `GET /v1/config` body fail closed (FR-003).
 *
 * The envelope is all-or-nothing: no `config` object means no document, so
 * the tab reports a failed read instead of an empty configuration. The
 * *fields* are read one at a time on purpose: a field this build cannot read
 * earns its own remediation row rather than blanking the eleven it sits
 * beside — which is what makes "renders *unreadable*, never a default" a
 * per-field promise (T-027).
 *
 * @param body - Response body text.
 * @returns The document, or `null` when the answer is not one.
 */
export function parseConfigDocument(body: string): ConfigDocument | null {
    const root = parseJsonObject(body);
    const config = root === null ? null : asRecord(root.config);
    if (config === null) {
        return null;
    }

    const fields: DocumentField[] = [];
    for (const [name, value] of Object.entries(config)) {
        fields.push(readField(name, value));
    }

    return { fields };
}

/**
 * The remediation for a value that does not match its declaration.
 *
 * The wording is the service validator's own voice (`service/config.ts`), so
 * an operator who sees it in the panel and in a 422 sees the same sentence.
 *
 * @param decl - The field's declaration.
 * @returns The action that would make the row render.
 */
function shapeRemediation(decl: SettingsRowDecl): string {
    if (decl.bounds !== null) {
        const { min, max, unit } = decl.bounds;

        return `set ${decl.field} to an integer between ${min} and ${max} ${unit}`;
    }

    return `set ${decl.field} to one of ${(decl.values ?? []).join(', ')}`;
}

/** A field of the configuration document this tab will actually render. */
type ReadableField = Extract<DocumentField, { readonly value: number | string }>;

/**
 * The value half of a declared row: what the document holds, its unit or
 * accepted set, and its default — labelled, so neither can read as the other.
 *
 * @param decl - The field's declaration.
 * @param field - Its value as read.
 * @returns The value segment.
 */
function valuePart(decl: SettingsRowDecl, field: ReadableField): string {
    const value = field.kind === 'number' ? String(field.value) : field.value;
    const unit = decl.bounds === null ? '' : ` ${decl.bounds.unit}`;
    const range = decl.bounds === null
        ? `accepted: ${(decl.values ?? []).join(', ')}`
        : `bounds ${decl.bounds.min}–${decl.bounds.max}`;

    return `${value}${unit} · ${range} · default ${decl.defaultValue}`;
}

/**
 * Build the row for one declared field the document carried.
 *
 * @param decl - The field's declaration.
 * @param field - Its value as read.
 * @returns The painted line, or the refusal line when the value does not fit.
 */
function declaredRow(decl: SettingsRowDecl, field: DocumentField): SettingsRow {
    if (field.kind === 'unreadable') {
        return { field: decl.field, text: `${decl.field}: unreadable — ${field.remediation}` };
    }

    if (decl.bounds !== null && field.kind !== 'number') {
        return { field: decl.field, text: `${decl.field}: unreadable — ${shapeRemediation(decl)}` };
    }

    if (decl.values !== null && (field.kind !== 'string' || !decl.values.includes(field.value))) {
        return { field: decl.field, text: `${decl.field}: unreadable — ${shapeRemediation(decl)}` };
    }

    return {
        field: decl.field,
        text: `${decl.field}: ${valuePart(decl, field)} · ${decl.takeEffect}`,
    };
}

/**
 * Build the row for a field this build declares nothing for (research Q2).
 *
 * @param field - Its value as read.
 * @returns The painted line, which borrows no bound and promises no effect.
 */
function undeclaredRow(field: DocumentField): SettingsRow {
    if (field.kind === 'unreadable') {
        return { field: field.name, text: `${field.name}: unreadable — ${field.remediation}` };
    }

    const value = field.kind === 'number' ? String(field.value) : field.value;

    return {
        field: field.name,
        text: `${field.name}: ${value} · bounds and take-effect not declared by this build`,
    };
}

/**
 * Build every row the tab paints, in document order (FR-071).
 *
 * @param doc - The parsed configuration document.
 * @returns One row per field the document carried.
 */
export function settingsRows(doc: ConfigDocument): readonly SettingsRow[] {
    return doc.fields.map((field) => {
        const decl = declarationFor(field.name);

        return decl === null ? undeclaredRow(field) : declaredRow(decl, field);
    });
}
