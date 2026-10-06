/**
 * Every `.astro` template the site ships, read the way a browser reads it.
 *
 * The guard itself is `glued-words.mjs`, and it is one rule rather than five
 * because the defect it catches is invisible to every other check: the build
 * succeeds, the HTML is valid, the links resolve, and the text is silently wrong.
 * Each page was written by a different session and each shipped the defect at
 * least once — install nine times, configure eighteen, use six — and the two
 * pages that had a private copy of the rule in their own test file were the two
 * that shipped the least. This file is what makes the coverage a property of the
 * directory rather than of five people's memories: it walks `src/` and asks the
 * question of everything it finds, so a page or component added later is covered
 * by the walk and not by a line somebody remembered to add.
 *
 * The suite is one test per template, named by the file it failed in, because a
 * gate that stops at the first failure costs a contributor a run per finding and
 * one that says only "some page is wrong" costs them a bisect.
 *
 * The `.assertions.mjs` name is deliberate, for the reason `base-path.assertions.mjs`
 * sets out: the repository's vitest has no config file, so its default include globs
 * every `test`-suffixed file from the repository root and would collect this one into
 * the repository's own gate, which FR-070 says must not notice `site/` at all.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { gluedLineBreaks } from './glued-words.mjs';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every `.astro` file under the site's `src/`, as `/`-separated paths from `src/`.
 *
 * Walked rather than listed, and that is the whole point of this file: a list is a
 * thing to update by hand and a hand that forgets is a page nobody checks. The walk
 * picks up a new page or component with no edit here at all.
 *
 * @param {string} directory The directory to walk, absolute.
 * @returns {string[]} Sorted, so a failure is reported in the same order every run.
 */
function astroTemplates(directory) {
    const found = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...astroTemplates(path));
        } else if (entry.name.endsWith('.astro')) {
            found.push(relative(join(SITE_ROOT, 'src'), path).split(/[\\/]/).join('/'));
        }
    }

    return found.sort();
}

const TEMPLATES = astroTemplates(join(SITE_ROOT, 'src'));

/** The five published pages, which `assert-build.mjs` proves exists in the output. */
const PAGES = [
    'pages/index.astro',
    'pages/install.astro',
    'pages/configure.astro',
    'pages/use.astro',
    'pages/debug.astro',
];

describe('the prose reads the way the source reads', () => {
    // Not vacuous: the walk must find the five pages, or a renamed directory would
    // make this suite pass by finding nothing at all.
    test('finds every published page', () => {
        for (const page of PAGES) {
            assert.ok(TEMPLATES.includes(page), `src/${page} was not found by the walk, so it was never checked`);
        }
        assert.equal(new Set(TEMPLATES).size, TEMPLATES.length, 'the walk reported a template twice');
    });

    for (const template of TEMPLATES) {
        test(`src/${template} loses no space to a line break`, () => {
            // Each element keeps its neighbouring words on its own line: Astro drops
            // the newline at a template boundary, so `opens on` followed by
            // `<strong>Status</strong>` renders "opens onStatus" with the build green.
            assert.deepEqual(
                gluedLineBreaks(readFileSync(join(SITE_ROOT, 'src', template), 'utf8')),
                [],
                'a line break beside an inline element loses the space; keep each element and the words around it on one line',
            );
        });
    }
});

describe('the guard bites', () => {
    // A gate measured only on pages that happen to be correct is an assumption
    // wearing a check's clothes. These are the two shapes that actually shipped, in
    // both directions, plus the whole-page case each of them was rewrapped out of.
    test('reports a word glued to an element that opens the next line', () => {
        const wrapped = ['<p>', 'Opens on', '<strong>Status</strong>.', '</p>'].join('\n');

        assert.deepEqual(
            gluedLineBreaks(wrapped),
            ['line 2: "Opens on" → "<strong>Status</strong>."'],
            'the break is reported',
        );
        assert.deepEqual(
            gluedLineBreaks(['<p>', 'Opens on <strong>Status</strong>.', '</p>'].join('\n')),
            [],
            'the same text kept whole is not',
        );
    });

    test('reports an element glued to the word after it', () => {
        const wrapped = ['<p>', 'under a <code>mecha-turk:</code>', 'prefix.', '</p>'].join('\n');

        assert.deepEqual(
            gluedLineBreaks(wrapped),
            ['line 2: "under a <code>mecha-turk:</code>" → "prefix."'],
            'the second direction is reported too',
        );
    });

    test('reports every losing break in one file rather than the first', () => {
        const three = [
            '<p>',
            'Its <strong>Setup</strong> tab is first.',
            'Opens on',
            '<strong>Status</strong>.',
            'Written by <code>dispatch-record.ts</code>',
            'at startup.',
            '</p>',
        ].join('\n');

        assert.equal(gluedLineBreaks(three).length, 2, 'both shapes, in both directions');
    });

    test('leaves a block boundary, and a chosen separator, alone', () => {
        // Nothing is lost beside a `<td>` or a `<p>`: the whitespace there is dropped
        // by design and separates elements rather than words. A bare JSX expression is
        // a separator the author chose, and the mapping table depends on that.
        const cells = ['<table>', '<tr>', '<th scope="row">', '<code>x</code>', '</th>', '</tr>', '</table>'].join('\n');
        const chosen = ['<th scope="row">', "{index === 0 ? '' : ', '}", '<code>{name}</code>', '</th>'].join('\n');

        assert.deepEqual(gluedLineBreaks(cells), [], 'a cell boundary loses nothing');
        assert.deepEqual(gluedLineBreaks(chosen), [], 'a separator the author wrote is not a lost space');
    });

    test('reads a page past its frontmatter rather than through it', () => {
        // The frontmatter is TypeScript and full of braces; a rule applied to it
        // would either find nothing or find nonsense. The two pages below are the
        // shapes: one whose frontmatter is prose-free, one whose template is.
        const withFence = ['---', 'const x = 1;', '---', '<p>', 'Opens on', '<strong>Status</strong>.', '</p>'].join('\n');

        assert.equal(
            gluedLineBreaks(withFence).length,
            1,
            'the break in the template is found, and the frontmatter above it is not scanned',
        );
    });
});
