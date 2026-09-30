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

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, parseStoredConfig, validateConfig } from '../service/config.ts';
import { SERVICE_SCHEMA_VERSION } from '../service/store/index.ts';
import type { ServiceConfig } from '../service/config.ts';
import type { ServiceStatusBody } from '../service/routes/status.ts';
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

    it.each(OUT_OF_BOUNDS)('rejects $field = $value with a named remediation', ({ field, value }) => {
        const result = validateConfig({ ...DEFAULT_CONFIG, [field]: value });

        expect(result.ok).toBe(false);
        if (!result.ok) {
            const issue = result.issues.find((candidate) => candidate.field === field);
            expect(issue?.remediation).toContain(field);
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

        expect(result).toEqual({ ...PRE_RUN_LAYER_CONFIG, leaseMs: 120_000, resultDeadlineMs: 120_000 });
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
        expect(body.config).toEqual({ ...PRE_RUN_LAYER_CONFIG, leaseMs: 120_000, resultDeadlineMs: 120_000 });
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
