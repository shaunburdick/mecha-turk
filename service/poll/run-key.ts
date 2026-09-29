/**
 * Run identity derivation (003 FR-010, FR-020, FR-029, FR-050).
 *
 * Everything a run is *called* is derived here, and derived deterministically
 * from the run key alone, so the service can re-derive an identity it has
 * already minted without storing a table of ids:
 *
 * - **run key** (FR-010) — the human-readable tuple
 *   `github|<account>|<owner/name>|<issue|pull_request>|<number>|<ordinal>`,
 *   displayed to the operator next to the correlation id;
 * - **correlation id** (FR-050) — `mt-run-<sha256(runKey) hex[0:24]>`, the
 *   single path-safe segment every hop of the chain carries;
 * - **attachment id** (FR-029) — the correlation id itself (identity
 *   derivation), so one copyable string finds the audit chain *and* the
 *   session in OpenChamber's list;
 * - **dispatch token** (FR-020) — `dtk-<sha256(runKey|attempt) hex[0:32]>`,
 *   minted **only when a reservation asks for it** (plan D4), never at claim.
 *
 * The token field is named `dispatchToken` everywhere it is persisted (plan
 * D6 / research §R3) so the credential-key guard never strips it while the
 * secret-shape scans still find zero credential occurrences; this module only
 * ever produces `dtk-<hex>`, which matches none of {@link findSecretLeak}'s
 * credential shapes.
 *
 * A row that must **name** a token without carrying it uses
 * {@link buildDispatchTokenFingerprint} instead: an unconsumed token is a live
 * authorization to report a result, and the audit trail is operator-facing and
 * retained for months, so the trail records a one-way `tokfp-…` identifier and
 * never the `dtk-…` value.
 *
 * The attachment bound is mirrored from the SDK's `GUEST_ATTACH_ID_MAX`
 * rather than imported: the service bundle must stay stdlib-only (AGENTS.md
 * invariant 6 keeps `@openchamber/sdk` a panel-side dependency), and a
 * mismatch is caught by the byte-format assertions in `tests/service-run-key`.
 */

import { createHash } from 'node:crypto';

/** Provider segment of every run key this build mints (FR-010's tuple). */
export const RUN_PROVIDER = 'github';

/** Longest attachment id the host accepts (`GUEST_ATTACH_ID_MAX`). */
export const ATTACHMENT_ID_MAX = 128;

/** Hex characters taken from the SHA-256 digest for a correlation id. */
const CORRELATION_HEX_CHARS = 24;

/** Hex characters taken from the SHA-256 digest for a dispatch token. */
const TOKEN_HEX_CHARS = 32;

/** Hex characters taken from the SHA-256 digest for a dispatch-token fingerprint. */
const FINGERPRINT_HEX_CHARS = 16;

/**
 * Prefix every token **fingerprint** carries.
 *
 * Deliberately *not* `dtk-`: the token namespace is itself a standing assertion
 * (no audit row may ever carry a `dtk-` value), so a fingerprint that shared the
 * prefix would be indistinguishable from a leaked token to that scan and to an
 * operator grepping the trail.
 */
export const FINGERPRINT_PREFIX = 'tokfp-';

/** Separator joining the run key's tuple segments. */
const KEY_SEPARATOR = '|';

/** The subject shapes a run can be about (FR-010). */
export type RunSubjectType = 'issue' | 'pull_request';

/** Coordinates a run key and its ordinal-free subject key are built from. */
export interface RunKeyInput {
    /** GitHub numeric user id of the account the work is under. */
    readonly accountNumericUserId: string;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** Whether the subject is an issue or a pull request. */
    readonly subjectType: RunSubjectType;
    /** Issue or pull request number. */
    readonly subjectNumber: number;
    /** 0-based ordinal of this run for its subject (FR-010). */
    readonly ordinal: number;
}

/**
 * Read the tuple's ordered segments, refusing any that would make it
 * ambiguous.
 *
 * The run key is displayed, re-derived, and hashed, so a segment carrying the
 * tuple's own separator would silently join two different subjects into one
 * key (constitution II: ambiguity is a stop condition, never a guess), and a
 * non-integer number or ordinal would make the key impossible to round-trip.
 *
 * @param input - The coordinates being assembled.
 * @returns The five segments, provider first and ordinal last.
 * @throws {Error} When a segment is empty or carries the `|` separator, or
 *   when the subject number or ordinal is not the integer its field names.
 */
