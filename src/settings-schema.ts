/**
 * The projection reader: `GET /v1/config`'s envelope read fail-closed, refusing a save that would
 * silently drop an unknown key (AC-115) — the panel's half of "one declaration".
 */

import { asRecord, parseJsonObject } from './json.ts';

export type TakeEffectClass = 'immediate' | 'next-cycle' | 'next-dispatch' | 'restart' | 'none';

/** Where a resolved configuration came from (006 contract §3). */
export type ConfigSource = 'stored' | 'default' | 'quarantined';

const TAKE_EFFECT_CLASSES: ReadonlySet<string> = new Set<TakeEffectClass>([
    'immediate',
    'next-cycle',
    'next-dispatch',
    'restart',
    'none',
]);

const CONFIG_SOURCES: ReadonlySet<string> = new Set<ConfigSource>(['stored', 'default', 'quarantined']);

export type ConfigValue = number | string;

export interface IntegerDescriptor {
    readonly name: string;
    readonly kind: 'integer';
    readonly unit: string;
    readonly min: number;
    readonly max: number;
    /** The documented default, rendered as *default* and never as the value. */
    readonly default: number;
    readonly takesEffect: TakeEffectClass;
}

export interface EnumDescriptor {
    readonly name: string;
    readonly kind: 'enum';
    readonly unit: null;
    /** Accepted values, verbatim — unknown ones are kept, never mapped. */
    readonly values: readonly string[];
    readonly default: string;
    readonly takesEffect: TakeEffectClass;
}

export interface StringDescriptor {
    readonly name: string;
    readonly kind: 'string';
    readonly unit: null;
    readonly format: string;
    readonly maxLength: number;
    readonly default: string;
    readonly takesEffect: TakeEffectClass;
    /**
     * Present only when the service declared the value as prose written across
     * several lines, so the row mounts a textarea rather than a one-line input
     * (owner ruling, PR #12; 006 FR-021's union is extended additively — no
     * member was removed or renamed). The reader accepts exactly the shape the
     * projection emits (`true`) or not at all; every other value **refuses the
     * envelope**, because a declaration this build half-reads is a row it would
     * render wrong (invariant 8).
     */
    readonly multiline?: true;
}

export type FieldDescriptor = IntegerDescriptor | EnumDescriptor | StringDescriptor;

export interface ConfigEnvelope {
    readonly config: Readonly<Record<string, ConfigValue>>;
    readonly fields: readonly FieldDescriptor[];
    readonly source: ConfigSource;
    readonly defaultsApplied: readonly string[];
    /** Members no descriptor covers: painted as *field this version does not show* — a save that
     * would carry one is refused rather than silently dropping it (AC-115). */
    readonly undisplayed: readonly string[];
    readonly unreadable: readonly string[];
}

/**
 * Read a string member, refusing anything else.
 */
function textOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Read a finite-number member, refusing anything else.
 */
function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a string list, refusing anything else.
 */
function textListOrNull(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const parsed: string[] = [];
    for (const entry of value) {
        const text = textOrNull(entry);
        if (text === null) {
            return null;
        }

        parsed.push(text);
    }

    return parsed;
}

interface DescriptorHead {
    readonly name: string;
    readonly takesEffect: TakeEffectClass;
}

/**
 * Read the `integer` half of a descriptor.
 *
 * @returns The descriptor, or `null` when a required member is missing or mistyped.
 */
function integerDescriptor(record: Record<string, unknown>, head: DescriptorHead): IntegerDescriptor | null {
    const unit = textOrNull(record.unit);
    const min = numberOrNull(record.min);
    const max = numberOrNull(record.max);
    const fallback = numberOrNull(record.default);
    if (unit === null || min === null || max === null || fallback === null) {
        return null;
    }

    return { name: head.name, kind: 'integer', unit, min, max, default: fallback, takesEffect: head.takesEffect };
}

/**
 * Read the `enum` half of a descriptor.
 */
