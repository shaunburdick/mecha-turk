/**
 * Service configuration: the operator-tunable polling, retry, and retention
 * knobs, validated with field-level remediation.
 *
 * Four decisions are not visible from the code:
 *
 * - **Validation is additive-reporting.** Every bad field is collected in one
 *   pass so `PUT /v1/config` can answer 422 with a complete list instead of
 *   failing one field at a time, and remediation names the field and its
 *   accepted range without ever echoing the submitted value — "list field +
 *   remediation, never values that could be secret".
 * - **`PUT` is a full replacement**: the body must be a complete
 *   `ServiceConfig` with no unknown keys, so a typo'd or hand-invented field is
 *   refused rather than silently ignored.
 * - **The read is more forgiving in exactly one direction.** A document
 *   written before a field existed takes that field's default instead of being
 *   quarantined, because a strict read would set aside every configuration an
 *   operator already had. An unknown key, a bad value, or a non-object still
 *   quarantines.
 * - **The automatic requeue budget is deliberately not a field here.** That
 *   decision is recorded in 006's `## Deferred`, and the bound lives in the run
 *   store as a module constant.
 */

import { findSecretLeak } from '../src/redaction.ts';
import { expectedAgentIssue } from './config-agent.ts';
import { startingPromptIssue } from './config-prompt.ts';
import { truncatedFieldName } from './http.ts';
import { isRecord } from './json.ts';
import { validateStartingPrompt } from './prompt.ts';
import type { JsonReadResult } from './store/index.ts';
import type { LogLevel, ServiceLogger } from './log.ts';

/** Store file this configuration is persisted to. */
export const CONFIG_FILE = 'config.json';

/**
 * Every log level the service accepts, in increasing severity.
 *
 * The ordered tuple is the single declaration of *which* levels exist;
 * {@link LOG_LEVELS} is derived from it for membership tests and
 * {@link configSchema} projects it as an enum descriptor's `values`, so a
 * level added here changes the validator and the wire together.
 *
 * Exported for one reader besides the projection: the Settings-tab cross-check
 * (`tests/settings-rows.test.ts`) asserts the panel's row declaration matches
 * the service's own enum set, so a level added here fails the build instead of
 * printing a stale set to the operator.
 */
export const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

/** Membership view of {@link LOG_LEVEL_VALUES}, used by the validator. */
export const LOG_LEVELS = new Set<string>(LOG_LEVEL_VALUES);

/** Validated, fully-populated service configuration. */
export interface ServiceConfig {
    /** Poll cadence per stream; the spec's default interval. */
    readonly intervalMs: number;
    /** Look-back window re-scanned on resume, so a restart never misses work. */
    readonly overlapMs: number;
    /** GitHub `per_page`; the platform truncates larger values. */
    readonly perPage: number;
    /** Attempts per failed request before the stream is marked blocked. */
    readonly retryMaxAttempts: number;
    /** First backoff delay; grows exponentially with jitter up to the max. */
    readonly retryBaseMs: number;
    /** Ceiling for a single backoff delay. */
    readonly retryMaxMs: number;
    /** How long audit entries are kept, in days. */
    readonly auditRetentionDays: number;
    /** Hard cap on audit entries, whichever retention limit trips first. */
    readonly auditMaxEntries: number;
    /** How long payload excerpts are kept, in days. */
    readonly excerptRetentionDays: number;
    /**
     * How long a claim's lease is valid.
     *
     * The claim stamps `expiresAt = now + leaseMs` on the service clock, and
     * the sweep requeues a run whose lease expired with no reservation. Also
     * halves into the sweep cadence.
     */
    readonly leaseMs: number;
    /**
     * How long an authorized attempt has to report its result.
     *
     * `starting` runs past this deadline become `unconfirmed`; the value is
     * armed onto the run at reservation time, not read at the deadline.
     */
    readonly resultDeadlineMs: number;
    /** Structured-log verbosity. */
    readonly logLevel: LogLevel;
    /**
     * Comparison baseline the observed agent is evaluated against after every
     * dispatch.
     *
     * The service only serves it — `GET /v1/config` hands the value to the
     * panel, which posts it with each verification read-back. The value is a
     * single token (never credential-shaped), trimmed on write, and **empty is
     * a first-class value**: it is the documented *no baseline configured*
     * state, in which verification records the observed agent and compares
     * nothing. The documented default is the empty string, so a fresh store
     * starts with no baseline rather than presuming one.
     */
    readonly expectedAgent: string;
    /**
     * The **global tier** of the layered starting prompt.
     *
     * The service serves it through the document `GET /v1/config` already
     * returns and refuses it through the single validator every tier shares:
     * `collectIssues` routes the member through
     * {@link startingPromptIssue}, whose only rule is
     * {@link validateStartingPrompt}, so a whole-document `PUT` answers the
     * same additive `422` — `field: 'startingPrompt'`, a remediation, and
     * **never a character of the submission** — as any other field.
     *
     * The **empty string is the documented default and means *unset***: an
     * operator who has not chosen a global instruction has none, and the
     * stored read fills a document predating the member with that blank
     * rather than quarantining it, reporting the fill in `defaultsApplied` as
     * a default, never as a configured value.
     */
    readonly startingPrompt: string;
}

