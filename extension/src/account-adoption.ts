/**
 * Silent adoption of service-side accounts the panel mirror lost (MVP
 * blocker 2 fix, 2026-09-27).
 *
 * The service persists accounts outside `host.storage`; reinstalling the
 * extension wipes the panel mirror only. The operator who re-pastes the same
 * token then hits the service's duplicate refusal (409) and is stuck. This
 * module closes that gap from the panel side: every account `GET /v1/accounts`
 * reports as usable (`state: 'active'`) that the mirror does not know is
 * adopted silently — the identity is rendered from the service's own answer
 * and the mirror is rewritten, so the paste field is not offered for an
 * account the service already holds.
 *
 * Consent governs NEW token handoff only, so adoption asks for none, and the
 * one-shot paste path stays untouched for genuinely new tokens.
 *
 * MVP-DEBT: with a usable account connected, the paste form stays hidden for
 * the whole mount, so handing off a genuinely *second* account needs a panel
 * reload of a service with no usable accounts (or a future "add account"
 * affordance). Multi-account adoption renders the first usable account.
 */

import { readScopeMirror, readStoredAccounts, writeAccountMirror } from './handoff.ts';
import { parseJsonObject } from './json.ts';
import type { PanelRuntime } from './panel-state.ts';
import { serviceGet } from './service-calls.ts';

/** Path of the credential-free account collection (service contract §2.2). */
const ACCOUNTS_PATH = '/v1/accounts';

/** One service account row the adoption reads (credential-free DTO). */
interface ServiceAccount {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /** Lifecycle state; only `active` accounts adopt. */
    readonly state: string;
    /** Raw FR-010 matrix from the DTO, validated by {@link readScopeMirror}. */
    readonly scopeCheck: unknown;
}

/**
 * Narrow one entry of the `accounts` array.
 *
 * @param value - One array element.
 * @returns The row, or `null` when its identity fields do not hold text.
 */
function parseAccountEntry(value: unknown): ServiceAccount | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const { numericUserId, login, state } = record;
    if (typeof numericUserId !== 'string' || typeof login !== 'string' || typeof state !== 'string') {
        return null;
    }

    return { numericUserId, login, state, scopeCheck: record.scopeCheck };
}

/**
 * Parse the account list response body.
 *
 * One unreadable entry fails the whole body: adopting a half-understood list
 * would mirror accounts this panel cannot vouch for.
 *
 * @param text - Response body text.
 * @returns The accounts, or `null` when the shape is unusable.
 */
function parseAccountsBody(text: string): readonly ServiceAccount[] | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.accounts)) {
        return null;
    }

    const accounts: ServiceAccount[] = [];
    for (const entry of root.accounts) {
        const account = parseAccountEntry(entry);
        if (account === null) {
            return null;
        }

        accounts.push(account);
    }

    return accounts;
}

/**
 * Adopt the service's usable accounts the panel mirror is missing.
 *
 * Reads `GET /v1/accounts`, writes a mirror for every usable account the
 * mirror lacks, and shows `Connected as <login>` for the first usable one so
 * the paste/consent form is not offered for an account the service already
 * holds. Never throws and never touches the one-shot paste path: a failed
 * read or an unreadable body simply leaves the flow exactly as it was.
 *
 * @param rt - Panel runtime.
 */
/**
 * Whether the mount is still alive mid-adoption.
 *
 * A function call, so the type analyzer never narrows a check past it.
 *
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
function stillMounted(rt: PanelRuntime): boolean {
    return rt.disposed === false;
}

/**
 * Read the service's usable accounts, or `null` when none are adoptable.
 *
 * @param rt - Panel runtime.
 * @returns The `active` accounts, or `null` when the read failed, the body
 *   was unreadable, or nothing usable is registered.
 */
async function fetchUsableAccounts(rt: PanelRuntime): Promise<readonly ServiceAccount[] | null> {
    const result = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: ACCOUNTS_PATH });
    if (!stillMounted(rt) || !result.ok) {
        return null;
    }

    const accounts = parseAccountsBody(result.body);
    const usable = accounts === null ? [] : accounts.filter((account) => account.state === 'active');

    return usable.length === 0 ? null : usable;
}

/**
 * Write a mirror for every usable account the mirror does not cover.
 *
 * @param rt - Panel runtime.
 * @param usable - The service's `active` accounts.
 */
async function writeMissingMirrors(rt: PanelRuntime, usable: readonly ServiceAccount[]): Promise<void> {
    const stored = await readStoredAccounts(rt);
    const mirrored = new Set(stored.map((mirror) => mirror.numericUserId));
    for (const account of usable) {
        if (mirrored.has(account.numericUserId)) {
            continue;
        }

        // MVP-DEBT: the scope matrix is adopted as the service DTO carries
        // it; a DTO row without a readable matrix mirrors `scopeCheck: null`
        // rather than fabricating verdicts (FR-010, review M1).
        await writeAccountMirror(rt, {
            numericUserId: account.numericUserId,
            login: account.login,
            scopeCheck: readScopeMirror(account.scopeCheck),
        });
    }
}

/**
 * Adopt the service's usable accounts the panel mirror is missing.
 *
 * Reads `GET /v1/accounts`, writes a mirror for every usable account the
 * mirror lacks, and shows `Connected as <login>` for the first usable one so
 * the paste/consent form is not offered for an account the service already
 * holds. Never throws and never touches the one-shot paste path: a failed
 * read or an unreadable body simply leaves the flow exactly as it was.
 *
 * @param rt - Panel runtime.
 */
export async function adoptServiceAccounts(rt: PanelRuntime): Promise<void> {
    if (!stillMounted(rt) || rt.state.handoff.connected !== null) {
        return;
    }

    const usable = await fetchUsableAccounts(rt);
    if (usable === null || !stillMounted(rt)) {
        return;
    }

    await writeMissingMirrors(rt, usable);
    if (!stillMounted(rt)) {
        return;
    }

    const first = usable[0];
    if (first !== undefined) {
        rt.state.handoff.connected = { numericUserId: first.numericUserId, login: first.login };
    }
}
