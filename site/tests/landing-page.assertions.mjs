/**
 * The landing page's obligations, as far as they are mechanical.
 *
 * The page is prose, and prose is not unit-tested: an assertion that restated
 * its sentences would prove only that the sentences had not changed. What is
 * checked here is the three classes of fact a reader would be misled by and no
 * build step would catch — the section structure FR-013 – FR-019 is laid out in,
 * the links the page writes, and the product facts it names, each read out of
 * the shipped declaration rather than out of a second copy here.
 *
 * Those facts are read from the product, never restated: the six tab labels come
 * from `src/tab-bodies.ts`, the tab order from `src/panel-state.ts`, the store
 * path from the service's own `service/store/dir.ts`, the storage namespace from
 * the manifest's panel id, and the scope words out of the panel's own
 * scope-refusal copy. A rename, a new tab, a new key or a fifth scope therefore
 * fails here instead of quietly making the page wrong, which is why these are
 * assertions and not a review.
 *
 * The `.assertions.mjs` name is deliberate, for the reason
 * `base-path.assertions.mjs` records: the repository's vitest globs every
 * `test`-suffixed file from the repository root and would collect this one, and
 * FR-070 says the root gate must not notice `site/` at all. The site's own
 * `npm test` runs these on `node --test`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import manifest from '../../package.json' with { type: 'json' };
import { DEFAULT_CONFIG } from '../../service/config.ts';
import { REASON_COPY } from '../../src/handoff-copy.ts';
import { TAB_IDS } from '../../src/panel-state.ts';
import { PRODUCT_ID } from '../src/data/product.ts';
import { PAGES, underBase } from '../src/data/site.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = resolve(SITE_ROOT, '..');

/** The page under test, as a path from the site root and as a repository path. */
const PAGE = 'src/pages/index.astro';

/**
 * The five sections the page is built from, each paired with the requirements it
 * discharges.
 *
 * FR-018 is absent by design, and that absence is the assertion: its four
 * documentation links and the licence link arrive with `Layout`, which
 * `assert-build.mjs` checks in the output (AC-003, AC-005). A section here would
 * be a second list of the same five addresses, and a one-line summary of each
 * documentation page a fifth place its subject is described — the drift FR-049
 * exists to prevent.
 */
const SECTIONS = [
    { heading: 'What Mecha Turk does', requirements: ['FR-013', 'FR-019'] },
    { heading: 'What Mecha Turk will not do', requirements: ['FR-014', 'FR-019'] },
    { heading: 'The panel', requirements: ['FR-015'] },
    { heading: 'Where your data lives', requirements: ['FR-016'] },
    { heading: 'Before you start', requirements: ['FR-017'] },
];

/** Every requirement FR-013 – FR-019 numbers, so a dropped section fails coverage. */
const BLOCK_B = ['FR-013', 'FR-014', 'FR-015', 'FR-016', 'FR-017', 'FR-018', 'FR-019'];

/**
 * The whitespace rule, in the two shapes a hand-wrapped line can break it.
 *
 * Astro drops the line break at a template boundary, so a break *beside* an inline
 * element costs the space the reader needed and the page renders "TheStatus" or
 * "Metadata,Issues". Text meeting text keeps its space (`—` at the end of one line
 * and a word at the start of the next still reads with a space), and a block
 * boundary discards the whitespace by design, so neither of those is a defect.
 *
 * The two shapes that are: an inline element opening a line whose predecessor is
 * not a block closer, and an inline element closing a line whose successor starts
 * with a word or another element.
 */
const INLINE_ELEMENT = /^<(?:strong|code|em|a)\b/;
const INLINE_CLOSER_AT_END = /<\/(?:strong|code|em|a)>[^\S\n]*$/;
const WORD_OR_ELEMENT_START = /^(?:[A-Za-z0-9]|<(?:strong|code|em|a)\b)/;

/**
 * A line that closes a block, or opens one: the whitespace at such a boundary is
 * dropped by design, so nothing can be lost there.
 */
const BLOCK_BOUNDARY = {
    ends: /<\/?(?:p|ul|ol|li|dl|dt|dd|section|table|tr|td|th|h[1-6])>$/,
    starts: /^<(?:p|ul|ol|li|dl|dt|dd|section|table|tr|td|th|h[1-6])\b/,
};

