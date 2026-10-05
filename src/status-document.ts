/**
 * The `GET /v1/status` document, and the read state that holds it.
 *
 * Parsing lives apart from rendering so the fail-closed rule is one function
 * deep and testable on its own: a body that does not carry the documented
 * shape answers **`null`**, never a partly-populated view (AGENTS invariant 8).
 * The tab then reports the read as failed and keeps whatever it
 * last rendered marked stale — it never renders a default as though the
 * service had said it.
 *
 * Every member here mirrors [contracts/status-projection.md](../../specs/005-panel-ia/contracts/status-projection.md):
 * `repositories` keeps its historical name, `pausedReason` is opaque
 * text the panel renders verbatim, `readable: false` marks a binding
 * row whose scan projection could not be read, and
 * `agentPin.lastVerification` is an outcome, an explicit *not available*, or
 * `null` — never a reassuring pass.
 *
 * The read state belongs here rather than beside the other `PanelState`
 * slices: it is a statement about *this document* (which read is on screen,
 * whether it is stale), and keeping it in this leaf module keeps
 * `panel-state.ts` free of a back-edge into the tab that renders it.
 */

import { parseJsonObject } from './json.ts';
import { readRequiredActorPolicy } from './run-actor.ts';
import type { ActorPolicy } from './run-actor.ts';

/** One account row as the Status tab renders it. */
export interface StatusAccountView {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /** Connection state, rendered verbatim — including values this build does not know. */
    readonly connectionState: string;
    /** Rate budget; `null` members are *not measured yet*, never zero. */
    readonly rate: StatusRateView;
}

/** The honest pre-poll rate baseline. */
export interface StatusRateView {
    /** Requests left in the window; `null` before the first measurement. */
    readonly remaining: number | null;
    /** Hourly budget; `null` before the first measurement. */
    readonly limit: number | null;
    /** Window reset stamp; `null` before the first measurement. */
    readonly resetAt: string | null;
    /** Requests used in the rolling hour; a real count, zero when none. */
    readonly usedLastHour: number;
}

