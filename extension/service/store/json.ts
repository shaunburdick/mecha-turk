/**
 * Atomic JSON persistence with corruption quarantine.
 *
 * Every store write goes to a temporary sibling file (mode `0600`, fsynced),
 * is renamed over the target, and only then is considered done: a crash or
 * power loss can leave a `.tmp` file behind but never a half-written
 * `config.json` (constitution Principle III — durable and idempotent work).
 * Readers never throw on bad *content*: an unparseable or schema-invalid file
 * is renamed aside as `*.corrupt-<timestamp>-<uuid>` and reported as
 * `quarantined`, so the service keeps running and the operator keeps the
 * evidence (corruption quarantine, never fail-stuck).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { parseJsonText } from '../json.ts';
import { DATA_DIR_MODE, DATA_FILE_MODE } from './dir.ts';
import { StorageUnavailableError } from './errors.ts';
import { readTextFile, removeIfPresent } from './files.ts';

/** Marks a file that was set aside because it could not be understood. */
const QUARANTINE_MARKER = '.corrupt-';

/** Suffix distinguishing an in-flight write from its committed target. */
const TEMP_SUFFIX = '.tmp';

/** Indentation used so store files stay readable for the operator. */
const JSON_INDENT = 2;

/** The quarantine member of {@link JsonReadResult}, named for reuse. */
interface QuarantinedOutcome {
    readonly status: 'quarantined';
    readonly quarantinePath: string;
}

/**
 * Outcome of reading one store file.
 *
 * - `ok` — parsed and accepted by the caller's validator.
 * - `absent` — no file yet, the normal first-run state.
 * - `quarantined` — the file was unusable and has been renamed aside; the
 *   path says where the evidence went.
 */
export type JsonReadResult<T> =
    | { readonly status: 'ok'; readonly value: T }
    | { readonly status: 'absent' }
    | QuarantinedOutcome;

/**
 * Write text to a fresh file and flush it to disk before it is renamed.
 *
 * @param tempPath - Absolute path of the temporary file to create.
 * @param text - Serialized content to write.
 */
async function writeAndSync(tempPath: string, text: string): Promise<void> {
    const handle = await fs.open(tempPath, 'w', DATA_FILE_MODE);
    try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/**
 * Rename an unusable file aside and report where it went.
 *
 * @param filePath - Absolute path of the file to quarantine.
 * @returns The quarantine outcome carrying the new path.
 * @throws {StorageUnavailableError} When the rename fails, because a file the
 *   service cannot read *and* cannot set aside means the store is unusable —
 *   that is a storage failure to surface, not a state to keep retrying.
 */
async function quarantine(filePath: string): Promise<QuarantinedOutcome> {
    const quarantinePath = `${filePath}${QUARANTINE_MARKER}${Date.now()}-${randomUUID()}`;
    try {
        await fs.rename(filePath, quarantinePath);
    } catch (error) {
        throw new StorageUnavailableError(`unusable store file cannot be set aside: ${filePath}`, error);
    }

    return { status: 'quarantined', quarantinePath };
}

/**
 * Write a JSON document atomically: temp file, fsync, rename.
 *
 * @param filePath - Absolute path of the file to replace or create.
 * @param value - Any JSON-serialisable value.
 * @throws {StorageUnavailableError} When the directory cannot be created or
 *   the file cannot be written; a leftover temporary file is cleaned up first.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const text = `${JSON.stringify(value, null, JSON_INDENT)}\n`;
    const tempPath = `${filePath}${TEMP_SUFFIX}${randomUUID()}`;
    await fs.mkdir(dirname(filePath), { recursive: true, mode: DATA_DIR_MODE });
    try {
        await writeAndSync(tempPath, text);
        await fs.rename(tempPath, filePath);
    } catch (error) {
        await removeIfPresent(tempPath);
        throw new StorageUnavailableError(`store file cannot be written: ${filePath}`, error);
    }
}

/**
 * Read and validate a store file, quarantining it when it cannot be used.
 *
 * @param filePath - Absolute path of the file to read.
 * @param validate - Shape check run against the parsed document; return
 *   `null` to reject it as unusable (which quarantines the file).
 * @returns The stored value, absence, or the quarantine path.
 * @throws {StorageUnavailableError} When the file exists but the filesystem
 *   refuses to read it, or when the quarantine rename itself fails.
 */
export async function readJsonFile<T>(
    filePath: string,
    validate: (raw: unknown) => T | null,
): Promise<JsonReadResult<T>> {
    const text = await readTextFile(filePath);
    if (text === null) {
        return { status: 'absent' };
    }

    const parsed = parseJsonText(text);
    if (!parsed.ok) {
        return await quarantine(filePath);
    }

    const value = validate(parsed.value);
    if (value === null) {
        return await quarantine(filePath);
    }

    return { status: 'ok', value };
}