/** One rejected field with the action that would fix it. */
export interface ConfigIssue {
    /** Field name as it should appear in the UI (secret-shaped names withheld). */
    readonly field: string;
    /** Actionable instruction; never echoes what the operator submitted. */
    readonly remediation: string;
}

/** Result of validating a candidate configuration document. */
export type ConfigValidation =
    | { readonly ok: true; readonly config: ServiceConfig }
    | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

/** Inclusive bounds of one numeric field, with the unit its range is in. */
export interface NumericBounds {
    readonly min: number;
    readonly max: number;
    readonly unit: string;
}

/**
 * Bounds for every numeric field; the validation messages read from here.
 *
 * Exported for one reader only: the Settings-tab cross-check
 * (`tests/settings-rows.test.ts`) pins the panel's row declaration to these
 * bounds and units, so a bound changed here fails the build instead of
 * printing a stale number to the operator.
 */
export const NUMERIC_BOUNDS = {
    intervalMs: { min: 15_000, max: 300_000, unit: 'milliseconds' },
    overlapMs: { min: 60_000, max: 7_200_000, unit: 'milliseconds' },
    perPage: { min: 1, max: 30, unit: 'items per page' },
    retryMaxAttempts: { min: 1, max: 10, unit: 'attempts' },
    retryBaseMs: { min: 1_000, max: 60_000, unit: 'milliseconds' },
    retryMaxMs: { min: 5_000, max: 300_000, unit: 'milliseconds' },
    auditRetentionDays: { min: 7, max: 3_650, unit: 'days' },
    auditMaxEntries: { min: 1_000, max: 1_000_000, unit: 'entries' },
    excerptRetentionDays: { min: 1, max: 365, unit: 'days' },
    leaseMs: { min: 30_000, max: 600_000, unit: 'milliseconds' },
    resultDeadlineMs: { min: 30_000, max: 600_000, unit: 'milliseconds' },
} as const satisfies Record<string, NumericBounds>;

/** One of the numeric fields above. */
type NumericField = keyof typeof NUMERIC_BOUNDS;

/** Numeric fields, derived so the list can never drift from the bounds. */
const NUMERIC_FIELDS = Object.keys(NUMERIC_BOUNDS) as readonly NumericField[];

