/**
 * The projection reader: `GET /v1/config`'s envelope, read fail-closed
 * (006 T-017; FR-003, FR-021, FR-027, FR-028; AC-115, AC-116).
 *
 * This is the panel's half of "one declaration, read twice": the service
 * projects the declaration it validates with, and this reader turns that
 * projection into **closed types** so nothing downstream can treat a guess as
 * a fact. Four rules, each a refusal rather than a partial application
 * (invariant 8):
 *
 * - **An unknown `kind` or `takesEffect`, or a descriptor missing the members
 *   its kind requires, refuses the whole envelope.** The descriptors *are* the
 *   declaration: a row the panel cannot type is a row it must not half-render,
 *   and rendering the other eleven while one is nonsense would present a
 *   document that never existed.
 * - **An unknown `source` refuses too** — the panel branches on it (the
 *   quarantine wording is a promise, not a decoration).
 * - **A `config` member is refused *as a value*, not as a document**: a member
 *   this build cannot type lands in {@link ConfigEnvelope.unreadable} and its
 *   row says so, while every field that did parse keeps rendering (AC-116).
 *   Filling that row from the descriptor's `default` is exactly the move
 *   FR-028 forbids — a default presented as a configured value.
 * - **Vocabulary values this reader has no reason to interpret pass through
 *   verbatim**: an enum's accepted values (a future level name renders as
 *   itself, never mapped to a known one) and the `defaultsApplied` list
 *   (FR-021's "refused or passed through verbatim, never mapped to a guess").
 *
 * The one thing a *member* without a descriptor gets is a flag, not a
 * rendering decision: {@link ConfigEnvelope.undisplayed} is what the tab paints
 * as *field this version does not show* and what later refuses to send a
 * document carrying it (FR-027, AC-115) — because a save that silently dropped
 * an unknown key is the drift this feature exists to remove.
 */

import { asRecord, parseJsonObject } from './json.ts';

/** Take-effect classes the projection may carry. */
export type TakeEffectClass = 'immediate' | 'next-cycle' | 'next-dispatch' | 'restart' | 'none';

/** Where a resolved configuration came from (006 contract §3). */
export type ConfigSource = 'stored' | 'default' | 'quarantined';

/** Every take-effect class, in one membership set. */
const TAKE_EFFECT_CLASSES: ReadonlySet<string> = new Set<TakeEffectClass>([
    'immediate',
    'next-cycle',
    'next-dispatch',
    'restart',
    'none',
]);

/** Every documented source, in one membership set. */
const CONFIG_SOURCES: ReadonlySet<string> = new Set<ConfigSource>(['stored', 'default', 'quarantined']);

/** A `config` value this build may render: a finite number or text. */
export type ConfigValue = number | string;

/** A bounded numeric field, as the projection carries it. */
export interface IntegerDescriptor {
    /** Documented key. */
    readonly name: string;
    /** Kind discriminator. */
    readonly kind: 'integer';
    /** The service's own unit phrase; a numeric field always carries one. */
    readonly unit: string;
    /** Inclusive lower bound. */
    readonly min: number;
    /** Inclusive upper bound. */
    readonly max: number;
    /** The documented default, rendered as *default* and never as the value. */
    readonly default: number;
    /** Declared take-effect class. */
    readonly takesEffect: TakeEffectClass;
}

/** An enum field, whose accepted values pass through verbatim. */
export interface EnumDescriptor {
    /** Documented key. */
    readonly name: string;
    /** Kind discriminator. */
    readonly kind: 'enum';
    /** An enum has no unit; none may be fabricated. */
    readonly unit: null;
    /** Accepted values, verbatim — unknown ones are kept, never mapped. */
    readonly values: readonly string[];
    /** The documented default. */
    readonly default: string;
    /** Declared take-effect class. */
    readonly takesEffect: TakeEffectClass;
}

/** The string field, whose bounds are a format rather than a range. */
export interface StringDescriptor {
    /** Documented key. */
    readonly name: string;
    /** Kind discriminator. */
    readonly kind: 'string';
    /** A string has no unit; none may be fabricated. */
    readonly unit: null;
    /** Service-authored prose about the allowed characters, rendered as text. */
    readonly format: string;
    /** Length ceiling in characters. */
    readonly maxLength: number;
    /** The documented default. */
    readonly default: string;
    /** Declared take-effect class. */
    readonly takesEffect: TakeEffectClass;
    /**
     * Present only when the service declared the value as prose written
     * across several lines, so the row mounts a textarea rather than a
     * one-line input (owner ruling, PR #12; 006 FR-021's union is extended
     * additively — no member was removed or renamed).
     *
     * The reader accepts it in exactly the one shape the projection emits
     * (`true`) or not at all; every other value **refuses the envelope**
     * rather than being dropped, because a declaration this build half-reads
     * is a row it would render wrong (invariant 8).
     */
    readonly multiline?: true;
}

