/**
 * Service configuration and status tests (task T-006).
 *
 * Validation is tested twice on purpose: against the model (every bound, the
 * unknown-field and secret-shaped-key rules, cross-field ordering, and the
 * no-value-echo guarantee) and over the real loopback API (defaults on a
 * fresh store, atomic PUT round-trip, 422 remediation lists, 400 for malformed
 * JSON, 503 when the data directory is unusable). `GET /v1/status` is asserted
 * against the contract's fixed shape, including its truthful wave-1 contents.
 *
 * Two string fields ride the same document and get a block each: the agent
 * baseline `expectedAgent` (006 FR-100) and the global prompt tier
 * `startingPrompt` (004 FR-081, task T-019), the latter sharing its rule with
 * the bindings and account save paths rather than restating it here.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import {
    DEFAULT_CONFIG,
    NUMERIC_BOUNDS,
    configFromStore,
    parseStoredConfig,
    validateConfig,
} from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { readServiceEnv } from '../service/env.ts';
import { createLogger } from '../service/log.ts';
import { STARTING_PROMPT_MAX_CODE_POINTS } from '../service/prompt.ts';
import { startService } from '../service/server.ts';
import { SERVICE_SCHEMA_VERSION } from '../service/store/index.ts';
import { findSecretLeak } from '../src/redaction.ts';
import { descriptorFor, parseConfigEnvelope } from '../src/settings-schema.ts';
import type { ServiceConfig } from '../service/config.ts';
import type { FieldDescriptor } from '../service/config-schema.ts';
import type { ServiceStatusBody } from '../service/routes/status.ts';
import { offlineVerifier } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Path of the configuration resource. */
const CONFIG_PATH = '/v1/config';

/** Field name referenced by several validation cases; one literal, one home. */
const INTERVAL_FIELD = 'intervalMs';

/** Name prefix a quarantined configuration file is renamed to. */
const CONFIG_FILE = 'config.json';
const CONFIG_QUARANTINE_PREFIX = `${CONFIG_FILE}.corrupt-`;

/** Path of the status resource. */
const STATUS_PATH = '/v1/status';

/** Path of the readiness probe, asserted alongside the degraded cases. */
const HEALTH_PATH = '/health';

/** Field name an operator might invent, which must be refused. */
const INVENTED_FIELD = 'pollInterval';

/** A token-shaped field name, which must never be echoed back. */
const TOKEN_FIELD = 'ghp_abcdefghijklmnop123456';

/** A value far outside every bound, used to prove nothing is echoed. */
const ABSURD_INTERVAL = 999_999_999;

/** The 422 envelope as `PUT /v1/config` returns it. */
interface ValidationBody {
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly issues: readonly { readonly field: string; readonly remediation: string }[];
    };
}

/** Candidate values that must each be refused, with the field that owns them. */
const OUT_OF_BOUNDS: readonly { readonly field: string; readonly value: number | string }[] = [
    { field: INTERVAL_FIELD, value: 14_999 },
    { field: INTERVAL_FIELD, value: 300_001 },
    { field: 'overlapMs', value: 30_000 },
    { field: 'perPage', value: 31 },
    { field: 'perPage', value: 30.5 },
    { field: 'retryMaxAttempts', value: 11 },
    { field: 'retryBaseMs', value: 999 },
    { field: 'retryMaxMs', value: 4_000 },
    { field: 'auditRetentionDays', value: 6 },
    { field: 'auditMaxEntries', value: 999 },
    { field: 'excerptRetentionDays', value: 366 },
    { field: 'leaseMs', value: 29_999 },
    { field: 'leaseMs', value: 600_001 },
    { field: 'resultDeadlineMs', value: 29_999 },
    { field: 'resultDeadlineMs', value: 600_001 },
    { field: 'logLevel', value: 'verbose' },
];

/** A configuration document written before the dispatch-run feature existed. */
const PRE_RUN_LAYER_CONFIG = {
    intervalMs: 30_000,
    overlapMs: 900_000,
    perPage: 25,
    retryMaxAttempts: 4,
    retryBaseMs: 4_000,
    retryMaxMs: 45_000,
    auditRetentionDays: 90,
    auditMaxEntries: 20_000,
    excerptRetentionDays: 14,
    logLevel: 'debug',
} as const;

/**
 * A document written after 003's lease knobs but before 006's field landed:
 * every documented key **except** `expectedAgent`.
 *
 * Derived from {@link DEFAULT_CONFIG} rather than retyped, so the fixture can
 * never claim to be "complete minus one" once a field is added.
 */
const PRE_AGENT_CONFIG: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(DEFAULT_CONFIG).filter(([field]) => field !== 'expectedAgent'),
);

/** Field name 006 adds; one literal, one home. */
const AGENT_FIELD = 'expectedAgent';

/** Documented default for {@link AGENT_FIELD}: *no baseline configured*. */
const AGENT_DEFAULT = '';

/** Field name 004 v1.3.0 adds to the document — the global prompt tier. */
const STARTING_PROMPT_FIELD = 'startingPrompt';

/** Documented default for {@link STARTING_PROMPT_FIELD}: *the tier is unset*. */
const PROMPT_DEFAULT = '';

/**
 * A document written before {@link STARTING_PROMPT_FIELD} existed — every
 * documented key **except** it.
 *
 * Derived from {@link DEFAULT_CONFIG} rather than retyped, so the fixture can
 * never claim to be "complete minus one" once another field lands.
 */
const PRE_PROMPT_CONFIG: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(DEFAULT_CONFIG).filter(([field]) => field !== STARTING_PROMPT_FIELD),
);

/** A baseline every rule accepts; used for the trimmed round trip and an accepted save. */
const ACCEPTED_AGENT = 'codex-reviewer';

/** The same baseline padded with whitespace, to prove the stored value is trimmed. */
const PADDED_AGENT = `  ${ACCEPTED_AGENT}  `;

/**
 * A value that passes the charset rule and still looks like a credential,
 * so the secret-shape refusal is the one that fires (AC-154).
 */
const CREDENTIAL_SHAPED_VALUE = `ghp_${'a'.repeat(36)}`;

