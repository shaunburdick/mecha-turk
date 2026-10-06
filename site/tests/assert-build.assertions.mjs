/**
 * The build-output assertions, proved able to fail.
 *
 * `scripts/assert-build.mjs` is the site's only gate, and a gate that has only
 * ever been seen green is an assumption wearing a check's clothes. So this builds
 * a conforming five-page output in a temporary directory, confirms the script
 * accepts it, and then breaks it one way at a time and confirms it refuses —
 * every assertion it makes, once.
 *
 * The fixture is written here rather than read from `dist/` on purpose. The real
 * output changes as the pages are written (four of the five do not exist yet),
 * and a fixture that tracked it could stop testing the script's logic and start
 * testing the site's current state. What is shared with the script is read from
 * the one file that declares it, `astro.config.ts`, so a repository rename moves
 * both at once.
 *
 * The `.assertions.mjs` name is deliberate, for the reason
 * `base-path.assertions.mjs` sets out: the repository's vitest has no config
 * file, so its default include globs every `test`-suffixed file from the
 * repository root and would collect this one into the repository's own gate,
 * which FR-070 says must not notice `site/` at all.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(SITE_ROOT, 'scripts', 'assert-build.mjs');

/** The five pages AC-001 names, read from the one file that declares the site's base path. */
const { base } = readDeclaredSite();

const FIXTURE_PAGES = [
    { address: '/', title: 'Mecha Turk', file: 'index.html' },
    { address: '/install/', title: 'Install', file: 'install/index.html' },
    { address: '/configure/', title: 'Configure', file: 'configure/index.html' },
    { address: '/use/', title: 'Use', file: 'use/index.html' },
    { address: '/debug/', title: 'Debug', file: 'debug/index.html' },
];

/** An off-origin repository, which is what the footer's two links point at by necessity. */
const REPOSITORY_URL = 'https://github.com/shaunburdick/mecha-turk';

const temporaryDirectories = [];

/**
 * @returns {{ base: string, origin: string }} The site's declared base path and canonical origin.
 */
function readDeclaredSite() {
    const config = readFileSync(join(SITE_ROOT, 'astro.config.ts'), 'utf8');
    const base = /^\s*base:\s*'([^']+)'/m.exec(config);
    const site = /^\s*site:\s*'([^']+)'/m.exec(config);
    assert.ok(base !== null, 'astro.config.ts declares a base path');
    assert.ok(site !== null, 'astro.config.ts declares a canonical site');
    return { base: base[1].replace(/\/+$/, ''), origin: new URL(site[1]).origin };
}

/**
 * The literal marker `/configure/` documents, in the shape the build emits it.
 *
 * Part of the conforming page rather than of a case, because the gate asserts twice over
 * it: the shape check refuses an **unmarked** one, and a separate assertion refuses an
 * output that declares none at all. A fixture without it would make the first of those
 * the only one reachable.
 */
const LITERAL_MARKER = '<p><code data-literal-marker="true">{number}</code> arrives as those characters.</p>';

/**
 * The roles a conforming page declares, per preference.
 *
 * Every role the audit reads is here rather than only the four an earlier version
 * needed: `assert-build.mjs` asserts each one is *declared* before it measures
 * against it, so a fixture that carried four would make that presence check
 * untestable — the fixture is what proves the palette is found, and a page missing
 * `--muted` is a page whose muted text nobody measured.
 *
 * The values are the ones the site shipped when this fixture was written, so a
 * negative case perturbs the palette a reader actually gets. `--rule` is never
 * measured, because it is a border colour and NFR-004 bounds text.
 */
const LIGHT_ROLES = [
    '--text:#111111',
    '--muted:#595f68',
    '--link:#0a4a8f',
    '--signal:#b4492c',
    '--hero-text:#f5f6ef',
    '--hero-link:#a8f0e7',
    '--rule:#d4d4d4',
    '--page:#ffffff',
    '--surface:#f6f6f6',
    '--elevated:#ffffff',
    '--code:#f0f0f0',
    '--hero:#08263b',
    '--table-head:#102f43',
].join(';');
const DARK_ROLES = [
    '--text:#f1f3f5',
    '--muted:#b9c0c8',
    '--link:#8fc5ff',
    '--signal:#ff9b75',
    '--hero-text:#f4f6ef',
    '--hero-link:#a8f0e7',
    '--rule:#59616c',
    '--page:#17191c',
    '--surface:#25292e',
    '--elevated:#2b313a',
    '--code:#20242b',
    '--hero:#061b2a',
    '--table-head:#061c2a',
].join(';');

/**
 * The painted surfaces a conforming page declares, in the form the audit can read.
 *
 * Two properties of this stylesheet are load-bearing rather than incidental:
 *
 * - **Colour is declared as `background-color`.** The audit resolves the colour a surface
 *   paints and refuses an image layer rather than approximating the colour under it, so a
 *   conforming fixture writes `background-color` and keeps any decoration in
 *   `background-image` — the same form `site/src/layout.astro` is held to.
 * - **Every surface the pairs name is painted.** The audit walks a surface's own selector
 *   and then its ancestor chain, and a walk that ends on nothing is itself an assertion.
 *   A fixture missing one of these would prove nothing about the pairs that read it.
 */
const PAINTED_SURFACES = [
    'body{background-color:var(--page);color:var(--text)}',
    'nav{background-color:var(--elevated)}',
    'footer{background-color:var(--elevated)}',
    'h1 + p{background-color:var(--surface);color:var(--muted)}',
    'main > h1 + section{background-color:var(--hero);color:var(--hero-text)}',
    'main > h1 + section a{color:var(--hero-link)}',
    'table{background-color:var(--elevated)}',
    'caption{background-color:var(--surface);color:var(--signal)}',
    'thead th{background-color:var(--table-head);color:var(--hero-text)}',
    'tbody tr:nth-child(even){background-color:var(--surface)}',
    'code{background-color:var(--code)}',
    'pre{background-color:var(--code)}',
    'a{color:var(--link)}',
].join('');

/**
 * WCAG 2.2's contrast ratio, computed here so the expected figures below are an
 * independent evaluation rather than a transcription of whatever the script last printed.
 *
 * @param {string} foreground The text colour, `#rgb` or `#rrggbb`.
 * @param {string} background What it is drawn on, in the same form.
 * @returns {number} Their ratio, from 1 to 21.
 */
