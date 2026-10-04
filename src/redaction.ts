/**
 * Secret-detection helpers guarding every panel-side write.
 *
 * The panel is not supposed to hold secret material at all: OpenChamber
 * attaches a provider token to outbound requests itself (and the panel makes
 * no GitHub request of its own since the install-time card went), while the
 * one credential that does reach the panel — a pasted PAT for the one-shot
 * handoff — is read and cleared in the same tick. Because the ledger and the
 * evidence record are built from strings the panel composes, "no secrets in
 * storage" is enforced here as an executable assertion instead of a promise:
 * every value written to `host.storage` passes through
 * {@link assertRedacted} first.
 */

/** Scalar value kinds a redacted record may hold. */
type Scalar = string | number | boolean | null;

/** One secret-shaped value the panel must never persist. */
interface SecretPattern {
    /** Stable identifier reported in the error, never the matched text. */
    readonly label: string;
    /** Pattern that recognises the shape, global so one pass covers every match. Kept linear to avoid backtracking. */
    readonly pattern: RegExp;
}

/**
 * Secret shapes recognised by {@link findSecretLeak}.
 *
 * The list covers GitHub token formats (`ghp_`, `gho_`, `ghu_`, `ghs_`,
 * `ghr_`, `github_pat_`) plus the two transport spellings that would appear
 * if a header were ever copied into a record: `Authorization:` and
 * `Bearer <credential>`.
 *
 * Patterns are global so {@link redact} replaces every occurrence in one pass;
 * detection uses `String.match`, which scans from the start and never inherits
 * the `lastIndex` state a `RegExp.test()` call would carry over.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
    { label: 'github-token-classic', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
    { label: 'github-token-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
    { label: 'authorization-header', pattern: /\bAuthorization\s*[:=]\s*["']?\S+/g },
    { label: 'bearer-credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g },
];

/** Key names that imply the value is credential material. */
const CREDENTIAL_KEY_PATTERN = /^(token|pat|password|secret|authorization|api[_-]?key|access[_-]?key|credential)$/i;

/**
 * Raised when a value that must be redacted contains secret-shaped material.
 *
 * The message names the subject and the matched pattern label on purpose; it
 * never echoes the matched text, so the failure itself cannot leak.
 */
export class RedactionError extends Error {
    /** Stable machine-readable marker so tests and callers can discriminate. */
    public override readonly name = 'RedactionError';

    /**
     * @param subject - Human-readable name of the value that failed the check.
     * @param patternLabel - Label of the pattern that matched, never its text.
     */
    public constructor(subject: string, patternLabel: string) {
        super(`Refusing to persist ${subject}: value matches ${patternLabel}`);
    }
}

/**
 * Look for secret-shaped material in a string.
 *
 * @param text - Candidate text, typically a serialized ledger or evidence record.
 * @returns The label of the first matching pattern, or `null` when clean.
 */
export function findSecretLeak(text: string): string | null {
    for (const { label, pattern } of SECRET_PATTERNS) {
        // `match` on a global pattern restarts from the beginning on every call,
        // so detection cannot miss a match because an earlier call advanced state.
        if (text.match(pattern) !== null) {
            return label;
        }
    }

    return null;
}

/**
 * Assert that a value contains no secret-shaped material.
 *
 * @param subject - Name used in the error message, e.g. `ledger`.
 * @param text - The exact text that will be persisted or reported.
 * @throws {RedactionError} When secret-shaped material is present.
 */
export function assertRedacted(subject: string, text: string): void {
    const label = findSecretLeak(text);
    if (label !== null) {
        throw new RedactionError(subject, label);
    }
}

/**
 * Replace secret-shaped material with a labelled placeholder.
 *
 * Used when a diagnostic string must still be recorded for the audit trail
 * without carrying the secret itself. Every occurrence of every pattern is
 * replaced, not just the first: a single diagnostic can quote more than one
 * token, and a half-redacted string is still a leak.
 *
 * @param text - Candidate text.
 * @returns The text with every secret-shaped match replaced by `[redacted:<label>]`.
 */
export function redact(text: string): string {
    let result = text;
    for (const { label, pattern } of SECRET_PATTERNS) {
        // `replaceAll` requires a global pattern, so an accidental non-global
        // pattern fails loudly here instead of silently replacing one match.
        // The replacer is a function so a label holding `$&` would insert
        // itself literally instead of re-reading the match it replaced.
        result = result.replaceAll(pattern, () => `[redacted:${label}]`);
    }

    return result;
}

/**
 * Drop object keys whose names suggest they hold credentials.
 *
 * Settings, request metadata, and provider payloads are untrusted input; a
 * key such as `token`, `pat`, or `authorization` is removed before its value
 * can reach the ledger.
 *
 * @param record - Shallow record about to be persisted.
 * @returns A copy with credential-named keys removed.
 */
export function stripCredentialKeys<V extends Scalar>(record: Readonly<Record<string, V>>): Record<string, V> {
    const result: Record<string, V> = {};
    for (const [key, value] of Object.entries(record)) {
        if (CREDENTIAL_KEY_PATTERN.test(key)) {
            continue;
        }

        result[key] = value;
    }

    return result;
}
