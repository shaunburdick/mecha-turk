/**
 * Append-only NDJSON persistence for the service's audit trail.
 *
 * The audit home is a line-oriented log rather than a rewritten document
 * (FR-033/FR-035): entries are appended with `O_APPEND` + fsync so an entry
 * either reaches disk whole or not at all, and existing entries are never
 * rewritten. A torn final line — a crash mid-append — is counted as
 * `malformed` on read and skipped; it can never make the reader throw, so an
 * interrupted boot still shows the history it has (never fail-stuck).
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { parseJsonText } from '../json.ts';
import { DATA_DIR_MODE, DATA_FILE_MODE, ensureDir } from './dir.ts';
import { StorageUnavailableError } from './errors.ts';
import { removeIfPresent, readTextFile } from './files.ts';
import { TEMP_SUFFIX, writeSyncedTempFile } from './json.ts';

/**
 * Outcome of reading an NDJSON file.
 *
 * @typeParam T - Entry shape produced by the caller's parser.
 */
export interface NdjsonReadResult<T> {
    /** Entries that parsed and passed the caller's shape check, in file order. */
    readonly entries: readonly T[];
    /** Lines that could not be used (torn write or wrong shape); skipped, never thrown. */
    readonly malformed: number;
}

/**
 * Append one JSON document as a single NDJSON line.
 *
 * @param filePath - Absolute path of the log file; parents are created `0700`.
 * @param entry - Any JSON-serialisable entry.
 * @throws {StorageUnavailableError} When the file cannot be opened or written;
 *   an already-reported storage failure is rethrown unchanged rather than
 *   wrapped twice.
 */
export async function appendJsonLine(filePath: string, entry: unknown): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    try {
        await fs.mkdir(dirname(filePath), { recursive: true, mode: DATA_DIR_MODE });
        const handle = await fs.open(filePath, 'a', DATA_FILE_MODE);
        try {
            await handle.writeFile(line, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        if (error instanceof StorageUnavailableError) {
            throw error;
        }

        throw new StorageUnavailableError(`log line cannot be appended: ${filePath}`, error);
    }
}

/**
 * Replace a line file atomically: temp file, fsync, rename.
 *
 * The exact three-syscall pattern {@link writeJsonAtomic} uses, applied to an
 * NDJSON document so a **rewriting** pass (006's retention trim) gets the same
 * crash guarantee an ordinary JSON write gets: the file is either the old one
 * or the new one, never a torn half-trail (constitution Principle III; 006
 * FR-055's "replaced atomically"). The mode is `0600` *before* the rename, so
 * the pre-rename window never widens the trail to anyone but the owner
 * (SEC-13 rule 1), and a failed rename removes the temporary rather than
 * leaving debris beside a trail that still holds its old bytes.
 *
 * @param filePath - Absolute path of the line file to replace or create.
 * @param entries - JSON-serialisable entries, written one per line in order.
 * @throws {StorageUnavailableError} When the directory cannot be created or
 *   the file cannot be written; the previous contents are left untouched.
 */
export async function writeJsonLinesAtomic(filePath: string, entries: readonly unknown[]): Promise<void> {
    const text = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
    const tempPath = `${filePath}${TEMP_SUFFIX}${randomUUID()}`;
    // `ensureDir` chmods after mkdir so `0700` survives a permissive umask,
    // the same guarantee `writeJsonAtomic` gives the store directory.
    await ensureDir(dirname(filePath));
    try {
        await writeSyncedTempFile(tempPath, text);
        await fs.rename(tempPath, filePath);
    } catch (error) {
        await removeIfPresent(tempPath);
        throw new StorageUnavailableError(`store file cannot be written: ${filePath}`, error);
    }
}

/**
 * Read every usable line of an NDJSON file.
 *
 * @param filePath - Absolute path of the log file.
 * @param parse - Shape check for one parsed document; return `null` to count
 *   the line as malformed.
 * @returns The entries plus the count of lines that could not be used.
 * @throws {StorageUnavailableError} When the file exists but cannot be read.
 */
export async function readJsonLines<T>(
    filePath: string,
    parse: (raw: unknown) => T | null,
): Promise<NdjsonReadResult<T>> {
    const text = await readTextFile(filePath);
    if (text === null) {
        return { entries: [], malformed: 0 };
    }

    const entries: T[] = [];
    let malformed = 0;
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }

        const parsed = parseJsonText(trimmed);
        const value = parsed.ok ? parse(parsed.value) : null;
        if (value === null) {
            malformed += 1;
            continue;
        }

        entries.push(value);
    }

    return { entries, malformed };
}
