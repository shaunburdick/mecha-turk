/**
 * The starting-prompt domain: validation, fingerprint, and snapshot (004
 * FR-010, FR-016, FR-020–FR-028; data-model §2).
 *
 * One function — {@link validateStartingPrompt} — is the save boundary *and*
 * the read boundary for a binding's prompt (plan D2), so a hand-edited
 * `bindings.json` and a panel `PUT` can never disagree about what is usable.
 * Its step order is normative because two edge cases depend on it: line
 * endings normalise **before** the control-character test (so a CRLF paste is
 * a line ending, not a refusal) and empty-after-trim resolves to *unset*
 * **before** the cap (so an empty instruction is never a refusal — it is a
 * clear).
 *
 * The refusal set is closed at four content rules — length, well-formedness,
 * reserved marker, credential shape — plus the type check that decides whether
 * the value is text at all. There is no content policy (004 FR-029): nothing
 * here reads what the operator *says*.
 *
 * Every refusal names the field and a remediation and **never quotes the
 * submitted value** (004 FR-003, AC-132/AC-133). That is what lets the
 * credential refusal be a refusal rather than a warning: the value never
 * reaches a log line, an audit row, or an error body, so it never becomes a
 * durable credential at rest (004 FR-024).
 *
 * The fingerprint is service-side on purpose — `node:crypto` cannot reach the
 * panel bundle — which is exactly what 004 FR-016 requires: computed by the
 * service, from the text alone.
 */

import { createHash } from 'node:crypto';
import {
    countCodePoints,
    hasIllegalControlChar,
    hasReservedMarkerLine,
    normaliseLineEndings,
    trimPrompt,
} from '../src/prompt.ts';
import { findSecretLeak } from '../src/redaction.ts';

/**
 * The stored prompt's cap, in Unicode code points after trimming (004 FR-020).
 *
 * A module constant rather than a `ServiceConfig` field (plan D6): 006 owns the
 * settings surface and 004 adds no setting an operator could tune, so an inert
 * config member would be exactly the dead field both features reject. 004
 * FR-021 keeps the value tunable in *planning* within 500–3,000 without a spec
 * change; only the default is fixed here.
 */
export const STARTING_PROMPT_MAX_CODE_POINTS = 2_000;

/** Wire and storage shape of a prompt fingerprint (004 FR-016; data-model §2.2). */
export const PROMPT_FINGERPRINT_PATTERN = /^mtp-[0-9a-f]{32}$/;

/** Prefix every fingerprint carries, so it reads as an identity in a log line. */
export const PROMPT_FINGERPRINT_PREFIX = 'mtp-';

/** Hex characters taken from the SHA-256 digest (32 hex = 128 bits). */
const FINGERPRINT_HEX_CHARS = 32;

/**
 * The remediation for a value that is present but is not text (004 FR-017).
 *
 * Naming the two clearing spellings is deliberate: the operator is told how to
 * express "unset" rather than being left to guess what the field wants.
 */
const REMEDIATION_TYPE =
    'startingPrompt must be text; send it absent or null to leave the starting prompt unset';

/** The remediation for a value over the cap (004 FR-020); never quotes the text. */
const REMEDIATION_CAP = `startingPrompt must be at most ${STARTING_PROMPT_MAX_CODE_POINTS}`
    + ' characters (Unicode code points) after trimming';

/** The remediation for a control character (004 FR-026). */
const REMEDIATION_CONTROL =
    'startingPrompt must not contain null or control characters other than newline and tab';

/** The remediation for a reserved marker line (004 FR-025); names the family, never the line. */
const REMEDIATION_MARKER = 'startingPrompt must not contain a line beginning with'
    + ' "--- BEGIN " or "--- END " (reserved composition markers)';

/**
 * The remediation for credential-shaped material (004 FR-024).
 *
 * @param label - The shipped detector's stable label, never the matched text.
 * @returns The remediation naming the shape and not the value.
 */
export function credentialRemediation(label: string): string {
    return `startingPrompt must not contain credential-shaped material (matched shape: ${label})`;
}

