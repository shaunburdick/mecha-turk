/**
 * The debug page's mechanical claims, and each one shown able to fail.
 *
 * Four things about this page are worth more than a paragraph of prose, and all
 * four are properties of the artefact rather than of what anyone wrote:
 *
 * 1. **Every symptom the panel ships is on the page, exactly.** A lookup table
 *    whose first column was retyped is worse than no table — the reader searches
 *    for the token the product prints, finds no row, and concludes the product is
 *    broken. So the check enumerates them from the shipped declarations and
 *    requires each to appear verbatim in the built page.
 * 2. **The page names no service route.** The product owner's ruling is that the
 *    debug page documents the panel and the files and nothing else: an operator
 *    has no supported shell path to the service, so printing one would document
 *    an unsupported path and put a token in a copy-paste history (FR-041 – FR-045).
 * 3. **The table is derived, not retyped.** Asserted over the component's *source*:
 *    no string the panel owns may appear in it as a literal, which is what makes
 *    "generated from the declaration" a checkable property rather than a claim in a
 *    docblock.
 * 4. **Every name the page prints is a name the build has.** The store table's
 *    entries are read from the service's own constants and the mapping table's
 *    identifiers from `src/` and `service/`, so neither table can invent a file or
 *    a prefix (FR-048).
 *
 * **Why this builds the site.** The symptom tokens exist only in the built output, so
 * the check that matters cannot run against the sources. It builds into a temporary
 * directory rather than reading `dist/` for two reasons: a `dist/` left by an earlier
 * build would be stale in exactly the way this page cannot tolerate, and a test must
 * never write to a tree another process may be building in. The cost is a few
 * seconds per run and one generated `site/.astro/` directory, which the site already
 * ignores. The coupling is the whole site's: a syntax error in any page fails this
 * file, which is the same coupling `astro check` already has.
 *
 * The `.assertions.mjs` name is deliberate, for the reason
 * `base-path.assertions.mjs` sets out: the repository's vitest has no config file,
 * so its default include globs every `test`-suffixed file from the repository root
 * and would collect this one into the repository's own gate, which FR-070 says
 * must not notice `site/` at all.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PANEL_PROBLEM_SHAPES, SYMPTOM_CODES, SYMPTOM_MESSAGES } from '../src/data/declarations.ts';

const SITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SITE_ROOT, '..');

/** The debug page and the one component it renders the symptom table through. */
const PAGE_SOURCE = 'pages/debug.astro';
const TABLE_COMPONENT = 'components/symptom-codes.astro';

/**
 * Read one of the repository's own source files.
 *
 * @param {...string} parts Path segments below the repository root.
 * @returns {string} The file's text.
 */
function repoSource(...parts) {
    return readFileSync(join(REPO_ROOT, ...parts), 'utf8');
}

/**
 * Every file under a repository directory, with its text, sorted.
 *
 * @param {string} relative The directory, repository-relative.
 * @returns {Array<{ path: string, text: string }>} Each file's path and contents.
 */
