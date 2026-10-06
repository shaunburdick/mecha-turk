#!/usr/bin/env node
/**
 * The site's build-output contract, executable.
 *
 * The page/link contract, preference palettes, and contrast floor are properties of
 * what `astro build` emitted, not of what anyone wrote: AC-001 (no page beyond
 * the five), AC-002 (every internal link under the base path), AC-003 (every
 * page reaches all five), AC-004 (no remote resource, no image file), AC-005
 * (one `h1`, a named navigation region, the license link), AC-032 (both CSS
 * preference palettes), NFR-002 (no JavaScript), NFR-003 (no third-party
 * request), and NFR-004's contrast floor in both palettes. A reviewer with `src/` open
 * is checking the wrong artefact — the failure these exist to catch is the one
 * that builds green and 404s on the published address.
 *
 * So this runs over `dist/` after the build and is the last step of
 * `npm run build`: one command for a contributor and for the site's only gate,
 * so the two cannot differ. It is `node`-stdlib-only.
 *
 * Every failure names the file, the markup or path that broke it, and the
 * requirement it breaks. A gate that says "invalid output" is a gate nobody can
 * act on, and one that stops at the first failure costs a contributor a build
 * per finding — so every failure is collected and all of them are reported.
 *
 * Usage: `node scripts/assert-build.mjs [dist-directory]`, defaulting to the
 * `dist/` beside this script's site. The argument exists so the fixtures in
 * `tests/assert-build.assertions.mjs` can point it at a temporary output; the
 * build script passes nothing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The five published pages: the path below the base, and the file that serves it (AC-001).
 *
 * The same five addresses are declared in `src/data/site.ts` as `PAGES`, and that
 * is what renders the navigation. This list is deliberately a second reading
 * rather than an import of that module — it is `.ts`, and importing it would put
 * this script behind whatever flags type-stripping needs on the site's Node
 * floor. The two are held to each other anyway: the navigation every page emits
 * is checked against *this* list, so a page dropped from `site.ts` fails here
 * instead of quietly shrinking the site.
 */
const PAGES = [
    { address: '/', label: 'the landing page', file: 'index.html' },
    { address: '/install/', label: 'the install page', file: 'install/index.html' },
    { address: '/configure/', label: 'the configure page', file: 'configure/index.html' },
    { address: '/use/', label: 'the use page', file: 'use/index.html' },
    { address: '/debug/', label: 'the debug page', file: 'debug/index.html' },
];

/**
 * NFR-002: a file the browser loads as code. `.map` is here because a source map
 * is only ever emitted beside the script it describes, so finding one means the
 * script is in the output too.
 */
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.map', '.wasm']);

/** FR-009 and AC-004: no image of any kind reaches the output. */
const IMAGE_EXTENSIONS = new Set([
    '.avif',
    '.bmp',
    '.gif',
    '.ico',
    '.jpeg',
    '.jpg',
    '.png',
    '.svg',
    '.tif',
    '.tiff',
    '.webp',
]);

/**
 * FR-052 and AC-006. Spelled out rather than derived, because a marker nobody can
 * name is a marker nobody writes. Each token is a word a page could carry while
 * still being unfinished.
 */
const PLACEHOLDER_TOKENS = ['todo', 'fixme', 'coming soon', 'lorem ipsum', 'placeholder', 'tbd', 'under construction'];

/**
 * A token matched **whole**, which is a different assertion from "matched somewhere".
 *
 * The first cut of this check asked whether the page contained the token at all, and
 * that is a check the shipped prose fails: `service/config-schema.ts` states that the
 * starting prompt is "sent to the agent verbatim, with no placeholders", the configure
 * page renders that sentence verbatim, and AC-006 then rejected *the service promising
 * that substitution does not happen*. A substring test also cannot tell a marker from
 * the word inside `todos.json`, from `tbd` inside a longer identifier, or from a
 * filename quoted in a code span — so a gate that fails on those is a gate a contributor
 * learns to work around rather than one that catches an unfinished page.
 *
 * The boundary is a set of characters that would make the token *part of a longer
 * name* rather than the name itself:
 *
 * - **Before**: a letter, digit, `_`, `.` or `-`. That covers `todos.json`, `.todo` and
 *   `fixme-mode`, none of which is an unfinished marker. A `/` is deliberately *not* in
 *   the set: in running prose a slash separates words far more often than it names a
 *   directory, so exempting it would let `the panel/TBD path` through to buy an exemption
 *   no real page needs. A gate's false *accept* is the expensive direction.
 * - **After**: a letter, digit or `_` (so the plural `placeholders` is not a match), or a
 *   `-` that continues into a word (`todo-list`), or a `.` that is *followed by* a word
 *   (`todo.md`). A trailing `.` with nothing name-like after it is punctuation, which is
 *   what `… fix this TODO.` ends with — that is still a marker and must still fail.
 *
 * The words of a multi-word token are joined by `[\s-]+` so `under-construction` matches
 * the phrase as well as `under construction`.
 */
const TOKEN_LEADING = '(?<![a-z0-9_.-])';
const TOKEN_TRAILING = '(?![a-z0-9_]|-\\w|\\.[a-z0-9])';

/**
 * Compile one token into the pattern that matches it whole.
 *
 * @param {string} token A word, or two words separated by a single space.
 * @returns {string} A pattern matching the token only where it stands alone.
 */
function wholeWordPattern(token) {
    const words = token
        .split(' ')
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s-]+');

    return `${TOKEN_LEADING}${words}${TOKEN_TRAILING}`;
}

/**
 * Every token compiled once, paired with the token a failure should quote.
 *
 * The patterns are written in lower case and are matched against lower-cased HTML, so
 * there is no `i` flag: the case is handled by the one `toLowerCase()` at the use site
 * rather than twice over. Compiled here rather than per page because this runs over five
 * pages on every build and a pattern that is rebuilt seven times each time is a
 * readability cost for nothing.
 */
const PLACEHOLDER_PATTERNS = PLACEHOLDER_TOKENS.map((token) => ({ token, pattern: new RegExp(wholeWordPattern(token)) }));

/**
 * The other two shapes FR-052 forbids, which no token list can reach because
 * neither carries a word of its own.
 *
 * `PLACEHOLDER_TOKENS` is a vocabulary; these are **syntax**, and the two together
 * are what AC-006 names — *"a placeholder, a template marker, a 'coming soon', an
 * empty section heading, or an instruction to fill something in later"*. A gate
 * holding the vocabulary alone is satisfied by a page whose unfinished parts are
 * spelled as braces rather than as words, which is precisely what a build leaves
 * behind when an `.astro` expression is not a valid identifier, is a raw string, or
 * renders nothing at all.
 */
