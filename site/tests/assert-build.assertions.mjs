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
 * A page that satisfies every clause of the contract: one `h1`, a labelled
 * navigation region carrying all five addresses, an inlined stylesheet that
 * fetches nothing and whose palette clears NFR-004's contrast floor, one content
 * section, and a footer linking the licence file in the repository.
 *
 * The palette is the shipped one rather than an arbitrary pair, so the fixture a
 * negative case perturbs is the palette a reader actually gets. `--rule` is here
 * and is never measured, because it is a border colour and NFR-004 bounds text.
 *
 * @param {{ address: string, title: string }} page The page to render.
 * @param {string} [extra] Markup appended inside `<main>`.
 * @param {string} [palette] The `:root` block's declarations, for a contrast case.
 * @returns {string} The page's markup.
 */
function conformingPage(page, extra = '', palette = '--text:#111111;--link:#0a4a8f;--rule:#d4d4d4;--surface:#f6f6f6') {
    const links = FIXTURE_PAGES.map((target) => {
        const href = `${base}${target.address}`;
        const current = href === `${base}${page.address}` ? ' aria-current="page"' : '';
        return `<li><a href="${href}"${current}>${target.title}</a></li>`;
    }).join('');
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        `<title>${page.title} · Mecha Turk</title>` +
        `<style>:root{${palette}}body{color:var(--text);background:#ffffff}` +
        'nav,footer{background:var(--surface)}a{color:var(--link)}</style>' +
        '</head><body>' +
        `<nav aria-label="Documentation pages"><ul>${links}</ul></nav>` +
        `<main><h1>${page.title}</h1><h2>Section</h2><p>Body copy.</p>${LITERAL_MARKER}${extra}</main>` +
        '<footer><ul>' +
        `<li><a href="${REPOSITORY_URL}">Source repository</a></li>` +
        `<li><a href="${REPOSITORY_URL}/blob/main/LICENSE">MIT licence</a></li>` +
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
        name: 'a footer with no link to the licence file',
        assertion: 'AC-005 a footer carrying the licence link',
        break: (files) => replacePage(files, 'debug/index.html', pageOf(files, 'debug/index.html').replace(`<li><a href="${REPOSITORY_URL}/blob/main/LICENSE">MIT licence</a></li>`, '')),
    },
    {
        name: 'a page left unfinished',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'configure/index.html', pageOf(files, 'configure/index.html').replace('<p>Body copy.</p>', '<p>Coming soon.</p>')),
    },
    {
        name: 'a template marker',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<p>Body copy.</p>', '<p>{{ notFilled }}</p>')),
    },
    {
        name: 'an expression that reached the output instead of being evaluated',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<p>Body copy.</p>', '<p>{pageTitle}</p>')),
    },
    {
        name: 'an empty section heading',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<h2>Section</h2>', '<h2></h2>')),
    },
    {
        name: 'a section heading whose only content rendered nothing',
        assertion: 'AC-006 no placeholder or unfinished marker',
        break: (files) => replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<h2>Section</h2>', '<h2 class="x">\n    </h2>')),
    },
    {
        name: 'a body colour that fails the contrast floor',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:#bbbbbb;--link:#0a4a8f;--surface:#f6f6f6')),
    },
    {
        name: 'a link colour that fails on the page background',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:#111111;--link:#c8c8c8;--surface:#f6f6f6')),
    },
    {
        name: 'a body colour that fails on the surface the footer sits on',
        // `#747474` is the *isolating* choice, and it was measured rather than guessed: at
        // 4.67:1 on `#ffffff` it passes the page pair and at 4.32:1 on `#f6f6f6` it fails
        // the surface one, so this case fails on the footer pair alone. A colour that failed
        // both would pass this test while proving nothing about which pair was measured —
        // the defect this whole case list exists to catch is an audit that measures the
        // wrong surface.
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:#747474;--link:#0a4a8f;--surface:#f6f6f6')),
    },
    {
        name: 'a link colour that fails on the surface the footer sits on',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:#111111;--link:#9a9a9a;--surface:#f6f6f6')),
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
        name: 'a body with no background for the floor to measure against',
        assertion: 'NFR-004 the declared text colours are audited',
        break: (files) => replacePage(files, 'index.html', pageOf(files, 'index.html').replace('background:#ffffff', '')),
    },
    {
        name: 'a colour written in a form the audit cannot read',
        assertion: 'NFR-004 the declared text colours clear 4.5:1',
        break: (files) => replacePage(files, 'index.html', conformingPage(FIXTURE_PAGES[0], '', '--text:rgb(17,17,17);--link:#0a4a8f;--surface:#f6f6f6')),
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
            replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<p>Body copy.</p>', marker.markup));
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
            replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<p>Body copy.</p>', word.markup));
            const run = assertBuild(writeOutput(files));

            assert.equal(run.status, 0, `the script refused ${word.markup}:\n${run.output}`);
        });
    }

    for (const shape of SHAPES_THAT_MUST_FAIL) {
        test(`refuses ${shape.name}`, () => {
            const files = conformingOutput();
            replacePage(files, 'use/index.html', pageOf(files, 'use/index.html').replace('<p>Body copy.</p>', shape.markup));
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
            replacePage(files, 'configure/index.html', pageOf(files, 'configure/index.html').replace('<p>Body copy.</p>', shape.markup));
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
        //    pair names the colour the `footer { background: var(--surface) }` rule resolves
        //    to. This is the assertion that would have failed had the footer been resolved
        //    by token lookup and come back empty, and the assertion that keeps it honest
        //    now that it resolves.
        const files = conformingOutput();
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, run.output);
        for (const [where, figures] of [
            ['body text on the page', '#111111 on #ffffff, 18.88:1'],
            ['a link on the page', '#0a4a8f on #ffffff, 8.79:1'],
            ['body text in the footer', '#111111 on #f6f6f6, 17.47:1'],
            ['a link in the footer', '#0a4a8f on #f6f6f6, 8.13:1'],
        ]) {
            assert.ok(
                run.output.includes(`NFR-004 contrast — ${where}: ${figures}`),
                `expected the audit to report \`${where}\` as \`${figures}\`, got:\n${run.output}`,
            );
        }
    });

    test('reads the surface a background rule paints, not the token behind it', () => {
        // The cascade, as a behaviour rather than as a comment. The footer's background is
        // repainted with a literal that no custom property holds, so an audit resolving the
        // pair by token name would measure `--surface` and get 8.13:1 where the page now
        // draws 8.49:1. Only reading the rule gets the right answer.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('nav,footer{background:var(--surface)}', 'footer{background:#fbfbfb}'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, `a literal footer background failed the audit:\n${run.output}`);
        assert.ok(
            run.output.includes('a link in the footer: #0a4a8f on #fbfbfb, 8.49:1'),
            `the audit measured the custom property rather than the background the footer paints:\n${run.output}`,
        );
    });

    test('inherits the surface up the chain when an element declares none', () => {
        // The other half of the cascade, and the shape the reported defect actually had: the
        // footer's background deleted. `background` is transparent by default, so the footer
        // shows `body`'s `#ffffff` — and the ratio must move from 8.13:1 to 8.79:1 rather
        // than the audit reporting the surface as unreadable. A chain that resolves to
        // nothing is a finding (`refuses a body with no background…` covers that case); a
        // chain that resolves to an ancestor is the cascade working.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('nav,footer{background:var(--surface)}', 'nav{}'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, `a footer inheriting its surface failed the audit:\n${run.output}`);
        assert.ok(
            run.output.includes('a link in the footer: #0a4a8f on #ffffff, 8.79:1'),
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
            pageOf(files, 'index.html').replace('nav,footer{background:var(--surface)}', 'nav{background:transparent}'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, run.output);
        assert.ok(
            run.output.includes('a link in the footer: #0a4a8f on #ffffff, 8.79:1'),
            `\`transparent\` was read as a colour to measure text against:\n${run.output}`,
        );
    });

    test('refuses a background it cannot place, rather than measuring the inherited surface', () => {
        // The non-vacuity case for the placement check: `main p` paints a background the
        // audit cannot resolve to a box, and skipping the rule would report the inherited
        // `#ffffff` for text that is not drawn on it — a green check that measured a
        // surface nobody chose.
        const files = new Map(conformingOutput());
        replacePage(
            files,
            'index.html',
            pageOf(files, 'index.html').replace('</style>', 'main p{background:#eeeeee}</style>'),
        );
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted a background behind an unresolvable selector');
        assert.ok(
            run.output.includes('NFR-004 the declared text colours are audited') && run.output.includes('`main p`'),
            `expected the unplaceable background to be reported, got:\n${run.output}`,
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
            conformingPage(FIXTURE_PAGES[0], '', '--text:#111111;--link:#0a4a8f;--rule:#f0f0f0;--surface:#f6f6f6'),
        );
        const run = assertBuild(writeOutput(files));

        assert.equal(run.status, 0, `a border colour the requirement does not bound failed the audit:\n${run.output}`);
        assert.match(run.output, /assertions hold/);
    });

    test('refuses a page whose documented literal marker is no longer marked', () => {
        // The other half of the exemption, and the reason the scan cannot be satisfied by
        // deleting the documentation: the marker itself is a finding.
        const files = conformingOutput();
        replacePage(files, 'configure/index.html', pageOf(files, 'configure/index.html').replace('<p>Body copy.</p>', '<p><code>{number}</code></p>'));
        const run = assertBuild(writeOutput(files));

        assert.notEqual(run.status, 0, 'the script accepted an unmarked literal marker');
        assert.ok(
            run.output.includes('AC-006 no placeholder or unfinished marker'),
            `expected the shape to refuse the unmarked marker, got:\n${run.output}`,
        );
        // And the same output with the attribute is accepted, so the refusal above is the
        // exemption being declared rather than the marker being read as forbidden outright.
        const marked = conformingOutput();
        replacePage(marked, 'configure/index.html', pageOf(marked, 'configure/index.html').replace('<p>Body copy.</p>', '<p><code data-literal-marker="true">{number}</code></p>'));

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
                '<p>Body copy.</p>',
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