/** 006's own twelve fields — the histogram's criterion of record (SC-106). */
const SPEC_FIELDS: readonly string[] = [
    'intervalMs',
    'overlapMs',
    'perPage',
    'retryMaxAttempts',
    'retryBaseMs',
    'retryMaxMs',
    'auditRetentionDays',
    'auditMaxEntries',
    'excerptRetentionDays',
    'logLevel',
    'expectedAgent',
    'startingPrompt',
];

/** Service registered for cleanup after the current test. */
let running: TestService | null = null;

/** Scratch directory created by a test that needs an unwritable parent. */
let scratch: string | null = null;

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork1 = async (): Promise<void> => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    if (scratch !== null) {
        await rm(scratch, { recursive: true, force: true });
        scratch = null;
    }
};

afterEach(afterEachWork1);

/**
 * Start a service instance and register it for cleanup.
 *
 * @param options - Harness options; forwarded verbatim.
 * @returns The running harness instance.
 */
async function startServiceForTest(
    options?: Parameters<typeof startTestService>[0],
): Promise<TestService> {
    const service = await startTestService(options);
    running = service;

    return service;
}

/**
 * Build a path under a regular file, so opening a store there must fail.
 *
 * @returns The unwritable data directory path.
 */
async function unwritableDataDir(): Promise<string> {
    scratch = await mkdtemp(join(tmpdir(), 'mecha-turk-blocked-'));
    const blocker = join(scratch, 'blocker');
    await writeFile(blocker, 'i am a file', 'utf8');

    return join(blocker, 'store');
}

