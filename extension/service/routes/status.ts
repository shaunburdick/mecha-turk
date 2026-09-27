/**
 * `GET /v1/status` — the health model the panel renders (contract §2.1).
 *
 * The service reports itself, where its data lives, why nothing is polling
 * yet, and — since custody landed in Wave 2 — the registered accounts with
 * their connection state, projected without credential material. The
 * `repositories` and `agentPin` sections stay empty until their waves; a
 * fixed shape with truthful contents beats a shape that grows under the
 * panel's feet, and `service.status: 'degraded'` with a `null` schema version
 * is how an unusable data directory reaches the operator (FR-039).
 *
 * `service.storage.writable` is the handoff pre-flight the panel reads before
 * it enables the token input (SEC-08/F10), and `surface.supported` is `true`
 * by construction: a service process only runs where the host spawns services
 * (desktop and web), so an answering process cannot be on an unsupported
 * surface — the panel owns the unsupported-surface banner (AC-017).
 */

import { DEFAULT_CONFIG, CONFIG_FILE, configFromStore, parseStoredConfig } from '../config.ts';
import { listAccounts } from '../accounts/store.ts';
import { STATUS } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceConfig } from '../config.ts';
import type { Account, ConnectionState } from '../accounts/model.ts';
import type { Route, RouteContext } from './types.ts';

/** Path of the status resource. */
export const STATUS_PATH = '/v1/status';

/** Why polling is paused: a fresh store has no accounts to poll for (FR-039). */
const PAUSED_REASON = 'config-incomplete';

/** Per-account rate state as the health model reports it (data-model RateState). */
export interface RateStateReport {
    /** Requests left in GitHub's current window; `null` before the first poll. */
    readonly remaining: number | null;
    /** Hourly budget; `null` before the first poll. */
    readonly limit: number | null;
    /** Window reset time; `null` before the first poll. */
    readonly resetAt: string | null;
    /** Requests used in the rolling hour; zero before the first poll. */
    readonly usedLastHour: number;
    /** Secondary-limit cooldown; `null` while GitHub is not cooling us down. */
    readonly secondaryBlockedUntil: string | null;
    /** Whether GitHub supports conditional requests; unknown until measured. */
    readonly conditionalSupport: 'unknown' | 'yes' | 'no';
    /** When this state was last written. */
    readonly updatedAt: string;
}

/** One account as `GET /v1/status` reports it (contract §2.1). */
export interface StatusAccount {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /** Last observed connection state. */
    readonly connectionState: ConnectionState;
    /** Rate budget; baseline values until the poller lands (T-014). */
    readonly rate: RateStateReport;
    /** Bound streams; empty until repository bindings land (T-020). */
    readonly streams: readonly unknown[];
}

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
        /**
         * Whether the data directory can serve writes right now — the handoff
         * pre-flight the panel reads *before* enabling the token input
         * (contract §2.1, SEC-08/F10).
         */
        readonly storage: { readonly writable: boolean };
    };
    /** Registered accounts, projected without any credential material. */
    readonly accounts: readonly StatusAccount[];
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
 * Project one account into the status document's account row.
 *
 * The rate block reports the honest pre-poll baseline (data-model RateState
 * with `null` budget fields and zero usage): the poller that fills it lands
 * with T-014, and a truthful "not measured yet" beats a plausible-looking
 * number for a system that has never polled (FR-036, NFR-009).
 *
 * @param account - The stored account.
 * @returns The status row; no credential material crosses this boundary.
 */
function statusAccountRow(account: Account): StatusAccount {
    return {
        numericUserId: account.numericUserId,
        login: account.login,
        connectionState: account.connectionState,
        rate: {
            remaining: null,
            limit: null,
            resetAt: null,
            usedLastHour: 0,
            secondaryBlockedUntil: null,
            conditionalSupport: 'unknown',
            updatedAt: account.updatedAt,
        },
        streams: [],
    };
}

/**
 * Read the account rows for the status document.
 *
 * @param context - Route context carrying the open store.
 * @returns The rows, or none when the store is down or unreadable — the
 *   status route answers with the storage signal instead of failing.
 */
async function statusAccounts(context: RouteContext): Promise<readonly StatusAccount[]> {
    if (context.store === null) {
        return [];
    }

    try {
        const accounts = await listAccounts(context.store, context.log);

        return accounts.map(statusAccountRow);
    } catch (error) {
        context.log.warn('accounts could not be listed for status', {
            errorKind: error instanceof Error ? error.name : typeof error,
        });

        return [];
    }
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
            storage: { writable: store !== null },
        },
        accounts: await statusAccounts(context),
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
