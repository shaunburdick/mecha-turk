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
import type { Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonText } from '../json.ts';
import { DATA_FILE_MODE, ensureDir } from './dir.ts';
import { StorageUnavailableError } from './errors.ts';
import { isMissingFile, readTextFile, removeIfPresent } from './files.ts';

/** Marks a file that was set aside because it could not be understood. */
const QUARANTINE_MARKER = '.corrupt-';

/**
 * Suffix distinguishing an in-flight write from its committed target.
 *
 * Exported so the line-file writer in `ndjson.ts` builds the *same* temp name
 * this writer does — one spelling, one debris pattern for the startup sweep
 * (`isTempDebris`), and no second guess about the shape an interrupted write
 * leaves behind.
 */
export const TEMP_SUFFIX = '.tmp';

/** Indentation used so store files stay readable for the operator. */
const JSON_INDENT = 2;

/** The quarantine member of {@link JsonReadResult}, named for reuse. */
interface QuarantinedOutcome {
    readonly status: 'quarantined';
    /**
     * Where the evidence went, or `null` when another reader set it aside first.
     *
     * A lost rename race is still a quarantine: the document *was* unusable
     * and *was* set aside — by the winning reader, under that reader's own
     * name — so only the path to it is unknown here. Reporting `absent` for
     * that case would tell the operator (and `configFromStore`'s `source`) that
     * nothing was ever wrong, which the contract's "invalid file ⇒
     * `quarantined`" rule refuses (006 contract §3 rule 9).
     */
    readonly quarantinePath: string | null;
}

/**
 * Outcome of reading one store file.
 *
 * - `ok` — parsed and accepted by the caller's validator.
 * - `absent` — no file yet, the normal first-run state (the read itself found
 *   nothing: the file never existed, or an earlier process renamed it away).
 * - `quarantined` — the file was unusable and is now set aside; the path says
 *   where the evidence went, or is `null` when a concurrent reader won the
 *   rename race and the evidence sits under that reader's name instead.
 */
export type JsonReadResult<T> =
    | QuarantinedOutcome
    | { readonly status: 'ok'; readonly value: T }
    | { readonly status: 'absent' };

/**
 * Write text to a fresh file and flush it to disk before it is renamed.
 *
 * The mode is passed to `open` explicitly: `0600` must hold whatever umask the
 * host runtime runs with, so the pre-rename window never exposes the bytes to
 * anyone but the owner (SEC-13 rule 1). Tests observe that window directly by
 * calling this function against a path inside the target directory.
 *
 * @param tempPath - Absolute path of the temporary file to create.
 */
export async function writeSyncedTempFile(tempPath: string, text: string): Promise<void> {
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
 * @returns The quarantine outcome carrying the new path, or the same
 *   quarantine with a `null` path when a concurrent reader renamed the file
 *   first — the document was invalid and has been set aside either way, so
 *   the *fact* never degrades to absence and only the path is unknown
 *   (006 contract §3 rule 9: invalid file ⇒ `quarantined`).
 * @throws {StorageUnavailableError} When the rename fails for any reason other
 *   than that disappearance, because a file the service cannot read *and*
 *   cannot set aside means the store is unusable — that is a storage failure to
 *   surface, not a state to keep retrying.
 */
async function quarantine(
    filePath: string,
): Promise<QuarantinedOutcome> {
    const quarantinePath = `${filePath}${QUARANTINE_MARKER}${Date.now()}-${randomUUID()}`;
    try {
        await fs.rename(filePath, quarantinePath);
    } catch (error) {
        // Two readers can reject the same document at the same moment — the
        // poll cycle reading the configuration while an operator's request
        // reads it, say — and whichever renames second finds the file already
        // gone under the winner's name. The evidence exists (this reader read
        // it and proved it unusable before the rename), so the answer stays
        // `quarantined`: only the path is unknown, because the file is now
        // named for the winner. It is still not a failure either — a request
        // is never answered `503 storage-unavailable` because it lost a race it
        // did not need to win (FR-039: absence and failure are different
        // facts, and only the second is a setup error).
        if (isMissingFile(error)) {
            return { status: 'quarantined', quarantinePath: null };
        }

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
    // `ensureDir` chmods after mkdir so `0700` survives a permissive umask,
    // the same guarantee the store directory itself gets at startup (SEC-13).
    await ensureDir(dirname(filePath));
    try {
        await writeSyncedTempFile(tempPath, text);
        await fs.rename(tempPath, filePath);
    } catch (error) {
        await removeIfPresent(tempPath);
        throw new StorageUnavailableError(`store file cannot be written: ${filePath}`, error);
    }
}

/** Name shape of an orphaned temporary file left behind by an interrupted write. */
const TEMP_DEBRIS_PATTERN = /\.tmp[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** How deep the startup sweep descends (`accounts/`, `checkpoints/`, `runs/`, `rate/`). */
const SWEEP_MAX_DEPTH = 3;

/**
 * Recognise the temporary file of an interrupted write.
 *
 * Readers ignore these by construction (they open exact target names), so the
 * only thing left to do with one is sweep it — it must never shadow a real
 * target or linger world-readable (contract §6 rule 5).
 *
 * @param name - File name inside the store.
 * @returns `true` for `<target>.tmp<uuid>` debris.
 */
export function isTempDebris(name: string): boolean {
    return TEMP_DEBRIS_PATTERN.test(name);
}

/**
 * Remove orphaned temporary files under a directory, recursively but bounded.
 *
 * @param dirPath - Absolute directory to sweep; a missing one sweeps nothing.
 * @param depth - Remaining recursion depth.
 * @returns How many debris files were removed (removal is best-effort).
 */
export async function sweepTempDebris(dirPath: string, depth: number = SWEEP_MAX_DEPTH): Promise<number> {
    if (depth < 0) {
        return 0;
    }

    let entries: Dirent[];
    try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
        // Absent or unreadable: there is nothing to sweep, and the open path
        // is the place that reports storage trouble, not the cleanup.
        return 0;
    }

    let removed = 0;
    for (const entry of entries) {
        const target = join(dirPath, entry.name);
        if (entry.isDirectory()) {
            removed += await sweepTempDebris(target, depth - 1);
        } else if (entry.isFile() && isTempDebris(entry.name)) {
            removed += 1;
            await removeIfPresent(target);
        }
    }

    return removed;
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
