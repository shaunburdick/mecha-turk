/**
 * The `GET /v1/status` document and its read state: an unshaped body answers `null`, never a partial view (inv. 8).
 */

import { parseJsonObject } from './json.ts';
import { readRequiredActorPolicy } from './run-actor.ts';
import type { ActorPolicy } from './run-actor.ts';

export interface StatusAccountView {
    readonly numericUserId: string;
    readonly login: string;
    readonly connectionState: string;
    /** Rate budget; `null` members are *not measured yet*, never zero. */
    readonly rate: StatusRateView;
}

export interface StatusRateView {
    readonly remaining: number | null;
    readonly limit: number | null;
    readonly resetAt: string | null;
    readonly usedLastHour: number;
}

export interface StatusBindingView {
    readonly bindingId: string;
    readonly repository: string;
    readonly projectId: string;
    readonly accountLogin: string;
    readonly active: boolean;
    readonly lastScanAt: string | null;
    readonly lastError: string | null;
    readonly pendingCount: number;
    readonly readable: boolean;
    /**
     * The **shape** of this binding's actor allow-list, never its contents.
     *
     * **Required, and fail-closed on both counts.** A row whose value is
     * outside the closed union, and a row that carries no value at all, each
     * refuse the document: the panel has no honest way to render *unknown* for
     * this one value, and the two defaults that would
     * let it slip through — an absent policy rendered as neutral, or as
     * `'open'`.
     */
    readonly actorPolicy: ActorPolicy;
}

export interface StatusServiceView {
    readonly status: 'ok' | 'degraded';
    readonly uptimeMs: number;
    readonly dataDir: string;
    readonly schemaVersion: number | null;
    readonly writable: boolean;
}

export interface StatusPollingView {
    readonly intervalMs: number;
    readonly nextPollAt: string | null;
    readonly paused: boolean;
    /** Machine-readable pause reason; rendered verbatim, never mapped to a guess. */
    readonly pausedReason: string;
}

export type StatusVerificationView =
    | {
        readonly kind: 'outcome';
        readonly observedAgent: string | null;
        readonly expectedAgent: string;
        readonly ok: boolean;
        readonly at: string;
    }
    | { readonly kind: 'unavailable'; readonly reason: string }
    | { readonly kind: 'none' };

export interface StatusAgentPinView {
    readonly expectedAgent: string | null;
    readonly verification: StatusVerificationView;
}

export interface StatusView {
    readonly service: StatusServiceView;
    readonly accounts: readonly StatusAccountView[];
    /** One row per stored binding; never omissions. */
    readonly bindings: readonly StatusBindingView[];
    readonly polling: StatusPollingView;
    readonly agentPin: StatusAgentPinView;
    readonly supported: boolean;
}

/**
 *
 * The tab keeps the last document it could read even when a later read fails,
 * because the retained content must be **marked stale** rather
 * than swapped for a reassuring blank; `stale` is exactly that mark, and it
 * is cleared by the next read that lands.
 */
export interface StatusTabState {
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    at: string | null;
    problem: string | null;
    stale: boolean;
    doc: StatusView | null;
    /**
     * The configured interval read beside the effective one, or
     * `null` when `GET /v1/config` did not supply one — rendered as *not
     * read*, never as a default the service did not confirm.
     */
    configuredIntervalMs: number | null;
}

/**
 * Build the empty Status tab state.
 */
export function initialStatusTab(): StatusTabState {
    return {
        phase: 'idle',
        at: null,
        problem: null,
        stale: false,
        doc: null,
        configuredIntervalMs: null,
    };
}

/**
 * Narrow one unknown to a plain object record.
 *
 * @returns The record, or `null` for `null`, arrays, and primitives.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

/**
 * Narrow one unknown to a finite number.
 */
function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

/**
 * Read a member that is a string or explicit `null`.
 *
 * @returns The string, `null` for the documented null, or `undefined` when
 *   the member is absent or of the wrong type (which fails the parse).
 */
