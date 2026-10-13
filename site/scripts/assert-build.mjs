#!/usr/bin/env node
/**
 * The site's build-output contract, executable: the last step of `npm run build`, auditing `dist/`
 * for AC-001…AC-006, AC-032 and NFR-002/003/004; every failure names its file, markup and rule.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The five published pages (AC-001) — a deliberate second reading of `PAGES` in `src/data/site.ts`
 * rather than an import (it is `.ts`). The navigation every page emits is checked against *this*
 * list, so a page dropped there fails here instead of quietly shrinking the site.
 */
const PAGES = [
    { address: '/', label: 'the landing page', file: 'index.html' },
    { address: '/install/', label: 'the install page', file: 'install/index.html' },
    { address: '/configure/', label: 'the configure page', file: 'configure/index.html' },
    { address: '/use/', label: 'the use page', file: 'use/index.html' },
    { address: '/debug/', label: 'the debug page', file: 'debug/index.html' },
];

/** NFR-002: a file the browser loads as code; `.map` counts because a source map means the script beside it shipped. */
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

/** FR-052 and AC-006: spelled out rather than derived — a marker nobody can name is a marker nobody writes. */
const PLACEHOLDER_TOKENS = ['todo', 'fixme', 'coming soon', 'lorem ipsum', 'placeholder', 'tbd', 'under construction'];

/**
 * A token matched **whole**, a different assertion from "matched somewhere": a substring test
 * rejects the shipped prose (the configure page quotes "no placeholders" verbatim) and confuses a
 * marker with a word inside a longer name. The boundary is what makes a token *part of a longer*
 * name* rather than the name: nothing letter/digit/`_`/`.`/`-` before (`todos.json`, `fixme-mode`),
 * and deliberately no `/` — in running prose a slash separates words more often than it names a
 * directory, and a false *accept* is the expensive direction. After: no letter/digit/`_` (so
 * `placeholders` passes), no `-word` (`todo-list`), no `.word` (`todo.md`); a trailing `.` with
 * nothing name-like after it is still a marker. Multi-word tokens join on `[\s-]+`.
 */
const TOKEN_LEADING = '(?<![a-z0-9_.-])';
const TOKEN_TRAILING = '(?![a-z0-9_]|-\\w|\\.[a-z0-9])';

/** Compile one token into the pattern that matches it whole. */
function wholeWordPattern(token) {
    const words = token
        .split(' ')
        .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s-]+');

    return `${TOKEN_LEADING}${words}${TOKEN_TRAILING}`;
}

/**
 * Every token compiled once, paired with the token a failure quotes: lower-case patterns matched
 * against lower-cased HTML (so no `i` flag), built here rather than per page — five pages, seven
 * patterns each, on every build.
 */
const PLACEHOLDER_PATTERNS = PLACEHOLDER_TOKENS.map((token) => ({ token, pattern: new RegExp(wholeWordPattern(token)) }));

/**
 * The two shapes FR-052 forbids that carry no word of their own: `PLACEHOLDER_TOKENS` is a
 * vocabulary, these are **syntax**, and AC-006 names both — a gate holding only the vocabulary is
 * satisfied by a page whose unfinished parts are spelled as braces, which is what a build leaves
 * behind when an `.astro` expression is invalid, a raw string, or renders nothing.
 */