function keySegments(input: RunKeyInput): readonly string[] {
    if (!Number.isInteger(input.subjectNumber) || input.subjectNumber < 1) {
        throw new Error('refusing to derive a run key without a positive subject number');
    }

    if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
        throw new Error('refusing to derive a run key without a non-negative ordinal');
    }

    const segments = [
        RUN_PROVIDER,
        input.accountNumericUserId,
        input.repository,
        input.subjectType,
        String(input.subjectNumber),
        String(input.ordinal),
    ];
    if (segments.some((segment) => segment === '' || segment.includes(KEY_SEPARATOR))) {
        throw new Error('refusing to derive a run key from a segment that carries the key separator');
    }

    return segments;
}

/**
 * Build the run key: FR-010's deterministic tuple.
 *
 * @param input - Subject coordinates plus this run's ordinal.
 * @returns `github|<account>|<owner/name>|<subjectType>|<number>|<ordinal>`.
 * @throws {Error} When a segment would make the tuple ambiguous.
 */
export function buildRunKey(input: RunKeyInput): string {
    return keySegments(input).join(KEY_SEPARATOR);
}

/**
 * Build the ordinal counter's key: the run key without its ordinal.
 *
 * The subject key is what `runs.json`'s `subjects` map is keyed by, and what
 * coalescing looks up (FR-011): every run of one subject under one account
 * shares it, so the counter survives terminal-run eviction and ordinals are
 * never reused (data-model §2.6).
 *
 * @param input - Subject coordinates; `ordinal` is ignored.
 * @returns `github|<account>|<owner/name>|<subjectType>|<number>`.
 * @throws {Error} When a segment would make the tuple ambiguous.
 */
export function buildSubjectKey(input: RunKeyInput): string {
    return keySegments(input).slice(0, -1).join(KEY_SEPARATOR);
}

/**
 * Hex-encode the prefix of one SHA-256 digest.
 *
 * @param text - Bytes to hash.
 * @param hexChars - How many hex characters of the digest to keep.
 * @returns The lower-case hex prefix.
 */
function digestHex(text: string, hexChars: number): string {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, hexChars);
}

/**
 * Derive a run's correlation id from its run key (FR-050).
 *
 * @param runKey - The run's key.
 * @returns `mt-run-<24 hex characters>` — one path-safe URL segment.
 */
export function buildCorrelationId(runKey: string): string {
    return `mt-run-${digestHex(runKey, CORRELATION_HEX_CHARS)}`;
}

/**
 * Derive a run's attachment id (FR-029): the correlation id, verbatim.
 *
 * @param correlationId - The run's correlation id.
 * @returns The same string, as the attachment id.
 * @throws {Error} When the id is not a single path-safe segment or exceeds
 *   {@link ATTACHMENT_ID_MAX} — a derivation bug must fail loudly rather than
 *   ship an attachment the host will reject or a segment a route cannot take.
 */
export function buildAttachmentId(correlationId: string): string {
    if (correlationId.length > ATTACHMENT_ID_MAX || !/^[A-Za-z0-9._~-]+$/.test(correlationId)) {
        throw new Error('refusing an attachment id that is not one path-safe segment within the host bound');
    }

    return correlationId;
}

/**
 * Mint the single-use dispatch token for one attempt (FR-020).
 *
 * Deterministic in the run key/attempt pair by design: the service
 * re-derives and validates it without storing a token table, and FR-033's
 * attempt reset (plan D6) re-derives a *fresh* token for the reset attempt.
 * Callers mint it **at reservation only** — never at claim (plan D4).
 *
 * @param runKey - The run's key.
 * @param attempt - The attempt number the token is for (starts at 1).
 * @returns `dtk-<32 hex characters>` — one path-safe URL segment.
 * @throws {Error} When the attempt is not a positive integer.
 */
export function buildDispatchToken(runKey: string, attempt: number): string {
    if (!Number.isInteger(attempt) || attempt < 1) {
        throw new Error('refusing to mint a dispatch token for an attempt that is not a positive integer');
    }

    return `dtk-${digestHex(`${runKey}${KEY_SEPARATOR}${attempt}`, TOKEN_HEX_CHARS)}`;
}

/**
 * Fingerprint one dispatch token for a row that must name it without carrying
 * it (003 FR-061; the `dispatch.unconfirmed` row).
 *
 * An unconsumed dispatch token is a live authorization to report a result, and
 * `audit.ndjson` is operator-facing and retained for months — so a row may name
 * *which* token was outstanding, never its value. This is a one-way digest of
 * the token bytes, not of the run key: two different tokens for one run (a
 * re-mint under a new attempt) produce two different fingerprints, so the row
 * still identifies the exact authorization, and the digest cannot be inverted
 * to recover a 256-bit token.
 *
 * @param dispatchToken - The token as recorded on the run's reservation.
 * @returns `tokfp-<16 hex characters>` — one path-safe segment.
 */
export function buildDispatchTokenFingerprint(dispatchToken: string): string {
    return `${FINGERPRINT_PREFIX}${digestHex(dispatchToken, FINGERPRINT_HEX_CHARS)}`;
}
