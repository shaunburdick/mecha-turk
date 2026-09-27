/**
 * `GET /v1/status` — the health model the panel renders (contract §2.1).
 *
 * Wave 1 ships the skeleton honestly: the service reports itself, where its
 * data lives, and why nothing is polling yet, while the `accounts`,
 * `repositories`, and `agentPin` sections are present but empty because no
 * account, binding, or agent pin exists before Waves 2–5. Reporting a fixed
 * shape with truthful contents beats a shape that grows under the panel's
 * feet — and `service.status: 'degraded'` with a `null` schema version is how
 * an unusable data directory reaches the operator (FR-039).
 *
 * `surface.supported` is `true` by construction: a service process only runs
 * where the host spawns services (desktop and web), and VS Code and mobile
 * never spawn one, so an answering process cannot be on an unsupported
 * surface — the panel owns the unsupported-surface banner (AC-017).
 */

import { DEFAULT_CONFIG, CONFIG_FILE, configFromStore, parseStoredConfig } from '../config.ts';
import { STATUS } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceConfig } from '../config.ts';
import type { Route, RouteContext } from './types.ts';

/** Path of the status resource. */
export const STATUS_PATH = '/v1/status';

/** Why polling is paused: a fresh store has no accounts to poll for (FR-039). */
const PAUSED_REASON = 'config-incomplete';

/** Health of the service process itself, as `GET /v1/status` reports it. */
export type ServiceHealth = 'ok' | 'degraded';

/** The `GET /v1/status` body, fixed by contract §2.1. */
export interface ServiceStatusBody {
    /** Process health, uptime, data location, and store schema version. */
    readonly service: {
        /** `degraded` when the data directory is unusable. */
        readonly status: ServiceHealth;
        /** Milliseconds since the server started. */
        readonly uptimeMs: number;
        /** Absolute data directory, so operators know what to back up (R2). */
        readonly dataDir: string;
        /** Store schema version, or `null` while the store is unavailable. */
        readonly schemaVersion: number | null;
    };
    /** Per-account identity and rate state; populated once custody lands. */
    readonly accounts: readonly unknown[];
    /** Per-repository poll state; populated once the poller lands. */
    readonly repositories: readonly unknown[];
    /** Agent pin state; `expectedAgent` arrives with the panel's setting mirror. */
    readonly agentPin: {
        /** Expected session agent, `null` until the panel mirrors the setting. */
        readonly expectedAgent: string | null;
        /** Last verification; none exists before the first dispatch. */
        readonly lastVerification: null;
    };
    /** Polling schedule; paused until there is something to poll. */
    readonly polling: {
        /** Effective interval from the configuration. */
        readonly intervalMs: number;
        /** Next scheduled poll; `null` while paused. */
        readonly nextPollAt: null;
        /** Whether polling is currently running. */
        readonly paused: boolean;
        /** Machine-readable reason the panel renders verbatim. */
        readonly pausedReason: string;
    };
    /** Platform support for spawning a service at all. */
    readonly surface: {
        /** Always `true` here; see the module note. */
        readonly supported: boolean;
    };
}

/**
 * Read the configuration the status reports the polling interval from.
 *
 * @param context - Route context carrying the open store.
 * @returns The effective configuration, or defaults when the store is down.
 */
async function readConfig(context: RouteContext): Promise<ServiceConfig> {
    if (context.store === null) {
        return DEFAULT_CONFIG;
    }

    const result = await context.store.readJson(CONFIG_FILE, parseStoredConfig);

    return configFromStore(result, context.log);
}

/**
 * Assemble the status document.
 *
 * @param context - Route context carrying store, clock, and data directory.
 * @returns The health model, with truthful contents for this wave.
 */
async function buildStatusBody(context: RouteContext): Promise<ServiceStatusBody> {
    const config = await readConfig(context);
    const { store } = context;

    return {
        service: {
            status: store === null ? 'degraded' : 'ok',
            uptimeMs: Date.now() - context.startedAt,
            dataDir: context.dataDir,
            schemaVersion: store?.schemaVersion ?? null,
        },
        accounts: [],
        repositories: [],
        agentPin: { expectedAgent: null, lastVerification: null },
        polling: {
            intervalMs: config.intervalMs,
            nextPollAt: null,
            paused: true,
            pausedReason: PAUSED_REASON,
        },
        surface: { supported: true },
    };
}

/**
 * Answer `GET /v1/status`.
 *
 * @param context - Route context carrying the open store.
 * @returns The status document; works even when the store is unavailable,
 *   because that is exactly when the operator needs to read it.
 */
async function handleGetStatus(context: RouteContext): Promise<HttpResponse> {
    const body = await buildStatusBody(context);

    return { status: STATUS.ok, body };
}

/** Read the full health model. */
export const statusRoute: Route = {
    method: 'GET',
    path: STATUS_PATH,
    handler: (context) => handleGetStatus(context),
};
