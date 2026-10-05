/**
 * The harness's own teardown contract: a temp tree goes away even when the
 * service that owned it has not finished writing into it.
 *
 * `tests/service-bindings.test.ts` T-005 ("writes zero rows when a restarted
 * service sees an unchanged file") failed in CI run 37339321097 with
 * `ENOTEMPTY: directory not empty, rmdir '/tmp/mecha-turk-service-…/store'`
 * thrown from `afterEach`, after every assertion in the test had passed. The
 * cause is structural rather than unlucky. `startService` arms its first scan
 * cycle fire-and-forget; `shutdown()` stops the scheduler from re-arming but
 * does not await a cycle already in flight; and an instance **restarted over an
 * existing store** is the one shape that scans on that immediate cycle, because
 * a first instance's cycle runs before its fixture has seeded a binding. So the
 * cycle's `scan-state.json` write can land while the teardown is deleting the
 * very directory it belongs in.
 *
 * Two halves answer that, and each is pinned here so neither can be dropped
 * without a test saying so: a removal that tolerates the straggler, and a
 * harness whose default poller never leaves the process — which is also the
 * invariant AGENTS.md asks of every suite.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCAN_STATE_FILE } from '../service/poll/scan.ts';
import { openStore } from '../service/store/index.ts';
import { writeFixtureBindings } from './support/binding-fixture.ts';
import { makeTempTree, removeTempTree } from './support/temp-tree.ts';
import { startTestService } from './support/service.ts';
import {
    REGISTERED_TOKEN,
    USER_OK,
    postVerify,
    running,
    startWithGitHub,
    stopAllServices,
    verifyBody,
    waitFor,
} from './support/verify.ts';

/** Binding the restarted instance finds, and the account it scans under. */
const BINDING_ID = 'bdg_teardown';

/** Files seeded into the tree so the removal walk outlasts a writer's first tick. */
const SEEDED_FILE_COUNT = 400;

/** Milliseconds between straggler writes; short enough to land mid-walk. */
const STRAGGLER_INTERVAL_MS = 2;

/** Straggler writes before it gives up, so the retry budget has a bounded straggler to absorb. */
const STRAGGLER_WRITE_LIMIT = 50;

/** Host the harness's own calls go to; the only one this suite may reach. */
const LOOPBACK_HOST = '127.0.0.1';

afterEach(stopAllServices);

/** Resolve after the given delay, so a fixture can stay on its own clock. */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Seed a directory with enough files that its removal takes real work.
 *
 * @param dir - Directory to fill; created if absent.
 * @param count - How many files to write.
 */
async function seedFiles(dir: string, count: number): Promise<void> {
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: count }, (_unused, index) =>
        writeFile(join(dir, `seed-${index}.json`), '{}')));
}

/**
 * Keep creating files under a directory until it disappears or the limit is hit.
 *
 * The bound is the point: an unbounded writer would outlast any retry budget and
 * leave the test measuring the writer instead of the removal.
 *
 * @param dir - Directory to write into, until it is gone.
 * @param limit - Most files to write before giving up.
 * @returns How many files were written.
 */
async function straggleInto(dir: string, limit: number): Promise<number> {
    let written = 0;

    for (let tick = 0; tick < limit; tick += 1) {
        await delay(STRAGGLER_INTERVAL_MS);
        try {
            await writeFile(join(dir, `straggler-${tick}.json`), '{}');
            written += 1;
        } catch {
            // The directory is gone: the removal won, and this suite is done.
            break;
        }
    }

    return written;
}

/** The absolute URL a recorded `fetch` call went to, in whatever form it was passed. */
function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
}

/** A `fetch` spy that records every host this process asked for. */
function recordHosts(): { readonly hosts: () => readonly string[]; readonly restore: () => void } {
    const spy = vi.spyOn(globalThis, 'fetch');

    return {
        hosts: () => [...new Set(spy.mock.calls.map(([input]) => new URL(urlOf(input)).hostname))],
        restore: () => {
            spy.mockRestore();
        },
    };
}

/**
 * Start an instance holding the account and active binding a restart scans.
 *
 * @returns The data directory the next instance can be started over.
 */
async function seedBoundStore(): Promise<string> {
    const { service } = await startWithGitHub({ user: USER_OK });
    const store = await openStore({ dataDir: service.dataDir });
    const registered = await postVerify(service, verifyBody(REGISTERED_TOKEN));

    expect(registered.status).toBe(201);
    await writeFixtureBindings(store, [BINDING_ID]);

    return service.dataDir;
}

describe('the shared removal policy', () => {
    it('removes a tree while a straggler is still writing into it', async () => {
        const root = await makeTempTree('harness-rm');
        const store = join(root, 'store');
        await seedFiles(store, SEEDED_FILE_COUNT);

        const straggler = straggleInto(store, STRAGGLER_WRITE_LIMIT);
        await removeTempTree(root);
        await straggler;

        expect(existsSync(root)).toBe(false);
    });
});

describe('a service restarted over a store that already holds a binding', () => {
    it('scans without leaving the process, and tears the tree down', async () => {
        const recorded = recordHosts();
        let dataDir = '';

        try {
            dataDir = await seedBoundStore();
            const restarted = await startTestService({ dataDir });
            running.push(restarted);
            await restarted.handle.reconciled;

            // The restarted instance's immediate cycle finds the binding and
            // records its scan state: the write this suite exists for.
            expect(await waitFor(() => existsSync(join(dataDir, SCAN_STATE_FILE)))).toBe(true);
            expect(recorded.hosts().filter((host) => host !== LOOPBACK_HOST)).toEqual([]);
        } finally {
            recorded.restore();
            await stopAllServices();
        }

        expect(existsSync(dataDir)).toBe(false);
    });
});
