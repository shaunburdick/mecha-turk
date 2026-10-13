/**
 * Reading the prompt's reference members off the wire: two readers, one rule set, shape never content (D10).
 */

import {
    PROMPT_FINGERPRINT_PATTERN,
    countCodePoints,
    isPromptSourceList,
} from './prompt.ts';
import type { PromptReference } from './prompt.ts';

export interface ClaimPrompt extends PromptReference {
    readonly promptText: string | null;
}

/**
 * Read a reference from an entry that queued with **no** prompt.
 *
 * The unset answer is explicit on every member: fingerprint and length `null`,
 * and `promptSources` **`null`** (FR-087's iff) — so a missing member, or a
 * source list riding an absent reference, refuses the entry rather than
 * defaulting to one (AGENTS invariant 8).
 *
 * @returns The explicit unset quartet, or `null` when a member disagrees.
 */
function absentReference(record: Record<string, unknown>): PromptReference | null {
    const isClean = record.promptFingerprint === null
        && record.promptLength === null
        && record.promptSources === null;

    return isClean
        ? { promptPresent: false, promptFingerprint: null, promptLength: null, promptSources: null }
        : null;
}

/**
 * Read a reference from an entry that carries a prompt.
 *
 * `promptSources` must be present **and** be a non-empty, duplicate-free
 * subsequence of `global, account, binding` ({@link isPromptSourceList}): a
 * missing list, an explicit `null`, an empty list, an unknown tier, and an
 * out-of-order or duplicated list each refuse the entry.
 *
 * @returns The reference, or `null` when any member is unusable.
 */
function presentReference(record: Record<string, unknown>): PromptReference | null {
    const { promptFingerprint, promptLength, promptSources } = record;
    if (
        typeof promptFingerprint !== 'string' ||
        typeof promptLength !== 'number' ||
        !Number.isSafeInteger(promptLength) ||
        promptLength < 1 ||
        !isPromptSourceList(promptSources) ||
        promptSources.length === 0 ||
        !PROMPT_FINGERPRINT_PATTERN.test(promptFingerprint)
    ) {
        return null;
    }

    return { promptPresent: true, promptFingerprint, promptLength, promptSources };
}

/**
 * Read the four reference members off a claim entry or a run-history row.
 *
 * @returns The reference, or `null` when the answer is not one this build may
 *   half-apply (004 FR-028, FR-087; AGENTS invariant 8).
 */
export function readPromptReference(record: Record<string, unknown>): PromptReference | null {
    if (typeof record.promptPresent !== 'boolean') {
        return null;
    }

    return record.promptPresent ? presentReference(record) : absentReference(record);
}

/**
 * Read the claim answer's five prompt members, including the transport-only
 * text (contracts `dispatch-prompt.md` §1).
 *
 * @returns The five members, or `null` when their combination is unusable.
 */
export function readClaimPrompt(record: Record<string, unknown>): ClaimPrompt | null {
    const reference = readPromptReference(record);
    if (reference === null) {
        return null;
    }

    if (!reference.promptPresent) {
        // The iff: no text may ride an entry that did not claim one.
        return record.promptText === null ? { ...reference, promptText: null } : null;
    }

    const { promptText } = record;
    if (typeof promptText !== 'string' || promptText === '' || countCodePoints(promptText) !== reference.promptLength) {
        return null;
    }

    return { ...reference, promptText };
}
