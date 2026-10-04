/**
 * Shared text rules for a binding's starting prompt (004 FR-022, FR-023,
 * FR-025, FR-026, FR-031).
 *
 * This module is deliberately browser-safe: it holds no `node:` import, so it
 * bundles into the panel as well as the service (plan N1). That matters
 * because the *composition* runs panel-side (`src/session.ts`) while the
 * *validation* runs service-side (`service/prompt.ts`), and the two must agree
 * byte for byte about what the fence is and what a reserved marker looks like.
 *
 * What lives here is only what both tiers need:
 *
 * - the fence pair the composition emits (004 FR-031) — emitted by the
 *   composition, never part of the operator's stored text;
 * - the reserved marker **prefixes** a stored prompt may not impersonate
 *   (004 FR-025) — stated as prefixes so a marker added later is covered
 *   without re-specifying the rule;
 * - outer-only trimming, line-ending normalisation, and code-point counting
 *   (004 FR-020, FR-022, FR-023);
 * - the two structural predicates the validator runs over that normalised
 *   text: a reserved marker line, and a control character;
 * - the closed tier vocabulary — `PromptSource`, its fixed stacking order,
 *   and the two predicates every `promptSources` reader shares (004 FR-072,
 *   FR-087), so the service that writes the list and the panel that reads it
 *   judge it against the same three strings.
 *
 * There is no content policy here or anywhere else in this feature (004
 * FR-029): these rules judge the *shape* of the text, never what it says.
 */

/** Opening fence of the operator prompt block; byte-equal to the specification's composition block. */
export const OPERATOR_PROMPT_FENCE_BEGIN = '--- BEGIN OPERATOR STARTING PROMPT ---';

/** Closing fence of the operator prompt block; byte-equal to the specification's composition block. */
export const OPERATOR_PROMPT_FENCE_END = '--- END OPERATOR STARTING PROMPT ---';

/**
 * Prefixes no stored prompt line may begin with.
 *
 * The trailing space is part of each prefix on purpose: `--- BEGINNING OF PLAN
 * ---` is ordinary operator text, while a line starting `--- BEGIN ` is an
 * attempt to speak in the composition's own voice. Prefixes rather than an
 * enumeration, so a future marker is covered without a spec change.
 */
export const RESERVED_MARKER_PREFIXES: readonly string[] = ['--- BEGIN ', '--- END '];

/** Line separator every composition and every rule in this module counts in. */
const NEWLINE = '\n';

/**
 * Wire and storage shape of a prompt fingerprint.
 *
 * Defined here rather than beside the hasher so the panel and the service read
 * the *same* rule: the service derives the value, the panel checks the shape
 * of the one it was handed, and neither can drift.
 */
export const PROMPT_FINGERPRINT_PATTERN = /^mtp-[0-9a-f]{32}$/;

/**
 * The closed tier vocabulary: which store a starting prompt came from (004
 * FR-072, FR-087).
 *
 * The three tiers stack most-general-first into the one composed block,
 * and every surface that carries a fingerprint carries this
 * vocabulary's ordered, duplicate-free list beside it. Declared
 * here — browser-safe, no `node:` import — so the service that *writes*
 * `promptSources` and the panel that *reads* it name the same three strings,
 * and neither side can drift into a fourth tier on its own.
 */
export type PromptSource = 'global' | 'account' | 'binding';

/**
 * The stacking order of {@link PromptSource}, most general first (004
 * FR-080), spelled as a tuple so its length and every element are pinned by
 * the type rather than by prose.
 *
 * `global` (the configuration field) stacks above `account` (the account
 * record's member), which stacks above `binding` (the binding's own). A
 * run's `promptSources` is always a duplicate-free subsequence of exactly
 * this order (FR-087) — {@link isPromptSourceList} is the check.
 */
export const PROMPT_SOURCE_ORDER = ['global', 'account', 'binding'] as const;

/**
 * Whether one value names a tier this build knows.
 *
 * Membership walks {@link PROMPT_SOURCE_ORDER} instead of spelling the
 * strings a second time, so the type, the order, and this predicate cannot
 * disagree: adding a tier would be an FR-070 scope change made in one tuple.
 *
 * @param value - Any value read from a wire document or a store record.
 * @returns `true` for exactly `'global'`, `'account'`, or `'binding'`.
 */
export function isPromptSource(value: unknown): value is PromptSource {
    if (typeof value !== 'string') {
        return false;
    }

    // Read as plain strings so an `unknown` value can be tested against the
    // tuple without a cast; the tuple itself keeps the literal element type.
    const order: readonly string[] = PROMPT_SOURCE_ORDER;

    return order.includes(value);
}