/** One refused prompt, in the `field` + remediation voice every refusal shares. */
export interface PromptIssue {
    /** Always the prompt field, so a client can render the refusal in place. */
    readonly field: 'startingPrompt';
    /** How to fix it; never echoes any part of the submitted value. */
    readonly remediation: string;
}

/** Result of validating one candidate prompt (data-model §2.1). */
export type PromptValidation =
    /** Usable text (already trimmed and normalised), or `null` for unset. */
    | { readonly ok: true; readonly prompt: string | null }
    /** A refusal; nothing is written and nothing is echoed. */
    | { readonly ok: false; readonly issue: PromptIssue };

/**
 * Refuse a candidate prompt with a field-level remediation.
 *
 * @param remediation - The fixed remediation for this refusal class.
 * @returns The refusal verdict.
 */
function refuse(remediation: string): PromptValidation {
    return { ok: false, issue: { field: 'startingPrompt', remediation } };
}

/**
 * Validate a stored or submitted starting prompt (data-model §2.1).
 *
 * The order is normative and is the order the specification fixes:
 *
 * 1. **Type** — absent or explicit `null` is unset; text continues; anything
 *    else is refused, never coerced, cast, or dropped (004 FR-017, FR-028).
 * 2. **Trim** the two ends only (004 FR-022).
 * 3. **Empty after trim** resolves to unset — "an empty instruction" is not a
 *    state the product has (004 FR-022).
 * 4. **Normalise** line endings (004 FR-023), *before* the control-character
 *    test so a CRLF paste is a line ending and not a refusal (plan D3).
 * 5. **Cap** at {@link STARTING_PROMPT_MAX_CODE_POINTS} code points (004 FR-020).
 * 6. **Well-formedness** — no control character but tab and newline (004 FR-026).
 * 7. **Reserved markers** — no line beginning with a reserved prefix (004 FR-025).
 * 8. **Credential shape** — the shipped detector's own labels (004 FR-024).
 *
 * @param raw - The candidate value as it arrived, or `undefined` when absent.
 * @returns The normalised text, `null` for unset, or the one refusal.
 */
export function validateStartingPrompt(raw: unknown): PromptValidation {
    if (raw === undefined || raw === null) {
        return { ok: true, prompt: null };
    }

    if (typeof raw !== 'string') {
        return refuse(REMEDIATION_TYPE);
    }

    const trimmed = trimPrompt(raw);
    if (trimmed === '') {
        return { ok: true, prompt: null };
    }

    const text = normaliseLineEndings(trimmed);
    if (countCodePoints(text) > STARTING_PROMPT_MAX_CODE_POINTS) {
        return refuse(REMEDIATION_CAP);
    }

    if (hasIllegalControlChar(text)) {
        return refuse(REMEDIATION_CONTROL);
    }

    if (hasReservedMarkerLine(text)) {
        return refuse(REMEDIATION_MARKER);
    }

    const label = findSecretLeak(text);
    if (label !== null) {
        return refuse(credentialRemediation(label));
    }

    return { ok: true, prompt: text };
}

/**
 * Derive a prompt's fingerprint from its normalised text alone (004 FR-016).
 *
 * `mtp-` + the first 32 hex characters of `sha256(utf8(text))`: fixed length,
 * `[0-9a-f]` only, URL-safe, and a pure function of the bytes — no salt, no
 * configuration, no clock, no binding id — so the same text fingerprints
 * identically across restarts, builds, and machines (004 NFR-126, AC-140).
 * Because a credential-shaped prompt is refused before it is ever stored, a
 * fingerprint can never be a hash of a secret (004 FR-024's closing clause).
 *
 * @param text - The normalised, trimmed prompt text.
 * @returns `mtp-<sha256 hex[0:32]>`.
 */
export function promptFingerprint(text: string): string {
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');

    return `${PROMPT_FINGERPRINT_PREFIX}${digest.slice(0, FINGERPRINT_HEX_CHARS)}`;
}

/**
 * The prompt as a queued record snapshots it (004 `### Key Entities`;
 * data-model §2.3).
 */
