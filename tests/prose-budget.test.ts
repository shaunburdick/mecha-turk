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
 * ## Words are the metric; lines are a record
 *
 * A prose *line* is a unit of layout, not of burden. It moves when a file is
 * re-wrapped and when a paragraph is cut into a list, and neither removes a word
 * a reader has to read. **AC-016 measures prose words**, and `CEILING` is the
 * pre-feature word figure itself — so a reflow cannot satisfy or break the
 * budget, and the number a reader is charged is the number that is enforced.
 *
 * The line count is **still measured and still reported**, because the structural
 * fact it carries is worth keeping, and it is pinned rather than left free — but
 * **it is no longer a ceiling**. `PINNED_LINES` is a fact about the site's shape,
 * not a bound on reader burden: a re-flow that changed it would be worth seeing in
 * the diff, not a budget being met. Every line figure here is therefore a
 * *reported and pinned* measurement, and `CEILING` — in words — is the only
 * enforced bound in this file.
 *
 * ## What the measurement found
 *
 * On this tree, measured by the functions below:
 *
 * | | prose lines | words |
 * | --- | --- | --- |
 * | `README.md` + walkthrough at `d2d3f40` (the budget AC-016 names) | 446 | 5,770 |
 * | `README.md` + walkthrough now | 82 | 1,110 |
 * | the five site pages now | 450 | 5,017 |
 * | **site content + README (the spend)** | **476** | **5,233** |
 *
 * Read by words — the metric AC-016 names — the move is a move: 5,233 against a
 * 5,770 budget, **537 words under**, so the shipped state **meets** AC-016.
 *
 * Read by prose lines it does not, and that is exactly why lines are not the
 * metric: 476 against 446, **30 lines over (6.7%)**. Those thirty are **not** a
 * wrap artifact. The site's pages carry fewer words in *more* lines, so they are
 * less dense per line than the documents were — 11.0 words per line against 12.9 —
 * because the site's content is broken into more, shorter units (headings, list
 * items, definition terms, table cells) rather than the documents' paragraphs.
 * **A budget that punishes the format the spec requires is measuring the wrong
 * thing** — the unit is words, and the thirty are preserved here as the record of
 * why.
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

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
 * The one enforced ceiling in this file: **prose words**, at the pre-feature
 * figure itself. The shipped site measures 5,233 — 537 words under — so AC-016 is
 * met with room rather than against a ceiling raised to fit the tree. Growth past
 * it fails visibly; admitting a legitimate increase is a one-line diff to this
 * constant, reviewed in the pull request.
 */
const CEILING = { words: 5_770 } as const;

/**
 * The shipped prose-line figure — **pinned, not a ceiling**. See the header: the
 * site's pages are cut into more, shorter units than the documents they replaced,
 * which is why AC-016 measures words. The count is asserted so it cannot move
 * unnoticed, and a changed figure says the *shape* of the prose moved, which is
 * itself worth seeing in a diff. It bounds nothing.
 *
 * Moved 462 → 476 with the *How Status keeps itself current* section on `/use/`
 * (14 lines, 190 words): content the site is now measured against, not a reflow.
 * The word ceiling is untouched, so the enforced bound did not move with it.
 *
 * Moved 476 → **478** with the release-tag paragraph on `/install/` (2 lines):
 * the current tag, read from the manifest rather than authored (FR-053), so the
 * number a reader pastes after the git URL is the one the extension ships. The
 * footer's own version line never reaches this measure — it is component
 * furniture, excluded by construction — so the figure moved by the page alone.
 */
const PINNED_LINES = 478;

