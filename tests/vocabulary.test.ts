import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The four-layer vocabulary guard (005 T-003, FR-020–FR-024, FR-028).
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
 * 4. `AGENTS.md`'s panel module map must list every file `src/` actually holds.
 *
 * Everything here reads the local tree only: no host, no service, no network.
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