function contrastRatio(foreground, background) {
    const luminance = (colour) => {
        const digits = colour.replace('#', '');
        const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits;
        const channels = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));

        return channels
            .map((channel) => channel / 255)
            .map((proportion) =>
                proportion <= 0.039_28 ? proportion / 12.92 : ((proportion + 0.055) / 1.055) ** 2.4,
            )
            .reduce((total, value, at) => total + value * [0.2126, 0.7152, 0.0722][at], 0);
    };
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));

    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The one piece of prose the negative cases rewrite.
 *
 * Every "break this page" case needs a *body-copy* anchor rather than any one of the
 * sentences below: the markers, the trace tokens, and the heading shapes are all written
 * against a phrase that is ordinary prose, so a fixture that spread its copy over several
 * sentences would make each of those cases name a string of its own.
 */
const BODY_COPY = 'The dispatch is recorded on the service.';

/**
 * The heading the empty-heading cases rewrite.
 *
 * Named as a constant for the same reason {@link BODY_COPY} is: an empty `<h2>` is only
 * findable if the fixture carries a heading with text in it, and a case that spelled the
 * heading out would break the moment the fixture's prose changed.
 */
const LEAD_HEADING = '<h2>Lead surface</h2>';

/**
 * The markup a conforming page carries for the surfaces above to exist in.
 *
 * The lead surface, the lead paragraph, and the table all sit in `<main>` in the shape the
 * selectors above name, so a fixture that dropped the markup would stop exercising the
 * placement those selectors depend on.
 */
const PAINTED_MARKUP = [
    '<h1>Field manual</h1>',
    '<p>The lead paragraph.</p>',
    `<section><h2>Lead surface</h2><p>${BODY_COPY}</p>`,
    `<p><a href="${base}/use/">A link</a></p>`,
    '<table><caption>Terms</caption><thead><tr><th scope="col">A</th></tr></thead>',
    '<tbody><tr><th scope="row">term</th><td><code>value</code></td></tr>',
    '<tr><th scope="row">term two</th><td>text</td></tr></tbody></table>',
].join('');

/**
 * Overlay declarations onto a role set, so a negative case names only the token it
 * perturbs.
 *
 * Reading the whole palette out of the call site meant every case repeated the six
 * tokens it did not care about, and one case did repeat five of six with a seventh
 * missing — which the presence check would then have reported as the reason the
 * page failed, rather than the contrast case it was written to prove.
 *
 * @param {string} roles The full role set.
 * @param {string} [overrides] `name:value` pairs separated by `;`.
 * @returns {string} The merged `name:value` list.
 */
function withRoles(roles, overrides = '') {
    const declared = new Map(
        roles.split(';').filter((entry) => entry !== '').map((entry) => {
            const [name, ...rest] = entry.split(':');
            return [name.trim(), rest.join(':').trim()];
        }),
    );
    for (const entry of overrides.split(';').filter((candidate) => candidate.trim() !== '')) {
        const [name, ...rest] = entry.split(':');
        declared.set(name.trim(), rest.join(':').trim());
    }

    return [...declared].map(([name, value]) => `${name}:${value}`).join(';');
}

/**
 * A page that satisfies every clause of the contract: one `h1`, a labelled
 * navigation region carrying all five addresses, an inlined stylesheet that
 * fetches nothing and whose palette clears NFR-004's contrast floor, one content
 * section, and a footer linking the license file in the repository.
 *
 * @param {{ address: string, title: string }} page The page to render.
 * @param {string} [extra] Markup appended inside `<main>`.
 * @param {string} [roles] `:root` declarations to override in the light preference.
 * @param {string} [darkRoles] The same, for the dark preference.
 * @returns {string} The page's markup.
 */
function conformingPage(page, extra = '', roles = '', darkRoles = '') {
    const palette = withRoles(LIGHT_ROLES, roles);
    const darkPalette = withRoles(DARK_ROLES, darkRoles);
    const links = FIXTURE_PAGES.map((target) => {
        const href = `${base}${target.address}`;
        const current = href === `${base}${page.address}` ? ' aria-current="page"' : '';
        return `<li><a href="${href}"${current}>${target.title}</a></li>`;
    }).join('');
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        `<title>${page.title} · Mecha Turk</title>` +
        `<style>:root{color-scheme:light;${palette}}` +
        `@media (prefers-color-scheme: dark){:root{color-scheme:dark;${darkPalette}}}` +
        `${PAINTED_SURFACES}</style>` +
        '</head><body>' +
        `<nav aria-label="Documentation pages"><ul>${links}</ul></nav>` +
        `<main>${PAINTED_MARKUP}${LITERAL_MARKER}${extra}</main>` +
        '<footer><ul>' +
        `<li><a href="${REPOSITORY_URL}">Source repository</a></li>` +
        `<li><a href="${REPOSITORY_URL}/blob/main/LICENSE">MIT license</a></li>` +
        '</ul></footer></body></html>'
    );
}

/**
 * The conforming output: five files, five pages, nothing else.
 *
 * @returns {Map<string, string>} Emitted path → contents, as `dist/`-relative paths.
 */
function conformingOutput() {
    return new Map(FIXTURE_PAGES.map((page) => [page.file, conformingPage(page)]));
}

/**
 * Materialise an output on disk.
 *
 * @param {Map<string, string>} files The output to write.
 * @returns {string} The directory it was written to.
 */
function writeOutput(files) {
    const root = mkdtempSync(join(tmpdir(), 'assert-build-'));
    temporaryDirectories.push(root);
    for (const [file, contents] of files) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, contents);
    }
    return root;
}

/**
 * Run the assertions over an output.
 *
 * @param {string} directory The output's directory.
 * @returns {{ status: number, output: string }} The exit status and everything it printed.
 */
