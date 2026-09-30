/**
 * The configuration audit row (006 T-015; FR-048, FR-070 – FR-074; AC-113,
 * AC-127, AC-135, AC-136, AC-137, AC-139, SC-109, SC-110; 003 FR-052/FR-061).
 *
 * The five properties a durable record of a settings change has to have, each
 * driven against the real loopback service on a temp-directory store:
 *
 * 1. **One row per change**, with one `{field, from, to}` triple per changed
 *    field, ordered by field name, plus each changed field's take-effect class
 *    (AC-135, SC-109).
 * 2. **Zero rows for a write that changed nothing** (AC-127, FR-048).
 * 3. **One value-free row per refusal** — the issue count, the documented
 *    field names, `<withheld>` for a foreign key, and *no* submitted value of
 *    any kind, with the stored document byte-identical afterwards (AC-136,
 *    AC-113, FR-072).
 * 4. **Its own correlation id**: never a run's, excluded from a run-filtered
 *    read (AC-137, SC-110, FR-074).
 * 5. **A failed append is surfaced, not swallowed** — the write still stands,
 *    the answer says `auditWritten: false`, and a structured warn names the
 *    loss (AC-139, FR-070's edge case).
 *
 * Offline: temp directories, a fake host environment, no GitHub, no network.
 */

import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_FILE, appendAudit, readAuditEntries } from '../service/audit.ts';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../service/config.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
import { openStore } from '../service/store/index.ts';
import type { AuditEntry } from '../service/audit.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Path of the configuration resource. */
const CONFIG_PATH = '/v1/config';

/** Correlation id shape the service mints for a run; a config row's is not one. */
const RUN_ID_PATTERN = /^mt-run-[0-9a-f]{24}$/;

/** The run identifier the dispatch row in the correlation case carries. */
const RUN_CORRELATION = 'mt-run-0123456789abcdef01234567';

/** Field name an operator might invent, which must never reach the row. */
const FOREIGN_KEY = 'surprise';

/** Value that key carries; it must never reach the row either. */
const FOREIGN_VALUE = 'landed-here';

/** The vocabulary name 002 reserved for a configuration write (FR-070). */
const CONFIG_CHANGED_EVENT = 'config.changed';

/** A level outside the closed set; it must never reach the row. */
const BAD_LEVEL = 'verbose';

/** A value outside `intervalMs`'s bounds; it must never reach the row. */
const ABSURD_INTERVAL = 999_999_999;

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the fixtures and the service share. */
let dataDir = '';

/** Services started by a case, shut down with the fixture. */
const running: TestService[] = [];

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-config-audit-'));
    dataDir = join(tempRoot, 'store');
    await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
    for (const service of running.splice(0)) {
        await service.shutdown();
    }

    await rm(tempRoot, { recursive: true, force: true });
});

/** One `PUT /v1/config` answer. */
interface PutAnswer {
    /** The configuration the service says is in force. */
    readonly config: unknown;
    /** Whether the `config.changed` row reached disk (contract §4). */
    readonly auditWritten: boolean;
}

/**
 * Start a service against the fixture directory.
 *
 * @returns The running instance, already registered for shutdown.
 */
async function startService(): Promise<TestService> {
    const service = await startTestService({ dataDir });
    running.push(service);

    return service;
}

/**
 * The service's open store, asserted present.
 *
 * @param service - The running instance.
 * @returns Its store handle.
 */
function storeOf(service: TestService): NonNullable<TestService['handle']['store']> {
    const { store } = service.handle;
    if (store === null) {
        throw new Error('fixture service has no store');
    }

    return store;
}

/**
 * Read every row the trail holds.
 *
 * @param service - The running instance.
 * @returns The rows, oldest first.
 */
async function trailOf(service: TestService): Promise<readonly AuditEntry[]> {
    return await readAuditEntries(storeOf(service));
}

/**
 * Send one whole-document replacement.
 *
 * @param service - The running instance.
 * @param body - The complete document to write.
 * @returns The parsed answer plus its status.
 */
async function putConfig(
    service: TestService,
    body: unknown,
): Promise<{ readonly status: number; readonly answer: PutAnswer }> {
    const response = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(body) });

    return { status: response.status, answer: (await response.json()) as PutAnswer };
}

/**
 * The rows that record a configuration write.
 *
 * @param trail - The trail to filter.
 * @returns The `config.changed` rows, oldest first.
 */
function configRows(trail: readonly AuditEntry[]): readonly AuditEntry[] {
    return trail.filter((entry) => entry.eventType === CONFIG_CHANGED_EVENT);
}

describe('an accepted write records exactly one applied row (006 T-015, AC-135, SC-109)', () => {
    it('records one triple per changed field, ordered by name, with each class', async () => {
        const service = await startService();

        const { status, answer } = await putConfig(service, {
            ...DEFAULT_CONFIG,
            intervalMs: 30_000,
            logLevel: 'debug',
        });

        expect(status).toBe(200);
        expect(answer.auditWritten).toBe(true);
        const rows = configRows(await trailOf(service));
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.eventType).toBe(CONFIG_CHANGED_EVENT);
        expect(row?.actorSource).toBe('operator');
        expect(row?.entity).toEqual({ kind: 'service', id: 'configuration' });
        expect(row?.decision).toBe('applied');
        expect(row?.reason).toBe('configuration replaced');
        expect(row?.details.changes).toEqual([
            { field: 'intervalMs', from: 60_000, to: 30_000 },
            { field: 'logLevel', from: 'info', to: 'debug' },
        ]);
        expect(row?.details.takesEffect).toEqual({ intervalMs: 'next-cycle', logLevel: 'immediate' });
        // Its own identifier: a configuration change belongs to no run.
        expect(row?.correlationId).not.toMatch(RUN_ID_PATTERN);
    });

    it('records nothing for a write that changed nothing (006 T-015, AC-127, FR-048)', async () => {
        const service = await startService();
        const replacement = { ...DEFAULT_CONFIG, intervalMs: 30_000 };
        const first = await putConfig(service, replacement);
        expect(first.answer.auditWritten).toBe(true);
        const afterFirst = await trailOf(service);

        const second = await putConfig(service, replacement);

        expect(second.status).toBe(200);
        expect(second.answer.auditWritten).toBe(true);
        expect(second.answer.config).toEqual(replacement);
        expect(await trailOf(service)).toEqual(afterFirst);
        expect(configRows(await trailOf(service))).toHaveLength(1);
    });
});

