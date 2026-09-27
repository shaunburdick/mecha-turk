/**
 * The panel's one-shot credential handoff (task T-009, token-handoff §2).
 *
 * Write-through, one shot, no cache, no retry buffer: the token enters this
 * module as a function argument, lives in the module-scoped {@link activeToken}
 * variable for the duration of the request, and is cleared in a `finally`
 * block on **every** exit — success, service refusal, host failure, timeout, or
 * a thrown error (contract §2 step ⑧, failure modes F1–F16). It is never
 * written to `host.storage`, never rendered, and never interpolated into a
 * note: the copy in this file is built from status *codes* only.
 *
 * Order is the contract's: consent gate (§1) → `GET /v1/status` pre-flight so
 * an unwritable store is discovered **before** the token is typed into a
 * request (F10/SEC-08) → `POST /v1/accounts/verify` with the current
 * `consentVersion` → map the outcome. A `HOST_TIMEOUT` re-reads `/v1/status`
 * before the panel declares failure (F4/SEC-05): the service, not the clock,
 * is the authority on whether an account appeared.
 */

import type { GuestRequestResult } from '@openchamber/sdk';
import { CONSENT_STORAGE_KEY, CONSENT_VERSION, consentCurrent, readConsentMirror } from './consent.ts';
import { isJsonValue, parseJsonObject } from './json.ts';
import { assertRedacted } from './redaction.ts';
import {
    CONSENT_REFUSAL,
    HOST_COPY,
    REASON_COPY,
    SERVICE_COPY,
    STORAGE_REFUSAL,
    UNKNOWN_FAILURE,
    connectedLine,
} from './handoff-copy.ts';
import { hostErrorCode, preflightHandoff, rereadStatusAfterTimeout } from './handoff-status.ts';
import type { ConsentMirror } from './consent.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Path the handoff posts to (contract §2.2). */
export const VERIFY_PATH = '/v1/accounts/verify';

/** `host.storage` key holding the account mirror from contract §3. */
export const ACCOUNTS_STORAGE_KEY = 'accounts';

/** Success status of `POST /v1/accounts/verify` (contract §2.2). */
const HTTP_CREATED = 201;

/** Status a store-backed route answers with when storage is unusable (F14). */
const HTTP_STORAGE_UNAVAILABLE = 503;

/** The credential in flight; cleared in `finally` on every exit (§2 step ⑧). */
let activeToken: string | undefined;

/** FR-010 capabilities, in the order the contract's matrix reports them. */
const SCOPE_CAPABILITIES = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/** One FR-010 capability name (contract §2 step ⑥). */
type ScopeCapability = (typeof SCOPE_CAPABILITIES)[number];

/** Result recorded for one capability: `ok`, `missing`, or `unknown` (FR-010). */
type ScopeResult = 'ok' | 'missing' | 'unknown';

/** FR-010 scope matrix as the account mirror records it (contract §3, review M1). */
export interface ScopeMirror {
    /** RFC 3339 timestamp of the check. */
    readonly checkedAt: string;
    /** One result per FR-010 capability. */
    readonly results: Readonly<Record<ScopeCapability, ScopeResult>>;
}

/**
 * Narrow a service `scopeCheck.results` payload to the four-capability matrix.
 *
 * Every FR-010 capability must carry a legal verdict; anything else is not a
 * matrix this panel can record.
 *
 * @param raw - The `results` field, or anything else.
 * @returns The matrix, or `null` when any capability is missing or illegal.
 */
function readScopeResults(raw: unknown): Readonly<Record<ScopeCapability, ScopeResult>> | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return null;
    }

    const results = raw as Record<string, unknown>;
    const entries: (readonly [ScopeCapability, ScopeResult])[] = [];
    for (const capability of SCOPE_CAPABILITIES) {
        const verdict = results[capability];
        if (verdict !== 'ok' && verdict !== 'missing' && verdict !== 'unknown') {
            return null;
        }

        entries.push([capability, verdict]);
    }

    return Object.fromEntries(entries) as Record<ScopeCapability, ScopeResult>;
}

/**
 * Narrow a service `scopeCheck` payload to the matrix the mirror records.
 *
 * A matrix this panel cannot trust is never guessed into existence, and an
 * absent one (the F4 status re-read reports no scopes at all) becomes `null`
 * rather than a fabricated verdict — `unknown` is reserved for a check that
 * actually ran (FR-010, review M1). Exported for the silent account
 * adoption, which mirrors the scope matrix the service DTO carries.
 *
 * @param raw - `scopeCheck` from the `201` body, or anything else.
 * @returns The matrix, or `null` when this surface has no usable one.
 */