/**
 * Whether a list could stand as a run's `promptSources`: a duplicate-free
 * subsequence of {@link PROMPT_SOURCE_ORDER}.
 *
 * The two refusals FR-087 names collapse into one walk: every element must
 * be a known tier ({@link isPromptSource}), and each must sit strictly
 * **later** in the order than its predecessor — a repeated tier cannot be
 * later than itself, so a duplicate fails the very test an out-of-order list
 * fails. `['global','account','binding']` and `['binding']` are accepted;
 * `['binding','global']` (out of order), `['global','global']` (duplicated),
 * and `['repo']` (unknown) are all refused.
 *
 * An empty list *is* a subsequence of the order; the presence rule
 * (`promptPresent` ⇔ a non-empty list) belongs to the reader that knows
 * whether a prompt exists, so this predicate checks order and membership
 * only and never guesses at presence (FR-087, AGENTS.md invariant 8).
 *
 * @param value - Any value read from a wire document or a store record.
 * @returns `true` when the list is all-known, in order, and duplicate-free.
 */
export function isPromptSourceList(value: unknown): value is readonly PromptSource[] {
    if (!Array.isArray(value)) {
        return false;
    }

    let previous = -1;
    for (const element of value) {
        if (!isPromptSource(element)) {
            return false;
        }

        const index = PROMPT_SOURCE_ORDER.indexOf(element);
        if (index <= previous) {
            return false;
        }

        previous = index;
    }

    return true;
}

/** First code point excluded from prompt text: NUL through backspace. */
const LAST_FORBIDDEN_LOW_CODE_POINT = 0x08;

/** Tab, the first of the two control characters an instruction may contain. */
const TAB_CODE_POINT = 0x09;

/** Line feed, the second of the two control characters an instruction may contain. */
const LINE_FEED_CODE_POINT = 0x0a;

/** First code point of the forbidden middle range: vertical tab. */
const FORBIDDEN_MIDDLE_START = 0x0b;

/** Last code point of the forbidden middle range: unit separator. */
const FORBIDDEN_MIDDLE_END = 0x1f;

/** First code point of the forbidden upper range: delete. */
const FORBIDDEN_UPPER_START = 0x7f;

/** Last code point of the forbidden upper range: application program control. */
const FORBIDDEN_UPPER_END = 0x9f;

/**
 * Trim whitespace from the two ends of a prompt only.
 *
 * Internal whitespace is the instruction — the newlines an operator used to
 * separate a goal from a constraint must survive byte for byte — so this is
 * outer trimming and nothing else.
 *
 * @param text - Candidate prompt text.
 * @returns The text without leading or trailing whitespace.
 */
export function trimPrompt(text: string): string {
    return text.trim();
}

/**
 * Fold Windows and legacy-Mac line endings onto the product's canonical form.
 *
 *
 * `\r\n` is replaced as a pair so a CRLF paste never leaves a stray `\r`, and
 * a lone `\r` becomes `\n`. Normalisation runs **before** the control-character
 * test, so a carriage return is read as a line ending rather than refused.
 *
 * @param text - Candidate prompt text, already trimmed at the ends.
 * @returns The text with every line ending spelled `\n`.
 */
export function normaliseLineEndings(text: string): string {
    let folded = '';
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '\r') {
            folded += text[index] ?? '';
            continue;
        }

        folded += NEWLINE;
        if (text[index + 1] === '\n') {
            index += 1;
        }
    }

    return folded;
}

/**
 * Count Unicode **code points**, not UTF-16 units.
 *
 * Spreading a string iterates code points, so a surrogate pair (an emoji, a
 * rare ideograph) counts as one — the unit the specification's 2,000-character
 * cap is written in.
 *
 * @param text - Candidate text.
 * @returns How many code points the text holds.
 */
export function countCodePoints(text: string): number {
    return [...text].length;
}

/**
 * Whether any line of the text tries to speak in the composition's voice.
 *
 *
 * A "line" is delimited by the normalised `\n`, so this runs after
 * {@link normaliseLineEndings} — otherwise a CRLF file would hide the prefix
 * behind a trailing carriage return.
 *
 * @param text - Candidate prompt text, normalised.
 * @returns `true` when a line begins with a reserved marker prefix.
 */
export function hasReservedMarkerLine(text: string): boolean {
    const prefixes = RESERVED_MARKER_PREFIXES;

    return text.split(NEWLINE).some((line) => prefixes.some((prefix) => line.startsWith(prefix)));
}