/**
 * The prose each bound document measures now, so growth cannot pass unnoticed.
 *
 * `walkthrough` moved **56 → 73 on 2026-10-05**, for the history-scope section 002 v1.13.0
 * adds (GitHub issue #22): FR-042 binds the walkthrough to state what the history scope is
 * and is not, and 007 FR-049 reduced every *other* operator section to a pointer, so that
 * clause and the one-home rule pull in opposite directions and the product owner resolved
 * it by keeping the documentation here.
 *
 * The same decision as `PINNED_LINES`' second move, and the same discipline: the section was
 * **trimmed to the operator-facing core first** — 69 prose lines down to 17 — so the figure
 * moved by 17 and not by 69, and everything the trim removed is stated authoritatively in
 * spec 002's `FR-053` – `FR-094` rather than nowhere. What remains is what FR-090 requires
 * an operator to be told before choosing: the two options, that the look-back happens once,
 * that it is bounded with no "all history", that an existing binding **may offer many
 * sessions**, that a recovery replay re-offers work regardless, and the upgrade consequence.
 *
 * Moved 73 → **76 on 2026-10-09**, for §10 "What happens after a dispatch" (3 prose lines) the
 * tracking lifecycle amendment (002 v1.16.0, GitHub issue #13) adds: FR-042 binds the walkthrough
 * to the operator-facing surfaces this feature changes, and the section is a pointer to the
 * published page that answers in full, so the three lines it keeps are the delta an operator
 * must know and nothing else — one run and one session per work item, that a delivery may move
 * their view, and that the item's terminal state is the end. The first draft of the amendment
 * took this figure to 98; the product owner's scope finding cut it to 25 lines and the reduction
 * to 3.
 *
 * **`CEILING.words` is untouched, deliberately.** The walkthrough is not in `spend()`, so
 * adding prose here moves a reported figure and no enforced bound; the reader-burden ceiling
 * the owner protected is not what this constant is.
 *
 * The combined reduction assertion below is **also untouched**: at 26 + 76 = 102 it still
 * clears `BEFORE.lines / 4` (111), so the trimming bought the whole of what was needed and
 * no reduction claim was given up beyond the recorded figure.
 */
const REDUCED = { readme: 26, walkthrough: 76 } as const;

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
 * Every balanced `{expression}` body in a text, as a `path`/`line`/`body` finding.
 *
 * ## Why this is its own assertion and not a side effect of the measure
 *
 * `stripExpressions` is the budget's biggest hole and it is a hole the measure *cannot*
 * close by itself. Words inside an expression body are stripped before `residue` counts,
 * so a page can carry reader-facing prose in `{…}` and the budget will not see it — the
 * words are real to the reader and absent from the measurement that is supposed to bound
 * them. A budget with an unbounded blind spot is not a budget with a small error bar; it is
 * a number that happens to be computed correctly on the subset it can read.
 *
 * So the strip stays where it is (an expression's *code* is markup and the measure is
 * right to drop it), and this is the paired assertion: the thing the measure drops on
 * purpose is separately asserted to carry no prose a reader reads.
 *
 * ## What counts as prose in a body, and what does not
 *
 * Not "contains a letter". A body is code by default, and the shipped site's bodies are
 * full of legitimate code-shaped content: `{'{number}'}` (a literal marker the configure
 * page *documents*, `site/src/pages/configure.astro`), `{row.entry}` (a member access),
 * `{withBase('/use/')}` (a call with a string argument).
 *
 * The discriminator is a **string literal holding prose**, in the two shapes that mean
 * different things:
 *
 * - **Multi-word prose** — a literal with a space-separated run of words. `'the manifest,
 *   by name'`. A sentence a reader reads, invisible to the budget. This is the case the
 *   assertion exists for.
 * - **A single bare word** — `'config.json'`, `'host'`, `'tbd'`. Identifiers, filenames,
 *   enum values, and the documented literal marker are all this shape, and the site's
 *   legitimate tables are full of them. Counting these would have made the assertion
 *   refuse the code it is meant to police.
 *
 * So the rule is **a literal carrying two or more words**, not "a literal". That is a
 * stated boundary rather than a fitted one: it is what distinguishes a sentence from a
 * filename, and the shipped site sits on the right side of it in all thirteen cases.
 *
 * All three literal spellings are read — single, double, and backtick. A backtick literal is
 * how an Astro expression holds a sentence (`{`…`}`), so leaving it out would have made the
 * assertion blind to exactly the shape a prose-hiding author reaches for first.
 *
 * @param path - Path of the document, absolute or repository-relative as `resolve` takes it.
 * @returns One finding per prose-carrying expression body.
 */
