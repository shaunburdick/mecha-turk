/**
 * Durable store foundation tests (task T-005).
 *
 * Everything the store promises to the rest of the service is asserted here
 * against the real filesystem in a throwaway temp directory: owner-only
 * modes, atomic replacement, corruption quarantine (never fail-stuck), the
 * NDJSON audit line, and the documented `storage-unavailable` failure when the
 * directory cannot be used at all (FR-039, data-model.md storage tier 1).
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRecord } from '../extension/service/json.ts';
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../extension/service/store/dir.ts';
import { readJsonFile, writeJsonAtomic } from '../extension/service/store/json.ts';
import { appendJsonLine, readJsonLines } from '../extension/service/store/ndjson.ts';
import {
    openStore,
    resolveDataDir,
    SERVICE_SCHEMA_VERSION,
    StorageUnavailableError,
} from '../extension/service/store/index.ts';

/** Filesystem mask covering the low nine mode bits (`rwx` for owner/group/other). */
const PERMISSION_BASE = 0o1000;

/** Store file asserted in several read/write cases. */
const CONFIG_FILE = 'config.json';

/** Audit log asserted in several append/read cases. */
const AUDIT_FILE = 'audit.ndjson';

/** Schema marker asserted in several open/reopen cases. */
const STATE_FILE = 'state.json';

/** Path inside the temp root that stands in for an unwritable parent. */
const BLOCKING_FILE = 'not-a-directory';

/** Relative store location under the operator home directory (research R2). */
const STORE_RELATIVE_PATH = '.config/openchamber/mecha-turk';

/** Environment the host would provide, built without quoting non-camel keys. */
function homeEnv(home: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    env.HOME = home;

    return env;
}

/** Reject any document whose `intervalMs` is not a number. */
function numericInterval(raw: unknown): Record<string, unknown> | null {
    return isRecord(raw) && typeof raw.intervalMs === 'number' ? raw : null;
}

/** Temporary directory created per test. */
let tempRoot = '';

/** Absolute path of the store inside the temp directory. */
let dataDir = '';

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-store-'));
    dataDir = join(tempRoot, 'store');
    await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Read the permission bits of a path.
 *
 * @param target - Absolute path to inspect.
 * @returns The mode masked to the low nine `rwx` bits.
 */
async function modeOf(target: string): Promise<number> {
    const info = await stat(target);

    return info.mode % PERMISSION_BASE;
}

describe('data directory resolution', () => {
    it('uses the documented default under $HOME', () => {
        expect(resolveDataDir(homeEnv('/home/operator'))).toBe(resolve('/home/operator', STORE_RELATIVE_PATH));
    });

    it('fails closed when the service environment has no HOME', () => {
        expect(() => resolveDataDir({})).toThrow(StorageUnavailableError);
        expect(() => resolveDataDir(homeEnv(''))).toThrow(StorageUnavailableError);
    });
});

