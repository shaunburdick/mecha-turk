/**
 * Service entry tests (task T-003): spawn the committed bundle exactly the
 * way the host does and prove the documented lifecycle end to end.
 *
 * The unit suites exercise the server in-process; this is the only test that
 * proves the *entry* — the `isEntryPoint` guard, the `--node` ESM bundle, the
 * documented environment (`PATH`, `HOME`, port, token, nothing else), and the
 * `SIGTERM` drain the host's uninstall path depends on. If the guard ever
 * regresses, the host's readiness probe times out and the service is marked
 * `SERVICE_FAILED`, which is precisely the failure this test catches first.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolvePath(import.meta.dirname, '..');

/** Committed bundle the host spawns with the app runtime. */
const ENTRY = resolvePath(ROOT, 'service/main.js');

/** Loopback address the service must bind. */
const HOST = '127.0.0.1';

/** Port value that asks the OS to choose, so the test never races for one. */
const OS_ASSIGNED_PORT = '0';

/** Bearer token the service is spawned with (past the length floor). */
const TOKEN = 'e'.repeat(40);

/** Minimum `OPENCHAMBER_SERVICE_TOKEN` length the service accepts (contract §1 Startup). */
const TOKEN_FLOOR = 32;

/** How long the bundle may take to log its listening port. */
const STARTUP_MS = 8_000;

/** Per-test budget for the full spawn → probe → signal → exit cycle. */
const TEST_MS = 15_000;

/** Process started by the current test. */
let entry: ChildProcess | null = null;

/** Temporary home the current test's store lives under. */
let home: string | null = null;

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork1 = async (): Promise<void> => {
    if (entry !== null) {
        entry.kill('SIGKILL');
        entry = null;
    }

    if (home !== null) {
        await rm(home, { recursive: true, force: true });
        home = null;
    }
};

afterEach(afterEachWork1);

/**
 * Build the environment the host documents for a guest service.
 *
 * `GUEST_SERVICES.md`: only PATH, HOME, temp, locale, and the Windows system
 * variables are copied — the test therefore passes nothing else, so a service
 * that secretly depended on the developer's shell would fail here.
 *
 * @param tempHome - Temporary HOME the store resolves its data directory from.
 * @returns The environment to spawn the bundle with.
 */
function buildEnv(tempHome: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    env.PATH = process.env.PATH;
    env.HOME = tempHome;
    env.OPENCHAMBER_SERVICE_PORT = OS_ASSIGNED_PORT;
    env.OPENCHAMBER_SERVICE_TOKEN = TOKEN;

    return env;
}

/**
 * Read the port the service logs once it is listening.
 *
 * @param child - Spawned bundle, with stdout and stderr piped.
 * @returns The bound port.
 * @throws When the process exits early or never reports a port; the captured
 *   output is included so a failure is debuggable from the test log alone.
 */
function readListeningPort(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => {
            reject(new Error(`service never reported a port: ${output}`));
        }, STARTUP_MS);
        const capture = (chunk: Buffer): void => {
            output += chunk.toString('utf8');
            const match = /"port":(\d+)/.exec(output);
            if (match?.[1] !== undefined) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        };

        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`service exited with code ${code}: ${output}`));
        });
    });
}

/**
 * Wait for the spawned service to exit, capturing everything it printed.
 *
 * Used by the fail-closed startup test, where the *absence* of a listening
 * service is the expectation and the captured output is what proves the
 * refusal was secret-free.
 *
 * @param child - Spawned bundle.
 * @returns The exit code (`null` when killed by a signal) and combined output.
 */
function readExitWithOutput(child: ChildProcess): Promise<{ readonly code: number | null; readonly output: string }> {
    return new Promise((resolve) => {
        let output = '';
        const capture = (chunk: Buffer): void => {
            output += chunk.toString('utf8');
        };

        child.stdout?.on('data', capture);
        child.stderr?.on('data', capture);
        child.once('exit', (code) => {
            resolve({ code, output });
        });
    });
}

/**
 * Wait for the spawned service to exit.
 *
 * @param child - Spawned bundle.
 * @returns The process exit code (`null` when killed by a signal).
 */
function waitForExit(child: ChildProcess): Promise<number | null> {
    return new Promise((resolve) => {
        child.once('exit', (code) => {
            resolve(code);
        });
    });
}

describe('service entry (spawned bundle)', () => {
    it('starts, answers the readiness probe, and drains on S… (+1 cases)', async () => {
        // case: starts, answers the readiness probe, and drains on SIGTERM
        {
            home = await mkdtemp(join(tmpdir(), 'mecha-turk-entry-'));
            entry = spawn(process.execPath, [ENTRY], { env: buildEnv(home), stdio: ['ignore', 'pipe', 'pipe'] });
            const port = await readListeningPort(entry);

            expect(port).toBeGreaterThan(0);
            const authorized = await fetch(`http://${HOST}:${port}/health`, {
                headers: { authorization: `Bearer ${TOKEN}` },
            });
            expect(authorized.status).toBe(200);
            expect(await authorized.json()).toMatchObject({ status: 'ok' });
            const refused = await fetch(`http://${HOST}:${port}/health`);
            expect(refused.status).toBe(401);

            const exited = waitForExit(entry);
            entry.kill('SIGTERM');
            expect(await exited).toBe(0);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: refuses to start on a short service token, exit non-zero, log secret-free (SEC-02a)
        {
            home = await mkdtemp(join(tmpdir(), 'mecha-turk-entry-'));
            const shortToken = 'f'.repeat(TOKEN_FLOOR - 1);
            const env = buildEnv(home);
            env.OPENCHAMBER_SERVICE_TOKEN = shortToken;
            entry = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });

            const { code, output } = await readExitWithOutput(entry);

            expect(code).not.toBe(0);
            expect(output).toContain('OPENCHAMBER_SERVICE_TOKEN');
            expect(output).not.toContain(shortToken);
            expect(output).not.toContain('listening');
        }
    },
    TEST_MS,);
});
