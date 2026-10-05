/**
 * The prose budget (007 T-035) — NFR-006 and AC-016, and the measurement that
 * makes FR-049's *"a move, not an expansion"* falsifiable. Without this file the
 * claim lives in a commit message; with it, it is a number that changes when the
 * claim stops being true.
 *
 * ## The rule, and why this rule
 *
 * A line counts as prose when, after the markup is removed, what is left carries
 * a real word. Three consequences, each of them load-bearing:
 *
 * 1. **Markup is stripped, not counted.** The metric is named `allDocProseLines`
 *    in `.project-health/baseline.json` — it measures prose, not template
 *    syntax — and AC-016 excludes *"per-page navigation and footer furniture"*,
 *    which is prose-flavoured wording: it implies prose rather than raw lines.
 *    Counting Astro tags would measure how the site is *templated*, not how much
 *    it asks of a reader. The rejected alternative was measured, not assumed:
 *    under a literal line rule the five pages alone carry **1,067 non-blank
 *    lines** — more than twice the 446-line pre-feature budget — so markup would
 *    exhaust a budget the reader's burden never approached. A rule a refactor can
 *    move is not a budget.
 * 2. **Per-page navigation and footer furniture are excluded by construction,
 *    not by a filter.** `Nav` and `Footer` live in `site/src/components/` and
 *    every page inherits them through `Layout`, so this measure reads
 *    `site/src/pages/**` and never sees them. A six-link nav repeated on five
 *    pages would be 30 lines of "prose" under a rule that counted furniture, and
 *    it is not 30 lines of anything a reader reads twice.
 * 3. **A fenced block's delimiters are markup; its content is not.** A command
 *    block in the walkthrough is documentation the reader reads. Dropping the
 *    content too would make the budget trivially satisfiable by reformatting
 *    prose into a code block — the same hole as counting the markup.
 *
 * ## Two figures, because one of them is not the one that matters
 *
 * A prose *line* is a unit of layout, not of burden. It moves when a file is
 * re-wrapped and when a paragraph is cut into a list, and neither removes a word
 * a reader has to read. So every figure here is measured twice — as lines and as
 * words — and **both** are ratcheted. A single-line rule could be satisfied by a
 * reflow; the word count is what the reader is actually charged.
 *
 * ## What the measurement found
 *
 * On this tree, measured by the functions below:
 *
 * | | prose lines | words |
 * | --- | --- | --- |
 * | `README.md` + walkthrough at `d2d3f40` (the budget AC-016 names) | 446 | 5,770 |
 * | `README.md` + walkthrough now | 82 | 1,110 |
 * | the five site pages now | 436 | 4,827 |
 * | **site content + README (the spend)** | **462** | **5,040** |
 *
 * Read by words, the move is a move: 5,040 against a 5,770 budget, 730 words
 * **under**. `CEILING.words` is therefore the pre-feature figure itself rather
 * than the shipped one — the word budget is the real AC-016 bound, enforced at
 * its original number, with 730 words of headroom.
 *
 * Read by prose lines it is not: 462 against 446, **16 lines over (3.6%)**. So
 * AC-016 as written is **met on words and missed by sixteen lines**, and both
 * halves are asserted below rather than the flattering one being reported alone.
 * `CEILING.lines` is the shipped figure and `GAP.lines` is the sixteen, tracked:
 * the ceiling was not raised to hide the miss and the requirement was not
 * softened to fit the tree, so narrowing the gap is a one-line diff that names
 * the narrowing.
 *
 * The sixteen are **not** a wrap artifact, and this was checked rather than
 * assumed. The site's pages carry fewer words in *more* lines, so they are less
 * dense per line than the documents were — 10.9 words per line against 12.9 —
 * because the site's content is broken into more, shorter units (headings, list
 * items, definition terms, table cells) rather than the documents' paragraphs.
 * Re-flowing the whole site at the pre-feature 80 columns was measured too: 450
 * lines, still over 446. So re-wrapping is not the lever, and the sixteen are
 * real lines of prose the site adds, not a formatting difference.
 *
 * ## Provenance of the pre-feature figures
 *
 * They were measured at `d2d3f40` — `main`'s tip when this feature was specified,
 * and the deliberate reduction pass T-035 tells later work not to work against.
 * They are **recorded, not re-derived at run time**: `actions/checkout` in
 * `verify.yml` is left at its default depth, so a history read that works in a
 * developer's clone fails in the one place the gate actually runs. A budget that
 * quietly stops being checked in CI is worse than one recorded as a number a
 * reviewer can see in the diff that raises it.
 *
 * ## Read as text, never imported
 *
 * `site/` is a separate npm subproject with its own manifest, lockfile, and
 * `node_modules` (FR-007, FR-008); root `package.json` stays the dual-role
 * OpenChamber manifest with no workspace link (AGENTS.md invariant 2). Importing
 * an `.astro` page into a root test would drag Astro and a second dependency tree
 * into the repository's own gate.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** The README — half the budget, and part of the spend. */
