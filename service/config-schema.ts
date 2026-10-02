/**
 * The configuration's **schema projection**: the declaration `config.ts`
 * holds, projected onto the wire (006 FR-020 – FR-022, contract §2).
 *
 * This module exists to keep `config.ts` inside the file-length gate while
 * preserving the property that matters: there is still exactly **one**
 * declaration. Every descriptor below is built from `NUMERIC_BOUNDS`,
 * `LOG_LEVEL_VALUES`, `EXPECTED_AGENT_RULE`, `DEFAULT_CONFIG`, and the
 * prompt tier's cap constant — the same objects `validateConfig` and
 * `validateStartingPrompt` read — plus `TAKE_EFFECT`, the exhaustive class
 * table. Nothing here restates a bound, a default, or an accepted value, so a
 * number cannot move in the validator and stay put on the wire (SC-101).
 * The one member that is prose rather than projection is `startingPrompt`'s
 * `format`: the guidance an operator needs about that field is part of the
 * field (004 FR-063), and research **R-4** places it in this declaration
 * rather than in a panel-authored helper — its cap is still the validator's
 * own constant, never a retyped number.
 *
 * `config.ts` deliberately does **not** import this module: the dependency
 * runs one way, projection ← declaration, which is what keeps the pair free of
 * a cycle and the validator free of wire concerns.
 */

import { DEFAULT_CONFIG, LOG_LEVEL_VALUES, NUMERIC_BOUNDS } from './config.ts';
import { EXPECTED_AGENT_RULE } from './config-agent.ts';
import { STARTING_PROMPT_MAX_CODE_POINTS } from './prompt.ts';
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

/** The class ten of 006's fields declare; named so the literal is written once. */
const NEXT_CYCLE = 'next-cycle';

/**
 * The class each documented field declares, projected onto the wire.
 *
 * `Record<ServiceConfigField, TakeEffect>` is exhaustive by construction
 * (plan D2): adding a member to `ServiceConfig` without declaring a class
 * fails `tsc --noEmit`, so "a field gained no consumer" cannot survive a
 * typecheck (006 SC-106). `leaseMs` and `resultDeadlineMs` are 003's fields
 * and are declared `next-cycle` by 006 under plan X1's count-dynamics rule.
 *
 * `startingPrompt` is 004's global prompt tier (004 FR-081): the poll loop
 * re-reads configuration once per cycle and the snapshot resolves at
 * detection, so a save is in force for events detected from the next cycle
 * on, while a queued run keeps the snapshot it was queued with.
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

/**
 * A free-text field, projected (006 FR-100, FR-100's second string field at
 * 004 v1.3.0: `startingPrompt`, 004 FR-081).
 *
 * The name is a closed union of the two string members `ServiceConfig`
 * carries: the projection cannot grow a third string row without widening
 * this type, and the panel's parser meets only names the service declared.
 */
export interface StringFieldDescriptor {
    /** Documented key. */
    readonly name: 'expectedAgent' | 'startingPrompt';
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
 * The global prompt tier's **format** prose (004 FR-081, FR-063, FR-089;
 * 006 FR-014, FR-021; research **R-4**, plan D23).
 *
 * The Settings row renders this text instead of a panel-authored helper: the
 * guidance an operator needs about a field is part of the field, and a
 * sentence typed into the panel would drift from the validator the moment
 * either moved (006 FR-014 — none of the row's copy from a value typed into
 * the panel).
 *
 * It carries FR-063's guidance in the operator's terms — sent to the agent
 * verbatim, no placeholders, a length cap, a credential-shaped value refused
 * rather than stored, and the pinned Default Agent this text cannot change —
 * beside this validator's own rules (trim, the cap, the three refusal shapes,
 * and empty meaning *unset*). The one number it quotes is interpolated from
 * {@link STARTING_PROMPT_MAX_CODE_POINTS}, so the cap cannot move in the
 * validator and stay put on the wire (006 SC-101).
 */
const STARTING_PROMPT_FORMAT = 'text sent to the agent verbatim, with no placeholders; '
    + `at most ${STARTING_PROMPT_MAX_CODE_POINTS} code points after trimming; `
    + 'credential-shaped, reserved-marker, and control characters refused rather than stored; '
    + 'empty means the global prompt tier is unset; the session still runs the pinned Default Agent, '
    + 'which this text cannot change';

/**
 * Project the declaration onto the wire.
 *
 * Descriptor order equals `collectIssues` order — both walk the bounds table
 * in its own key order, then `logLevel`, then `expectedAgent`, then
 * `startingPrompt` — so the panel's rows and a refusal's issue list share one
 * order (AC-107).
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
    // Twelfth field, pushed directly after `expectedAgent`: the order is the
    // validator's own (004 FR-081; 006 AC-107).
    descriptors.push({
        name: 'startingPrompt',
        kind: 'string',
        unit: null,
        format: STARTING_PROMPT_FORMAT,
        maxLength: STARTING_PROMPT_MAX_CODE_POINTS,
        default: DEFAULT_CONFIG.startingPrompt,
        takesEffect: TAKE_EFFECT.startingPrompt,
    });

    return descriptors;
}
