/**
 * Run identity derivation (003 FR-010, FR-020, FR-029, FR-050).
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

/** The subject shapes a run can be about. */
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
    /** 0-based ordinal of this run for its subject. */
    readonly ordinal: number;
}

/**
 * Read the tuple's ordered segments, refusing any that would make it
 * ambiguous: the run key is displayed, re-derived and hashed, so a segment
 * carrying the tuple's own separator would silently join two different
 * subjects into one key (constitution II: ambiguity is a stop condition,
 * never a guess), and a non-integer number or ordinal would make the key
 * impossible to round-trip.
 */
function keySegments(input: RunKeyInput): readonly string[] {
    if (!Number.isSafeInteger(input.subjectNumber) || input.subjectNumber < 1) {
        throw new Error('refusing to derive a run key without a positive subject number');
    }

    if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
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
 */
export function buildRunKey(input: RunKeyInput): string {
    return keySegments(input).join(KEY_SEPARATOR);
}

/**
 * Build the ordinal counter's key: the run key without its ordinal.
 *
 * The subject key is what `runs.json`'s `subjects` map is keyed by, and what
 * coalescing looks up: every run of one subject under one account
 * shares it, so the counter survives terminal-run eviction and ordinals are
 * never reused (data-model §2.6).
 *
 */
export function buildSubjectKey(input: RunKeyInput): string {
    return keySegments(input).slice(0, -1).join(KEY_SEPARATOR);
}

/**
 * Hex-encode the prefix of one SHA-256 digest.
 */
function digestHex(text: string, hexChars: number): string {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, hexChars);
}

/**
 * Derive a run's correlation id from its run key.
 */
export function buildCorrelationId(runKey: string): string {
    return `mt-run-${digestHex(runKey, CORRELATION_HEX_CHARS)}`;
}

/**
 * Derive a run's attachment id: the correlation id, verbatim.
 *
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
 * Mint the single-use dispatch token for one attempt.
 *
 * Deterministic in the run key/attempt pair by design: the service
 * re-derives and validates it without storing a token table, and FR-033's
 * attempt reset re-derives a *fresh* token for the reset attempt.
 * Callers mint it **at reservation only** — never at claim.
 *
 */
export function buildDispatchToken(runKey: string, attempt: number): string {
    if (!Number.isSafeInteger(attempt) || attempt < 1) {
        throw new Error('refusing to mint a dispatch token for an attempt that is not a positive integer');
    }

    return `dtk-${digestHex(`${runKey}${KEY_SEPARATOR}${attempt}`, TOKEN_HEX_CHARS)}`;
}

/**
 * Fingerprint one dispatch token for a row that must name it without
 * carrying it (003 FR-061; the `dispatch.unconfirmed` row). An unconsumed
 * token is a live authorization to report a result, and `audit.ndjson` is
 * operator-facing and retained for months — so a row may name *which* token
 * was outstanding, never its value. The digest is of the token bytes rather
 * than the run key, so a re-mint under a new attempt yields a different
 * fingerprint, the row still identifies the exact authorization, and it
 * cannot be inverted to recover a 256-bit token.
 */
export function buildDispatchTokenFingerprint(dispatchToken: string): string {
    return `${FINGERPRINT_PREFIX}${digestHex(dispatchToken, FINGERPRINT_HEX_CHARS)}`;
}