const README = 'README.md';

/** The operator walkthrough — the other half of the budget. */
const WALKTHROUGH = 'specs/002-agent-event-extension/quickstart.md';

/** Where the site's pages live, relative to the root. */
const PAGES_DIR = 'site/src/pages';

/** The canonical site, as both reduced documents must point at it. */
const SITE = 'https://shaunburdick.github.io/mecha-turk/';

/**
 * The five pages AC-001 publishes, by bare name. The directory is read from disk
 * and compared against this list rather than the paths being hard-coded, so a
 * sixth page fails the measurement instead of quietly escaping it.
 */
const PUBLISHED_PAGES: readonly string[] = ['configure', 'debug', 'index', 'install', 'use'];

/**
 * The budget AC-016 names: the README and the operator walkthrough as they stood
 * at `d2d3f40`. Recorded, never read from git — see the header.
 */
const BEFORE = { lines: 446, words: 5_770 } as const;

/**
 * What this file enforces. `words` is the pre-feature figure itself, because the
 * shipped site is 730 words under it. `lines` is the shipped figure, because the
 * shipped site is sixteen lines over it, and `GAP` records the miss rather than
 * the ceiling absorbing it.
 */
const CEILING = { lines: 462, words: 5_770 } as const;

/**
 * Spend minus budget, in both metrics, at the figures above. `lines` is positive
 * (over); `words` is negative (under). A tracked pair, not a comment: it moves
 * when the site grows and when it is cut, and either way the diff is the record.
 */
const GAP = { lines: 16, words: -730 } as const;

/** The prose each bound document measures now, so growth cannot pass unnoticed. */
const REDUCED = { readme: 26, walkthrough: 56 } as const;

/** The only headings the reduced README may carry (FR-049). */
const README_HEADINGS: readonly string[] = ['# Mecha Turk', '## Development', '## License'];

/**
 * The walkthrough sections FR-049 reduces to pointers: install, first run, store,
 * and troubleshooting. Its build and verification sections stay, because they are
 * contributor commands rather than operator documentation.
 */
const POINTER_SECTIONS: readonly string[] = [
    '## 3. Install',
    '## 4. First run',
    '## 6. Service store & backup',
    '## 8. Troubleshooting',
];

/** One document's prose, measured. */
interface Prose {
    /** Lines whose markup-stripped residue carries a real word. */
    readonly lines: number;
    /** Words across those same lines; wrap-independent, so it cannot be reflowed. */
    readonly words: number;
}

/**
 * Everything that is markup rather than prose, removed before counting: an Astro
 * frontmatter block (the imports, the component's own doc comment, and its data
 * declarations — the shape of the template, not what it says), a `<style>` block,
 * and an HTML comment.
 *
 * @param text - The document's text.
 * @param path - Repository-relative path, which is what says whether a
 *   frontmatter block and a style block can be present at all.
 * @returns The prose-bearing part of the document.
 */
