/**
 * The accounts DTO the panel reads: the credential-free account list, its
 * lifecycle members, and the four-capability scope matrix (005 FR-062, FR-066;
 * 004 FR-082, FR-089).
 *
 * Split out of [`bindings-service.ts`](./bindings-service.ts) for the
 * file-length gate, and because the accounts list is a **different record with
 * a different rule set** from the binding rows the Bindings tab grants: it is
 * read-only (the panel writes accounts through their own profile route), it
 * carries a nested matrix rather than a flat set of trigger flags, and its
 * display label and account-tier prompt are the two members 004 and 005
 * re-cut. One reader per record, and each reader fails closed on its own terms.
 *
 * **Nothing here is a credential.** The DTO carries identities and state, never
 * a token, and the panel renders it as text (005 FR-080).
 *
 * The names are re-exported from `bindings-service.ts` so every existing import
 * keeps working — exactly as `panel-state.ts` re-exports `AccountsTabState`
 * from `accounts-state.ts` — while the record's own module says what it is.
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
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /**
     * Operator display label as the service stored it, or `null` when unset.
     *
     *
     * The panel reads it; it never renders it as identity — `login` stays the
     * fact the row shows when there is no label.
     */
    readonly displayName: string | null;
    /**
     * The account tier of the starting prompt, or absent when this account
     * has none.
     *
     * `null` on the wire and absent in this type both read as *unset* — a
     * complete, valid state — so `?? ''` is all a reader needs. It is read
     * only: the row summary shows presence and length, never this text and
     * never a fingerprint, the account mirror never stores it,
     * and the profile write carries it as **one member of a
     * closed body**, absent = unchanged.
     *
     * `| undefined` is explicit because `exactOptionalPropertyTypes` is on:
     * a record that left the member out **omits** the key (the parse writes
     * it only for a string), and a value that is neither text nor `null`
     * refuses the whole body (invariant 8).
     */
    readonly startingPrompt?: string | null | undefined;
    /** `true` only for accounts whose latest verification succeeded. */
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
    /** Connection state as the DTO reports it, absent when not carried. */
    readonly connectionState?: string;
    /** RFC 3339 stamp of the last successful verification, or absent. */
    readonly verifiedAt?: string;
    /** Cause when `state` is `error`; `null`/absent means none was recorded. */
    readonly errorReason?: string | null;
    /** The four-capability FR-010 matrix, absent when the DTO carried none. */
    readonly scopeMatrix?: AccountScopeMatrix;
}


/** The two operator-editable members of one account record. */
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

/** How the accounts reader narrows those two members. */
type PanelMembers =
    /** Both readable; `fields` joins the panel record as-is. */
    | { readonly ok: true; readonly fields: PanelMemberFields }
    /** A member present and not text: the whole body is refused (invariant 8). */
    | { readonly ok: false };

/**
 * Narrow the two members the account profile write edits (005 FR-066, 004
 * FR-082).
 *
 * Both are `string | null` on the wire and both read as *unset* when absent
 * — a store that predates either needs no migration —
 * and a value that is neither text nor `null` refuses the whole body rather
 * than being dropped: a record that silently lost its prompt would render
 * *not set* while the service still dispatched with it.
 *
 * Extracted so `parseAccountsBody` stays inside its complexity budget: one
 * pass, one refusal, and the unset prompt's key simply not written.
 *
 * @returns Both members, or the refusal that stops the read.
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

/** Members of one account record the Accounts rows render, beyond identity. */
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
 * Narrow one account's `scopeCheck` DTO field to a verdict (003 T-029).
 *
 * The narrowing itself is account-mirror's {@link readScopeMirror} — the same
 * four-capability matrix the handoff records into storage — so the mirror and
 * the wire DTO can never drift into two different meanings of "readable". A
 * body without a usable matrix answers `null`, which is *no evidence* rather
 * than *no problem*: the prerequisites section renders that as not checkable
 * and never as satisfied.
 *
 * @param raw - `scopeCheck` from the accounts DTO, or anything else.
 * @returns The verdict, or `null` when the DTO carries no readable matrix.
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
