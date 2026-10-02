/**
 * Durable store foundation tests (task T-005).
 *
 * Everything the store promises to the rest of the service is asserted here
 * against the real filesystem in a throwaway temp directory: owner-only
 * modes, atomic replacement, corruption quarantine (never fail-stuck), the
 * NDJSON audit line, and the documented `storage-unavailable` failure when the
 * directory cannot be used at all (FR-039, data-model.md storage tier 1).
 */

import { promises as fs } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRecord } from '../service/json.ts';
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../service/store/dir.ts';
import { isTempDebris, readJsonFile, writeJsonAtomic, writeSyncedTempFile } from '../service/store/json.ts';
import { appendJsonLine, readJsonLines } from '../service/store/ndjson.ts';
import {
    openStore,
    resolveDataDir,
    SERVICE_SCHEMA_VERSION,
    StorageUnavailableError,
} from '../service/store/index.ts';

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

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-store-'));
    dataDir = join(tempRoot, 'store');
    await mkdir(dataDir, { recursive: true });
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

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
    it('uses the documented default under $HOME (+1 cases)', async () => {
        // case: uses the documented default under $HOME
        {
            expect(resolveDataDir(homeEnv('/home/operator'))).toBe(resolve('/home/operator', STORE_RELATIVE_PATH));
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: fails closed when the service environment has no HOME
        {
            expect(() => resolveDataDir({})).toThrow(StorageUnavailableError);
            expect(() => resolveDataDir(homeEnv(''))).toThrow(StorageUnavailableError);
        }
    });
});