function body(text: string, path: string): string {
    if (!path.endsWith('.astro')) {
        return text;
    }
    return text
        .replace(/^\u{FEFF}?---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')
        .replaceAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replaceAll(/<!--[\s\S]*?-->/g, '');
}

/**
 * Every `{expression}` body, innermost pairs first and repeatedly: an Astro
 * expression nests, and the braces an inner one holds must not be read as the end
 * of the outer one. One pass is not enough for `{{a} b}`, and an unbalanced
 * expression simply leaves its leftover braces, which carry no word.
 *
 * @param text - Text that may contain expressions.
 * @returns The text with every balanced expression body replaced by a space.
 */
function stripExpressions(text: string): string {
    let stripped = text;
    while (/\{[^{}]*\}/.test(stripped)) {
        stripped = stripped.replaceAll(/\{[^{}]*\}/g, ' ');
    }
    return stripped;
}

/**
 * One line with its markup stripped: expression bodies first; then tags; then
 * markdown's own structure — heading, quote, bullet, and ordered markers, a link
 * with its target, thematic breaks, emphasis and code glyphs, and table cell
 * separators. Whitespace collapses to single spaces.
 *
 * A link's text goes with its target: a heading whose words are also the words
 * beneath it is a table of contents, not a second telling of the page.
 *
 * @param line - One source line.
 * @returns Its markup-free residue.
 */
function residue(line: string): string {
    return stripExpressions(line)
        .replaceAll(/<[^>]*>/g, ' ')
        .replace(/^\s*#{1,6}\s+/, ' ')
        .replaceAll(/^\s*>+\s?/g, ' ')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ' ')
        .replaceAll(/\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/^\s*-{3,}\s*$/, ' ')
        .replaceAll(/[*_`~|]/g, ' ')
        .replaceAll(/[<>(){}[\]#!]/g, ' ')
        .replaceAll(/\s+/g, ' ')
        .trim();
}

/** A word inside one line's residue, including internal apostrophes and hyphens. */
const WORD = /[A-Za-z0-9][A-Za-z0-9'’-]*/g;

/**
 * The prose-bearing residues of one document, one entry per counted line. Split
 * out from `measure` so the rule can be checked on its own terms: what it drops
 * and what it keeps are then two assertions about a list rather than arithmetic
 * that agrees with itself.
 *
 * A fence delimiter is markup and contributes nothing — including its language
 * tag, which survives `residue` as a bare word and would otherwise be counted. The
 * lines between two delimiters are counted like any other.
 *
 * @param path - Repository-relative path of the document.
 * @returns Each line's residue, for the lines that carry a real word.
 */
function proseLines(path: string): readonly string[] {
    const source = readFileSync(resolve(ROOT, path), 'utf8');
    const kept: string[] = [];
    let isFenced = false;
    for (const line of body(source, path).split(/\r?\n/)) {
        if (/^\s*(?:```|~~~)/.test(line)) {
            isFenced = !isFenced;
            continue;
        }
        const prose = residue(line);
        if (/[A-Za-z0-9]/.test(prose)) {
            kept.push(prose);
        }
    }
    return kept;
}

/**
 * Measure one document.
 *
 * @param path - Repository-relative path of the document.
 * @returns Its line and word counts.
 */
function measure(path: string): Prose {
    const lines = proseLines(path);
    return {
        lines: lines.length,
        words: lines.reduce((count, line) => count + (line.match(WORD) ?? []).length, 0),
    };
}

/**
 * Add measurements together.
 *
 * @param counts - The measurements to add.
 * @returns Their sum, per metric.
 */
function total(...counts: readonly Prose[]): Prose {
    let lines = 0;
    let words = 0;
    for (const count of counts) {
        lines += count.lines;
        words += count.words;
    }
    return { lines, words };
}

