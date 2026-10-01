/**
 * Service configuration and status tests (task T-006).
 *
 * Validation is tested twice on purpose: against the model (every bound, the
 * unknown-field and secret-shaped-key rules, cross-field ordering, and the
 * no-value-echo guarantee) and over the real loopback API (defaults on a
 * fresh store, atomic PUT round-trip, 422 remediation lists, 400 for malformed
 * JSON, 503 when the data directory is unusable). `GET /v1/status` is asserted
 * against the contract's fixed shape, including its truthful wave-1 contents.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, NUMERIC_BOUNDS, parseStoredConfig, validateConfig } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { readServiceEnv } from '../service/env.ts';
import { createLogger } from '../service/log.ts';
import { startService } from '../service/server.ts';
import { SERVICE_SCHEMA_VERSION } from '../service/store/index.ts';
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

/** Documented default for {@link AGENT_FIELD}. */
const AGENT_DEFAULT = 'project-manager';

/** A baseline every rule accepts; used for the trimmed round trip and an accepted save. */
const ACCEPTED_AGENT = 'codex-reviewer';

/** The same baseline padded with whitespace, to prove the stored value is trimmed. */
const PADDED_AGENT = `  ${ACCEPTED_AGENT}  `;

/**
 * A value that passes the charset rule and still looks like a credential,
 * so the secret-shape refusal is the one that fires (AC-154).
 */
const CREDENTIAL_SHAPED_VALUE = `ghp_${'a'.repeat(36)}`;

/** 006's own eleven fields — the histogram's criterion of record (SC-106). */
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
];

/** Service registered for cleanup after the current test. */
let running: TestService | null = null;

/** Scratch directory created by a test that needs an unwritable parent. */
let scratch: string | null = null;

afterEach(async () => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    if (scratch !== null) {
        await rm(scratch, { recursive: true, force: true });
        scratch = null;
    }
});

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
    it('accepts the shipped defaults unchanged', () => {
        const result = validateConfig(DEFAULT_CONFIG);

        expect(result).toEqual({ ok: true, config: DEFAULT_CONFIG });
    });

    it('rejects every out-of-bounds value with a named remediation', () => {
        for (const { field, value } of OUT_OF_BOUNDS) {
            const result = validateConfig({ ...DEFAULT_CONFIG, [field]: value });

            expect(result.ok, `${field} = ${String(value)} must be refused`).toBe(false);
            if (!result.ok) {
                const issue = result.issues.find((candidate) => candidate.field === field);
                expect(issue?.remediation, `${field} remediation must name the field`).toContain(field);
            }
        }
    });

    it('reports every missing field in one pass', () => {
        const result = validateConfig({ [INTERVAL_FIELD]: 60_000 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            const fields = result.issues.map((issue) => issue.field);
            const missing = Object.keys(DEFAULT_CONFIG).filter((field) => field !== INTERVAL_FIELD);
            expect(fields).toEqual(expect.arrayContaining(missing));
            expect(fields).not.toContain(INTERVAL_FIELD);
        }
    });

    it('rejects a document that is not an object', () => {
        const result = validateConfig('not a configuration');

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues[0]?.field).toBe('body');
        }
    });

    it('rejects an unknown field with a removal instruction', () => {
        const result = validateConfig({ ...DEFAULT_CONFIG, [INVENTED_FIELD]: 60_000 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            const issue = result.issues.find((candidate) => candidate.field === INVENTED_FIELD);
            expect(issue?.remediation).toContain('remove this key');
        }
    });

    it('withholds a secret-shaped field name instead of echoing it', () => {
        const result = validateConfig({ ...DEFAULT_CONFIG, [TOKEN_FIELD]: 1 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues.map((issue) => issue.field)).toContain('<withheld>');
            expect(JSON.stringify(result.issues)).not.toContain(TOKEN_FIELD);
            expect(result.issues.map((issue) => issue.field)).not.toContain(TOKEN_FIELD);
        }
    });

    it('rejects a retry ceiling below the retry base', () => {
        const result = validateConfig({ ...DEFAULT_CONFIG, retryBaseMs: 60_000, retryMaxMs: 5_000 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues.map((issue) => issue.field)).toContain('retryMaxMs');
        }
    });

    it('never echoes the submitted value in a remediation', () => {
        const result = validateConfig({ ...DEFAULT_CONFIG, intervalMs: ABSURD_INTERVAL });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            for (const issue of result.issues) {
                expect(issue.remediation).not.toContain(String(ABSURD_INTERVAL));
            }
        }
    });

    it('defaults the lease and result-deadline knobs to the documented bounds (T-008)', () => {
        expect(DEFAULT_CONFIG.leaseMs).toBe(120_000);
        expect(DEFAULT_CONFIG.resultDeadlineMs).toBe(120_000);
        expect(validateConfig(DEFAULT_CONFIG)).toEqual({ ok: true, config: DEFAULT_CONFIG });
    });

    it('never offers a requeue-budget field (003 v1.3.0 / 006 Deferred)', () => {
        const result = validateConfig({ ...DEFAULT_CONFIG, requeueBudget: 3 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.issues.map((issue) => issue.field)).toContain('requeueBudget');
        }
    });

    it('reads a configuration document written before the lease fields existed (T-008)', () => {
        const result = parseStoredConfig(PRE_RUN_LAYER_CONFIG);

        expect(result).toEqual({
            config: {
                ...PRE_RUN_LAYER_CONFIG,
                leaseMs: 120_000,
                resultDeadlineMs: 120_000,
                [AGENT_FIELD]: AGENT_DEFAULT,
            },
            defaultsApplied: ['leaseMs', 'resultDeadlineMs', AGENT_FIELD],
        });
    });

    it('still quarantines a stored document whose own values are unusable (T-008)', () => {
        expect(parseStoredConfig({ ...PRE_RUN_LAYER_CONFIG, leaseMs: 1 })).toBeNull();
        expect(parseStoredConfig({ ...PRE_RUN_LAYER_CONFIG, requeueBudget: 3 })).toBeNull();
        expect(parseStoredConfig({ ...PRE_RUN_LAYER_CONFIG, logLevel: 'verbose' })).toBeNull();
    });
});

