import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RESOLVE_LABEL, RETRY_LABEL, RETURN_LABEL } from '../src/dispatches-rows.ts';
import { AUDIT_BUTTON_LABEL } from '../src/audit-view.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
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
 * 4. `AGENTS.md`'s panel module map must list every file `src/` actually holds;
 * 5. **the L1 half (T-029)**: the six tabs' rendered output and `README.md`
 *    carry neither retired noun *as a noun*, with **no exempt source at all**
 *    — the short mapping list the About tab used to render was removed with
 *    the rest of that page by the 2026-10-01 product-owner scrub (005
 *    v1.6.0), so every string the six tabs hand the SDK is scanned — and test
 *    names follow their subject's layer (FR-028).
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
        .map((entry) => String(entry))
        .filter((entry) => entry.endsWith('.ts'))
        .sort();
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
        const entries = readdirSync(resolve(ROOT, dir), { recursive: true }).map((entry) => String(entry));
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
 * @param text - The module's source.
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
 * @param modules - The modules to check.
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

/**
 * Read `AGENTS.md`'s panel module map (the section between its two headings).
 *
 * @returns The section's text, or an empty string when the heading is gone.
 */
function panelModuleMapSection(): string {
    const text = readFileSync(resolve(ROOT, 'AGENTS.md'), UTF8);
    const start = text.indexOf('## Module map (panel');
    if (start < 0) {
        return '';
    }

    const rest = text.slice(start);
    const end = rest.indexOf('\n## ', 1);

    return end < 0 ? rest : rest.slice(0, end);
}

/**
 * Read every backticked entry of the panel module map's first column.
 *
 * @returns One glob-ish pattern per entry (`handoff*.ts` stays a wildcard).
 */
