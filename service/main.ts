/**
 * Service entry point — the file the host spawns.
 *
 * OpenChamber starts `service/main.js` with the app runtime itself
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE`, `GUEST_SERVICES.md`), so this
 * module must be committed already built and must start serving as soon as it
 * runs. It also has to stay importable: the bundle tests load this file to
 * prove it is ESM rather than an IIFE, and loading it must not open a port.
 * The {@link isEntryPoint} guard is what keeps those two behaviours apart —
 * only a process whose `argv[1]` *is* this module starts the server.
 *
 * Shutdown follows the documented lifecycle: the host sends `SIGTERM` on
 * uninstall and on host quit, the service drains in-flight requests, persists
 * through the store's atomic writes, and exits; a watchdog forces the exit if
 * something keeps the loop alive past the drain window.
 *
 * Starting the service also starts its two timers, and the ordering between
 * them and the listener is the dispatch-recovery guarantee (003 FR-032): the
 * lease/deadline sweep runs **once before the HTTP server accepts a claim**, so
 * a claim stranded by a crash or a restart is already recovered when a panel
 * reconnects, and the sweep then keeps its own unref'd timer. Both timers are
 * unref'd and both stop on shutdown.
 */

import path from 'node:path';
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
 *
 * @returns `true` when `argv[1]` resolves to this file, i.e. the host spawned
 *   it directly rather than a test importing it.
 */
function isEntryPoint(): boolean {
    const entry = process.argv[1];

    return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

/**
 * Guarantee the process exits even if a socket refuses to let go.
 *
 * The timer is unref'd, so it never keeps an otherwise-idle process alive —
 * it only fires when something else is still holding the event loop open.
 *
 * @param log - Logger used to record the forced exit.
 */
function scheduleForceExit(log: ServiceLogger): void {
    const watchdog = setTimeout(() => {
        log.warn('forcing exit after graceful shutdown');
        process.exit(process.exitCode ?? 0);
    }, FORCE_EXIT_MS);
    watchdog.unref();
}

/**
 * Drain the service and record how the process should exit.
 *
 * @param handle - Running service to stop.
 * @param log - Logger for the outcome.
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
 *
 * @param handle - Running service to stop.
 * @param log - Logger for the outcome.
 * @returns A listener taking the signal's label for the log entry.
 */
function createShutdownHandler(handle: ServiceHandle, log: ServiceLogger): (label: string) => void {
    return (label: string): void => {
        log.info('shutdown requested', { signal: label });
        void stopService(handle, log);
    };
}

/**
 * Wire `SIGTERM` and `SIGINT` to the graceful shutdown path.
 *
 * @param handle - Running service to stop on signal.
 * @param log - Logger for the shutdown outcome.
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
 *
 * @param env - Environment to read; defaults to `process.env`.
 */
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
