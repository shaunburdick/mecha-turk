/**
 * Silent adoption of service-side accounts the panel mirror lost (MVP
 * blocker 2 fix, 2026-09-27) plus the duplicate-refusal adopt (MVP, 2026-09-27).
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
 * The same read answers the duplicate refusal mid-flow (operator re-paste):
 * {@link isDuplicateRefusal} is the envelope check the handoff uses to route
 * the refusal here, and {@link adoptOnDuplicate} drives the shared adoption
 * core with the failed-adoption fallback copy, so the module owns one
 * adoption core plus the refusal test, and the handoff owns only the routing.
 *
 * Adoption asks for nothing of its own — there is no consent step left to
 * skip (002 v1.9.0) — and the one-shot paste path stays untouched for
 * genuinely new tokens.
 *
 * MVP-DEBT: with a usable account connected, the paste form stays hidden for
 * the whole mount — handing off a genuinely second account needs a panel
 * reload, or the bindings pane's "Remove account" affordance to clear the path.
 * Multi-account adoption renders the first usable account.
 */

import type { GuestRequestResult } from '@openchamber/sdk';
import { readScopeMirror, readStoredAccounts, writeAccountMirror } from './account-mirror.ts';
import { SERVICE_COPY, UNKNOWN_FAILURE, duplicateAdoptedLine } from './handoff-copy.ts';
import { asRecord, parseJsonObject } from './json.ts';
import type { PanelRuntime } from './panel-state.ts';
import { reloadBindingsAfterConnect } from './bindings.ts';
import { ACCOUNTS_PATH, serviceGet } from './service-calls.ts';

/** Service error code that says the pasted token belongs to a held account. */
const DUPLICATE_CODE = 'duplicate-account';

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
 * Decide whether one service answer is the duplicate-account refusal.
 *
 * The refusal is the service's own statement that the credential belongs to
 * an account it already holds — a state fact, not a credential verdict — so
 * it routes to adoption rather than to the failure copy.
 *
 * @param result - A non-2xx `POST /v1/accounts/verify` answer.
 * @returns `true` when the envelope carries the duplicate code.
 */
export function isDuplicateRefusal(result: GuestRequestResult): boolean {
    const root = parseJsonObject(result.body);
    const error = root?.error as { code?: unknown } | undefined;

    return typeof error?.code === 'string' && error.code === DUPLICATE_CODE;
}

/**
 * Narrow one entry of the service's `accounts` array.
 *
 * @param value - One array element.
 * @returns The row, or `null` when its identity fields do not hold text.
 */
function parseAccountRow(value: unknown): ServiceAccount | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const { numericUserId, login, state, scopeCheck } = record;
    if (typeof numericUserId !== 'string' || typeof login !== 'string' || typeof state !== 'string') {
        return null;
    }

    return { numericUserId, login, state, scopeCheck };
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
        const account = parseAccountRow(entry);
        if (account === null) {
            return null;
        }

        accounts.push(account);
    }

    return accounts;
}

/**
 * Whether the mount is still alive mid-adoption.
 *
 * A function call, so the type analyzer never narrows a check past it.
 *
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
function stillMounted(rt: PanelRuntime): boolean {
    return !rt.disposed;
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
 * mirror lacks, and connects the first usable one so the paste form
 * is not offered for an account the service already holds. Never throws and
 * never touches the one-shot paste path: a failed read or an unreadable body
 * simply leaves the flow exactly as it was. There is nothing to ask the
 * operator here: the service already holds the credential, and the consent
 * step this flow used to skip is gone.
 *
 * @param rt - Panel runtime.
 * @returns The adopted identity, or `null` when the service answered nothing
 *   adoptable (unreachable, unreadable body, no `active` account) or the
 *   panel already shows one.
 */
export async function adoptServiceAccounts(rt: PanelRuntime): Promise<AdoptedIdentity | null> {
    if (!stillMounted(rt) || rt.state.handoff.connected !== null) {
        return null;
    }

    const usable = await fetchUsableAccounts(rt);
    if (usable === null || !stillMounted(rt)) {
        return null;
    }

    await writeMissingMirrors(rt, usable);
    if (!stillMounted(rt)) {
        return null;
    }

    const first = usable[0];
    if (first === undefined) {
        return null;
    }

    const adopted: AdoptedIdentity = { numericUserId: first.numericUserId, login: first.login };
    rt.state.handoff.connected = adopted;

    return adopted;
}

/** The identity shape the handoff state carries once one account connects. */
export interface AdoptedIdentity {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
}

/**
 * Adopt on the duplicate refusal, keeping the panel's answer honest on failure.
 *
 * The happy path is the mount adoption's own: connect the first usable
 * account and hand its identity to the caller — the handoff renders the
 * adopted copy. When the service cannot be read at all, this *is* news worth
 * saying: the operator just demonstrated the account exists by hitting the
 * refusal, so the catalogue copy for that code lands on the note line, and
 * the next mount adoption gets its own chance once the service is reachable.
 *
 * @param rt - Panel runtime.
 * @returns The adopted identity, or `null` when adoption found nothing.
 */
export async function adoptOnDuplicate(rt: PanelRuntime): Promise<AdoptedIdentity | null> {
    rt.state.handoff.connected = null;
    const adopted = await adoptServiceAccounts(rt);
    if (adopted === null) {
        rt.state.handoff.note = SERVICE_COPY.get(DUPLICATE_CODE) ?? UNKNOWN_FAILURE;

        return null;
    }

    rt.state.handoff.note = duplicateAdoptedLine(adopted.login);
    // The adoption connected an account the panel mirror had lost, so the
    // Bindings tab's accounts dropdown re-reads before the operator looks at it.
    reloadBindingsAfterConnect(rt);

    return adopted;
}
