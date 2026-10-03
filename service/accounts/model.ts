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
import { validateStartingPrompt } from '../prompt.ts';
import { findSecretLeak } from '../../src/redaction.ts';
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
    /**
     * Operator-supplied display label, or `null` when unset (005 FR-066).
     *
     * Display only: it never takes part in identity, in a durable key, or in
     * the binding's account reference — the numeric id stays the key (002
     * FR-009). Absent in every record this build wrote before the field, which
     * reads as `null` without a migration (FR-005: the upgrade writes nothing).
     */
    readonly displayName: string | null;
    /**
     * The account's starting-prompt tier, or `null` when unset (004 FR-082).
     *
     * The record is the tier's only home, so it lives and dies with the
     * account: `DELETE ?force=1` removes both together, rotation, login rename,
     * and credential refresh leave it byte-identical, and a re-added account
     * starts unset — no tier is ever seeded (FR-071). Absent in every record
     * this build wrote before the field, which reads as `null` without a
     * migration (FR-018: the upgrade writes nothing).
     *
     * A stored value that fails the one `validateStartingPrompt` refuses the
     * whole record rather than being coerced or dropped — the store
     * quarantines the file (FR-017's posture applied to this store).
     */
    readonly startingPrompt: string | null;
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
    /** Operator-supplied display label, or `null` when unset (005 FR-066). */
    readonly displayName: string | null;
    /**
     * The account's starting-prompt tier, or `null` when unset (004 FR-082).
     *
     * Added **by name** — the projection names every member it returns, so the
     * credential-free guarantee stays a property of the construction rather
     * than of a denylist. Free text only: `toAccountDto` copies nothing from
     * `credential`, and the type-level guard the suite compiles still holds.
     */
    readonly startingPrompt: string | null;
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
    /** Operator-supplied display label, or `null` when absent or unset. */
    readonly displayName: string | null;
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
 * What a stored-document parse refused, in the `field: remediation` voice.
 *
 * The bindings read's `RefusalNote` pattern (004 FR-019) applied to this
 * store: the sink lets `readAccount` log *why* a file was quarantined without
 * ever logging a byte of what it held. `reason` is written at most once —
 * later refusals do not overwrite the first — and the refusal vocabulary never
 * echoes a value, so a credential-shaped prompt cannot reach the log line
 * through it (004 FR-024, AC-133).
 */
