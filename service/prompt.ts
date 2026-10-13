/**
 * The starting-prompt domain: validation, fingerprint, snapshot, and the
 * three-tier resolution that feeds one.
 */

import { createHash } from 'node:crypto';
import {
    PROMPT_FINGERPRINT_PATTERN,
    PROMPT_SOURCE_ORDER,
    countCodePoints,
    hasIllegalControlChar,
    hasReservedMarkerLine,
    isPromptSourceList,
    normaliseLineEndings,
    trimPrompt,
} from '../src/prompt.ts';
import type { PromptSource } from '../src/prompt.ts';
import { findSecretLeak } from '../src/redaction.ts';

/** Re-exported so the service stays the one import path for prompt rules. */
export { PROMPT_FINGERPRINT_PATTERN };

/**
 * The tier vocabulary re-exported (data-model §6): one declaration in the
 * browser-safe module, one import path for every service writer.
 */
export type { PromptSource };

/**
 * The stored prompt's cap, in Unicode code points after trimming.
 *
 * A module constant rather than a `ServiceConfig` field: the settings surface
 * owns its own fields, and this one adds no setting an operator could tune, so
 * an inert config member would be exactly the dead field both features reject.
 * The value stays tunable in *planning* within 500–3,000 without a spec change;
 * only the default is fixed here.
 */
export const STARTING_PROMPT_MAX_CODE_POINTS = 2_000;


/** Prefix every fingerprint carries, so it reads as an identity in a log line. */
export const PROMPT_FINGERPRINT_PREFIX = 'mtp-';

/** Hex characters taken from the SHA-256 digest (32 hex = 128 bits). */
const FINGERPRINT_HEX_CHARS = 32;

/**
 * The remediation for a value that is present but is not text.
 *
 * Naming the two clearing spellings is deliberate: the operator is told how to
 * express "unset" rather than being left to guess what the field wants.
 */
const REMEDIATION_TYPE =
    'startingPrompt must be text; send it absent or null to leave the starting prompt unset';

/** The remediation for a value over the cap; never quotes the text. */
const REMEDIATION_CAP = `startingPrompt must be at most ${STARTING_PROMPT_MAX_CODE_POINTS}`
    + ' characters (Unicode code points) after trimming';

const REMEDIATION_CONTROL =
    'startingPrompt must not contain null or control characters other than newline and tab';

/** The remediation for a reserved marker line; names the family, never the line. */
const REMEDIATION_MARKER = 'startingPrompt must not contain a line beginning with'
    + ' "--- BEGIN " or "--- END " (reserved composition markers)';

/**
 * @param label - The shipped detector's stable label, never the matched text.
 */
export function credentialRemediation(label: string): string {
    return `startingPrompt must not contain credential-shaped material (matched shape: ${label})`;
}

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
 */
function refuse(remediation: string): PromptValidation {
    return { ok: false, issue: { field: 'startingPrompt', remediation } };
}

/**
 * Validate a stored or submitted starting prompt. The order is normative and
 * is the order the specification fixes: type (absent or `null` is unset,
 * never coerced), trim the two ends, empty-after-trim resolves to unset,
 * normalise line endings **before** the control-character test so a CRLF
 * paste is a line ending and not a refusal, cap at
 * {@link STARTING_PROMPT_MAX_CODE_POINTS}, then well-formedness, reserved
 * markers, and credential shape.
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
 * Derive a prompt's fingerprint from its normalised text alone: `mtp-` plus
 * the first 32 hex characters of `sha256(utf8(text))` — fixed length,
 * `[0-9a-f]` only, URL-safe, and a pure function of the bytes (no salt, no
 * configuration, no clock, no binding id), so the same text fingerprints
 * identically across restarts, builds and machines. Because a
 * credential-shaped prompt is refused before it is ever stored, a
 * fingerprint can never be a hash of a secret.
 */
export function promptFingerprint(text: string): string {
    const digest = createHash('sha256').update(text, 'utf8').digest('hex');

    return `${PROMPT_FINGERPRINT_PREFIX}${digest.slice(0, FINGERPRINT_HEX_CHARS)}`;
}

/**
 * One tier's validated text — what a per-tier change row records.
 *
 * The change rows' fingerprint is **this tier's own** hash of its own text,
 * never the composed body's: per-tier change is recorded where the change
 * happened, and only a run's snapshot stacks. A binding-only tier and a
 * binding-only body happen to hash the same bytes, which is exactly the
 * golden-identity property this shape pins.
 */
export interface TierPrompt {
    /** Normalised, trimmed, at most the cap, never empty. */
    readonly text: string;
    /** `mtp-<sha256 hex[0:32]>`, derived from this tier's `text`. */
    readonly fingerprint: string;
    /** `[...text].length` in Unicode code points. */
    readonly length: number;
}

