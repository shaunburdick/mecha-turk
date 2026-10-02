/**
 * Reading the prompt's reference members off the wire (004 FR-015, FR-037,
 * FR-052; contracts `dispatch-prompt.md` §1 and §2).
 *
 * Two readers, one rule set. Both parse the **same three scalars** — presence,
 * fingerprint, length — because that is what keeps one parser rule and one
 * renderer rule serving every surface:
 *
 * - **A present reference is internally consistent**: fingerprint in the fixed
 *   `mtp-…` format and a positive integer length; `null` on both iff the run
 *   queued with no prompt.
 * - **The claim answer adds a fourth member**, and it obeys the contract's
 *   iff: `promptText` is non-null **if and only if** `promptPresent` is
 *   `true`. A run that carries text without claiming it, or claims it without
 *   carrying it, refuses the entry — and one refused entry refuses the whole
 *   answer, which is the claim reader's standing fail-closed posture.
 *
 * The readers validate *shape*, never content: the service refused a
 * credential-shaped prompt at the save boundary, and re-running the detector
 * here would invent the second validation boundary plan D10 rejects. An unset
 * run answers all four explicitly (`false`, `null`, `null`, `null`) because
 * the co-ship build parses them — an explicit `null` is a truer answer than
 * an absent key for a boolean the panel has to act on.
 */

import { PROMPT_FINGERPRINT_PATTERN, countCodePoints } from './prompt.ts';
import type { PromptReference } from './prompt.ts';

/** The prompt members of a claim entry, after validation. */
export interface ClaimPrompt extends PromptReference {
    /** The text the composition fences, or `null` when none (claim transport only). */
    readonly promptText: string | null;
}

/**
 * Read a reference from an entry that queued with **no** prompt.
 *
 * @param record - The parsed entry.
 * @returns The explicit unset triple, or `null` when a member disagrees.
 */
function absentReference(record: Record<string, unknown>): PromptReference | null {
    const clean = record.promptFingerprint === null && record.promptLength === null;

    return clean ? { promptPresent: false, promptFingerprint: null, promptLength: null } : null;
}

/**
 * Read a reference from an entry that carries a prompt.
 *
 * @param record - The parsed entry.
 * @returns The reference, or `null` when any member is unusable.
 */
function presentReference(record: Record<string, unknown>): PromptReference | null {
    const { promptFingerprint, promptLength } = record;
    if (typeof promptFingerprint !== 'string' || !PROMPT_FINGERPRINT_PATTERN.test(promptFingerprint)) {
        return null;
    }

    if (typeof promptLength !== 'number' || !Number.isInteger(promptLength) || promptLength < 1) {
        return null;
    }

    return { promptPresent: true, promptFingerprint, promptLength };
}

/**
 * Read the three reference scalars off a claim entry or a run-history row.
 *
 * @param record - The parsed entry.
 * @returns The reference, or `null` when the answer is not one this build may
 *   half-apply (004 FR-028; AGENTS invariant 8).
 */
export function readPromptReference(record: Record<string, unknown>): PromptReference | null {
    if (typeof record.promptPresent !== 'boolean') {
        return null;
    }

    return record.promptPresent ? presentReference(record) : absentReference(record);
}

/**
 * Read the claim answer's four prompt members, including the transport-only
 * text (contracts `dispatch-prompt.md` §1).
 *
 * @param record - The parsed claim entry.
 * @returns The four members, or `null` when their combination is unusable.
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
    if (typeof promptText !== 'string' || promptText === '') {
        return null;
    }

    if (countCodePoints(promptText) !== reference.promptLength) {
        return null;
    }

    return { ...reference, promptText };
}