function assertBuild(directory) {
    const run = spawnSync(process.execPath, [SCRIPT, directory], { encoding: 'utf8' });
    assert.equal(run.error, undefined, `the script ran: ${run.error?.message ?? ''}`);
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/**
 * @param {Map<string, string>} files An output.
 * @param {string} file One of its pages.
 * @returns {string} That page's markup.
 */
function pageOf(files, file) {
    return files.get(file) ?? '';
}

/**
 * @param {Map<string, string>} files An output.
 * @param {string} file One of its pages.
 * @param {string} markup Its replacement markup.
 */
function replacePage(files, file, markup) {
    files.set(file, markup);
}

/**
 * Every way the contract can be broken, one assertion each.
 *
 * Each entry names the assertion the script must report, so the negative test
 * checks the *right* assertion refused rather than merely that something did.
 * The fixture is rebuilt per entry, so no case can mask another by leaving a
 * previous break in place.
 */
const VIOLATIONS = [
    {
        name: 'a page that was never built',
        assertion: 'AC-001 the five pages, and no further page',
        break: (files) => files.delete('use/index.html'),
    },
    {
        name: 'a page beyond the five',
        assertion: 'AC-001 the five pages, and no further page',
        break: (files) => files.set('404.html', conformingPage(FIXTURE_PAGES[0])),
    },
    {
        name: 'an internal link with the base dropped',
        assertion: 'AC-002 every internal link is under the base path',
        break: (files) => replacePage(files, 'debug/index.html', pageOf(files, 'debug/index.html').replaceAll(`${base}/install/`, '/install/')),
    },
    {
        name: 'an internal link without its trailing slash',
        assertion: 'AC-002 every internal link is in directory form',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replaceAll(`${base}/debug/`, `${base}debug`)),
    },
    {
        name: 'an internal link to a page that does not exist',
        assertion: 'AC-002 every internal link resolves to a page that exists',
        break: (files) => replacePage(files, 'install/index.html', pageOf(files, 'install/index.html').replaceAll(`${base}/configure/`, `${base}/nowhere/`)),
    },
    {
        name: 'a page missing one of the five navigation targets',
        assertion: 'AC-003 every page links all five pages',
        break: (files) => replacePage(files, 'configure/index.html', pageOf(files, 'configure/index.html').replace(`<li><a href="${base}/debug/">Debug</a></li>`, '')),
    },
    {
        name: 'a remote stylesheet',
        assertion: 'FR-010 no off-origin resource reference',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</head>', '<link rel="stylesheet" href="https://cdn.example.com/site.css"></head>')),
    },
    {
        name: 'a preconnect, which is a request with no content in it',
        assertion: 'FR-010 no off-origin resource reference',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</head>', '<link rel="preconnect" href="https://cdn.example.com"></head>')),
    },
    {
        name: 'a remote font imported by the inlined stylesheet',
        assertion: 'FR-010 no off-origin resource reference',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</style>', '@import url("https://fonts.example.com/inter.css");</style>')),
    },
    {
        name: 'a remote background image in a `style` attribute',
        // A `style` attribute is a stylesheet body, so `url()` in it is a request — and the
        // URL is not the attribute's whole value, which is why no entry in
        // `RESOURCE_POSITIONS` can see it and why it is routed through
        // `assertInlineStylesheet` instead of being listed.
        assertion: 'FR-010 no off-origin resource reference',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('<main>', '<main><div style="background:url(https://cdn.example.com/a.gif)">Mecha Turk</div>')),
    },
    {
        name: 'a base element pointing at another origin',
        assertion: 'FR-010 no off-origin resource reference',
        break: (files) => replacePage(files, 'install/index.html', pageOf(files, 'install/index.html').replace('</head>', '<base href="https://cdn.example.com/"></head>')),
    },
    {
        name: 'a base element that drops the published base path',
        assertion: 'AC-002 every resource is under the base path',
        break: (files) => replacePage(files, 'install/index.html', pageOf(files, 'install/index.html').replace('</head>', '<base href="/"></head>')),
    },
    {
        name: 'a meta refresh to another origin',
        // Treated as a resource reference, not ignored: it is a navigation the page performs
        // with no reader's click in it, which is the shape NFR-003 forbids rather than the
        // shape it exempts (`<a href>`, a hyperlink the reader may choose to follow).
        assertion: 'FR-010 no off-origin resource reference',
        break: (files) => replacePage(files, 'debug/index.html', pageOf(files, 'debug/index.html').replace('</head>', '<meta http-equiv="refresh" content="0;url=https://evil.example.com/"></head>')),
    },
    {
        name: 'a script reference with the base dropped',
        assertion: 'AC-002 every resource is under the base path',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</head>', '<script src="/app.js"></script></head>')),
    },
    {
        name: 'a same-origin resource the build never emitted',
        assertion: 'AC-002 every resource resolves to a file that exists',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</head>', `<link rel="stylesheet" href="${base}/site.css"></head>`)),
    },
    {
        name: 'a script file in the output',
        assertion: 'NFR-002 no script file',
        break: (files) => files.set('_astro/app.js', 'console.log(1);\n'),
    },
    {
        name: 'a script element on a page',
        assertion: 'NFR-002 no script element',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('</body>', `<script>${base};</script></body>`)),
    },
    {
        name: 'a manual dark-theme toggle',
        assertion: 'AC-032 no manual theme toggle',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</main>', '<button aria-label="Toggle dark theme">Dark mode</button></main>')),
    },
    {
        name: 'an event-handler attribute',
        assertion: 'NFR-002 no event-handler attribute',
        break: (files) => replacePage(files, 'debug/index.html', pageOf(files, 'debug/index.html').replace('<body>', '<body onload="boot()">')),
    },
    {
        name: 'an image file in the output',
        assertion: 'AC-004 no image file',
        break: (files) => files.set('favicon.ico', 'not really an icon\n'),
    },
    {
        name: 'an image element on a page',
        assertion: 'AC-004 no image',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('<main>', `<main><img src="${base}/logo.png" alt="Mecha Turk">`)),
    },
    {
        name: 'a second top-level heading',
        assertion: 'AC-005 exactly one top-level heading',
        break: (files) => replacePage(files, 'install/index.html', pageOf(files, 'install/index.html').replace('</main>', '<h1>Install</h1></main>')),
    },
    {
        name: 'a deeper heading ahead of the top-level one',
        assertion: 'NFR-004 the headings start at the top level',
        break: (files) => replacePage(files, 'install/index.html', pageOf(files, 'install/index.html').replace('<main><h1>', '<main><h2>Before</h2><h1>')),
    },
    {
        name: 'a second navigation region',
        assertion: 'AC-005 a navigation region',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('</main>', '<nav aria-label="Section"></nav></main>')),
    },
    {
        name: 'a navigation region with no accessible name',
        assertion: 'AC-005 the navigation region has an accessible name',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<nav aria-label="Documentation pages">', '<nav>')),
    },
    {
        name: 'a footer with no link to the license file',
        assertion: 'AC-005 a footer carrying the license link',
        break: (files) => replacePage(files, 'debug/index.html', pageOf(files, 'debug/index.html').replace(`<li><a href="${REPOSITORY_URL}/blob/main/LICENSE">MIT license</a></li>`, '')),
    },
    {
        name: 'a page left unfinished',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'configure/index.html', pageOf(files, 'configure/index.html').replace(`<p>${BODY_COPY}</p>`, '<p>Coming soon.</p>')),
    },
    {
        name: 'a template marker',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace(`<p>${BODY_COPY}</p>`, '<p>{{ notFilled }}</p>')),
    },
    {
        name: 'an expression that reached the output instead of being evaluated',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace(`<p>${BODY_COPY}</p>`, '<p>{pageTitle}</p>')),
    },
    {
        name: 'an empty section heading',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace(LEAD_HEADING, '<h2></h2>')),
    },
    {
        name: 'a section heading whose only content rendered nothing',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace(LEAD_HEADING, '<h2 class="x">\n    </h2>')),
    },
    {
        name: 'a body colour that fails the contrast floor',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:#bbbbbb')),
    },
    {
        name: 'a link colour that fails on the page background',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--link:#c8c8c8')),
    },
    {
        name: 'a body colour that fails on the surface the footer sits on',
        // The footer's surface is `--elevated`, and `#767676` on `#e4e4e4` is the
        // *isolating* choice, measured rather than guessed: at 4.72:1 on the fixture's
        // `#ffffff` page it passes the page pair and fails the footer pair alone. A colour
        // that failed both would pass this test while proving nothing about which surface
        // was measured — the defect this whole case list exists to catch is an audit that
        // measures the wrong surface.
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:#767676;--elevated:#e4e4e4')),
    },
    {
        name: 'a link colour that fails on the surface the footer sits on',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--link:#9a9a9a;--elevated:#e4e4e4')),
    },
    {
        name: 'a muted colour that fails on the lead paragraph it opens',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--muted:#8f8f8f')),
    },
    {
        name: 'a signal colour that fails on a table caption band',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--signal:#a8a8a8')),
    },
    {
        name: 'a muted colour that fails on the navigation it opens',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--muted:#949494')),
    },
    {
        name: 'a lead-surface colour that fails against the ink it sits on',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--hero-text:#3d5a6b')),
    },
    {
        name: 'a lead-surface link colour that fails against the ink it sits on',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--hero-link:#3f6470')),
    },
    {
        name: 'a dark-palette table header that fails against its own band',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '', '--hero-text:#3c4750')),
    },
    {
        name: 'a missing dark preference palette',
        assertion: 'AC-032 both preference palettes are declared',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace(/@media \(prefers-color-scheme: dark\)\{:root\{[^}]*\}\}/, '')),
    },
    {
        name: 'a dark preference that selects the light color scheme',
        assertion: 'AC-032 each preference selects its matching color scheme',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '', '--page:#17191c').replace('@media (prefers-color-scheme: dark){:root{color-scheme:dark;', '@media (prefers-color-scheme: dark){:root{color-scheme:light;')),
    },
    {
        name: 'a stylesheet that declares no palette for the audit to read',
        // The non-vacuity case, and the reason it is its own entry: an audit that finds no
        // tokens reports no failures for a page whose text colour it never looked at, so
        // deleting `:root` must fail rather than turn the contrast check off.
        assertion: 'NFR-004 the declared text colours are audited',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace(/:root\{[^}]*\}/, '')),
    },
    {
        // The presence check is per role, not per palette: a stylesheet that still declares
        // `--text` has a palette, so only removing the *one role a pair reads* can show that
        // the audit names it rather than merely counting tokens.
        name: 'a palette missing one role the pairs read',
        assertion: 'NFR-004 the declared text colours are audited',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0]).replace('--muted:#595f68;', '')),
    },
    {
        name: 'a body with no background for the floor to measure against',
        assertion: 'NFR-004 the declared text colours are audited',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('background-color:var(--page);', '')),
    },
    {
        // The chain non-vacuity check, per surface rather than once: `body` is where every
        // other surface's walk ends, so an audit that only checked `body` would report
        // nothing here. `caption`'s own band is removed **and** the canvas it falls through
        // to, because a walk that resolves to an ancestor is the cascade working — the
        // finding is a walk that ends on nothing.
        name: 'a measured surface whose whole walk paints no colour',
        assertion: 'NFR-004 the declared text colours are audited',
        break: (files) =>
            replacePage(
                files,
                'index.html',
                pageOf(files, 'index.html')
                    .replace('caption{background-color:var(--surface);', 'caption{')
                    .replace('body{background-color:var(--page);', 'body{'),
            ),
    },
    {
        name: 'a surface painted with an image layer the audit cannot read',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('caption{background-color:var(--surface);', 'caption{background:linear-gradient(90deg,var(--surface),transparent);')),
    },
    {
        name: 'a layered background shorthand on a measured surface',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('table{background-color:var(--elevated)}', 'table{background:var(--elevated) url(none.png)}')),
    },
    {
        name: 'a background behind a selector the audit cannot place',
        assertion: 'NFR-004 the declared text colours are audited',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</style>', 'main .card{background-color:#eeeeee}</style>')),
    },
    {
        name: 'a background painted only inside a viewport-dependent at-rule',
        assertion: 'NFR-004 the declared text colours are audited',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('</style>', '@media (min-width: 40rem){nav{background-color:#eeeeee}}</style>')),
    },
    {
        name: 'a colour written in a form the audit cannot read',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:rgb(17,17,17)')),
    },
];