function asStringOrNull(value: unknown): string | null | undefined {
    if (value === null) {
        return null;
    }

    return typeof value === 'string' ? value : undefined;
}

/**
 * Read a member that is a number or explicit `null`.
 *
 * @returns The number, `null` for the documented null, or `undefined` when
 *   the member is absent or of the wrong type.
 */
function asNumberOrNull(value: unknown): number | null | undefined {
    if (value === null) {
        return null;
    }

    return asNumber(value);
}

/**
 * Read the process-health enum without accepting a value outside it.
 *
 * @returns The health, or `null` when it is neither `ok` nor `degraded`.
 */
function asHealth(value: unknown): 'ok' | 'degraded' | null {
    return value === 'ok' || value === 'degraded' ? value : null;
}

/**
 * Parse the rate block; every member is required so a partial block is a
 * refusal rather than a half-measured budget.
 */
function parseRate(value: unknown): StatusRateView | null {
    const rate = asRecord(value);
    if (rate === null) {
        return null;
    }

    const remaining = asNumberOrNull(rate.remaining);
    const limit = asNumberOrNull(rate.limit);
    const resetAt = asStringOrNull(rate.resetAt);
    const usedLastHour = asNumber(rate.usedLastHour);
    if (remaining === undefined || limit === undefined || resetAt === undefined || usedLastHour === null) {
        return null;
    }

    return { remaining, limit, resetAt, usedLastHour };
}

function parseAccount(value: unknown): StatusAccountView | null {
    const account = asRecord(value);
    if (account === null) {
        return null;
    }

    const numericUserId = asString(account.numericUserId);
    const login = asString(account.login);
    const connectionState = asString(account.connectionState);
    if (numericUserId === null || login === null || connectionState === null) {
        return null;
    }

    const rate = parseRate(account.rate);
    if (rate === null) {
        return null;
    }

    return { numericUserId, login, connectionState, rate };
}

interface BindingIdentity {
    readonly bindingId: string;
    readonly repository: string;
    readonly projectId: string;
    readonly accountLogin: string;
}

/**
 * Read the four identity members of one binding row.
 *
 * @returns The identity, or `null` when any member is not a string.
 */
function parseBindingIdentity(row: Record<string, unknown>): BindingIdentity | null {
    const bindingId = asString(row.bindingId);
    const repository = asString(row.repository);
    const projectId = asString(row.projectId);
    const accountLogin = asString(row.accountLogin);
    if (bindingId === null || repository === null || projectId === null || accountLogin === null) {
        return null;
    }

    return { bindingId, repository, projectId, accountLogin };
}

/**
 * Parse one binding row out of the `repositories` member.
 */
function parseBinding(value: unknown): StatusBindingView | null {
    const row = asRecord(value);
    if (row === null) {
        return null;
    }

    const { active, readable } = row;
    const identity = parseBindingIdentity(row);
    const lastScanAt = asStringOrNull(row.lastScanAt);
    const lastError = asStringOrNull(row.lastError);
    const pendingCount = asNumber(row.pendingCount);
    const actorPolicy = readRequiredActorPolicy(row.actorPolicy);
    const isFlags = typeof active === 'boolean' && typeof readable === 'boolean';
    if (
        identity === null || lastScanAt === undefined || lastError === undefined
        || pendingCount === null || actorPolicy === null || !isFlags
    ) {
        return null;
    }

    return {
        ...identity,
        active,
        lastScanAt,
        lastError,
        pendingCount,
        readable,
        actorPolicy,
    };
}

function parseService(value: unknown): StatusServiceView | null {
    const service = asRecord(value);
    const storage = service === null ? null : asRecord(service.storage);
    if (service === null || storage === null) {
        return null;
    }

    const status = asHealth(service.status);
    const uptimeMs = asNumber(service.uptimeMs);
    const dataDir = asString(service.dataDir);
    const schemaVersion = asNumberOrNull(service.schemaVersion);
    const writable = asBoolean(storage.writable);
    if (status === null || uptimeMs === null || dataDir === null || schemaVersion === undefined || writable === null) {
        return null;
    }

    return { status, uptimeMs, dataDir, schemaVersion, writable };
}