function panelModuleMapEntries(): readonly string[] {
    const entries: string[] = [];
    for (const line of panelModuleMapSection().split('\n')) {
        if (!line.startsWith('|')) {
            continue;
        }

        const firstCell = line.split('|')[1] ?? '';
        for (const match of firstCell.matchAll(/`([^`]+)`/g)) {
            const entry = match[1];
            if (entry !== undefined) {
                entries.push(entry);
            }
        }
    }

    return entries;
}

/**
 * Match a module-map entry against a file name (`*` is the only wildcard).
 *
 * @param entry - The map entry, e.g. `handoff*.ts`.
 * @param name - The bare file name being looked for.
 * @returns `true` when the entry covers the file.
 */
function mapEntryCovers(entry: string, name: string): boolean {
    const parts = entry.split('*');
    if (parts.length === 1) {
        return entry === name;
    }

    const first = parts[0] ?? '';
    if (!name.startsWith(first)) {
        return false;
    }

    const last = parts[parts.length - 1] ?? '';
    let cursor = first.length;
    for (let index = 1; index < parts.length - 1; index += 1) {
        const part = parts[index] ?? '';
        const at = name.indexOf(part, cursor);
        if (at < 0) {
            return false;
        }

        cursor = at + part.length;
    }

    return name.endsWith(last) && name.length - last.length >= cursor;
}

describe('L2 module vocabulary: the renamed files are the only ones that exist (005 T-003)', () => {
    it('reads a real panel source tree rather than an empty directory', () => {
        expect(panelModules().length).toBeGreaterThan(40);
    });

    it('has no src/repos*.ts and no src/runs*.ts module left behind (FR-024)', () => {
        const retired = panelModules().filter((name) => RETIRED_MODULE_PATTERNS.some((pattern) => pattern.test(name)));

        expect(retired).toEqual([]);
    });

    it('has every module the rename produced, so a reverted git mv fails here', () => {
        const names = new Set(panelModules());

        for (const expected of RENAMED_MODULES) {
            expect(names.has(expected), `${SRC_DIR}/${expected} must exist after the L2 rename`).toBe(true);
        }
    });

    it('fails on a retired name rather than passing vacuously', () => {
        const candidates = ['bindings.ts', 'repos.ts', 'runs-ui.ts'];
        const reverted = candidates.filter((name) => RETIRED_MODULE_PATTERNS.some((pattern) => pattern.test(name)));

        expect(reverted).toEqual(['repos.ts', 'runs-ui.ts']);
    });
});

describe('every src/** import resolves to a file that exists (005 T-003)', () => {
    /** Repository-relative path the synthetic fixtures pretend to live at. */
    const SYNTHETIC_PATH = 'src/example.ts';

    it('scans the panel modules rather than nothing', () => {
        expect(scanModules([SRC_DIR]).length).toBeGreaterThan(40);
    });

    it('resolves every relative specifier in the tree', () => {
        expect(unresolvedImports(scanModules([SRC_DIR]))).toEqual([]);
    });

    it('reports a specifier that names a file that is not there', () => {
        const text = "import { thing } from './gone.ts';";
        const synthetic: readonly ScannedModule[] = [{ path: SYNTHETIC_PATH, text }];

        expect(unresolvedImports(synthetic)).toEqual([{ from: SYNTHETIC_PATH, specifier: './gone.ts' }]);
    });

    it('ignores package specifiers, which are the host SDK and Node', () => {
        const text = "import { readFileSync } from 'node:fs';\nexport { thing } from './real.ts';";

        expect(relativeSpecifiers(text)).toEqual(['./real.ts']);
    });
});

describe('the L4 domain vocabulary FR-022 retains is still present (005 T-003)', () => {
    it('finds every retained term somewhere in the scanned source', () => {
        const corpus = scanModules(L4_SCAN_DIRS)
            .map((module) => module.text)
            .join('\n');

        expect(corpus.length).toBeGreaterThan(1000);

        for (const { token, note } of RETAINED_L4) {
            expect(corpus.includes(token), `${token} (${note}) must survive the L2 rename`).toBe(true);
        }
    });

    it('reads a corpus wide enough to matter', () => {
        const modules = scanModules(L4_SCAN_DIRS);

        expect(modules.some((module) => module.path.startsWith('src/'))).toBe(true);
        expect(modules.some((module) => module.path.startsWith('service/'))).toBe(true);
        expect(modules.some((module) => module.path.startsWith('tests/'))).toBe(true);
    });
});

describe("AGENTS.md's panel module map lists every file src/ contains (005 T-003)", () => {
    it('reads the map section rather than an empty one', () => {
        expect(panelModuleMapEntries().length).toBeGreaterThan(20);
    });

    it('leaves no src module off the map', () => {
        const entries = panelModuleMapEntries();
        const missing = panelModules().filter((name) => !entries.some((entry) => mapEntryCovers(entry, name)));

        expect(missing).toEqual([]);
    });

    it('treats a wildcard as a wildcard and an exact name as exact', () => {
        expect(mapEntryCovers('handoff*.ts', 'handoff-status.ts')).toBe(true);
        expect(mapEntryCovers('handoff*.ts', 'session.ts')).toBe(false);
        expect(mapEntryCovers('json.ts', 'json.ts')).toBe(true);
        expect(mapEntryCovers('json.ts', 'jsonx.ts')).toBe(false);
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
    const stubbed: Record<string, unknown> = { ...actual };
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

/** The picker callbacks the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
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
 */
const DOMAIN_PROSE_RULE: NounRule = {
    name: 'an article + run (the domain noun in a sentence)',
    pattern: /\b(?:the|this|each|every|its|same|selected|one|that|own)\s+run\b/gi,
};

/**
 * Collect every string inside one SDK mount's props, however deeply nested.
 *
 * Tab labels, list titles, and subtitles all live one level down, so a
 * shallow read would skip exactly the rows FR-020 names first.
 *
 * @param value - Anything a mount was handed.
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
 * @param props - Whatever the primitive received.
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
 * @param rules - Which rules to apply.
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

/**
 * Remove a document's vocabulary section, the one place the retired words
 * are supposed to appear (FR-029).
 *
 * @param text - The document to strip.
 * @returns The document without any `## …Vocabulary…` section.
 */
function withoutMappingSection(text: string): string {
    const lines = text.split('\n');
    const kept: string[] = [];
    let skipping = false;

    for (const line of lines) {
        if (line.startsWith('## ')) {
            skipping = /vocabulary/i.test(line);
        }

        if (!skipping) {
            kept.push(line);
        }
    }

    return kept.join('\n');
}

describe('L1: no retired noun reaches an operator (005 T-029, AC-140, SC-107)', () => {
    it('mounts all six tabs, so the scan is not vacuous', async () => {
        const strings = await renderedSixTabs();

        expect(strings.length).toBeGreaterThan(40);
        for (const label of ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About']) {
            expect(strings).toContain(label);
        }
    });

    it('renders no retired noun in any of the six tabs', async () => {
        const rendered = await renderedSixTabs();

        // **No exemption.** The About tab's short mapping list was the one
        // source the scan skipped — it is supposed to carry the retired words
        // as history — and the 2026-10-01 scrub removed it (005 v1.6.0), so
        // every string the six tabs hand the SDK is scanned now.
        expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], rendered.join('\n'))).toEqual([]);
    });

    it('renders no retired noun in the row-level labels the tabs export', () => {
        const labels = [RETRY_LABEL, RESOLVE_LABEL, RETURN_LABEL, AUDIT_BUTTON_LABEL].join('\n');

        expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], labels)).toEqual([]);
    });

    it('bites on every retired shape, so the scan cannot pass vacuously', () => {
        const sample = 'the Runs list — the Repositories tab — Run shows a reason';

        expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], sample)).toHaveLength(3);
        expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'the run key')).toHaveLength(1);
        // The two shapes that must keep working: the imperative verb and the
        // retained identifiers.
        expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'Run OpenChamber on web')).toEqual([]);
        expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], 'runs.json runKey mt-run-1')).toEqual([]);
    });

    it('README.md names neither retired noun outside its mapping (AC-140)', () => {
        const text = withoutMappingSection(readFileSync(resolve(ROOT, 'README.md'), 'utf8'));

        expect(hits([...CAPITAL_NOUNS, DOMAIN_PROSE_RULE], text)).toEqual([]);
        // Not vacuous: the imperative use of the word still reads as English.
        expect(text).toContain('Run OpenChamber on web or desktop.');
    });
});

describe('FR-028: a test is named for the layer its subject is in', () => {
    it('has no test file named after a retired panel module', () => {
        const retired = readdirSync(resolve(ROOT, 'tests'), { recursive: true })
            .map((entry) => String(entry))
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
        for (const entry of readdirSync(resolve(ROOT, 'tests'))) {
            if (!String(entry).endsWith('.ts')) {
                continue;
            }

            const source = readFileSync(resolve(ROOT, 'tests', String(entry)), 'utf8');
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
