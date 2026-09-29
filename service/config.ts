/**
 * Service configuration: the operator-tunable polling, retry, and retention
 * knobs, validated with field-level remediation.
 *
 * The bounds come from the spec and plan (FR-017 interval 15,000–300,000 ms
 * default 60,000; overlap 1–120 min default 10 min; FR-020 `per_page ≤ 30`;
 * retention defaults from the spec's Configuration Model; FR-031's lease and
 * result deadline 30,000–600,000 ms, default 120,000 — T-008). Validation is
 * deliberately *additive-reporting*: every bad field is collected in one pass
 * so `PUT /v1/config` can answer 422 with a complete list instead of failing
 * one field at a time, and remediation names the field and its accepted
 * range without ever echoing the submitted value (contract §2.1/FR-039 —
 * "list field + remediation, never values that could be secret").
 *
 * `PUT` is a full replacement: the body must be a complete `ServiceConfig`
 * with no unknown keys, so a typo'd or hand-invented field is refused rather
 * than silently ignored. The *read* is deliberately more forgiving in exactly
 * one direction — a document written before a field existed takes that
 * field's default instead of being quarantined (T-008) — because a strict read
 * would set aside every configuration an operator already had.
 *
 * The automatic requeue budget is deliberately **not** a field here: 003
 * v1.3.0 and 006's `## Deferred` record that decision, and the bound lives in
 * the run store as a module constant.
 */

import { findSecretLeak } from '../src/redaction.ts';
import { isRecord } from './json.ts';
import type { JsonReadResult } from './store/index.ts';
import type { LogLevel, ServiceLogger } from './log.ts';

/** Store file this configuration is persisted to. */
export const CONFIG_FILE = 'config.json';

/** Longest unknown field name echoed back before it is elided. */
const MAX_ECHOED_FIELD_CHARS = 64;

/** Every log level the service accepts, in increasing severity. */
const LOG_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

/** Validated, fully-populated service configuration. */
export interface ServiceConfig {
    /** Poll cadence per stream; the spec's default interval. */
    readonly intervalMs: number;
    /** Look-back window re-scanned on resume, so a restart never misses work. */
    readonly overlapMs: number;
    /** GitHub `per_page`; the platform truncates larger values (FR-020). */
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
     * How long a claim's lease is valid (FR-031, plan D9).
     *
     * The claim stamps `expiresAt = now + leaseMs` on the service clock, and
     * the sweep requeues a run whose lease expired with no reservation. Also
     * halves into the sweep cadence.
     */
    readonly leaseMs: number;
    /**
     * How long an authorized attempt has to report its result (FR-023, plan D9).
     *
     * `starting` runs past this deadline become `unconfirmed`; the value is
     * armed onto the run at reservation time, not read at the deadline.
     */
    readonly resultDeadlineMs: number;
    /** Structured-log verbosity. */
    readonly logLevel: LogLevel;
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
interface NumericBounds {
    readonly min: number;
    readonly max: number;
    readonly unit: string;
}

/** Bounds for every numeric field; the validation messages read from here. */
const NUMERIC_BOUNDS = {
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
};

/**
 * Fields this feature added to a configuration a build without them wrote.
 *
 * The read path fills these in rather than demanding them, because the
 * alternative is worse than useless: a strict read would quarantine every
 * `config.json` an operator already has the moment this build starts, and the
 * store answers a quarantined file with the defaults anyway (T-008). The
 * write path stays strict — `PUT` is a full replacement, so a body missing a
 * field is a refusal with a remediation, not a silent default.
 */
const ADDED_AFTER_FIRST_RELEASE = {
    leaseMs: DEFAULT_CONFIG.leaseMs,
    resultDeadlineMs: DEFAULT_CONFIG.resultDeadlineMs,
} as const satisfies Partial<ServiceConfig>;

/**
 * Narrow a value to a supported log level.
 *
 * @param value - Candidate value.
 * @returns `true` for `debug`, `info`, `warn`, or `error`.
 */
function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && LOG_LEVELS.has(value);
}

/**
 * Check one numeric field against its bounds.
 *
 * @param raw - Candidate document.
 * @param field - Field to check.
 * @returns Zero or one issue; an out-of-bounds, fractional, or missing value
 *   all produce the same actionable remediation.
 */
