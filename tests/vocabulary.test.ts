import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RESOLVE_LABEL, RETRY_LABEL, RETURN_LABEL } from '../src/dispatches-rows.ts';
import { AUDIT_BUTTON_LABEL } from '../src/audit-view.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import { byText } from './support/sort.ts';
import { fakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';

/**
 * The four-layer vocabulary guard (005 T-003 + T-029, FR-020–FR-024, FR-028).
 *
 * Waves 1 and 2 renamed the panel's *source* vocabulary — L2 — while leaving
 * user-facing copy (L1), wire paths (L3), and the run domain (L4) alone. This
 * suite is what makes that discipline a build gate rather than a review habit:
 *
 * 1. no retired module file (`src/repos*.ts`, `src/runs*.ts`) may exist;
 * 2. every relative import under `src/` must resolve, so a missed sweep fails
 *    here instead of surprising the typechecker later;
 * 3. the L4 terms FR-022 retains must still be present, so the L2 guard cannot
 *    be satisfied by over-renaming the domain vocabulary away;
 * 4. **the L1 half (T-029)**: the six tabs' rendered output and `README.md`
 *    carry neither retired noun *as a noun*, with **no exempt source at all**
 *    — the short mapping list the About tab used to render was removed with
 *    the rest of that page by the 2026-10-01 product-owner scrub (005
 *    v1.6.0), and the readme's own mapping table went the same day under the
 *    same owner's ruling (a user-oriented readme carries no rename history),
 *    so every string the six tabs hand the SDK is scanned and `README.md` is
 *    read whole — and test names follow their subject's layer (FR-028).
 *
 * The L1 scan reads what the tabs actually handed the SDK, recursively, so a
 * tab label or a list row title counts as much as a headline does.
 */

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** The panel's source directory, repository-relative. */
const SRC_DIR = 'src';

/** Directories the L4 retention scan reads, repository-relative. */
const L4_SCAN_DIRS: readonly string[] = ['src', 'service', 'tests'];

/** Encoding used when reading text files. */
const UTF8 = 'utf8';

/** Module-file names the L2 rename retired (FR-024). */
const RETIRED_MODULE_PATTERNS: readonly RegExp[] = [/^repos.*\.ts$/, /^runs.*\.ts$/];

/** Modules the L2 rename produced; none may be missing from the tree. */
const RENAMED_MODULES: readonly string[] = [
    'bindings-mount.ts',
    'bindings-rows.ts',
    'bindings-service.ts',
    'bindings-ui.ts',
    'bindings.ts',
    'dispatches-rows.ts',
    'dispatches-service.ts',
    'dispatches-ui.ts',
    'dispatches.ts',
];

/**
 * L4 terms FR-022 retains verbatim, each with the corpus that must still carry
 * it. The list is the allow-list: renaming one of these away is exactly the
 * over-rename this suite exists to refuse.
 */
const RETAINED_L4: readonly { readonly token: string; readonly note: string }[] = [
    { token: 'RunRow', note: 'the run-history projection type' },
    { token: 'runKey', note: 'the deterministic run key' },
    { token: 'attempt', note: 'the dispatch-attempt identity' },
    { token: 'retryRun', note: 'the run-keyed retry operation' },
    { token: 'runs.json', note: 'the durable run document' },
    { token: 'run.', note: 'the audit entity prefix' },
];

/** One module a vocabulary scan read. */
interface ScannedModule {
    /** Repository-relative path, used in failure messages. */
    readonly path: string;
    /** Module text exactly as written. */
    readonly text: string;
}

/** A relative specifier and the module that carries it. */
interface BrokenImport {
    /** Repository-relative path of the importing module. */
    readonly from: string;
    /** The specifier that did not resolve. */
    readonly specifier: string;
}

/**
 * List the panel's `.ts` modules.
 *
 * @returns Sorted file names (no directory prefix) under `src/`.
 */
function panelModules(): readonly string[] {
    return readdirSync(resolve(ROOT, SRC_DIR))
        .map(String)
        .filter((entry) => entry.endsWith('.ts'))
        .toSorted(byText);
}

/**
 * Read every `.ts` file under the given repository-relative directories.
 *
 * @param dirs - Directories to walk, recursively.
 * @returns The path and text of each module found.
 */
function scanModules(dirs: readonly string[]): readonly ScannedModule[] {
    const modules: ScannedModule[] = [];

    for (const dir of dirs) {
        const entries = readdirSync(resolve(ROOT, dir), { recursive: true }).map(String);
        for (const entry of entries) {
            if (!entry.endsWith('.ts')) {
                continue;
            }

            const path = `${dir}/${entry}`;
            modules.push({ path, text: readFileSync(resolve(ROOT, path), UTF8) });
        }
    }

    return modules;
}

/**
 * Collect the relative module specifiers one module imports statically.
 *
 * @returns Each specifier that starts with `./` or `../`, in source order.
 */
function relativeSpecifiers(text: string): readonly string[] {
    const pattern = /(?:from\s+|import\s+)'(\.[^']+)'/g;
    const specifiers: string[] = [];
    for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier !== undefined) {
            specifiers.push(specifier);
        }
    }

    return specifiers;
}