function enumDescriptor(record: Record<string, unknown>, head: DescriptorHead): EnumDescriptor | null {
    const values = textListOrNull(record.values);
    const fallback = textOrNull(record.default);
    if (values === null || fallback === null || record.unit !== null) {
        return null;
    }

    return { name: head.name, kind: 'enum', unit: null, values, default: fallback, takesEffect: head.takesEffect };
}

/**
 * Read the `string` half of a descriptor.
 *
 * @returns The descriptor, or `null` when a required member is missing or mistyped,
 *   or when the optional `multiline` member carries anything but `true`.
 */
function stringDescriptor(record: Record<string, unknown>, head: DescriptorHead): StringDescriptor | null {
    const format = textOrNull(record.format);
    const maxLength = numberOrNull(record.maxLength);
    const fallback = textOrNull(record.default);
    if (format === null || maxLength === null || fallback === null || record.unit !== null) {
        return null;
    }

    // The one optional member in the union (owner ruling, PR #12): absent is
    // the single-line shape, `true` is the only value the projection emits,
    // and anything else — a `false`, a string, a `null` — refuses the whole
    // envelope rather than being silently dropped, because a row that reads
    // its affordance from the wire must not invent the half it did not get
    // (invariant 8).
    const { multiline } = record;
    if (multiline !== undefined && multiline !== true) {
        return null;
    }

    return {
        name: head.name,
        kind: 'string',
        unit: null,
        format,
        maxLength,
        default: fallback,
        takesEffect: head.takesEffect,
        ...(multiline !== undefined && { multiline: true }),
    };
}

/**
 * Read one descriptor, refusing anything outside the closed union.
 *
 * @returns The descriptor, or `null` for an unknown kind, an unknown class,
 *   or a descriptor missing a member its kind requires.
 */
function readDescriptor(raw: unknown): FieldDescriptor | null {
    const record = asRecord(raw);
    if (record === null) {
        return null;
    }

    const name = textOrNull(record.name);
    const takesEffect = textOrNull(record.takesEffect);
    if (name === null || name === '' || takesEffect === null || !TAKE_EFFECT_CLASSES.has(takesEffect)) {
        return null;
    }

    const head: DescriptorHead = { name, takesEffect: takesEffect as TakeEffectClass };
    if (record.kind === 'integer') {
        return integerDescriptor(record, head);
    }

    if (record.kind === 'enum') {
        return enumDescriptor(record, head);
    }

    if (record.kind === 'string') {
        return stringDescriptor(record, head);
    }

    // An unknown kind is refused rather than rendered as the nearest one: the
    // descriptor is the declaration, and a kind this build does not know is a
    // row it cannot type (FR-021, invariant 8).
    return null;
}

/**
 * Decide whether a document value fits the descriptor that governs it: the
 * descriptor is the declaration, so "type" is not a JavaScript question alone —
 * a string under an `integer` field, a number under an enum, and a level the
 * accepted set does not carry are values this build cannot render *as
 * configured* (AC-116, 005's rule for a mismatched row). A member with **no**
 * descriptor is judged on its own shape only, since it renders as *field this
 * version does not show* and claims no kind.
 */
function fitsDescriptor(descriptor: FieldDescriptor | null, value: unknown): value is ConfigValue {
    if (typeof value === 'number') {
        return Number.isFinite(value) && (descriptor === null || descriptor.kind === 'integer');
    }

    if (typeof value !== 'string') {
        return false;
    }

    if (descriptor === null || descriptor.kind === 'string') {
        return true;
    }

    return descriptor.kind === 'enum' && descriptor.values.includes(value);
}

/**
 * Split the `config` members into the ones this build can render as
 * configured and the ones it cannot.
 */
