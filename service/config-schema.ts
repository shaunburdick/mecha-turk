/**
 * The configuration's schema projection: the declaration `config.ts`
 * holds, projected onto the wire (006 FR-020 – FR-022, contract §2).
 */

import { DEFAULT_CONFIG, LOG_LEVEL_VALUES, NUMERIC_BOUNDS } from './config.ts';
import { EXPECTED_AGENT_RULE } from './config-agent.ts';
import { STARTING_PROMPT_MAX_CODE_POINTS } from './prompt.ts';
import type { LogLevel } from './log.ts';
import type { ServiceConfig } from './config.ts';

/** Every documented field name — the exhaustiveness source for {@link TAKE_EFFECT}. */
export type ServiceConfigField = keyof ServiceConfig;

/**
 * The closed take-effect vocabulary.
 *
 * `restart` and `none` stay in the vocabulary because it is a wire contract
 * and removing a value would be a wire change; no field in this
 * feature declares either.
 */
export type TakeEffect = 'immediate' | 'next-cycle' | 'next-dispatch' | 'restart' | 'none';

/** The class ten of 006's fields declare; named so the literal is written once. */
const NEXT_CYCLE = 'next-cycle';

/**
 * The class each documented field declares, projected onto the wire.
 * `Record<ServiceConfigField, TakeEffect>` is exhaustive by construction, so
 * adding a member without declaring a class fails `tsc --noEmit` and *a
 * field gained no consumer* cannot survive a typecheck. `startingPrompt`
 * (004 FR-081) is in force for events detected from the next cycle on,
 * because the loop re-reads configuration once per cycle while a queued run
 * keeps the snapshot it was queued with.
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
    startingPrompt: NEXT_CYCLE,
} as const satisfies Record<ServiceConfigField, TakeEffect>;

/** A bounded numeric field, projected. */
export interface IntegerFieldDescriptor {
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
    readonly takesEffect: TakeEffect;
}

/** A closed enum field, projected. */
export interface EnumFieldDescriptor {
    readonly name: 'logLevel';
    /** Closed kind discriminator. */
    readonly kind: 'enum';
    /** An enum has no unit; none may be fabricated. */
    readonly unit: null;
    /** Accepted values, verbatim. */
    readonly values: readonly LogLevel[];
    /** Documented default. */
    readonly default: LogLevel;
    readonly takesEffect: TakeEffect;
}

/**
 * A free-text field, projected (006 FR-100, FR-100's second string field at
 * 004 v1.3.0: `startingPrompt`, 004 FR-081).
 *
 * The name is a closed union of the two string members `ServiceConfig`
 * carries: the projection cannot grow a third string row without widening
 * this type, and the panel's parser meets only names the service declared.
 */
export interface StringFieldDescriptor {
    readonly name: 'expectedAgent' | 'startingPrompt';
    /** Closed kind discriminator. */
    readonly kind: 'string';
    /** A string has no unit; none may be fabricated. */
    readonly unit: null;
    /** Service-authored prose describing the allowed characters, rendered as text only. */
    readonly format: string;
    /** Length ceiling in characters. */
    readonly maxLength: number;
    /** Documented default. */
    readonly default: string;
    readonly takesEffect: TakeEffect;
    /**
     * Present only when the value is prose written across several lines, so
     * the panel mounts a textarea instead of a one-line input (product-owner
     * UI ruling on PR #12). **Absent means single-line**, and `true` is the
     * only value this declaration ever emits, so every other value refuses the
     * envelope rather than being dropped — an affordance the panel half-reads
     * is a row it would render wrong (invariant 8). The control's height is
     * panel copy, not a bound.
     */
    readonly multiline?: true;
}

/**
 * One projected field — a closed discriminated union on `kind` (contract §2).
 *
 * The panel's parser refuses anything outside this union rather than guessing,
 * and a `string` entry carries no `unit` and no numeric bound.
 */
export type FieldDescriptor = IntegerFieldDescriptor | EnumFieldDescriptor | StringFieldDescriptor;

/**
 * The global prompt tier's **format** prose (004 FR-081, FR-063, FR-089;
 * 006 FR-014, FR-021; research R-4, plan D23). The Settings row renders this
 * instead of a panel-authored helper: guidance about a field belongs to the
 * field, and a sentence typed into the panel would drift from the validator
 * (006 FR-014). It carries FR-063's guidance in the operator's terms beside
 * this validator's own rules, and the one number it quotes is interpolated
 * from {@link STARTING_PROMPT_MAX_CODE_POINTS} so the cap cannot move in the
 * validator and stay put on the wire.
 */
const STARTING_PROMPT_FORMAT = 'text sent to the agent verbatim, with no placeholders; '
    + `at most ${STARTING_PROMPT_MAX_CODE_POINTS} code points after trimming; `
    + 'credential-shaped, reserved-marker, and control characters refused rather than stored; '
    + 'empty means the global prompt tier is unset; the session still runs the pinned Default Agent, '
    + 'which this text cannot change';

/**
 * Project the declaration onto the wire. Descriptor order equals
 * `Object.keys(DEFAULT_CONFIG)` and `collectIssues` order, so the panel's
 * rows and a refusal's issue list share one order; the prompt row leads by
 * product-owner ruling on PR #12, the numerics keep their relative order,
 * and no validator moved with it.
 */
export function configSchema(): readonly FieldDescriptor[] {
    const numericFields = Object.keys(NUMERIC_BOUNDS) as readonly (keyof typeof NUMERIC_BOUNDS)[];
    const descriptors: FieldDescriptor[] = [
        {
            // First field: 004's global prompt tier, ahead of every numeric one, so
            // this order stays `Object.keys(DEFAULT_CONFIG)` and `collectIssues`
            // order exactly (006 AC-107; product-owner ruling, PR #12). `multiline`
            // is declared here and nowhere else: an agent name is one line, an
            // instruction is a paragraph.
            name: 'startingPrompt',
            kind: 'string',
            unit: null,
            format: STARTING_PROMPT_FORMAT,
            maxLength: STARTING_PROMPT_MAX_CODE_POINTS,
            default: DEFAULT_CONFIG.startingPrompt,
            takesEffect: TAKE_EFFECT.startingPrompt,
            multiline: true,
        },
    ];

    for (const field of numericFields) {
        descriptors.push({
            name: field,
            kind: 'integer',
            unit: NUMERIC_BOUNDS[field].unit,
            min: NUMERIC_BOUNDS[field].min,
            max: NUMERIC_BOUNDS[field].max,
            default: DEFAULT_CONFIG[field],
            takesEffect: TAKE_EFFECT[field],
        });
    }

    descriptors.push({
        name: 'logLevel',
        kind: 'enum',
        unit: null,
        values: LOG_LEVEL_VALUES,
        default: DEFAULT_CONFIG.logLevel,
        takesEffect: TAKE_EFFECT.logLevel,
    }, {
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