/**
 * Resolve each module's relative specifiers against its own directory.
 *
 * @returns One entry per specifier that names a file that does not exist.
 */
function unresolvedImports(modules: readonly ScannedModule[]): readonly BrokenImport[] {
    const broken: BrokenImport[] = [];

    for (const module of modules) {
        for (const specifier of relativeSpecifiers(module.text)) {
            const target = resolve(ROOT, dirname(module.path), specifier);
            if (!existsSync(target)) {
                broken.push({ from: module.path, specifier });
            }
        }
    }

    return broken;
}

describe('L2 module vocabulary: the renamed files are the only ones that exist (005 T-003)', () => {
    it('reads a real panel source tree rather than an empty directory', () => {
        {
            expect(panelModules().length).toBeGreaterThan(40);
        }
        {
            const retired = panelModules().filter((name) => RETIRED_MODULE_PATTERNS.some((pattern) => pattern.test(
                name
            )));

            expect(retired).toEqual([]);
        }
        {
            const names = new Set(panelModules());

            for (const expected of RENAMED_MODULES) {
                expect(names.has(expected), `${SRC_DIR}/${expected} must exist after the L2 rename`).toBe(true);
            }
        }
        {
            const candidates = ['bindings.ts', 'repos.ts', 'runs-ui.ts'];
            const reverted = candidates.filter((name) => RETIRED_MODULE_PATTERNS.some((pattern) => pattern.test(name)));

            expect(reverted).toEqual(['repos.ts', 'runs-ui.ts']);
        }
    });
});

describe('every src/** import resolves to a file that exists (005 T-003)', () => {
    /** Repository-relative path the synthetic fixtures pretend to live at. */
    const SYNTHETIC_PATH = 'src/example.ts';

    it('scans the panel modules rather than nothing', () => {
        {
            expect(scanModules([SRC_DIR]).length).toBeGreaterThan(40);
        }
        {
            expect(unresolvedImports(scanModules([SRC_DIR]))).toEqual([]);
        }
        {
            const text = "import { thing } from './gone.ts';";
            const synthetic: readonly ScannedModule[] = [{ path: SYNTHETIC_PATH, text }];

            expect(unresolvedImports(synthetic)).toEqual([{ from: SYNTHETIC_PATH, specifier: './gone.ts' }]);
        }
        {
            const text = "import { readFileSync } from 'node:fs';\nexport { thing } from './real.ts';";

            expect(relativeSpecifiers(text)).toEqual(['./real.ts']);
        }
    });
});

describe('the L4 domain vocabulary FR-022 retains is still present (005 T-003)', () => {
    it('finds every retained term somewhere in the scanned source', () => {
        {
            const corpus = scanModules(L4_SCAN_DIRS)
                .map((module) => module.text)
                .join('\n');

            expect(corpus.length).toBeGreaterThan(1_000);

            for (const { token, note } of RETAINED_L4) {
                expect(corpus.includes(token), `${token} (${note}) must survive the L2 rename`).toBe(true);
            }
        }
        {
            const modules = scanModules(L4_SCAN_DIRS);

            expect(modules.some((module) => module.path.startsWith('src/'))).toBe(true);
            expect(modules.some((module) => module.path.startsWith('service/'))).toBe(true);
            expect(modules.some((module) => module.path.startsWith('tests/'))).toBe(true);
        }
    });
});