describe('GET and PUT /v1/config', () => {
    it('answers a fresh store with the defaults', async () => {
        const service = await startServiceForTest();

        const response = await service.call(CONFIG_PATH);
        const body: { config: ServiceConfig } = await response.json();

        expect(response.status).toBe(200);
        expect(body.config).toEqual(DEFAULT_CONFIG);
    });

    it('persists a replacement and reads it back', async () => {
        const service = await startServiceForTest();
        const replacement = { ...DEFAULT_CONFIG, intervalMs: 30_000, logLevel: 'debug' as const };

        const put = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(replacement) });
        const stored = JSON.parse(await readFile(join(service.dataDir, CONFIG_FILE), 'utf8')) as ServiceConfig;
        const get = await service.call(CONFIG_PATH);
        const body: { config: ServiceConfig } = await get.json();

        expect(put.status).toBe(200);
        expect(stored).toEqual(replacement);
        expect(body.config).toEqual(replacement);
    });

    it('rejects a partial document with one remediation per missing field', async () => {
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
    });

    it('rejects an unknown field rather than silently ignoring it', async () => {
        const service = await startServiceForTest();

        const response = await service.call(CONFIG_PATH, {
            method: 'PUT',
            body: JSON.stringify({ ...DEFAULT_CONFIG, [INVENTED_FIELD]: 60_000 }),
        });
        const failure: ValidationBody = await response.json();

        expect(response.status).toBe(422);
        expect(failure.error.issues.map((issue) => issue.field)).toContain(INVENTED_FIELD);
    });

    it('refuses a body that is not valid JSON', async () => {
        const service = await startServiceForTest();

        const response = await service.call(CONFIG_PATH, { method: 'PUT', body: '{"intervalMs":' });

        expect(response.status).toBe(400);
    });

    it('reads a pre-existing configuration document without quarantining it (T-008)', async () => {
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
        });
        expect(entries.filter((entry) => entry.startsWith(CONFIG_QUARANTINE_PREFIX))).toEqual([]);
    });

    it('round-trips a retuned lease and result deadline (T-008)', async () => {
        const service = await startServiceForTest();
        const replacement = { ...DEFAULT_CONFIG, leaseMs: 45_000, resultDeadlineMs: 300_000 };

        const put = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(replacement) });
        const get = await service.call(CONFIG_PATH);
        const body: { config: ServiceConfig } = await get.json();

        expect(put.status).toBe(200);
        expect(body.config).toEqual(replacement);
    });

    it('answers 503 for both routes when the data directory is unusable', async () => {
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
    });
});

