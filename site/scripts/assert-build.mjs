#!/usr/bin/env node
/**
 * The site's build-output contract, executable.
 *
 * Five acceptance criteria and two non-functional requirements are properties of
 * what `astro build` emitted, not of what anyone wrote: AC-001 (no page beyond
 * the five), AC-002 (every internal link under the base path), AC-003 (every
 * page reaches all five), AC-004 (no remote resource, no image file), AC-005
 * (one `h1`, a named navigation region, the licence link), NFR-002 (no
 * JavaScript), and NFR-003 (no third-party request). A reviewer with `src/` open
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
 * Attributes whose value the browser fetches or executes.
 *
 * This is the distinction the whole off-origin check turns on, and it is a
 * distinction of *position*, not of host. FR-010 and NFR-003 govern the requests
 * a page view makes; a hyperlink is not one. The footer's links into the
 * repository are off-origin by necessity — the site publishes no copy of the
 * licence (plan D8) and AC-005 requires the link — so a check that flagged every
 * off-origin URL would be flagging a requirement.
 */
const RESOURCE_POSITIONS = [
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
 */
function assertThePage(page, html, base, origin, emitted) {
    const where = `dist/${page.file}`;
    const pageAddress = `${base}${page.address}`;
    const elements = readElements(html);

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
                assertResourceReference(where, pageAddress, base, origin, emitted, element, attribute, candidate);
            }
        }
    }

    // FR-010: an inline stylesheet cannot reach off-origin either, and there is no stylesheet at all.
    for (const block of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
        assertInlineStylesheet(`${where}: <style>`, block[1], origin);
    }

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

    // AC-005 and FR-076: the footer links the licence file in the repository.
    assertTheFooterLicenceLink(where, html, pageAddress, origin);

    // FR-052 and AC-006: nothing unfinished survives into the output.
    const lowered = html.toLowerCase();
    for (const token of PLACEHOLDER_TOKENS) {
        assert(
            'AC-006 no placeholder or unfinished marker',
            !lowered.includes(token),
            `${where}: contains "${token}" — FR-052 forbids a placeholder, a template marker or a "coming ` +
                'soon" on any page. The vocabulary this gate looks for is: ' +
                `${PLACEHOLDER_TOKENS.join(', ')}.`,
        );
    }
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
 * Check one resource reference: a value the browser fetches or executes.
 *
 * @param {string} where The emitted file, for the message.
 * @param {string} pageAddress The page's own published address.
 * @param {string} base The declared base path.
 * @param {string} origin The site's canonical origin.
 * @param {Set<string>} emitted The emitted files.
 * @param {{ name: string, attributes: Map<string, string> }} element The element carrying it.
 * @param {string} attribute The attribute's name.
 * @param {string} [raw] One candidate out of the attribute's value, for a `srcset`.
 */
function assertResourceReference(where, pageAddress, base, origin, emitted, element, attribute, raw) {
    const value = raw ?? element.attributes.get(attribute) ?? '';
    const at = `${where}: ${openingTag(element)}${raw === undefined ? '' : ` — candidate \`${raw}\``}`;
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
 * Check that the footer carries a link to the licence file in the repository.
 *
 * @param {string} where The emitted file, for the message.
 * @param {string} html The page's markup.
 * @param {string} pageAddress The page's own published address.
 * @param {string} origin The site's canonical origin.
 */
function assertTheFooterLicenceLink(where, html, pageAddress, origin) {
    const footerStart = html.indexOf('<footer');
    const footerEnd = html.indexOf('</footer>');
    const body =
        footerStart === -1 || footerEnd === -1 || footerEnd < footerStart
            ? undefined
            : html.slice(footerStart, footerEnd);
    assert(
        'AC-005 a footer carrying the licence link',
        body !== undefined,
        `${where}: the page carries no footer element — AC-005 and FR-076 require a footer on every page.`,
    );
    if (body === undefined) {
        return;
    }
    const targets = readLinkTargets(body);
    const licence = targets.find((raw) => {
        if (!/^https?:\/\//i.test(raw.trim())) {
            return false;
        }
        const classified = classify(raw, pageAddress, origin);
        return classified.kind === 'off-origin' && classified.pathname.endsWith('/LICENSE');
    });
    assert(
        'AC-005 a footer carrying the licence link',
        licence !== undefined,
        `${where}: the footer's links are [${targets.join(', ') || 'none'}] and none is an absolute link to ` +
            'a repository LICENSE file — AC-005 and FR-076 require one on every page, and the site ' +
            'publishes no copy of the licence (plan D8), so the link has to be absolute.',
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

    for (const page of PAGES) {
        if (!emitted.has(page.file)) {
            continue;
        }
        assertThePage(page, readFileSync(join(distDirectory, page.file), 'utf8'), base, origin, emitted);
    }

    if (failures.length === 0) {
        process.stdout.write(
            `assert-build: ${checks} assertions hold over ${emitted.size} files and ${PAGES.length} pages, ` +
                `every internal reference under ${base}/.\n`,
        );
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