/* -------------------------------------------------------------------- *
 * L1 — the words an operator reads (005 T-029, FR-020, FR-029, FR-028)
 * -------------------------------------------------------------------- */

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });

                return {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => undefined,
                };
            };
        }
    }

    return stubbed;
});

/** The six tabs FR-010 puts in the strip, in strip order. */
const TAB_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'] as const;

/** The panel-level handler the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
};

/** One retired-noun rule: a shape that can only be a noun use. */
interface NounRule {
    /** What the finding means, printed when the rule bites. */
    readonly name: string;
    /** The shape to look for. */
    readonly pattern: RegExp;
}

/**
 * The nouns the rename retired (FR-020, SC-107).
 *
 * The imperative verb survives on purpose — *Run OpenChamber on web or
 * desktop* is an instruction, and its capitalized complement is what tells
 * the two apart from *Run shows …*. The retained domain vocabulary (FR-022)
 * survives too: `runKey`, `runs.json`, and `mt-run-…` are identifiers, not
 * prose, so no rule below looks for them.
 */
const CAPITAL_NOUNS: readonly NounRule[] = [
    { name: 'Repositories (the bindings noun)', pattern: /\bRepositories\b/g },
    { name: 'Runs (the work-unit noun)', pattern: /\bRuns\b/g },
    { name: 'Run followed by a lowercase word (a noun use of Run)', pattern: /\bRun\b\s+[a-z]/g },
];

/**
 * The domain noun in prose (`the run …`), which FR-022 retains for the
 * domain but FR-020 never wanted in a sentence an operator reads.
 *
 * Deliberately **not** applied to test titles: FR-028 keeps a test of the
 * run model named as a test of the run model.
 *
 * `run key` is exempt, and the site's debug page is what showed this rule was a
 * shape too wide. `runKey` is a retained identifier (FR-022) and the panel's own
 * shipped copy writes it in prose — `src/dispatches-rows.ts` tells a reader a
 * retry returns a dispatch "to waiting under the same run key" — so a rule that
 * bit on the two-word spelling would forbid the product's own words and would
 * have failed a page the specification endorses (007 FR-050 bans `run` as a noun
 * *for a unit of work*, which is not what the identifier is). The camelCase
 * spelling was already outside every rule here, which is why it took a surface
 * that spells it out in prose to find the gap.
 */
const DOMAIN_PROSE_RULE: NounRule = {
    name: 'an article + run (the domain noun in a sentence)',
    pattern: /\b(?:the|this|each|every|its|same|selected|one|that|own)\s+run\b(?!\s*[- ]?keys?\b)/gi,
};

/**
 * Collect every string inside one SDK mount's props, however deeply nested.
 *
 * Tab labels, list titles, and subtitles all live one level down, so a
 * shallow read would skip exactly the rows FR-020 names first.
 *
 * @param found - Accumulator the caller owns.
 */
function collectStrings(value: unknown, found: string[]): void {
    if (typeof value === 'string') {
        found.push(value);

        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectStrings(item, found);
        }

        return;
    }

    if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) {
            collectStrings(item, found);
        }
    }
}

/**
 * Every string one SDK mount was handed, at any depth.
 *
 * @returns The strings among them, in property order.
 */
function stringsIn(props: unknown): readonly string[] {
    const found: string[] = [];
    collectStrings(props, found);

    return found;
}

/**
 * Find the retired-noun uses in a text.
 *
 * @param text - The text to scan.
 * @returns One finding per match: the rule and the word it caught.
 */
function hits(rules: readonly NounRule[], text: string): readonly string[] {
    const findings: string[] = [];
    for (const rule of rules) {
        for (const match of text.matchAll(rule.pattern)) {
            findings.push(`${rule.name}: “${match[0]}”`);
        }
    }

    return findings;
}

/**
 * Mount all six tabs once and collect every string they handed the SDK.
 *
 * @returns The strings, newest paint last.
 */
async function renderedSixTabs(): Promise<readonly string[]> {
    mounts.log.length = 0;
    const rt = createTestRuntime(fakeHost());
    const dom = fakeDom();
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });
    for (const id of TAB_IDS) {
        rt.shell?.activate(id);
    }

    // Settings and About read on their first activation; a macrotask lets
    // both land so their repainted strings are in the scan too.
    await tick();
    const strings = mounts.log.flatMap((entry) => stringsIn(entry.props));
    rt.shell?.dispose();

    return strings;
}