/** The configuration a fresh store starts with. */
export const DEFAULT_CONFIG: ServiceConfig = {
    // First member: the global prompt tier, by product-owner ruling ("move it to
    // the top of the list"). This key order *is* the declaration order —
    // `parseStoredConfig` reports fills in it, and `configSchema()` and
    // `collectIssues` both mirror it.
    // Blank, not a placeholder: empty **is** the documented *unset* state of
    // the global prompt tier, and a document written before the field existed
    // is filled with exactly this value, never with invented instruction text.
    startingPrompt: '',
    intervalMs: 60_000,
    overlapMs: 600_000,
    perPage: 30,
    retryMaxAttempts: 5,
    retryBaseMs: 5_000,
    retryMaxMs: 60_000,
    auditRetentionDays: 180,
    auditMaxEntries: 50_000,
    excerptRetentionDays: 30,
    leaseMs: 120_000,
    resultDeadlineMs: 120_000,
    logLevel: 'info',
    // Blank, not a name: the documented default is *no baseline configured*
    // — "not everyone is going to use project-manager".
    expectedAgent: '',
};

/**
 * Narrow a value to a supported log level.
 *
 * @returns `true` for `debug`, `info`, `warn`, or `error`.
 */
function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && LOG_LEVELS.has(value);
}

/**
 * Check one numeric field against its bounds.
 *
 * @returns Zero or one issue; an out-of-bounds, fractional, or missing value
 *   all produce the same actionable remediation.
 */
function numericIssue(raw: Record<string, unknown>, field: NumericField): readonly ConfigIssue[] {
    const bounds = NUMERIC_BOUNDS[field];
    const value = raw[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max) {
        return [];
    }

    return [
        {
            field,
            remediation: `set ${field} to an integer between ${bounds.min} and ${bounds.max} ${bounds.unit}`,
        },
    ];
}

/**
 * Check the one relationship that spans two fields.
 *
 * @returns An issue when the retry ceiling sits below the retry base.
 */
function retryOrderIssue(raw: Record<string, unknown>): readonly ConfigIssue[] {
    const base = raw.retryBaseMs;
    const ceiling = raw.retryMaxMs;
    if (typeof base === 'number' && typeof ceiling === 'number' && base > ceiling) {
        return [
            {
                field: 'retryMaxMs',
                remediation: 'set retryMaxMs to a value greater than or equal to retryBaseMs',
            },
        ];
    }

    return [];
}

/**
 * Report a field the configuration does not define.
 *
 * The name is echoed only when it looks like an ordinary identifier: a
 * secret-shaped key (a pasted token used as a field name, say) is replaced
 * with `<withheld>` so a 422 can never become a token-reflection oracle.
 *
 * @returns The issue describing the removal.
 */
function unknownFieldIssue(key: string): ConfigIssue {
    if (findSecretLeak(key) !== null) {
        return {
            field: '<withheld>',
            remediation: 'remove this key; only the documented ServiceConfig fields are accepted',
        };
    }

    return {
        field: truncatedFieldName(key),
        remediation: 'remove this key; only the documented ServiceConfig fields are accepted',
    };
}

/**
 * Recognise a defined configuration field.
 *
 * The documented field set *is* the default document's key set, so a field
 * cannot be declared in one place and forgotten here: one declaration, read
 * twice.
 *
 * @returns `true` for any key {@link DEFAULT_CONFIG} carries.
 */
function isKnownField(key: string): boolean {
    return Object.hasOwn(DEFAULT_CONFIG, key);
}

/**
 * Collect every problem with a candidate document in one pass.
 *
 * @returns All issues, in field order followed by unknown keys.
 */
function collectIssues(raw: Record<string, unknown>): readonly ConfigIssue[] {
    // First, mirroring `DEFAULT_CONFIG`'s own key order, so this list stays
    // the order the schema projection pushes its descriptors in. No numeric
    // validator moved: the bounds loop below is untouched.
    const issues: ConfigIssue[] = [...startingPromptIssue(raw.startingPrompt)];
    for (const field of NUMERIC_FIELDS) {
        issues.push(...numericIssue(raw, field));
    }

    if (!isLogLevel(raw.logLevel)) {
        issues.push({
            field: 'logLevel',
            remediation: 'set logLevel to one of debug, info, warn, error',
        });
    }

    issues.push(...expectedAgentIssue(raw.expectedAgent), ...retryOrderIssue(raw));
    for (const key of Object.keys(raw)) {
        if (!isKnownField(key)) {
            issues.push(unknownFieldIssue(key));
        }
    }

    return issues;
}

