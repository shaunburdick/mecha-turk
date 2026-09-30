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
 *   text: a reserved marker line, and a control character.
 *
 * There is no content policy here or anywhere else in this feature (004
 * FR-029): these rules judge the *shape* of the text, never what it says.
 */

/** Opening fence of the operator prompt block; byte-equal to the specification's composition block. */
export const OPERATOR_PROMPT_FENCE_BEGIN = '--- BEGIN OPERATOR STARTING PROMPT ---';

/** Closing fence of the operator prompt block; byte-equal to the specification's composition block. */
export const OPERATOR_PROMPT_FENCE_END = '--- END OPERATOR STARTING PROMPT ---';

/**
 * Prefixes no stored prompt line may begin with (004 FR-025).
 *
 * The trailing space is part of each prefix on purpose: `--- BEGINNING OF PLAN
 * ---` is ordinary operator text, while a line starting `--- BEGIN ` is an
 * attempt to speak in the composition's own voice. Prefixes rather than an
 * enumeration, so a future marker is covered without a spec change.
 */
export const RESERVED_MARKER_PREFIXES: readonly string[] = ['--- BEGIN ', '--- END '];

/** Line separator every composition and every rule in this module counts in. */
const NEWLINE = '\n';

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
 * Trim whitespace from the two ends of a prompt only (004 FR-022).
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
 * Fold Windows and legacy-Mac line endings onto the product's canonical form
 * (004 FR-023).
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
 * Count Unicode **code points**, not UTF-16 units (004 FR-020).
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
 * Whether any line of the text tries to speak in the composition's voice
 * (004 FR-025, AC-134).
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
 * Whether one code point is a control character no instruction may contain
 * (004 FR-026): anything but tab and line feed inside the C0/C1 control
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
 * Whether the text holds a character no instruction may contain (004 FR-026).
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
