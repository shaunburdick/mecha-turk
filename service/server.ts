/**
 * Loopback HTTP server lifecycle: bind, serve, drain, close.
 *
 * `startService` opens the durable store (a failed open is not fatal — the
 * process must stay up so the panel can show *why* setup is incomplete), wires
 * the pipeline, and binds `127.0.0.1` on the port the host reserved. Shutdown
 * is graceful in three bounded steps: stop accepting, let in-flight requests
 * finish (the drain the contract's SIGTERM path expects), then drop idle
 * keep-alive sockets and finally any connection that outlived the deadline —
 * so checkpoints and audit writes are never cut off mid-flight.
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { reconcileInterruptedAccounts } from './accounts/reconcile.ts';
import { createGitHubVerifier } from './github.ts';
import type { GitHubIssuePoller } from './poll/poller-github.ts';
import { LOOPBACK_HOST } from './http.ts';
import { createRequestHandler } from './pipeline.ts';
import { ROUTES } from './routes/index.ts';
import { startSweep, sweepOnce } from './poll/sweep.ts';
import { startPollLoop, createDefaultPoller } from './poll/timer.ts';
import type { SweepLoop, SweepOutcome } from './poll/sweep.ts';
import type { PollLoop } from './poll/timer.ts';
import { openStore, SERVICE_SCHEMA_VERSION, StorageUnavailableError } from './store/index.ts';
import { createVerifyThrottle } from './throttle.ts';
import type { ReconcileSummary } from './accounts/reconcile.ts';
import type { GitHubVerifier } from './github.ts';
import type { PipelineDeps, PipelineState } from './pipeline.ts';
import type { ServiceEnv } from './env.ts';
import type { ServiceLogger } from './log.ts';
import type { RouteContext } from './routes/types.ts';
import type { ServiceStore } from './store/index.ts';

/** How long shutdown waits for in-flight requests before forcing sockets closed. */
const DRAIN_TIMEOUT_MS = 5_000;

/** How long shutdown waits for the listener to finish closing. */
const CLOSE_TIMEOUT_MS = 5_000;

/** Poll interval while waiting for the in-flight counter to reach zero. */
const DRAIN_POLL_MS = 25;

/** Construction options for a service instance. */
export interface StartServiceOptions {
    /** Validated host environment (bind port + bearer token). */
    readonly env: ServiceEnv;
    /** Absolute data directory; created and initialised on start. */
    readonly dataDir: string;
    /** Structured logger shared by the pipeline and routes. */
    readonly log: ServiceLogger;
    /**
     * GitHub verifier for the credential routes and startup reconciliation.
     *
     * Defaults to the process `fetch`-backed client; tests inject a fake so
     * no suite run ever reaches the network.
     */
    readonly github?: GitHubVerifier;
    /**
     * GitHub issue poller for the M1 loop (MVP re-cut).
     *
     * Defaults to the process `fetch`-backed poller; tests inject a fake so
     * no suite run ever reaches the network.
     */
    readonly poller?: GitHubIssuePoller;
}

/** Handle to a running service instance. */
export interface ServiceHandle {
    /** Port actually bound (resolved when the port came from the OS). */
    readonly port: number;
    /** Data directory this instance serves. */
    readonly dataDir: string;
    /** Open store, or `null` when the directory was unusable at start. */
    readonly store: ServiceStore | null;
    /**
     * Settles when the F13 startup reconciliation pass has finished.
     *
     * The pass runs *after* the listener is accepting connections, so
     * readiness is never held open behind an upstream call; tests await this
     * before asserting on post-crash account states.
     */
    readonly reconciled: Promise<ReconcileSummary>;
    /**
     * Settles with the boot sweep's outcome.
     *
     * The sweep is awaited *before* the listener binds (FR-032), so by the time
     * a port is reachable a stranded claim has already been recovered; this
     * promise is the observable form of that ordering, and answers an empty
     * summary when the store was unusable.
     */
    readonly swept: Promise<SweepOutcome>;
    /** Drain in-flight requests and close the listener; safe to call twice. */
    shutdown(): Promise<void>;
}

