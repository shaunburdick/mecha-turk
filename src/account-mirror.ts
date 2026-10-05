/**
 * The account mirror the panel records in `host.storage` (contract §3).
 *
 * One record per connected GitHub account: identity, lifecycle state, and the
 * FR-010 scope matrix, written after a successful handoff and rewritten by the
 * silent account adoption. The module owns the storage key, the narrowing of
 * stored entries, and the read/write helpers, so every consumer (the handoff,
 * the adoption, the removal affordance) shares one shape and one failure rule:
 * a mirror this panel cannot fully vouch for is not one.
 *
 * Extracted from `handoff.ts` so the adoption and the removal can import the
 * mirror rules without an import cycle through the one-shot paste path.
 */

import { writeStorage } from './storage-write.ts';
import type { PanelRuntime } from './panel-state.ts';

/** `host.storage` key holding the account mirror from contract §3. */
export const ACCOUNTS_STORAGE_KEY = 'accounts';

/** FR-010 capabilities, in the order the contract's matrix reports them. */
const SCOPE_CAPABILITIES = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/** One FR-010 capability name (contract §2 step ⑥). */
export type ScopeCapability = (typeof SCOPE_CAPABILITIES)[number];

/** Result recorded for one capability: `ok`, `missing`, or `unknown`. */
export type ScopeResult = 'ok' | 'missing' | 'unknown';

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

/**
 * Read the account mirror list this panel wrote earlier.
 *
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
 * Persist an account mirror after a success or an adoption (contract §3).
 *
 * The list is rewritten whole with this identity replacing any earlier entry
 * for the same account.
 *
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
 * Drop one account from the stored mirror list (operator-driven removal).
 *
 * A missing entry or a refused write is not an error of its own: the service
 * has already forgotten the account, and the next adoption pass (or the next
 * handoff) repairs the mirror. The removal path reports the service outcome
 * on its own note line; this only keeps the panel copy from outliving it.
 *
 * @param numericUserId - Account whose mirror entry is removed.
 */
export async function removeAccountMirror(rt: PanelRuntime, numericUserId: string): Promise<void> {
    const stored = await readStoredAccounts(rt);
    const others = stored.filter((entry) => entry.numericUserId !== numericUserId);
    await writeStorage(rt, { key: ACCOUNTS_STORAGE_KEY, value: others });
}

/**
 * Parse a stored identity pair this panel wrote into a mirror.
 *
 * Exported for callers that render an identity they read back from storage.
 *
 * @param value - One entry from the `accounts` storage key.
 * @returns The mirror, or `null` when the entry is not one of this panel's.
 */
export function parseAccountMirror(value: unknown): AccountMirror | null {
    return isAccountMirror(value) ? value : null;
}
