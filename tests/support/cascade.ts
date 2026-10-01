/**
 * The resolving half of the stylesheet reader: which rules apply to one
 * element, and which declaration wins.
 *
 * The reader models a subset of CSS and is deliberately *optimistic* where the
 * subset runs out: a construct it does not understand (`+`, `~`, `:not`, an
 * exotic attribute operator, a pseudo-class it has never seen) answers "this
 * applies", and a selector's ancestor chain is assumed to hold rather than
 * walked. Optimism only ever adds declarations to the contest, so a rule that
 * would show an element is always given its chance to win — the assertions get
 * harder to pass, never easier, and a stylesheet that hides a body only under
 * a condition this reader cannot model fails loudly rather than passes
 * quietly.
 *
 * Ties resolve the way a browser resolves them: `!important` first, then
 * specificity, then source order. The user-agent sheet is not modelled at all,
 * because anything it declares is already out-ranked by every author rule.
 *
 * One author declaration is not written in a rule at all: an element's own
 * `style` attribute. It is offered to the contest as a candidate whose weight
 * no selector can reach (an inline declaration has the highest specificity
 * there is), so an inline `display` is a real answer here rather than a gap
 * the reader silently skips — which is what makes
 * `[hidden] { display: none !important }` provably necessary.
 */
import { toDeclaration } from './stylesheet.ts';
import type { StyleRule } from './stylesheet.ts';

/** The element the cascade is asked about. */
export interface ProbeElement {
    /** Lower-case tag name. */
    readonly tag: string;
    /** The `id` attribute, when the element has one. */
    readonly id?: string;
    /** Class words; a tab body carries none, which is what makes it interesting. */
    readonly classes?: readonly string[];
    /** Attributes as name → value (an empty string for a bare attribute). */
    readonly attributes?: Readonly<Record<string, string>>;
    /** 1-based position among the parent's element children. */
    readonly position?: number;
    /** How many element children the parent has, for `:last-child`. */
    readonly childCount?: number;
    /** The parent, so the reader can note a chain exists even if it skips it. */
    readonly parent?: ProbeElement;
}

/** The inputs `cascadedDisplay` takes. */
export interface CascadeInput {
    /** The parsed stylesheet. */
    readonly rules: readonly StyleRule[];
    /** The element to resolve a `display` for. */
    readonly element: ProbeElement;
    /** The `@media` preludes currently in force. */
    readonly media: ReadonlySet<string>;
}

/** Token kinds, named once so no selector string is ever repeated. */
const TAG_KIND = 'tag';
const ID_KIND = 'id';
const CLASS_KIND = 'class';
const ATTRIBUTE_KIND = 'attribute';
const PSEUDO_KIND = 'pseudo';

/** Which selector construct a compound token came from. */
type TokenKind =
    | typeof TAG_KIND
    | typeof ID_KIND
    | typeof CLASS_KIND
    | typeof ATTRIBUTE_KIND
    | typeof PSEUDO_KIND;

/** One token of a compound selector. */
interface Token {
    /** Which construct the token came from. */
    readonly kind: TokenKind;
    /** `div`, `root`, `mt-block`, `data-body`, `first-child` … */
    readonly name: string;
    /** For `[a=b]`, the operator and value that follow the name. */
    readonly detail: string;
}

/** One token and the index just past it, as {@link readToken} reports both. */
interface Step {
    readonly token: Token;
    readonly next: number;
}

/** A declaration that could set `display`, with everything a tie-break needs. */
interface Candidate {
    /** The declared value. */
    readonly value: string;
    /** Whether the declaration was `!important`. */
    readonly important: boolean;
    /** Specificity of the selector that declared it. */
    readonly weight: number;
    /** Source order of the rule that declared it. */
    readonly order: number;
}

/** The inputs {@link applyRule} takes. */
interface RuleInput {
    readonly rule: StyleRule;
    readonly element: ProbeElement;
    readonly media: ReadonlySet<string>;
    readonly current: Candidate | null;
}

/** The inputs {@link applySelector} takes. */
interface SelectorInput {
    readonly selector: string;
    readonly rule: StyleRule;
    readonly element: ProbeElement;
    readonly current: Candidate | null;
}

/** The universal selector, which matches anything and weighs nothing. */
const STAR = '*';

/** The one property these assertions resolve: an element's `display`. */
const DISPLAY_PROPERTY = 'display';

/** The `style` attribute, which carries declarations an element owns itself. */
const STYLE_ATTRIBUTE = 'style';