const UNFINISHED_SHAPES = [
    {
        name: 'a template marker',
        // `{{name}}`: the shape every template engine and every README placeholder
        // reserves, and the shape a value read from configuration can carry into a
        // page verbatim. A single brace pair is not matched here — that is
        // `UNRESOLVED_EXPRESSION`, below.
        pattern: /\{\{[^{}]*\}\}/,
    },
    {
        name: 'an unresolved expression',
        // `{name}`, `{name.member}`, `{name['key']}`, `{name[0]}`: an expression that
        // reached the output instead of being evaluated, which is what an undefined
        // binding, a `set:html` of template source, or a component prop holding literal
        // text leaves on the page.
        //
        // **Member access is inside the pattern, not beside it.** Astro's own expressions
        // are predominantly member access — `{row.entry}`, `{row.holds}` — so a bare
        // identifier was the narrow reading of a leak that in practice arrives with a dot
        // in it, and the audit would have called the shipped site's own shapes unreachable
        // while catching only the one shape the site does not use.
        //
        // A `(` is excluded, so `{foo(bar)}` is not matched here: that is a *call*, and
        // whether it evaluated is not decidable from the output alone. It is left to the
        // token scan rather than guessed at, because a false accept is the expensive
        // direction.
        pattern: /\{\s*[A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:'[^']*'|"[^"]*"|\d+)\s*\]))*\s*\}/,
    },
    {
        name: 'an empty heading',
        // `<h2></h2>`: the section heading FR-052 names explicitly, at any level and
        // through any attributes. Whitespace-only counts, because that is what a
        // heading whose only content was an expression that rendered nothing looks
        // like after the build trims it.
        pattern: /<h([1-6])\b[^>]*>\s*<\/h\1\s*>/i,
    },
];

/**
 * The one element on the site that spells a literal brace marker on purpose.
 *
 * `/configure/` documents that the starting prompt is sent verbatim by printing
 * the marker itself — `<code>{'{number}'}</code>` — and FR-052's shape check cannot
 * tell that from an expression that leaked into the output. The exemption is an
 * **attribute** rather than an HTML comment for the reason 007 D14 gives the
 * vocabulary scan: Astro strips comments from a template, so a comment would scope
 * the exemption in the source and vanish from the built page, leaving the scan
 * reading the marker in one and not the other. Marking the element is what makes the
 * exemption survive the build, and `AC_LITERAL_MARKER` is asserted to be present
 * below, so the marker cannot be deleted into a failure the contributor does not
 * see.
 */
const AC_LITERAL_MARKER = 'data-literal-marker';

/**
 * A page's markup with its style blocks removed.
 *
 * The shape checks above are assertions about **what a reader reads**, and a CSS
 * rule body is a run of braces that no template engine produced. `PLACEHOLDER_PATTERNS`
 * runs over the raw page and is left alone — it is an existing assertion, and
 * narrowing the bytes it reads would only weaken it.
 *
 * @param {string} html A page's markup.
 * @returns {string} The same page with every `<style>` body removed.
 */
function readMarkup(html) {
    return html.replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/**
 * Every page's markup, with the marked literal markers cut out of it.
 *
 * Cut whole elements rather than the attribute alone, so an exempt `<code>` cannot
 * hide a second marker the author put inside it. The span runs from the marked
 * element's opening tag to the first closing tag of the same name — which is
 * unambiguous for the element this site marks, a `<code>` that carries one marker.
 *
 * @param {string} markup A page's markup, style blocks already removed.
 * @returns {string} The same markup with every marked element removed.
 */
function withoutLiteralMarkers(markup) {
    const open = /<([a-zA-Z][^\s/>]*)\b([^>]*)>/g;
    const spans = [];
    for (const element of markup.matchAll(open)) {
        const attributes = readAttributes(element[2] ?? '');
        if (attributes.get(AC_LITERAL_MARKER) !== 'true') {
            continue;
        }
        const close = new RegExp(`</${(element[1] ?? '').toLowerCase()}\\s*>`, 'gi');
        close.lastIndex = (element.index ?? 0) + element[0].length;
        const found = close.exec(markup);
        const start = element.index ?? 0;
        const end = found === null ? start + element[0].length : found.index + found[0].length;
        spans.push([start, end]);
    }
    if (spans.length === 0) {
        return markup;
    }
    const kept = [];
    let cursor = 0;
    for (const [start, end] of spans) {
        kept.push(markup.slice(cursor, start));
        cursor = end;
    }
    kept.push(markup.slice(cursor));

    return kept.join('');
}

/**
 * Attributes whose value the browser fetches, executes, or resolves every other
 * reference against.
 *
 * This is the distinction the whole off-origin check turns on, and it is a
 * distinction of *position*, not of host. FR-010 and NFR-003 govern the requests
 * a page view makes; a hyperlink is not one. The footer's links into the
 * repository are off-origin by necessity — the site publishes no copy of the
 * license (plan D8) and AC-005 requires the link — so a check that flagged every
 * off-origin URL would be flagging a requirement.
 *
 * **`base` is the first entry that fetches nothing, and the reason it is here.**
 * A `<base href>` names no resource; it re-bases every *relative* URL on the page,
 * so the request it causes is made under whatever origin it names. That is the
 * shape NFR-003 forbids, it is reachable from a build that stays otherwise green,
 * and a position list that omitted it would have left a page able to point its
 * own stylesheet, font and script at a third-party host by changing one attribute
 * in the layout. It carries the same two AC-002 checks as every other position, so
 * a base that is off-origin **or** drops the published path fails either way.
 *
 * `style` is the second such entry, and it is handled rather than listed: a
 * `style` attribute is a stylesheet body, so it is routed through
 * `assertInlineStylesheet` below — which is what catches
 * `style="background:url(https://…)"`. Listing it here would read it as a bare URL
 * and miss every `url()` in it.
 */
const RESOURCE_POSITIONS = [
    { tag: 'base', attribute: 'href' },
    { tag: 'img', attribute: 'src' },
    { tag: 'image', attribute: 'href' },
    { tag: 'image', attribute: 'xlink:href' },
    { tag: 'script', attribute: 'src' },
    { tag: 'iframe', attribute: 'src' },
    { tag: 'embed', attribute: 'src' },
    { tag: 'object', attribute: 'data' },
    { tag: 'input', attribute: 'src' },
    { tag: 'source', attribute: 'src' },
    { tag: 'track', attribute: 'src' },
    { tag: 'video', attribute: 'src' },
    { tag: 'video', attribute: 'poster' },
    { tag: 'audio', attribute: 'src' },
    { tag: 'use', attribute: 'href' },
    { tag: 'link', attribute: 'href' },
];

/** A candidate list rather than one URL, on any element that can carry one. */
const SRCSET_ATTRIBUTES = new Set(['srcset', 'imagesrcset']);

/** Schemes that make no request to another origin. */
const INERT_SCHEMES = new Set(['about:']);

/** Schemes that carry content inline where the browser would otherwise fetch it. */
const INLINE_SCHEMES = new Set(['data:', 'blob:']);

// ---------------------------------------------------------------------------------------------
// NFR-004's contrast floor, over the **static** pairs the built pages state outright.
//
// The requirement names an automated audit of the built pages; this reads each emitted page's
// light and dark cascades independently, because a palette edit can change contrast without
// touching any markup. Left to a comment, it is a claim; measured here, it is a gate.
//
// ## What this audit does not claim
//
// It is a bounded reader of declarations, not a CSS engine, and three things follow from that
// boundary — each of them refused loudly rather than skipped quietly:
//
// - **Responsive large-text classification.** Every pair below is normal text, and its floor
//   is 4.5:1. The display titles are sized in `clamp()` against the viewport, so whether one
//   of them is "large text" is a question about a rendered font size; the browser pass over
//   the rendered pages answers it with WCAG 2.2's own 18pt/14pt-bold boundary.
// - **`:focus-visible` and other pseudo-states.** A state-scoped rule paints nothing in the
//   resting state measured here (`unresolvableBackgrounds` says so), and a focus indicator's
//   contrast is a question about what the browser paints after a keystroke. The rendered pass
//   measures the focused element.
// - **Gradient pixels.** A surface that paints an image layer is refused, not approximated:
//   the colour under a translucent wash is not the colour a reader sees. `background-color`
//   plus `background-image` is the form this can read, and the rendered pass samples the
//   pixels the two together produce.
// ---------------------------------------------------------------------------------------------

/** NFR-004's floor, as WCAG 2.2 states it: 4.5:1 for body text. */
const CONTRAST_FLOOR = 4.5;

/**
 * Every surface the audit measures text on, as far as its bounded model can tell.
 *
 * `selector` is the one shape this model can place: the box the text is drawn in. A
 * **bare element name** places itself; the four structural selectors below are the ones
 * the layout paints behind text that a bare name cannot name, and each is listed here
 * because the audit refuses a background it cannot place rather than resolving it by
 * guesswork. A layout rule that paints behind a selector missing from this table fails
 * the build — which is the point: a surface nobody measured is a surface nobody read.
 *
 * `chain` is where a transparent surface falls through. `background` is not inherited in
 * CSS — the initial value is `transparent`, and a transparent box shows whatever is
 * behind it — so "the background behind this text" is a walk up the ancestor chain until
 * something opaque is declared, and that walk is the cascade, not a lookup. A chain that
 * ends without an opaque declaration means the stylesheet paints nothing at all, which
 * the audit reports rather than assumes.
 */
const CONTRAST_SURFACES = [
    { name: 'page', selectors: ['body'], chain: ['html'] },
    { name: 'the lead surface', selectors: ['main > h1 + section'], chain: ['section', 'body', 'html'] },
    // Two selectors, one surface: the title's lead paragraph and a section's first paragraph
    // are the same sunken band, declared by one rule. A surface is a *painted box*, and a
    // surface painted by a selector list is still one box.
    { name: 'the lead paragraph', selectors: ['h1 + p', 'h2 + p'], chain: ['body', 'html'] },
    { name: 'a section', selectors: ['section'], chain: ['body', 'html'] },
    { name: 'the navigation', selectors: ['nav'], chain: ['body', 'html'] },
    { name: 'the footer', selectors: ['footer'], chain: ['body', 'html'] },
    { name: 'a table caption', selectors: ['caption'], chain: ['table', 'body', 'html'] },
    { name: 'a table', selectors: ['table'], chain: ['body', 'html'] },
    { name: 'a table header', selectors: ['thead th'], chain: ['table', 'body', 'html'] },
    { name: 'a banded table row', selectors: ['tbody tr:nth-child(even)'], chain: ['table', 'body', 'html'] },
    { name: 'inline code', selectors: ['code'], chain: ['body', 'html'] },
    // `pre code` is listed as well as `pre`: it declares `transparent`, which this audit reads
    // as *paints nothing*, so it must be a selector the walk recognises or the inner `code`
    // would be an unplaceable background and the block's own colour would go unmeasured.
    { name: 'a code block', selectors: ['pre', 'pre code'], chain: ['body', 'html'] },
];

/**
 * The text/background pairs the layout can put together.
 *
 * Each pair names the **element the text sits in**, not a colour and not a token: the
 * background that element is drawn on is a fact about the cascade, and a token is not
 * one. `--surface` happens to be what the footer paints today, so a pair could name the
 * token and pass — but it would then be measuring a custom property that no rule is
 * obliged to use, which is the audit telling a story about the stylesheet rather than
 * reading it. The surface is resolved below the way a browser resolves it, so a footer
 * repainted with a literal, a `rgb()`, or nothing at all is measured on what it
 * actually sits on.
 *
 * The foreground stays a token: `:root`'s text roles are what the rules that set `color`
 * reference, so naming them is naming the site's palette rather than hard-coding its
 * values. **Each token named here is the one the layout actually paints that text in**,
 * which is why `--muted` opens the navigation (`nav a` is dim, not link-blue) and
 * `--signal` opens a table caption: a pair that named a different token would report a
 * ratio for a colour no reader ever sees.
 *
 * `--rule` is deliberately absent: it is a border colour, and NFR-004 bounds text
 * contrast — a 1px rule is not text a reader has to read. The audit prints its
 * measurements for both preference cascades.
 *
 * Every pair is **normal text**, because that is what this parser can measure: the
 * display titles are sized in `clamp()` against the viewport, so classifying them as
 * large text is a question about a rendered font size rather than a declaration this
 * audit can read. Everything below is text whose size the stylesheet states outright.
 */
const CONTRAST_PAIRS = [
    { where: 'body text on the page', foreground: '--text', surface: 'page' },
    { where: 'a link on the page', foreground: '--link', surface: 'page' },
    { where: 'muted text on the page', foreground: '--muted', surface: 'page' },
    { where: 'a generated index on the page', foreground: '--signal', surface: 'page' },
    { where: 'the lead paragraph', foreground: '--muted', surface: 'the lead paragraph' },
    { where: 'body text in a section', foreground: '--text', surface: 'a section' },
    { where: 'a link in a section', foreground: '--link', surface: 'a section' },
    { where: 'body text in the lead surface', foreground: '--hero-text', surface: 'the lead surface' },
    { where: 'a link in the lead surface', foreground: '--hero-link', surface: 'the lead surface' },
    { where: 'a navigation link', foreground: '--muted', surface: 'the navigation' },
    { where: 'the current page in the navigation', foreground: '--signal', surface: 'the navigation' },
    { where: 'body text in the footer', foreground: '--text', surface: 'the footer' },
    { where: 'a link in the footer', foreground: '--link', surface: 'the footer' },
    { where: 'a table caption on its band', foreground: '--signal', surface: 'a table caption' },
    { where: 'a table header', foreground: '--hero-text', surface: 'a table header' },
    { where: 'body text in a table', foreground: '--text', surface: 'a table' },
    { where: 'a link in a table', foreground: '--link', surface: 'a table' },
    { where: 'body text in a banded table row', foreground: '--text', surface: 'a banded table row' },
    { where: 'inline code on its chip', foreground: '--text', surface: 'inline code' },
    { where: 'a code block', foreground: '--text', surface: 'a code block' },
];

/**
 * The tokens every pair above reads. Asserted **present** rather than assumed, because an
 * audit that reports nothing about a page whose palette it failed to find is the exact shape
 * of gate this file exists to refuse: a green check that measured nothing.
 */
const REQUIRED_PALETTE = [
    '--text',
    '--muted',
    '--link',
    '--signal',
    '--hero-text',
    '--hero-link',
    '--page',
    '--surface',
    '--elevated',
    '--code',
    '--hero',
    '--table-head',
];

/**
 * How many `var(--x)` hops a declared colour may take before the audit calls it unreadable.
 *
 * The shipped palette resolves in one; the bound exists so a self-referential or circular
 * declaration fails loudly rather than spinning.
 */
const MAX_COLOUR_HOPS = 4;

/**
 * A background value that paints nothing, so the element behind it shows through.
 *
 * `transparent` is the initial value and the one this site could plausibly write; `none` is
 * the other half of the same idea, and both mean the walk goes up the chain rather than
 * stopping on a colour nobody can see text against.
 */
const SEE_THROUGH_BACKGROUNDS = new Set(['transparent', 'none']);

/**
 * The `background` shorthand values that paint an **image** rather than a colour.
 *
 * An image is pixels, and this audit reads declarations rather than pixels: it resolves the
 * colour each measured surface paints and has no answer for a gradient between two colours.
 * So an image layer is refused rather than approximated — the browser pass over the rendered
 * pages measures those pixels, and this file's job is to be honest about the difference.
 */
const BACKGROUND_IMAGES = ['linear-gradient(', 'radial-gradient(', 'conic-gradient(', 'repeating-linear-gradient(', 'repeating-radial-gradient(', 'repeating-conic-gradient(', 'image-set(', 'cross-fade(', 'url('];

// ---------------------------------------------------------------------------------------------
// Reading the site's own configuration. The base path and the canonical origin are declared in
// exactly one place (FR-005, AC-002), and copying either into this script would make it the second
// copy — reintroducing the rename bug inside the gate that exists to catch it. So both are parsed
// out of astro.config.ts, and a shape this script cannot read is a hard error rather than a silent
// fallback.
// ---------------------------------------------------------------------------------------------

/**
 * @returns {{ base: string, origin: string }} The declared base path, without a trailing slash, and
 *   the canonical origin it is published under.
 */
function readDeclaredSite() {
    const config = readFileSync(join(SITE_ROOT, 'astro.config.ts'), 'utf8');
    const base = /^\s*base:\s*'([^']+)'/m.exec(config);
    const origin = /^\s*site:\s*'([^']+)'/m.exec(config);
    const unreadable = [
        base ? undefined : "`base: '…'`",
        origin ? undefined : "`site: '…'`",
    ].filter((missing) => missing !== undefined);
    if (unreadable.length > 0) {
        throw new Error(
            `assert-build: ${unreadable.join(' and ')} not found in astro.config.ts. This script reads the ` +
                "site's base path and canonical origin from there, because AC-002 declares the base in " +
                'exactly one file, and it will not guess either one.',
        );
    }
    return {
        base: base[1].replace(/\/+$/, ''),
        origin: new URL(origin[1]).origin,
    };
}

