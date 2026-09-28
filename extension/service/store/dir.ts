/**
 * Data-directory resolution and creation for the service's durable store.
 *
 * The host does not pass `OPENCHAMBER_DATA_DIR` to a guest service — only
 * `PATH`, `HOME`, temp, locale, and Windows system variables are copied
 * (`GUEST_SERVICES.md`) — so the store resolves the documented default data
 * directory itself: `$HOME/.config/openchamber/mecha-turk/`
 * (002 research R2). The resolved path is reported in `GET /v1/status` so an
 * operator running a custom host data directory still knows exactly which
 * folder to back up.
 *
 * The directory is created `0700` and every file the store writes is `0600`
 * (data-model.md conventions): the audit trail and any credential material
 * that later lands here are readable by the operator's account only.
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { StorageUnavailableError } from './errors.ts';

/** Owner-only mode for the store directory. */
export const DATA_DIR_MODE = 0o700;

/** Owner-only mode for every file the store writes. */
export const DATA_FILE_MODE = 0o600;

/** Store location beneath the operator's home directory (002 research R2). */
const STORE_RELATIVE_PATH = '.config/openchamber/mecha-turk';

/**
 * Resolve the durable store directory from the service environment.
 *
 * @param env - Environment as the host provides it; `HOME` is guaranteed
 *   present by `GUEST_SERVICES.md` and is the only key read here.
 * @returns The absolute path of the store directory.
 * @throws {StorageUnavailableError} When `HOME` is missing or empty, so the
 *   failure names the missing variable instead of writing somewhere implicit.
 */
export function resolveDataDir(env: Readonly<Record<string, string | undefined>>): string {
    const home = env.HOME;
    if (home === undefined || home === '') {
        throw new StorageUnavailableError('HOME is not set; the Mecha Turk data directory cannot be located');
    }

    return resolve(home, STORE_RELATIVE_PATH);
}

/**
 * Create a directory (and its parents) and make it owner-only.
 *
 * `mkdir` applies its mode through the process umask, so `chmod` follows to
 * make `0700` explicit: the guarantee must hold whatever umask the host
 * runtime runs with, not just on a default `022` setup.
 *
 * @param dirPath - Absolute directory to create.
 * @throws {StorageUnavailableError} When the directory cannot be created,
 *   for example when a parent path is a regular file or is read-only.
 */
export async function ensureDir(dirPath: string): Promise<void> {
    try {
        await fs.mkdir(dirPath, { recursive: true, mode: DATA_DIR_MODE });
        await fs.chmod(dirPath, DATA_DIR_MODE);
    } catch (error) {
        throw new StorageUnavailableError(`directory cannot be created or made owner-only: ${dirPath}`, error);
    }
}