/** Parts the handle closure reads; bundled to keep construction to one parameter. */
interface HandleParts {
    readonly server: Server;
    readonly state: PipelineState;
    readonly store: ServiceStore | null;
    readonly dataDir: string;
    readonly port: number;
    readonly reconciled: Promise<ReconcileSummary>;
    readonly swept: Promise<SweepOutcome>;
    /** Poll loop handle, or `null` when there was no store to poll with. */
    readonly poll?: PollLoop | null;
    /** Lease/deadline sweep handle, or `null` when there was no store. */
    readonly sweep?: SweepLoop | null;
}

/**
 * Open the durable store, degrading instead of failing the process.
 *
 * @param options - Start options carrying the data directory and logger.
 * @returns The open store, or `null` when the directory is unusable (the
 *   reason is logged; store-backed routes then answer `503`).
 */
async function openStoreSafe(options: StartServiceOptions): Promise<ServiceStore | null> {
    try {
        return await openStore({ dataDir: options.dataDir });
    } catch (error) {
        if (!(error instanceof StorageUnavailableError)) {
            throw error;
        }

        options.log.error('store unavailable', { dataDir: options.dataDir, error: error.message });

        return null;
    }
}

/**
 * Bind the listener to `127.0.0.1`.
 *
 * @param server - Server to start listening.
 * @param port - Port from the host environment (`0` = OS-assigned).
 * @returns Resolves once the listener is accepting connections.
 * @throws When the port cannot be bound (already taken, or not permitted).
 */
function listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            reject(error);
        };
        server.once('error', onError);
        server.listen(port, LOOPBACK_HOST, () => {
            server.removeListener('error', onError);
            resolve();
        });
    });
}

/**
 * Read the bound port from a listening server.
 *
 * @param server - Server that has finished listening.
 * @returns The TCP port number.
 * @throws {Error} When the server is listening on something other than TCP.
 */
function boundPort(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('service is not listening on a TCP port');
    }

    return address.port;
}

/**
 * Wait for a fixed interval.
 *
 * @param milliseconds - Delay before resolving.
 * @returns A promise that resolves after the delay.
 */
function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * Wait until no request is in flight, or the deadline passes.
 *
 * @param state - Pipeline counter to watch.
 * @param timeoutMs - Maximum time to wait.
 */
async function waitForDrain(state: PipelineState, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (state.inFlight > 0 && Date.now() < deadline) {
        await sleep(DRAIN_POLL_MS);
    }
}

/**
 * Await a promise but give up after a deadline.
 *
 * @param promise - Promise that may hang (the listener's close callback).
 * @param timeoutMs - Maximum time to wait for it.
 */
async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            resolve();
        }, timeoutMs);
    });
    await Promise.race([promise, deadline]);
    if (timer !== undefined) {
        clearTimeout(timer);
    }
}

/** Parts one shutdown needs; bundled so a drain is one call. */
interface ShutdownInput {
    /** Listener to close. */
    readonly server: Server;
    /** Pipeline counter the drain waits on. */
    readonly state: PipelineState;
    /** Poll loop to stop first, or `null` when none was started. */
    readonly poll: PollLoop | null;
    /** Sweep timer to stop with the poll loop, or `null` when none started. */
    readonly sweep: SweepLoop | null;
}

/**
 * Drain and close a server.
 *
 * The poll loop (M1) and the dispatch sweep stop first, so a scheduled cycle
 * cannot race one of its writes against the drain's persistence window.
 *
 * @param input - The listener, the drain counter, the poll loop, and the sweep.
 */
async function performShutdown(input: ShutdownInput): Promise<void> {
    const { server, state, poll, sweep } = input;
    poll?.stop();
    sweep?.stop();
    const closed = new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });
    await waitForDrain(state, DRAIN_TIMEOUT_MS);
    server.closeIdleConnections();
    await withTimeout(closed, CLOSE_TIMEOUT_MS);
    server.closeAllConnections();
    await closed;
}

/**
 * Build the handle callers use to stop this instance.
 *
 * @param parts - Server, counters, and metadata for the handle.
 * @returns The handle; `shutdown()` is idempotent across concurrent calls.
 */
function createHandle(parts: HandleParts): ServiceHandle {
    let closing: Promise<void> | null = null;
    const shutdown = (): Promise<void> => {
        closing ??= performShutdown({
            server: parts.server,
            state: parts.state,
            poll: parts.poll ?? null,
            sweep: parts.sweep ?? null,
        });

        return closing;
    };

    return {
        port: parts.port,
        dataDir: parts.dataDir,
        store: parts.store,
        reconciled: parts.reconciled,
        swept: parts.swept,
        shutdown,
    };
}