function parsePolling(value: unknown): StatusPollingView | null {
    const polling = asRecord(value);
    if (polling === null) {
        return null;
    }

    const intervalMs = asNumber(polling.intervalMs);
    const nextPollAt = asStringOrNull(polling.nextPollAt);
    const paused = asBoolean(polling.paused);
    const pausedReason = asString(polling.pausedReason);
    if (intervalMs === null || nextPollAt === undefined || paused === null || pausedReason === null) {
        return null;
    }

    return { intervalMs, nextPollAt, paused, pausedReason };
}

/**
 * Parse the agent pin's three-shape verification member.
 */
function parseVerification(value: unknown): StatusVerificationView | null {
    if (value === null) {
        return { kind: 'none' };
    }

    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    if (record.available === false) {
        const reason = asString(record.reason);

        return reason === null ? null : { kind: 'unavailable', reason };
    }

    const observedAgent = asStringOrNull(record.observedAgent);
    const expectedAgent = asString(record.expectedAgent);
    const { ok } = record;
    const at = asString(record.at);
    if (observedAgent === undefined || expectedAgent === null || typeof ok !== 'boolean' || at === null) {
        return null;
    }

    return { kind: 'outcome', observedAgent, expectedAgent, ok, at };
}

function parseAgentPin(value: unknown): StatusAgentPinView | null {
    const agentPin = asRecord(value);
    if (agentPin === null) {
        return null;
    }

    const expectedAgent = asStringOrNull(agentPin.expectedAgent);
    const verification = parseVerification(agentPin.lastVerification);
    if (expectedAgent === undefined || verification === null) {
        return null;
    }

    return { expectedAgent, verification };
}

/**
 * Parse one homogeneous row array; one unparseable row refuses the whole
 * document rather than silently dropping the row an operator would look for.
 *
 * @returns Every row, or `null` when the member is not an array or a row fails.
 */
function parseRows<T>(value: unknown, parseOne: (entry: unknown) => T | null): T[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const rows: T[] = [];
    for (const entry of value) {
        const row = parseOne(entry);
        if (row === null) {
            return null;
        }

        rows.push(row);
    }

    return rows;
}

/**
 * Parse a whole `GET /v1/status` body, fail closed.
 *
 * @returns The view, or `null` when any required member is missing or of the
 *   wrong shape — never a partially populated document.
 */
export function parseStatusView(body: string): StatusView | null {
    const root = parseJsonObject(body);
    if (root === null) {
        return null;
    }

    const service = parseService(root.service);
    const accounts = parseRows(root.accounts, parseAccount);
    const bindings = parseRows(root.repositories, parseBinding);
    const polling = parsePolling(root.polling);
    const agentPin = parseAgentPin(root.agentPin);
    const surface = asRecord(root.surface);
    const supported = surface === null ? null : asBoolean(surface.supported);
    if (
        service === null || accounts === null || bindings === null
        || polling === null || agentPin === null || supported === null
    ) {
        return null;
    }

    return { service, accounts, bindings, polling, agentPin, supported };
}

/**
 * Read the configured poll interval out of a `GET /v1/config` answer.
 *
 * The effective value comes from the status document; this is the *configured*
 * one Status shows beside it so a difference can be named rather than hidden.
 *
 * @returns The configured interval, or `null` when the document does not carry
 *   a usable one — which the tab reports as *not read*, never as a default.
 */
export function configuredIntervalFrom(body: string): number | null {
    const root = parseJsonObject(body);
    const config = root === null ? null : asRecord(root.config);
    if (config === null) {
        return null;
    }

    return asNumber(config.intervalMs);
}
