/**
 * Data-directory resolution and creation for the service's durable store.
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
 */
export async function ensureDir(dirPath: string): Promise<void> {
    try {
        await fs.mkdir(dirPath, { recursive: true, mode: DATA_DIR_MODE });
        await fs.chmod(dirPath, DATA_DIR_MODE);
    } catch (error) {
        throw new StorageUnavailableError(`directory cannot be created or made owner-only: ${dirPath}`, error);
    }
}