/**
 * Kick off the F13 startup reconciliation pass.
 *
 * It never rejects: a reconciliation failure is logged as an error *kind*
 * (never upstream text) and reported as a zeroed summary, so the panel can
 * still learn from the running service.
 *
 * @param store - Open store, or `null` when the directory is unusable.
 * @param github - Verifier used for the re-verification step.
 * @param log - Structured logger.
 * @returns The pass's completion promise.
 */
function startReconciliation(input: {
    /** Open store, or `null` when the directory is unusable. */
    readonly store: ServiceStore | null;
    /** Verifier used for the re-verification step. */
    readonly github: GitHubVerifier;
    /** Structured logger. */
    readonly log: ServiceLogger;
}): Promise<ReconcileSummary> {
    return reconcileInterruptedAccounts(input).catch((error: unknown) => {
        input.log.error('startup reconciliation failed', {
            errorKind: error instanceof Error ? error.name : typeof error,
        });

        return { examined: 0, marked: 0, restored: 0 };
    });
}

/**
 * Recover stranded claims before the first claim can be served (FR-032).
 *
 * The pass is **awaited** here, between opening the store and binding the
 * listener: a panel that closed mid-dispatch must find its work already
 * waiting again when it reconnects, and a run whose lease expired while the
 * service was down must never be offered under a lease that is already stale.
 * A failure is logged and answered with an empty summary rather than thrown —
 * an unreadable store is a degraded start (the routes answer `503`), not a
 * process that refuses to boot.
 *
 * @param input - Open store, or `null` when the directory is unusable.
 * @param log - Structured logger.
 * @returns The pass's completion promise.
 */
function startBootSweep(input: {
    /** Open store, or `null` when the directory is unusable. */
    readonly store: ServiceStore | null;
    /** Structured logger. */
    readonly log: ServiceLogger;
}): Promise<SweepOutcome> {
    if (input.store === null) {
        return Promise.resolve({ recoveries: [] });
    }

    return sweepOnce({ store: input.store, log: input.log }).catch((error: unknown) => {
        input.log.warn('boot sweep failed', { errorKind: error instanceof Error ? error.name : typeof error });

        return { recoveries: [] };
    });
}

/**
 * Start the loopback service.
 *
 * @param options - Environment, data directory, and logger.
 * @returns A handle to the listening instance.
 * @throws When the port cannot be bound; store failures do *not* throw — the
 *   instance starts degraded so the panel can report them.
 */
export async function startService(options: StartServiceOptions): Promise<ServiceHandle> {
    const store = await openStoreSafe(options);
    const github = options.github ?? createGitHubVerifier();
    const state: PipelineState = { inFlight: 0 };
    const context: RouteContext = {
        store,
        dataDir: options.dataDir,
        startedAt: Date.now(),
        log: options.log,
        schemaVersion: SERVICE_SCHEMA_VERSION,
        github,
        throttle: createVerifyThrottle(),
    };
    const deps: PipelineDeps = { env: options.env, context, routes: ROUTES, log: options.log, state };
    const server = createServer(createRequestHandler(deps));
    // FR-032: the sweep runs at service start, before the server accepts a
    // claim, so a restart recovers stranded claims with no operator action.
    const swept = await startBootSweep({ store, log: options.log });
    await listen(server, options.env.port);
    // Reconciliation runs after the listener is up: an upstream call must
    // never hold the host's readiness probe hostage (F16 readiness is about
    // *this* process answering, not about GitHub being reachable).
    const reconciled = startReconciliation({ store, github, log: options.log });
    // M1 loop (MVP re-cut): the timer starts only when a store exists, so a
    // degraded start does not poll. The default interval (60 s) is the
    // contract default; `PUT /v1/config` retunes the next cycle.
    const poll = store === null ? null : startPollLoop({
        store,
        log: options.log,
        poller: options.poller ?? createDefaultPoller(),
    });
    // The lease/deadline sweep keeps running on its own unref'd timer, at
    // half the shorter of the two configured durations.
    const sweep = store === null ? null : startSweep({ store, log: options.log });

    return createHandle({
        server,
        state,
        store,
        dataDir: options.dataDir,
        port: boundPort(server),
        reconciled,
        swept: Promise.resolve(swept),
        poll,
        sweep,
    });
}
