/**
 * Reading the prompt's reference members off the wire (004 FR-015, FR-037,
 * FR-052, FR-087; contracts `dispatch-prompt.md` §1 and §2, `layered-prompt.md` §3).
 *
 * Two readers, one rule set. Both parse the **same four members** — presence,
 * fingerprint, length, sources — because that is what keeps one parser rule
 * and one renderer rule serving every surface:
 *
 * - **A present reference is internally consistent**: fingerprint in the fixed
 *   `mtp-…` format, a positive integer length, and a **non-empty**
 *   `promptSources` list that is a duplicate-free subsequence of
 *   `global, account, binding`; `null` on every member iff the run queued with
 *   no prompt — an unset reference must say so explicitly, so a missing member
 *   is refused rather than defaulted (FR-087, AGENTS.md invariant 8).
 * - **The claim answer adds a fifth member**, and it obeys the contract's
 *   iff: `promptText` is non-null **if and only if** `promptPresent` is
 *   `true`. A run that carries text without claiming it, or claims it without
 *   carrying it, refuses the entry — and one refused entry refuses the whole
 *   answer, which is the claim reader's standing fail-closed posture.
 *
 * The readers validate *shape*, never content: the service refused a
 * credential-shaped prompt at the save boundary, and re-running the detector
 * here would invent the second validation boundary plan D10 rejects. An unset
 * run answers all five explicitly (`false`, `null`, `null`, `null`, `null`)
 * because the co-ship build parses them — an explicit `null` is a truer answer
 * than an absent key for members the panel has to act on.
 */

import {
    PROMPT_FINGERPRINT_PATTERN,
    countCodePoints,
    isPromptSourceList,
} from './prompt.ts';
import type { PromptReference } from './prompt.ts';

/** The prompt members of a claim entry, after validation. */
export interface ClaimPrompt extends PromptReference {
    /** The text the composition fences, or `null` when none (claim transport only). */
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
 * @param record - The parsed claim entry.
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