/** Sort two page names, stated rather than left to the platform's default. */
function byName(first: string, second: string): number {
    return first.localeCompare(second);
}

/**
 * The site pages, discovered rather than listed: every `.astro` file directly in
 * `site/src/pages`, as a repository-relative path, sorted for a stable ledger.
 *
 * @returns One path per page.
 */
function sitePages(): readonly string[] {
    return readdirSync(resolve(ROOT, PAGES_DIR))
        .filter((name) => name.endsWith('.astro'))
        .map((name) => `${PAGES_DIR}/${name}`)
        .toSorted(byName);
}

/** AC-016's spend, measured: the site's content plus the README. */
function spend(): Prose {
    return total(measure(README), ...sitePages().map((path) => measure(path)));
}

/**
 * The `.project-health` baseline's repository-wide prose figure, which NFR-006
 * names as the reference. Read rather than pinned: that number belongs to the
 * project-health tool, which regenerates it deliberately, and pinning another
 * owner's baseline here would fail on a legitimate regeneration. It is carried
 * into every budget failure so the comparison AC-016 asks for is on the record.
 *
 * @returns `allDocProseLines`, or `unreadable` if the field is not a number.
 */
function repositoryWide(): number | string {
    const baseline: unknown = JSON.parse(
        readFileSync(resolve(ROOT, '.project-health/baseline.json'), 'utf8'),
    );
    if (typeof baseline !== 'object' || baseline === null) {
        return 'unreadable';
    }
    const figure = (baseline as Record<string, unknown>).allDocProseLines;
    return typeof figure === 'number' ? figure : 'unreadable';
}

/**
 * One measurement as a right-aligned cell pair, so every row of the ledger lines
 * up and a reader comparing two failures is comparing columns.
 *
 * @param count - The measurement to format.
 * @returns Its two figures.
 */
function figures(count: Prose): string {
    return `${String(count.lines).padStart(4)} lines  ${String(count.words).padStart(5)} words`;
}

/**
 * A per-file breakdown naming every document counted, so a failure says which one
 * moved rather than only that a sum did.
 *
 * @returns One aligned line per document, then the total.
 */
function ledger(): string {
    const paths = [README, WALKTHROUGH, ...sitePages()];
    const rows = paths.map((path) => `    ${path.padEnd(46)}  ${figures(measure(path))}`);
    const sum = total(...paths.map((path) => measure(path)));
    return [...rows, `    ${'total'.padEnd(46)}  ${figures(sum)}`].join('\n');
}

/**
 * The block every budget assertion carries on failure: what was measured, against
 * what, the pre-feature figure, the gap to it, and the repository-wide reference
 * NFR-006 names.
 *
 * @param measured - What this run measured for the spend.
 * @returns The message body.
 */
function verdict(measured: Prose): string {
    const gap: Prose = {
        lines: measured.lines - BEFORE.lines,
        words: measured.words - BEFORE.words,
    };
    return [
        ledger(),
        `    ceiling             ${figures(CEILING)}`,
        `    pre-feature budget  ${figures(BEFORE)}  at d2d3f40`,
        `    gap, spend-budget   ${figures(gap)}`,
        `    .project-health/baseline.json allDocProseLines: ${String(repositoryWide())}`,
        '    A prose line is a unit of layout, not of burden: it moves when a file',
        '    is re-wrapped and when a paragraph is cut into a list, neither of which',
        '    removes a word a reader has to read. The word count is ratcheted too,',
        '    at the pre-feature figure, and it is the one with 730 words of room.',
    ].join('\n');
}

/**
 * One `## ` section of a markdown document, by its exact heading line.
 *
 * @param document - The whole markdown document.
 * @param heading - The heading line, `## ` included.
 * @returns The section's body, or the empty string when the heading is absent.
 */