/**
 * The four markup shapes FR-052 forbids and no token list can reach.
 *
 * Split from `MARKERS_THAT_MUST_FAIL` because that list is a *vocabulary* and this one is
 * *syntax* — a page can be unfinished in every entry here while carrying none of its words.
 * Each asserts the shape is named, so a failure says which one slipped past.
 */
const SHAPES_THAT_MUST_FAIL = [
    { name: 'a template marker', markup: '<p>{{ notFilled }}</p>' },
    { name: 'a template marker with a sentence in it', markup: '<p>{{ describe this later }}</p>' },
    { name: 'an unresolved expression', markup: '<p>{pageTitle}</p>' },
    { name: 'an unresolved expression with member access', markup: '<p>{page.title}</p>' },
    { name: 'an empty section heading', markup: '<h2></h2>' },
    { name: 'a section heading with nothing but an expression that rendered nothing', markup: '<h3>  </h3>' },
    { name: 'an empty heading carrying attributes', markup: '<h4 class="lead" id="x"></h4>' },
];

/**
 * The other half of AC-006: the marker's *shape*.
 *
 * The gate matches each token whole rather than as a substring, because a substring
 * test fails the shipped prose — the configure page prints the service's own sentence
 * "text sent to the agent verbatim, with no placeholders", and AC-006 was refusing the
 * service for promising that substitution does not happen. Narrowing a check is only
 * worth doing if what it used to catch still fails, so every entry here is a marker a
 * reader would see as unfinished, in the two shapes that matter: a word standing alone,
 * and a word followed by punctuation. Both must be refused.
 *
 * Each case asserts the *token* is named, so a failure says which marker slipped past
 * rather than merely that something did.
 */