// ---------------------------------------------------------------------------------------------
// HTML reading. The Node standard library has no DOM parser and a dependency would make the site's
// only gate depend on an install; the emitted HTML is flat and minified, so a tolerant tag scanner
// sees every attribute these checks need.
// ---------------------------------------------------------------------------------------------

/**
 * Parse an element's attribute text into a lower-cased name → value map. Handles quoted,
 * single-quoted, and bare values, and treats a valueless attribute as an empty string.
 *
 * @param {string} raw The text between an element's name and its closing `>`.
 * @returns {Map<string, string>} Attribute values, by lower-cased name.
 */
function readAttributes(raw) {
    const found = new Map();
    const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
    for (const match of raw.matchAll(pattern)) {
        found.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    return found;
}

/**
 * Every element in a document, in document order. Quoted attribute runs are matched whole, so a `>`
 * inside a value does not end the tag early.
 *
 * @param {string} html A page's markup.
 * @returns {Array<{ name: string, attributes: Map<string, string>, index: number }>}
 */
function readElements(html) {
    const elements = [];
    const pattern = /<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    for (const match of html.matchAll(pattern)) {
        elements.push({
            name: match[1].toLowerCase(),
            attributes: readAttributes(match[2]),
            index: match.index,
        });
    }
    return elements;
}

/**
 * @param {string} html A page's markup.
 * @returns {Array<string>} Every `<a href>` target on the page, in document order.
 */
function readLinkTargets(html) {
    return [...html.matchAll(/<a\s[^>]*href=(?:"([^"]*)"|'([^']*)')/gi)].map((match) => match[1] ?? match[2] ?? '');
}

/**
 * Classify a reference, resolving a relative one against the address of the page it appears on.
 *
 * A relative reference resolves onto the site's own origin, so it comes back same-origin; an
 * absolute one keeps whatever host it names. That is what separates "this page links into the site"
 * from "this page points somewhere else", without a host allow-list that a rename would break.
 *
 * @param {string} raw The attribute value as authored.
 * @param {string} pageAddress The page's own published address, including the base path.
 * @param {string} origin The site's canonical origin.
 * @returns {{ kind: string, pathname: string, detail: string }} `kind` is one of `same-document`,
 *   `same-origin`, `off-origin`, or `unusable`; `detail` says why when the reference is not usable.
 */
function classify(raw, pageAddress, origin) {
    const value = raw.trim();
    const unusable = (detail) => ({ kind: 'unusable', pathname: '', detail });
    if (value === '') {
        return unusable('the value is empty');
    }
    if (value.startsWith('#')) {
        return { kind: 'same-document', pathname: '', detail: '' };
    }
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value)?.[1]?.toLowerCase();
    if (scheme !== undefined && INERT_SCHEMES.has(`${scheme}:`)) {
        return { kind: 'same-document', pathname: '', detail: '' };
    }
    if (scheme !== undefined && INLINE_SCHEMES.has(`${scheme}:`)) {
        return unusable(
            `an inline \`${scheme}:\` reference carries content in the page instead of naming a file, ` +
                'and the only thing this site would inline is an image or a script (FR-009, NFR-002)',
        );
    }
    if (scheme === 'javascript') {
        return unusable('a `javascript:` URL is client-side scripting, which NFR-002 forbids outright');
    }
    let resolved;
    try {
        resolved = new URL(value, `${origin}${pageAddress}`);
    } catch {
        return unusable(`\`${value}\` is not a resolvable URL`);
    }
    const sameOrigin = resolved.origin === origin;
    return {
        kind: sameOrigin && (resolved.protocol === 'http:' || resolved.protocol === 'https:') ? 'same-origin' : 'off-origin',
        pathname: resolved.pathname,
        detail: sameOrigin ? '' : `it points at ${resolved.origin}`,
    };
}

/**
 * Locate a resolved path under the site's own output.
 *
 * @param {string} pathname The resolved path.
 * @param {string} base The declared base path, without a trailing slash.
 * @returns {{ underBase: boolean, directoryForm: boolean, file: string }} `file` is the path it would
 *   have to name inside `dist/`, or the empty string when it is not under the base at all.
 */
function locateInOutput(pathname, base) {
    const underBase = pathname === base || pathname.startsWith(`${base}/`);
    if (!underBase) {
        return { underBase: false, directoryForm: false, file: '' };
    }
    const below = pathname.slice(base.length).replace(/^\/+/, '');
    return {
        underBase: true,
        directoryForm: pathname.endsWith('/'),
        file: below === '' ? 'index.html' : below.endsWith('/') ? `${below}index.html` : below,
    };
}

/**
 * One selector as the audit compares it.
 *
 * The built stylesheet is minified, and the minifier rewrites more than whitespace:
 *
 * - `main > h1 + section` arrives as `main>h1+section`, so combinator spacing is removed;
 * - `tbody tr:nth-child(even)` arrives as `tbody tr:nth-child(2n)`, because `even` is the
 *   keyword spelling of the `2n` progression with no offset.
 *
 * That second rewrite is the one that could have gone quietly wrong. A surface named in the
 * `even` spelling would simply stop matching, the walk would fall through to the next ancestor,
 * and the pair would be reported against a **lighter** colour than the one actually painted —
 * an inflated ratio on a real build rather than a failure. `CONTRAST_SURFACES` is written in
 * the readable keyword form, so both spellings are normalised to it here.
 *
 * @param {string} selector One selector as authored or as minified.
 * @returns {string} Its normalised spelling.
 */
function normaliseSelector(selector) {
    return selector
        .trim()
        .toLowerCase()
        .replace(/\s*([>+~])\s*/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/nth-child\(2n\)/g, 'nth-child(even)');
}

/**
 * The colours and rules one page's inlined stylesheet declares.
 *
 * Read out of the **built** page rather than out of `src/layout.astro`, because the
 * requirement's own verification is *"an automated audit of the built pages"* — and because a
 * page that carried a `<style>` of its own would then be audited on its palette too, rather
 * than inheriting the layout's by assumption.
 *
 * The requested `prefers-color-scheme` block is activated and other such blocks are excluded
 * before reading. `unconditional` records whether another at-rule paints a background: a
 * viewport-dependent surface is one whose contrast this audit cannot decide, so it is refused.
 *
 * @param {string} css Every `<style>` body on the page, concatenated.
 * @param {'light' | 'dark'} scheme The preference whose cascade is being read.
 * @returns {{ tokens: Map<string, string>, rules: Array<{ selectors: string[], body: string }>, unconditional: boolean, hasDarkPreference: boolean }}
 *   The active palette's custom properties and rules, whether non-scheme conditional backgrounds
 *   are absent, and whether the stylesheet declares a dark preference.
 */
function readPalette(css, scheme) {
    const preference = splitPreferenceRules(css, scheme);
    const activeCss = `${preference.base}\n${preference.active.join('\n')}`;
    const tokens = new Map();
    const rules = [];
    for (const block of activeCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = (block[1] ?? '')
            .split(',')
            .map((selector) => normaliseSelector(selector))
            .filter((selector) => selector !== '');
        if (selectors.length > 0) {
            rules.push({ selectors, body: block[2] ?? '' });
        }
    }
    for (const rule of rules) {
        // Later declarations win, which is the cascade: a page's second `:root` overrides
        // the first, exactly as a browser resolves it.
        for (const declared of rule.body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) {
            tokens.set((declared[1] ?? '').toLowerCase(), (declared[2] ?? '').trim());
        }
    }

    return {
        tokens,
        rules,
        unconditional: !atRulePaintsABackground(preference.base),
        hasDarkPreference: preference.hasDarkPreference,
    };
}

/**
 * Separate color-scheme media rules from the unconditional stylesheet and activate only the
 * requested preference. This lets the audit resolve the browser's two cascades independently
 * without treating a dark-only background as an unknown viewport-dependent surface.
 *
 * @param {string} css Every `<style>` body on the page.
 * @param {'light' | 'dark'} scheme The preference whose cascade is being read.
 * @returns {{ base: string, active: string[], hasDarkPreference: boolean }}
 */
function splitPreferenceRules(css, scheme) {
    const source = css.replaceAll(/\/\*[\s\S]*?\*\//g, ' ');
    const media = /@media\s*\(([^{}]*prefers-color-scheme\s*:\s*(dark|light)[^{}]*)\)\s*\{/gi;
    const removed = [];
    const active = [];
    let hasDarkPreference = false;

    for (const match of source.matchAll(media)) {
        const opening = (match.index ?? 0) + match[0].length - 1;
        const closing = matchingBrace(source, opening);
        const preference = (match[2] ?? '').toLowerCase();
        if (preference === 'dark') {
            hasDarkPreference = true;
        }
        if (preference === scheme) {
            active.push(source.slice(opening + 1, closing));
        }
        removed.push([match.index ?? 0, closing + 1]);
    }

    let cursor = 0;
    const base = [];
    for (const [start, end] of removed) {
        base.push(source.slice(cursor, start));
        cursor = end;
    }
    base.push(source.slice(cursor));

    return { base: base.join(''), active, hasDarkPreference };
}

/**
 * Find a block's matching closing brace, accounting for nested CSS rules.
 *
 * @param {string} css Stylesheet source.
 * @param {number} opening Index of the opening brace.
 * @returns {number} Index of the matching closing brace, or the final source character.
 */
function matchingBrace(css, opening) {
    let depth = 1;
    for (let index = opening + 1; index < css.length; index += 1) {
        if (css[index] === '{') {
            depth += 1;
        } else if (css[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }

    return css.length - 1;
}

/**
 * Whether any remaining at-rule block — `@media`, `@supports` — declares a background.
 *
 * A background that only applies inside a query is a background the audit cannot resolve:
 * whether it paints depends on a viewport it does not know, and reading the rule as though
 * it were unconditional is the false *accept* this file exists to refuse. The check is a
 * finding rather than a skip for that reason. Braces are counted so a nested block does not
 * end the walk early.
 *
 * @param {string} css Every `<style>` body on the page, concatenated.
 * @returns {boolean} Whether a conditional block declares a background.
 */
function atRulePaintsABackground(css) {
    for (const opening of css.matchAll(/@[a-z-]+[^{]*\{/gi)) {
        let depth = 1;
        let at = opening.index + opening[0].length;
        while (at < css.length && depth > 0) {
            if (css[at] === '{') {
                depth += 1;
            } else if (css[at] === '}') {
                depth -= 1;
            }
            at += 1;
        }
        if (readPaintedBackground(css.slice(opening.index + opening[0].length, at - 1)).paints) {
            return true;
        }
    }

    return false;
}

/**
 * Split a shorthand value into its top-level layers, so a comma inside `rgba()` or inside a
 * gradient's own arguments does not read as two layers.
 *
 * @param {string} value A shorthand value as written.
 * @returns {string[]} Every layer, in source order.
 */
function splitBackgroundLayers(value) {
    const layers = [];
    let depth = 0;
    let buffer = '';
    for (const char of value) {
        if (char === '(') {
            depth += 1;
        } else if (char === ')') {
            depth = Math.max(depth - 1, 0);
        }
        if (char === ',' && depth === 0) {
            layers.push(buffer.trim());
            buffer = '';
            continue;
        }
        buffer += char;
    }
    if (buffer.trim() !== '') {
        layers.push(buffer.trim());
    }

    return layers;
}

/**
 * What one rule body paints behind itself: a colour, nothing, or something this audit
 * cannot read.
 *
 * Both spellings of the property are read, and the **last** of them wins, which is the
 * cascade: a `background-color` written after a `background` shorthand overrides the
 * shorthand's own colour component, and one written before it is reset by it.
 *
 * The one form refused is a shorthand carrying more than one layer. Such a rule paints
 * images over a colour — a gradient with a colour under it — and reading the bottom layer
 * as *the* background would be measuring a colour the reader never sees. It is reported
 * with the declaration to write instead, because "declare the colour as
 * `background-color` and the decoration as `background-image`" is both true CSS and a form
 * this audit can read: an image layer paints no colour at all, so a surface that declares
 * only one genuinely falls through to what is behind it.
 *
 * @param {string} body One rule's declarations.
 * @returns {{ paints: boolean, value: string, problem: string }} Whether the rule paints an
 *   opaque colour, the value it is (or `''` when it paints none), and what stopped the audit
 *   from reading one when it paints something it cannot measure.
 */
function readPaintedBackground(body) {
    const declarations = [...body.matchAll(/(?<![-\w])(background-color|background)\s*:\s*([^;}]+)/gi)]
        .map((found) => ({
            shorthand: (found[1] ?? '').toLowerCase() === 'background',
            value: (found[2] ?? '').trim(),
        }))
        .filter((declaration) => declaration.value !== '');
    const last = declarations.at(-1);
    if (last === undefined) {
        return { paints: false, value: '', problem: '' };
    }
    if (!last.shorthand) {
        return {
            paints: !SEE_THROUGH_BACKGROUNDS.has(last.value.toLowerCase()),
            value: last.value,
            problem: '',
        };
    }

    const layers = splitBackgroundLayers(last.value);
    if (layers.length > 1) {
        return {
            paints: true,
            value: '',
            problem: `\`background: ${last.value}\` declares ${layers.length} layers, so the colour a reader ` +
                'sees is the last one seen through the first',
        };
    }
    const only = layers[0] ?? '';
    const image = BACKGROUND_IMAGES.find((candidate) => only.toLowerCase().startsWith(candidate));
    if (image !== undefined) {
        return {
            paints: true,
            value: '',
            problem: `\`background: ${last.value}\` paints an image layer, which this audit cannot read as a ` +
                'colour',
        };
    }

    return { paints: !SEE_THROUGH_BACKGROUNDS.has(only.toLowerCase()), value: only, problem: '' };
}

/**
 * The colour the text on one surface is actually drawn on, resolved the way a browser
 * resolves it: this element's own declaration, or — when it declares none, or declares one
 * that paints nothing — the nearest ancestor's.
 *
 * Each link in the walk is either the surface's own selector (a bare element name, or one
 * of the structural selectors `CONTRAST_SURFACES` enumerates) or a bare ancestor name. A
 * background behind a selector outside that set is not resolved here:
 * `unresolvableBackgrounds` names it and the audit fails, because a background it cannot
 * place is a background nobody measured.
 *
 * @param {Array<{ selectors: string[], body: string }>} rules Every rule, in source order.
 * @param {string} surface The surface's name, as `CONTRAST_SURFACES` spells it.
 * @returns {{ declared: string, from: string, problem: string }} The winning declaration, the
 *   selector that made it, and what stopped the audit from reading it when it painted
 *   something unmeasurable.
 */
function paintBackground(rules, surface) {
    const definition = CONTRAST_SURFACES.find((candidate) => candidate.name === surface);
    if (definition === undefined) {
        return { declared: '', from: '', problem: `\`${surface}\` is not a surface this audit reads` };
    }

    for (const candidate of [...definition.selectors.flat(), ...definition.chain].map(normaliseSelector)) {
        // The last rule that **declares a background** wins, which is the cascade within the
        // walk. A later rule that only sets a padding does not reset an earlier background —
        // that is why this filters to rules that declare one and takes the last of those, rather
        // than taking the last matching rule and then finding nothing in it.
        const winner = rules
            .filter((rule) => rule.selectors.includes(candidate) && readPaintedBackground(rule.body).paints)
            .at(-1);
        if (winner === undefined) {
            continue;
        }
        const painted = readPaintedBackground(winner.body);
        return { declared: painted.value, from: candidate, problem: painted.problem };
    }

    return { declared: '', from: '', problem: '' };
}

/**
 * Every background declaration this audit cannot place, named.
 *
 * A rule may paint behind a bare element name, or behind one of the selectors
 * `CONTRAST_SURFACES` enumerates, to be read. Two kinds of rule sit outside that model, and
 * they are named for opposite reasons:
 *
 * - a selector the model does not know (`.card`, `html[dir='rtl']`, `main p`) paints behind
 *   a box this audit cannot identify, and resolving it as absent would report the inherited
 *   surface for text that is not drawn on it;
 * - a **state- or pseudo-element-scoped** rule (`:hover`, `:focus-visible`, `::before`,
 *   `::after`) paints nothing in the resting state this audit measures. It is left out of
 *   the model deliberately and written down here, because the browser pass over the rendered
 *   pages is what exercises a hover or focus surface and a reader should know which half of
 *   the evidence covers them. *State* means the interaction states only: `:first-child`,
 *   `:nth-child(…)`, `:checked` and `:disabled` all hold while the page sits still, so a
 *   background behind one paints in the state this audit measures and is refused like any
 *   other unplaceable selector rather than skipped.
 *
 * @param {Array<{ selectors: string[], body: string }>} rules Every rule, in source order.
 * @returns {string[]} One line per unplaceable selector, for the failure message.
 */
function unresolvableBackgrounds(rules) {
    const placed = new Set(
    CONTRAST_SURFACES.flatMap((surface) => [...surface.selectors.flat(), ...surface.chain]).map(normaliseSelector),
);
    /*
     * Pseudo-elements — `::x`, and the legacy `:before`/`:after` spelling the minifier ships —
     * generate boxes this audit does not read text out of, and the four interaction states do not
     * hold at rest. Everything else is refused. The state name must also be outside a `:not(…)`,
     * since `a:not(:hover)` *is* the link's resting state; a `(` in front of it is what that
     * looks like in a selector.
     */
    const isScopedToAState = (selector) =>
        /::|:(?:before|after|first-line|first-letter)\b|(?:^|[^:(]):(?:hover|focus|active|visited)\b/.test(selector);
    const unreadable = [];
    for (const rule of rules) {
        if (!readPaintedBackground(rule.body).paints) {
            continue;
        }
        for (const selector of rule.selectors) {
            if (placed.has(selector) || isScopedToAState(selector) || /^[a-z][a-z0-9]*$/.test(selector)) {
                continue;
            }
            unreadable.push(selector);
        }
    }

    return unreadable;
}

/**
 * Follow a declared colour through `var(--x)` references to the value at the end of it.
 *
 * @param {string} value A colour as declared, possibly `var(--name)`.
 * @param {Map<string, string>} tokens The page's declared custom properties.
 * @returns {string} The colour as written, with references resolved; unchanged when the chain
 *   does not end within `MAX_COLOUR_HOPS`, which `assertContrast` then reports as unreadable.
 */
function resolveColour(value, tokens) {
    let resolved = value;
    for (let hop = 0; hop < MAX_COLOUR_HOPS; hop += 1) {
        const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(resolved);
        if (reference === null) {
            return resolved;
        }
        const next = tokens.get((reference[1] ?? '').toLowerCase());
        if (next === undefined) {
            return resolved;
        }
        resolved = next;
    }

    return resolved;
}

/**
 * A `#rgb` or `#rrggbb` colour as its three channels.
 *
 * Anything else is `null` rather than a guess. `rgb()`, `hsl()`, and colour keywords are all
 * valid CSS and none of them is in this site's palette; a gate that skipped what it could not
 * read would report a passing page for a colour it never looked at, so the unreadable shape
 * is a hard failure that names the value and says what to write instead.
 *
 * @param {string} value A colour as declared.
 * @returns {{ r: number, g: number, b: number } | null} Its channels, each 0–255.
 */
function parseColour(value) {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim());
    if (hex === null) {
        return null;
    }
    const digits = hex[1] ?? '';
    const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits;

    return {
        r: Number.parseInt(full.slice(0, 2), 16),
        g: Number.parseInt(full.slice(2, 4), 16),
        b: Number.parseInt(full.slice(4, 6), 16),
    };
}

/**
 * One channel's linear-light value, per WCAG 2.2's definition of relative luminance.
 *
 * @param {number} channel One channel, 0–255.
 * @returns {number} Its linear-light value, 0–1.
 */
function linearise(channel) {
    const proportion = channel / 255;

    return proportion <= 0.039_28 ? proportion / 12.92 : ((proportion + 0.055) / 1.055) ** 2.4;
}

/**
 * A colour's relative luminance.
 *
 * @param {{ r: number, g: number, b: number }} colour The colour's channels.
 * @returns {number} Its relative luminance, 0–1.
 */
function luminance(colour) {
    return 0.2126 * linearise(colour.r) + 0.7152 * linearise(colour.g) + 0.0722 * linearise(colour.b);
}

/**
 * The contrast ratio between two colours, as WCAG 2.2 states it.
 *
 * @param {{ r: number, g: number, b: number }} foreground The text's colour.
 * @param {{ r: number, g: number, b: number }} background What it is drawn on.
 * @returns {number} Their ratio, from 1 (identical) to 21 (black on white).
 */
function contrastRatio(foreground, background) {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));

    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * NFR-004's contrast floor, audited over the colours a page's stylesheet resolves to.
 *
 * Five assertions beyond the floor itself, and each of them is the one that keeps the next
 * honest: the tokens the pairs name must be declared, both preference palettes must exist and
 * select their own `color-scheme`, every background must be placeable, every surface must
 * resolve to a colour at all, and every colour must be one this audit can read. An audit that
 * finds no palette, or cannot tell which box a background paints, or walks off the end of a
 * chain, or meets a gradient it cannot resolve, reports no failures for a page whose text
 * colour it never looked at — and a green check that measured nothing is the exact shape of
 * gate this file exists to refuse.
 *
 * @param {string} where The emitted file, for the message.
 * @param {string} css Every `<style>` body on the page, concatenated.
 * @param {'light' | 'dark'} scheme The preference whose contrast is being measured.
 * @returns {Array<{ where: string, foreground: string, background: string, ratio: number }>}
 *   Every pair the audit measured, for the ledger the run prints.
 */
function assertContrast(where, css, scheme) {
    const { tokens, rules, unconditional, hasDarkPreference } = readPalette(css, scheme);
    const measured = [];
    const here = `${where} (${scheme} preference)`;

    for (const required of REQUIRED_PALETTE) {
        assert(
            'NFR-004 the declared text colours are audited',
            tokens.has(required),
            `${here}: the active cascade declares no \`${required}\`, so NFR-004's contrast floor was ` +
                'measured against nothing for the pairs that read it. The layout declares its palette in ' +
                '`:root` and the audit reads it from the built page; deleting a token has to fail here ' +
                'rather than turn the audit off.',
        );
    }
    assert(
        'AC-032 both preference palettes are declared',
        hasDarkPreference,
        `${where}: no built \`prefers-color-scheme: dark\` rules were found, so the dark palette could not be audited. ` +
            'Declare a site-owned dark palette in the emitted stylesheet.',
    );
    const rootColorSchemes = rules
        .filter((rule) => rule.selectors.includes(':root'))
        .map((rule) => /(?:^|;)\s*color-scheme\s*:\s*([^;}]+)/i.exec(rule.body)?.[1]?.trim())
        .filter((value) => value !== undefined);
    assert(
        'AC-032 each preference selects its matching color scheme',
        rootColorSchemes.at(-1) === scheme,
        `${where}: the ${scheme} preference resolves root \`color-scheme\` to ` +
            `\`${rootColorSchemes.at(-1) ?? 'nothing'}\`, not \`${scheme}\`. Declare the matching scheme in the built CSS.`,
    );
    assert(
        'NFR-004 the declared text colours are audited',
        unconditional,
        `${here}: a rule inside an at-rule block declares a background, and whether it paints depends on ` +
            'a viewport this audit does not know — a background it cannot resolve is a background nobody ' +
            'measured. Paint unconditional backgrounds, or narrow the pairs this audit reads.',
    );
    const unplaceable = unresolvableBackgrounds(rules);
    assert(
        'NFR-004 the declared text colours are audited',
        unplaceable.length === 0,
        `${here}: ${unplaceable.map((selector) => `\`${selector}\``).join(', ')} paint a background behind a ` +
            'selector this audit cannot place, so it cannot tell which box the text is drawn in and would ' +
            'measure it against the inherited surface instead. Add the selector to `CONTRAST_SURFACES` if it ' +
            `is a real surface, or paint it behind a bare element name. The surfaces read are ` +
            `\`${[...new Set(CONTRAST_PAIRS.map((pair) => pair.surface))].join('`, `')}\`.`,
    );
    // Non-vacuity for the cascade itself: a walk that ends on nothing means the stylesheet paints
    // no surface at all, and an audit that then measured nothing would still exit zero. Checked
    // once per surface rather than per pair, and reported as the stylesheet finding it is.
    for (const name of [...new Set(CONTRAST_PAIRS.map((pair) => pair.surface))]) {
        const definition = CONTRAST_SURFACES.find((candidate) => candidate.name === name);
        const resolved = paintBackground(rules, name);
        assert(
            'NFR-004 the declared text colours are audited',
            resolved.declared !== '',
            `${here}: nothing in \`${[...(definition?.selectors.flat() ?? []), ...(definition?.chain ?? [])].join('` → `')}\` ` +
                `declares a background, so there is nothing for NFR-004's contrast floor to measure ${name} ` +
                'against. `background` is transparent by default, so a stylesheet that declares none paints ' +
                'the canvas — which this audit does not read, because the canvas colour is a browser default ' +
                'rather than something the page states.',
        );
    }

    for (const pair of CONTRAST_PAIRS) {
        const surface = paintBackground(rules, pair.surface);
        const foregroundRaw = resolveColour(tokens.get(pair.foreground) ?? '', tokens);
        const backgroundRaw = resolveColour(surface.declared, tokens);
        const foreground = parseColour(foregroundRaw);
        const background = parseColour(backgroundRaw);
        const id = 'NFR-004 the declared text colours clear 4.5:1';

        if (surface.problem !== '') {
            assert(
                id,
                false,
                `${here}: the background behind ${pair.where} is one this audit cannot read: ` +
                    `${surface.problem}. Declare the colour as \`background-color\` and any decoration as ` +
                    '`background-image`; a rendered gradient is measured against its actual pixels by the ' +
                    "browser pass over the built pages, not by this one.",
            );
            continue;
        }
        if (foreground === null) {
            assert(
                id,
                false,
                `${here}: ${pair.where} is \`${foregroundRaw}\`, which this audit cannot read. NFR-004's floor ` +
                    'is measured over `#rgb` and `#rrggbb`, and a colour in a form the audit cannot parse is ' +
                    'a colour nobody measured — write it as a hex literal.',
            );
            continue;
        }
        if (background === null) {
            assert(
                id,
                false,
                `${here}: the background behind ${pair.where} is \`${backgroundRaw}\`, which this audit cannot ` +
                    `read. It resolved from \`${pair.surface}\`${surface.from === '' ? '' : ` through \`${surface.from}\``} ` +
                    'and no value up that walk is a hex literal; declare one the audit can measure, or write ' +
                    'the colour as `#rgb`/`#rrggbb`.',
            );
            continue;
        }
        const ratio = contrastRatio(foreground, background);
        measured.push({ where: `${scheme} ${pair.where}`, foreground: foregroundRaw, background: backgroundRaw, ratio });
        assert(
            id,
            ratio >= CONTRAST_FLOOR,
            `${here}: ${pair.where} is \`${foregroundRaw}\` on \`${backgroundRaw}\`, a contrast ratio of ` +
                `${ratio.toFixed(2)}:1 — NFR-004 requires at least ${CONTRAST_FLOOR}:1 for normal text. ` +
                'Darken the foreground or lighten the background; every other pair on the page is measured ' +
                'the same way.',
        );
    }

    return measured;
}

/**
 * An element's opening tag as written, so a failure quotes the markup it refused
 * rather than a reconstruction of the one attribute that mattered.
 *
 * @param {{ name: string, attributes: Map<string, string> }} element The element.
 * @returns {string} Its opening tag.
 */
function openingTag(element) {
    const attributes = [...element.attributes].map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${value}"`));
    return `<${element.name}${attributes.join('')}>`;
}

/**
 * @param {string} file A `/`-separated path.
 * @returns {string} The lower-cased extension including the dot, or the empty string.
 */
function extensionOf(file) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Every file under a directory, as `/`-separated paths relative to it.
 *
 * @param {string} root The directory to walk.
 * @returns {string[]} Sorted, so two runs report a difference in the same order.
 */
function listFiles(root) {
    const found = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                walk(path);
            } else {
                found.push(relative(root, path).split(/[\\/]/).join('/'));
            }
        }
    };
    walk(root);
    return found.sort();
}

