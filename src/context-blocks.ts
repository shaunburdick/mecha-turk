/**
 * The bounded excerpt renderer: delimiters, defusing, and the per-source
 * budget (002 FR-028, 003 FR-014).
 *
 * This is the half of the first message that quotes **untrusted** source text,
 * split out of [`session.ts`](./session.ts) so that module stays the frame and
 * request builder it has become. Everything here is a pure string function,
 * which is the point: source text is copied, bounded, and neutralized, never
 * interpreted — and the tests drive all of it without a socket.
 *
 * Three properties this module owes, worst-first:
 *
 * - **A source can never forge a delimiter.** {@link defuseDelimiters} runs
 *   before any truncation, so a cut can never reassemble a marker, and only
 *   ever touches the two literal markers the block is built from.
 * - **Nothing is dropped silently.** Every source either renders under its own
 *   heading, carries an explicit truncation or omission marker, or is named by
 *   the roll-up line whose length was reserved before the first block ran.
 * - **The budget is one running number.** Every character a block emits is
 *   subtracted from the same allowance the caller sized, so the total is
 *   honest whatever the per-item bounds disagree about.
 */

/** Line separator used by the bounded context. */
const NEWLINE = '\n';

/** Appended to excerpt text this module cut (FR-014's explicit truncation marker). */
export const EXCERPT_TRUNCATION_MARKER = '… [truncated]';

/** Stands in for excerpt text this context had no room for; never silent (FR-014). */
export const EXCERPT_OMITTED_MARKER = '[excerpt omitted: no room in this dispatch context]';

/** Opening delimiter of the untrusted source text (FR-026). */
export const BEGIN_UNTRUSTED = '--- BEGIN UNTRUSTED ISSUE TEXT (truncated) ---';

/** Closing delimiter of the untrusted source text (FR-026). */
export const END_UNTRUSTED = '--- END UNTRUSTED ISSUE TEXT ---';

/** Hyphen used to elide a delimiter that hostile source text tried to forge. */
const DEFUSED_HYPHEN = '‐';

/**
 * Maximum characters one source's excerpt may occupy in the context.
 *
 * Two limits have to hold at once (FR-014): a per-source ceiling of 4,000
 * characters and the 12,000-character dispatch total. The per-item bound this
 * module applies is {@link SOURCE_EXCERPT_MAX_CHARS} — the 600-character bound
 * the trigger layer already writes and the claim transport already carries —
 * which is inside the 4,000 ceiling by construction, so the *budget* rather
 * than the ceiling is what decides how much of a source is shown. Each source
 * actually receives `min(600, its fair share of what is left)`, so 200
 * retained references (200 × 600 = 120,000 characters) can never crowd past
 * the dispatch total, and every source that is cut says so (FR-014's explicit
 * truncation marker — never a silent drop).
 */
export const SOURCE_EXCERPT_MAX_CHARS = 600;

/** One line of untrusted context: its heading, and the excerpt under it. */
export interface ContextBlock {
    /** `null` for the legacy single-source shape, which carries no heading. */
    readonly head: string | null;
    /** The source's excerpt. */
    readonly excerpt: string;
}

/**
 * Elide one block delimiter out of untrusted text.
 *
 * @param marker - The literal marker to neutralize.
 * @returns The marker with its hyphens substituted, so it can no longer match.
 */
function elideMarker(marker: string): string {
    return marker.replaceAll('-', DEFUSED_HYPHEN);
}

/**
 * Elide any attempt by untrusted text to forge one of the block's delimiters.
 *
 * A source that quoted `--- END UNTRUSTED ISSUE TEXT ---` verbatim would close
 * the block early and let everything after it read as trusted framing — which
 * is exactly what FR-014's "delimiters that prevent source text from altering
 * policy" forbids. The substitution is byte-for-byte length preserving, happens
 * **before** any truncation (so a cut can never reassemble a marker), and only
 * ever touches the two literal markers.
 *
 * @param text - Untrusted source text.
 * @returns The text with every forged delimiter neutralized.
 */
