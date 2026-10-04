/**
 * Shared harness for the loopback service tests.
 *
 * The harness reproduces what `GUEST_SERVICES.md` says the host provides —
 * `OPENCHAMBER_SERVICE_PORT`, `OPENCHAMBER_SERVICE_TOKEN`, and a `HOME` the
 * store resolves its data directory from — then starts the real server on an
 * OS-assigned port. Nothing here is mocked: every test in this suite talks to
 * the same `http.Server` the host would talk to, which is the only way the
 * transport invariants (uniform 401, body cap, drain) mean anything.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServiceEnv } from '../../service/env.ts';
import { createLogger } from '../../service/log.ts';
import { startService } from '../../service/server.ts';
import type { GitHubVerifier } from '../../service/github.ts';
import type { GitHubIssuePoller } from '../../service/poll/poller-github.ts';
import type { ServiceHandle } from '../../service/server.ts';
import { offlineVerifier } from './github.ts';

/** Port value the harness hands the service so the OS picks one. */
const OS_ASSIGNED_PORT = '0';

/** Loopback address every harness connection uses. */
const HOST = '127.0.0.1';

/** Token length in bytes; hex-encoded it is well past the service minimum. */
const TOKEN_BYTES = 24;

/** Prefix under the system temp directory for each harness instance. */
const TEMP_PREFIX = 'mecha-turk-service-';

/** Options accepted by {@link startTestService}. */
export interface StartTestServiceOptions {
    /** Data directory to serve; defaults to a fresh temp directory. */
    readonly dataDir?: string;
    /** Extra environment merged over the harness defaults (env overrides). */
    readonly env?: Readonly<Record<string, string | undefined>>;
    /**
     * GitHub verifier handed to the credential routes (T-007/T-008).
     *
     * Defaults to a verifier whose `fetch` never leaves the test process, so
     * no suite run can reach the network; a test that needs GitHub behaviour
     * injects one over `createGitHubVerifier(fakeGitHub(...).fetch)`.
     */
    readonly github?: GitHubVerifier;
    /**
     * GitHub issue poller the background scan loop runs under.
     *
     * Defaults to the process `fetch`-backed poller, exactly as production
     * does. A harness whose fixture seeds an active binding injects an
     * offline one instead: `startService` arms its first scan cycle
     * fire-and-forget, so with a real poller that cycle reaches GitHub and
     * writes `scan-state.json` on a schedule no shutdown drains — the
     * ENOTEMPTY teardown race this option exists to remove.
     */
    readonly poller?: GitHubIssuePoller;
}

/** A running service instance plus everything a test needs to poke it. */
export interface TestService {
    /** Origin the service answers on, e.g. `http://127.0.0.1:41234`. */
    readonly baseUrl: string;
    /** Bearer token the harness started the service with. */
    readonly token: string;
    /** Data directory the service was pointed at. */
    readonly dataDir: string;
    /** Lines the capturing logger has received, in order. */
    readonly logLines: readonly string[];
    /** Handle to the running instance (port, store, shutdown). */
    readonly handle: ServiceHandle;
    /** `fetch` with the bearer token already attached. */
    call(path: string, init?: RequestInit): Promise<Response>;
    /** Drain the service (requests and startup reconciliation) and remove the temp directory it owned. */
    shutdown(): Promise<void>;
}

/** Options for a raw HTTP/1.1 exchange (targets and bodies fetch cannot send). */
export interface RawExchangeOptions {
    /** Port to connect to. */
    readonly port: number;
    /** Complete request text; must end with `Connection: close` so the reply ends too. */
    readonly requestText: string;
}

/**
 * Start the real service against a fake host environment.
 *
 * @param options - Optional data directory and environment overrides.
 * @returns The running instance and its captured log lines.
 */
export async function startTestService(options: StartTestServiceOptions = {}): Promise<TestService> {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const home = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    const env: Record<string, string | undefined> = {};
    env.HOME = home;
    env.OPENCHAMBER_SERVICE_PORT = OS_ASSIGNED_PORT;
    env.OPENCHAMBER_SERVICE_TOKEN = token;
    Object.assign(env, options.env ?? {});
    const dataDir = options.dataDir ?? join(home, 'store');
    const logLines: string[] = [];
    const log = createLogger({
        level: 'debug',
        sink: (line) => {
            logLines.push(line);
        },
    });
    const handle = await startService({
        env: readServiceEnv(env),
        dataDir,
        log,
        github: options.github ?? offlineVerifier(),
        ...(options.poller !== undefined && { poller: options.poller }),
    });
    const baseUrl = `http://${HOST}:${handle.port}`;

    return {
        baseUrl,
        token,
        dataDir,
        logLines,
        handle,
        call: async (path, init = {}) =>
            await fetch(`${baseUrl}${path}`, {
                ...init,
                headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
            }),
        shutdown: async () => {
            await handle.shutdown();
            // `startService` starts startup reconciliation *after* the listener
            // binds and never awaits it (readiness must not wait on GitHub),
            // and `handle.shutdown()` does not drain it either. The harness
            // awaits it here so a reconcile write can never land under the
            // removal below.
            await handle.reconciled;
            await rm(home, { recursive: true, force: true });
        },
    };
}

/**
 * Send a raw HTTP/1.1 request and collect the reply as text.
 *
 * Tests use this for anything `fetch` refuses to build: absolute-form or
 * protocol-relative targets, overlong paths, and bodies attached to `GET`.
 *
 * @param options - Port plus the complete request text.
 * @returns The raw response, terminated when the server closes the socket.
 */
export async function rawExchange(options: RawExchangeOptions): Promise<string> {
    return await new Promise((resolve, reject) => {
        const socket = connect(options.port, HOST);
        let received = '';
        socket.on('connect', () => {
            socket.write(options.requestText);
        });
        socket.on('data', (chunk: Buffer) => {
            received += chunk.toString('utf8');
        });
        socket.on('end', () => {
            resolve(received);
        });
        socket.on('error', (error: Error) => {
            reject(error);
        });
    });
}