function numericIssue(raw: Record<string, unknown>, field: NumericField): readonly ConfigIssue[] {
    const bounds = NUMERIC_BOUNDS[field];
    const value = raw[field];
    if (typeof value === 'number' && Number.isInteger(value) && value >= bounds.min && value <= bounds.max) {
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
 * @param raw - Candidate document.
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
 * @param key - Unknown key from the request body.
 * @returns The issue describing the removal.
 */
function unknownFieldIssue(key: string): ConfigIssue {
    if (findSecretLeak(key) !== null) {
        return {
            field: '<withheld>',
            remediation: 'remove this key; only the documented ServiceConfig fields are accepted',
        };
    }

    const name = key.length > MAX_ECHOED_FIELD_CHARS ? `${key.slice(0, MAX_ECHOED_FIELD_CHARS)}…` : key;

    return {
        field: name,
        remediation: 'remove this key; only the documented ServiceConfig fields are accepted',
    };
}

/**
 * Recognise a defined configuration field.
 *
 * @param key - Key from the request body.
 * @returns `true` for `logLevel` or any numeric field above.
 */
function isKnownField(key: string): boolean {
    return key === 'logLevel' || Object.hasOwn(NUMERIC_BOUNDS, key);
}

/**
 * Collect every problem with a candidate document in one pass.
 *
 * @param raw - Candidate document, already known to be an object.
 * @returns All issues, in field order followed by unknown keys.
 */
function collectIssues(raw: Record<string, unknown>): readonly ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    for (const field of NUMERIC_FIELDS) {
        issues.push(...numericIssue(raw, field));
    }

    if (!isLogLevel(raw.logLevel)) {
        issues.push({
            field: 'logLevel',
            remediation: 'set logLevel to one of debug, info, warn, error',
        });
    }

    issues.push(...retryOrderIssue(raw));
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
 * @param raw - Document that already passed {@link validateConfig}.
 * @param field - Field to read.
 * @returns The stored value.
 * @throws {Error} When the value is missing — unreachable: validation runs
 *   first, and this guard exists so a future refactor cannot build a config
 *   from an unchecked document.
 */
function readNumber(raw: Record<string, unknown>, field: NumericField): number {
    const value = raw[field];
    if (typeof value !== 'number') {
        throw new Error(`validated configuration is missing ${field}`);
    }

    return value;
}

/**
 * Read the validated log level.
 *
 * @param raw - Document that already passed {@link validateConfig}.
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
 * Assemble the typed configuration once every field has been checked.
 *
 * @param raw - Document that produced no issues.
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
    };
}

/**
 * Validate a candidate configuration document.
 *
 * @param raw - Parsed request body or stored document.
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

/**
 * Store-side validator: accept a valid document, filling fields this build
 * added after the file was written.
 *
 * A hand-edited `config.json` that fails validation is quarantined by the
 * store (never fail-stuck) and the service answers with defaults until the
 * operator PUTs a valid document. A document that is merely *older* than this
 * build must not be treated that way: only a field that is present and
 * unusable refuses, so an unknown key, a bad value, or a non-object still
 * quarantines exactly as before (T-008).
 *
 * @param raw - Parsed stored document.
 * @returns The typed config, or `null` to trigger quarantine.
 */
export function parseStoredConfig(raw: unknown): ServiceConfig | null {
    if (!isRecord(raw)) {
        return null;
    }

    const filled: Record<string, unknown> = { ...raw };
    for (const [field, fallback] of Object.entries(ADDED_AFTER_FIRST_RELEASE)) {
        if (!(field in filled)) {
            filled[field] = fallback;
        }
    }

    const validation = validateConfig(filled);

    return validation.ok ? validation.config : null;
}

/**
 * Resolve the effective configuration from a store read.
 *
 * @param result - Outcome of reading `config.json`.
 * @param log - Logger used when a stored document had to be set aside.
 * @returns The stored configuration, or the defaults.
 */
export function configFromStore(result: JsonReadResult<ServiceConfig>, log: ServiceLogger): ServiceConfig {
    if (result.status === 'ok') {
        return result.value;
    }

    if (result.status === 'quarantined') {
        log.warn('stored configuration was unusable and has been set aside', {
            quarantinePath: result.quarantinePath,
        });
    }

    return DEFAULT_CONFIG;
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
