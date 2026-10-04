/**
 * `GET /v1/status` — the health model the panel renders (contract §2.1).
 *
 * The service reports itself, where its data lives, why it is or is not
 * polling, the registered accounts with their connection state, and one row
 * per stored binding — each projected without credential material.
 *
 * Three members used to be literals a running process contradicted
 * (005 FR-031–FR-033): `polling` said it was paused with no next poll no
 * matter what the scheduler was doing, `repositories` was always `[]`, and
 * `agentPin.lastVerification` was always `null`. They are now computed —
 * `polling` from a read-only view of the live scheduler
 * ([`poll/view.ts`](../poll/view.ts)), `repositories` from the **same**
 * `readStatusRows` the Bindings tab reads, and the verification from the run
 * document the service already holds.
 *
 * `service.storage.writable` is the handoff pre-flight the panel reads before
 * it enables the token input (SEC-08/F10), and `surface.supported` is `true`
 * by construction: a service process only runs where the host spawns services
 * (desktop and web), so an answering process cannot be on an unsupported
 * surface — the panel owns the unsupported-surface banner (AC-017).
 *
 * The document answers `200` even when the store is down: that is exactly when
 * the operator needs to read it (contract §1).
 */

import { DEFAULT_CONFIG, CONFIG_FILE, configFromStore, parseStoredConfig } from '../config.ts';
import { listAccounts } from '../accounts/store.ts';
import { readBindings } from '../bindings-read.ts';
import { previewRunsDocument } from '../poll/runs-document.ts';
import { nextPollAtOf, pausedReasonOf } from '../poll/view.ts';
import { STATUS } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceConfig } from '../config.ts';
import type { Account, ConnectionState } from '../accounts/model.ts';
import type { BindingRecord } from '../bindings.ts';
import type { ActorPolicy, RunVerification } from '../poll/runs-types.ts';
import { readStatusRows } from './events.ts';
import type { Route, RouteContext } from './types.ts';

/** Path of the status resource. */
export const STATUS_PATH = '/v1/status';

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

/**
 * One binding as the `repositories` member reports it (005 FR-032).
 *
 * The member keeps its historical name and every field but one comes
 * straight from the `readStatusRows` projection the Bindings tab reads, so the
 * two surfaces cannot disagree about a binding. `readable` is the addition: a
 * row whose scan projection could not be read appears with `readable: false`
 * and is **never omitted**, because an omitted binding reads as a deleted one.
 *
 */
export interface StatusRepositoryRow {
    /** Binding the row describes. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** The binding's project id. */
    readonly projectId: string;
    /** The account login this binding polls under. */
    readonly accountLogin: string;
    /** `true` when the binding is enabled right now. */
    readonly active: boolean;
    /** RFC 3339 stamp of the last completed scan, or `null`. */
    readonly lastScanAt: string | null;
    /** Short machine reason the last scan skipped, else `null`. */
    readonly lastError: string | null;
    /** Events for this binding that are pending or in flight. */
    readonly pendingCount: number;
    /**
     * Whether the scan projection behind this row could be read.
     *
     * `false` turns every scan-derived member into "unknown": the panel renders
     * the row as *unreadable* rather than believing a zero (005 AC-105).
     */
    readonly readable: boolean;
    /**
     * The **shape** of this binding's actor allow-list (005 FR-093).
     *
     * `'open'` when the binding carries no `allowedUsers` member and
     * `'restricted'` when it carries one — derived from the **binding**, not
     * from the scan projection, so it stays truthful on a row that is otherwise
     * unreadable (contract `status-projection.md`). It never carries a login:
     * the permitted set's home is `bindings.json`, and a copy of it in a
     * document the panel renders is the liability, not the control (003
     * NFR-113, 005 FR-091).
     */
    readonly actorPolicy: ActorPolicy;
}

/**
 * The agent pin's verification member (005 FR-033).
 *
 * Three shapes, and none of them means "ok": the most recent outcome the
 * service holds, an explicit *not available* marker when the run document that
 * holds them could not be read, or `null` when no dispatch has ever been
 * verified. `null` never renders as a pass.
 */
