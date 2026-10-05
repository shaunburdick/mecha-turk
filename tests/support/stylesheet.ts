/**
 * A CSS reader: a stylesheet's text in, its rules out.
 *
 * The panel's DOM tests run against a fake double that computes no styles, so
 * a rule that *loses* the cascade looks exactly like a rule that wins — six
 * stacked tab bodies passed every DOM assertion in the suite while
 * `getComputedStyle` answered `flex` for all of them. This is the half of the
 * answer that reads the shipped `<style>` honestly; `./cascade.ts` is the half
 * that resolves what it reads.
 *
 * Comments are removed before scanning, and every scan respects strings,
 * parentheses, brackets, and braces, so a `;` inside `color-mix(in srgb, …)`
 * or a `}` inside a media block lands in the right place.
 */

/** One `property: value` declaration inside a rule. */
export interface Declaration {
    /** Property name, lower-cased the way the cascade compares it. */
    readonly property: string;
    /** The value with any `!important` suffix already stripped. */
    readonly value: string;
    /** Whether the declaration carried `!important`. */
    readonly important: boolean;
}

/** One style rule, with the media prelude that guards it. */
export interface StyleRule {
    /** Every selector in the list, split on top-level commas. */
    readonly selectors: readonly string[];
    /** Its declarations, in source order. */
    readonly declarations: readonly Declaration[];
    /** The `@media` prelude guarding the rule, or null at the top level. */
    readonly media: string | null;
    /** Source position, so equal-specificity ties resolve like a browser. */
    readonly order: number;
}

/** A cursor over the text being scanned. */
interface Cursor {
    readonly text: string;
    index: number;
}

/** How much grouping a scan has walked into, and whether it is inside a string. */
interface Grouping {
    depth: number;
    quote: string;
}

/** The result of scanning up to a stop character. */
interface Scan {
    /** Text before the stop (or the whole remainder when nothing stopped it). */
    readonly text: string;
    /** The stop character found and consumed, or an empty string at the end. */
    readonly found: string;
}

/** The accumulator a parse hands back. */
interface ParseState {
    readonly rules: StyleRule[];
    order: number;
}

/** The inputs {@link scanRules} takes, gathered because there are three. */
interface ScanInput {
    /** Cursor at the start of the text to scan. */
    readonly cursor: Cursor;
    /** The enclosing conditional prelude, or null at the top level. */
    readonly media: string | null;
    /** Accumulator carrying the rules and the source-order counter. */
    readonly state: ParseState;
}

/** CSS comments, removed before anything is scanned. */
const COMMENT = /\/\*[\s\S]*?\*\//g;

/** The `!important` suffix a declaration may carry. */
const IMPORTANT_SUFFIX = /\s*!\s*important\s*$/i;

/** At-rules whose block holds rules rather than declarations. */
const CONDITIONAL_AT_RULES = ['@media', '@supports', '@container', '@layer', '@scope'];

/** Characters of a malformed declaration an error message quotes back. */
const NESTING_EXCERPT = 60;

/** How many distinct media preludes get enumerated before settling for worst/best. */
const MEDIA_ENUMERATION_LIMIT = 4;

/**
 * Pull every `<style>` element's text out of an HTML document.
 *
 * @param html - The document source.
 * @returns The style blocks joined, ready for {@link parseStylesheet}.
 */
export function styleText(html: string): string {
    const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];

    return blocks.map((found) => found[1] ?? '').join('\n');
}

/**
 * Consume a quoted run or open a new one; false when the char is not a quote.
 *
 * @param cursor - Cursor to advance.
 * @param grouping - The scan's depth and current quote character.
 * @returns True when the character belonged to a string.
 */
function inQuotes(cursor: Cursor, grouping: Grouping): boolean {
    const char = cursor.text.charAt(cursor.index);

    if (grouping.quote !== '') {
        cursor.index += char === '\\' ? 2 : 1;
        if (char === grouping.quote && char !== '\\') {
            grouping.quote = '';
        }

        return true;
    }

    if (char === '"' || char === "'") {
        grouping.quote = char;
        cursor.index += 1;

        return true;
    }

    return false;
}

/**
 * Consume a parenthesised or bracketed run; false for any other character.
 *
 * @param cursor - Cursor to advance.
 * @param grouping - The scan's depth, moved by the group it walked into.
 * @returns True when the character belonged to a group.
 */
function inGroup(cursor: Cursor, grouping: Grouping): boolean {
    const char = cursor.text.charAt(cursor.index);
    const isOpening = char === '(' || char === '[';
    const isClosing = char === ')' || char === ']';

    if (!isOpening && !isClosing) {
        return false;
    }

    grouping.depth = Math.max(grouping.depth + (isOpening ? 1 : -1), 0);
    cursor.index += 1;

    return true;
}

/**
 * Read to a stop character, skipping strings, parens, brackets, and braces.
 *
 * The stop is consumed, so a caller can scan again from where this left off.
 *
 * @param cursor - Cursor to advance past the stop it found.
 * @param stops - Characters that end the scan when they sit at depth zero.
 * @returns The text before the stop, and the stop itself.
 */