export function readScopeMirror(raw: unknown): ScopeMirror | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return null;
    }

    const payload = raw as { readonly checkedAt?: unknown; readonly results?: unknown };
    if (typeof payload.checkedAt !== 'string') {
        return null;
    }

    const results = readScopeResults(payload.results);
    if (results === null) {
        return null;
    }

    return { checkedAt: payload.checkedAt, results };
}

/** Account mirror shape contract §3 records in `host.storage` after a success. */
export interface AccountMirror {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /** Connection state the mirror reports. */
    readonly state: 'active';
    /**
     * FR-010 matrix the service reported, or `null` when this surface learned
     * the account without one (the F4 status re-read carries no scopes).
     */
    readonly scopeCheck: ScopeMirror | null;
}

/**
 * Narrow a stored entry to an account mirror.
 *
 * @param value - One entry from the `accounts` storage key.
 * @returns `true` only for a mirror this panel wrote itself (contract §3's
 *   four fields; a pre-M1 entry without `scopeCheck` is not one).
 */
function isAccountMirror(value: unknown): value is AccountMirror {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const mirror = value as {
        readonly numericUserId?: unknown;
        readonly login?: unknown;
        readonly state?: unknown;
        readonly scopeCheck?: unknown;
    };

    return (
        typeof mirror.numericUserId === 'string' &&
        typeof mirror.login === 'string' &&
        mirror.state === 'active' &&
        (mirror.scopeCheck === null || readScopeMirror(mirror.scopeCheck) !== null)
    );
}

/** What the panel knows about one handoff attempt. */
export interface HandoffState {
    /** Whether the current consent copy has been accepted on this install. */
    consentGiven: boolean;
    /** Whether `GET /v1/status` reported `service.storage.writable`. */
    storageWritable: boolean;
    /** Whether the pre-flight has completed at least once. */
    preflighted: boolean;
    /** Account ids seen in the pre-flight, so F4 can detect a new one. */
    knownAccountIds: readonly string[];
    /** Identity rendered as `Connected as <login>` after a success. */
    connected: { readonly numericUserId: string; readonly login: string } | null;
    /** Operator-facing note; never contains credential material. */
    note: string;
    /** Whether a handoff is currently in flight. */
    busy: boolean;
}

/** Input accepted by {@link runHandoff}. */
export interface HandoffInput {
    /** The pasted credential; lives only in this call's scope. */
    readonly token: string;
    /** Optional operator-supplied expected login (FR-009). */
    readonly expectedLogin?: string;
}

/**
 * Create the empty handoff state shown before the first pre-flight.
 *
 * @returns The initial state.
 */
export function initialHandoffState(): HandoffState {
    return {
        consentGiven: false,
        storageWritable: false,
        preflighted: false,
        knownAccountIds: [],
        connected: null,
        note: '',
        busy: false,
    };
}

/**
 * Read the credential currently in flight (test seam for F-clear assertions).
 *
 * @returns The active token, or `undefined` when nothing is in flight.
 */
export function currentHandoffToken(): string | undefined {
    return activeToken;
}

/**
 * Read the stored consent mirror from `host.storage`.
 *
 * @param rt - Panel runtime.
 * @returns The mirror, or `null` when absent or unreadable.
 */
async function readStoredConsent(rt: PanelRuntime): Promise<ConsentMirror | null> {
    try {
        return readConsentMirror(await rt.host.storage.get(CONSENT_STORAGE_KEY));
    } catch {
        return null;
    }
}

/**
 * Persist a value in `host.storage` behind the redaction guard.
 *
 * @param rt - Panel runtime.
 * @param key - Storage key.
 * @param value - JSON value to write; must be credential-free.
 * @returns `true` when the write succeeded, `false` when it was refused.
 */
async function writeStorage(
    rt: PanelRuntime,
    entry: { readonly key: string; readonly value: unknown },
): Promise<boolean> {
    if (!isJsonValue(entry.value)) {
        return false;
    }

    try {
        assertRedacted(entry.key, JSON.stringify(entry.value));
        await rt.host.storage.set(entry.key, entry.value);
    } catch {
        return false;
    }

    return true;
}

/**
 * Mark the current consent copy as accepted and persist the mirror (§1.1).
 *
 * @param rt - Panel runtime.
 */