describe('store open', () => {
    it('creates the data directory owner-only (+2 cases)', async () => {
        // case: creates the data directory owner-only
        {
            const freshDir = join(tempRoot, 'fresh-store');
            await openStore({ dataDir: freshDir });

            expect(await modeOf(freshDir)).toBe(DATA_DIR_MODE);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: records the schema version in state.json
        {
            const store = await openStore({ dataDir });
            const state = JSON.parse(await readFile(join(dataDir, STATE_FILE), 'utf8')) as Record<string, unknown>;

            expect(store.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
            expect(state.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
            expect(typeof state.initializedAt).toBe('string');
            expect(await modeOf(join(dataDir, STATE_FILE))).toBe(DATA_FILE_MODE);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: replaces an unreadable state.json instead of failing stuck
        {
            await openStore({ dataDir });
            await writeFile(join(dataDir, STATE_FILE), '{"schemaVersion": 1', 'utf8');

            const store = await openStore({ dataDir });
            const files = await readdir(dataDir);

            expect(store.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
            expect(files.some((name) => name.includes('.corrupt-'))).toBe(true);
            expect(files).toContain(STATE_FILE);
        }
    });
});

describe('atomic json writes', () => {
    it('writes files owner-only and leaves no temporary behi… (+5 cases)', async () => {
        // case: writes files owner-only and leaves no temporary behind
        {
            const store = await openStore({ dataDir });
            await store.writeJson(CONFIG_FILE, { intervalMs: 60_000 });

            expect(await modeOf(join(dataDir, CONFIG_FILE))).toBe(DATA_FILE_MODE);
            const files = await readdir(dataDir);
            expect(files.filter((name) => isTempDebris(name))).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: replaces an existing document in one rename
        {
            const target = join(dataDir, CONFIG_FILE);
            await writeJsonAtomic(target, { revision: 1 });
            await writeJsonAtomic(target, { revision: 2 });

            const result = await readJsonFile(target, (raw) => (isRecord(raw) ? raw : null));
            expect(result).toEqual({ status: 'ok', value: { revision: 2 } });
            const files = await readdir(dataDir);
            expect(files.filter((name) => isTempDebris(name))).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: reports a missing document as absent
        {
            const result = await readJsonFile(join(dataDir, CONFIG_FILE), () => null);

            expect(result).toEqual({ status: 'absent' });
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: quarantines a torn document and keeps serving
        {
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
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: quarantines a document its validator rejects
        {
            const target = join(dataDir, CONFIG_FILE);
            await writeFile(target, '{"intervalMs":"soon"}', 'utf8');

            const result = await readJsonFile(target, numericInterval);

            expect(result.status).toBe('quarantined');
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: reports absence when another reader set the file aside first
        {
            const target = join(dataDir, CONFIG_FILE);
            await writeFile(target, '{"intervalMs": 60_00', 'utf8');
            // Two readers can both reject the same document — a cycle reading the
            // configuration while the operator's request reads it, say — and the
            // loser's rename finds the file already gone. That is absence, not a
            // storage failure: the evidence is on disk under the winner's name.
            const rename = vi
                .spyOn(fs, 'rename')
                .mockRejectedValue(Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }));

            try {
                const result = await readJsonFile(target, numericInterval);
                expect(result).toEqual({ status: 'absent' });
            } finally {
                rename.mockRestore();
            }
        }
    });

    it('ignores a leftover temporary file when reading (+1 cases)', async () => {
        // case: ignores a leftover temporary file when reading
        {
            await writeFile(join(dataDir, `${CONFIG_FILE}.tmp.deadbeef`), 'not json', 'utf8');

            const result = await readJsonFile(join(dataDir, CONFIG_FILE), () => null);

            expect(result).toEqual({ status: 'absent' });
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: refuses paths that escape the data directory
        {
            const store = await openStore({ dataDir });

            await expect(store.writeJson('../escape.json', {})).rejects.toThrow(/relative path/);
            await expect(store.readJson('/etc/passwd', () => null)).rejects.toThrow(/relative path/);
        }
    });
});

describe('ndjson audit lines', () => {
    it('appends owner-only lines and reads them back (+2 cases)', async () => {
        // case: appends owner-only lines and reads them back
        {
            const store = await openStore({ dataDir });
            await store.appendLine(AUDIT_FILE, { seq: 1, eventType: 'service.started' });
            await store.appendLine(AUDIT_FILE, { seq: 2, eventType: 'config.changed' });

            const result = await store.readLines(AUDIT_FILE, (raw) => (isRecord(raw) ? raw : null));

            expect(result.malformed).toBe(0);
            expect(result.entries.map((entry) => entry.seq)).toEqual([1, 2]);
            expect(await modeOf(join(dataDir, AUDIT_FILE))).toBe(DATA_FILE_MODE);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: skips a torn trailing line instead of throwing
        {
            const target = join(dataDir, AUDIT_FILE);
            await appendJsonLine(target, { seq: 1 });
            await writeFile(target, '{"seq": 2, "eventType": "config.', { flag: 'a' });

            const result = await readJsonLines(target, (raw) => (isRecord(raw) ? raw : null));

            expect(result.entries.map((entry) => entry.seq)).toEqual([1]);
            expect(result.malformed).toBe(1);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: treats a missing log as empty
        {
            const result = await readJsonLines(join(dataDir, AUDIT_FILE), () => null);

            expect(result).toEqual({ entries: [], malformed: 0 });
        }
    });
});

describe('atomic line-file rewrites (006 T-011)', () => {
    it('replaces a trail with lines a reader parses back, ow… (+2 cases)', async () => {
        // case: replaces a trail with lines a reader parses back, owner-only
        {
            const store = await openStore({ dataDir });
            await store.appendLine(AUDIT_FILE, { seq: 1, eventType: 'service.started' });

            await store.writeLines(AUDIT_FILE, [
                { seq: 2, eventType: 'config.changed' },
                { seq: 3, eventType: 'audit.trimmed' },
            ]);

            const result = await store.readLines(AUDIT_FILE, (raw) => (isRecord(raw) ? raw : null));
            expect(result.malformed).toBe(0);
            expect(result.entries.map((entry) => entry.seq)).toEqual([2, 3]);
            expect(await modeOf(join(dataDir, AUDIT_FILE))).toBe(DATA_FILE_MODE);
            const files = await readdir(dataDir);
            expect(files.filter((name) => isTempDebris(name))).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: keeps the previous bytes when the rename fails, and leaves no debris
        {
            const store = await openStore({ dataDir });
            await store.writeLines(AUDIT_FILE, [{ seq: 1 }, { seq: 2 }]);
            const before = await readFile(join(dataDir, AUDIT_FILE), 'utf8');
            const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('rename failed'), {
                code: 'EIO',
            }));

            try {
                await expect(store.writeLines(AUDIT_FILE, [{ seq: 9 }])).rejects.toThrow(StorageUnavailableError);
            } finally {
                rename.mockRestore();
            }

            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).toBe(before);
            const files = await readdir(dataDir);
            expect(files.filter((name) => isTempDebris(name))).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: creates a missing trail outright
        {
            const store = await openStore({ dataDir });

            await store.writeLines(AUDIT_FILE, [{ seq: 1 }]);

            const result = await store.readLines(AUDIT_FILE, (raw) => (isRecord(raw) ? raw : null));
            expect(result.entries).toEqual([{ seq: 1 }]);
            expect(await modeOf(join(dataDir, AUDIT_FILE))).toBe(DATA_FILE_MODE);
        }
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

describe('SEC-13 atomic credential window', () => {
    it('creates the temporary file 0600 inside the target di… (+5 cases)', async () => {
        // case: creates the temporary file 0600 inside the target directory before the rename
        {
            const target = join(dataDir, 'accounts', '123.json');
            const tempPath = `${target}.tmpdeadbeef-0000-4000-8000-000000000000`;
            await mkdir(join(dataDir, 'accounts'), { recursive: true });

            await writeSyncedTempFile(tempPath, '{"token":"x"}');

            expect(await modeOf(tempPath)).toBe(DATA_FILE_MODE);
            expect(dirname(tempPath)).toBe(join(dataDir, 'accounts'));
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: ignores the umask when creating that temporary file
        {
            const previousUmask = process.umask(0o000);
            try {
                const target = join(dataDir, 'state.json');
                const tempPath = `${target}.tmpdeadbeef-0000-4000-8000-000000000001`;

                await writeSyncedTempFile(tempPath, '{}');

                expect(await modeOf(tempPath)).toBe(DATA_FILE_MODE);
            } finally {
                process.umask(previousUmask);
            }
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: leaves no temporary debris behind a completed write
        {
            const store = await openStore({ dataDir });

            await store.writeJson('accounts/123.json', { token: 'x' });
            const entries = await readdir(dataDir, { recursive: true });
            const debris = entries.filter((entry) => isTempDebris(String(entry)));

            expect(debris).toEqual([]);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: sweeps orphaned temporary files at startup without touching real ones
        {
            await mkdir(join(dataDir, 'accounts'), { recursive: true });
            const orphanTop = join(dataDir, 'state.json.tmpdeadbeef-0000-4000-8000-000000000002');
            const orphanNested = join(dataDir, 'accounts', '123.json.tmpdeadbeef-0000-4000-8000-000000000003');
            await writeFile(orphanTop, 'half-written', 'utf8');
            await writeFile(orphanNested, 'half-written', 'utf8');
            await writeFile(join(dataDir, 'keepme.json'), '{"keep":true}', 'utf8');

            const store = await openStore({ dataDir });

            expect(store.schemaVersion).toBe(SERVICE_SCHEMA_VERSION);
            await expect(stat(orphanTop)).rejects.toThrow();
            await expect(stat(orphanNested)).rejects.toThrow();
            expect(await readFile(join(dataDir, 'keepme.json'), 'utf8')).toBe('{"keep":true}');
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: corrects a permissive store directory back to owner-only at startup
        {
            await openStore({ dataDir });
            await chmod(dataDir, 0o755);
            expect(await modeOf(dataDir)).not.toBe(DATA_DIR_MODE);

            await openStore({ dataDir });

            expect(await modeOf(dataDir)).toBe(DATA_DIR_MODE);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: reasserts owner-only modes on directories a write creates
        {
            await openStore({ dataDir });
            const previousUmask = process.umask(0o000);
            try {
                const store = await openStore({ dataDir });
                await store.writeJson('accounts/123.json', { token: 'x' });
            } finally {
                process.umask(previousUmask);
            }

            expect(await modeOf(join(dataDir, 'accounts'))).toBe(DATA_DIR_MODE);
        }
    });
});