describe('store open', () => {
    it('creates the data directory owner-only', async () => {
        const freshDir = join(tempRoot, 'fresh-store');
        await openStore({ dataDir: freshDir });

        expect(await modeOf(freshDir)).toBe(DATA_DIR_MODE);
    });

    it('records the schema version in state.json', async () => {
        const store = await openStore({ dataDir });
        const state = JSON.parse(await readFile(join(dataDir, STATE_FILE), 'utf8')) as Record<string, unknown>;

        expect(store.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
        expect(state.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
        expect(typeof state.initializedAt).toBe('string');
        expect(await modeOf(join(dataDir, STATE_FILE))).toBe(DATA_FILE_MODE);
    });

    it('replaces an unreadable state.json instead of failing stuck', async () => {
        await openStore({ dataDir });
        await writeFile(join(dataDir, STATE_FILE), '{"schemaVersion": 1', 'utf8');

        const store = await openStore({ dataDir });
        const files = await readdir(dataDir);

        expect(store.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
        expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
        expect(files).toContain(STATE_FILE);
    });
});

describe('atomic json writes', () => {
    it('writes files owner-only and leaves no temporary behind', async () => {
        const store = await openStore({ dataDir });
        await store.writeJson(CONFIG_FILE, { intervalMs: 60_000 });

        expect(await modeOf(join(dataDir, CONFIG_FILE))).toBe(DATA_FILE_MODE);
        const files = await readdir(dataDir);
        expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('replaces an existing document in one rename', async () => {
        const target = join(dataDir, CONFIG_FILE);
        await writeJsonAtomic(target, { revision: 1 });
        await writeJsonAtomic(target, { revision: 2 });

        const result = await readJsonFile(target, (raw) => (isRecord(raw) ? raw : null));
        expect(result).toEqual({ status: 'ok', value: { revision: 2 } });
        const files = await readdir(dataDir);
        expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('reports a missing document as absent', async () => {
        const result = await readJsonFile(join(dataDir, CONFIG_FILE), () => null);

        expect(result).toEqual({ status: 'absent' });
    });

    it('quarantines a torn document and keeps serving', async () => {
        const target = join(dataDir, CONFIG_FILE);
        await writeFile(target, '{"intervalMs": 60_00', 'utf8');

        const result = await readJsonFile(target, () => null);

        expect(result.status).toBe('quarantined');
        if (result.status === 'quarantined') {
            expect(result.quarantinePath).toContain('.corrupt-');
            await expect(stat(result.quarantinePath)).resolves.toBeDefined();
        }

        // Not fail-stuck: the same path is immediately writable again.
        await writeJsonAtomic(target, { intervalMs: 60_000 });
        const repaired = await readJsonFile(target, numericInterval);
        expect(repaired.status).toBe('ok');
    });

    it('quarantines a document its validator rejects', async () => {
        const target = join(dataDir, CONFIG_FILE);
        await writeFile(target, '{"intervalMs":"soon"}', 'utf8');

        const result = await readJsonFile(target, numericInterval);

        expect(result.status).toBe('quarantined');
    });

    it('ignores a leftover temporary file when reading', async () => {
        await writeFile(join(dataDir, `${CONFIG_FILE}.tmp.deadbeef`), 'not json', 'utf8');

        const result = await readJsonFile(join(dataDir, CONFIG_FILE), () => null);

        expect(result).toEqual({ status: 'absent' });
    });

    it('refuses paths that escape the data directory', async () => {
        const store = await openStore({ dataDir });

        await expect(store.writeJson('../escape.json', {})).rejects.toThrow(/relative path/);
        await expect(store.readJson('/etc/passwd', () => null)).rejects.toThrow(/relative path/);
    });
});

describe('ndjson audit lines', () => {
    it('appends owner-only lines and reads them back', async () => {
        const store = await openStore({ dataDir });
        await store.appendLine(AUDIT_FILE, { seq: 1, eventType: 'service.started' });
        await store.appendLine(AUDIT_FILE, { seq: 2, eventType: 'config.changed' });

        const result = await store.readLines(AUDIT_FILE, (raw) => (isRecord(raw) ? raw : null));

        expect(result.malformed).toBe(0);
        expect(result.entries.map((entry) => entry.seq)).toEqual([1, 2]);
        expect(await modeOf(join(dataDir, AUDIT_FILE))).toBe(DATA_FILE_MODE);
    });

    it('skips a torn trailing line instead of throwing', async () => {
        const target = join(dataDir, AUDIT_FILE);
        await appendJsonLine(target, { seq: 1 });
        await writeFile(target, '{"seq": 2, "eventType": "config.', { flag: 'a' });

        const result = await readJsonLines(target, (raw) => (isRecord(raw) ? raw : null));

        expect(result.entries.map((entry) => entry.seq)).toEqual([1]);
        expect(result.malformed).toBe(1);
    });

    it('treats a missing log as empty', async () => {
        const result = await readJsonLines(join(dataDir, AUDIT_FILE), () => null);

        expect(result).toEqual({ entries: [], malformed: 0 });
    });
});

describe('unwritable data directory', () => {
    it('reports storage-unavailable instead of crashing', async () => {
        const blockingPath = join(tempRoot, BLOCKING_FILE);
        await writeFile(blockingPath, 'i am a file', 'utf8');

        const failure = await openStore({ dataDir: join(blockingPath, 'store') }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(StorageUnavailableError);
        expect(failure).toHaveProperty('code', 'storage-unavailable');
    });
});