export async function acceptHandoffConsent(rt: PanelRuntime): Promise<void> {
    const mirror: ConsentMirror = { givenAt: new Date().toISOString(), version: CONSENT_VERSION };
    rt.state.handoff.consentGiven = consentCurrent(mirror);
    await writeStorage(rt, { key: CONSENT_STORAGE_KEY, value: mirror });
}

/**
 * Record a declined consent: the account stays unusable, panel stays usable.
 *
 * @param rt - Panel runtime.
 */
export function declineHandoffConsent(rt: PanelRuntime): void {
    rt.state.handoff.consentGiven = false;
    rt.state.handoff.note = CONSENT_REFUSAL;
}

/**
 * Apply the consent gate and the storage pre-flight before anything is sent.
 *
 * @param rt - Panel runtime.
 * @returns A refusal reason when the handoff must not be sent, otherwise `null`.
 */
async function handoffGate(rt: PanelRuntime): Promise<string | null> {
    const mirror = await readStoredConsent(rt);
    rt.state.handoff.consentGiven = consentCurrent(mirror);
    if (!rt.state.handoff.consentGiven) {
        return CONSENT_REFUSAL;
    }

    const snapshot = await preflightHandoff(rt);
    if (snapshot === null) {
        return rt.state.handoff.note === '' ? UNKNOWN_FAILURE : rt.state.handoff.note;
    }

    if (!snapshot.storageWritable) {
        rt.state.handoff.note = STORAGE_REFUSAL;

        return STORAGE_REFUSAL;
    }

    return null;
}

function serviceErrorEnvelope(result: GuestRequestResult): { readonly code: string; readonly reason: string | null } {
    const root = parseJsonObject(result.body);
    const error = root?.error as { code?: unknown; reasonClass?: unknown } | undefined;
    const code = typeof error?.code === 'string' ? error.code : '';
    const reason = typeof error?.reasonClass === 'string' ? error.reasonClass : null;

    return { code, reason };
}

/**
 * Parse a credential-route failure envelope into its copy.
 *
 * @param result - The non-2xx response from the service.
 * @returns Operator-facing copy built from the code alone (never a value).
 */
function serviceFailureCopy(result: GuestRequestResult): string {
    const { code, reason } = serviceErrorEnvelope(result);
    if (code === 'credential-rejected' && reason !== null) {
        return REASON_COPY.get(reason) ?? SERVICE_COPY.get(code) ?? UNKNOWN_FAILURE;
    }

    return SERVICE_COPY.get(code) ?? UNKNOWN_FAILURE;
}

/**
 * Read the account mirror list this panel wrote earlier.
 *
 * Exported for the silent account adoption, which must know which service
 * accounts the mirror already covers before it writes any.
 *
 * @param rt - Panel runtime.
 * @returns The mirrors; anything unreadable is treated as an empty list.
 */
export async function readStoredAccounts(rt: PanelRuntime): Promise<readonly AccountMirror[]> {
    try {
        const stored = await rt.host.storage.get(ACCOUNTS_STORAGE_KEY);
        const entries: readonly unknown[] = Array.isArray(stored) ? stored : [];

        return entries.filter(isAccountMirror);
    } catch {
        return [];
    }
}

/**
 * Persist the account mirror contract §3 records after a success.
 *
 * Exported for the silent account adoption, which records an account the
 * service already holds without any credential handoff.
 *
 * @param rt - Panel runtime.
 * @param identity - Identity and FR-010 matrix the service answered with
 *   (`scopeCheck: null` for the F4 status re-read, which reports no scopes).
 */
export async function writeAccountMirror(
    rt: PanelRuntime,
    identity: {
        readonly numericUserId: string;
        readonly login: string;
        readonly scopeCheck: ScopeMirror | null;
    },
): Promise<void> {
    const mirror: AccountMirror = {
        numericUserId: identity.numericUserId,
        login: identity.login,
        state: 'active',
        scopeCheck: identity.scopeCheck,
    };
    const stored = await readStoredAccounts(rt);
    const others = stored.filter((entry) => entry.numericUserId !== identity.numericUserId);
    await writeStorage(rt, { key: ACCOUNTS_STORAGE_KEY, value: [...others, mirror] });
}

/**
 * Handle a `201` verification: render the identity and mirror the account.
 *
 * @param rt - Panel runtime.
 * @param result - The service's success response.
 * @returns `true` when the body carried a usable identity.
 */
