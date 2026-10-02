/**
 * The configuration's **schema projection**: the declaration `config.ts`
 * holds, projected onto the wire (006 FR-020 – FR-022, contract §2).
 *
 * This module exists to keep `config.ts` inside the file-length gate while
 * preserving the property that matters: there is still exactly **one**
 * declaration. Every descriptor below is built from `NUMERIC_BOUNDS`,
 * `LOG_LEVEL_VALUES`, `EXPECTED_AGENT_RULE`, and `DEFAULT_CONFIG` — the same
 * objects `validateConfig` reads — plus `TAKE_EFFECT`, the exhaustive class
 * table. Nothing here restates a bound, a default, or an accepted value, so a
 * number cannot move in the validator and stay put on the wire (SC-101).
 *
 * `config.ts` deliberately does **not** import this module: the dependency
 * runs one way, projection ← declaration, which is what keeps the pair free of
 * a cycle and the validator free of wire concerns.
 */

import { DEFAULT_CONFIG, LOG_LEVEL_VALUES, NUMERIC_BOUNDS } from './config.ts';
import { EXPECTED_AGENT_RULE } from './config-agent.ts';
import type { LogLevel } from './log.ts';
import type { ServiceConfig } from './config.ts';

/** Every documented field name — the exhaustiveness source for {@link TAKE_EFFECT}. */
export type ServiceConfigField = keyof ServiceConfig;

/**
 * The closed take-effect vocabulary (006 FR-030).
 *
 * `restart` and `none` stay in the vocabulary because it is a wire contract
 * (FR-021) and removing a value would be a wire change; no field in this
 * feature declares either (FR-037).
 */
export type TakeEffect = 'immediate' | 'next-cycle' | 'next-dispatch' | 'restart' | 'none';

/** The class nine of 006's fields declare; named so the literal is written once. */
const NEXT_CYCLE = 'next-cycle';

/**
 * The class each documented field declares, projected onto the wire.
 *
 * `Record<ServiceConfigField, TakeEffect>` is exhaustive by construction
 * (plan D2): adding a member to `ServiceConfig` without declaring a class
 * fails `tsc --noEmit`, so "a field gained no consumer" cannot survive a
 * typecheck (006 SC-106). `leaseMs` and `resultDeadlineMs` are 003's fields
 * and are declared `next-cycle` by 006 under plan X1's count-dynamics rule.
 */
export const TAKE_EFFECT = {
    intervalMs: NEXT_CYCLE,
    overlapMs: NEXT_CYCLE,
    perPage: NEXT_CYCLE,
    retryMaxAttempts: NEXT_CYCLE,
    retryBaseMs: NEXT_CYCLE,
    retryMaxMs: NEXT_CYCLE,
    auditRetentionDays: NEXT_CYCLE,
    auditMaxEntries: NEXT_CYCLE,
    excerptRetentionDays: NEXT_CYCLE,
    leaseMs: NEXT_CYCLE,
    resultDeadlineMs: NEXT_CYCLE,
    logLevel: 'immediate',
    expectedAgent: 'next-dispatch',
} as const satisfies Record<ServiceConfigField, TakeEffect>;

/** A bounded numeric field, projected (006 FR-021). */
export interface IntegerFieldDescriptor {
    /** Documented key. */
    readonly name: keyof typeof NUMERIC_BOUNDS;
    /** Closed kind discriminator. */
    readonly kind: 'integer';
    /** Unit of the range, from the bounds table. */
    readonly unit: string;
    /** Inclusive lower bound. */
    readonly min: number;
    /** Inclusive upper bound. */
    readonly max: number;
    /** Documented default. */
    readonly default: number;
    /** Declared take-effect class. */
    readonly takesEffect: TakeEffect;
}

/** A closed enum field, projected (006 FR-021). */
export interface EnumFieldDescriptor {
    /** Documented key. */
    readonly name: 'logLevel';
    /** Closed kind discriminator. */
    readonly kind: 'enum';
    /** An enum has no unit; none may be fabricated (FR-014, FR-021). */
    readonly unit: null;
    /** Accepted values, verbatim. */
    readonly values: readonly LogLevel[];
    /** Documented default. */
    readonly default: LogLevel;
    /** Declared take-effect class. */
    readonly takesEffect: TakeEffect;
}

/** The one string field, projected (006 FR-100). */
export interface StringFieldDescriptor {
    /** Documented key. */
    readonly name: 'expectedAgent';
    /** Closed kind discriminator. */
    readonly kind: 'string';
    /** A string has no unit; none may be fabricated (FR-014, FR-021). */
    readonly unit: null;
    /** Service-authored prose describing the allowed characters, rendered as text only. */
    readonly format: string;
    /** Length ceiling in characters. */
    readonly maxLength: number;
    /** Documented default. */
    readonly default: string;
    /** Declared take-effect class. */
    readonly takesEffect: TakeEffect;
}

/**
 * One projected field — a closed discriminated union on `kind` (contract §2).
 *
 * The panel's parser refuses anything outside this union rather than guessing
 * (FR-021), and a `string` entry carries no `unit` and no numeric bound.
 */
export type FieldDescriptor = IntegerFieldDescriptor | EnumFieldDescriptor | StringFieldDescriptor;

/**
 * Project the declaration onto the wire.
 *
 * Descriptor order equals `collectIssues` order — both walk the bounds table
 * in its own key order, then `logLevel`, then `expectedAgent` — so the panel's
 * rows and a refusal's issue list share one order (AC-107).
 *
 * @returns One descriptor per documented field, in declaration order.
 */
export function configSchema(): readonly FieldDescriptor[] {
    const numericFields = Object.keys(NUMERIC_BOUNDS) as readonly (keyof typeof NUMERIC_BOUNDS)[];
    const descriptors: FieldDescriptor[] = numericFields.map((field) => ({
        name: field,
        kind: 'integer',
        unit: NUMERIC_BOUNDS[field].unit,
        min: NUMERIC_BOUNDS[field].min,
        max: NUMERIC_BOUNDS[field].max,
        default: DEFAULT_CONFIG[field],
        takesEffect: TAKE_EFFECT[field],
    }));

    descriptors.push({
        name: 'logLevel',
        kind: 'enum',
        unit: null,
        values: LOG_LEVEL_VALUES,
        default: DEFAULT_CONFIG.logLevel,
        takesEffect: TAKE_EFFECT.logLevel,
    });
    descriptors.push({
        name: 'expectedAgent',
        kind: 'string',
        unit: null,
        format: EXPECTED_AGENT_RULE.format,
        maxLength: EXPECTED_AGENT_RULE.maxLength,
        default: DEFAULT_CONFIG.expectedAgent,
        takesEffect: TAKE_EFFECT.expectedAgent,
    });

    return descriptors;
}