/** The prompt as a queued record snapshots it: the **composed block body**. */
export interface PromptSnapshot {
    /** Set tiers joined by exactly one blank line, global → account → binding. */
    readonly text: string;
    /** `mtp-<sha256 hex[0:32]>`, derived from `text` — one hash over the body. */
    readonly fingerprint: string;
    /** `[...text].length` in Unicode code points — the body the fence wraps. */
    readonly length: number;
    /** Contributing tiers: ordered, duplicate-free, never empty. */
    readonly sources: readonly PromptSource[];
}

/**
 * Build one **tier's** triple for a record that may carry a prompt — the
 * shape per-tier change rows record, so no caller can mistake a tier for a
 * run's stacked snapshot (which comes from {@link resolvePromptSnapshot}).
 * Structural on purpose: it names only the member it reads, so this module
 * never imports `bindings.ts` and no cycle can form. `null` is the fail-safe
 * answer for unusable text as well as unset, so nothing is stored, nothing is
 * dispatched, and no fingerprint is derived from text the validator refused.
 */
export function promptTierOf(record: {
    /** The stored prompt, when the record carries one; `null` reads as unset. */
    readonly startingPrompt?: string | null;
}): TierPrompt | null {
    const verdict = validateStartingPrompt(record.startingPrompt);
    if (!verdict.ok || verdict.prompt === null) {
        return null;
    }

    const text = verdict.prompt;

    return { text, fingerprint: promptFingerprint(text), length: countCodePoints(text) };
}

/** The one blank line that goes between consecutive set tiers (2 code points). */
const TIER_GAP = '\n\n';

/**
 * Stack the set tiers into one block body: exactly one blank line between
 * **consecutive set** tiers in the fixed order global → account → binding,
 * and a tier that is `null` contributes nothing — no empty line, no
 * placeholder, no note. The body is **built, never parsed**: tier boundaries
 * come from these three named members and never from searching the text, so a
 * tier's own internal blank lines are ordinary operator text. Inputs must
 * already be validated and normalised — that is
 * {@link resolvePromptSnapshot}'s job; this function only stacks.
 */
export function composePromptBody(tiers: {
    /** The global tier's text (`config.json`), or `null` when unset. */
    readonly global: string | null;
    /** The account tier's text (the account record), or `null` when unset. */
    readonly account: string | null;
    /** The binding tier's text (the binding record), or `null` when unset. */
    readonly binding: string | null;
}): string {
    const set: string[] = [];
    for (const tier of [tiers.global, tiers.account, tiers.binding]) {
        if (tier !== null && tier !== '') {
            set.push(tier);
        }
    }

    return set.join(TIER_GAP);
}

type ResolvedTier =
    /** Absent or empty: contributes nothing to the composition. */
    | { readonly state: 'unset' }
    /** Validated, normalised text ready to stack. */
    | { readonly state: 'set'; readonly text: string }
    /** A set tier the validator refused: no snapshot composes at all. */
    | { readonly state: 'refused' };

/**
 * The member is read **structurally**: all three stores hold the tier under the
 * same `startingPrompt` name, so the resolver imports neither `ServiceConfig`,
 * `Account`, nor `BindingRecord`, and every tier passes the single
 * `validateStartingPrompt`. An explicit `null`/`undefined` record, or a record
 * without the member, is *unset* — a complete state that contributes nothing;
 * anything that is not a record at all is a refusal, never a default
 * (AGENTS.md invariant 8).
 */
function resolveTier(record: unknown): ResolvedTier {
    if (record === undefined || record === null) {
        return { state: 'unset' };
    }

    if (typeof record !== 'object' || Array.isArray(record)) {
        return { state: 'refused' };
    }

    const verdict = validateStartingPrompt((record as Record<string, unknown>).startingPrompt);
    if (!verdict.ok) {
        return { state: 'refused' };
    }

    return verdict.prompt === null ? { state: 'unset' } : { state: 'set', text: verdict.prompt };
}

/**
 * Resolve the three tiers into the one snapshot a queued record stores,
 * called at detection with the same records that produced the run's
 * `projectId`/`worktreeOption` so the two are one moment rather than a
 * timing assumption (004 FR-015). Each tier validates on its own and is
 * never coerced or substituted; `sources` follows the set tiers by
 * construction. `null` when no tier is set **or** a passed tier is unusable:
 * nothing composed from text the validator refused.
 */
