import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Throwaway directory trees for tests that need a real filesystem.
 *
 * Twenty-six suites each created one with `mkdtemp` and removed it in an
 * `afterEach`. That is twenty-six chances to type one half of the option pair
 * wrongly, and a teardown that omits `force` fails the whole run on a directory
 * another test is still holding open. Both halves live here so a suite cannot
 * get one without the other.
 */

/**
 * Create a fresh temp directory whose name carries the calling suite's prefix.
 *
 * The prefix is what makes a leaked tree identifiable after a crashed run — with
 * twenty-six of these possible, `mecha-turk-a1b2c3` says nothing about which
 * suite abandoned it.
 *
 * @param prefix - Suite-identifying fragment for the directory name.
 * @returns The absolute path to the new directory.
 */
export async function makeTempTree(prefix: string): Promise<string> {
    return await mkdtemp(join(tmpdir(), `mecha-turk-${prefix}-`));
}

/**
 * Remove a temp tree and everything under it.
 *
 * @param root - Directory {@link makeTempTree} returned.
 */
export async function removeTempTree(root: string): Promise<void> {
    await rm(root, { recursive: true, force: true });
}