export interface AccountRefusalNote {
    /** First `field: remediation` the parser refused, or `null` when none was named. */
    reason: string | null;
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
 * Narrow a value to "absent, null, or text".
 *
 * The absent half is the pre-005 shape of `displayName`, which reads as
 * `null` without a migration (FR-005: the upgrade writes nothing); a
 * present-but-not-text value is refused like every other malformed member
 * (invariant 8) rather than silently dropped.
 *
 * @param value - Candidate value from a stored record.
 * @returns `true` for a string, `null`, or an absent key.
 */
function isOptionalNullableString(value: unknown): value is string | null | undefined {
    return value === undefined || value === null || typeof value === 'string';
}

/**
 * Read and check the record's string fields in one pass.
 *
 * @param raw - Parsed document already known to be a record.
 * @returns The checked strings, or `null` when any of them is unusable.
 */
function readAccountStrings(raw: Record<string, unknown>): StoredAccountStrings | null {
    const { login, expectedLogin, displayName, verifiedAt, errorReason, createdAt, updatedAt } = raw;
    if (typeof login !== 'string' || login === '') {
        return null;
    }

    if (!isNullableString(expectedLogin) || !isNullableString(errorReason)) {
        return null;
    }

    if (!isOptionalNullableString(displayName)) {
        return null;
    }

    if (typeof verifiedAt !== 'string' || typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
        return null;
    }

    return {
        login,
        expectedLogin,
        displayName: displayName ?? null,
        verifiedAt,
        errorReason,
        createdAt,
        updatedAt,
    };
}

/**
 * Parse a stored document into an account.
 *
 * Every member is checked before the record is handed back, and the account
 * tier goes through the **one** `validateStartingPrompt` (FR-083): a document
 * carrying a non-text, oversized, credential-shaped, or marker-bearing
 * `startingPrompt` is refused **as a whole record** rather than read with a
 * coerced, defaulted, or dropped member (FR-017, FR-028). The refusal's
 * `field: remediation` is captured in `note` so the store can log why the file
 * was set aside — never a byte of what it held.
 *
 * Absence and `null` are the complete "unset" state: both read as `null`, the
 * file is neither quarantined nor rewritten (FR-018).
 *
 * @param raw - Parsed `accounts/<id>.json` document.
 * @param note - Sink the first field-level refusal is captured into.
 * @returns The account, or `null` when the document does not match the
 *   data-model shape (the store then quarantines it — never fail-stuck).
 */
export function parseStoredAccount(raw: unknown, note: AccountRefusalNote): Account | null {
    if (!isRecord(raw) || !isNumericUserId(raw.numericUserId)) {
        return null;
    }

    // Checked first so a hand-edited prompt always reaches the note: this is
    // the refusal the log exists to explain (the bindings read's posture).
    const prompt = validateStartingPrompt(raw.startingPrompt);
    if (!prompt.ok) {
        note.reason ??= `${prompt.issue.field}: ${prompt.issue.remediation}`;

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
        startingPrompt: prompt.prompt,
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
        displayName: account.displayName,
        startingPrompt: account.startingPrompt,
        state: account.state,
        connectionState: account.connectionState,
        verifiedAt: account.verifiedAt,
        scopeCheck: account.scopeCheck,
        errorReason: account.errorReason,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
    };
}

/** Longest accepted display name, in Unicode code points (005 contract §2). */
export const DISPLAY_NAME_MAX_CODE_POINTS = 80;

/** The field every display-name refusal names, so a client renders it in place. */
export type DisplayNameField = 'displayName';

/** Refused because the value is present but is not text (contract §2 step 1). */
const DISPLAY_NAME_TYPE = 'displayName must be text, or null to clear it';

/** Refused because the value is over the cap (contract §2 step 4); never quotes it. */
const DISPLAY_NAME_CAP = `displayName must be at most ${DISPLAY_NAME_MAX_CODE_POINTS} characters`
    + ' (Unicode code points) after trimming';

/** Refused because the value carries invisible or direction-altering text (step 6). */
const DISPLAY_NAME_CONTROL = 'displayName must not contain control characters';

/** Last C0 control character (inclusive). */
const LAST_C0 = 0x1f;

/** C1 control range, inclusive on both ends. */
const FIRST_C1 = 0x7f;
const LAST_C1 = 0x9f;

/**
 * Whether a string carries a C0 or C1 control character.
 *
 * Written as a code-point walk rather than a regular expression so the
 * character classes are visible as numbers: a control character in source is
 * exactly the kind of thing that renders as nothing and reads as a space.
 *
 * @param value - The already-trimmed candidate.
 * @returns `true` when at least one character is invisible or direction-altering.
 */
function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= LAST_C0 || (code >= FIRST_C1 && code <= LAST_C1)) {
            return true;
        }
    }

    return false;
}

/** One refused display name, in the `field` + remediation voice every refusal shares. */
export interface DisplayNameIssue {
    /** Always the display-name field, so the refusal renders where it belongs. */
    readonly field: DisplayNameField;
    /** How to fix it; never echoes any part of the submitted value. */
    readonly remediation: string;
}

/** Result of validating one candidate display name (005 contract §2). */
export type DisplayNameValidation =
    /** Usable text (trimmed), or `null` for "no display name". */
    | { readonly ok: true; readonly displayName: string | null }
    /** A refusal; nothing is written and nothing of the value is echoed. */
    | { readonly ok: false; readonly issue: DisplayNameIssue };

/**
 * Validate one candidate display name, in the contract's six-step order.
 *
 * Type → trim → empty-or-null clears → cap → credential shape → control
 * characters. The order matters: the cap is checked *before* the detector, so
 * an oversized credential-shaped value is refused on its length alone and the
 * refusal cannot leak a single character of what was submitted (AC-130,
 * FR-085). No content policy beyond these steps — it is a label, and the
 * service does not decide what an operator may call their own account.
 *
 * @param raw - The value exactly as the body carried it.
 * @returns The trimmed name (`null` to clear), or the refusal that beat it.
 */
export function validateDisplayName(raw: unknown): DisplayNameValidation {
    if (raw !== null && typeof raw !== 'string') {
        return { ok: false, issue: { field: 'displayName', remediation: DISPLAY_NAME_TYPE } };
    }

    if (raw === null) {
        return { ok: true, displayName: null };
    }

    const trimmed = raw.trim();
    if (trimmed === '') {
        return { ok: true, displayName: null };
    }

    if ([...trimmed].length > DISPLAY_NAME_MAX_CODE_POINTS) {
        return { ok: false, issue: { field: 'displayName', remediation: DISPLAY_NAME_CAP } };
    }

    const label = findSecretLeak(trimmed);
    if (label !== null) {
        return {
            ok: false,
            issue: {
                field: 'displayName',
                remediation: `displayName must not contain credential-shaped material (matched shape: ${label})`,
            },
        };
    }

    if (hasControlCharacter(trimmed)) {
        return { ok: false, issue: { field: 'displayName', remediation: DISPLAY_NAME_CONTROL } };
    }

    return { ok: true, displayName: trimmed };
}