describe('a refused write records one value-free row (006 T-015, AC-136, AC-113, FR-072)', () => {
    it('carries the count and the documented names, and no submitted value', async () => {
        const seed = await openStore({ dataDir });
        await seed.writeJson(CONFIG_FILE, DEFAULT_CONFIG);
        const before = await readFile(join(dataDir, CONFIG_FILE), 'utf8');
        const service = await startService();
        const refused = {
            ...DEFAULT_CONFIG,
            intervalMs: ABSURD_INTERVAL,
            logLevel: BAD_LEVEL,
            retryBaseMs: 60_000,
            retryMaxMs: 5_000,
            expectedAgent: '   ',
            [FOREIGN_KEY]: FOREIGN_VALUE,
        };

        const { status } = await putConfig(service, refused);

        expect(status).toBe(422);
        // Nothing was written: the stored document is byte-for-byte what it was.
        expect(await readFile(join(dataDir, CONFIG_FILE), 'utf8')).toBe(before);
        const rows = configRows(await trailOf(service));
        expect(rows).toHaveLength(1);
        const [row] = rows;
        expect(row?.decision).toBe('refused');
        expect(row?.reason).toBe('configuration refused');
        // Exactly the two members the contract names — no length, no hash, and
        // no member that could carry a value back out of the submission.
        expect(Object.keys(row?.details ?? {})).toEqual(['issueCount', 'fields']);
        expect(row?.details.issueCount).toBe(5);
        expect(row?.details.fields).toEqual([
            'intervalMs',
            'logLevel',
            'expectedAgent',
            'retryMaxMs',
            '<withheld>',
        ]);
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain(String(ABSURD_INTERVAL));
        expect(serialized).not.toContain(BAD_LEVEL);
        expect(serialized).not.toContain(FOREIGN_KEY);
        expect(serialized).not.toContain(FOREIGN_VALUE);
        expect(serialized).not.toContain('   ');
    });
});

describe('correlation discipline (006 T-015, AC-137, SC-110, FR-074)', () => {
    it('keeps its own identifier and stays out of a run-filtered read', async () => {
        const service = await startService();
        const { store } = service.handle;
        if (store === null) {
            throw new Error('fixture service has no store');
        }
        await appendAudit(store, {
            eventType: 'dispatch.claimed',
            actorSource: 'panel',
            entity: { kind: 'run', id: RUN_CORRELATION },
            correlationId: RUN_CORRELATION,
            reason: 'fixture dispatch row',
        });

        await putConfig(service, { ...DEFAULT_CONFIG, perPage: 12 });

        const rows = configRows(await trailOf(service));
        expect(rows).toHaveLength(1);
        const configId = rows[0]?.correlationId ?? '';
        expect(configId).not.toBe(RUN_CORRELATION);
        expect(configId).not.toMatch(RUN_ID_PATTERN);
        // A run-filtered read answers the run's rows and never this one.
        const runResponse = await service.call(`${AUDIT_PATH}?correlationId=${RUN_CORRELATION}`);
        const runView = (await runResponse.json()) as {
            readonly entries: readonly AuditEntry[];
            readonly count: number;
        };
        expect(runView.count).toBeGreaterThan(0);
        expect(runView.entries.some((entry) => entry.eventType === CONFIG_CHANGED_EVENT)).toBe(false);
        // Under its own identifier the row is retrievable, alone.
        const ownResponse = await service.call(`${AUDIT_PATH}?correlationId=${configId}`);
        const ownView = (await ownResponse.json()) as {
            readonly entries: readonly AuditEntry[];
            readonly count: number;
        };
        expect(ownView.count).toBe(1);
        expect(ownView.entries[0]?.eventType).toBe(CONFIG_CHANGED_EVENT);
    });
});

describe('a failing append is surfaced, never rolled back (006 T-015, AC-139)', () => {
    it('answers success with auditWritten false and one structured warn', async () => {
        const service = await startService();
        const store = storeOf(service);
        const append = store.appendLine.bind(store);
        store.appendLine = async (path: string, entry: unknown): Promise<void> => {
            if (path === AUDIT_FILE) {
                throw new Error('disk full');
            }

            await append(path, entry);
        };
        const replacement = { ...DEFAULT_CONFIG, intervalMs: 45_000 };

        const { status, answer } = await putConfig(service, replacement);

        expect(status).toBe(200);
        expect(answer.auditWritten).toBe(false);
        // The write stands: it is the durable record, and a missing row is not
        // a reason to undo it (FR-047, FR-070's edge case).
        expect(answer.config).toEqual(replacement);
        const stored = await readFile(join(dataDir, CONFIG_FILE), 'utf8');
        expect(JSON.parse(stored) as unknown).toEqual(replacement);
        expect(configRows(await trailOf(service))).toEqual([]);
        expect(service.logLines.some((line) => line.includes('configuration change could not be recorded'))).toBe(true);
    });
});
