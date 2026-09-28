/**
 * Filesystem primitives shared by the store's JSON and NDJSON writers.
 *
 * Reads distinguish "not there yet" (`ENOENT` → `null`, a normal first-run
 * state) from "cannot be read" (anything else → `StorageUnavailableError`),
 * because the two mean very different things to the service: the first is
 * absence, the second is a setup failure the panel must surface (FR-039).
 */

import { promises as fs } from 'node:fs';
import { StorageUnavailableError } from './errors.ts';

/**
 * Recognise the "no such file" errno Node throws for filesystem calls.
 *
 * @param error - Caught value from a filesystem call.
 * @returns `true` only for `ENOENT`; permission and I/O errors return `false`
 *   so they surface as storage-unavailable instead of silent absence.
 */
function isMissingFile(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Read a UTF-8 file, treating a missing file as absence rather than failure.
 *
 * @param filePath - Absolute path of the file to read.
 * @returns The file's text, or `null` when the file does not exist.
 * @throws {StorageUnavailableError} When the file exists but cannot be read
 *   (permissions, an I/O error, or an unreadable parent directory).
 */
export async function readTextFile(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (isMissingFile(error)) {
            return null;
        }

        throw new StorageUnavailableError(`store file cannot be read: ${filePath}`, error);
    }
}

/**
 * Remove a file when present, never failing the operation that triggered it.
 *
 * Used for temporary-file cleanup, where the original write failure is the
 * error worth reporting and a secondary unlink error would only mask it.
 *
 * @param filePath - Absolute path of the file to remove.
 */
export async function removeIfPresent(filePath: string): Promise<void> {
    try {
        await fs.rm(filePath, { force: true });
    } catch {
        // Best-effort cleanup: callers already hold the failure that matters.
        return;
    }
}