describe('GET /v1/status', () => {
    it('reports the documented skeleton on a healthy store', async () => {
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
    });

    it('reflects a persisted interval in the polling state', async () => {
        const service = await startServiceForTest();
        const replacement = { ...DEFAULT_CONFIG, intervalMs: 30_000 };

        await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(replacement) });
        const response = await service.call(STATUS_PATH);
        const body: ServiceStatusBody = await response.json();

        expect(body.polling.intervalMs).toBe(30_000);
    });

    it('reports degraded and schema-less when the store is unavailable', async () => {
        const service = await startServiceForTest({ dataDir: await unwritableDataDir() });

        const response = await service.call(STATUS_PATH);
        const body: ServiceStatusBody = await response.json();

        expect(body.service.status).toBe('degraded');
        expect(body.service.schemaVersion).toBeNull();
        expect(body.polling.paused).toBe(true);
        expect(body.surface.supported).toBe(true);
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
    /** One case per documented refusal, with the remediation contract §4 fixes. */
    const REFUSALS: readonly { readonly case: string; readonly value: string; readonly remediation: string }[] = [
        {
            case: 'empty after trimming',
            value: '   ',
            remediation: 'set expectedAgent to a non-empty agent name',
        },
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

    it('refuses each documented bad value with its own remediation and no echo', () => {
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
    });

    it('stores the trimmed value so a save/load round trip is stable', () => {
        const result = validateConfig({ ...DEFAULT_CONFIG, [AGENT_FIELD]: PADDED_AGENT });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config[AGENT_FIELD]).toBe(ACCEPTED_AGENT);
        }
    });

    it('refuses a PUT that omits the field while the read fills it (FR-100(b), data-model §2)', async () => {
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
    });

    it('leaves the stored value in force when a credential-shaped save is refused (AC-154)', async () => {
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
    });
});

describe('GET /v1/config widens without changing what it already said (006 FR-020, contract §1)', () => {
    it('reports source fidelity for all three reads, and [] whenever source is not stored', async () => {
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
    });

    it('carries one descriptor per documented field, in the validator\'s own order (AC-107)', async () => {
        const service = await startServiceForTest();
        const response = await service.call(CONFIG_PATH);
        const envelope: ConfigEnvelope = await response.json();

        expect(envelope.fields.map((descriptor) => descriptor.name)).toEqual(Object.keys(DEFAULT_CONFIG));
        expect(envelope.fields).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        for (const descriptor of envelope.fields) {
            expect(descriptor.takesEffect).toBeTruthy();
        }
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
 * Build a value that each descriptor's own kind refuses.
 *
 * @param descriptor - The projected field to fail.
 * @returns A value outside that field's rule, for the ordering assertion.
 */
function refusedValueFor(descriptor: FieldDescriptor): unknown {
    if (descriptor.kind === 'integer') {
        return descriptor.min - 1;
    }

    if (descriptor.kind === 'enum') {
        return 'verbose';
    }

    return 'project manager';
}

describe('the projection is the validator\'s own declaration (006 SC-101, SC-106)', () => {
    it('moves together when a bound moves, and returns when it is reverted (SC-101)', () => {
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
    });

    it('emits descriptors in exactly the order a full refusal reports issues', () => {
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
    });

    it('declares nine next-cycle, one immediate, and one next-dispatch over 006\'s eleven (SC-106)', () => {
        const declared = configSchema()
            .filter((descriptor) => SPEC_FIELDS.includes(descriptor.name))
            .map((descriptor) => descriptor.takesEffect);

        expect(declared).toHaveLength(11);
        expect(declared.filter((takeEffect) => takeEffect === 'next-cycle')).toHaveLength(9);
        expect(declared.filter((takeEffect) => takeEffect === 'immediate')).toHaveLength(1);
        expect(declared.filter((takeEffect) => takeEffect === 'next-dispatch')).toHaveLength(1);
        expect(declared.filter((takeEffect) => takeEffect === 'restart' || takeEffect === 'none')).toHaveLength(0);
    });

    it('gives the string field no unit and no numeric bound, and the enum field the four levels', () => {
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
        if (agent?.kind === 'string') {
            expect(agent.format).toContain('no spaces');
        }

        expect(descriptorOf('logLevel')).toMatchObject({
            kind: 'enum',
            unit: null,
            values: ['debug', 'info', 'warn', 'error'],
            default: 'info',
            takesEffect: 'immediate',
        });
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