// ---------------------------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------------------------

const failures = [];
let checks = 0;

/**
 * Record one assertion. Nothing is thrown and nothing exits early, because a gate that stops at the
 * first failure costs a contributor a build per finding.
 *
 * @param {string} id The requirement the assertion discharges, so a failure says which rule broke.
 * @param {boolean} held Whether the assertion held.
 * @param {string} message What is wrong, naming the file and the markup or path.
 */
function assert(id, held, message) {
    checks += 1;
    if (!held) {
        failures.push(`FAIL [${id}] ${message}`);
    }
}

/**
 * The shape of the output itself: the exact file set, and no script and no image file anywhere.
 *
 * AC-001's "no further page" and NFR-002's "the built output contains no script file" are the same
 * measurement read two ways, and both are reported by name so a failure says which rule broke.
 *
 * @param {string[]} emitted Every emitted file, relative to `dist/`.
 */
function assertTheOutputShape(emitted) {
    const expected = PAGES.map((page) => page.file);
    const present = new Set(emitted);

    for (const page of PAGES.filter((candidate) => !present.has(candidate.file))) {
        assert(
            'AC-001 the five pages, and no further page',
            false,
            `dist/${page.file} was not emitted — ${page.label} is one of the five pages AC-001 names, and ` +
                'the site publishes no page at any other address.',
        );
    }
    for (const file of emitted.filter((candidate) => !expected.includes(candidate))) {
        assert(
            'AC-001 the five pages, and no further page',
            false,
            `dist/${file} was emitted and the contract names no such file — AC-001 publishes exactly five ` +
                'pages, and the contract admits no 404.html, no _astro/ directory, no sitemap, no ' +
                'robots.txt and no web manifest.',
        );
    }
    for (const file of emitted.filter((candidate) => SCRIPT_EXTENSIONS.has(extensionOf(candidate)))) {
        assert(
            'NFR-002 no script file',
            false,
            `dist/${file} is a script file — NFR-002: no page ships JavaScript, and the built output is ` +
                'where that is proved. A <script> element or a client directive in a source introduced it.',
        );
    }
    for (const file of emitted.filter((candidate) => IMAGE_EXTENSIONS.has(extensionOf(candidate)))) {
        assert(
            'AC-004 no image file',
            false,
            `dist/${file} is an image file — FR-009 and AC-004 admit no image of any kind, including a ` +
                'self-hosted favicon. A file in public/ is copied to the output verbatim.',
        );
    }
}

