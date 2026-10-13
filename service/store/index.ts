/**
 * Durable service store: directory lifecycle, schema version, and the
 * typed file operations every service module shares.
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { nowIso } from '../../src/ids.ts';
import { isRecord } from '../json.ts';
import { ensureDir } from './dir.ts';
import { StorageUnavailableError } from './errors.ts';
import { readJsonFile, sweepTempDebris, writeJsonAtomic } from './json.ts';
import { appendJsonLine, readJsonLines, writeJsonLinesAtomic } from './ndjson.ts';
import type { JsonReadResult } from './json.ts';
import type { NdjsonReadResult } from './ndjson.ts';

/** Schema version this build writes into `state.json` (contract §1 versioning). */
export const SERVICE_SCHEMA_VERSION = 1;

/** The one store file the core owns outright. */
const STATE_FILE = 'state.json';

/** Contents of `state.json`: the schema marker plus when the store was created. */
export interface ServiceState {
    /** Schema version of the files in this store; migrations key off it. */
    readonly schemaVersion: number;
    /** RFC 3339 timestamp of store creation. */
    readonly initializedAt: string;
}

/**
 * The store handle handed to the rest of the service.
 *
 * Paths are relative to the data directory; validators are supplied by the
 * caller so each file type keeps its own shape knowledge.
 */
export interface ServiceStore {
    /** Absolute data directory backing this handle. */
    readonly dataDir: string;
    /** Schema version read from (or written to) `state.json`. */
    readonly schemaVersion: number;
    /**
     * Read one JSON document.
     *
     * @param validate - Shape check; `null` quarantines the file.
     * @returns The stored value, absence, or the quarantine path.
     */
    readJson<T>(relativePath: string, validate: (raw: unknown) => T | null): Promise<JsonReadResult<T>>;
    /**
     * Write one JSON document atomically.
     */
    writeJson(relativePath: string, value: unknown): Promise<void>;
    /**
     * Append one NDJSON line.
     */
    appendLine(relativePath: string, entry: unknown): Promise<void>;
    /**
     * Replace a whole NDJSON file atomically (temp `0600` → fsync → rename).
     *
     * The line-file sibling of {@link writeJson}, for the rewriting passes
     * (the retention trim): the file becomes the new set of entries in one
     * rename, so a crash leaves either the old file or the new one and never a
     * torn half-write.
     */
    writeLines(relativePath: string, entries: readonly unknown[]): Promise<void>;
    /**
     * Read every usable line of an NDJSON file.
     *
     */
    readLines<T>(relativePath: string, parse: (raw: unknown) => T | null): Promise<NdjsonReadResult<T>>;
    /**
     * List the entries of a directory inside the data directory.
     */
    listDir(relativePath: string): Promise<readonly string[]>;
    /**
     * Remove one file inside the data directory; absence is not an error.
     */
    removeFile(relativePath: string): Promise<void>;
}

/**
 * Validate a parsed `state.json` document.
 */
function parseServiceState(raw: unknown): ServiceState | null {
    if (!isRecord(raw)) {
        return null;
    }

    const version = raw.schemaVersion;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
        return null;
    }

    const initializedAt = typeof raw.initializedAt === 'string' ? raw.initializedAt : nowIso();

    return { schemaVersion: version, initializedAt };
}

/**
 * Read the store's schema marker, writing a fresh one when absent or unusable.
 *
 * `state.json` is a marker, not operator data: if it is missing, torn, or was
 * written by a build this one cannot understand, it is replaced rather than
 * quarantined-and-stuck — the history files beside it are untouched either way.
 */
async function readOrCreateSchemaVersion(dataDir: string): Promise<number> {
    const statePath = resolve(dataDir, STATE_FILE);
    const result = await readJsonFile(statePath, parseServiceState);
    if (result.status === 'ok') {
        return result.value.schemaVersion;
    }

    const state: ServiceState = { schemaVersion: SERVICE_SCHEMA_VERSION, initializedAt: nowIso() };
    await writeJsonAtomic(statePath, state);

    return SERVICE_SCHEMA_VERSION;
}

/**
 * Resolve a relative store path inside the data directory, refusing escape.
 *
 */
function resolveStorePath(dataDir: string, relativePath: string): string {
    if (relativePath === '' || isAbsolute(relativePath) || relativePath.includes('..')) {
        throw new Error(`store path must be a relative path inside the data directory: ${relativePath}`);
    }

    return resolve(dataDir, relativePath);
}

/**
 * List the entries of a directory inside the data directory.
 *
 */
async function listStoreDir(dataDir: string, relativePath: string): Promise<readonly string[]> {
    const target = resolveStorePath(dataDir, relativePath);
    try {
        return await fs.readdir(target);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return [];
        }

        throw new StorageUnavailableError(`store directory cannot be listed: ${target}`, error);
    }
}

/**
 * Remove a file inside the data directory.
 */
async function removeStoreFile(dataDir: string, relativePath: string): Promise<void> {
    const target = resolveStorePath(dataDir, relativePath);
    try {
        await fs.rm(target, { force: true });
    } catch (error) {
        throw new StorageUnavailableError(`store file cannot be removed: ${target}`, error);
    }
}

/**
 * Bind store operations to one data directory.
 *
 * @returns The handle whose paths resolve inside `dataDir` only.
 */
function createStore(dataDir: string, schemaVersion: number): ServiceStore {
    const locate = (relativePath: string): string => resolveStorePath(dataDir, relativePath);

    return {
        dataDir,
        schemaVersion,
        readJson: async (relativePath, validate) => await readJsonFile(locate(relativePath), validate),
        writeJson: async (relativePath, value) => await writeJsonAtomic(locate(relativePath), value),
        appendLine: async (relativePath, entry) => await appendJsonLine(locate(relativePath), entry),
        writeLines: async (relativePath, entries) => await writeJsonLinesAtomic(locate(relativePath), entries),
        readLines: async (relativePath, parse) => await readJsonLines(locate(relativePath), parse),
        listDir: async (relativePath) => await listStoreDir(dataDir, relativePath),
        removeFile: async (relativePath) => await removeStoreFile(dataDir, relativePath),
    };
}

/**
 * Open (creating if needed) the durable store at a data directory.
 *
 * Startup does the two housekeeping steps before anything else can
 * read: it verifies (and corrects) the owner-only directory mode through
 * {@link ensureDir}, and sweeps temporary debris an interrupted write left
 * behind so a crash can never leave stale partial files lying around.
 *
 * @returns A handle bound to that directory with `state.json` initialised.
 */
export async function openStore(options: { readonly dataDir: string }): Promise<ServiceStore> {
    const { dataDir } = options;
    await ensureDir(dataDir);
    await sweepTempDebris(dataDir);
    const schemaVersion = await readOrCreateSchemaVersion(dataDir);

    return createStore(dataDir, schemaVersion);
}

export { resolveDataDir } from './dir.ts';
export { StorageUnavailableError, STORAGE_UNAVAILABLE_CODE } from './errors.ts';
export type { JsonReadResult, NdjsonReadResult };
