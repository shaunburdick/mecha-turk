/**
 * Account record: shape, validation, and the credential-free projection
 * (data-model.md Account, FR-006/FR-009/FR-012).
 *
 * The record is the **only** place a credential lives at rest
 * (`accounts/<numericUserId>.json`, `0600`), so this module draws the line
 * between the two projections explicitly: {@link Account} carries
 * `credential` and is never serialised into a response, while
 * {@link toAccountDto} builds the credential-free DTO every API surface
 * returns — by construction, not by discipline (SEC-15's credential-free
 * account DTOs). `tests/service-accounts.test.ts` asserts at the type level
 * that the DTO cannot carry a `credential` member.
 */

import { isRecord } from '../json.ts';
import type { CredentialKind, ScopeCheck } from '../github.ts';

/** Lifecycle state of an account (data-model.md Account). */
export type AccountState = 'pending_handoff' | 'verifying' | 'active' | 'rejected' | 'revoked' | 'error';

/** Operator-facing connection state derived from the last credential check. */
export type ConnectionState = 'connected' | 'auth-failed' | 'rate-limited' | 'offline';

/** The credential as it is stored at rest — never returned by any route. */
export interface CredentialRecord {
    /** The token itself; lives only inside `accounts/<id>.json`. */
    readonly token: string;
    /** Credential family recorded at verification time. */
    readonly kind: CredentialKind;
    /** RFC 3339 timestamp of the verification that proven this token. */
    readonly verifiedAt: string;
}

/** One durable account. */
export interface Account {
    /** GitHub numeric user id — the durable key (FR-009); never the login. */
    readonly numericUserId: string;
    /** Display login; a rename updates this field only (AC-004). */
    readonly login: string;
    /** Operator-supplied expected login, or `null` when not constrained. */
    readonly expectedLogin: string | null;
    /** Credential at rest; excluded from every response by {@link toAccountDto}. */
    readonly credential: CredentialRecord;
    /** FR-010 scope matrix taken at the last verification. */
    readonly scopeCheck: ScopeCheck;
    /** Lifecycle state; only `active` accounts poll (data-model transitions). */
    readonly state: AccountState;
    /** Last observed connection state, rendered in health. */
    readonly connectionState: ConnectionState;
    /** RFC 3339 timestamp of the successful verification (rotation refreshes it). */
    readonly verifiedAt: string;
    /** Machine-readable cause when `state` is `error`, e.g. `interrupted-handoff`. */
    readonly errorReason: string | null;
    /** RFC 3339 timestamp of account creation. */
    readonly createdAt: string;
    /** RFC 3339 timestamp of the last record change. */
    readonly updatedAt: string;
}

/** The credential-free account projection returned by every route. */
export interface AccountDto {
    /** GitHub numeric user id. */
    readonly numericUserId: string;
    /** Display login. */
    readonly login: string;
    /** Operator-supplied expected login, or `null`. */
    readonly expectedLogin: string | null;
    /** Lifecycle state. */
    readonly state: AccountState;
    /** Last observed connection state. */
    readonly connectionState: ConnectionState;
    /** RFC 3339 timestamp of the last successful verification. */
    readonly verifiedAt: string;
    /** FR-010 scope matrix. */
    readonly scopeCheck: ScopeCheck;
    /** Cause when `state` is `error`, otherwise `null`. */
    readonly errorReason: string | null;
    /** RFC 3339 timestamp of account creation. */
    readonly createdAt: string;
    /** RFC 3339 timestamp of the last change. */
    readonly updatedAt: string;
}

/** Every lifecycle state, in one place for the runtime guard. */
const ACCOUNT_STATES: ReadonlySet<string> = new Set<AccountState>([
    'pending_handoff',
    'verifying',
    'active',
    'rejected',
    'revoked',
    'error',
]);

/** Every connection state, in one place for the runtime guard. */
const CONNECTION_STATES: ReadonlySet<string> = new Set<ConnectionState>([
    'connected',
    'auth-failed',
    'rate-limited',
    'offline',
]);

/** Every credential family, in one place for the runtime guard. */
const CREDENTIAL_KINDS: ReadonlySet<string> = new Set<CredentialKind>(['fine-grained', 'classic', 'unknown']);

/** Longest accepted GitHub numeric id, in digits (ids fit comfortably below). */
const NUMERIC_ID_MAX_CHARS = 20;

/**
 * Narrow a value to a GitHub numeric user id.
 *
 * @param value - Candidate value from a URL segment or a `GET /user` payload.
 * @returns `true` only for a digit-only id of sane length — the same check
 *   keeps a path segment from ever escaping `accounts/`.
 */
export function isNumericUserId(value: unknown): value is string {
    return typeof value === 'string' && /^\d+$/.test(value) && value.length <= NUMERIC_ID_MAX_CHARS;
}

/**
 * Narrow a value to a lifecycle state.
 *
 * @param value - Candidate value from a stored record.
 * @returns `true` for one of the data-model states.
 */