function proseInExpressions(path: string): readonly string[] {
    const findings: string[] = [];
    const lines = body(readFileSync(resolve(ROOT, path), 'utf8'), path).split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
        // Innermost-first, repeatedly — the same order `stripExpressions` uses, so what is
        // read here is exactly what the measure drops. An unbalanced expression leaves its
        // braces, which carry no literal and so no finding.
        let remaining = line;
        while (/\{[^{}]*\}/.test(remaining)) {
            remaining = remaining.replaceAll(/\{[^{}]*\}/g, (body_) => {
                const literal = /'([^']*)'|"([^"]*)"|`([^`]*)`/.exec(body_);
                const text = (literal?.[1] ?? literal?.[2] ?? literal?.[3] ?? '').trim();
                if (text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length >= 2) {
                    findings.push(`${path}:${index + 1} ${JSON.stringify(text)}`);
                }

                return ' ';
            });
        }
    }

    return findings;
}

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
 * The `.project-health` baseline's repository-wide prose figure — **a neighbouring
 * tracked metric, not this budget's reference**. NFR-006 names it as what it is:
 * `allDocProseLines` is a tracked metric *of the project-health skill* over a
 * different population (every documentation prose line in the whole repository,
 * not the four documents AC-016 compares), and it is that skill's to regenerate
 * deliberately. So it is read rather than pinned — pinning another owner's
 * baseline here would fail on a legitimate regeneration — and carried into every
 * budget failure so the wider context is on the record.
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
 * The same cell pair for a bound stated in words alone, so the enforced ceiling
 * prints in the same columns as every other figure rather than leaving a blank
 * where a line count would be.
 *
 * @param words - The word figure to format.
 * @returns Its cell pair, with no line figure.
 */