/**
 * Read one validated numeric field.
 *
 * @returns The stored value.
 * @throws {TypeError} When the value is missing — unreachable: validation runs
 *   first, and this guard exists so a future refactor cannot build a config
 *   from an unchecked document.
 */
function readNumber(raw: Record<string, unknown>, field: NumericField): number {
    const value = raw[field];
    if (typeof value !== 'number') {
        throw new TypeError(`validated configuration is missing ${field}`);
    }

    return value;
}

/**
 * Read the validated log level.
 *
 * @returns The stored level.
 * @throws {Error} When the value is missing; see {@link readNumber}.
 */
function readLogLevel(raw: Record<string, unknown>): LogLevel {
    const value = raw.logLevel;
    if (!isLogLevel(value)) {
        throw new Error('validated configuration is missing logLevel');
    }

    return value;
}

/**
 * Read the validated agent name.
 *
 * The stored value is the **trimmed** one, so a save/load round trip is
 * stable and the audit `from`/`to` pair records the value as it stands.
 *
 * @returns The stored baseline.
 * @throws {Error} When the value is missing; see {@link readNumber}.
 */
function readExpectedAgent(raw: Record<string, unknown>): string {
    const value = raw.expectedAgent;
    if (typeof value !== 'string') {
        throw new TypeError('validated configuration is missing expectedAgent');
    }

    return value.trim();
}

/**
 * Read the validated global prompt tier.
 *
 * The stored value is the **normalised** text the validator produced — outer
 * trim and line-ending normalisation applied — so a save/load round trip is
 * stable, exactly like `expectedAgent`'s trimmed value, and *unset* is stored as
 * the empty string the document declares as its default. The validator is
 * re-run rather than a second trimming rule being written here: one rule set at
 * three save boundaries means the read cannot disagree with the write about
 * what the text is.
 *
 * @returns The stored text, `''` when the tier is unset.
 * @throws {Error} When the value is unusable; see {@link readNumber}.
 */
function readStartingPrompt(raw: Record<string, unknown>): string {
    const verdict = validateStartingPrompt(raw.startingPrompt);
    if (!verdict.ok) {
        throw new Error('validated configuration is missing startingPrompt');
    }

    return verdict.prompt ?? '';
}

/**
 * Assemble the typed configuration once every field has been checked.
 *
 * @returns The validated configuration.
 */
function buildConfig(raw: Record<string, unknown>): ServiceConfig {
    return {
        intervalMs: readNumber(raw, 'intervalMs'),
        overlapMs: readNumber(raw, 'overlapMs'),
        perPage: readNumber(raw, 'perPage'),
        retryMaxAttempts: readNumber(raw, 'retryMaxAttempts'),
        retryBaseMs: readNumber(raw, 'retryBaseMs'),
        retryMaxMs: readNumber(raw, 'retryMaxMs'),
        auditRetentionDays: readNumber(raw, 'auditRetentionDays'),
        auditMaxEntries: readNumber(raw, 'auditMaxEntries'),
        excerptRetentionDays: readNumber(raw, 'excerptRetentionDays'),
        leaseMs: readNumber(raw, 'leaseMs'),
        resultDeadlineMs: readNumber(raw, 'resultDeadlineMs'),
        logLevel: readLogLevel(raw),
        expectedAgent: readExpectedAgent(raw),
        startingPrompt: readStartingPrompt(raw),
    };
}

/**
 * Validate a candidate configuration document.
 *
 * @returns The typed config, or every issue found (never just the first).
 */