function walk(relative) {
    // `readdirSync`'s recursive mode returns path strings relative to the directory
    // it was given, which is what the repository's own vocabulary scan reads.
    const found = [];
    for (const entry of readdirSync(join(REPO_ROOT, relative), { recursive: true }).map(String)) {
        if (!entry.endsWith('.ts')) {
            continue;
        }
        const path = `${relative}/${entry.split('/').join('/')}`;
        found.push({ path, text: readFileSync(join(REPO_ROOT, path), 'utf8') });
    }

    return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** Everything the panel and the service ship, concatenated once. */
const shippedSource = [...walk('src'), ...walk('service')].map((file) => file.text).join('\n');

/**
 * Escape text the way Astro escapes an interpolated expression.
 *
 * The assertions compare against the *built* markup, where `"`, `<`, and `>` inside
 * a rendered string arrive as entities — so the expected side has to be escaped the
 * same way, or the comparison would fail on a token that is in fact printed
 * correctly. `&` goes first, or the entities this function introduces would be
 * escaped a second time.
 *
 * @param {string} text The string as the panel renders it.
 * @returns {string} The same string as it appears in the built markup.
 */
function asBuiltText(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * The inverse of {@link asBuiltText}, for reading a rendered value back.
 *
 * @param {string} text Markup as the build emitted it.
 * @returns {string} The string the page rendered.
 */
function asRenderedText(text) {
    return text
        .replaceAll('&quot;', '"')
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&');
}

/**
 * Require every string to appear in the built page, exactly.
 *
 * A function taking both sides, so the negative case can drive it with a token the
 * panel does not ship — a comparison never seen red is an assumption wearing a
 * check's clothes.
 *
 * @param {string} label What is being looked for, named in the failure.
 * @param {string} html The built page.
 * @param {readonly string[]} expected The strings the product renders.
 */
function assertPrinted(label, html, expected) {
    const missing = expected.filter((entry) => !html.includes(asBuiltText(entry)));
    assert.deepEqual(missing, [], `${label}: the built page does not carry ${JSON.stringify(missing)}`);
}

/**
 * Read one string constant out of a source file's text, by name.
 *
 * @param {string} text A source file.
 * @param {string} name The constant's name.
 * @returns {string} The literal it is assigned.
 */
function stringConstant(text, name) {
    const match = new RegExp(`\\b${name}\\s*(?::\\s*'[^']*')?\\s*=\\s*'([^']+)'`).exec(text);
    assert.notEqual(match, null, `${name} is a string constant in the file this reads`);
    return match[1];
}

/**
 * The store-relative names the service declares, read from its own constants.
 *
 * Deliberately a second reading of the service's text rather than an import of its
 * modules: an import would prove nothing about what the service *declares*, which is
 * what the page's table claims. One constant per file is named, so a parse cannot
 * wander into an unrelated string of the same shape.
 *
 * @returns {Set<string>} Every name the service declares.
 */
function declaredStoreNames() {
    const declared = [
        [['service', 'store', 'index.ts'], 'STATE_FILE'],
        [['service', 'config.ts'], 'CONFIG_FILE'],
        [['service', 'poll', 'runs-document.ts'], 'RUNS_FILE'],
        [['service', 'poll', 'events-parse.ts'], 'EVENTS_FILE'],
        [['service', 'poll', 'scan.ts'], 'SCAN_STATE_FILE'],
        [['service', 'accounts', 'store.ts'], 'BINDINGS_FILE'],
        [['service', 'accounts', 'store.ts'], 'ACCOUNTS_DIR'],
        [['service', 'audit.ts'], 'AUDIT_FILE'],
    ];

    return new Set(declared.map(([path, name]) => stringConstant(repoSource(...path), name)));
}

/**
 * One table of the built page, found by the text of its header cell.
 *
 * @param {string} html A built page.
 * @param {string} header The header cell that names the table.
 * @returns {string} The table's markup, header row included.
 */
function tableWithHeader(html, header) {
    const headerAt = html.indexOf(`<th scope="col">${header}</th>`);
    assert.notEqual(headerAt, -1, `the page carries a table headed ${header}`);
    const start = html.lastIndexOf('<table', headerAt);

    return html.slice(start, html.indexOf('</table>', headerAt));
}

/**
 * The rendered value of every row-header cell in a table.
 *
 * @param {string} table A table's markup.
 * @returns {string[]} The values, in document order, entities decoded.
 */
function rowHeadersOf(table) {
    return [...table.matchAll(/<th scope="row">(.*?)<\/th>/g)]
        .map((match) => match[1].replaceAll(/<[^>]+>/g, '').trim())
        .map(asRenderedText);
}

/** Every string the panel renders as a failure, in the order the table prints them. */
const SHIPPED_SYMPTOMS = [
    ...SYMPTOM_CODES.map((code) => code.token),
    ...SYMPTOM_CODES.map((code) => code.meaning),
    ...SYMPTOM_MESSAGES,
    ...PANEL_PROBLEM_SHAPES,
];

/**
 * A line whose own boundary is markup rather than prose.
 *
 * A `<td>` on its own line is a whole cell, and a break beside it separates elements rather than words, so
 * neither side of such a break can lose a space.
 */
const BLOCK_LINE = /^<\/?(?:p|ul|ol|li|table|thead|tbody|tr|th|td|section|h1|h2|div|caption|Layout|SymptomCodes)\b|^<>$|^<\/>/;

/** An inline element that opens a line, with no word of its own before it. */
const INLINE_OPENS = /^<(?:code|strong|em|a|br)\b/;

/** An inline element that closes a line, with no word of its own after it. */
const INLINE_CLOSES = /<\/(?:code|strong|em|a)>$/;

/**
 * The line breaks that would swallow the space beside an inline element.
 *
 * Astro drops the newline at a template boundary rather than rendering it as whitespace, so a line ending in
 * a word followed by a line opening with `<code>` prints them glued — and so does a line ending with
 * `</strong>` followed by one opening with a word. The build stays green and the markup is valid, so nothing
 * else in the gate can see it: this page shipped three of them while it was written, which is why it is
 * measured here rather than trusted to review.
 *
 * @param {string} source An `.astro` file's text.
 * @returns {string[]} One finding per break that loses a space, quoting both halves.
 */
function gluedLineBreaks(source) {
    const template = (source.split('\n---\n')[1] ?? source).split('\n');
    const prose = template
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('/*') && !line.startsWith('*') && !line.includes('{'));

    const glued = [];
    for (const [index, here] of prose.entries()) {
        const next = prose[index + 1];
        if (next === undefined || BLOCK_LINE.test(here) || BLOCK_LINE.test(next)) {
            continue;
        }
        if (INLINE_OPENS.test(next) || INLINE_CLOSES.test(here)) {
            glued.push(`${JSON.stringify(here.slice(-40))} → ${JSON.stringify(next.slice(0, 40))}`);
        }
    }

    return glued;
}

const pageSource = readFileSync(join(SITE_ROOT, 'src', PAGE_SOURCE), 'utf8');
const tableComponent = readFileSync(join(SITE_ROOT, 'src', TABLE_COMPONENT), 'utf8');

/**
 * Require a shipped string not to appear as a quoted literal.
 *
 * Quotation is what separates *stating* a token from merely writing prose that
 * happens to contain the same letters — `validation` is a shipped token and also an
 * ordinary English word, so a bare substring test would fail a page that never typed
 * the token at all. A retyped token is a quoted one: `'NO_SERVICE'` in an array,
 * `` `<id>` `` in a template. Those three spellings are what a hand-typed row looks
 * like, and none of them is how prose quotes a word.
 *
 * @param {string} text The source to check.
 * @param {string} shipped A string the panel renders.
 * @param {string} where Which file, for the failure message.
 */
function assertNotRestated(text, shipped, where) {
    for (const quote of ["'", '"', '`']) {
        const restated = `${quote}${shipped}${quote}`;
        assert.ok(!text.includes(restated), `${where} does not restate ${JSON.stringify(restated)}`);
    }
}

describe("the debug page's sources", () => {
    test('name no service route', () => {
        // FR-041 – FR-045 and the product owner's ruling: the panel and the files,
        // and no shell path to the service. A route path here would document a path
        // no supported surface walks.
        for (const [file, text] of [[PAGE_SOURCE, pageSource], [TABLE_COMPONENT, tableComponent]]) {
            assert.ok(!text.includes('/v1/'), `${file} names no service route`);
            assert.ok(!/\bcurl\b/.test(text), `${file} instructs no shell request`);
        }
    });

    test('retype no symptom the panel ships', () => {
        // The derived-rows guarantee, asserted over the source: a string the panel
        // maps by code may appear in these two files only because it was imported, so
        // it may not appear in them as a literal of its own. The three bare sentences
        // and the one built refusal are deliberately *not* in this set — the page has
        // to quote them, because it keys its own prose by the rendered string, and the
        // test below asserts it quotes exactly those four and no others.
        for (const shipped of [...SYMPTOM_CODES.map((code) => code.token), ...SYMPTOM_CODES.map((code) => code.meaning)]) {
            assertNotRestated(tableComponent, shipped, TABLE_COMPONENT);
            assertNotRestated(pageSource, shipped, PAGE_SOURCE);
        }
        // Not vacuous: the component really is read as text — it carries the em dash
        // its prose uses, and the page carries the quoted sentences of the test below.
        assert.ok(tableComponent.includes('—'), 'the component was read, not skipped');
        assert.ok(pageSource.includes("'"), 'the page was read, not skipped');
    });

    test('quote the sentences the panel renders on its own, and only those', () => {
        // The table's rows are keyed by the rendered string, so a rename in
        // `src/handoff-copy.ts` leaves the page with a row nothing describes. The
        // component refuses that at build time; this asserts the coverage that
        // refusal protects, in both directions — the four are all quoted, and nothing
        // else from the panel's copy is.
        for (const sentence of [...SYMPTOM_MESSAGES, ...PANEL_PROBLEM_SHAPES]) {
            assert.ok(pageSource.includes(`'${sentence}'`), `the page describes ${JSON.stringify(sentence)}`);
        }
        for (const code of SYMPTOM_CODES) {
            assert.ok(!pageSource.includes(`'${code.token}'`), `the page does not quote the token ${code.token}`);
        }
    });

    test('lose no space to a line break beside an inline element', () => {
        // Astro drops the newline at a template boundary, so a hand-wrapped line
        // renders `ItsStatus` or `mecha-turk:prefix`. The build stays green, the
        // markup is valid, and a reader is the only one who sees it.
        assert.deepEqual(gluedLineBreaks(pageSource), [], 'each element keeps its neighbouring words on its own line');
    });

    test('bites on a line break that would glue a word to an element', () => {
        // The negative case, over the shape that shipped three times on this page:
        // the break after a word, and then the same text kept whole.
        const wrapped = ['---', '<p>', '    Its', '    <strong>Status</strong> tab reports the state.', '</p>', ''].join('\n');
        const whole = ['---', '<p>', '    Its <strong>Status</strong> tab reports the state.', '</p>', ''].join('\n');

        assert.deepEqual(
            gluedLineBreaks(wrapped),
            ['"Its" → "<strong>Status</strong> tab reports the "'],
            'the break is reported',
        );
        assert.deepEqual(gluedLineBreaks(whole), [], 'the same text kept whole is not');
    });

    test('say what it would refuse to print', () => {
        // The three codes the page's own prose needs and `handoff-copy.ts` does not
        // carry are exactly the ones it must not print as a token — so their absence
        // is asserted, which is what keeps FR-048's "no name the build lacks" honest
        // for a page that writes prose about the product.
        const retired = ['Handoff refused', 'Warning: dispatched'];

        for (const phrase of retired) {
            assert.ok(!pageSource.includes(phrase), `the page does not print ${JSON.stringify(phrase)}`);
        }
    });
});

describe("the debug page's built output", () => {
    let html = '';
    let outDir = '';

    before(() => {
        outDir = mkdtempSync(join(tmpdir(), 'mecha-turk-debug-page-'));
        const build = spawnSync(
            process.execPath,
            [join(SITE_ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', '--outDir', outDir],
            { cwd: SITE_ROOT, encoding: 'utf8' },
        );
        assert.equal(build.status, 0, `the site builds, because these tokens exist only in its output:\n${build.stderr}`);
        html = readFileSync(join(outDir, 'debug', 'index.html'), 'utf8');
    });

    after(() => rmSync(outDir, { recursive: true, force: true }));

    test('carries every symptom token the panel renders today', () => {
        // AC-011: a symptom the product renders and this page cannot carry is a
        // symptom a reader cannot look up.
        assertPrinted('the symptom table', html, SYMPTOM_CODES.map((code) => code.token));
    });

    test("carries the panel's own sentence for each of them", () => {
        assertPrinted('the panel copy', html, SYMPTOM_CODES.map((code) => code.meaning));
    });

    test('carries the sentences the panel renders alone, and the one it builds', () => {
        assertPrinted('the bare sentences and the built refusal', html, [...SYMPTOM_MESSAGES, ...PANEL_PROBLEM_SHAPES]);
    });

    test('has exactly one row per shipped symptom, each with a line beside it', () => {
        const table = tableWithHeader(html, 'What the panel prints');
        const rows = (table.match(/<tr>/g) ?? []).length - 1; // less the header row

        assert.equal(rows, SHIPPED_SYMPTOMS.length - SYMPTOM_CODES.length, 'one row per row of the declaration');
        assert.equal((table.match(/<td>/g) ?? []).length, rows, 'every row carries what it means');
    });

    test('names no service route', () => {
        assert.ok(!html.includes('/v1/'), 'the built debug page names no service route');
    });

    test('refuses a symptom the panel does not ship', () => {
        // The negative case for the token check: a token typed into the table by
        // hand, which is the one failure this page cannot have.
        assert.throws(
            () => assertPrinted('a hand-added token', html, ['quota-exhausted']),
            /the built page does not carry \["quota-exhausted"\]/,
        );
    });

    test('names no store entry the service does not declare', () => {
        const declared = declaredStoreNames();
        const entries = rowHeadersOf(tableWithHeader(html, 'In the store'));
        assert.ok(entries.length >= 8, 'the data-directory table has the rows the page prints');

        // The first segment is the comparison: `accounts/<id>.json` is a shape, and
        // the directory it is built in is what the service declares.
        const unknown = [...new Set(entries.map((entry) => entry.split('/')[0]))].filter((name) => !declared.has(name));
        assert.deepEqual(unknown, [], `the page names store entries nothing declares: ${JSON.stringify(unknown)}`);
    });

    test('refuses a store entry the service never shipped', () => {
        // The negative case: a row added to the page by hand.
        const declared = declaredStoreNames();

        assert.deepEqual(['payments.json'].filter((name) => !declared.has(name)), ['payments.json']);
    });

    test('names no identifier the product does not ship', () => {
        // Every name in the mapping table is a string the code contains — with the
        // retired words exempt, and exempt for the whole point of the table: they
        // appear nowhere in the product, which is why the reader needs the mapping.
        const retired = new Set(['Runs', 'Run', 'Repositories']);
        const named = rowHeadersOf(tableWithHeader(html, 'Name you may see'))
            .flatMap((cell) => cell.split(', '))
            .filter((name) => !retired.has(name));

        assert.ok(named.length >= 20, 'the mapping table carries the names it claims to');
        const invented = [...new Set(named)].filter((name) => !shippedSource.includes(name.replaceAll('…', '')));
        assert.deepEqual(invented, [], `the page names identifiers the product does not ship: ${JSON.stringify(invented)}`);
    });

    test('refuses an identifier the product never shipped', () => {
        // The negative case: a prefix invented for the table.
        assert.ok(!shippedSource.includes('runscope-'), 'the invented prefix is not in the product');
        assert.throws(
            () => assert.ok(shippedSource.includes('runscope-')),
            /evaluated to a falsy value/,
        );
    });

    test('carries the retired nouns inside the mapping table and nowhere else', () => {
        // D14: the one sanctioned exception, held to its boundary. The section is a
        // marked element rather than an HTML comment because Astro strips comments
        // from a template — the vocabulary scan (T-032) has to be able to cut this
        // table out of the source or of the built page.
        const start = html.indexOf('data-vocabulary-mapping');
        assert.notEqual(start, -1, 'the mapping table is a marked section, so the scan can exclude it');
        const inside = html.slice(start, html.indexOf('</section>', start));
        const outside = `${html.slice(0, start)}${html.slice(html.indexOf('</section>', start))}`;

        for (const retired of ['Runs', 'Repositories']) {
            assert.ok(inside.includes(`<code>${retired}</code>`), `the mapping table carries ${retired}`);
            assert.ok(!outside.includes(`<code>${retired}</code>`), `${retired} appears nowhere else on the page`);
        }
    });
});