describe('L1: no retired noun reaches an operator (005 T-029, AC-140, SC-107)', () => {
    it('mounts all six tabs, so the scan is not vacuous', async () => {
        {
            const strings = await renderedSixTabs();

            expect(strings.length).toBeGreaterThan(40);
            for (const label of ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About']) {
                expect(strings).toContain(label);
            }
        }
    });

    it('renders no retired noun in any of the six tabs', async () => {
        {
            const rendered = await renderedSixTabs();

            // **No exemption.** The About tab's short mapping list was the one
            // source the scan skipped — it is supposed to carry the retired words
            // as history — and the 2026-10-01 scrub removed it (005 v1.6.0), so
            // every string the six tabs hand the SDK is scanned now.
            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], rendered.join('\n'))).toEqual([]);
        }
    });

    it('renders no retired noun in the row-level labels the tabs export', async () => {
        {
            const labels = [RETRY_LABEL, RESOLVE_LABEL, RETURN_LABEL, AUDIT_BUTTON_LABEL].join('\n');

            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], labels)).toEqual([]);
        }
    });

    it('bites on every retired shape, so the scan cannot pass vacuously', async () => {
        {
            const sample = 'the Runs list — the Repositories tab — Run shows a reason';

            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], sample)).toHaveLength(3);
            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'every run failed')).toHaveLength(1);
            // The two shapes that must keep working: the imperative verb and the
            // retained identifiers. `run key` is the prose spelling of `runKey`,
            // which FR-022 retains and the panel itself prints.
            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'Run OpenChamber on web')).toEqual([]);
            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'runs.json runKey mt-run-1')).toEqual([]);
            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'the same run key, the run-key file')).toEqual([]);
            // And the exemption is the identifier, not the word `run` after it.
            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'every run keyed by the run keys')).toHaveLength(1);
        }
    });

    it('README.md names neither retired noun anywhere in it', async () => {
        {
            // Read whole: the mapping table that used to be the one exempt
            // section left the readme with the product owner's 2026-10-01
            // ruling, so there is nothing left to strip before scanning.
            const text = readFileSync(resolve(ROOT, 'README.md'), 'utf8');

            expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], text)).toEqual([]);
            // Not vacuous: the imperative use of the word still reads as English.
        }
    });

});

/* -------------------------------------------------------------------- *
 * L1 on the documentation site (007 T-032, FR-050, FR-051, AC-012)
 * -------------------------------------------------------------------- */

/**
 * The site's source directory, repository-relative.
 *
 * Read as **text** and never imported (007 FR-070): an import would pull Astro
 * and the site's own `node_modules` into the repository's gate, and the root
 * manifest must stay the installable manifest with no workspace link by which
 * the root could reach it (invariant 2, FR-007). Reading the source is also
 * what makes this suite runnable on a clone that has never built the site.
 */
const SITE_SRC_DIR = 'site/src';

/** The five pages the site publishes, so a walk that finds fewer has failed. */
const SITE_PAGES: readonly string[] = [
    'configure.astro',
    'debug.astro',
    'index.astro',
    'install.astro',
    'use.astro',
];

/**
 * The marked element: a `<section>` opening tag carrying the exclusion marker.
 *
 * The marker is an attribute rather than an HTML comment because Astro strips
 * comments from a template — a comment would scope the exclusion in the source
 * and vanish from the built page, so a scan could cut the table out of one and
 * not the other. Matching the opening tag as well as the attribute is what holds
 * the exclusion to a `<section>` rather than to any element at all (007 D14).
 */
const MAPPING_SECTION = /<section\b[^>]*\bdata-vocabulary-mapping\s*=\s*"true"/;

/** The retired nouns the mapping table exists to carry, spelled as the source spells them. */
const REQUIRED_MAPPING_NAMES: readonly string[] = ['Runs', 'Run', 'Repositories'];

/** A half-open span of one text. */
interface Span {
    readonly start: number;
    readonly end: number;
}

/** One site's source file, with the spans its mapping table occupies. */
interface SiteSource {
    readonly path: string;
    readonly text: string;
    readonly mappingTable: readonly Span[];
}