/**
 * Check one page's markup.
 *
 * @param {{ address: string, label: string, file: string }} page The page, with its published address.
 * @param {string} html The page's markup.
 * @param {string} base The declared base path.
 * @param {string} origin The site's canonical origin.
 * @param {Set<string>} emitted The emitted files, as a set of `dist/`-relative paths.
 * @returns {Array<{ where: string, foreground: string, background: string, ratio: number }>}
 *   The contrast pairs NFR-004's audit measured on this page, for the ledger the run prints.
 */
function assertThePage(page, html, base, origin, emitted) {
    const where = `dist/${page.file}`;
    const pageAddress = `${base}${page.address}`;
    const elements = readElements(html);

    const manualThemeControl = [...html.matchAll(/<(?:button|select)\b([^>]*)>([\s\S]*?)<\/(?:button|select)\s*>|<input\b([^>]*)>/gi)].find(
        (control) => /\b(theme|appearance|dark mode|light mode)\b/i.test(`${control[1] ?? ''} ${control[2] ?? ''} ${control[3] ?? ''}`.replace(/<[^>]*>/g, ' ')),
    );
    assert(
        'AC-032 no manual theme toggle',
        manualThemeControl === undefined,
        `${where}: a manual theme control was emitted; FR-079 requires CSS-only preference matching with no toggle.`,
    );

    // NFR-002, in the three shapes client-side scripting can take.
    for (const element of elements.filter((candidate) => candidate.name === 'script')) {
        assert(
            'NFR-002 no script element',
            false,
            `${where}: a <script> element — NFR-002 says no page ships JavaScript, and nothing on this ` +
                'site has an interactive component that would need one.',
        );
    }
    for (const element of elements) {
        for (const [name] of element.attributes) {
            if (/^on[a-z]+$/.test(name)) {
                assert(
                    'NFR-002 no event-handler attribute',
                    false,
                    `${where}: ${openingTag(element)} — the \`${name}\` attribute is client-side scripting, ` +
                        'and NFR-002 admits none.',
                );
            }
        }
    }

    // FR-009 and AC-004: nothing in the markup that renders an image.
    for (const element of elements.filter((candidate) => candidate.name === 'img' || candidate.name === 'image')) {
        assert(
            'AC-004 no image',
            false,
            `${where}: ${openingTag(element)} — FR-009 admits no image of any kind and AC-004 asserts the ` +
                'built output contains none. Describe it in words instead.',
        );
    }

    // FR-010 and NFR-003: no resource reference leaves the site, and none is base-less.
    for (const element of elements) {
        for (const position of RESOURCE_POSITIONS) {
            if (element.name !== position.tag || !element.attributes.has(position.attribute)) {
                continue;
            }
            assertResourceReference(where, pageAddress, base, origin, emitted, element, position.attribute);
        }
        for (const attribute of element.attributes.keys()) {
            if (!SRCSET_ATTRIBUTES.has(attribute)) {
                continue;
            }
            for (const candidate of readSrcset(element.attributes.get(attribute) ?? '')) {
                assertResourceReference(where, pageAddress, base, origin, emitted, element, attribute, candidate, 'candidate');
            }
        }
        // A `style` attribute is a stylesheet body, so it is read as one: this is what
        // catches `style="background:url(https://cdn.example/a.gif)"`, which no entry in
        // RESOURCE_POSITIONS can see because the URL is not the attribute's whole value.
        if (element.attributes.has('style')) {
            assertInlineStylesheet(
                `${where}: ${openingTag(element)} \`style\` attribute`,
                element.attributes.get('style') ?? '',
                origin,
            );
        }
    }

    // FR-010 and NFR-003: a meta refresh is the one navigation a page performs with no
    // reader's click in it, which makes it a reference the page itself makes — the shape
    // NFR-003 forbids, not the shape it exempts (`<a href>`, a hyperlink the reader may
    // choose to follow). Treated as a resource reference rather than ignored; see
    // `readRefreshTarget` for why it cannot be read as a bare `content` value.
    for (const element of elements) {
        const equiv = (element.attributes.get('http-equiv') ?? '').trim().toLowerCase();
        if (element.name !== 'meta' || equiv !== 'refresh') {
            continue;
        }
        const target = readRefreshTarget(element.attributes.get('content') ?? '');
        if (target === '') {
            continue;
        }
        assertResourceReference(where, pageAddress, base, origin, emitted, element, 'content', target, 'navigates to');
    }

    // FR-010: an inline stylesheet cannot reach off-origin either, and there is no stylesheet at all.
    const stylesheets = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
    for (const block of stylesheets) {
        assertInlineStylesheet(`${where}: <style>`, block[1], origin);
    }

    // NFR-004's other half: both independently selected palettes, over this built page.
    const css = stylesheets.map((block) => block[1]).join('\n');
    const contrast = ['light', 'dark'].flatMap((scheme) => assertContrast(where, css, scheme));

    // AC-002 and AC-003: every internal link resolves to a page the build actually emitted.
    const reachable = new Set();
    for (const raw of readLinkTargets(html)) {
        const classified = classify(raw, pageAddress, origin);
        if (classified.kind === 'same-document') {
            continue;
        }
        if (classified.kind === 'off-origin') {
            // A hyperlink a reader may choose to follow is not a request the page makes. The footer's
            // links into the repository are required by AC-005 and are off-origin by necessity.
            continue;
        }
        if (classified.kind === 'unusable') {
            assert(
                'AC-002 every internal link is under the base path',
                false,
                `${where}: <a href="${raw}"> — ${classified.detail}.`,
            );
            continue;
        }
        const target = locateInOutput(classified.pathname, base);
        assert(
            'AC-002 every internal link is under the base path',
            target.underBase,
            `${where}: <a href="${raw}"> resolves to ${classified.pathname}, which is not under ${base}/, ` +
                'so it leaves the published site. Every internal link is built by the one base-path helper ' +
                'in src/data/site.ts; a page never writes an href of its own.',
        );
        assert(
            'AC-002 every internal link is in directory form',
            target.directoryForm,
            `${where}: <a href="${raw}"> resolves to ${classified.pathname}, which has no trailing slash. ` +
                `${where === 'dist/index.html' ? 'The landing page' : page.label} is served from a directory, ` +
                "so the address a reader must be sent to is the one with the slash — which is what " +
                "`trailingSlash: 'always'` decides, and what `build.format: 'directory'` emits.",
        );
        assert(
            'AC-002 every internal link resolves to a page that exists',
            !target.underBase || emitted.has(target.file),
            `${where}: <a href="${raw}"> resolves to ${classified.pathname}, and the build emitted no ` +
                '`dist/' + target.file + '` — the link would 404 on the published address while the build ' +
                'stayed green.',
        );
        reachable.add(classified.pathname);
    }

    for (const entry of PAGES) {
        const target = `${base}${entry.address}`;
        assert(
            'AC-003 every page links all five pages',
            reachable.has(target),
            `${where}: no link to ${target} — FR-004 requires every page to carry navigation to the ` +
                'landing page and all four documentation pages, so no page is an orphan reachable only ' +
                `by its own address. ${page.label} is the page missing it.`,
        );
    }

    // AC-005 and NFR-004: the landmarks, and the order they appear in.
    const headings = elements.filter((element) => /^h[1-6]$/.test(element.name));
    assert(
        'AC-005 exactly one top-level heading',
        headings.filter((element) => element.name === 'h1').length === 1,
        `${where}: ${headings.filter((element) => element.name === 'h1').length} <h1> elements — AC-005 ` +
            'requires exactly one top-level heading per page, so a page has a single subject.',
    );
    assert(
        'NFR-004 the headings start at the top level',
        headings[0]?.name === 'h1',
        `${where}: the first heading is <${headings[0]?.name ?? 'none'}> — NFR-004 requires one top-level ` +
            'heading per page in order, so no deeper heading may come before it.',
    );

    const navs = elements.filter((element) => element.name === 'nav');
    assert(
        'AC-005 a navigation region',
        navs.length === 1,
        `${where}: ${navs.length} <nav> elements — AC-005 requires a navigation region on every page.`,
    );
    for (const nav of navs) {
        assert(
            'AC-005 the navigation region has an accessible name',
            nav.attributes.has('aria-labelledby') || (nav.attributes.get('aria-label') ?? '').trim() !== '',
            `${where}: ${openingTag(nav)} carries no accessible name — NFR-004 requires a labelled ` +
                'navigation landmark, which is what lets a reader using assistive technology skip past it. ' +
                'Add aria-label.',
        );
    }

    // AC-005 and FR-076: the footer links the license file in the repository.
    assertTheFooterLicenseLink(where, html, pageAddress, origin);

    // FR-052 and AC-006: nothing unfinished survives into the output, in either of the two
    // shapes it can take. The vocabulary first — matched whole, see `TOKEN_LEADING` for why
    // a substring test would refuse the shipped prose.
    const lowered = html.toLowerCase();
    for (const { token, pattern } of PLACEHOLDER_PATTERNS) {
        assert(
            'AC-006 no placeholder or unfinished marker',
            !pattern.test(lowered),
            `${where}: carries "${token}" as a word of its own — FR-052 forbids a placeholder, a template ` +
                'marker or a "coming soon" on any page. The vocabulary this gate looks for is: ' +
                `${PLACEHOLDER_TOKENS.join(', ')}. A token inside a longer name — a plural, an identifier, a ` +
                'filename — is not one of them and does not fail here.',
        );
    }

    // And then the shapes, which carry no word of their own — a page whose unfinished parts
    // are spelled as braces rather than as words is exactly what a vocabulary cannot see.
    //
    // Marked literal markers are cut first; that the site still declares one is asserted
    // once over the whole output, in `assertTheLiteralMarkerIsDeclared`, for the reason
    // every other scan here is paired with a presence check.
    const markup = readMarkup(html);
    const scanned = withoutLiteralMarkers(markup);
    for (const shape of UNFINISHED_SHAPES) {
        const found = shape.pattern.exec(scanned);
        assert(
            'AC-006 no placeholder or unfinished marker',
            found === null,
            `${where}: carries ${shape.name} \`${found?.[0] ?? ''}\` — FR-052 forbids a placeholder, a template ` +
                'marker, an empty section heading or an instruction to fill something in later, and this is that ' +
                'check reading the built page rather than a list of words. An expression that evaluates, a heading ' +
                `with text in it, and a marker quoted inside an element marked \`${AC_LITERAL_MARKER}="true"\` all pass.`,
        );
    }

    return contrast;
}