const UNFINISHED_SHAPES = [
    {
        name: 'a template marker',
        // `{{name}}`: every template engine's placeholder, and the shape a value read from
        // configuration can carry into a page verbatim; a single brace pair is the pattern below.
        pattern: /\{\{[^{}]*\}\}/,
    },
    {
        name: 'an unresolved expression',
        // `{name}`, `{name.member}`, `{name['key']}`, `{name[0]}`: an expression that reached the
        // output unevaluated. Member access is inside the pattern because Astro's own expressions
        // are predominantly member access — a bare identifier would call the shipped site's own
        // shapes unreachable while catching only what the site does not use. A `(` is excluded:
        // whether a call evaluated is not decidable from the output, so the token scan owns it.
        pattern: /\{\s*[A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:'[^']*'|"[^"]*"|\d+)\s*\]))*\s*\}/,
    },
    {
        name: 'an empty heading',
        // `<h2></h2>`: the heading FR-052 names, at any level. Whitespace-only counts, which is
        // what a heading whose only content rendered nothing looks like after the build trims it.
        pattern: /<h([1-6])\b[^>]*>\s*<\/h\1\s*>/i,
    },
];

/**
 * The one element that spells a literal brace marker on purpose: `/configure/` documents that the
 * starting prompt is sent verbatim by printing the marker itself, and FR-052's shape check cannot
 * tell that from an expression that leaked into the output. The exemption is an **attribute**
 * rather than an HTML comment because Astro strips comments from a template — the exemption would
 * scope the source and vanish from the built page. Asserted present below, so the marker cannot be
 * deleted into a failure nobody sees.
 */
const AC_LITERAL_MARKER = 'data-literal-marker';

/**
 * A page's markup with its style blocks removed: the shape checks assert what a reader reads, and
 * a CSS rule body is a run of braces no template engine produced. `PLACEHOLDER_PATTERNS` still
 * runs over the raw page — narrowing the bytes it reads would only weaken an existing assertion.
 */
function readMarkup(html) {
    return html.replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
}

/**
 * Every page's markup with the marked literal markers cut out of it — whole elements, not the
 * attribute alone, so an exempt `<code>` cannot hide a second marker inside it: the span runs from
 * the marked opening tag to the first closing tag of the same name.
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
 * Attributes whose value the browser fetches, executes, or resolves every other reference against
 * — a distinction of *position*, not of host: FR-010 and NFR-003 govern the requests a page view
 * makes, a hyperlink is not one, and the footer's repository links are off-origin by necessity
 * (AC-005, plan D8).
 * **`base` is the first entry that fetches nothing, and the reason it is here**: a `<base href>`
 * re-bases every *relative* URL on the page, so the requests it causes go to whatever origin it
 * names — the shape NFR-003 forbids, reachable from an otherwise green build. It carries the same
 * two AC-002 checks as every other position.
 * **`style` is handled rather than listed**: a `style` attribute is a stylesheet body and is
 * routed through `assertInlineStylesheet` below, which is what catches `style="background:url(…)"`
 * — listed here it would be read as a bare URL and miss every `url()` in it.
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
// NFR-004's contrast floor, over the **static** pairs the built pages state outright: a palette
// edit changes contrast without touching markup, so measured here rather than left a claim.
// ## What this audit does not claim
// A bounded reader of declarations, not a CSS engine, and three boundary questions are refused
// loudly rather than skipped: responsive `clamp()` titles stay normal text here (the browser pass
// applies WCAG 2.2's own 18pt/14pt-bold boundary); a state-scoped rule paints nothing in the
// resting state (`unresolvableBackgrounds` says so) and the rendered pass measures focus/hover;
// gradient surfaces are refused, not approximated — the rendered pass samples their pixels.
// ---------------------------------------------------------------------------------------------

/** NFR-004's floor, as WCAG 2.2 states it: 4.5:1 for body text. */
const CONTRAST_FLOOR = 4.5;

/**
 * Every surface the audit measures text on, as far as its bounded model can tell. `selector` is
 * the one shape it can place — the box the text is drawn in — and each entry is listed because the
 * audit refuses a background it cannot place rather than resolving it by guesswork: a surface
 * nobody measured is a surface nobody read. `chain` is where a transparent surface falls through:
 * `background` is not inherited (the initial value is `transparent`), so the background behind
 * text is a walk up the ancestors until something opaque is declared, and a chain that ends with
 * none means the stylesheet paints nothing at all — reported rather than assumed.
 */
const CONTRAST_SURFACES = [
    { name: 'page', selectors: ['body'], chain: ['html'] },
    { name: 'the lead surface', selectors: ['main > h1 + section'], chain: ['section', 'body', 'html'] },
    // Two selectors, one surface: the lead paragraph and a section's first paragraph are the same
    // sunken band, declared by one rule — a surface is a *painted box*.
    { name: 'the lead paragraph', selectors: ['h1 + p', 'h2 + p'], chain: ['body', 'html'] },
    { name: 'a section', selectors: ['section'], chain: ['body', 'html'] },
    { name: 'the navigation', selectors: ['nav'], chain: ['body', 'html'] },
    { name: 'the footer', selectors: ['footer'], chain: ['body', 'html'] },
    { name: 'a table caption', selectors: ['caption'], chain: ['table', 'body', 'html'] },
    { name: 'a table', selectors: ['table'], chain: ['body', 'html'] },
    { name: 'a table header', selectors: ['thead th'], chain: ['table', 'body', 'html'] },
    { name: 'a banded table row', selectors: ['tbody tr:nth-child(even)'], chain: ['table', 'body', 'html'] },
    { name: 'inline code', selectors: ['code'], chain: ['body', 'html'] },
    // `pre code` is listed as well as `pre`, which declares `transparent` — read as *paints
    // nothing* — so the block's own colour would go unmeasured.
    { name: 'a code block', selectors: ['pre', 'pre code'], chain: ['body', 'html'] },
];

/**
 * The text/background pairs the layout can put together. Each pair names the **element the text
 * sits in**, not a colour and not a token: the background under that element is a fact about the
 * cascade, and naming a token that `--surface` happens to be today would measure a custom
 * property no rule is obliged to use. Surfaces resolve below the way a browser resolves them, so
 * a footer repainted with a literal, a `rgb()`, or nothing at all is measured on what it sits on.
 * The foreground stays a token — `:root`'s text roles are the site's palette — and each one named
 * is the one the layout actually paints that text in (`--muted` opens the navigation, `--signal`
 * a table caption): a pair naming a different token would report a ratio no reader ever sees.
 * `--rule` is deliberately absent: a border is not text, and NFR-004 bounds text contrast.
 * Every pair is **normal text**, because `clamp()` display titles cannot be classified from a
 * declaration this audit can read.
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
 * The tokens every pair above reads, asserted **present**: an audit that reports nothing about a
 * page whose palette it failed to find is a green check that measured nothing.
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
 * How many `var(--x)` hops a declared colour may take before the audit calls it unreadable: the
 * shipped palette resolves in one, and the bound makes a circular declaration fail rather than spin.
 */
const MAX_COLOUR_HOPS = 4;

/**
 * A background value that paints nothing, so the element behind it shows through — `transparent`
 * is the initial value and `none` the other spelling; both send the walk up the chain.
 */
const SEE_THROUGH_BACKGROUNDS = new Set(['transparent', 'none']);

/**
 * The `background` shorthand values that paint an **image** rather than a colour. This audit reads
 * declarations rather than pixels, so an image layer is refused rather than approximated — the
 * browser pass over the rendered pages measures those pixels.
 */
const BACKGROUND_IMAGES = ['linear-gradient(', 'radial-gradient(', 'conic-gradient(', 'repeating-linear-gradient(', 'repeating-radial-gradient(', 'repeating-conic-gradient(', 'image-set(', 'cross-fade(', 'url('];

// ---------------------------------------------------------------------------------------------
// Reading the site's own configuration: base path and canonical origin are declared in one place
// (FR-005, AC-002), and copying either here would reintroduce the rename bug inside the gate that
// exists to catch it — so a shape this script cannot read is a hard error, never a silent fallback.
// ---------------------------------------------------------------------------------------------

/** The declared base path without a trailing slash, and the canonical origin it is published under. */
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
// HTML reading: no DOM parser in the stdlib and no dependency for the site's only gate; the
// emitted HTML is flat and minified, so a tolerant tag scanner sees every attribute these need.
// ---------------------------------------------------------------------------------------------

/**
 * Parse an element's attribute text into a lower-cased name → value map: quoted, single-quoted
 * and bare values, and a valueless attribute as `''`.
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
 * Every element in document order; quoted attribute runs are matched whole, so a `>` inside a
 * value does not end the tag early.
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

/** Every `<a href>` target on the page, in document order. */
function readLinkTargets(html) {
    return [...html.matchAll(/<a\s[^>]*href=(?:"([^"]*)"|'([^']*)')/gi)].map((match) => match[1] ?? match[2] ?? '');
}

/**
 * Classify a reference, resolving a relative one against the address of the page it appears on: a
 * relative reference resolves onto the site's own origin, an absolute one keeps its host — what
 * separates "links into the site" from "points elsewhere" without a host allow-list a rename
 * would break. `kind` is `same-document`, `same-origin`, `off-origin` or `unusable`; `detail` says
 * why when it is not usable.
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
 * Locate a resolved path under the site's own output; `file` is the path it would have to name
 * inside `dist/`, or the empty string when it is not under the base at all.
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
 * One selector as the audit compares it. The minifier strips combinator spacing (`main>h1+section`)
 * and rewrites `tbody tr:nth-child(even)` as `tbody tr:nth-child(2n)` — the rewrite that could have
 * gone quietly wrong: a surface named in the `even` spelling would stop matching, the walk would
 * fall through to a lighter ancestor, and the pair would report an inflated ratio on a real build
 * rather than a failure. `CONTRAST_SURFACES` is written in the readable keyword form, so both
 * spellings are normalised to it here.
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
 * The colours and rules one page's inlined stylesheet declares, read out of the **built** page
 * rather than `src/layout.astro`: the requirement's own verification is *"an automated audit of
 * the built pages"*, and a page carrying a `<style>` of its own would otherwise inherit the
 * layout's palette by assumption. The requested `prefers-color-scheme` block is activated and the
 * others excluded first; `unconditional` records whether another at-rule paints a background — a
 * viewport-dependent surface is one this audit cannot decide, so it is refused.
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
        // Later declarations win, which is the cascade: a page's second `:root` overrides the first.
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
 * requested preference, so the audit reads the browser's two cascades independently without
 * treating a dark-only background as an unknown viewport-dependent surface.
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

/** Find a block's matching closing brace, accounting for nested CSS rules. */
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
 * Whether any remaining at-rule block — `@media`, `@supports` — declares a background. One that
 * only applies inside a query depends on a viewport this audit does not know, and reading the rule
 * as unconditional is the false *accept* this file exists to refuse, so it is a finding rather than
 * a skip. Braces are counted so a nested block does not end the walk early.
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
 * What one rule body paints behind itself: a colour, nothing, or something this audit cannot
 * read. Both spellings of the property are read and the **last** of them wins, which is the
 * cascade. The one form refused is a shorthand carrying more than one layer — it paints images
 * over a colour, and reading the bottom layer would measure a colour the reader never sees. It is
 * reported with the fix, because "declare the colour as `background-color` and the decoration as
 * `background-image`" is both true CSS and a form this audit can read: an image layer paints no
 * colour, so a surface declaring only one genuinely falls through to what is behind it.
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
 * The colour the text on one surface is actually drawn on, resolved the way a browser resolves
 * it: this element's own declaration, or — when it declares none, or one that paints nothing —
 * the nearest ancestor's. Each link is a surface selector from `CONTRAST_SURFACES` or a bare
 * ancestor name; a background behind a selector outside that set is not resolved here
 * (`unresolvableBackgrounds` names it and the audit fails), because a background it cannot place
 * is a background nobody measured.
 */
function paintBackground(rules, surface) {
    const definition = CONTRAST_SURFACES.find((candidate) => candidate.name === surface);
    if (definition === undefined) {
        return { declared: '', from: '', problem: `\`${surface}\` is not a surface this audit reads` };
    }

    for (const candidate of [...definition.selectors.flat(), ...definition.chain].map(normaliseSelector)) {
        // The last rule that **declares a background** wins, which is the cascade within the walk:
        // a later padding-only rule does not reset an earlier background, so this filters to rules
        // that declare one and takes the last of those.
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
 * Every background declaration this audit cannot place, named. Two kinds sit outside the model,
 * for opposite reasons: a selector it does not know (`.card`, `html[dir='rtl']`, `main p`) paints
 * behind a box it cannot identify, and resolving that as absent would report the inherited
 * surface for text not drawn on it; and a **state- or pseudo-element-scoped** rule (`:hover`,
 * `:focus-visible`, `::before`, `::after`) paints nothing in the resting state this audit
 * measures. The second is left out deliberately and written down here, because the browser pass
 * over the rendered pages is what exercises a hover or focus surface and a reader should know
 * which half of the evidence covers them. *State* means the interaction states only:
 * `:first-child`, `:nth-child(…)`, `:checked` and `:disabled` hold while the page sits still, so
 * a background behind one paints in the measured state and is refused like any other.
 */
function unresolvableBackgrounds(rules) {
    const placed = new Set(
    CONTRAST_SURFACES.flatMap((surface) => [...surface.selectors.flat(), ...surface.chain]).map(normaliseSelector),
);
    /*
     * Pseudo-elements generate boxes this audit reads no text out of and the four interaction
     * states do not hold at rest; everything else is refused. The state name must be outside a
     * `:not(…)` — `a:not(:hover)` *is* the resting state — hence the `(` in front of it.
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
 * Follow a declared colour through `var(--x)` references to the value at the end of it;
 * unchanged when the chain does not end within `MAX_COLOUR_HOPS`, which `assertContrast` then
 * reports as unreadable.
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
 * A `#rgb` or `#rrggbb` colour as its three channels, `null` for anything else rather than a
 * guess: `rgb()`, `hsl()` and colour keywords are valid CSS and none is in this site's palette,
 * and a gate that skipped what it could not read would pass a page for a colour it never looked
 * at — so the unreadable shape is a hard failure that names the value.
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

/** One channel's linear-light value, per WCAG 2.2's definition of relative luminance. */
function linearise(channel) {
    const proportion = channel / 255;

    return proportion <= 0.039_28 ? proportion / 12.92 : ((proportion + 0.055) / 1.055) ** 2.4;
}

/** A colour's relative luminance, 0–1. */
function luminance(colour) {
    return 0.2126 * linearise(colour.r) + 0.7152 * linearise(colour.g) + 0.0722 * linearise(colour.b);
}

/** The contrast ratio between two colours, as WCAG 2.2 states it: 1 (identical) to 21 (black on white). */
function contrastRatio(foreground, background) {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));

    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * NFR-004's contrast floor, audited over the colours a page's stylesheet resolves to. Five
 * assertions beyond the floor keep the next honest — the pairs' tokens declared, both preference
 * palettes present and selecting their own `color-scheme`, every background placeable, every
 * surface resolving to a colour, every colour readable — because an audit that finds no palette,
 * cannot tell which box a background paints, walks off the end of a chain, or meets a gradient it
 * cannot resolve reports no failures for a page whose text colour it never looked at, and a green
 * check that measured nothing is the exact shape of gate this file exists to refuse.
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
    // Non-vacuity for the cascade: a walk that ends on nothing means the stylesheet paints no
    // surface at all, and an audit that measured nothing would still exit zero — once per surface.
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
 * An element's opening tag as written, so a failure quotes the markup it refused rather than a
 * reconstruction of the one attribute that mattered.
 */
function openingTag(element) {
    const attributes = [...element.attributes].map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${value}"`));
    return `<${element.name}${attributes.join('')}>`;
}

/** The lower-cased extension of a `/`-separated path, including the dot, or the empty string. */
function extensionOf(file) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/** Every file under a directory as `/`-separated paths relative to it, sorted for a stable report. */
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

// The checks.

const failures = [];
let checks = 0;

/**
 * Record one assertion. Nothing is thrown and nothing exits early, because a gate that stops at
 * the first failure costs a contributor a build per finding; `id` names the rule that broke.
 */
function assert(id, held, message) {
    checks += 1;
    if (!held) {
        failures.push(`FAIL [${id}] ${message}`);
    }
}

/**
 * The shape of the output itself: the exact file set, and no script and no image file anywhere —
 * AC-001's "no further page" and NFR-002's "no script file" are one measurement read two ways,
 * both reported by name so a failure says which rule broke.
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
 * Check one page's markup, returning the contrast pairs NFR-004's audit measured on it, for the
 * ledger the run prints.
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
        // A `style` attribute is a stylesheet body, so it is read as one — this catches
        // `style="background:url(https://…)"`, which no RESOURCE_POSITIONS entry can see.
        if (element.attributes.has('style')) {
            assertInlineStylesheet(
                `${where}: ${openingTag(element)} \`style\` attribute`,
                element.attributes.get('style') ?? '',
                origin,
            );
        }
    }

    // FR-010/NFR-003: a meta refresh is the one navigation a page performs with no reader's click
    // in it — a reference the page itself makes, not the `<a href>` shape NFR-003 exempts. See
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
            // A hyperlink the reader may choose to follow is not a request the page makes; the
            // footer's repository links are required by AC-005 and off-origin by necessity.
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

    // FR-052 and AC-006: the vocabulary first, matched whole — see `TOKEN_LEADING` for why a
    // substring test would refuse the shipped prose.
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

    // Then the shapes, which carry no word of their own. Marked literal markers are cut first,
    // and that one is still declared is asserted once over the whole output.
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

/** A `srcset` attribute's candidate URLs, one per descriptor group. */
function readSrcset(value) {
    return value
        .split(',')
        .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
        .filter((candidate) => candidate !== '');
}

/**
 * The URL a `<meta http-equiv="refresh">` navigates to, or the empty string when it only
 * re-renders the page it is on. Read out of the `content` value rather than through `classify`,
 * because `content` is not a URL: `0;url=https://evil.example/` is a *delay* followed by a target,
 * and handing the whole value to `new URL()` resolves it as a relative path — back onto the
 * site's own origin, where it passes as an internal reference. That is why a meta refresh is
 * handled rather than added to `RESOURCE_POSITIONS`.
 */
function readRefreshTarget(content) {
    const found = /(?:^|[;,])\s*url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;,]+))/i.exec(content);

    return found === null ? '' : found[1] ?? found[2] ?? found[3] ?? '';
}

/**
 * Check one resource reference: a value the browser fetches or executes. `raw` is one target read
 * out of a larger attribute (a `srcset` candidate, a meta refresh's destination), `as` how to name
 * it in the message.
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

/** Check an inline stylesheet: it may not pull in another stylesheet, and it may not name a remote one. */
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

/** Check that the footer carries a link to the license file in the repository. */
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
 * Check that the site still declares the literal marker it is exempt about — **once over the
 * whole output, not once per page**: the exemption belongs to `/configure/`, and an assertion
 * every page had to satisfy would be satisfied by four copies of a marker nobody needs. The
 * presence check is separate from the scan for the reason every other scan in this file is paired
 * with one: an **absence** assertion is satisfied just as well by a site that deleted the marker
 * and its sentence with it, so deleting the documentation is a visible failure rather than a quiet
 * one (007 AC-013).
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

// Run.

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
        // NFR-004 names its verification as *"an automated audit of the built pages"*, so the
        // figures are printed rather than left to be re-derived. Deduplicated by *preference, pair
        // and colour*: the layout inlines one palette into all five pages, but two different pairs
        // can share a colour and collapsing those would hide which pair was read.
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
