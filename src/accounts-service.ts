/**
 * The accounts DTO the panel reads: the credential-free account list, its
 * lifecycle members, and the four-capability scope matrix (005 FR-062, FR-066;
 * 004 FR-082, FR-089); nothing here is a credential (005 FR-080).
 */

import { asRecord, parseJsonObject } from './json.ts';
import { readScopeMirror } from './account-mirror.ts';
import type { ScopeCapability, ScopeResult } from './account-mirror.ts';

/** Verdict one account's recorded scope matrix gives its token (FR-010). */
export type AccountScopeVerdict = 'ok' | 'missing' | 'unknown';

/** The four-capability FR-010 matrix as the account DTO carries it. */
export type AccountScopeMatrix = Readonly<Record<ScopeCapability, ScopeResult>>;

/** One registered account the panel can bind (credential never present). */
export interface PanelAccount {
    readonly numericUserId: string;
    readonly login: string;
    /**
     * Operator display label as the service stored it, or `null` when unset.
     *
     * The panel reads it; it never renders it as identity — `login` stays the
     * fact the row shows when there is no label.
     */
    readonly displayName: string | null;
    /**
     * The account tier of the starting prompt, or absent when this account has
     * none. `null` on the wire and absent in this type both read as *unset* —
     * a complete, valid state — so `?? ''` is all a reader needs. Read only:
     * the row summary shows presence and length, the mirror never stores it,
     * and the profile write carries it as **one member of a closed body**,
     * absent = unchanged. `| undefined` is explicit because
     * `exactOptionalPropertyTypes` is on — a record that left the member out
     * **omits** the key, and a value that is neither text nor `null` refuses
     * the whole body (invariant 8).
     */
    readonly startingPrompt?: string | null | undefined;
    readonly usable: boolean;
    /**
     * What this account's recorded FR-010 scope matrix says about its token,
     * absent when the DTO carried no matrix this build reads.
     *
     * Absent means *no evidence*, never *no problem*: the prerequisites
     * section renders it as not checkable, never as satisfied.
     */
    readonly scope?: AccountScopeVerdict;
    /**
     * Lifecycle state as the accounts DTO reports it, absent
     * when this body carried none.
     *
     * Deliberately `string` rather than a closed union: an unknown state has
     * to reach the operator as `unknown state: <raw>` rather than be narrowed
     * away, and `usable` below is derived from the value,
     * not from this annotation.
     */
    readonly state?: string;
    readonly connectionState?: string;
    readonly verifiedAt?: string;
    readonly errorReason?: string | null;
    /** The four-capability FR-010 matrix, absent when the DTO carried none. */
    readonly scopeMatrix?: AccountScopeMatrix;
}


interface PanelMemberFields {
    /** Operator display label, or `null` when the row leads with the login. */
    readonly displayName: string | null;
    /**
     * The account tier of the prompt. The key is **absent** when the tier is
     * unset — 004 FR-082's complete, valid state — which is what lets a
     * `JSON.stringify` of this record never carry an empty member.
     */
    readonly startingPrompt?: string | undefined;
}

type PanelMembers =
    | { readonly ok: true; readonly fields: PanelMemberFields }
    /** A member present and not text: the whole body is refused (invariant 8). */
    | { readonly ok: false };

/**
 * Narrow the two members the account profile write edits (005 FR-066, 004
 * FR-082). Both are `string | null` on the wire and both read as *unset* when
 * absent — a store that predates either needs no migration — and a value that
 * is neither text nor `null` refuses the whole body rather than being dropped:
 * a record that silently lost its prompt would render *not set* while the
 * service still dispatched with it. Extracted so `parseAccountsBody` stays
 * inside its complexity budget.
 */
function readPanelMembers(record: Record<string, unknown>): PanelMembers {
    const { displayName, startingPrompt } = record;
    for (const value of [displayName, startingPrompt]) {
        if (value !== undefined && value !== null && typeof value !== 'string') {
            return { ok: false };
        }
    }

    return {
        ok: true,
        fields: {
            displayName: typeof displayName === 'string' ? displayName : null,
            ...(typeof startingPrompt === 'string' && { startingPrompt }),
        },
    };
}

type AccountDetail = Pick<
    PanelAccount,
    'state' | 'connectionState' | 'verifiedAt' | 'errorReason' | 'scopeMatrix'
>;

/**
 * Read one account record's FR-062 detail members (005 FR-062, FR-067).
 *
 * Present-and-not-text refuses the whole body (invariant 8) rather than being
 * dropped, because a row that silently lost its lifecycle state would render
 * an account as unexplained. Absent stays absent: a member this DTO did not
 * carry reads as *not reported*, never as a plausible default.
 *
 * @returns The detail, or `null` when a member was present but unusable.
 */
function readAccountDetail(record: Record<string, unknown>): AccountDetail | null {
    const detail: {
        state?: string;
        connectionState?: string;
        verifiedAt?: string;
        errorReason?: string | null;
        scopeMatrix?: AccountScopeMatrix;
    } = {};

    for (const field of ['state', 'connectionState', 'verifiedAt'] as const) {
        const value = record[field];
        if (value === undefined) {
            continue;
        }

        if (typeof value !== 'string') {
            return null;
        }

        detail[field] = value;
    }

    const { errorReason } = record;
    if (errorReason !== undefined && errorReason !== null) {
        if (typeof errorReason !== 'string') {
            return null;
        }

        detail.errorReason = errorReason;
    }

    const matrix = readScopeMirror(record.scopeCheck)?.results;
    if (matrix !== undefined) {
        detail.scopeMatrix = matrix;
    }

    return detail;
}

/**
 * Narrow one account's `scopeCheck` DTO field to a verdict (003 T-029). The
 * narrowing is account-mirror's {@link readScopeMirror} — the same
 * four-capability matrix the handoff records into storage — so mirror and wire
 * DTO can never drift into two different meanings of "readable". A body
 * without a usable matrix answers `null`, which is *no evidence* rather than
 * *no problem*: the prerequisites section renders that as not checkable and
 * never as satisfied.
 */
function accountScope(raw: unknown): AccountScopeVerdict | null {
    const mirror = readScopeMirror(raw);
    if (mirror === null) {
        return null;
    }

    const results = Object.values(mirror.results);
    if (results.includes('missing')) {
        return 'missing';
    }

    return results.includes('unknown') ? 'unknown' : 'ok';
}

/**
 * Parse the accounts response body into the records the picker offers.
 *
 * @returns The accounts, or `null` when the shape is unusable.
 */
export function parseAccountsBody(text: string): PanelAccount[] | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.accounts)) {
        return null;
    }

    const accounts: PanelAccount[] = [];
    for (const entry of root.accounts) {
        const record = asRecord(entry);
        if (record === null) {
            return null;
        }

        const { numericUserId, login } = record;
        if (typeof numericUserId !== 'string' || typeof login !== 'string') {
            return null;
        }

        const members = readPanelMembers(record);
        if (!members.ok) {
            return null;
        }

        const detail = readAccountDetail(record);
        if (detail === null) {
            return null;
        }

        // The key stays *absent* when there is no readable matrix, so a
        // record that never carried one and a matrix this build cannot read
        // are indistinguishable — both mean "no evidence".
        const scope = accountScope(record.scopeCheck);
        accounts.push({
            numericUserId,
            login,
            ...members.fields,
            usable: detail.state === 'active',
            ...detail,
            ...(scope !== null && { scope }),
        });
    }

    return accounts;
}