async function completeHandoff(rt: PanelRuntime, result: GuestRequestResult): Promise<boolean> {
    const root = parseJsonObject(result.body);
    if (root === null) {
        rt.state.handoff.note = UNKNOWN_FAILURE;

        return false;
    }

    const { numericUserId } = root;
    const { login } = root;
    if (typeof numericUserId !== 'string' || typeof login !== 'string') {
        rt.state.handoff.note = UNKNOWN_FAILURE;

        return false;
    }

    const identity = { numericUserId, login, scopeCheck: readScopeMirror(root.scopeCheck) };
    rt.state.handoff.connected = { numericUserId, login };
    rt.state.handoff.note = connectedLine(login);
    await writeAccountMirror(rt, identity);

    return true;
}

/**
 * Handle a failure thrown by `serviceRequest` (host transport codes, F1–F4).
 *
 * @param rt - Panel runtime.
 * @param error - The caught failure.
 */
async function applyHostFailure(rt: PanelRuntime, error: unknown): Promise<void> {
    const code = hostErrorCode(error);
    if (code === null) {
        rt.state.handoff.note = UNKNOWN_FAILURE;

        return;
    }

    if (code === 'HOST_TIMEOUT') {
        const snapshot = await rereadStatusAfterTimeout(rt);
        const appeared = snapshot?.accounts.find(
            (account) => !rt.state.handoff.knownAccountIds.includes(account.numericUserId),
        );
        if (appeared !== undefined) {
            await completeHandoff(rt, {
                status: 200,
                body: JSON.stringify({ numericUserId: appeared.numericUserId, login: appeared.login }),
            });

            return;
        }
    }

    rt.state.handoff.note = HOST_COPY.get(code) ?? UNKNOWN_FAILURE;
}

/**
 * Drop the stored consent mirror so the consent step shows again.
 *
 * @param rt - Panel runtime.
 * @returns `true` when the mirror was removed, `false` when the host refused.
 */
async function clearStoredConsent(rt: PanelRuntime): Promise<boolean> {
    try {
        await rt.host.storage.delete(CONSENT_STORAGE_KEY);

        return true;
    } catch {
        // A refused delete only leaves a stale mirror behind; the service
        // still refuses the next attempt, so the gate fails closed either way.
        return false;
    }
}

/**
 * Handle a non-2xx answer from the credential route (F5–F15).
 *
 * @param rt - Panel runtime.
 * @param result - The service's failure response.
 */
async function applyServiceFailure(rt: PanelRuntime, result: GuestRequestResult): Promise<void> {
    rt.state.handoff.connected = null;
    rt.state.handoff.note = serviceFailureCopy(result);
    if (result.status === HTTP_STORAGE_UNAVAILABLE) {
        rt.state.handoff.storageWritable = false;
    }

    if (serviceErrorEnvelope(result).code === 'consent-required') {
        // The service refused on consent grounds, so this install's stored
        // "yes" no longer covers the wording it enforces: drop the mirror so
        // the consent step shows again before the next attempt (§1.2).
        rt.state.handoff.consentGiven = false;
        await clearStoredConsent(rt);
    }
}

/**
 * Send the one-shot verification request (contract §2 step ④).
 *
 * @param rt - Panel runtime.
 * @param input - Credential and optional expected login.
 * @returns The service's answer.
 */
async function requestVerification(rt: PanelRuntime, input: HandoffInput): Promise<GuestRequestResult> {
    const body: Record<string, unknown> = { token: input.token, consentVersion: CONSENT_VERSION };
    if (input.expectedLogin !== undefined) {
        body.expectedLogin = input.expectedLogin;
    }

    return await rt.host.serviceRequest({ method: 'POST', path: VERIFY_PATH, body: JSON.stringify(body) });
}

/**
 * Run one handoff from paste to result (token-handoff §2).
 *
 * @param rt - Panel runtime.
 * @param input - The pasted credential and optional expected login.
 */
export async function runHandoff(rt: PanelRuntime, input: HandoffInput): Promise<void> {
    activeToken = input.token;
    rt.state.handoff.busy = true;
    try {
        const refusal = await handoffGate(rt);
        if (refusal !== null) {
            rt.state.handoff.note = refusal;

            return;
        }

        const result = await requestVerification(rt, input);
        if (result.status === HTTP_CREATED) {
            await completeHandoff(rt, result);
        } else {
            await applyServiceFailure(rt, result);
        }
    } catch (error) {
        await applyHostFailure(rt, error);
    } finally {
        activeToken = undefined;
        rt.state.handoff.busy = false;
    }
}