/** Characters a CSS identifier may carry, so names are scanned rather than matched. */
const NAME_CHAR = /[\w-]/;

/** Characters that separate one compound selector from the next. */
const SEPARATORS = ' >+~';

/** Characters that may prefix an attribute operator (`~=`, `|=`, …). */
const ATTRIBUTE_OPERATORS = '~|^$*';

/** Quotes an attribute value may be wrapped in. */
const QUOTED = /^["']|["']$/g;

/** Scale factors that turn (ids, classes, types) into one comparable number. */
const CLASS_WEIGHT = 1_000;
const ID_WEIGHT = 1_000_000;

/**
 * The weight of an element's own `style` declaration — the (1,0,0,0) a
 * selector cannot reach. Spelled as the product of the two scales above so it
 * stays "more ids than any selector could ever carry" if they ever move.
 */
const STYLE_WEIGHT = ID_WEIGHT * CLASS_WEIGHT;

/** The `=` operator, spelled out for the case that carries no prefix. */
const EQUALS = '=';

/**
 * Read how far an identifier runs from one position.
 *
 * @param text - The selector text.
 * @param start - Where the name begins.
 * @returns The index just past the name, or `start` when there is none.
 */
function scanName(text: string, start: number): number {
    let index = start;

    while (index < text.length && NAME_CHAR.test(text.charAt(index))) {
        index += 1;
    }

    return index;
}

/**
 * Read one `[name]` / `[name=value]` attribute selector.
 *
 * @param piece - The bracketed text, brackets included.
 * @returns Its name and the operator/value that follows it.
 */
function parseAttribute(piece: string): Token {
    const inner = piece.slice(1, -1);
    const equals = inner.indexOf(EQUALS);

    if (equals === -1) {
        return { kind: ATTRIBUTE_KIND, name: inner.trim(), detail: '' };
    }

    const before = inner.slice(0, equals).trim();
    const tail = before.slice(-1);
    const symbolic = ATTRIBUTE_OPERATORS.includes(tail);
    const name = symbolic ? before.slice(0, -1) : before;
    const operator = symbolic ? `${tail}${EQUALS}` : EQUALS;
    const value = inner.slice(equals + 1).trim().replace(QUOTED, '');

    return { kind: ATTRIBUTE_KIND, name, detail: `${operator}${value}` };
}

/**
 * Read one `:pseudo` / `:pseudo(argument)` selector.
 *
 * @param piece - The colon-prefixed text.
 * @returns Its name and argument, or an empty argument.
 */
function parsePseudo(piece: string): Token {
    const body = piece.slice(1);
    const open = body.indexOf('(');

    if (open === -1) {
        return { kind: PSEUDO_KIND, name: body, detail: '' };
    }

    return { kind: PSEUDO_KIND, name: body.slice(0, open), detail: body.slice(open + 1, -1) };
}

/**
 * Read one token that opens with `[` or `:` through to its closing delimiter.
 *
 * @param compound - The compound selector being read.
 * @param index - Where the delimiter sits.
 * @returns The token, and the index just past it.
 */
function readDelimited(compound: string, index: number): Step {
    const bracketed = compound.charAt(index) === '[';
    const closer = bracketed ? ']' : ')';
    const close = compound.indexOf(closer, index);
    const end = close === -1 ? compound.length : close + 1;
    const text = compound.slice(index, end);

    return { token: bracketed ? parseAttribute(text) : parsePseudo(text), next: end };
}

/**
 * Read one token that opens with `#` or `.`.
 *
 * @param compound - The compound selector being read.
 * @param index - Where the token starts.
 * @returns The token, and the index just past it.
 */
function readNamed(compound: string, index: number): Step {
    const end = scanName(compound, index + 1);
    const kind = compound.charAt(index) === '#' ? ID_KIND : CLASS_KIND;

    return { token: { kind, name: compound.slice(index + 1, end), detail: '' }, next: end };
}

/**
 * Read one token of a compound selector, whatever it opens with.
 *
 * @param compound - The compound selector being read.
 * @param index - Where the token starts.
 * @returns The token, and the index just past it.
 */
function readToken(compound: string, index: number): Step {
    const char = compound.charAt(index);

    if (char === STAR) {
        return { token: { kind: TAG_KIND, name: STAR, detail: '' }, next: index + 1 };
    }

    if (char === '#' || char === '.') {
        return readNamed(compound, index);
    }

    if (char === '[' || char === ':') {
        return readDelimited(compound, index);
    }

    const end = scanName(compound, index);

    return {
        token: { kind: TAG_KIND, name: compound.slice(index, end), detail: '' },
        next: end === index ? index + 1 : end,
    };
}

/**
 * Parse one compound selector (`div#root.mt-block[data-body]`) into tokens.
 *
 * @param compound - The compound selector text.
 * @returns Its tokens, left to right.
 */
function parseCompound(compound: string): readonly Token[] {
    const tokens: Token[] = [];
    let index = 0;

    while (index < compound.length) {
        const step = readToken(compound, index);
        tokens.push(step.token);
        index = step.next;
    }

    return tokens;
}

/**
 * Whether a `:nth-child()` argument selects this position.
 *
 * @param argument - `3`, `odd`, `even`, or something this reader cannot model.
 * @param element - The element whose position is being tested.
 * @returns False only when the argument is understood and the position is not.
 */
function matchesNth(argument: string, element: ProbeElement): boolean {
    const position = element.position ?? 0;
    const trimmed = argument.trim();

    if (trimmed === 'odd') {
        return position % 2 === 1;
    }

    if (trimmed === 'even') {
        return position % 2 === 0;
    }

    const parsed = Number.parseInt(trimmed, 10);

    return Number.isNaN(parsed) ? true : position === parsed;
}

/**
 * Whether one attribute selector holds for an element.
 *
 * @param token - The parsed attribute selector.
 * @param element - The element under test.
 * @returns True when the attribute is there and any modelled test passes.
 */
function matchesAttribute(token: Token, element: ProbeElement): boolean {
    const actual = element.attributes?.[token.name];

    if (actual === undefined) {
        return false;
    }

    if (token.detail === '') {
        return true;
    }

    if (token.detail.startsWith(EQUALS)) {
        return actual === token.detail.slice(1);
    }

    return true;
}

/**
 * Whether one pseudo-class holds for an element.
 *
 * The positional classes are the ones this reader can disprove; everything
 * else, `:not` included, is answered optimistically (see the module header).
 *
 * @param token - The parsed pseudo-class.
 * @param element - The element under test.
 * @returns False for a positional class it can rule out, true otherwise.
 */
function matchesPseudo(token: Token, element: ProbeElement): boolean {
    if (token.name === 'first-child') {
        return element.position === 1;
    }

    if (token.name === 'last-child') {
        return element.position === element.childCount;
    }

    if (token.name === 'nth-child') {
        return matchesNth(token.detail, element);
    }

    return true;
}

/**
 * Whether one parsed token selects an element.
 *
 * @param token - The token to test.
 * @param element - The element under test.
 * @returns True when the token holds.
 */
function matchesToken(token: Token, element: ProbeElement): boolean {
    if (token.kind === TAG_KIND) {
        return token.name === STAR || token.name === element.tag;
    }

    if (token.kind === ID_KIND) {
        return token.name === element.id;
    }

    if (token.kind === CLASS_KIND) {
        return (element.classes ?? []).includes(token.name);
    }

    if (token.kind === ATTRIBUTE_KIND) {
        return matchesAttribute(token, element);
    }

    return matchesPseudo(token, element);
}

/**
 * Whether every token of one compound selector holds.
 *
 * @param compound - The compound selector text.
 * @param element - The element under test.
 * @returns True when no token rules the element out.
 */
function matchesCompound(compound: string, element: ProbeElement): boolean {
    return parseCompound(compound).every((token) => matchesToken(token, element));
}

/**
 * Split a complex selector into its compound selectors.
 *
 * @param selector - One selector from a rule's list.
 * @returns Every compound, left to right.
 */
function splitCompounds(selector: string): readonly string[] {
    const compounds: string[] = [];
    let buffer = '';
    let depth = 0;

    for (const char of selector) {
        if (char === '(' || char === '[') {
            depth += 1;
        } else if (char === ')' || char === ']') {
            depth = Math.max(depth - 1, 0);
        }

        if (depth === 0 && SEPARATORS.includes(char)) {
            if (buffer !== '') {
                compounds.push(buffer);
                buffer = '';
            }
            continue;
        }

        buffer += char;
    }

    if (buffer !== '') {
        compounds.push(buffer);
    }

    return compounds;
}

/**
 * Whether one selector selects one element.
 *
 * Only the rightmost compound decides; an ancestor chain is assumed to hold
 * rather than walked, which is the optimism the module header describes.
 *
 * @param selector - A single selector from a rule's list.
 * @param element - The element under test.
 * @returns True when the selector applies to it.
 */
function matchesSelector(selector: string, element: ProbeElement): boolean {
    const compounds = splitCompounds(selector);
    const last = compounds[compounds.length - 1];

    return last !== undefined && matchesCompound(last, element);
}

/**
 * The specificity of one selector, collapsed into a single number.
 *
 * @param selector - A single selector from a rule's list.
 * @returns `ids * 1e6 + classes * 1e3 + types`, the usual (a, b, c) ranking.
 */
function specificity(selector: string): number {
    let ids = 0;
    let classes = 0;
    let types = 0;

    for (const compound of splitCompounds(selector)) {
        for (const token of parseCompound(compound)) {
            if (token.kind === ID_KIND) {
                ids += 1;
            } else if (token.kind === TAG_KIND) {
                types += token.name === STAR ? 0 : 1;
            } else {
                classes += 1;
            }
        }
    }

    return ids * ID_WEIGHT + classes * CLASS_WEIGHT + types;
}

/**
 * Whether one candidate out-ranks the incumbent, in cascade order.
 *
 * @param candidate - The declaration under consideration.
 * @param incumbent - The winner so far.
 * @returns True when the candidate should replace it.
 */
function beats(candidate: Candidate, incumbent: Candidate): boolean {
    if (candidate.important !== incumbent.important) {
        return candidate.important;
    }

    if (candidate.weight !== incumbent.weight) {
        return candidate.weight > incumbent.weight;
    }

    return candidate.order > incumbent.order;
}

/**
 * Fold one rule's `display` declarations into the winner so far.
 *
 * @param input - The rule, the element, the media in force, and the incumbent.
 * @returns The incumbent, or the rule's declaration when it out-ranks it.
 */
function applySelector(input: SelectorInput): Candidate | null {
    const { selector, rule, element, current } = input;

    if (!matchesSelector(selector, element)) {
        return current;
    }

    const weight = specificity(selector);
    let best = current;

    for (const declaration of rule.declarations) {
        if (declaration.property !== DISPLAY_PROPERTY) {
            continue;
        }

        const candidate: Candidate = {
            value: declaration.value,
            important: declaration.important,
            weight,
            order: rule.order,
        };

        if (best === null || beats(candidate, best)) {
            best = candidate;
        }
    }

    return best;
}

/**
 * Fold one rule into the winner so far, skipping media that is not in force.
 *
 * @param input - The rule, the element, the media in force, and the incumbent.
 * @returns The incumbent, or a better declaration the rule contributes.
 */
function applyRule(input: RuleInput): Candidate | null {
    const { rule, element, media, current } = input;

    if (rule.media !== null && !media.has(rule.media)) {
        return current;
    }

    let best = current;

    for (const selector of rule.selectors) {
        best = applySelector({ selector, rule, element, current: best });
    }

    return best;
}

/**
 * The candidate an element's own `style` attribute contributes, if any.
 *
 * An inline declaration is an author declaration carrying the highest
 * specificity there is, so it enters the contest at {@link STYLE_WEIGHT} — no
 * selector can out-rank it, and only another `!important` declaration beats
 * it. It is read through `toDeclaration` so an inline `!important` is parsed
 * as one rather than left glued to the value.
 *
 * `order` is 0 because nothing ever ties on this weight: `beats` only consults
 * source order when importance and weight are both equal, and this candidate
 * is alone at the top of the scale.
 *
 * @param element - The element under test.
 * @returns The inline `display` candidate, or null when the attribute holds none.
 */
function inlineCandidate(element: ProbeElement): Candidate | null {
    const text = element.attributes?.[STYLE_ATTRIBUTE];

    if (text === undefined) {
        return null;
    }

    for (const chunk of text.split(';')) {
        const declaration = toDeclaration(chunk);

        if (declaration.property === DISPLAY_PROPERTY) {
            return { value: declaration.value, important: declaration.important, weight: STYLE_WEIGHT, order: 0 };
        }
    }

    return null;
}

/**
 * The `display` the cascade gives one element, under one set of media.
 *
 * @param input - The parsed rules, the element, and the media in force.
 * @returns The winning value, or null when nothing declares `display`.
 */
export function cascadedDisplay(input: CascadeInput): string | null {
    const winner = input.rules.reduce<Candidate | null>(
        (current, rule) => applyRule({ rule, element: input.element, media: input.media, current }),
        inlineCandidate(input.element),
    );

    return winner === null ? null : winner.value;
}