export function validateConfig(raw: unknown): ConfigValidation {
    if (!isRecord(raw)) {
        return {
            ok: false,
            issues: [{ field: 'body', remediation: 'send a JSON object holding the full ServiceConfig' }],
        };
    }

    const issues = collectIssues(raw);
    if (issues.length > 0) {
        return { ok: false, issues };
    }

    return { ok: true, config: buildConfig(raw) };
}

/** One read of the stored document: the parsed config plus its provenance. */
export interface StoredConfigRead {
    /** The document, with every documented key it lacked filled in. */
    readonly config: ServiceConfig;
    /** Documented keys this read filled from {@link DEFAULT_CONFIG}, in declaration order. */
    readonly defaultsApplied: readonly string[];
}

/** Where a resolved configuration came from — the contract's `source` member. */
export type ConfigSource = 'stored' | 'default' | 'quarantined';

/** One resolved store read: the effective document and its provenance. */
export interface ConfigRead {
    /** The document the caller should treat as effective. */
    readonly config: ServiceConfig;
    /** Which read produced it; `default` and `quarantined` both serve defaults. */
    readonly source: ConfigSource;
    /** Documented keys the stored file lacked; always `[]` unless `source` is `stored`. */
    readonly defaultsApplied: readonly string[];
}

/**
 * Store-side validator: accept a valid document, filling every documented key
 * the file predates.
 *
 * A hand-edited `config.json` that fails validation is quarantined by the
 * store (never fail-stuck) and the service answers with defaults until the
 * operator PUTs a valid document. A document that is merely *older* than this
 * build must not be treated that way: a missing **documented** key is filled
 * from {@link DEFAULT_CONFIG} and reported, so schema evolution never costs an
 * operator their other values — while an unknown key, a bad value, or a
 * non-object still quarantines exactly as before.
 *
 * The write path is deliberately stricter: `PUT` stays a full replacement, so
 * a body missing a field is a refusal with a remediation, never a silent
 * default.
 *
 * @returns The typed config plus the keys this read filled, or `null` to
 *   trigger quarantine.
 */
export function parseStoredConfig(raw: unknown): StoredConfigRead | null {
    if (!isRecord(raw)) {
        return null;
    }

    const filled = { ...raw };
    const defaultsApplied: string[] = [];
    for (const field of Object.keys(DEFAULT_CONFIG) as readonly (keyof ServiceConfig)[]) {
        if (Object.hasOwn(filled, field)) {
            continue;
        }

        filled[field] = DEFAULT_CONFIG[field];
        defaultsApplied.push(field);
    }

    const validation = validateConfig(filled);

    return validation.ok ? { config: validation.config, defaultsApplied } : null;
}

/**
 * Resolve the effective configuration from a store read.
 *
 * The three answers the contract's `source` member distinguishes come out of
 * the read itself, so the quarantine fact reaches the panel without a second
 * read.
 *
 * @returns The effective document, where it came from, and which documented
 *   keys this read filled (always `[]` unless `source` is `stored`).
 */
export function configFromStore(result: JsonReadResult<StoredConfigRead>, log: ServiceLogger): ConfigRead {
    if (result.status === 'ok') {
        return {
            config: result.value.config,
            source: 'stored',
            defaultsApplied: result.value.defaultsApplied,
        };
    }

    if (result.status === 'quarantined') {
        log.warn('stored configuration was unusable and has been set aside', {
            quarantinePath: result.quarantinePath,
        });

        return { config: DEFAULT_CONFIG, source: 'quarantined', defaultsApplied: [] };
    }

    return { config: DEFAULT_CONFIG, source: 'default', defaultsApplied: [] };
}

/**
 * Build the contract's 422 response for a list of field issues.
 *
 * The implementation lives with the other transport-level response builders
 * in `http.ts` (it is the envelope every validation failure uses, not a
 * configuration concern); it is re-exported here so configuration consumers
 * keep a single import site.
 */
export { validationResponse } from './http.ts';