/**
 * Read one of the site's pages whole, frontmatter included.
 *
 * @param name - The file name under `site/src/pages/`.
 * @returns The page's text.
 */
function sitePage(name: string): string {
    return readFileSync(resolve(ROOT, SITE_SRC_DIR, 'pages', name), UTF8);
}

/**
 * The offset just past the bracket closing the one that opens at `open`.
 *
 * Bracket-counted rather than matched against a literal terminator, so the span
 * survives the declaration being re-wrapped or re-indented: this suite reads
 * somebody else's source, and a reader that depends on how it was formatted is a
 * reader that breaks on a change that changed nothing.
 *
 * @param text - The whole file.
 * @param open - Index of the opening bracket.
 * @returns The end offset, or `-1` when the brackets never balance.
 */
function bracketEnd(text: string, open: number): number {
    let depth = 0;

    for (let at = open; at < text.length; at += 1) {
        const character = text[at];
        if (character === undefined) {
            break;
        }

        if ('[{('.includes(character)) {
            depth += 1;
        } else if (']})'.includes(character)) {
            depth -= 1;
            if (depth === 0) {
                return at + 1;
            }
        }
    }

    return -1;
}

/**
 * The spans the identifier-mapping table occupies in one site's source file.
 *
 * **Two spans, and both are the table.** The marked `<section>` is where the
 * built page carries it; the array declaration the marked markup renders is
 * where the *source* carries it, because a `.astro` page keeps its rows in a
 * frontmatter binding rather than in markup. A scan that excluded only the
 * section would read the table's own rows as an unsanctioned use of the retired
 * words. The declaration is found by looking for the names the marked markup
 * itself mentions, rather than by naming one binding — so a page that moves the
 * table keeps its exemption, and a page that gains a marked section gains its
 * own.
 *
 * Nothing else is removed. A file with no marker yields no spans at all, so the
 * scan cannot widen itself by accident, and the assertions below pin which two
 * spans the shipped page produces.
 *
 * @param text - The file's whole text.
 * @returns The table's spans, the marked section first.
 */
function mappingTableSpans(text: string): readonly Span[] {
    const marked = MAPPING_SECTION.exec(text);
    if (marked === null) {
        return [];
    }

    const close = text.indexOf('</section>', marked.index);
    if (close === -1) {
        return [];
    }

    const spans: Span[] = [{ start: marked.index, end: close + '</section>'.length }];
    const inside = text.slice(marked.index, close);

    for (const declared of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
        const name = declared[1];
        if (name === undefined || !inside.includes(name)) {
            continue;
        }

        const equals = text.indexOf('=', declared.index + declared[0].length);
        const open = equals === -1 ? -1 : text.indexOf('[', equals);
        // Only an array *literal*. A binding initialised to a call or a spread
        // has no bracket to count, and swallowing whatever follows an `=` that is
        // not followed by `[` is exactly the silent over-exclusion this suite is
        // required to be unable to do.
        if (open === -1 || text.slice(equals + 1, open).trim() !== '') {
            continue;
        }

        const end = bracketEnd(text, open);
        if (end !== -1) {
            spans.push({ start: declared.index, end });
        }
    }

    return spans;
}

/**
 * One text with the given spans cut out of it.
 *
 * All of them in one pass, which is what makes it usable as the *negative* case
 * for the scan: removing the spans one at a time from the original text would
 * leave every span but the first still in the result. Sorted here because the
 * table's rows are declared *before* the section that renders them, so the two
 * spans arrive in the file's own order and not the file's reading order.
 *
 * @param text - The whole file.
 * @param spans - The spans to remove, non-overlapping.
 * @returns What is left, in the original order.
 */
function withoutSpans(text: string, spans: readonly Span[]): string {
    const kept: string[] = [];
    const ordered = [...spans].toSorted((left, right) => left.start - right.start);
    let at = 0;

    for (const span of ordered) {
        kept.push(text.slice(at, span.start));
        at = span.end;
    }
    kept.push(text.slice(at));

    return kept.join('');
}