/** One binding row, keyed by the member the wire keeps. */
export interface StatusBindingView {
    /** Binding this row describes. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** Target project id, so Status can notice one the host has not registered. */
    readonly projectId: string;
    /** Account login the binding polls under. */
    readonly accountLogin: string;
    /** Whether the binding is enabled right now. */
    readonly active: boolean;
    /** Last completed scan, or `null` when it has never scanned. */
    readonly lastScanAt: string | null;
    /** Machine reason the last scan skipped or failed, or `null`. */
    readonly lastError: string | null;
    /** Events pending or in flight for this binding. */
    readonly pendingCount: number;
    /** `false` marks every scan-derived member unreadable. */
    readonly readable: boolean;
    /**
     * The **shape** of this binding's actor allow-list, never its contents.
     *
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

/** Process health, location, and store state. */
export interface StatusServiceView {
    /** `degraded` when the data directory is unusable. */
    readonly status: 'ok' | 'degraded';
    /** Milliseconds since the service started. */
    readonly uptimeMs: number;
    /** Absolute data directory — the thing to back up. */
    readonly dataDir: string;
    /** Store schema version, or `null` while the store is unavailable. */
    readonly schemaVersion: number | null;
    /** Whether the data directory can serve writes right now. */
    readonly writable: boolean;
}

/** The polling block, computed by the service from its live scheduler. */
export interface StatusPollingView {
    /** Effective interval the scheduler is running with. */
    readonly intervalMs: number;
    /** Next scheduled poll; `null` while polling does not run. */
    readonly nextPollAt: string | null;
    /** `true` only when the loop is genuinely not running. */
    readonly paused: boolean;
    /** Machine-readable pause reason; rendered verbatim, never mapped to a guess. */
    readonly pausedReason: string;
}

/** The agent pin's verification member, in its three shapes. */
export type StatusVerificationView =
    /** The most recent read-back the service holds. */
    | {
        readonly kind: 'outcome';
        /** Agent the dispatch observed, or `null` when it was unreadable. */
        readonly observedAgent: string | null;
        /** Baseline the judgment used. */
        readonly expectedAgent: string;
        /** Whether the two matched. */
        readonly ok: boolean;
        /** RFC 3339 stamp of the read-back. */
        readonly at: string;
    }
    /** The service cannot say: the outcome lives on the dispatch row and audit. */
    | { readonly kind: 'unavailable'; readonly reason: string }
    /** Nothing has ever been verified. */
    | { readonly kind: 'none' };

/** What Status knows about the Default Agent pin. */
export interface StatusAgentPinView {
    /** The service's own expected-agent member; `null` when it holds none. */
    readonly expectedAgent: string | null;
    /** The three-shape verification member. */
    readonly verification: StatusVerificationView;
}

/** A fully parsed status document. */
export interface StatusView {
    /** Process health and location. */
    readonly service: StatusServiceView;
    /** One row per registered account; `[]` is an honest empty. */
    readonly accounts: readonly StatusAccountView[];
    /** One row per stored binding; never omissions. */
    readonly bindings: readonly StatusBindingView[];
    /** The computed polling block. */
    readonly polling: StatusPollingView;
    /** The agent pin. */
    readonly agentPin: StatusAgentPinView;
    /** Whether this host surface can run a service at all. */
    readonly supported: boolean;
}

/**
 * Where the Status tab's read stands, and what it last rendered.
 *
 * The tab keeps the last document it could read even when a later read fails,
 * because the retained content must be **marked stale** rather
 * than swapped for a reassuring blank; `stale` is exactly that mark, and it
 * is cleared by the next read that lands.
 */
export interface StatusTabState {
    /** Read phase: nothing yet, in flight, landed, or refused. */
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    /** RFC 3339 stamp of the read that last landed, or `null`. */
    at: string | null;
    /** Why the last read failed; `null` while the tab has no failure to show. */
    problem: string | null;
    /** Whether `doc` is from an earlier read than the one that just failed. */
    stale: boolean;
    /** The parsed status document, or `null` until one lands. */
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
 *
 * @returns The state before the first read.
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
 *
 * @returns The number, or `null` when it is not one.
 */
function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Narrow one unknown to a string.
 *
 * @returns The string, or `null` when it is not one.
 */
function asString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Narrow one unknown to a boolean.
 *
 * @returns The boolean, or `null` when it is not one.
 */
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
 * @param value - The `service.status` member.
 * @returns The health, or `null` when it is neither `ok` nor `degraded`.
 */
function asHealth(value: unknown): 'ok' | 'degraded' | null {
    return value === 'ok' || value === 'degraded' ? value : null;
}

/**
 * Parse the rate block; every member is required so a partial block is a
 * refusal rather than a half-measured budget.
 *
 * @param value - The `rate` member.
 * @returns The rate view, or `null` when the shape is wrong.
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

/**
 * Parse one account row.
 *
 * @returns The row, or `null` when the shape is wrong.
 */
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

/** A binding's identity members, which the guidance line also needs. */
interface BindingIdentity {
    /** Binding this row describes. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** Target project id. */
    readonly projectId: string;
    /** Account login the binding polls under. */
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
 *
 * @returns The row, or `null` when the shape is wrong.
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

/**
 * Parse the process block.
 *
 * @param value - The `service` member.
 * @returns The view, or `null` when the shape is wrong.
 */
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

/**
 * Parse the polling block.
 *
 * @param value - The `polling` member.
 * @returns The view, or `null` when the shape is wrong.
 */
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
 *
 * @param value - The `lastVerification` member.
 * @returns The shape, or `null` when the document carries something else.
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

/**
 * Parse the agent pin block.
 *
 * @param value - The `agentPin` member.
 * @returns The view, or `null` when the shape is wrong.
 */
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