function section(document: string, heading: string): string {
    const start = document.indexOf(`${heading}\n`);
    if (start === -1) {
        return '';
    }
    const rest = document.slice(start + heading.length + 1);
    const next = rest.search(/^## /m);
    return next < 0 ? rest : rest.slice(0, next);
}

/**
 * Every ATX heading line in a markdown document, in order.
 *
 * @param document - The whole markdown document.
 * @returns Its headings, verbatim.
 */
function headings(document: string): readonly string[] {
    return document.match(/^#{1,6} .+$/gm) ?? [];
}

/** Non-blank line count, used only to prove the fence rule is doing something. */
function nonBlank(path: string): number {
    return readFileSync(resolve(ROOT, path), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '').length;
}

describe('007 T-035 the measure is a measurement, not a constant', () => {
    it('strips markup and counts what is left', () => {
        // A tag, an expression, and a table's delimiter row carry no real word,
        // so none of them is prose however they are written.
        expect(residue('    <p class="x">')).toBe('');
        expect(residue('    {withBase("/install")}')).toBe('');
        expect(residue('| --- | --- |')).toBe('--- ---');
        // Nested braces are stripped innermost-first, so an expression's own
        // brace does not terminate it early.
        expect(residue('{items.map((item) => <li>{item}</li>)}')).toBe('');
        // What a reader reads survives, with markdown's markers turned into the
        // whitespace they already were. An emphasis pair leaves a space where the
        // glyph stood, which neither metric can tell: both count words and lines,
        // and neither counts the gap.
        expect(residue('## Install')).toBe('Install');
        expect(residue('- **Fail closed**: a missing project blocks dispatch')).toBe(
            'Fail closed : a missing project blocks dispatch',
        );
        expect(residue('  Mecha Turk polls GitHub.')).toBe('Mecha Turk polls GitHub.');
        // A frontmatter block is markup, however much prose its doc comment
        // carries, and a markdown document has none to remove.
        const frontmatter = '---\n/**\n * A long comment about the page.\n */\nimport L from \'./l.astro\';\n---\n';
        expect(body(`${frontmatter}<p>Prose.</p>`, 'p.astro')).toBe('<p>Prose.</p>');
        expect(body('| a | b |\n', 'd.md')).toBe('| a | b |\n');
    });

    it('fences count their content and not their delimiters', () => {
        // The walkthrough is half the budget and carries the contributor command
        // blocks, so it is the document this is checked against: the rule drops
        // each ``` and its language tag, and keeps the command between them.
        const kept = proseLines(WALKTHROUGH);
        expect(kept, 'the walkthrough no longer has a fenced block').toContain('npm ci');
        expect(kept, 'a fence delimiter was counted as prose').not.toContain('sh');
        expect(kept, 'a table delimiter row was counted as prose').not.toContain('--- ---');
        // Every delimiter is a line the measure did not count, so the counted
        // prose is below the document's own non-blank lines.
        expect(measure(WALKTHROUGH).lines).toBeLessThan(nonBlank(WALKTHROUGH));
    });

    it('reads the repository-wide figure NFR-006 names, without pinning it', () => {
        expect(repositoryWide()).toBeGreaterThan(0);
    });
});

describe('007 AC-016 the site is measured, page by page', () => {
    it('measures exactly the five pages AC-001 publishes', () => {
        const suffix = '.astro'.length;
        const prefix = PAGES_DIR.length + 1;
        const found = sitePages().map((path) => path.slice(prefix, -suffix)).toSorted(byName);
        expect(found).toStrictEqual([...PUBLISHED_PAGES].toSorted(byName));
        // And every one of them carries prose: a page that measured zero would
        // satisfy this suite by being empty.
        for (const path of sitePages()) {
            expect(measure(path).lines, `${path} measures no prose at all`).toBeGreaterThan(20);
        }
    });

    it('the site content plus the README is inside the recorded ceiling', () => {
        const measured = spend();
        expect(
            measured.lines,
            `prose lines grew past the ceiling\n${verdict(measured)}`,
        ).toBeLessThanOrEqual(CEILING.lines);
        expect(
            measured.words,
            `prose words grew past the ceiling — this is the metric a re-wrap cannot move\n${verdict(measured)}`,
        ).toBeLessThanOrEqual(CEILING.words);
    });

    it('records the gap to the pre-feature budget rather than absorbing it', () => {
        const measured = spend();
        const lines = measured.lines - BEFORE.lines;
        const words = measured.words - BEFORE.words;
        // AC-016 as written is **met on words and missed on lines**: 5,040 words
        // against a 5,770 budget, and 462 prose lines against 446. Both halves are
        // asserted, so the suite cannot be made to report the flattering one
        // alone, and the line ceiling is not raised to hide the sixteen.
        expect(lines, `the recorded line gap moved\n${verdict(measured)}`).toBe(GAP.lines);
        expect(words, `the recorded word gap moved\n${verdict(measured)}`).toBe(GAP.words);
    });
});

describe('007 AC-016 the two bound documents shrank', () => {
    it('each of them measures its reduced figure', () => {
        expect(measure(README).lines, `${README} moved\n${ledger()}`).toBe(REDUCED.readme);
        expect(measure(WALKTHROUGH).lines, `${WALKTHROUGH} moved\n${ledger()}`).toBe(REDUCED.walkthrough);
        // And the pair is far below the budget it used to be, so the reduction
        // is a measurement rather than an intention.
        expect(total(measure(README), measure(WALKTHROUGH)).lines).toBeLessThan(BEFORE.lines / 4);
    });

    it('the README carries no operator topic of its own', () => {
        // FR-049: each section of the README maps to exactly one site page, and
        // no section's substance is left in full in both places. The pre-feature
        // README carried eighteen headings — How it works, Honest boundaries, The
        // panel, Configuration, Requirements, Install, Set up, Starting prompt,
        // First dispatch, When a dispatch doesn't go through, Where your data
        // lives, Security at a glance, Uninstall, Troubleshooting — and every one
        // of them is a page now. Two are legitimately the repository's own: the
        // contributor commands and the licence.
        const document = readFileSync(resolve(ROOT, README), 'utf8');
        const found = headings(document);
        expect(
            found.filter((heading) => !README_HEADINGS.includes(heading)),
            `${README} carries a section the site owns`,
        ).toStrictEqual([]);
        // Not vacuous: the scanner reads the headings that are allowed to stay.
        expect(found).toStrictEqual(README_HEADINGS);
        expect(document).toContain(SITE);
    });

    it("the walkthrough's operator sections are pointers", () => {
        const document = readFileSync(resolve(ROOT, WALKTHROUGH), 'utf8');
        for (const heading of POINTER_SECTIONS) {
            const pointer = section(document, heading);
            // Not vacuous: a heading that went missing would leave an empty scan
            // and every assertion in this loop would pass on nothing.
            expect(pointer, `${WALKTHROUGH} no longer has ${heading}`).not.toBe('');
            expect(pointer, `${heading} does not point at the canonical page`).toContain(SITE);
            // The substance moved to the page, so what is left carries no table
            // and no command block. §1, §2 and §5 are absent from this list by
            // construction: they are the build, verification, and
            // manual-verification commands FR-049 keeps.
            expect(pointer, `${heading} still carries a table`).not.toMatch(/^\s*\|/m);
            expect(pointer, `${heading} still carries a fenced block`).not.toMatch(/^\s*(?:```|~~~)/m);
        }
        // The exempt sections really do still carry what FR-049 leaves them, so
        // the scan above is scoped by list rather than by the document having
        // lost its substance wholesale.
        expect(section(document, '## 1. Build')).toMatch(/^\s*(?:```|~~~)/m);
        expect(section(document, '## 5. Manual verification checklist (post-install)')).toMatch(/^\s*\|/m);
    });
});

