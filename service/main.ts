/**
 * Service entry point — the file the host spawns, committed already built
 * and importable without opening a port.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServiceEnv } from './env.ts';
import { createLogger, describeError } from './log.ts';
import { startService } from './server.ts';
import { resolveDataDir } from './store/index.ts';
import type { ServiceLogger } from './log.ts';
import type { ServiceHandle } from './server.ts';

/** How long a graceful shutdown may linger before the process forces an exit. */
const FORCE_EXIT_MS = 5_000;

/**
 * Detect whether this module is the process entry point.
 */
function isEntryPoint(): boolean {
    const entry = process.argv[1];

    return entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url);
}

/**
 * Guarantee the process exits even if a socket refuses to let go.
 *
 * The timer is unref'd, so it never keeps an otherwise-idle process alive —
 * it only fires when something else is still holding the event loop open.
 */
function scheduleForceExit(log: ServiceLogger): void {
    const watchdog = setTimeout(() => {
        log.warn('forcing exit after graceful shutdown');
        // The app OpenChamber spawns, not a library, and some unnamed handle
        // still holds the loop open — returning would wedge the shutdown.
        // eslint-disable-next-line unicorn/no-process-exit -- a CLI app, not a library, and no handle closes by name.
        process.exit(process.exitCode ?? 0);
    }, FORCE_EXIT_MS);
    watchdog.unref();
}

/**
 * Drain the service and record how the process should exit.
 */
async function stopService(handle: ServiceHandle, log: ServiceLogger): Promise<void> {
    try {
        await handle.shutdown();
        process.exitCode = 0;
        scheduleForceExit(log);
    } catch (error) {
        process.exitCode = 1;
        log.error('shutdown failed', { error: describeError(error) });
    }
}

/**
 * Build the listener for one shutdown signal.
 */
function createShutdownHandler(handle: ServiceHandle, log: ServiceLogger): (label: string) => void {
    return (label: string): void => {
        log.info('shutdown requested', { signal: label });
        void stopService(handle, log);
    };
}

/**
 * Wire `SIGTERM` and `SIGINT` to the graceful shutdown path.
 */
function installSignalHandlers(handle: ServiceHandle, log: ServiceLogger): void {
    const onShutdown = createShutdownHandler(handle, log);
    process.once('SIGTERM', () => {
        onShutdown('SIGTERM');
    });
    process.once('SIGINT', () => {
        onShutdown('SIGINT');
    });
}

/**
 * Start the service from the host-provided environment.
 *
 * Every failure is caught, logged as one structured line, and reflected in
 * `process.exitCode`, so the host sees a crashed start as `SERVICE_FAILED`
 * instead of a silent hang.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export async function runService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const log = createLogger({ level: 'info' });
    try {
        const serviceEnv = readServiceEnv(env);
        const dataDir = resolveDataDir(env);
        const handle = await startService({ env: serviceEnv, dataDir, log });
        installSignalHandlers(handle, log);
        log.info('service listening', { port: handle.port, dataDir: handle.dataDir });
    } catch (error) {
        process.exitCode = 1;
        log.error('service failed to start', { error: describeError(error) });
    }
}

// The host runs `node service/main.js` directly; tests import this module for
// its exports without opening a port.
if (isEntryPoint()) {
    void runService();
}