/**
 * @param {string} value A `srcset` attribute's value.
 * @returns {string[]} Its candidate URLs, one per descriptor group.
 */
function readSrcset(value) {
    return value
        .split(',')
        .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
        .filter((candidate) => candidate !== '');
}

/**
 * The URL a `<meta http-equiv="refresh">` navigates to, or the empty string when it only
 * re-renders the page it is on.
 *
 * Read out of the `content` value rather than through `classify`, because `content` is not a
 * URL: `0;url=https://evil.example/` is a *delay* followed by a target, and handing the whole
 * value to `new URL()` would resolve it as a relative path — back onto the site's own origin,
 * where it passes as an internal reference. That is why a meta refresh had to be handled
 * rather than added to `RESOURCE_POSITIONS`.
 *
 * @param {string} content A refresh `content` value.
 * @returns {string} The target URL, or the empty string when there is none.
 */
function readRefreshTarget(content) {
    const found = /(?:^|[;,])\s*url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;,]+))/i.exec(content);

    return found === null ? '' : found[1] ?? found[2] ?? found[3] ?? '';
}

/**
 * Check one resource reference: a value the browser fetches or executes.
 *
 * @param {string} where The emitted file, for the message.
 * @param {string} pageAddress The page's own published address.
 * @param {string} base The declared base path.
 * @param {string} origin The site's canonical origin.
 * @param {Set<string>} emitted The emitted files.
 * @param {{ name: string, attributes: Map<string, string> }} element The element carrying it.
 * @param {string} attribute The attribute's name.
 * @param {string} [raw] One target read out of the attribute's value — a `srcset` candidate, a
 *   meta refresh's destination — where the attribute itself holds something larger.
 * @param {string} [as] How to name `raw` in the message.
 */
