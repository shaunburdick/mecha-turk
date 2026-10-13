/**
 * Append-only NDJSON persistence for the service's audit trail.
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
 * Replace a line file atomically: temp file, fsync, rename — the exact
 * three-syscall pattern {@link writeJsonAtomic} uses, so a **rewriting**
 * retention trim gets the crash guarantee an ordinary JSON write gets: old
 * file or new one, never a torn half-trail (constitution III; 006 FR-055).
 * The mode is `0600` *before* the rename, so the pre-rename window never
 * widens the trail to anyone but the owner (SEC-13 rule 1), and a failed
 * rename removes the temporary rather than leaving debris.
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