function scanTo(cursor: Cursor, stops: string): Scan {
    const start = cursor.index;
    const grouping: Grouping = { depth: 0, quote: '' };

    while (cursor.index < cursor.text.length) {
        if (inQuotes(cursor, grouping)) {
            continue;
        }

        const char = cursor.text.charAt(cursor.index);

        if (inGroup(cursor, grouping)) {
            continue;
        }

        if (grouping.depth === 0 && stops.includes(char)) {
            const text = cursor.text.slice(start, cursor.index);
            cursor.index += 1;

            return { text, found: char };
        }

        if (char === '{' || char === '}') {
            grouping.depth = Math.max(grouping.depth + (char === '{' ? 1 : -1), 0);
        }

        cursor.index += 1;
    }

    return { text: cursor.text.slice(start), found: '' };
}

/**
 * Split one selector list on the commas that sit outside brackets and parens.
 *
 * @param prelude - Text holding the rule's selector list.
 * @returns The selectors, trimmed, in source order.
 */
function splitSelectors(prelude: string): readonly string[] {
    const cursor: Cursor = { text: prelude, index: 0 };
    const selectors: string[] = [];

    for (;;) {
        const piece = scanTo(cursor, ',');
        const trimmed = piece.text.trim();

        if (trimmed !== '') {
            selectors.push(trimmed);
        }

        if (piece.found !== ',') {
            return selectors;
        }
    }
}

/**
 * Read one `property: value` pair, pulling `!important` off the end.
 *
 * Exported because an inline `style` attribute holds the same syntax a
 * declaration block does, and the cascade reads it with this (see
 * `./cascade.ts`).
 *
 * @param chunk - One declaration, already trimmed.
 * @returns The parsed declaration.
 */
export function toDeclaration(chunk: string): Declaration {
    const cursor: Cursor = { text: chunk, index: 0 };
    const separator = scanTo(cursor, ':');
    const raw = separator.found === '' ? '' : chunk.slice(cursor.index).trim();
    const match = IMPORTANT_SUFFIX.exec(raw);

    return {
        property: separator.text.trim().toLowerCase(),
        value: match === null ? raw : raw.slice(0, match.index).trim(),
        important: match !== null,
    };
}

/**
 * Split a rule's block into declarations, honouring strings and parens.
 *
 * @param body - Everything between a rule's braces.
 * @returns Its declarations, in source order.
 */
function splitDeclarations(body: string): readonly Declaration[] {
    const cursor: Cursor = { text: body, index: 0 };
    const declarations: Declaration[] = [];

    for (;;) {
        const piece = scanTo(cursor, ';');
        const chunk = piece.text.trim();

        if (chunk.includes('{')) {
            throw new Error(`a declaration block nests another rule: ${chunk.slice(0, NESTING_EXCERPT)}`);
        }

        if (chunk !== '') {
            declarations.push(toDeclaration(chunk));
        }

        if (piece.found !== ';') {
            return declarations;
        }
    }
}

/**
 * Whether an at-rule's block holds rules (recursable) rather than declarations.
 *
 * @param prelude - The at-rule's text up to its opening brace.
 * @returns True for `@media` and its conditional cousins.
 */
function isConditional(prelude: string): boolean {
    return CONDITIONAL_AT_RULES.some((keyword) => prelude.trimStart().startsWith(keyword));
}

/**
 * Walk a stylesheet (or one media block) and collect every rule it holds.
 *
 * @param input - The cursor to scan, the media guard, and the accumulator.
 */
function scanRules(input: ScanInput): void {
    const { cursor, media, state } = input;

    for (;;) {
        const preludeScan = scanTo(cursor, '{}');

        if (preludeScan.found !== '{') {
            return;
        }

        const block = scanTo(cursor, '}');
        const prelude = preludeScan.text.trim();

        if (prelude.startsWith('@')) {
            if (isConditional(prelude)) {
                scanRules({ cursor: { text: block.text, index: 0 }, media: prelude, state });
            }
            continue;
        }

        if (prelude === '') {
            continue;
        }

        const { order } = state;
        state.order += 1;
        state.rules.push({
            selectors: splitSelectors(prelude),
            declarations: splitDeclarations(block.text),
            media,
            order,
        });
    }
}

/**
 * Parse a whole stylesheet into the rules a cascade can be resolved over.
 *
 * @param css - The stylesheet source, comments and all.
 * @returns Every rule, in source order, each with its media guard.
 */
export function parseStylesheet(css: string): readonly StyleRule[] {
    const state: ParseState = { rules: [], order: 0 };
    scanRules({ cursor: { text: css.replaceAll(COMMENT, ' '), index: 0 }, media: null, state });

    return state.rules;
}

/**
 * Every combination of conditional blocks a stylesheet could be read under.
 *
 * Two blocks means four readings (neither, each on its own, both), which is
 * how a rule that only hides an element at one viewport width is caught.
 *
 * @param rules - The parsed stylesheet.
 * @returns One set of in-force media preludes per combination.
 */
export function mediaVariants(rules: readonly StyleRule[]): readonly ReadonlySet<string>[] {
    const names = [
        ...new Set(
            rules
                .map((rule) => rule.media)
                .filter((name): name is string => name !== null),
        ),
    ];

    if (names.length > MEDIA_ENUMERATION_LIMIT) {
        return [new Set<string>(), new Set(names)];
    }

    const variants: ReadonlySet<string>[] = [];

    for (let reading = 0; reading < 2 ** names.length; reading++) {
        const active = new Set<string>();

        for (const [bit, name] of names.entries()) {
            if (Math.floor(reading / 2 ** bit) % 2 === 1) {
                active.add(name);
            }
        }

        variants.push(active);
    }

    return variants;
}