function partitionConfig(
    config: Record<string, unknown>,
    descriptors: readonly FieldDescriptor[],
): {
    readonly readable: Record<string, ConfigValue>;
    readonly unreadable: readonly string[];
} {
    const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
    const readable: Record<string, ConfigValue> = {};
    const unreadable: string[] = [];
    for (const [name, value] of Object.entries(config)) {
        if (!fitsDescriptor(byName.get(name) ?? null, value)) {
            unreadable.push(name);
            continue;
        }

        readable[name] = value;
    }

    return { readable, unreadable };
}

/**
 * Narrow a source string to the three documented values (contract §3).
 *
 * The guard exists because the panel *branches* on `source` — the quarantine
 * wording is a promise to the operator — so an unrecognised one is refused
 * rather than rendered as though it were `stored`.
 */
function isConfigSource(value: string): value is ConfigSource {
    return CONFIG_SOURCES.has(value);
}

/**
 * Read a `GET /v1/config` body fail closed.
 *
 * @returns The envelope, or `null` when any part of it cannot be trusted.
 */
export function parseConfigEnvelope(body: string): ConfigEnvelope | null {
    const root = parseJsonObject(body);
    if (root === null) {
        return null;
    }

    const config = asRecord(root.config);
    const source = textOrNull(root.source);
    if (config === null || source === null || !isConfigSource(source)) {
        return null;
    }

    const defaultsApplied = textListOrNull(root.defaultsApplied);
    if (defaultsApplied === null) {
        return null;
    }

    const rawFields = Array.isArray(root.fields) ? root.fields : null;
    if (rawFields === null) {
        return null;
    }

    const fields: FieldDescriptor[] = [];
    for (const entry of rawFields) {
        const descriptor = readDescriptor(entry);
        if (descriptor === null) {
            return null;
        }

        fields.push(descriptor);
    }

    const { readable, unreadable } = partitionConfig(config, fields);
    const described = new Set(fields.map((descriptor) => descriptor.name));
    const undisplayed = Object.keys(config).filter((name) => !described.has(name));

    return { config: readable, fields, source, defaultsApplied, undisplayed, unreadable };
}

/**
 * Find the descriptor for one document member.
 *
 * @returns Its descriptor, or `null` when the service declared none.
 */
export function descriptorFor(envelope: ConfigEnvelope, name: string): FieldDescriptor | null {
    return envelope.fields.find((descriptor) => descriptor.name === name) ?? null;
}

export interface ConfigWriteAnswer {
    readonly returned: ConfigEnvelope;
    /**
     * Whether the `config.changed` row reached disk, or
     * `null` when the answer carried no such member — which is *not* a claim
     * that it did: the panel never implies traceability it does not have.
     */
    readonly auditWritten: boolean | null;
}

/**
 * Read a `PUT /v1/config` answer fail closed. The contract's write answer is `{ config,
 * auditWritten }` (§4) — **not** the read envelope, which has no `source` to report. A full
 * envelope is adopted as it stands (§1); otherwise `config` is judged against **the declaration the
 * last read supplied** and rebuilt with `source: stored`, because the descriptors it did not send
 * are immutable by construction. Anything else refuses rather than half-applying (invariant 8);
 * `null` when neither shape can be trusted.
 */
export function parseConfigWriteAnswer(input: {
    readonly body: string;
    readonly previous: ConfigEnvelope;
}): ConfigWriteAnswer | null {
    const root = parseJsonObject(input.body);
    if (root === null) {
        return null;
    }

    const auditWritten = typeof root.auditWritten === 'boolean' ? root.auditWritten : null;
    const full = parseConfigEnvelope(input.body);
    if (full !== null) {
        return { returned: full, auditWritten };
    }

    const config = asRecord(root.config);
    if (config === null) {
        return null;
    }

    const { readable, unreadable } = partitionConfig(config, input.previous.fields);
    const described = new Set(input.previous.fields.map((descriptor) => descriptor.name));
    const undisplayed = Object.keys(config).filter((name) => !described.has(name));

    return {
        returned: {
            config: readable,
            fields: input.previous.fields,
            source: 'stored',
            defaultsApplied: [],
            undisplayed,
            unreadable,
        },
        auditWritten,
    };
}