/**
 * Every site's source file, with its mapping table's spans resolved.
 *
 * Walked rather than listed: the site's own guard records what a hand list costs
 * — three of its five pages shipped the same prose defect because the rule that
 * would have caught it was not shared, and `site/tests/prose-wrapping.assertions.mjs`
 * exists because of it. This is the same argument applied to the vocabulary.
 *
 * @returns Each file's repository-relative path, its text, and its table spans.
 */
function siteSources(): readonly SiteSource[] {
    return readdirSync(resolve(ROOT, SITE_SRC_DIR), { recursive: true })
        .map(String)
        .filter((entry) => /\.(?:astro|mjs|md|ts)$/.test(entry))
        .toSorted(byText)
        .map((entry) => {
            const text = readFileSync(resolve(ROOT, SITE_SRC_DIR, entry), UTF8);

            return { path: `${SITE_SRC_DIR}/${entry}`, text, mappingTable: mappingTableSpans(text) };
        });
}

/**
 * The retired-noun uses in one site's source that the mapping table does not cover.
 *
 * Split out of `siteFindings` so the nesting stays shallow enough to read: three
 * loops and a guard in one function body is where a reader stops being able to
 * see which of the two is the guard.
 *
 * @param source - The file, with its table spans resolved.
 * @returns One finding per unsanctioned match, naming the file and the line.
 */
function sourceFindings(source: SiteSource): readonly string[] {
    const findings: string[] = [];

    for (const rule of [...CAPITAL_NOUNS, DOMAIN_PROSE_RULE]) {
        for (const match of source.text.matchAll(rule.pattern)) {
            const at = match.index;
            const isCovered = source.mappingTable.some((span) => at >= span.start && at < span.end);
            if (isCovered) {
                continue;
            }

            const line = source.text.slice(0, at).split('\n').length;
            findings.push(`${source.path}:${line} ${rule.name}: “${match[0]}”`);
        }
    }

    return findings;
}

/**
 * The retired-noun uses in the site's source that the mapping table does not cover.
 *
 * @param sources - The site's files, each with its table spans.
 * @returns Every file's findings, in walk order.
 */
function siteFindings(sources: readonly SiteSource[]): readonly string[] {
    return sources.flatMap((source) => sourceFindings(source));
}

/**
 * Whether a text carries the identifier-mapping table (007 FR-051, AC-013).
 *
 * A **presence** check, and deliberately a separate property from the scan
 * above. That scan asserts an absence, and an absence is satisfied just as well
 * by a page that has no table at all — this repository's own README passed the
 * scan on exactly the day the table was taken out of it. So the exemption and
 * the requirement are checked apart: the scan says the retired words are
 * nowhere else, and this says they are somewhere.
 *
 * @param text - A site's source, or a fixture standing in for one.
 * @returns Whether the marked table and the rows it renders are both present.
 */
function carriesMappingTable(text: string): boolean {
    const spans = mappingTableSpans(text);
    const inside = spans.map((span) => text.slice(span.start, span.end));

    return (
        MAPPING_SECTION.test(text)
        && inside.some((piece) => piece.includes('<table'))
        && REQUIRED_MAPPING_NAMES.every((name) => inside.some((piece) => piece.includes(`'${name}'`)))
    );
}

/**
 * A page shaped like the debug page: a marked section over a frontmatter table,
 * with the retired nouns one section away from both.
 *
 * A fixture rather than a mutation of the real page, so the negative case stays
 * readable as the shape it is and does not have to survive an edit to a page
 * four sessions wrote.
 */
const MAPPING_FIXTURE = [
    '---',
    "const rows = [{ names: ['Runs'], is: 'a dispatch' }];",
    '---',
    '<section data-vocabulary-mapping="true">',
    '    <table>{rows.map((row) => <code>{row.names}</code>)}</table>',
    '    <code>Repositories</code>',
    '</section>',
    '<p>The Repositories tab is gone and every run failed.</p>',
].join('\n');