/** FR-052 and AC-006: what an unfinished page carries. */
const PLACEHOLDERS = ['todo', 'fixme', 'coming soon', 'lorem ipsum', 'placeholder', 'tbd', 'under construction'];

/** The four capability tokens this product has ever discussed, for the stale-row guard. */
const CAPABILITY_TOKENS = ['sessions', 'prompt', 'service', 'network'];

/**
 * Read a file from the product tree.
 *
 * @param {string} relativePath A `/`-separated path from the repository root.
 * @returns {string} Its text.
 */
function productFile(relativePath) {
    return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
}

/**
 * The landing page's source.
 *
 * @returns {string} The whole file, frontmatter included.
 */
function page() {
    return readFileSync(resolve(SITE_ROOT, PAGE), 'utf8');
}

/**
 * The page's markup, with the frontmatter removed.
 *
 * @returns {string} The template only.
 */
function template() {
    return page().replace(/^---[\s\S]*?\n---\n/, '');
}

/**
 * The six tab labels, in the order the panel's strip shows them.
 *
 * Read out of `src/tab-bodies.ts` rather than `TAB_IDS`, because the ids and the
 * labels are written in two places and this page prints the labels an operator
 * reads. `TAB_IDS` is the id union the two are held against.
 *
 * @returns {string[]} One label per tab, in strip order.
 */
function shippedTabLabels() {
    return [...productFile('src/tab-bodies.ts').matchAll(/label: '([^']+)'/g)].map((match) => match[1]);
}

/**
 * The scope names the service verifies, in the panel's own words.
 *
 * Extracted from the panel's scope-refusal copy rather than listed, so this file
 * holds no scope vocabulary of its own to drift: a fifth capability in the
 * service's matrix brings its own copy entry and fails the assertion below until
 * the page names it.
 *
 * @returns {string[]} One display name per verified scope.
 */
function verifiedScopeNames() {
    return [...REASON_COPY.entries()]
        .filter(([code]) => code.startsWith('scope-missing:'))
        .map(([, copy]) => /missing the (.+?) scope/.exec(copy)?.[1])
        .filter((word) => word !== undefined);
}

