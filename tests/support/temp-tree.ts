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

/** A temp tree and the `store/` child a service resolves its data directory from. */
export interface StoreTree {
    /** The temp root, to hand to {@link removeTempTree}. */
    readonly root: string;
    /** The child directory the store writes into. */
    readonly dataDir: string;
}

/**
 * A temp tree with the `store/` child every service suite needs inside it.
 *
 * Twenty suites wrote the same two lines and then spelled the child's name
 * themselves. The name is not cosmetic: it is what a hand-rolled path in a test
 * has to match, and what `openStore({ dataDir })` is then pointed at — so a suite
 * that spelled it differently from its neighbour would fail in a way that reads
 * like a service bug.
 *
 * @param prefix - Suite-identifying fragment for the directory name.
 * @returns The root and its `store/` child.
 */
export async function makeStoreTree(prefix: string): Promise<StoreTree> {
    const root = await makeTempTree(prefix);
    return { root, dataDir: join(root, 'store') };
}
