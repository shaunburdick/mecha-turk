/**
 * The base-path join, against every spelling of `BASE_URL` the site can be built
 * with.
 *
 * This is the one piece of the site whose failure is invisible to every other
 * check: a wrong join still type-checks, still builds, and still produces a
 * green gate — the links are simply wrong on the published address. So the
 * spellings are pinned here rather than left to whichever one happens to be
 * configured today.
 *
 * The `.assertions.mjs` name is deliberate. The repository's vitest has no
 * config file, so its default include globs every `test`-suffixed file from the
 * repository root and would collect this one, fail it as "no test suite found"
 * under Vitest, and put a failing suite into the repository's own gate — which
 * FR-070 says must not notice `site/` at all. These are run by the site's own
 * `npm test`, on `node --test`, with the site's own Node floor.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PAGES, underBase, withBase } from '../src/data/site.ts';

/** Every `BASE_URL` Astro can produce, per the configuration reference. */
const SPELLINGS = [
    { trailingSlash: "unset (the 'ignore' default)", baseUrl: '/mecha-turk' },
    { trailingSlash: "'always', as this site sets it", baseUrl: '/mecha-turk/' },
    { trailingSlash: "'never'", baseUrl: '/mecha-turk' },
];

/** What each spelling must produce for the site to be the same site. */
const EXPECTED = '/mecha-turk/install/';

describe('underBase', () => {
    for (const { trailingSlash, baseUrl } of SPELLINGS) {
        test(`keeps the base with trailingSlash ${trailingSlash}`, () => {
            assert.equal(underBase(baseUrl, '/install/'), EXPECTED);
        });
    }

    test('accepts a page path with or without its leading slash', () => {
        assert.equal(underBase('/mecha-turk', 'install/'), EXPECTED);
        assert.equal(underBase('/mecha-turk/', 'install/'), EXPECTED);
    });

    test('resolves the landing page onto the base itself', () => {
        assert.equal(underBase('/mecha-turk', '/'), '/mecha-turk/');
        assert.equal(underBase('/mecha-turk/', '/'), '/mecha-turk/');
    });

    test('resolves every page of the site under every spelling', () => {
        for (const { baseUrl } of SPELLINGS) {
            for (const page of PAGES) {
                const href = underBase(baseUrl, page.path);
                assert.ok(href.startsWith('/mecha-turk/'), `${baseUrl} + ${page.path} → ${href}`);
                assert.ok(href.endsWith('/'), `${baseUrl} + ${page.path} → ${href}`);
            }
        }
    });

    test('never glues the base to the path', () => {
        // The failure this exists to catch: `trailingSlash` unset makes
        // BASE_URL `/mecha-turk`, and a plain concatenation then emits
        // `/mecha-turkinstall/`.
        for (const { baseUrl } of SPELLINGS) {
            assert.notEqual(underBase(baseUrl, '/install/'), '/mecha-turkinstall/');
        }
    });

    test('never drops the base', () => {
        // The other half of the same failure: resolving `install/` against a
        // base that has no trailing slash treats the base as a file, so
        // `install/` replaces it and the link lands at the domain root.
        for (const { baseUrl } of SPELLINGS) {
            assert.notEqual(underBase(baseUrl, '/install/'), '/install/');
        }
    });

    test('carries no query, fragment, or origin out of a page path', () => {
        assert.equal(underBase('/mecha-turk', '/install/#step-3'), '/mecha-turk/install/#step-3');
        assert.equal(underBase('/mecha-turk', '/install/'), '/mecha-turk/install/');
    });

    test('a site with no base still resolves relative to the origin root', () => {
        assert.equal(underBase('/', '/install/'), '/install/');
    });
});

describe('PAGES', () => {
    test('is the five pages the site publishes, in navigation order', () => {
        assert.deepEqual(
            PAGES.map((page) => page.path),
            ['/', '/install/', '/configure/', '/use/', '/debug/'],
        );
    });

    test('gives every page a non-empty label for the navigation to render', () => {
        for (const page of PAGES) {
            assert.notEqual(page.title.trim(), '');
        }
    });

    test('has no two pages at the same address', () => {
        assert.equal(new Set(PAGES.map((page) => page.path)).size, PAGES.length);
    });
});

describe('withBase', () => {
    test('reads the base out of the build environment', () => {
        // Unreachable outside a build: `import.meta.env` is Vite's, not Node's.
        // The join it feeds is what `underBase` above pins down.
        assert.throws(() => withBase('/install/'));
    });
});