function assertResourceReference(where, pageAddress, base, origin, emitted, element, attribute, raw, as) {
    const value = raw ?? element.attributes.get(attribute) ?? '';
    const at = `${where}: ${openingTag(element)}${raw === undefined ? '' : ` — ${as ?? 'candidate'} \`${raw}\``}`;
    const classified = classify(value, pageAddress, origin);
    if (classified.kind === 'same-document') {
        return;
    }
    if (classified.kind === 'unusable') {
        assert('FR-010 no off-origin resource reference', false, `${at} — ${classified.detail}.`);
        return;
    }
    assert(
        'FR-010 no off-origin resource reference',
        classified.kind === 'same-origin',
        `${at} — ${classified.detail}. FR-010 and NFR-003: a page view makes requests to the site's own ` +
            'origin only. A remote font, stylesheet, script, image, analytics endpoint or content-delivery ' +
            'host is what this catches.',
    );
    if (classified.kind !== 'same-origin') {
        return;
    }
    const target = locateInOutput(classified.pathname, base);
    assert(
        'AC-002 every resource is under the base path',
        target.underBase,
        `${at} — it resolves to ${classified.pathname}, which is not under ${base}/, so the browser would ` +
            'request it from the domain root and get the Pages 404 rather than the file.',
    );
    assert(
        'AC-002 every resource resolves to a file that exists',
        !target.underBase || emitted.has(target.file),
        `${at} — it resolves to ${classified.pathname} and the build emitted no \`dist/${target.file}\`.`,
    );
}