/** One projected field — a closed discriminated union on `kind`. */
export type FieldDescriptor = IntegerDescriptor | EnumDescriptor | StringDescriptor;

/** One parsed `GET /v1/config` answer. */
export interface ConfigEnvelope {
    /** The members this build could type; the rest are listed below. */
    readonly config: Readonly<Record<string, ConfigValue>>;
    /** The declaration, in the service's order (the row order follows it). */
    readonly fields: readonly FieldDescriptor[];
    /** Where `config` came from; the quarantine wording hangs off it. */
    readonly source: ConfigSource;
    /** Documented keys this read filled from the default; `[]` unless stored. */
    readonly defaultsApplied: readonly string[];
    /** `config` members no descriptor covers: *field this version does not show*. */
    readonly undisplayed: readonly string[];
    /** `config` members whose value this build cannot type: *unreadable*. */
    readonly unreadable: readonly string[];
}

/**
 * Read a string member, refusing anything else.
 *
 * @returns The string, or `null` when it is not one.
 */
function textOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Read a finite-number member, refusing anything else.
 *
 * @returns The number, or `null` when it is not a finite one.
 */
function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a string list, refusing anything else.
 *
 * @returns The list, or `null` when it is not an array of strings.
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

/** The two members every descriptor must carry before its kind's own. */
interface DescriptorHead {
    /** Documented key. */
    readonly name: string;
    /** Declared take-effect class. */
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
 *
 * @returns The descriptor, or `null` when a required member is missing or mistyped.
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
 * Decide whether a document value fits the descriptor that governs it.
 *
 * The descriptor is the declaration, so "type" is not a JavaScript question
 * alone: a string under an `integer` field, a number under an enum, and a
 * level the accepted set does not carry are all values this build cannot
 * render *as configured* (AC-116, 005's own rule for a mismatched row). A
 * member with **no** descriptor is judged on its own shape only — it will be
 * rendered as *field this version does not show*, which needs a value to show
 * and makes no claim about which kind it should have been.
 *
 * @returns `true` when the value may be rendered as configured.
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
 *
 * @returns The readable members, and the names of the unreadable ones.
 */
function partitionConfig(
    config: Record<string, unknown>,
    descriptors: readonly FieldDescriptor[],
): {
    /** Members worth rendering as configured. */
    readonly readable: Record<string, ConfigValue>;
    /** Members whose value this build refuses to half-apply. */
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
 *
 * @returns `true` for a documented source.
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

/** One `PUT /v1/config` answer: the document now in force, and its audit outcome. */
export interface ConfigWriteAnswer {
    /** The configuration the service says it stored, as a full envelope. */
    readonly returned: ConfigEnvelope;
    /**
     * Whether the `config.changed` row reached disk, or
     * `null` when the answer carried no such member — which is *not* a claim
     * that it did: the panel never implies traceability it does not have.
     */
    readonly auditWritten: boolean | null;
}

/**
 * Read a `PUT /v1/config` answer fail closed.
 *
 * The contract's write answer is `{ config, auditWritten }` (§4) — **not** the
 * read envelope, because a write has no `source` or `defaultsApplied` to
 * report: the declaration it does not carry is the one this tab read before it
 * wrote. So the reader takes the two shapes it can meet, in this order:
 *
 * 1. a **full envelope** (the shape the read answers with) is adopted as it
 *    stands, which is what the co-ship assumption in §1 relies on;
 * 2. otherwise a `config` member is judged against **the declaration the last
 *    read supplied** and rebuilt into a full envelope whose `source` is
 *    `stored` — the service has just said it wrote the document, and the
 *    members it did not send (the descriptor list) are immutable by
 *    construction: `GET /v1/config` projects them from `service/config.ts`.
 *
 * Anything else — no `config` member, an unparseable body — refuses rather
 * than half-applying, and the caller reports a document the panel could not
 * read (invariant 8).
 *
 * @returns The answer, or `null` when neither shape can be trusted.
 */
export function parseConfigWriteAnswer(input: {
    /** Response body text. */
    readonly body: string;
    /** The last document this tab read, which supplies the declaration. */
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
