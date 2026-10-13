/**
 * Service configuration: the operator-tunable polling, retry, and
 * retention knobs, validated with field-level remediation.
 */

import { join } from 'node:path';

import { findSecretLeak } from '../src/redaction.ts';
import { expectedAgentIssue } from './config-agent.ts';
import { startingPromptIssue } from './config-prompt.ts';
import { truncatedFieldName } from './http.ts';
import { isRecord } from './json.ts';
import { validateStartingPrompt } from './prompt.ts';
import type { JsonReadResult, ServiceStore } from './store/index.ts';
import type { LogLevel, ServiceLogger } from './log.ts';

export const CONFIG_FILE = 'config.json';

/**
 * Every log level the service accepts, in increasing severity: the ordered
 * tuple is the single declaration of *which* levels exist, so a level added
 * here changes {@link LOG_LEVELS}, {@link configSchema} and the wire
 * together. It is exported for one reader besides the projection — the
 * Settings-tab cross-check (`tests/settings-rows.test.ts`) — so a level added
 * here fails the build instead of printing a stale set to the operator.
 */
export const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

export const LOG_LEVELS = new Set<string>(LOG_LEVEL_VALUES);

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
    readonly logLevel: LogLevel;
    /**
     * Comparison baseline the observed agent is evaluated against after every
     * dispatch. The service only serves it — `GET /v1/config` hands the value
     * to the panel, which posts it with each read-back. It is a single token
     * (never credential-shaped), trimmed on write, and **empty is a
     * first-class value**: the documented *no baseline configured* state, in
     * which verification records the observed agent and compares nothing. The
     * default is the empty string, so a fresh store starts with no baseline
     * rather than presuming one.
     */
    readonly expectedAgent: string;
    /**
     * The **global tier** of the layered starting prompt, served through the
     * document `GET /v1/config` already returns and refused through the single
     * validator every tier shares, so a whole-document `PUT` answers the same
     * additive `422` — a remediation and **never a character of the
     * submission**. The **empty string is the documented default and means
     * *unset***: a document predating the member is filled rather than
     * quarantined, reported in `defaultsApplied` as a default and never as a
     * configured value.
     */
    readonly startingPrompt: string;
}

export interface ConfigIssue {
    /** Field name as it should appear in the UI (secret-shaped names withheld). */
    readonly field: string;
    /** Actionable instruction; never echoes what the operator submitted. */
    readonly remediation: string;
}

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

type NumericField = keyof typeof NUMERIC_BOUNDS;

/** Numeric fields, derived so the list can never drift from the bounds. */
const NUMERIC_FIELDS = Object.keys(NUMERIC_BOUNDS) as readonly NumericField[];

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

function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === 'string' && LOG_LEVELS.has(value);
}

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
 * The documented field set *is* the default document's key set, so a field
 * cannot be declared in one place and forgotten here: one declaration, read
 * twice.
 */
function isKnownField(key: string): boolean {
    return Object.hasOwn(DEFAULT_CONFIG, key);
}

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

function readNumber(raw: Record<string, unknown>, field: NumericField): number {
    const value = raw[field];
    if (typeof value !== 'number') {
        throw new TypeError(`validated configuration is missing ${field}`);
    }

    return value;
}

function readLogLevel(raw: Record<string, unknown>): LogLevel {
    const value = raw.logLevel;
    if (!isLogLevel(value)) {
        throw new Error('validated configuration is missing logLevel');
    }

    return value;
}

/**
 * The stored value is the **trimmed** one, so a save/load round trip is
 * stable and the audit `from`/`to` pair records the value as it stands.
 */
function readExpectedAgent(raw: Record<string, unknown>): string {
    const value = raw.expectedAgent;
    if (typeof value !== 'string') {
        throw new TypeError('validated configuration is missing expectedAgent');
    }

    return value.trim();
}