/**
 * Check an inline stylesheet: it may not pull in another stylesheet, and it may not name a remote one.
 *
 * @param {string} where Where the block came from, for the message.
 * @param {string} css The block's contents.
 * @param {string} origin The site's canonical origin.
 */
function assertInlineStylesheet(where, css, origin) {
    for (const imported of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')]+)/gi)) {
        assert(
            'FR-010 no off-origin resource reference',
            false,
            `${where} @import ${imported[1]} — an @import is a stylesheet request, and this site has no ` +
                "stylesheet: the layout's CSS is inlined into every page.",
        );
    }
    for (const referenced of css.matchAll(/url\(\s*["']?([^"')]+)/gi)) {
        const classified = classify(referenced[1], '/', origin);
        assert(
            'FR-010 no off-origin resource reference',
            classified.kind !== 'off-origin' && classified.kind !== 'unusable',
            `${where} url(${referenced[1]}) — ${classified.detail || 'it points off-origin'}. A stylesheet ` +
                "that fetches anything is a third-party request (FR-010, NFR-003); this one fetches nothing.",
        );
    }
}

/**
 * Check that the footer carries a link to the license file in the repository.
 *
 * @param {string} where The emitted file, for the message.
 * @param {string} html The page's markup.
 * @param {string} pageAddress The page's own published address.
 * @param {string} origin The site's canonical origin.
 */
function assertTheFooterLicenseLink(where, html, pageAddress, origin) {
    const footerStart = html.indexOf('<footer');
    const footerEnd = html.indexOf('</footer>');
    const body =
        footerStart === -1 || footerEnd === -1 || footerEnd < footerStart
            ? undefined
            : html.slice(footerStart, footerEnd);
    assert(
        'AC-005 a footer carrying the license link',
        body !== undefined,
        `${where}: the page carries no footer element — AC-005 and FR-076 require a footer on every page.`,
    );
    if (body === undefined) {
        return;
    }
    const targets = readLinkTargets(body);
    const license = targets.find((raw) => {
        if (!/^https?:\/\//i.test(raw.trim())) {
            return false;
        }
        const classified = classify(raw, pageAddress, origin);
        return classified.kind === 'off-origin' && classified.pathname.endsWith('/LICENSE');
    });
    assert(
        'AC-005 a footer carrying the license link',
        license !== undefined,
        `${where}: the footer's links are [${targets.join(', ') || 'none'}] and none is an absolute link to ` +
            'a repository LICENSE file — AC-005 and FR-076 require one on every page, and the site ' +
            'publishes no copy of the license (plan D8), so the link has to be absolute.',
    );
}

/**
 * Check that the site still declares the literal marker it is exempt about.
 *
 * **Once over the whole output, not once per page.** The exemption belongs to
 * `/configure/`, which is the one page that prints a literal marker in order to say the
 * prompt is sent verbatim; the other four pages have nothing to mark, and an assertion
 * every page had to satisfy would be satisfied by four copies of a marker nobody needs.
 *
 * The presence check is separate from the scan above for the reason every other scan in
 * this file is paired with one: an **absence** assertion — no unexplained marker survives —
 * is satisfied exactly as well by a site that has deleted the marker and its sentence with
 * it. So the two are checked apart. This is the split `tests/vocabulary.test.ts` makes for
 * the identifier-mapping table (007 AC-013), and it is why deleting the documentation is a
 * visible failure rather than a quiet one.
 *
 * @param {string} markup Every emitted page's markup, concatenated.
 */
function assertTheLiteralMarkerIsDeclared(markup) {
    const declared = markup.match(new RegExp(`<[^>]*\\b${AC_LITERAL_MARKER}="true"`, 'gi')) ?? [];

    assert(
        'AC-006 the documented literal marker is marked as one',
        declared.length > 0,
        `no emitted element carries \`${AC_LITERAL_MARKER}="true"\`. /configure/ documents that the starting ` +
            'prompt is sent verbatim by printing the marker itself, and that element is how the AC-006 shape ' +
            'check tells that documentation from an expression that leaked into the output — so its absence ' +
            'means the exemption the shipped site relies on is no longer declared, and the shape check would ' +
            'now be refusing the site it exists to protect.',
    );
}

// ---------------------------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------------------------

const { base, origin } = readDeclaredSite();
const distDirectory = resolve(process.cwd(), process.argv[2] ?? join(SITE_ROOT, 'dist'));

if (!existsSync(distDirectory) || !statSync(distDirectory).isDirectory()) {
    checks += 1;
    failures.push(
        `FAIL [AC-001 the five pages, and no further page] ${distDirectory} is not a directory — run ` +
            '`npm run build` first. This script asserts the artefact, and there is none to assert.',
    );
} else {
    const emitted = new Set(listFiles(distDirectory));
    assertTheOutputShape([...emitted]);

    const pages = [];
    const contrast = [];
    for (const page of PAGES) {
        if (!emitted.has(page.file)) {
            continue;
        }
        const html = readFileSync(join(distDirectory, page.file), 'utf8');
        pages.push(html);
        contrast.push(...assertThePage(page, html, base, origin, emitted));
    }
    assertTheLiteralMarkerIsDeclared(pages.join(''));

    if (failures.length === 0) {
        process.stdout.write(
            `assert-build: ${checks} assertions hold over ${emitted.size} files and ${PAGES.length} pages, ` +
                `every internal reference under ${base}/.\n`,
        );
        // NFR-004 names its verification as *"the site's own check plus an automated audit of
        // the built pages"*, so the audit's own figures are printed rather than left to be
        // re-derived by hand. Deduplicated by *preference, pair and colour*, not by colour alone: the
        // layout inlines one palette into all five pages, so five identical ledgers would be
        // five times the noise — but two different pairs can share a colour pair (a link on the
        // page and a link on the surface both measure once the surface is `body`'s), and
        // collapsing those would hide which pair was read.
        const distinct = new Map();
        for (const pair of contrast) {
            distinct.set(`${pair.where}: ${pair.foreground} on ${pair.background}`, pair);
        }
        for (const pair of distinct.values()) {
            process.stdout.write(
                `assert-build: NFR-004 contrast — ${pair.where}: ${pair.foreground} on ${pair.background}, ` +
                    `${pair.ratio.toFixed(2)}:1 (floor ${CONTRAST_FLOOR}:1)\n`,
            );
        }
    }
}

if (failures.length > 0) {
    process.stdout.write(`${failures.join('\n')}\n`);
    process.stdout.write(
        `assert-build: ${failures.length} of ${checks} assertions did not hold. The artefact does not ` +
            'satisfy contracts/site-build-output.md, and a build that succeeded is not the same thing as a ' +
            'build that is correct.\n',
    );
    process.exitCode = 1;
}