const MARKERS_THAT_MUST_FAIL = [
    { name: 'a bare word', markup: '<p>TODO</p>' },
    { name: 'a word with a colon', markup: '<p>TODO: name the two steps.</p>' },
    { name: 'a word with a full stop', markup: '<p>Write this last. FIXME.</p>' },
    { name: 'a word inside an em', markup: '<p>The <em>copy</em> is <strong>TBD</strong>.</p>' },
    { name: 'a word after a slash, in prose', markup: '<p>Fix the panel/TBD path.</p>' },
    { name: 'a hyphenated phrase', markup: '<p>Under-construction for now.</p>' },
    { name: 'a spaced phrase across a line wrap', markup: '<p>\n    The page is\n    coming soon.\n</p>' },
    { name: 'a word in a heading', markup: '<h2>Lorem ipsum</h2>' },
    { name: 'a word after a slash', markup: '<p>Fix the panel/TBD path.</p>' },
];

/**
 * The words that are *not* markers, in the shapes the shipped pages actually carry them.
 *
 * These are the cases that made a substring test unusable: a plural, an identifier, a
 * filename, a sentence the service states about itself. A gate that refuses these is a
 * gate a contributor routes around, and AC-006 would end up protecting nothing.
 */
const WORDS_THAT_MUST_PASS = [
    { name: 'the plural of a marker', markup: '<p>with no placeholders; the text is sent verbatim</p>' },
    { name: 'a marker inside a filename', markup: '<p>The file <code>todos.json</code> is not one.</p>' },
    { name: 'a marker inside an identifier', markup: '<p>The field <code>todoCount</code> holds a number.</p>' },
    { name: 'a hyphenated identifier', markup: '<p>It writes <code>tbd-rows.json</code> on disk.</p>' },
    { name: 'a dotfile', markup: '<p>A <code>.todo</code> file, if one appears.</p>' },
    { name: 'a dotted filename', markup: '<p>The store holds <code>todo.md</code> alongside.</p>' },
];

/**
 * The markup that has to survive the shape check, in the shapes the shipped pages actually
 * carry it.
 *
 * The first entry is the one this check could have made impossible. `/configure/` documents
 * that the starting prompt is sent verbatim *by printing the marker*, so the built page
 * carries a `{number}` that no build ever evaluated — a check for an unresolved expression
 * without an exemption would refuse the site it exists to protect. The exemption is the
 * `data-literal-marker` attribute rather than an HTML comment, because Astro strips comments
 * from a template: a comment would scope the exemption in the source and vanish from the
 * built page, leaving the scan reading the marker in one and not the other.
 */
const SHAPES_THAT_MUST_PASS = [
    {
        name: 'the literal marker /configure/ documents, marked as one',
        markup: '<p><code data-literal-marker="true">{number}</code> arrives as those characters.</p>',
    },
    // An expression that evaluated leaves no braces in the output at all — the site
    // renders the *value*, so a conforming page's body copy here is already the shape an
    // evaluated expression produces. Asserting the pass on that is what stops the pattern
    // above being widened until it refuses ordinary prose.
    { name: 'an expression that evaluated', markup: '<p>The state is recorded on the dispatch.</p>' },
    { name: 'a heading with text in it', markup: '<h2>How a dispatch is authorized</h2>' },
    { name: 'a heading wrapping onto the next line', markup: '<h2>\n    Section\n</h2>' },
];