/**
 * The stored value is the **normalised** text the validator produced — outer
 * trim and line-ending normalisation applied — so a save/load round trip is
 * stable, exactly like `expectedAgent`'s trimmed value, and *unset* is stored as
 * the empty string the document declares as its default. The validator is
 * re-run rather than a second trimming rule being written here: one rule set at
 * three save boundaries means the read cannot disagree with the write about
 * what the text is.
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

export interface StoredConfigRead {
    /** The document, with every documented key it lacked filled in. */
    readonly config: ServiceConfig;
    /** Documented keys this read filled from {@link DEFAULT_CONFIG}, in declaration order. */
    readonly defaultsApplied: readonly string[];
}

/** Where a resolved configuration came from — the contract's `source` member. */
export type ConfigSource = 'stored' | 'default' | 'quarantined';

export interface ConfigRead {
    /** The document the caller should treat as effective. */
    readonly config: ServiceConfig;
    /** Which read produced it; `default` and `quarantined` both serve defaults. */
    readonly source: ConfigSource;
    /** Documented keys the stored file lacked; always `[]` unless `source` is `stored`. */
    readonly defaultsApplied: readonly string[];
}

/**
 * Store-side validator: accept a valid document, filling every documented
 * key the file predates. A hand-edited document that fails validation is
 * quarantined and the service answers with defaults until the operator
 * PUTs a valid one; a document that is merely *older* must not be, so a
 * missing documented key is filled from {@link DEFAULT_CONFIG} and reported,
 * while an unknown key, a bad value or a non-object still quarantines
 * exactly as before. The write path is stricter: `PUT` stays a full
 * replacement, so a missing field is a refusal, never a silent default.
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
 * Prefix every quarantined copy of the configuration keeps. The store
 * renames an unusable document to `<CONFIG_FILE>.corrupt-<stamp>-<uuid>`
 * beside its target, so this prefix is the durable record of a set-aside
 * document — the same shape and spelling as the queue's evidence in
 * `service/poll/events.ts`. It is written out rather than imported so this
 * module keeps no runtime dependency on the store: the naming rule belongs
 * to whoever writes the file, and a reader only has to agree with it.
 */
const QUARANTINE_EVIDENCE_PREFIX = `${CONFIG_FILE}.corrupt-`;

/**
 * Names are `<target>.corrupt-<stamp>-<uuid>` and the stamp is a fixed-width
 * `Date.now()`, so sorting the names orders the quarantines chronologically and
 * the last one is the operator's most recent unusable document.
 *
 * @returns Absolute path of the newest quarantined copy, or `null` when the
 *   store has never set one aside.
 */
async function latestQuarantineEvidence(store: ServiceStore): Promise<string | null> {
    const entries = await store.listDir('.');
    const quarantined = entries
        .filter((entry) => entry.startsWith(QUARANTINE_EVIDENCE_PREFIX))
        .toSorted((left, right) => left.localeCompare(right));
    const newest = quarantined.at(-1);

    return newest === undefined ? null : join(store.dataDir, newest);
}

/**
 * Read the effective configuration, keeping a set-aside document a fact. A
 * quarantine **renames** the file, so every later reader finds nothing — and
 * answering `default` there would claim nothing was ever wrong, which the
 * contract's *invalid file ⇒ `quarantined`* rule refuses. The evidence left
 * beside the target stands in for the observation, so whichever reader
 * arrives first reports the same thing. Scoped to the one read whose
 * `source` is observable: the internal readers would cost a directory
 * listing and a warn line per cycle for nothing.
 */
export async function readStoredConfig(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<ConfigRead> {
    const result = await input.store.readJson(CONFIG_FILE, parseStoredConfig);
    if (result.status !== 'absent') {
        return configFromStore(result, input.log);
    }

    const evidence = await latestQuarantineEvidence(input.store);

    return configFromStore(
        evidence === null ? result : { status: 'quarantined', quarantinePath: evidence },
        input.log,
    );
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