/**
 * Whether one code point is a control character no instruction may contain:
 * anything but tab and line feed inside the C0/C1 control
 * ranges.
 *
 * Written as a comparison rather than a character-class regexp so the three
 * forbidden ranges are named constants a reader can check against the
 * specification's own `[\u0000-\u0008\u000B-\u001F\u007F-\u009F]`.
 *
 * @param codePoint - The code point under test.
 * @returns `true` for a forbidden control character.
 */
function isForbiddenControl(codePoint: number): boolean {
    if (codePoint <= LAST_FORBIDDEN_LOW_CODE_POINT) {
        return true;
    }

    if (codePoint === TAB_CODE_POINT || codePoint === LINE_FEED_CODE_POINT) {
        return false;
    }

    if (codePoint >= FORBIDDEN_MIDDLE_START && codePoint <= FORBIDDEN_MIDDLE_END) {
        return true;
    }

    return codePoint >= FORBIDDEN_UPPER_START && codePoint <= FORBIDDEN_UPPER_END;
}

/**
 * Whether the text holds a character no instruction may contain.
 *
 * Call this **after** {@link normaliseLineEndings}: a raw carriage return sits
 * inside the forbidden middle range, and normalisation is what makes it a line
 * ending instead.
 *
 * @param text - Candidate prompt text, normalised.
 * @returns `true` for a null character or any control character other than
 *   newline and tab.
 */
export function hasIllegalControlChar(text: string): boolean {
    for (const character of text) {
        if (isForbiddenControl(character.codePointAt(0) ?? 0)) {
            return true;
        }
    }

    return false;
}

/**
 * The prompt reference the machine-readable `data` carries.
 *
 * Three scalars, the ordered source list, and **never the text**: the
 * instruction travels once, in the message's `text`, so a second copy in
 * `data` would be exactly the duplicate 004 FR-037 forbids. The list names
 * which tiers produced the block — everywhere the fingerprint is —
 * and its presence is part of the reference's iff: a present reference holds
 * a non-empty {@link PromptSource} list, an absent one holds `null`.
 */
export interface PromptReference {
    /** Whether the run carried a starting prompt. */
    readonly promptPresent: boolean;
    /** Its `mtp-…` fingerprint, or `null` when none. */
    readonly promptFingerprint: string | null;
    /** Code points of the normalised text, or `null` when none. */
    readonly promptLength: number | null;
    /** Tiers that contributed, most general first, or `null` when none. */
    readonly promptSources: readonly PromptSource[] | null;
}

/**
 * How many characters a prompt block and its blank line will occupy.
 *
 * This is the number the bounded context reserves **before** it sizes the
 * excerpt budget, which is what makes FR-035's rule mechanical: the excerpt
 * shortens first and the prompt never shortens at all.
 *
 * @param prompt - The normalised prompt text, or `null` when unset.
 * @returns The reserved character count; `0` for an unset prompt.
 */
export function promptBlockChars(prompt: string | null): number {
    if (prompt === null || prompt === '') {
        return 0;
    }

    // begin fence, its newline, the text, its newline, the end fence, then
    // the blank line the composition puts between the block and the frame.
    return OPERATOR_PROMPT_FENCE_BEGIN.length + prompt.length + OPERATOR_PROMPT_FENCE_END.length + 4;
}

/**
 * Compose the session's first message: the operator's prompt block first,
 * then the automatic frame (004 FR-030, `## Dispatch Message Composition`).
 *
 * The fence is **emitted** here and never parsed out of anything (004 FR-031,
 * FR-033): the operator's text is concatenated byte for byte between the two
 * markers — no escaping, no reflow, no substitution — and when the prompt is
 * unset the frame comes back untouched: no fence, no blank line, no note about
 * the absence. This is the one function that produces the
 * message; nothing else renders it.
 *
 * @param input - The prompt, and the frame the bounded context built.
 * @returns The complete first message.
 */
export function composeFirstMessage(input: {
    /** The normalised prompt text, or `null` for a run with none. */
    readonly prompt: string | null;
    /** The automatic frame, already bounded. */
    readonly frame: string;
}): string {
    if (input.prompt === null || input.prompt === '') {
        return input.frame;
    }

    return `${OPERATOR_PROMPT_FENCE_BEGIN}${NEWLINE}${input.prompt}${NEWLINE}`
        + `${OPERATOR_PROMPT_FENCE_END}${NEWLINE}${NEWLINE}${input.frame}`;
}