after(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('assert-build', () => {
    test('accepts an output that satisfies the contract', () => {
        const run = assertBuild(writeOutput(conformingOutput()));
        assert.equal(run.status, 0, run.output);
        assert.match(run.output, /assertions hold over 5 files and 5 pages/);
    });

    // Both preference cascades are read independently, so "it measured the dark palette"
    // has to be shown rather than implied: the only failure reported must be the dark one,
    // naming the dark page colours and the dark pair — and the light cascade must be
    // silent, or the audit would be reading one cascade twice.
    test('red-first: refuses a dark body palette below the contrast floor', () => {
        const files = conformingOutput();
        replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '', '--text:#555555'));
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted dark body text below 4.5:1');
        assert.match(
            run.output,
            new RegExp(
                `dark preference\\): body text on the page is \`#555555\` on \`#17191c\`, a contrast ratio of ` +
                    `${contrastRatio('#555555', '#17191c').toFixed(2)}:1`,
            ),
        );
        assert.doesNotMatch(run.output, /light preference\):/);
    });

    // The counterpart: a page whose *light* palette fails while its dark one passes is the
    // case a single-cascade audit would miss entirely, so it is a separate test rather than
    // the same fixture read twice.
    test('red-first: refuses a light body palette below the contrast floor', () => {
        const files = conformingOutput();
        replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:#808080'));
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted light body text below 4.5:1');
        assert.match(
            run.output,
            new RegExp(
                `light preference\\): body text on the page is \`#808080\` on \`#ffffff\`, a contrast ratio of ` +
                    `${contrastRatio('#808080', '#ffffff').toFixed(2)}:1`,
            ),
        );
        assert.doesNotMatch(run.output, /dark preference\): body text on the page/);
    });

    test('refuses an output that was never built, rather than passing on an empty directory', () => {
        const missing = mkdtempSync(join(tmpdir(), 'assert-build-none-'));
        temporaryDirectories.push(missing);
        const run = assertBuild(join(missing, 'dist'));
        assert.notEqual(run.status, 0);
        assert.match(run.output, /run `npm run build` first/);
    });

    for (const violation of VIOLATIONS) {
        test(`refuses ${violation.name}`, () => {
            const files = conformingOutput();
            violation.break(files);
            const run = assertBuild(writeOutput(files));
            assert.notEqual(run.status, 0, `the script accepted an output with ${violation.name}`);
            assert.ok(
                run.output.includes(`FAIL [${violation.assertion}]`),
                `expected the report to carry [${violation.assertion}] for ${violation.name}, got:\n${run.output}`,
            );
        });
    }

    for (const marker of MARKERS_THAT_MUST_FAIL) {
        test(`still refuses ${marker.name}`, () => {
            // The narrowing is only sound if what it used to catch still fails, so each
            // of these is measured rather than argued: the gate must exit non-zero and
            // name the token, not merely fail on something.
            const files = conformingOutput();
            replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace(`<p>${BODY_COPY}</p>`, marker.markup));
            const run = assertBuild(writeOutput(files));

            assert.notEqual(run.status, 0, `the script accepted ${marker.markup}`);
            assert.ok(
                run.output.includes('AC-006 no placeholder or unfinished marker'),
                `expected AC-006 to refuse ${marker.markup}, got:\n${run.output}`,
            );
        });
    }

    for (const word of WORDS_THAT_MUST_PASS) {
        test(`accepts ${word.name}`, () => {
            const files = conformingOutput();
            replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace(`<p>${BODY_COPY}</p>`, word.markup));
            const run = assertBuild(writeOutput(files));

            assert.equal(run.status, 0, `the script refused ${word.markup}:\n${run.output}`);
        });
    }

    for (const shape of SHAPES_THAT_MUST_FAIL) {
        test(`refuses ${shape.name}`, () => {
            const files = conformingOutput();
            replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace(`<p>${BODY_COPY}</p>`, shape.markup));
            const run = assertBuild(writeOutput(files));

            assert.notEqual(run.status, 0, `the script accepted ${shape.markup}`);
            assert.ok(
                run.output.includes('AC-006 no placeholder or unfinished marker'),
                `expected AC-006 to refuse ${shape.markup}, got:\n${run.output}`,
            );
        });
    }

    for (const shape of SHAPES_THAT_MUST_PASS) {
        test(`accepts ${shape.name}`, () => {
            const files = conformingOutput();
            replacePage(files, 'configure/index.html', pageOf(files, 'configure/index.html').replace(`<p>${BODY_COPY}</p>`, shape.markup));
            const run = assertBuild(writeOutput(files));

            assert.equal(run.status, 0, `the script refused ${shape.markup}:\n${run.output}`);
        });
    }

    test('reports the ratio it computed, for every pair, on the shipped palette', () => {
        // The audit's own figures, asserted rather than eyeballed. Two properties at once:
        //
        // 1. **The figures are the ones a browser computes.** `#111111` on `#ffffff` is
        //    18.88:1 and `#0a4a8f` on `#f6f6f6` is 8.13:1, measured independently of this
        //    script. Asserting the exact strings is what stops the audit from quietly
        //    computing something else and still passing — a check that reports a ratio
        //    nobody verified is a check that has stopped measuring.
        // 2. **The footer is measured on the surface it is painted, not on the page.** The
        //    pair names the colour the footer background rule resolves
        //    to. This is the assertion that would have failed had the footer been resolved
        //    by token lookup and come back empty, and the assertion that keeps it honest
        //    now that it resolves.
        const files = conformingOutput();
        const run = assertBuild(writeOutput(files));

        // The expected ratios are **computed here**, from WCAG 2.2's own definition of relative
        // luminance, rather than transcribed from a run of the script. A transcribed figure
        // would only prove the two strings agree with whatever the script last printed; a
        // computed one is an independent evaluation of the same two colours, which is what
        // makes this an assertion about the arithmetic rather than about a string. The two
        // agree to the two decimals the audit prints.
        assert.equal(run.status, 0, run.output);
        for (const [where, foreground, background] of [
            ['light body text on the page', '#111111', '#ffffff'],
            ['light a link on the page', '#0a4a8f', '#ffffff'],
            ['light muted text on the page', '#595f68', '#ffffff'],
            ['light a generated index on the page', '#b4492c', '#ffffff'],
            ['light the lead paragraph', '#595f68', '#f6f6f6'],
            ['light body text in a section', '#111111', '#ffffff'],
            ['light a link in a section', '#0a4a8f', '#ffffff'],
            ['light body text in the lead surface', '#f5f6ef', '#08263b'],
            ['light a link in the lead surface', '#a8f0e7', '#08263b'],
            ['light a navigation link', '#595f68', '#ffffff'],
            ['light the current page in the navigation', '#b4492c', '#ffffff'],
            ['light body text in the footer', '#111111', '#ffffff'],
            ['light a link in the footer', '#0a4a8f', '#ffffff'],
            ['light a table caption on its band', '#b4492c', '#f6f6f6'],
            ['light a table header', '#f5f6ef', '#102f43'],
            ['light body text in a table', '#111111', '#ffffff'],
            ['light a link in a table', '#0a4a8f', '#ffffff'],
            ['light body text in a banded table row', '#111111', '#f6f6f6'],
            ['light inline code on its chip', '#111111', '#f0f0f0'],
            ['light a code block', '#111111', '#f0f0f0'],
            ['dark body text on the page', '#f1f3f5', '#17191c'],
            ['dark a link on the page', '#8fc5ff', '#17191c'],
            ['dark muted text on the page', '#b9c0c8', '#17191c'],
            ['dark a generated index on the page', '#ff9b75', '#17191c'],
            ['dark the lead paragraph', '#b9c0c8', '#25292e'],
            ['dark body text in a section', '#f1f3f5', '#17191c'],
            ['dark a link in a section', '#8fc5ff', '#17191c'],
            ['dark body text in the lead surface', '#f4f6ef', '#061b2a'],
            ['dark a link in the lead surface', '#a8f0e7', '#061b2a'],
            ['dark a navigation link', '#b9c0c8', '#2b313a'],
            ['dark the current page in the navigation', '#ff9b75', '#2b313a'],
            ['dark body text in the footer', '#f1f3f5', '#2b313a'],
            ['dark a link in the footer', '#8fc5ff', '#2b313a'],
            ['dark a table caption on its band', '#ff9b75', '#25292e'],
            ['dark a table header', '#f4f6ef', '#061c2a'],
            ['dark body text in a table', '#f1f3f5', '#2b313a'],
            ['dark a link in a table', '#8fc5ff', '#2b313a'],
            ['dark body text in a banded table row', '#f1f3f5', '#25292e'],
            ['dark inline code on its chip', '#f1f3f5', '#20242b'],
            ['dark a code block', '#f1f3f5', '#20242b'],
        ]) {
            assert.ok(
                run.output.includes(
                    `NFR-004 contrast — ${where}: ${foreground} on ${background}, ` +
                        `${contrastRatio(foreground, background).toFixed(2)}:1`,
                ),
                `expected the audit to report \`${where}\` as \`${foreground} on ${background}, ` +
                    `${contrastRatio(foreground, background).toFixed(2)}:1\`, got:\n${run.output}`,
            );
        }
    });

    test('reads the surface a background rule paints, not the token behind it', () => {
        // The cascade, as a behaviour rather than as a comment. The footer's background is
        // repainted with a literal no custom property holds, so an audit resolving the pair
        // by token name would measure `--elevated` and report a ratio for a colour the page
        // no longer draws. Only reading the rule gets the right answer.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace(
                '</style>',
                '@media (prefers-color-scheme: light){footer{background-color:#fbfbfb}}</style>',
            ),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, `a literal footer background failed the audit:\n${run.output}`);
        assert.ok(
            run.output.includes(`light a link in the footer: #0a4a8f on #fbfbfb, ${contrastRatio('#0a4a8f', '#fbfbfb').toFixed(2)}:1`),
            `the audit measured the custom property rather than the background the footer paints:\n${run.output}`,
        );
        // And the *dark* cascade is unaffected by a light-only repaint, which is what makes
        // this a test of two independent reads rather than of one rule.
        assert.ok(
            run.output.includes('dark a link in the footer: #8fc5ff on #2b313a'),
            `a light-only background leaked into the dark cascade:\n${run.output}`,
        );
    });

    test('inherits the surface up the chain when an element declares none', () => {
        // The other half of the cascade: the footer's background deleted. `background` is
        // transparent by default, so the footer shows `body`'s `--page` — and the ratio must
        // move to the page pair's rather than the audit reporting the surface as unreadable.
        // A walk that resolves to *nothing* is a separate finding (the body case covers it);
        // a walk that resolves to an ancestor is the cascade working.
        const files = new Map(conformingOutput());
        replacePage(files, 'index.html', pageOf(files, 'index.html').replace('footer{background-color:var(--elevated)}', ''));
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, `a footer inheriting its surface failed the audit:\n${run.output}`);
        assert.ok(
            run.output.includes('light a link in the footer: #0a4a8f on #ffffff, 8.79:1'),
            `the footer did not inherit \`body\`'s background:\n${run.output}`,
        );
    });

    test('treats an explicitly transparent background as nothing painted', () => {
        // `transparent` is what an element writes when it means "whatever is behind me", so
        // it must take the same path as writing nothing — the alternative is the audit
        // measuring text against a colour no reader ever sees.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('footer{background-color:var(--elevated)}', 'footer{background-color:transparent}'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, run.output);
        assert.ok(
            run.output.includes('light a link in the footer: #0a4a8f on #ffffff, 8.79:1'),
            `\`transparent\` was read as a colour to measure text against:\n${run.output}`,
        );
    });

    test('refuses a background it cannot place, rather than measuring the inherited surface', () => {
        // The non-vacuity case for the placement check: `main .card` paints a background the
        // audit cannot resolve to a box, and skipping the rule would report the inherited
        // `#ffffff` for text that is not drawn on it — a green check that measured a
        // surface nobody chose.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('</style>', 'main .card{background-color:#eeeeee}</style>'),
        );
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted a background behind an unresolvable selector');
        assert.ok(
            run.output.includes('NFR-004 the declared text colours are audited') && run.output.includes('`main .card`'),
            `expected the unplaceable background to be reported, got:\n${run.output}`,
        );
    });

    test('leaves a pseudo-state background alone, and says so in the report', () => {
        // The model is bounded on purpose: `:hover` and `:focus-visible` paint nothing in the
        // resting state this audit measures, so refusing them would fail a build over a
        // surface no reader sees at rest. What must not happen is *silence* — the assertion
        // below checks the fixture's hover background is accepted, and the rendered-browser
        // pass is named in the script's own comment as the half that measures focus and
        // hover for real.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('</style>', 'nav a:hover,nav a:focus-visible{background-color:#eeeeee}</style>'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, `a pseudo-state background failed the audit:\n${run.output}`);
        assert.ok(
            run.output.includes('light a navigation link: #595f68 on #ffffff'),
            `the resting navigation surface was not measured as painted:\n${run.output}`,
        );
        // The boundary is also written down where the model is defined, so the next reader
        // learns it from the code rather than from this test. Matched on the phrase the
        // comment actually uses; the behaviour above is the part that can fail.
        const script = readFileSync(SCRIPT, 'utf8');

        assert.match(script, /state- or pseudo-element-scoped/);
        assert.match(script, /what exercises a hover or focus surface/);
    });

    // A pseudo-class is only exempt when the state it names is *not* the resting one. The first
    // item of a list is the first item all the time, so `li:first-child` paints on every reader's
    // screen — a check that exempted any selector containing a `:` would skip that surface and
    // report the inherited one instead. Red-first: the old `/::|[^:]:[\w-]+/` exemption matched
    // `first-child` and this fixture passed before it was narrowed.
    test('refuses a background behind a pseudo-class that paints at rest', () => {
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('</style>', 'li:first-child{background-color:#eeeeee}</style>'),
        );
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted a background behind a resting-state pseudo-class');
        assert.ok(
            run.output.includes('NFR-004 the declared text colours are audited') && run.output.includes('`li:first-child`'),
            `expected the resting-state background to be reported by name, got:\n${run.output}`,
        );
    });

    // The minifier rewrites `nth-child(even)` as `nth-child(2n)`, and a surface named in the
    // keyword spelling that silently stopped matching would fall through to the next ancestor —
    // reporting a *lighter* colour than the one painted and therefore an inflated ratio. The
    // fixture is written the way the build writes it, so this fails if the normalisation is
    // ever removed.
    test('resolves a minified `nth-child(2n)` to the banded row it paints', () => {
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('tbody tr:nth-child(even){', 'tbody tr:nth-child(2n){'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, run.output);
        // `#f6f6f6` is the band's own colour and `#ffffff` the table it would fall through to,
        // so the two spellings of the assertion cannot both hold: a dropped normalisation
        // reports the white, which is the inflated answer this case exists to catch.
        assert.ok(
            run.output.includes('light body text in a banded table row: #111111 on #f6f6f6'),
            `the banded row fell through to the table's own colour:\n${run.output}`,
        );
        assert.ok(
            !run.output.includes('light body text in a banded table row: #111111 on #ffffff'),
            `the banded row was measured against the table rather than against itself:\n${run.output}`,
        );
    });

    test('refuses a surface painted with a gradient rather than reading the colour under it', () => {
        // The boundary written down in the script's own header, asserted rather than trusted:
        // a gradient is pixels, and the colour under it is not the colour a reader sees. The
        // audit must refuse and point at the declaration form it can read.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace(
                'caption{background-color:var(--surface);',
                'caption{background:linear-gradient(90deg,var(--surface),transparent);',
            ),
        );
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted a gradient-painted measured surface');
        assert.ok(
            run.output.includes('`background-color` and any decoration as `background-image`'),
            `expected the refusal to name the declaration form it can read, got:\n${run.output}`,
        );
    });

    test('refuses a background that only paints inside a media query', () => {
        // Whether it applies depends on a viewport the audit does not know, so reading the
        // rule as unconditional is a false accept — the whole reason this check exists.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('</style>', '@media (max-width: 30rem){footer{background:#808080}}</style>'),
        );
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted a viewport-conditional background');
        assert.ok(
            run.output.includes('NFR-004 the declared text colours are audited') && run.output.includes('at-rule'),
            `expected the conditional background to be reported, got:\n${run.output}`,
        );
    });

    test('measures the shipped palette, and does not measure the border colour', () => {
        // The conformance case above carries the shipped colours, so a palette that passes is
        // one the site actually ships. This adds the negative control the other direction:
        // `--rule` at a ratio no text ever needs is *accepted*, because it is a 1px border and
        // NFR-004 bounds text contrast. Measuring it would have made the audit fail on a
        // colour the requirement does not name — a check that refuses correct code, which is
        // the other way a gate stops being one.
        const files = conformingOutput();
        replacePage(
            files,
            'index.html',
            conformingPage(FIXTURE_PAGES[0], '', '--text:#111111;--link:#0a4a8f;--rule:#f0f0f0;--page:#ffffff;--surface:#f6f6f6'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, `a border colour the requirement does not bound failed the audit:\n${run.output}`);
        assert.match(run.output, /assertions hold/);
    });

    test('refuses a page whose documented literal marker is no longer marked', () => {
        // The other half of the exemption, and the reason the scan cannot be satisfied by
        // deleting the documentation: the marker itself is a finding.
        const files = conformingOutput();
        replacePage(files, 'configure/index.html', pageOf(files, 'configure/index.html').replace(`<p>${BODY_COPY}</p>`, '<p><code>{number}</code></p>'));
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted an unmarked literal marker');
        assert.ok(
            run.output.includes('AC-006 no placeholder or unfinished marker'),
            `expected the shape to refuse the unmarked marker, got:\n${run.output}`,
        );
        // And the same output with the attribute is accepted, so the refusal above is the
        // exemption being declared rather than the marker being read as forbidden outright.
        const marked = conformingOutput();
        replacePage(marked, 'configure/index.html', pageOf(marked, 'configure/index.html').replace(`<p>${BODY_COPY}</p>`, '<p><code data-literal-marker="true">{number}</code></p>'));

        assert.equal(assertBuild(writeOutput(marked)).status, 0);
    });

    test('refuses an output where no page declares a literal marker at all', () => {
        // The non-vacuity case for the exemption: the scan above is an absence, and an absence
        // is satisfied by a site that removed the documentation along with the marker.
        const files = new Map([...conformingOutput()].map(([file, markup]) => [file, markup.replace(/data-literal-marker="true"/g, '')]));
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted an output with no declared literal marker');
        assert.ok(
            run.output.includes('AC-006 the documented literal marker is marked as one'),
            `expected the declaration to be required, got:\n${run.output}`,
        );
    });

    test('refuses the service\'s own sentence that promises no placeholders are substituted', () => {
        // The reason the match is a whole-word one, as a test rather than a note: this
        // exact sentence is what the configure page prints from
        // `service/config-schema.ts`, and a substring check on `placeholder` failed the
        // shipped site over it. It must be accepted now — and `coming soon`, one word
        // away, must still not be.
        const files = conformingOutput();
        replacePage(
            files,
            'configure/index.html',
            pageOf(files, 'configure/index.html').replace(
                `<p>${BODY_COPY}</p>`,
                '<p>text sent to the agent verbatim, with no placeholders; at most 2,000 code points</p>',
            ),
        );

        assert.equal(assertBuild(writeOutput(files)).status, 0, "the service's own guidance is not a placeholder marker");
    });

    test('names the file and the markup it refused, not just the assertion', () => {
        const files = conformingOutput();
        replacePage(
            files,
            'debug/index.html',
            pageOf(files, 'debug/index.html').replace(
                '</head>',
                '<link rel="stylesheet" href="https://cdn.example.com/site.css"></head>',
            ),
        );
        const run = assertBuild(writeOutput(files));
        assert.match(
            run.output,
            /dist\/debug\/index\.html: <link rel="stylesheet" href="https:\/\/cdn\.example\.com\/site\.css">/,
        );
        assert.match(run.output, /it points at https:\/\/cdn\.example\.com/);
    });

    test('reports every failure at once rather than stopping at the first', () => {
        const files = conformingOutput();
        files.delete('use/index.html');
        files.set('logo.png', 'not really a png\n');
        const run = assertBuild(writeOutput(files));
        assert.notEqual(run.status, 0);
        const failures = run.output.split('\n').filter((line) => line.startsWith('FAIL ['));
        assert.ok(failures.length >= 3, `expected several failures, got:\n${run.output}`);
    });
});