describe('the landing page lays out the structure FR-013 – FR-019 require', () => {
    test('is one top-level heading followed by its five sections, in order', () => {
        const headings = [...template().matchAll(/<h([1-3])>([^<]+)<\/h\1>/g)].map((match) => ({
            level: Number(match[1]),
            text: match[2].trim(),
        }));

        assert.deepEqual(
            headings.map((heading) => heading.text),
            ['Mecha Turk', ...SECTIONS.map((section) => section.heading)],
            "the page's outline is its h1 and the five sections, in the reader's order",
        );
        assert.deepEqual(
            headings.map((heading) => heading.level),
            [1, 2, 2, 2, 2, 2],
            'the h1 comes first and every section is its sibling — no section nests inside another',
        );
    });

    test('every section carries content, not only a heading', () => {
        // AC-006 forbids an empty section. This is the mechanical reading of it:
        // the shape a stub leaves behind is a heading with nothing between it and
        // the next heading.
        const html = template();
        for (const [index, section] of SECTIONS.entries()) {
            const from = html.indexOf(`<h2>${section.heading}</h2>`);
            assert.notEqual(from, -1, `the page has no ${section.heading} section`);
            const nextHeading =
                index + 1 < SECTIONS.length ? html.indexOf(`<h2>${SECTIONS[index + 1].heading}</h2>`) : html.indexOf('</Layout>');
            const body = html.slice(from, nextHeading);
            assert.ok(/<(?:p|ul|ol|dl|table)\b/.test(body), `${section.heading} carries no content`);
        }
    });

    test('covers every requirement in the block, with FR-018 carried by the shell', () => {
        const covered = new Set(SECTIONS.flatMap((section) => section.requirements));
        covered.add('FR-018');

        for (const requirement of BLOCK_B) {
            assert.ok(covered.has(requirement), `${requirement} is claimed by no section of the page`);
        }
        assert.equal(covered.size, BLOCK_B.length, 'the page claims a requirement outside FR-013 – FR-019');
    });

    test('inherits the shell and repeats none of its navigation', () => {
        // FR-018's obligation is met by the layout, so the page's own body must
        // carry no anchor at all: a link to a published page would be harmless but
        // redundant, and a link to a page the site does not publish is what FR-018
        // forbids outright.
        assert.ok(template().includes('<Layout>'), 'FR-018: the documentation links and the licence link come with Layout');
        assert.deepEqual([...template().matchAll(/<a\s/g)].map((match) => match[0]), [], 'the page writes an anchor of its own');
    });

    test('references no host, image, script, or frame of its own', () => {
        // FR-009, FR-010 and NFR-002 as source text. `assert-build.mjs` owns the
        // same properties over `dist/`; this is the half that can run without a
        // build, and it is also what a future edit would break first.
        assert.doesNotMatch(template(), /(?:href|src)="(?:https?:)?\/\//, 'the page references an off-site URL');
        for (const element of ['img', 'script', 'iframe', 'object', 'embed', 'link', 'style']) {
            assert.doesNotMatch(template(), new RegExp(`<${element}\\b`), `<${element}> is not admitted on any page`);
        }
    });
});

describe('every internal link resolves under the base path', () => {
    test('every page the site declares lands under the declared base path', () => {
        // The page writes no link of its own, so what this holds is the property
        // any future link on this page would need: it is correct only if it is one
        // of these five, joined by the one helper. The base is read out of
        // `astro.config.ts` rather than written here, because FR-005 and AC-002
        // declare it in exactly one file — `underBase` rather than `withBase`,
        // since `import.meta.env.BASE_URL` is a Vite import and this runs on plain
        // `node --test`.
        const base = /^\s*base:\s*'([^']+)'/m.exec(readFileSync(resolve(SITE_ROOT, 'astro.config.ts'), 'utf8'))?.[1];

        assert.ok(base, 'astro.config.ts declares no base path for these links to land under');
        for (const declared of PAGES) {
            const href = underBase(base, declared.path);
            assert.ok(href.startsWith('/mecha-turk/'), `${declared.path} resolves outside the base: ${href}`);
            assert.ok(href.endsWith('/'), `${declared.path} is not in directory form: ${href}`);
        }
    });
});