describe('L1 on the documentation site: no retired noun outside the mapping table (007 T-032, AC-012)', () => {
    const SOURCES = siteSources();

    it('walks all five pages and the components they render', () => {
        {
            const pages = SOURCES.filter((source) => source.path.startsWith(`${SITE_SRC_DIR}/pages/`))
                .map((source) => source.path);

            expect(pages).toEqual(SITE_PAGES.map((page) => `${SITE_SRC_DIR}/pages/${page}`));
            expect(SOURCES.length).toBeGreaterThan(SITE_PAGES.length);
        }
    });

    it('carries no retired noun in any page, component, or data module', () => {
        expect(siteFindings(SOURCES)).toEqual([]);
    });

    it('marks one section on the whole site, and it is the debug page\'s', () => {
        expect(SOURCES.filter((source) => MAPPING_SECTION.test(source.text)).map((source) => source.path)).toEqual([
            `${SITE_SRC_DIR}/pages/debug.astro`,
        ]);
    });

    it('excludes that section and the rows it renders, and almost nothing else', () => {
        {
            const text = sitePage('debug.astro');

            // Named by the line each span opens on, so an exclusion that grew —
            // or a page that moved its table — fails here rather than quietly
            // hiding a retired word.
            expect(
                mappingTableSpans(text).map((span) => text.slice(span.start, text.indexOf('\n', span.start)))
            ).toEqual([
                '<section aria-label="Identifier mapping" data-vocabulary-mapping="true">',
                'const mappingRows: readonly MappingRow[] = [',
            ]);
        }
        {
            // And the rest of the page is still scanned: two spans out of a
            // four-hundred-line page leave the overwhelming majority of it in.
            const text = sitePage('debug.astro');
            const retained = withoutSpans(text, mappingTableSpans(text));

            expect(retained.length).toBeGreaterThan(text.length / 2);
        }
    });

    it('carries the identifier-mapping table, which an absence check cannot prove', () => {
        {
            expect(carriesMappingTable(sitePage('debug.astro'))).toBe(true);
        }
        {
            // The negative case, and the reason this is its own test rather than
            // part of the scan: take the table out and the *absence* assertion
            // above still passes, because a page with no retired noun anywhere
            // is what that assertion asks for. Only this one refuses it.
            const text = sitePage('debug.astro');
            const without = withoutSpans(text, mappingTableSpans(text));

            expect(siteFindings([{ path: 'debug.astro', text: without, mappingTable: [] }])).toEqual([]);
            expect(carriesMappingTable(without)).toBe(false);
        }
    });

    it('bites: the same words, one section away from the table, are findings', () => {
        {
            const spans = mappingTableSpans(MAPPING_FIXTURE);

            expect(spans).toHaveLength(2);
            expect(siteFindings([{ path: 'fixture.astro', text: MAPPING_FIXTURE, mappingTable: spans }])).toEqual([
                'fixture.astro:8 Repositories (the bindings noun): “Repositories”',
                'fixture.astro:8 an article + run (the domain noun in a sentence): “every run”',
            ]);
        }
    });
});

describe('FR-028: a test is named for the layer its subject is in', () => {
    it('has no test file named after a retired panel module', () => {
        const retired = readdirSync(resolve(ROOT, 'tests'), { recursive: true })
            .map(String)
            .filter((entry) => entry.endsWith('.ts'))
            .filter((entry) => /(^|[\\/])(runs|repos)[-.]/.test(entry));

        expect(retired).toEqual([]);
    });

    it('keeps the wire and domain subjects named as they are', () => {
        // The other half of FR-028: a guard that passes by renaming
        // everything would have deleted the domain's own vocabulary.
        for (const kept of ['service-runs.test.ts', 'service-run-key.test.ts', 'service-run-wire.test.ts']) {
            expect(existsSync(resolve(ROOT, 'tests', kept)), `${kept} must keep its name`).toBe(true);
        }
    });

    it('titles no test with a retired capital noun', () => {
        const titles: string[] = [];
        const entries = readdirSync(resolve(ROOT, 'tests'));
        for (const entry of entries) {
            if (!entry.endsWith('.ts')) {
                continue;
            }

            const source = readFileSync(resolve(ROOT, 'tests', entry), 'utf8');
            // `it(` / `describe(` / `test(` at a call site — not `.test(`,
            // which is how a matcher's own fixture would read as a title.
            const call = /(?:^|[\s;{(])(?:it|describe|test)\(\s*'([^']*)'/g;
            for (const match of source.matchAll(call)) {
                titles.push(match[1] ?? '');
            }
        }

        expect(titles.length).toBeGreaterThan(100);
        expect(hits(CAPITAL_NOUNS, titles.join('\n'))).toEqual([]);
    });
});