export type StatusVerification =
    /** The most recent read-back the service holds, matched or mismatched. */
    | {
        /** Agent the read-back observed, or `null` when it was unreadable. */
        readonly observedAgent: string | null;
        /** Agent the binding expected. */
        readonly expectedAgent: string;
        /** Whether the two matched; a mismatch is a warning, never a state. */
        readonly ok: boolean;
        /** RFC 3339 stamp of the read-back. */
        readonly at: string;
    }
    /** The service cannot say: the outcome lives on the dispatch row and audit. */
    | { readonly available: false; readonly reason: 'no-service-mirror' }
    /** Nothing has ever been verified. */
    | null;

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
    /** One row per stored binding, under the member's historical name (FR-026). */
    readonly repositories: readonly StatusRepositoryRow[];
    /** Agent pin state; `expectedAgent` arrives with the panel's setting mirror. */
    readonly agentPin: {
        /** Expected session agent, `null` until the panel mirrors the setting. */
        readonly expectedAgent: string | null;
        /** Most recent verification, an explicit *not available*, or `null`. */
        readonly lastVerification: StatusVerification;
    };
    /** Polling schedule, computed from the live scheduler (005 FR-031). */
    readonly polling: {
        /** Effective interval from the configuration. */
        readonly intervalMs: number;
        /** Next scheduled poll; `null` while polling does not run. */
        readonly nextPollAt: string | null;
        /** `true` only when the loop is genuinely not running. */
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
 * number for a system that has never polled.
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
 * Read the bindings the repository rows are keyed by.
 *
 * @param context - Route context carrying the open store.
 * @returns The stored bindings, or none when they cannot be read — a row list
 *   built from bindings nobody can name would invent rows, not report them.
 */
async function storedBindings(context: RouteContext): Promise<readonly BindingRecord[]> {
    if (context.store === null) {
        return [];
    }

    try {
        return await readBindings({ store: context.store, log: context.log });
    } catch (error) {
        context.log.warn('bindings could not be listed for status', {
            errorKind: error instanceof Error ? error.name : typeof error,
        });

        return [];
    }
}

/**
 * The row reported for a binding whose scan projection could not be read.
 *
 * Identity members come from the binding file (which was read), every
 * scan-derived member is `null`/`0`, and `readable: false` tells the panel not
 * to believe them (AC-105; FR-003: a missing value never reads as a healthy
 * one). `actorPolicy` is **not** scan-derived: it comes from the binding, so it
 * is as truthful here as on a readable row (005 FR-093).
 *
 * @param binding - The stored binding this row is keyed by.
 * @returns The unreadable row; present, never omitted.
 */
function unreadableRepositoryRow(binding: BindingRecord): StatusRepositoryRow {
    return {
        bindingId: binding.bindingId,
        repository: binding.repository,
        projectId: binding.projectId,
        accountLogin: binding.accountLogin,
        active: binding.state === 'active',
        lastScanAt: null,
        lastError: null,
        pendingCount: 0,
        readable: false,
        // Absent is open, and a present list is always non-empty by the rule
        // that refuses `[]` — the same derivation the readable rows use, so
        // one binding never reports two shapes (002 FR-047).
        actorPolicy: binding.allowedUsers === undefined ? 'open' : 'restricted',
    };
}

/**
 * The most recent verification outcome a run list holds, else `null`.
 *
 * Takes the structural view of a run it actually needs — `verification` — so
 * the projection can be driven by a one-field fixture instead of a whole
 * stored run.
 *
 * @param runs - Runs (or anything carrying a run's verification record).
 * @returns The freshest read-back by its own stamp, or `null` when no dispatch
 *   has ever been verified.
 */
export function mostRecentVerification(
    runs: readonly { readonly verification: RunVerification | null }[],
): StatusVerification {
    let freshest: RunVerification | null = null;
    for (const run of runs) {
        const { verification } = run;
        if (verification === null) {
            continue;
        }

        if (freshest === null || Date.parse(verification.at) >= Date.parse(freshest.at)) {
            freshest = verification;
        }
    }

    if (freshest === null) {
        return null;
    }

    return {
        observedAgent: freshest.observedAgent,
        expectedAgent: freshest.expectedAgent,
        ok: freshest.ok,
        at: freshest.at,
    };
}

/** The explicit *not available* marker: the outcome lives on the run and audit. */
function notAvailableVerification(): StatusVerification {
    return { available: false, reason: 'no-service-mirror' };
}

/**
 * Read the two run-derived halves of the document: the binding rows and the
 * agent pin's last verification.
 *
 * Both come from the same documents the rest of the panel reads, and both
 * degrade to an explicit *unreadable* answer rather than to an empty one — the
 * store being unable to describe its runs is exactly when a reassuring `[]`
 * would be a lie (constitution II).
 *
 * @param context - Route context carrying the open store.
 * @param bindings - The stored bindings every row is keyed by.
 * @returns The rows plus the verification member.
 */
async function runDerivedProjection(
    context: RouteContext,
    bindings: readonly BindingRecord[],
): Promise<{ readonly repositories: readonly StatusRepositoryRow[]; readonly verification: StatusVerification }> {
    const { store } = context;
    if (store === null) {
        return { repositories: [], verification: notAvailableVerification() };
    }

    try {
        const rows = await readStatusRows({ store, log: context.log, bindings });
        const document = await previewRunsDocument({ store, log: context.log });

        return {
            repositories: rows.map((row) => ({ ...row, readable: true })),
            verification: mostRecentVerification(document.runs),
        };
    } catch (error) {
        context.log.warn('run projection could not be read for status', {
            errorKind: error instanceof Error ? error.name : typeof error,
        });

        return {
            repositories: bindings.map(unreadableRepositoryRow),
            verification: notAvailableVerification(),
        };
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

    return configFromStore(result, context.log).config;
}

/**
 * Assemble the status document.
 *
 * @param context - Route context carrying store, clock, and data directory.
 * @returns The health model, with every member computed from what the service
 *   actually knows (005 FR-031–FR-034).
 */
async function buildStatusBody(context: RouteContext): Promise<ServiceStatusBody> {
    const config = await readConfig(context);
    const { store, polling } = context;
    const storeUsable = store !== null;
    const accounts = await statusAccounts(context);
    const bindings = await storedBindings(context);
    const { repositories, verification } = await runDerivedProjection(context, bindings);
    // The scheduler's own answer: paused only when the loop is genuinely not
    // running, never a literal the running process would contradict.
    const running = storeUsable && polling.isRunning();
    const activeBindings = bindings.filter((binding) => binding.state === 'active').length;
    const pausedReason = pausedReasonOf({
        storeUsable,
        running,
        stopping: polling.isStopping(),
        activeBindings,
    });

    return {
        service: {
            status: storeUsable ? 'ok' : 'degraded',
            uptimeMs: Date.now() - context.startedAt,
            dataDir: context.dataDir,
            schemaVersion: store?.schemaVersion ?? null,
            storage: { writable: storeUsable },
        },
        accounts,
        repositories,
        agentPin: { expectedAgent: null, lastVerification: verification },
        polling: {
            intervalMs: config.intervalMs,
            nextPollAt: nextPollAtOf(polling, config.intervalMs),
            paused: !running,
            pausedReason,
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