describe('ServiceConfig validation', () => {
    it('accepts the shipped defaults unchanged (+5 cases)', async () => {
        // case: accepts the shipped defaults unchanged
        {
            const result = validateConfig(DEFAULT_CONFIG);

            expect(result).toEqual({ ok: true, config: DEFAULT_CONFIG });
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rejects every out-of-bounds value with a named remediation
        {
            for (const { field, value } of OUT_OF_BOUNDS) {
                const result = validateConfig({ ...DEFAULT_CONFIG, [field]: value });

                expect(result.ok, `${field} = ${String(value)} must be refused`).toBe(false);
                if (!result.ok) {
                    const issue = result.issues.find((candidate) => candidate.field === field);
                    expect(issue?.remediation, `${field} remediation must name the field`).toContain(field);
                }
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reports every missing field in one pass
        {
            const result = validateConfig({ [INTERVAL_FIELD]: 60_000 });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                const fields = result.issues.map((issue) => issue.field);
                const missing = Object.keys(DEFAULT_CONFIG).filter((field) => field !== INTERVAL_FIELD);
                expect(fields).toEqual(expect.arrayContaining(missing));
                expect(fields).not.toContain(INTERVAL_FIELD);
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rejects a document that is not an object
        {
            const result = validateConfig('not a configuration');

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.issues[0]?.field).toBe('body');
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rejects an unknown field with a removal instruction
        {
            const result = validateConfig({ ...DEFAULT_CONFIG, [INVENTED_FIELD]: 60_000 });

            expect(result.ok).toBe(false);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: withholds a secret-shaped field name instead of echoing it
        {
            const result = validateConfig({ ...DEFAULT_CONFIG, [TOKEN_FIELD]: 1 });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.issues.map((issue) => issue.field)).toContain('<withheld>');
                expect(JSON.stringify(result.issues)).not.toContain(TOKEN_FIELD);
                expect(result.issues.map((issue) => issue.field)).not.toContain(TOKEN_FIELD);
            }
        }
    });

    it('rejects a retry ceiling below the retry base (+5 cases)', async () => {
        // case: rejects a retry ceiling below the retry base
        {
            const result = validateConfig({ ...DEFAULT_CONFIG, retryBaseMs: 60_000, retryMaxMs: 5_000 });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.issues.map((issue) => issue.field)).toContain('retryMaxMs');
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: never echoes the submitted value in a remediation
        {
            const result = validateConfig({ ...DEFAULT_CONFIG, intervalMs: ABSURD_INTERVAL });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                for (const issue of result.issues) {
                    expect(issue.remediation).not.toContain(String(ABSURD_INTERVAL));
                }
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: defaults the lease and result-deadline knobs to the documented bounds (T-008)
        {
            expect(DEFAULT_CONFIG.leaseMs).toBe(120_000);
            expect(DEFAULT_CONFIG.resultDeadlineMs).toBe(120_000);
            expect(validateConfig(DEFAULT_CONFIG)).toEqual({ ok: true, config: DEFAULT_CONFIG });
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: never offers a requeue-budget field (003 v1.3.0 / 006 Deferred)
        {
            const result = validateConfig({ ...DEFAULT_CONFIG, requeueBudget: 3 });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.issues.map((issue) => issue.field)).toContain('requeueBudget');
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reads a configuration document written before the lease fields existed (T-008)
        {
            const result = parseStoredConfig(PRE_RUN_LAYER_CONFIG);

            expect(result).toEqual({
                config: {
                    ...PRE_RUN_LAYER_CONFIG,
                    leaseMs: 120_000,
                    resultDeadlineMs: 120_000,
                    [AGENT_FIELD]: AGENT_DEFAULT,
                    // v1.4.1: the global prompt tier joined the document, and a
                    // file predating it fills from the documented blank (004
                    // FR-081's no-migration rule) — reported as a default.
                    [STARTING_PROMPT_FIELD]: PROMPT_DEFAULT,
                },
                defaultsApplied: ['leaseMs', 'resultDeadlineMs', AGENT_FIELD, STARTING_PROMPT_FIELD],
            });
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: still quarantines a stored document whose own values are unusable (T-008)
        {
            expect(parseStoredConfig({ ...PRE_RUN_LAYER_CONFIG, leaseMs: 1 })).toBeNull();
            expect(parseStoredConfig({ ...PRE_RUN_LAYER_CONFIG, requeueBudget: 3 })).toBeNull();
            expect(parseStoredConfig({ ...PRE_RUN_LAYER_CONFIG, logLevel: 'verbose' })).toBeNull();
        }
    });
});

describe('GET and PUT /v1/config', () => {
    it('answers a fresh store with the defaults (+5 cases)', async () => {
        // case: answers a fresh store with the defaults
        {
            const service = await startServiceForTest();

            const response = await service.call(CONFIG_PATH);
            const body: { config: ServiceConfig } = await response.json();

            expect(response.status).toBe(200);
            expect(body.config).toEqual(DEFAULT_CONFIG);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: persists a replacement and reads it back
        {
            const service = await startServiceForTest();
            const replacement = { ...DEFAULT_CONFIG, intervalMs: 30_000, logLevel: 'debug' as const };

            const put = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(replacement) });
            const stored = JSON.parse(await readFile(join(service.dataDir, CONFIG_FILE), 'utf8')) as ServiceConfig;
            const get = await service.call(CONFIG_PATH);
            const body: { config: ServiceConfig } = await get.json();

            expect(put.status).toBe(200);
            expect(stored).toEqual(replacement);
            expect(body.config).toEqual(replacement);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rejects a partial document with one remediation per missing field
        {
            const service = await startServiceForTest();

            const response = await service.call(CONFIG_PATH, {
                method: 'PUT',
                body: JSON.stringify({ intervalMs: 30_000 }),
            });
            const failure: ValidationBody = await response.json();

            expect(response.status).toBe(422);
            expect(failure.error.code).toBe('validation');
            const missing = Object.keys(DEFAULT_CONFIG).filter((field) => field !== INTERVAL_FIELD);
            expect(failure.error.issues.map((issue) => issue.field)).toEqual(expect.arrayContaining(missing));
            expect(failure.error.message).toContain('retryBaseMs');
            const stored = await readFile(join(service.dataDir, CONFIG_FILE), 'utf8').catch(() => null);
            expect(stored).toBeNull();
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rejects an unknown field rather than silently ignoring it
        {
            const service = await startServiceForTest();

            const response = await service.call(CONFIG_PATH, {
                method: 'PUT',
                body: JSON.stringify({ ...DEFAULT_CONFIG, [INVENTED_FIELD]: 60_000 }),
            });
            const failure: ValidationBody = await response.json();

            expect(response.status).toBe(422);
            expect(failure.error.issues.map((issue) => issue.field)).toContain(INVENTED_FIELD);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: refuses a body that is not valid JSON
        {
            const service = await startServiceForTest();

            const response = await service.call(CONFIG_PATH, { method: 'PUT', body: '{"intervalMs":' });

            expect(response.status).toBe(400);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reads a pre-existing configuration document without quarantining it (T-008)
        {
            const service = await startServiceForTest();
            await writeFile(join(service.dataDir, CONFIG_FILE), JSON.stringify(PRE_RUN_LAYER_CONFIG), 'utf8');

            const response = await service.call(CONFIG_PATH);
            const body: { config: ServiceConfig } = await response.json();
            const entries = await readdir(service.dataDir);

            expect(response.status).toBe(200);
            expect(body.config).toEqual({
                ...PRE_RUN_LAYER_CONFIG,
                leaseMs: 120_000,
                resultDeadlineMs: 120_000,
                [AGENT_FIELD]: AGENT_DEFAULT,
                // v1.4.1: the same arrival fill for the global prompt tier.
                [STARTING_PROMPT_FIELD]: PROMPT_DEFAULT,
            });
            expect(entries.filter((entry) => entry.startsWith(CONFIG_QUARANTINE_PREFIX))).toEqual([]);
        }
    });

    it('round-trips a retuned lease and result deadline (T-0… (+1 cases)', async () => {
        // case: round-trips a retuned lease and result deadline (T-008)
        {
            const service = await startServiceForTest();
            const replacement = { ...DEFAULT_CONFIG, leaseMs: 45_000, resultDeadlineMs: 300_000 };

            const put = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(replacement) });
            const get = await service.call(CONFIG_PATH);
            const body: { config: ServiceConfig } = await get.json();

            expect(put.status).toBe(200);
            expect(body.config).toEqual(replacement);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: answers 503 for both routes when the data directory is unusable
        {
            const service = await startServiceForTest({ dataDir: await unwritableDataDir() });

            const get = await service.call(CONFIG_PATH);
            const put = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(DEFAULT_CONFIG) });
            const health = await service.call(HEALTH_PATH);
            const bodies = [await get.json(), await put.json()];

            expect(get.status).toBe(503);
            expect(put.status).toBe(503);
            for (const body of bodies) {
                expect(body).toMatchObject({ error: { code: 'storage-unavailable' } });
            }
            expect(health.status).toBe(200);
        }
    });
});

describe('GET /v1/status', () => {
    it('reports the documented skeleton on a healthy store (+2 cases)', async () => {
        // case: reports the documented skeleton on a healthy store
        {
            const service = await startServiceForTest();

            const response = await service.call(STATUS_PATH);
            const body: ServiceStatusBody = await response.json();

            expect(response.status).toBe(200);
            const sections = Object.keys(body).sort();
            expect(sections).toEqual(['accounts', 'agentPin', 'polling', 'repositories', 'service', 'surface']);
            expect(body.service.status).toBe('ok');
            expect(body.service.dataDir).toBe(service.dataDir);
            expect(body.service.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
            expect(body.service.uptimeMs).toBeGreaterThanOrEqual(0);
            expect(body.accounts).toEqual([]);
            expect(body.repositories).toEqual([]);
            expect(body.agentPin).toEqual({ expectedAgent: null, lastVerification: null });
            expect(body.polling.intervalMs).toBe(DEFAULT_CONFIG.intervalMs);
            expect(body.polling.paused).toBe(false);
            expect(body.polling.pausedReason).toBe('');
            expect(Date.parse(body.polling.nextPollAt ?? '')).toBeGreaterThan(Date.now());
            expect(body.surface.supported).toBe(true);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reflects a persisted interval in the polling state
        {
            const service = await startServiceForTest();
            const replacement = { ...DEFAULT_CONFIG, intervalMs: 30_000 };

            await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(replacement) });
            const response = await service.call(STATUS_PATH);
            const body: ServiceStatusBody = await response.json();

            expect(body.polling.intervalMs).toBe(30_000);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reports degraded and schema-less when the store is unavailable
        {
            const service = await startServiceForTest({ dataDir: await unwritableDataDir() });

            const response = await service.call(STATUS_PATH);
            const body: ServiceStatusBody = await response.json();

            expect(body.service.status).toBe('degraded');
            expect(body.service.schemaVersion).toBeNull();
            expect(body.polling.paused).toBe(true);
            expect(body.surface.supported).toBe(true);
        }
    });
});

/** The widened `GET /v1/config` envelope (006 contract §1). */
interface ConfigEnvelope {
    /** The effective document — unchanged in name and type from pre-006. */
    readonly config: ServiceConfig;
    /** The declaration, projected from the validator's own tables. */
    readonly fields: readonly FieldDescriptor[];
    /** Where `config` came from. */
    readonly source: 'stored' | 'default' | 'quarantined';
    /** Documented keys the stored file lacked. */
    readonly defaultsApplied: readonly string[];
}

describe('expectedAgent — the eleventh field (006 FR-100, AC-154)', () => {
    /**
     * One case per documented refusal, with the remediation contract §4 fixes.
     *
     * **Blank is not among them** (006 FR-100(c) as amended at v1.5.0): empty
     * after trimming is the documented *no baseline configured*, so it is
     * accepted and asserted in its own case below. What the rule still refuses
     * is everything else about the value — length, charset, credential shape —
     * plus an absent or non-string member, because the whole-document rule is
     * untouched (FR-100(b)).
     */
    const REFUSALS: readonly { readonly case: string; readonly value: string; readonly remediation: string }[] = [
        {
            case: 'longer than 80 characters',
            value: 'a'.repeat(81),
            remediation: 'set expectedAgent to at most 80 characters',
        },
        {
            case: 'contains a space',
            value: 'project manager',
            remediation: 'set expectedAgent to letters, digits, and . _ - @ : / with no spaces',
        },
        {
            case: 'credential shaped',
            value: CREDENTIAL_SHAPED_VALUE,
            remediation: 'set expectedAgent to an agent name, not a credential',
        },
    ];

    it('refuses each documented bad value with its own remed… (+3 cases)', async () => {
        // case: refuses each documented bad value with its own remediation and no echo
        {
            for (const { case: shape, value, remediation } of REFUSALS) {
                const result = validateConfig({ ...DEFAULT_CONFIG, [AGENT_FIELD]: value });

                expect(result.ok, `${shape} must be refused`).toBe(false);
                if (!result.ok) {
                    const issue = result.issues.find((candidate) => candidate.field === AGENT_FIELD);
                    expect(issue?.remediation, `${shape} remediation`).toBe(remediation);
                    expect(issue?.remediation, `${shape} must not echo whitespace`).not.toContain('    ');
                    const submitted = value.trim();
                    if (submitted !== '') {
                        expect(JSON.stringify(result.issues), `${shape} must not echo the value`)
                            .not.toContain(submitted);
                    }
                }
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: stores the trimmed value so a save/load round trip is stable
        {
            const result = validateConfig({ ...DEFAULT_CONFIG, [AGENT_FIELD]: PADDED_AGENT });

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.config[AGENT_FIELD]).toBe(ACCEPTED_AGENT);
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: accepts a blank baseline (006 FR-100(c) as amended) and still
        // refuses an absent or non-string member (FR-100(b), whole-document)
        {
            for (const blank of ['', '   ', '\t']) {
                const result = validateConfig({ ...DEFAULT_CONFIG, [AGENT_FIELD]: blank });

                expect(result.ok, `${JSON.stringify(blank)} must be a valid baseline`).toBe(true);
                if (result.ok) {
                    expect(result.config[AGENT_FIELD]).toBe('');
                }
            }

            for (const absent of [null, 42, ['project-manager']]) {
                const result = validateConfig({ ...DEFAULT_CONFIG, [AGENT_FIELD]: absent });

                expect(result.ok, `${typeof absent} must be refused`).toBe(false);
                if (!result.ok) {
                    const issue = result.issues.find((candidate) => candidate.field === AGENT_FIELD);
                    expect(issue?.remediation).toBe(
                        'set expectedAgent to a string; leave it empty for no baseline',
                    );
                }
            }

            // The whole-document rule refuses an omitted key (FR-100(b)), even
            // though a blank *value* is accepted above.
            const result = validateConfig({ ...PRE_AGENT_CONFIG });

            expect(result.ok, 'an omitted key must be refused').toBe(false);
            if (!result.ok) {
                expect(result.issues.map((issue) => issue.field)).toContain(AGENT_FIELD);
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: an explicitly blank baseline round-trips, and the read-side
        // backfill never resurrects a name over it (absent vs present-but-empty)
        {
            const service = await startServiceForTest();
            const put = await service.call(CONFIG_PATH, {
                method: 'PUT',
                body: JSON.stringify({ ...DEFAULT_CONFIG, [AGENT_FIELD]: '' }),
            });
            const read = await service.call(CONFIG_PATH);
            const envelope: ConfigEnvelope = await read.json();
            const stored = JSON.parse(
                await readFile(join(service.dataDir, CONFIG_FILE), 'utf8'),
            ) as Record<string, unknown>;

            expect(put.status).toBe(200);
            expect(read.status).toBe(200);
            expect(envelope.config[AGENT_FIELD]).toBe('');
            // Present-but-empty is *configured*: `defaultsApplied` keys off
            // absence only, so nothing fills the blank with a default.
            expect(envelope.source).toBe('stored');
            expect(envelope.defaultsApplied).toEqual([]);
            expect(stored[AGENT_FIELD]).toBe('');

            // The other half: a document that omits the key is filled with the
            // (blank) default and *is* reported as filled.
            await writeFile(join(service.dataDir, CONFIG_FILE), JSON.stringify(PRE_AGENT_CONFIG), 'utf8');
            const backfilledResponse = await service.call(CONFIG_PATH);
            const backfilled: ConfigEnvelope = await backfilledResponse.json();
            expect(backfilled.defaultsApplied).toEqual([AGENT_FIELD]);
            expect(backfilled.config[AGENT_FIELD]).toBe('');
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: refuses a PUT that omits the field while the read fills it (FR-100(b), data-model §2)
        {
            const service = await startServiceForTest();
            await writeFile(join(service.dataDir, CONFIG_FILE), JSON.stringify(PRE_AGENT_CONFIG), 'utf8');

            const read = await service.call(CONFIG_PATH);
            const envelope: ConfigEnvelope = await read.json();
            const put = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(PRE_AGENT_CONFIG) });
            const failure: ValidationBody = await put.json();
            const stored = await readFile(join(service.dataDir, CONFIG_FILE), 'utf8');

            // Read side: filled, reported, and byte-identical — a read writes nothing.
            expect(read.status).toBe(200);
            expect(envelope.source).toBe('stored');
            expect(envelope.defaultsApplied).toEqual([AGENT_FIELD]);
            expect(envelope.config[AGENT_FIELD]).toBe(AGENT_DEFAULT);
            expect(envelope.config.intervalMs).toBe(DEFAULT_CONFIG.intervalMs);
            expect(stored).toBe(JSON.stringify(PRE_AGENT_CONFIG));

            // Write side: the whole-file rule is unchanged, so the same body is a 422.
            expect(put.status).toBe(422);
            expect(failure.error.issues.map((issue) => issue.field)).toContain(AGENT_FIELD);
            expect(await readFile(join(service.dataDir, CONFIG_FILE), 'utf8')).toBe(JSON.stringify(PRE_AGENT_CONFIG));
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: leaves the stored value in force when a credential-shaped save is refused (AC-154)
        {
            const service = await startServiceForTest();
            const accepted = { ...DEFAULT_CONFIG, [AGENT_FIELD]: ACCEPTED_AGENT };
            await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(accepted) });
            const before = await readFile(join(service.dataDir, CONFIG_FILE), 'utf8');

            const refused = await service.call(CONFIG_PATH, {
                method: 'PUT',
                body: JSON.stringify({ ...DEFAULT_CONFIG, [AGENT_FIELD]: CREDENTIAL_SHAPED_VALUE }),
            });
            const body = await refused.text();
            const after = await readFile(join(service.dataDir, CONFIG_FILE), 'utf8');

            expect(refused.status).toBe(422);
            expect(body).toContain(AGENT_FIELD);
            expect(body).not.toContain(CREDENTIAL_SHAPED_VALUE);
            expect(after).toBe(before);
        }
    });
});

describe('startingPrompt — the global tier (004 FR-081, FR-083; 006 FR-041)', () => {
    /** The cap, in code points, read from the one declaration the validator uses. */
    const CAP = STARTING_PROMPT_MAX_CODE_POINTS;

    /** A value at the cap exactly, which must be accepted (004 FR-020). */
    const AT_CAP_PROMPT = 'a'.repeat(CAP);

    /** One code point past the cap, which must be refused. */
    const OVER_CAP_PROMPT = 'a'.repeat(CAP + 1);

    /** Padding around an ordinary instruction, to prove the stored value normalises. */
    const PADDED_PROMPT = '  first line\r\nsecond line  ';

    /** What {@link PADDED_PROMPT} reads back as: trimmed, line endings normalised. */
    const NORMALISED_PROMPT = 'first line\nsecond line';

    it('takes the documented blank as unset and stores the normalised text', () => {
        // The shipped default *is* the documented unset state (004 FR-081).
        expect(DEFAULT_CONFIG.startingPrompt).toBe(PROMPT_DEFAULT);
        expect(validateConfig(DEFAULT_CONFIG)).toEqual({ ok: true, config: DEFAULT_CONFIG });

        // The ceiling this rule applies is the specification's own figure.
        expect(CAP).toBe(2_000);

        for (const blank of ['', '   ', '\t\n']) {
            const result = validateConfig({ ...DEFAULT_CONFIG, [STARTING_PROMPT_FIELD]: blank });

            expect(result.ok, `${JSON.stringify(blank)} must mean unset`).toBe(true);
            if (result.ok) {
                expect(result.config[STARTING_PROMPT_FIELD]).toBe(PROMPT_DEFAULT);
            }
        }

        const padded = validateConfig({ ...DEFAULT_CONFIG, [STARTING_PROMPT_FIELD]: PADDED_PROMPT });

        expect(padded.ok).toBe(true);
        if (padded.ok) {
            expect(padded.config[STARTING_PROMPT_FIELD]).toBe(NORMALISED_PROMPT);
        }
    });

    it('accepts 2,000 code points and refuses 2,001 with the field and no echo', () => {
        const accepted = validateConfig({ ...DEFAULT_CONFIG, [STARTING_PROMPT_FIELD]: AT_CAP_PROMPT });

        expect(accepted.ok, 'the cap itself must be accepted').toBe(true);
        if (accepted.ok) {
            expect(accepted.config[STARTING_PROMPT_FIELD]).toHaveLength(CAP);
        }

        const refused = validateConfig({ ...DEFAULT_CONFIG, [STARTING_PROMPT_FIELD]: OVER_CAP_PROMPT });

        expect(refused.ok, 'one code point past the cap must be refused').toBe(false);
        if (!refused.ok) {
            const issue = refused.issues.find((candidate) => candidate.field === STARTING_PROMPT_FIELD);

            expect(issue, 'the refusal must name the field').toBeDefined();
            expect(issue?.remediation).toContain(String(CAP));
            // No echo — neither the value nor any run of it appears anywhere
            // in the additive issue list (004 FR-003, AC-133).
            expect(JSON.stringify(refused.issues)).not.toContain(OVER_CAP_PROMPT);
            expect(JSON.stringify(refused.issues)).not.toContain('a'.repeat(64));
        }
    });

    it('refuses a credential-shaped value with the shipped shape label, over the model and the wire', async () => {
        // The label comes from the shipped detector itself, so this asserts the
        // *same* shape vocabulary without restating it (004 FR-024).
        const label = findSecretLeak(CREDENTIAL_SHAPED_VALUE);
        expect(label, 'the fixture must still read as a credential').not.toBeNull();

        const refused = validateConfig({ ...DEFAULT_CONFIG, [STARTING_PROMPT_FIELD]: CREDENTIAL_SHAPED_VALUE });

        expect(refused.ok).toBe(false);
        if (!refused.ok) {
            const issue = refused.issues.find((candidate) => candidate.field === STARTING_PROMPT_FIELD);

            expect(issue?.remediation).toContain(`matched shape: ${String(label)}`);
            expect(JSON.stringify(refused.issues)).not.toContain(CREDENTIAL_SHAPED_VALUE);
        }

        // The same refusal as `PUT /v1/config` answers it: 422, the field
        // named, zero characters of the value in the envelope, and a stored
        // document left byte-identical (006 FR-040, NFR-103).
        const service = await startServiceForTest();
        const before = JSON.stringify({ ...DEFAULT_CONFIG });
        await writeFile(join(service.dataDir, CONFIG_FILE), before, 'utf8');

        const put = await service.call(CONFIG_PATH, {
            method: 'PUT',
            body: JSON.stringify({ ...DEFAULT_CONFIG, [STARTING_PROMPT_FIELD]: CREDENTIAL_SHAPED_VALUE }),
        });
        const failure: ValidationBody = await put.json();
        const after = await readFile(join(service.dataDir, CONFIG_FILE), 'utf8');

        expect(put.status).toBe(422);
        expect(failure.error.code).toBe('validation');
        expect(failure.error.issues.map((issue) => issue.field)).toContain(STARTING_PROMPT_FIELD);
        expect(JSON.stringify(failure)).not.toContain(CREDENTIAL_SHAPED_VALUE);
        expect(after).toBe(before);
    });

    it('refuses a non-string member, because the whole-document rule is untouched', async () => {
        for (const wrong of [null, 42, ['an instruction']]) {
            const result = validateConfig({ ...DEFAULT_CONFIG, [STARTING_PROMPT_FIELD]: wrong });

            expect(result.ok, `${JSON.stringify(wrong)} must be refused`).toBe(false);
            if (!result.ok) {
                const issue = result.issues.find((candidate) => candidate.field === STARTING_PROMPT_FIELD);

                expect(issue?.remediation).toContain(STARTING_PROMPT_FIELD);
            }
        }

        // …and a PUT that omits the member entirely is the same 422: a member
        // the whole-file rule requires is never filled in on a *write* (006 FR-041).
        const service = await startServiceForTest();
        const put = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(PRE_PROMPT_CONFIG) });
        const failure: ValidationBody = await put.json();

        expect(put.status).toBe(422);
        expect(failure.error.issues.map((issue) => issue.field)).toContain(STARTING_PROMPT_FIELD);
    });

    it('fills a file predating the member, reports the fill, and writes no audit row', async () => {
        const service = await startServiceForTest();
        const storedBefore = JSON.stringify(PRE_PROMPT_CONFIG);
        await writeFile(join(service.dataDir, CONFIG_FILE), storedBefore, 'utf8');

        const { store } = service.handle;
        if (store === null) {
            throw new Error('fixture service has no store');
        }

        const trailBefore = await readAuditEntries(store);
        const read = await service.call(CONFIG_PATH);
        const envelope: ConfigEnvelope = await read.json();
        const trailAfter = await readAuditEntries(store);
        const storedAfter = await readFile(join(service.dataDir, CONFIG_FILE), 'utf8');

        // The read: filled from the documented blank, reported as a default,
        // never presented as configured (004 FR-081, 006 FR-028).
        expect(read.status).toBe(200);
        expect(envelope.source).toBe('stored');
        expect(envelope.defaultsApplied).toEqual([STARTING_PROMPT_FIELD]);
        expect(envelope.config[STARTING_PROMPT_FIELD]).toBe(PROMPT_DEFAULT);
        // A read rewrites nothing…
        expect(storedAfter).toBe(storedBefore);
        // …and appends nothing: the arrival fill is not an event (004 FR-088
        // records *changes*, and this one changed no value).
        expect(trailAfter).toEqual(trailBefore);
        expect(trailAfter.filter((entry) => entry.eventType === 'config.changed')).toEqual([]);

        // The write half of the same document stays a whole-file refusal, so
        // the blank is only ever filled by the read (006 FR-041).
        const put = await service.call(CONFIG_PATH, { method: 'PUT', body: storedBefore });
        const failure: ValidationBody = await put.json();
        const storedUnchanged = await readFile(join(service.dataDir, CONFIG_FILE), 'utf8');

        expect(put.status).toBe(422);
        expect(failure.error.code).toBe('validation');
        expect(failure.error.issues.map((issue) => issue.field)).toEqual([STARTING_PROMPT_FIELD]);
        expect(storedUnchanged).toBe(storedBefore);
    });
});

describe('GET /v1/config widens without changing what it already said (006 FR-020, contract §1)', () => {
    it('reports source fidelity for all three reads, and [] … (+1 cases)', async () => {
        // case: reports source fidelity for all three reads, and [] whenever source is not stored
        {
            const service = await startServiceForTest();

            // Absent: the documented defaults answer, and `config` keeps its shape.
            const absentResponse = await service.call(CONFIG_PATH);
            const absent: ConfigEnvelope = await absentResponse.json();
            expect(absent.source).toBe('default');
            expect(absent.defaultsApplied).toEqual([]);
            expect(absent.config).toEqual(DEFAULT_CONFIG);

            // Stored: the file's values, with only the missing key reported as filled.
            await writeFile(join(service.dataDir, CONFIG_FILE), JSON.stringify(PRE_AGENT_CONFIG), 'utf8');
            const storedResponse = await service.call(CONFIG_PATH);
            const stored: ConfigEnvelope = await storedResponse.json();
            expect(stored.source).toBe('stored');
            expect(stored.defaultsApplied).toEqual([AGENT_FIELD]);
            expect(stored.config[AGENT_FIELD]).toBe(AGENT_DEFAULT);

            // Quarantined: defaults serve, no key is claimed as filled, no value as configured.
            const unusable = JSON.stringify({ ...PRE_AGENT_CONFIG, surprise: 1 });
            await writeFile(join(service.dataDir, CONFIG_FILE), unusable, 'utf8');
            const quarantinedResponse = await service.call(CONFIG_PATH);
            const quarantined: ConfigEnvelope = await quarantinedResponse.json();
            expect(quarantined.source).toBe('quarantined');
            expect(quarantined.defaultsApplied).toEqual([]);
            expect(quarantined.config).toEqual(DEFAULT_CONFIG);
            const entries = await readdir(service.dataDir);
            expect(entries.filter((entry) => entry.startsWith(CONFIG_QUARANTINE_PREFIX))).toHaveLength(1);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: carries one descriptor per documented field, in the validator\'s own order (AC-107)
        {
            const service = await startServiceForTest();
            const response = await service.call(CONFIG_PATH);
            const envelope: ConfigEnvelope = await response.json();

            expect(envelope.fields.map((descriptor) => descriptor.name)).toEqual(Object.keys(DEFAULT_CONFIG));
            expect(envelope.fields).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
            for (const descriptor of envelope.fields) {
                expect(descriptor.takesEffect).toBeTruthy();
            }
        }
    });
});

describe('a lost quarantine rename still answers quarantined (006 contract §3 rule 9)', () => {
    it('maps a pathless quarantine to source quarantined, and keeps real absence at default', () => {
        const logLines: string[] = [];
        const log = createLogger({ level: 'warn', sink: (line) => logLines.push(line) });

        // The per-cycle config reader and an operator's request can both
        // reject the same stored document; the loser's rename finds the file
        // already set aside under the winner's name, so the outcome carries no
        // path. The document was invalid either way, so the operator still
        // gets the "unusable and set aside" sentence, not "defaults apply".
        const raced = configFromStore({ status: 'quarantined', quarantinePath: null }, log);

        expect(raced.source).toBe('quarantined');
        expect(raced.config).toEqual(DEFAULT_CONFIG);
        expect(raced.defaultsApplied).toEqual([]);
        expect(logLines.join('\n')).toContain('stored configuration was unusable and has been set aside');

        // Absence is a different fact and keeps its own answer: a store with
        // no `config.json` is the first-run state, never a quarantine — and
        // it earns no warning either.
        expect(configFromStore({ status: 'absent' }, log).source).toBe('default');
        expect(logLines).toHaveLength(1);
    });
});

/**
 * Find one projected descriptor.
 *
 * @param name - Documented field name.
 * @returns Its descriptor, or `undefined` when the field is undocumented.
 */
function descriptorOf(name: string): FieldDescriptor | undefined {
    return configSchema().find((descriptor) => descriptor.name === name);
}

/**
 * The value each **string** field's own rule refuses, by documented name.
 *
 * The two string fields refuse entirely different things: `expectedAgent` is a
 * single-token charset, while `startingPrompt` has **no content policy at all**
 * (004 FR-029) — ordinary words with spaces are exactly what an instruction is
 * made of, so the prompt entry fails one of its four refusal classes instead:
 * a reserved composition-marker line (004 FR-025).
 */
const STRING_REFUSALS: Readonly<Record<string, unknown>> = {
    expectedAgent: 'project manager',
    startingPrompt: '--- BEGIN composed prompt ---',
};

/**
 * Build a value that each descriptor's own kind refuses.
 *
 * @param descriptor - The projected field to fail.
 * @returns A value outside that field's rule, for the ordering assertion.
 * @throws {Error} When a string field has no refusal fixture — a new string
 *   field must declare what fails it rather than inheriting another field's
 *   rule by default.
 */
function refusedValueFor(descriptor: FieldDescriptor): unknown {
    if (descriptor.kind === 'integer') {
        return descriptor.min - 1;
    }

    if (descriptor.kind === 'enum') {
        return 'verbose';
    }

    const refusal = STRING_REFUSALS[descriptor.name];
    if (refusal === undefined) {
        throw new Error(`no refusal fixture for string field ${descriptor.name}`);
    }

    return refusal;
}

describe('the projection is the validator\'s own declaration (006 SC-101, SC-106)', () => {
    it('moves together when a bound moves, and returns when … (+3 cases)', async () => {
        // case: moves together when a bound moves, and returns when it is reverted (SC-101)
        {
            expect(descriptorOf('intervalMs')).toMatchObject({ min: 15_000, max: 300_000 });
            expect(validateConfig({ ...DEFAULT_CONFIG, intervalMs: 15_001 }).ok).toBe(true);

            try {
                Reflect.set(NUMERIC_BOUNDS.intervalMs, 'min', 42_000);
                expect(descriptorOf('intervalMs')).toMatchObject({ min: 42_000, max: 300_000 });
                const moved = validateConfig({ ...DEFAULT_CONFIG, intervalMs: 15_001 });
                expect(moved.ok).toBe(false);
                if (!moved.ok) {
                    const issue = moved.issues.find((candidate) => candidate.field === 'intervalMs');
                    expect(issue?.remediation).toContain('42000');
                }
            } finally {
                Reflect.set(NUMERIC_BOUNDS.intervalMs, 'min', 15_000);
            }

            expect(descriptorOf('intervalMs')).toMatchObject({ min: 15_000 });
            expect(validateConfig({ ...DEFAULT_CONFIG, intervalMs: 15_001 }).ok).toBe(true);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: emits descriptors in exactly the order a full refusal reports issues
        {
            const candidate: Record<string, unknown> = {};
            for (const descriptor of configSchema()) {
                candidate[descriptor.name] = refusedValueFor(descriptor);
            }

            const result = validateConfig(candidate);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                const reportedOrder = configSchema().map((descriptor) => descriptor.name);
                expect(result.issues.map((issue) => issue.field)).toEqual(reportedOrder);
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: declares ten next-cycle, one immediate, and one next-dispatch over 006\'s twelve (SC-106)
        {
            const declared = configSchema()
                .filter((descriptor) => SPEC_FIELDS.includes(descriptor.name))
                .map((descriptor) => descriptor.takesEffect);

            // The criterion of record is twelve fields under 006 v1.6.0 —
            // nine polling/retention fields, `logLevel`, `expectedAgent`, and
            // 004's global prompt tier — so a thirteenth must be added here by
            // hand rather than absorbed silently.
            expect(SPEC_FIELDS).toHaveLength(12);
            expect(declared).toHaveLength(12);
            expect(declared.filter((takeEffect) => takeEffect === 'next-cycle')).toHaveLength(10);
            expect(declared.filter((takeEffect) => takeEffect === 'immediate')).toHaveLength(1);
            expect(declared.filter((takeEffect) => takeEffect === 'next-dispatch')).toHaveLength(1);
            expect(declared.filter((takeEffect) => takeEffect === 'restart' || takeEffect === 'none')).toHaveLength(0);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: gives the string field no unit and no numeric bound, and the enum field the four levels
        {
            const agent = descriptorOf(AGENT_FIELD);
            expect(agent).toMatchObject({
                kind: 'string',
                unit: null,
                maxLength: 80,
                default: AGENT_DEFAULT,
                takesEffect: 'next-dispatch',
            });
            const agentKeys = agent === undefined ? [] : Object.keys(agent);
            expect(agentKeys).not.toContain('min');
            expect(agentKeys).not.toContain('max');

            expect(descriptorOf('logLevel')).toMatchObject({
                kind: 'enum',
                unit: null,
                values: ['debug', 'info', 'warn', 'error'],
                default: 'info',
                takesEffect: 'immediate',
            });
        }
    });

    it('round-trips the twelfth descriptor through the panel\'s closed parser', () => {
        const parsed = parseConfigEnvelope(
            JSON.stringify({
                config: DEFAULT_CONFIG,
                fields: configSchema(),
                source: 'default',
                defaultsApplied: [],
            }),
        );

        expect(parsed, 'the projection must survive the panel\'s fail-closed reader').not.toBeNull();
        if (parsed === null) {
            return;
        }

        // Every documented member has a descriptor, so the panel marks nothing
        // as *field this version does not show* and nothing as unreadable —
        // the twelfth field included (006 FR-027, AC-115).
        expect(parsed.undisplayed).toEqual([]);
        expect(parsed.unreadable).toEqual([]);

        const descriptor = descriptorFor(parsed, STARTING_PROMPT_FIELD);

        expect(descriptor).not.toBeNull();
        expect(descriptor).toMatchObject({
            kind: 'string',
            unit: null,
            maxLength: STARTING_PROMPT_MAX_CODE_POINTS,
            default: PROMPT_DEFAULT,
            takesEffect: 'next-cycle',
        });

        // The bounds slot of a string row *is* the format prose, and FR-063's
        // guidance rides it (004 research R-4): the row renders no
        // panel-authored copy, so everything an operator must be told about
        // this field has to arrive on the wire — including the cap as a
        // concrete number rather than a placeholder (006 FR-014, FR-023).
        const format = descriptor?.kind === 'string' ? descriptor.format : '';

        expect(format).toContain('sent to the agent verbatim');
        expect(format).toContain('no placeholders');
        expect(format).toContain(`${STARTING_PROMPT_MAX_CODE_POINTS} code points after trimming`);
        expect(format).toContain('refused rather than stored');
        expect(format).toContain('pinned Default Agent');
    });
});

/**
 * Corrupt the stored configuration on disk, so the next read sets it aside
 * and emits the warn line whose presence or absence *is* the threshold.
 *
 * @param dataDir - Store directory of a running instance.
 */
async function corruptStoredConfig(dataDir: string): Promise<void> {
    const unusable = JSON.stringify({ ...DEFAULT_CONFIG, surprise: 1 });
    await writeFile(join(dataDir, CONFIG_FILE), unusable, 'utf8');
}

describe('logLevel is immediate (006 FR-033, FR-037, AC-103, SC-105)', () => {
    /** The one warn line a configuration read emits when it sets a file aside. */
    const SET_ASIDE = 'stored configuration was unusable and has been set aside';

    /** Bearer token for the instance this suite starts directly. */
    const BEARER_TOKEN = 'ab'.repeat(24);

    it('adopts the stored level at start-up and an accepted save on the very next line', async () => {
        const lines: string[] = [];
        const log = createLogger({
            level: 'debug',
            sink: (line) => {
                lines.push(line);
            },
        });
        const home = await mkdtemp(join(tmpdir(), 'mecha-turk-loglevel-'));
        const dataDir = join(home, 'store');
        await mkdir(dataDir, { recursive: true });
        await writeFile(
            join(dataDir, CONFIG_FILE),
            JSON.stringify({ ...DEFAULT_CONFIG, logLevel: 'error' }),
            'utf8',
        );

        const hostEnv: Record<string, string | undefined> = {};
        hostEnv.HOME = home;
        hostEnv.OPENCHAMBER_SERVICE_PORT = '0';
        hostEnv.OPENCHAMBER_SERVICE_TOKEN = BEARER_TOKEN;
        const handle = await startService({
            env: readServiceEnv(hostEnv),
            dataDir,
            log,
            github: offlineVerifier(),
        });
        const origin = `http://127.0.0.1:${handle.port}`;
        const headers = { authorization: `Bearer ${BEARER_TOKEN}` };
        const setAsideCount = (): number => lines.filter((line) => line.includes(SET_ASIDE)).length;

        /**
         * Read the configuration once and discard the answer.
         *
         * @returns The HTTP status the read answered with.
         */
        const readConfig = async (): Promise<number> => {
            const response = await fetch(`${origin}${CONFIG_PATH}`, { headers });
            await response.text();

            return response.status;
        };

        try {
            // AC-103: the stored `error` level is in force with no restart, so
            // a warn emitted after start-up does not reach the sink.
            await corruptStoredConfig(dataDir);
            expect(await readConfig()).toBe(200);
            expect(setAsideCount()).toBe(0);

            // A refused write moves no threshold.
            const refused = await fetch(`${origin}${CONFIG_PATH}`, {
                method: 'PUT',
                headers,
                body: JSON.stringify({ ...DEFAULT_CONFIG, intervalMs: 1 }),
            });
            await refused.text();
            expect(refused.status).toBe(422);
            await corruptStoredConfig(dataDir);
            expect(await readConfig()).toBe(200);
            expect(setAsideCount()).toBe(0);

            // SC-105: the accepted save flips the very next line — no restart,
            // no second write, and nothing else done in between.
            const accepted = await fetch(`${origin}${CONFIG_PATH}`, {
                method: 'PUT',
                headers,
                body: JSON.stringify({ ...DEFAULT_CONFIG, logLevel: 'info' }),
            });
            await accepted.text();
            expect(accepted.status).toBe(200);
            await corruptStoredConfig(dataDir);
            expect(await readConfig()).toBe(200);
            expect(setAsideCount()).toBe(1);
        } finally {
            await handle.shutdown();
            await rm(home, { recursive: true, force: true });
        }
    });
});
