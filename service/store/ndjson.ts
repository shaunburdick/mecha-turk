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

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { parseJsonText } from '../json.ts';
import { DATA_DIR_MODE, DATA_FILE_MODE } from './dir.ts';
import { StorageUnavailableError } from './errors.ts';
import { readTextFile } from './files.ts';

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