export interface PromptSnapshot {
    /** Normalised, trimmed, at most the cap, never empty. */
    readonly text: string;
    /** `mtp-<sha256 hex[0:32]>`, derived from `text`. */
    readonly fingerprint: string;
    /** `[...text].length` in Unicode code points. */
    readonly length: number;
}

/**
 * Build a snapshot for a record that may carry a prompt.
 *
 * Structural on purpose — it names only the member it reads, so
 * `service/prompt.ts` never imports `service/bindings.ts` and the two cannot
 * form a cycle.
 *
 * @param record - A binding-shaped record, or anything else.
 * @returns The snapshot, or `null` when the prompt is unset **or** unusable.
 *
 * The unusable case cannot reach here in practice — the read path quarantines
 * a file whose prompt fails validation before the poll loop ever sees a
 * binding — so `null` is the fail-safe answer of last resort rather than a
 * coercion: nothing is stored, nothing is dispatched, and no fingerprint is
 * derived from text the validator refused.
 */
export function promptSnapshotOf(record: {
    /** The stored prompt, when the record carries one. */
    readonly startingPrompt?: string;
}): PromptSnapshot | null {
    const verdict = validateStartingPrompt(record.startingPrompt);
    if (!verdict.ok || verdict.prompt === null) {
        return null;
    }

    const text = verdict.prompt;

    return { text, fingerprint: promptFingerprint(text), length: countCodePoints(text) };
}

/** What a stored `prompt` member holds, once it has been read (data-model §3). */
export type StoredPromptSnapshot =
    /** The member is absent or `null`: a run queued with no prompt. */
    | { readonly status: 'unset' }
    /** A snapshot the shape checks accepted. */
    | { readonly status: 'set'; readonly snapshot: PromptSnapshot };

/** Read the stored text member, refusing anything that is not non-empty text. */
function storedText(candidate: Record<string, unknown>): string | null {
    const { text } = candidate;

    return typeof text === 'string' && text !== '' ? text : null;
}

/** Read the stored fingerprint member, refusing anything outside the fixed format. */
function storedFingerprint(candidate: Record<string, unknown>): string | null {
    const { fingerprint } = candidate;

    return typeof fingerprint === 'string' && PROMPT_FINGERPRINT_PATTERN.test(fingerprint)
        ? fingerprint
        : null;
}

/** Read the stored length member, refusing anything that is not a positive integer. */
function storedLength(candidate: Record<string, unknown>): number | null {
    const { length } = candidate;

    return typeof length === 'number' && Number.isInteger(length) && length > 0 ? length : null;
}

/**
 * Validate the three stored members against each other and against the secret
 * rule the save boundary applied.
 *
 * @param candidate - The stored `prompt` member, already known to be a record.
 * @returns The snapshot, or `null` when any member is unusable.
 */
function readStoredSnapshot(candidate: Record<string, unknown>): PromptSnapshot | null {
    const text = storedText(candidate);
    const fingerprint = storedFingerprint(candidate);
    const length = storedLength(candidate);
    if (text === null || fingerprint === null || length === null) {
        return null;
    }

    if (countCodePoints(text) !== length || findSecretLeak(text) !== null) {
        return null;
    }

    return { text, fingerprint, length };
}

/**
 * Read a prompt snapshot back out of a stored document (data-model §3).
 *
 * Shape only — the fingerprint is checked against its format rather than
 * recomputed (plan D11), because recompute-on-read would turn any future
 * algorithm change into a quarantine of every stored run. The stored text
 * still answers the secret rule the save boundary applied, so a hand-edited
 * run row cannot smuggle a credential onto the claim answer (004 FR-019 by
 * analogy, NFR-121).
 *
 * @param raw - The stored value, or `undefined` when the member is absent.
 * @returns The reading, or `null` when a **present** value is unusable —
 *   which the caller turns into a document refusal rather than a half-read run.
 */
export function parseStoredPromptSnapshot(raw: unknown): StoredPromptSnapshot | null {
    if (raw === undefined || raw === null) {
        return { status: 'unset' };
    }

    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const snapshot = readStoredSnapshot(raw as Record<string, unknown>);

    return snapshot === null ? null : { status: 'set', snapshot };
}