describe('the facts the page names are the facts the product ships', () => {
    test('the six tabs are named in shipped order, one line each', () => {
        const labels = shippedTabLabels();

        assert.deepEqual(labels, ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About']);
        assert.deepEqual(
            [...productFile('src/tab-bodies.ts').matchAll(/id: '([^']+)'/g)].map((match) => match[1]),
            [...TAB_IDS],
            'the spec list and the id union disagree, so a tab would be documented that the panel does not show',
        );

        const definitionList = template().slice(template().indexOf('<dl>'), template().indexOf('</dl>'));
        const listed = [...definitionList.matchAll(/<dt>([^<]+)<\/dt>\s*<dd>/g)].map((match) => match[1].trim());

        assert.deepEqual(listed, labels, 'FR-015: the tabs are not named in the order the panel shows them');
        assert.equal(listed.length, 6, 'FR-015: one line each means one entry per tab');
    });

    test('the service store path it names is the one the service resolves', () => {
        const relative = /STORE_RELATIVE_PATH = '([^']+)'/.exec(productFile('service/store/dir.ts'))?.[1];

        assert.ok(relative, 'service/store/dir.ts no longer declares its store path');
        assert.ok(page().includes(`~/${relative}/`), `the page does not name the store the service resolves (${relative})`);
    });

    test('the second storage location is a place the panel really writes to', () => {
        // FR-016's second location is `host.storage`, so this asserts it exists —
        // a panel that stopped using it would leave the page describing a
        // location that is not there. The *keys* are deliberately not listed: one
        // of the five is not namespaced with the panel id, so any claim the page
        // made about the namespace would be a claim the build does not support,
        // and an inventory here would be a second copy of the panel's own
        // constants to keep in step.
        const written = ['ledger.ts', 'evidence.ts', 'dispatch-record.ts', 'account-mirror.ts'].flatMap((module) =>
            [...productFile(`src/${module}`).matchAll(/STORAGE_KEY = '([^']+)'/g)].map((match) => match[1]),
        );

        assert.ok(written.length >= 4, `the panel ships ${written.length} host.storage keys; the page describes one location holding its state`);
        assert.ok(
            written.some((key) => key.startsWith(`${PRODUCT_ID}:`)),
            `no panel storage key is namespaced with the manifest's panel id (${PRODUCT_ID})`,
        );

        // What the page must not do is name any of them.
        for (const key of written) {
            assert.ok(!template().includes(`<code>${key}</code>`), `the page spells the \`${key}\` storage key`);
        }
    });

    test('names every scope the service verifies, in the panel\'s own words', () => {
        const words = verifiedScopeNames();

        assert.equal(words.length, 4, 'the panel no longer names four scope refusals');
        for (const word of words) {
            assert.ok(page().includes(`<code>${word}</code>`), `the page does not name the ${word} scope`);
        }
        assert.ok(Object.hasOwn(DEFAULT_CONFIG, 'expectedAgent'), 'the service no longer declares the verification baseline the page names');
        assert.ok(page().includes('<code>expectedAgent</code>'), 'the page does not name the verification baseline');
    });

    test('names no capability the manifest does not request', () => {
        // FR-022 and FR-048, aimed at the one falsehood README.md carried: a
        // `network` row copied out of a readme the manifest contradicts. The page
        // spells a literal in `<code>`, so a pasted capability row would land
        // there, and `network` is not requested at all (AGENTS.md invariant 3).
        const requested = new Set(manifest.openchamber.contributes.capabilities);
        for (const [, token] of template().matchAll(/<code>([^<]+)<\/code>/g)) {
            if (!CAPABILITY_TOKENS.includes(token)) {
                continue;
            }
            assert.ok(requested.has(token), `the page names the \`${token}\` capability, which the manifest does not request`);
        }
    });

    test('carries no version-shaped literal and no placeholder', () => {
        // FR-053: the version is read out of the manifest by `data/product.ts` and
        // printed by the About tab, never here. FR-052 and AC-006: no marker that
        // says the page is unfinished.
        assert.doesNotMatch(page(), /(?<![\d.])\d+\.\d+\.\d+(?![\d.])/, 'the page spells a version out');
        for (const marker of PLACEHOLDERS) {
            assert.ok(!page().toLowerCase().includes(marker), `the page carries "${marker}"`);
        }
    });
});

describe('the page reads correctly', () => {
    test('no word is glued to an inline element by the way this file is wrapped', () => {
        // Astro drops the line break at a template boundary, so a hand-wrapped line
        // renders "TheStatus" or "polling.Nothing" — the space vanishes in both
        // directions: before an element that starts the next line, and after an
        // element that ends this one. Nothing else in the site's gate can see it:
        // the build stays green and the HTML is valid. This is the one assertion
        // here that guards how the page reads rather than what it says, and it
        // exists because the page shipped both directions of the defect while it
        // was being written.
        const lines = template().split('\n');
        const glued = [];

        for (const [index, line] of lines.entries()) {
            const here = line.trimEnd();
            const next = lines[index + 1]?.trim() ?? '';
            if (here === '' || next === '' || BLOCK_BOUNDARY.ends.test(here) || BLOCK_BOUNDARY.starts.test(next)) {
                continue;
            }
            // Punctuation beside the element does not save either case: `</code>,`
            // followed by `<code>` still renders "Metadata,Issues" with no space
            // after the comma, which is why the first shape asks only what the
            // previous line *ends* in and the second only that the tag is last.
            const elementOpensNextLine = INLINE_ELEMENT.test(next) && !BLOCK_BOUNDARY.ends.test(here);
            const elementEndsThisLine = INLINE_CLOSER_AT_END.test(here) && WORD_OR_ELEMENT_START.test(next);

            if (elementOpensNextLine || elementEndsThisLine) {
                glued.push(`line ${index + 1} → ${index + 2}: "${here.slice(-30)}" | "${next.slice(0, 30)}"`);
            }
        }

        assert.deepEqual(glued, [], 'a line break beside an inline element loses the space; keep each element inside one line');
    });
});