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
 * A page that satisfies every clause of the contract: one `h1`, a labelled
 * navigation region carrying all five addresses, an inlined stylesheet that
 * fetches nothing, one content section, and a footer linking the licence file in
 * the repository.
 *
 * @param {{ address: string, title: string }} page The page to render.
 * @param {string} [extra] Markup appended inside `<main>`.
 * @returns {string} The page's markup.
 */
function conformingPage(page, extra = '') {
    const links = FIXTURE_PAGES.map((target) => {
        const href = `${base}${target.address}`;
        const current = href === `${base}${page.address}` ? ' aria-current="page"' : '';
        return `<li><a href="${href}"${current}>${target.title}</a></li>`;
    }).join('');
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        `<title>${page.title} · Mecha Turk</title>` +
        '<style>body{color:#111;background:#fff}a{color:#0a4a8f}</style>' +
        '</head><body>' +
        `<nav aria-label="Documentation pages"><ul>${links}</ul></nav>` +
        `<main><h1>${page.title}</h1><h2>Section</h2><p>Body copy.</p>${extra}</main>` +
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