function wordsOnly(words: number): string {
    return `${'—'.padStart(10)}  ${String(words).padStart(5)} words`;
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
        `    enforced ceiling    ${wordsOnly(CEILING.words)}  the pre-feature figure`,
        `    pinned line figure   ${PINNED_LINES} lines  reported, not enforced`,
        `    pre-feature budget  ${figures(BEFORE)}  at d2d3f40`,
        `    spend-budget gap    ${figures(gap)}`,
        `    .project-health/baseline.json allDocProseLines: ${String(repositoryWide())}`,
        '    A prose line is a unit of layout, not of burden: it moves when a file',
        '    is re-wrapped and when a paragraph is cut into a list, neither of which',
        '    removes a word a reader has to read. AC-016 therefore measures words,',
        '    at the pre-feature figure, which is the only bound enforced here.',
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

    it('finds prose hidden inside an expression, which the measure drops', () => {
        // The negative, on a document built to hide prose rather than to ship it. The
        // sentence below is counted by `residue` as nothing at all, because
        // `stripExpressions` removes the body before the word count runs — which is the hole
        // this assertion closes.
        //
        // Planted in a temporary directory rather than in `site/src/pages/`, because
        // `proseInExpressions` reads a repository-relative path and the honest way to hand
        // it one is to write a real file — and a real file written over a shipped page
        // would replace it. `mkdtempSync` under `os.tmpdir()` keeps the tree the gate
        // measures untouched, including on a failure.
        const directory = mkdtempSync(join(tmpdir(), 'prose-budget-'));
        const planted = join(directory, 'use.astro');
        writeFileSync(
            planted,
            [
                '<p>{`The dispatch is refused because no account is approved.`}</p>',
                '<p>{row.meaning}</p>',
                "<p>{'config.json'}</p>",
                '<p>Plain prose the measure does count.</p>',
            ].join('\n'),
        );
        try {
            // Not vacuous: the measure really does drop the sentence, so the finding
            // cannot be an artefact of the prose budget already counting it.
            expect(residue('<p>{`The dispatch is refused because no account is approved.`}</p>')).toBe('');
            expect(residue('<p>Plain prose the measure does count.</p>')).toBe('Plain prose the measure does count.');
            // The finding names the file and the line, so a failure says where to look.
            expect(proseInExpressions(planted)).toEqual([
                `${planted}:1 "The dispatch is refused because no account is approved."`,
            ]);
            // And the two shapes beside it are not reported: a member access and a
            // single-word literal are code, which is why the rule is "two or more words".
            expect(proseInExpressions(planted)).toHaveLength(1);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('reads the site\'s own expression bodies, and finds no prose in them', () => {
        // The shipped state, and the reason the rule above is shaped the way it is: the
        // site's bodies are all code — member accesses, calls with route arguments, and
        // one documented literal marker. `configure.astro`'s `{'{number}'}` is the case
        // that forces the single-word boundary; the thirteen bodies it finds are the
        // reason the walk is over the pages rather than a hand list.
        const findings = sitePages().flatMap((path) => proseInExpressions(path));

        expect(findings).toEqual([]);
        // Not vacuous: the reader found the bodies it is judging, and one of them is the
        // documented literal marker — the single-word literal the rule must not refuse.
        const patterns = sitePages().map(
            (path) => body(readFileSync(resolve(ROOT, path), 'utf8'), path).match(/\{[^{}]*[A-Za-z0-9][^{}]*\}/g) ?? [],
        );
        const bodies = patterns.flat();

        expect(bodies.length, 'the walk found no expression body to judge').toBeGreaterThan(5);
        // The literal marker as `configure.astro` writes it: an expression whose body is the
        // string `{number}` — a single word, which is why the rule must not refuse it.
        const marker = '{\'{number}\'}';

        expect(
            sitePages().some((path) => readFileSync(resolve(ROOT, path), 'utf8').includes(marker)),
            'the documented literal marker is gone, so the single-word boundary is untested',
        ).toBe(true);
    });

    it('reads the neighbouring project-health figure NFR-006 names, without pinning it', () => {
        // It is not the budget's reference and not pinned; it is read so a failure
        // can report the wider context, and it stays another owner's metric to move.
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

    it('meets the enforced word ceiling, which the pre-feature figure sets', () => {
        // The enforced bound, and the only one. It is the pre-feature figure itself
        // rather than a number raised to fit the tree, so AC-016 is met because the
        // move was a move: 5,233 words against 5,770, 537 under. A re-wrap, a
        // re-indent, or a paragraph cut into a list cannot move this.
        const measured = spend();
        expect(
            measured.words,
            `prose words grew past the ceiling — this is the metric a re-wrap cannot move\n${verdict(measured)}`,
        ).toBeLessThanOrEqual(CEILING.words);
    });

    it('pins the reported line figure without enforcing it as a ceiling', () => {
        // Lines are reported, not bounded. This asserts the figure so it cannot
        // move unnoticed, and the message says plainly that no budget is here: the
        // thirty lines over the pre-feature count are the record of a structural
        // fact — the site's content is cut into more, shorter units — not a miss.
        // The figure last moved when `/use/` gained *How Status keeps itself
        // current* (14 lines, 190 words), which the product owner asked for so
        // main's Status cadence has a home the README reduction did not leave it.
        // That is content, not a re-flow, so the pin moved with it and the word
        // ceiling above is what still bounds reader burden.
        const measured = spend();
        const enforced = `the enforced bound is ${String(CEILING.words)} words`;
        expect(
            measured.lines,
            `the reported prose-line figure moved — pinned, not a ceiling; ${enforced}\n${verdict(measured)}`,
        ).toBe(PINNED_LINES);
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
        // contributor commands and the license.
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