export function resolvePromptSnapshot(tiers: {
    /** This cycle's effective configuration (the global tier's record). */
    readonly global: unknown;
    /** The account record this binding names (the account tier's record). */
    readonly account: unknown;
    /** The binding record being scanned (the binding tier's record). */
    readonly binding: unknown;
}): PromptSnapshot | null {
    const resolved: Record<PromptSource, ResolvedTier> = {
        global: resolveTier(tiers.global),
        account: resolveTier(tiers.account),
        binding: resolveTier(tiers.binding),
    };

    if (PROMPT_SOURCE_ORDER.some((source) => resolved[source].state === 'refused')) {
        return null;
    }

    const text = composePromptBody({
        global: resolved.global.state === 'set' ? resolved.global.text : null,
        account: resolved.account.state === 'set' ? resolved.account.text : null,
        binding: resolved.binding.state === 'set' ? resolved.binding.text : null,
    });
    if (text === '') {
        return null;
    }

    const sources = PROMPT_SOURCE_ORDER.filter((source) => resolved[source].state === 'set');

    return { text, fingerprint: promptFingerprint(text), length: countCodePoints(text), sources };
}

/**
 * `n × cap + 2 × (n − 1)`: every set tier is capped at
 * {@link STARTING_PROMPT_MAX_CODE_POINTS} code points on its own, and the body
 * joins consecutive set tiers with exactly one 2-code-point blank line per gap —
 * gaps counted only between tiers present, so three tiers give
 * `3 × 2,000 + 2 × 2 = 6,004`. The run reader cross-checks a stored body's
 * `length` against this figure and the row's own `sources` count, which is
 * how a hand-edited row is held to the bound **without ever re-splitting the
 * body** (structure is built, never parsed).
 */
export function promptStackMaxCodePoints(sourceCount: number): number {
    return sourceCount * STARTING_PROMPT_MAX_CODE_POINTS + 2 * (sourceCount - 1);
}

/** What a stored `prompt` member holds, once it has been read (data-model §3). */
export type StoredPromptSnapshot =
    /** The member is absent or `null`: a run queued with no prompt. */
    | { readonly status: 'unset' }
    /** A snapshot the shape checks accepted. */
    | { readonly status: 'set'; readonly snapshot: PromptSnapshot };

function storedText(candidate: Record<string, unknown>): string | null {
    const { text } = candidate;

    return typeof text === 'string' && text !== '' ? text : null;
}

function storedFingerprint(candidate: Record<string, unknown>): string | null {
    const { fingerprint } = candidate;

    return typeof fingerprint === 'string' && PROMPT_FINGERPRINT_PATTERN.test(fingerprint)
        ? fingerprint
        : null;
}

function storedLength(candidate: Record<string, unknown>): number | null {
    const { length } = candidate;

    return typeof length === 'number' && Number.isSafeInteger(length) && length > 0 ? length : null;
}

/**
 *
 * Absent, `null`, empty, non-array, out-of-order, duplicated, or unknown all
 * **refuse** — there is no defaulting branch, because the feature has never
 * been released: no legitimate record can lack the member, and one that arrived
 * anyway is refused rather than completed on its behalf (AGENTS.md invariant 8).
 */
function storedSources(candidate: Record<string, unknown>): readonly PromptSource[] | null {
    const { sources } = candidate;

    if (!Array.isArray(sources) || sources.length === 0 || !isPromptSourceList(sources)) {
        return null;
    }

    return sources;
}

/**
 * Validate the stored members against each other and against the secret
 * rule the save boundary applied.
 */
function readStoredSnapshot(candidate: Record<string, unknown>): PromptSnapshot | null {
    const text = storedText(candidate);
    const fingerprint = storedFingerprint(candidate);
    const length = storedLength(candidate);
    const sources = storedSources(candidate);
    if (
        text === null ||
        fingerprint === null ||
        length === null ||
        sources === null ||
        countCodePoints(text) !== length
    ) {
        return null;
    }

    // The stack bound rather than the per-tier cap: a legitimate three-tier body
    // reaches 6,004 code points, so the ceiling a row may claim is the one its
    // own `sources` count describes — while a single-tier row still answers
    // 2,000, exactly what the shipped reader enforced, and a row claiming more
    // tiers than any body could stack is refused with it.
    if (length > promptStackMaxCodePoints(sources.length)) {
        return null;
    }

    // The cap and the secret rule the save boundary applied: a hand-edited
    // run row must not smuggle an oversized or credential-shaped instruction
    // onto the claim answer.
    if (findSecretLeak(text) !== null) {
        return null;
    }

    return { text, fingerprint, length, sources };
}

/**
 * Read a prompt snapshot back out of a stored document. Shape only — the
 * fingerprint is checked against its format rather than recomputed, because
 * recompute-on-read would turn any future algorithm change into a quarantine
 * of every stored run. The stored text still answers the secret rule the save
 * boundary applied, so a hand-edited run row cannot smuggle a credential onto
 * the claim answer, and `sources` must be present, non-empty, ordered and
 * duplicate-free: a present `prompt` without `sources` refuses the document,
 * never defaults one (invariant 8).
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
