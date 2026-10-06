/**
 * The version the documentation publishes, checked against the manifest it is
 * read from.
 *
 * FR-053 forbids a version literal in the site's sources: the number has one
 * source, `data/product.ts` reading the root `package.json`. Two surfaces now
 * print it — the footer every page carries, and the install page's pinning
 * section, which names the tag a reader pastes after the git URL — so this
 * file asks both questions of both: the identifier is present, and no `x.y.z`
 * is typed in its place.
 *
 * That second question is the one worth having. A literal builds green, passes
 * every other suite, and leaves the documentation disagreeing with the
 * extension it documents from the next release onward — the drift FR-053
 * exists to make impossible, caught only by looking for it.
 *
 * The `.assertions.mjs` name is deliberate, for the reason
 * `base-path.assertions.mjs` sets out: the repository's vitest has no config
 * file, so its default include globs every `test`-suffixed file from the
 * repository root and would collect this one into the repository's own gate,
 * which FR-070 says must not notice `site/` at all.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import manifest from '../../package.json' with { type: 'json' };
import { PRODUCT_VERSION } from '../src/data/product.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The two templates that print the version, as paths from the site root. */
const PRINTERS = ['src/components/footer.astro', 'src/pages/install.astro'];

/** Any `x.y.z` typed into a source, which FR-053 forbids outright. */
const VERSION_LITERAL = /\b\d+\.\d+\.\d+\b/;

describe('the documented version is the manifest\'s', () => {
    test('PRODUCT_VERSION is the manifest read, not a second copy of it', () => {
        assert.equal(PRODUCT_VERSION, manifest.version);
    });

    for (const template of PRINTERS) {
        test(`site/${template} renders PRODUCT_VERSION and types no literal`, () => {
            const source = readFileSync(join(SITE_ROOT, template), 'utf8');

            assert.ok(
                source.includes('PRODUCT_VERSION'),
                `${template} prints the version without reading it; import it from data/product.ts`,
            );
            assert.doesNotMatch(
                source,
                VERSION_LITERAL,
                `${template} types a version literal, which the next release leaves stale (FR-053)`,
            );
        });
    }

    test('the literal the two checks above refuse is one they can see', () => {
        // A pattern that has only ever matched nothing is an assumption wearing
        // a check's clothes: this is the shape the guard exists to catch.
        assert.match('Version 0.0.1', VERSION_LITERAL);
        assert.doesNotMatch('Version {PRODUCT_VERSION}', VERSION_LITERAL);
    });
});