export function defuseDelimiters(text: string): string {
    return text
        .replaceAll(BEGIN_UNTRUSTED, elideMarker(BEGIN_UNTRUSTED))
        .replaceAll(END_UNTRUSTED, elideMarker(END_UNTRUSTED));
}

/**
 * Fit one source's excerpt into its share of the budget, marking the cut.
 *
 * @param excerpt - Untrusted excerpt, delimiters already neutralized.
 * @param bound - Characters this source may spend on its excerpt.
 * @returns The excerpt, a truncation-marked prefix of it, or the omission
 *   marker when not even the marker's own length fits.
 */
function fitExcerpt(excerpt: string, bound: number): string {
    if (excerpt.length <= bound) {
        return excerpt;
    }

    if (bound <= EXCERPT_TRUNCATION_MARKER.length) {
        return EXCERPT_OMITTED_MARKER;
    }

    return `${excerpt.slice(0, bound - EXCERPT_TRUNCATION_MARKER.length)}${EXCERPT_TRUNCATION_MARKER}`;
}

/**
 * Compose the explicit roll-up line that names the sources the budget excluded.
 *
 * @param skipped - How many sources were not listed.
 * @returns The line; plain text, never a delimiter.
 */
function rollUpLine(skipped: number): string {
    const noun = skipped === 1 ? 'source' : 'sources';

    return `[+${skipped} ${noun} not listed: dispatch context budget exhausted]`;
}

/**
 * Render every block the budget still affords, in order.
 *
 * Each source takes `min(SOURCE_EXCERPT_MAX_CHARS, its fair share of what is
 * left)`, so the answer is deterministic, every listed source is fully
 * accounted for, and a source the budget cannot list is counted rather than
 * silently dropped. The roll-up line's length is reserved before the first
 * block is rendered, which is what makes "never silent" a guarantee instead of
 * a hope: the reserved space cannot be spent by the blocks in front of it.
 *
 * @param input - The blocks and the character budget their lines may occupy.
 * @returns The lines to place between the delimiters, in order.
 */
export function renderBlocks(input: {
    readonly blocks: readonly ContextBlock[];
    readonly available: number;
}): string[] {
    const { blocks, available } = input;
    // Two extra characters cover the blank line that would precede the roll-up.
    // Reserving only for a multi-source run keeps a single-source context whole:
    // there the block's own truncation/omission marker is the visible cut, and
    // spending sixty characters on a roll-up that cannot happen would only
    // shrink the quotation.
    const reserve = blocks.length > 1 ? rollUpLine(blocks.length).length + NEWLINE.length * 2 : 0;
    const budget = Math.max(available - reserve, 0);
    const rendered: string[] = [];
    let used = 0;
    let skipped = 0;

    for (const [index, block] of blocks.entries()) {
        const separator = rendered.length > 0 ? NEWLINE.length * 2 : 0;
        const remaining = budget - used - separator;
        const sourcesLeft = blocks.length - index;
        if (remaining <= 0) {
            skipped = sourcesLeft;
            break;
        }

        const head = block.head === null ? '' : `${defuseDelimiters(block.head)}${NEWLINE}`;
        // FR-014's per-item bound: the smallest of the excerpt ceiling, this
        // source's fair share of what is left, and what is left after its own
        // heading is paid for. All three hold at once, and the hard length
        // check below keeps the total honest whatever the three disagree about.
        const share = Math.floor(remaining / sourcesLeft);
        const bound = Math.max(Math.min(SOURCE_EXCERPT_MAX_CHARS, share, remaining - head.length), 0);
        const text = `${head}${fitExcerpt(defuseDelimiters(block.excerpt), bound)}`;
        if (text.length > remaining) {
            skipped = sourcesLeft;
            break;
        }

        rendered.push(text);
        used += separator + text.length;
    }

    if (skipped > 0) {
        const rollUp = rollUpLine(skipped);
        const separator = rendered.length > 0 ? NEWLINE.length * 2 : 0;
        if (used + separator + rollUp.length <= available) {
            rendered.push(rollUp);
        }
    }

    return rendered;
}