function isAccountState(value: unknown): value is AccountState {
    return typeof value === 'string' && ACCOUNT_STATES.has(value);
}

/**
 * Narrow a value to a connection state.
 *
 * @param value - Candidate value from a stored record.
 * @returns `true` for one of the data-model states.
 */
function isConnectionState(value: unknown): value is ConnectionState {
    return typeof value === 'string' && CONNECTION_STATES.has(value);
}

/**
 * Narrow a value to a credential family.
 *
 * @param value - Candidate value from a stored record.
 * @returns `true` for one of the documented families.
 */
function isCredentialKind(value: unknown): value is CredentialKind {
    return typeof value === 'string' && CREDENTIAL_KINDS.has(value);
}

/**
 * Validate a stored scope matrix.
 *
 * @param raw - Candidate value from a stored record.
 * @returns `true` when all four FR-010 capabilities carry a legal result.
 */
function isScopeCheck(raw: unknown): raw is ScopeCheck {
    if (!isRecord(raw) || typeof raw.checkedAt !== 'string' || !isRecord(raw.results)) {
        return false;
    }

    const { results } = raw;

    return ['metadata', 'issues', 'pull-requests', 'contents'].every((capability) => {
        const value = results[capability];

        return value === 'ok' || value === 'missing' || value === 'unknown';
    });
}

/**
 * Validate the credential block of a stored record.
 *
 * @param raw - Candidate value from a stored record.
 * @returns `true` when the block is complete; a record without it is
 *   unusable and the store quarantines it rather than serving a token-less
 *   account as if it had a credential.
 */
function isCredentialRecord(raw: unknown): raw is CredentialRecord {
    return (
        isRecord(raw) &&
        typeof raw.token === 'string' &&
        raw.token !== '' &&
        isCredentialKind(raw.kind) &&
        typeof raw.verifiedAt === 'string'
    );
}

/** String fields a stored account record must carry. */
interface StoredAccountStrings {
    /** Display login; non-empty. */
    readonly login: string;
    /** Operator-supplied expected login, or `null`. */
    readonly expectedLogin: string | null;
    /** RFC 3339 timestamp of the last successful verification. */
    readonly verifiedAt: string;
    /** Cause when `state` is `error`, otherwise `null`. */
    readonly errorReason: string | null;
    /** RFC 3339 timestamp of account creation. */
    readonly createdAt: string;
    /** RFC 3339 timestamp of the last record change. */
    readonly updatedAt: string;
}

/**
 * Narrow a value to a string or an explicit `null`.
 *
 * @param value - Candidate value from a stored record.
 * @returns `true` for a string or `null`, never for a missing/odd type.
 */
function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

/**
 * Read and check the record's string fields in one pass.
 *
 * @param raw - Parsed document already known to be a record.
 * @returns The checked strings, or `null` when any of them is unusable.
 */
function readAccountStrings(raw: Record<string, unknown>): StoredAccountStrings | null {
    const { login, expectedLogin, verifiedAt, errorReason, createdAt, updatedAt } = raw;
    if (typeof login !== 'string' || login === '') {
        return null;
    }

    if (!isNullableString(expectedLogin) || !isNullableString(errorReason)) {
        return null;
    }

    if (typeof verifiedAt !== 'string' || typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
        return null;
    }

    return { login, expectedLogin, verifiedAt, errorReason, createdAt, updatedAt };
}

/**
 * Parse a stored document into an account.
 *
 * @param raw - Parsed `accounts/<id>.json` document.
 * @returns The account, or `null` when the document does not match the
 *   data-model shape (the store then quarantines it — never fail-stuck).
 */
export function parseStoredAccount(raw: unknown): Account | null {
    if (!isRecord(raw) || !isNumericUserId(raw.numericUserId)) {
        return null;
    }

    const strings = readAccountStrings(raw);
    if (strings === null) {
        return null;
    }

    if (!isCredentialRecord(raw.credential) || !isScopeCheck(raw.scopeCheck)) {
        return null;
    }

    if (!isAccountState(raw.state) || !isConnectionState(raw.connectionState)) {
        return null;
    }

    return {
        numericUserId: raw.numericUserId,
        ...strings,
        credential: raw.credential,
        scopeCheck: raw.scopeCheck,
        state: raw.state,
        connectionState: raw.connectionState,
    };
}

/**
 * Project an account into its credential-free DTO.
 *
 * The projection names every field it returns: a future `credential` addition
 * to the record cannot leak by spreading this object, which is what makes
 * "no credential fields, by construction" (contract §2.2) testable.
 *
 * @param account - The durable record.
 * @returns The DTO every API surface is allowed to return.
 */
export function toAccountDto(account: Account): AccountDto {
    return {
        numericUserId: account.numericUserId,
        login: account.login,
        expectedLogin: account.expectedLogin,
        state: account.state,
        connectionState: account.connectionState,
        verifiedAt: account.verifiedAt,
        scopeCheck: account.scopeCheck,
        errorReason: account.errorReason,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
    };
}
