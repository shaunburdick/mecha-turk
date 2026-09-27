import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Bundled panel entry produced by `npm run build`. */
const BUNDLE = resolve(ROOT, 'extension/panel/main.js');

/** Repository-relative path of the committed service bundle. */
const SERVICE_BUNDLE_PATH = 'extension/service/main.js';

/** Bundled service entry produced by `npm run build --workspace extension`. */
const SERVICE_BUNDLE = resolve(ROOT, SERVICE_BUNDLE_PATH);

/** Panel HTML that loads the bundle. */
const PANEL_HTML = resolve(ROOT, 'extension/panel/index.html');

/** Encoding used when reading the shipped artifacts. */
const UTF8 = 'utf8';

/** GitHub token shapes that must never appear in shipped artifacts. */
const TOKEN_PATTERNS: readonly RegExp[] = [/\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/];

/** Exports of the committed service bundle, typed without an `any`. */
interface ServiceEntryModule {
    /** Starts the service from the host environment; called only when spawned. */
    readonly runService: (env?: NodeJS.ProcessEnv) => Promise<void>;
}

describe('built panel bundle', () => {
    it('exists where the manifest expects it', () => {
        expect(existsSync(BUNDLE)).toBe(true);
    });

    it('is a classic IIFE rather than an ES module', () => {
        const bundle = readFileSync(BUNDLE, UTF8);
        expect(bundle.startsWith('(()=>{')).toBe(true);
        expect(bundle.trimEnd().endsWith('})();')).toBe(true);
        expect(bundle).not.toContain('import.meta');
        expect(bundle).not.toMatch(/(^|\n)export\s/m);
        expect(bundle).not.toMatch(/(^|\n)import\s/m);
    });

    it('carries no GitHub token material', () => {
        const bundle = readFileSync(BUNDLE, UTF8);
        for (const pattern of TOKEN_PATTERNS) {
            expect(bundle).not.toMatch(pattern);
        }
    });

    it('ships the Repositories pane and its tab (MVP blocker, 2026-09-27)', () => {
        const bundle = readFileSync(BUNDLE, UTF8);

        // The mount-time gate greps the bundle for the pane's marker; the
        // minifier renames identifiers and strips comments, so the marker
        // rides a runtime attribute instead: `data-mount="mountRepositoriesPane"`.
        expect(bundle).toContain('mountRepositoriesPane');
        // And a semantic proof that is only true when the pane's code is
        // actually bundled: the empty-list copy the pane itself renders.
        expect(bundle).toContain('No repository bound yet — add one below or refresh.');
        expect(bundle).toContain('Repository bindings');
    });
});

describe('panel html', () => {
    it('loads the bundled script', () => {
        const html = readFileSync(PANEL_HTML, UTF8);
        expect(html).toContain('<script src="main.js"></script>');
        expect(html).toContain('<div id="root">');
    });

    it('carries no inline secrets or external origins', () => {
        const html = readFileSync(PANEL_HTML, UTF8);
        expect(html).not.toMatch(/(token|secret|password)\s*=/i);
        for (const pattern of TOKEN_PATTERNS) {
            expect(html).not.toMatch(pattern);
        }
    });
});

describe('built service bundle', () => {
    it('exists where the manifest expects it', () => {
        expect(existsSync(SERVICE_BUNDLE)).toBe(true);
    });

    it('is committed to the repository', () => {
        // The host never compiles TypeScript: `service/main.js` ships built, so
        // an uncommitted bundle would install a broken service.
        const tracked = execFileSync('git', ['ls-files', '--error-unmatch', SERVICE_BUNDLE_PATH], {
            cwd: ROOT,
            encoding: UTF8,
        });

        expect(tracked.trim()).toBe(SERVICE_BUNDLE_PATH);
    });

    it('is ESM rather than a classic IIFE', () => {
        const bundle = readFileSync(SERVICE_BUNDLE, UTF8);

        expect(bundle.startsWith('(()=>{')).toBe(false);
        expect(bundle.trimEnd().endsWith('})();')).toBe(false);
        // `--node` keeps Node built-ins external and the entry's exports, both
        // of which are only expressible in module form.
        expect(bundle).toMatch(/^import\s.*from\s+['"]node:/m);
        expect(bundle).toMatch(/^export\s*\{/m);
    });

    it('imports without starting a service', async () => {
        const module: ServiceEntryModule = await import(pathToFileURL(SERVICE_BUNDLE).href);

        // Loading the module must be inert: only a process spawned as
        // `node service/main.js` starts listening (see service-entry.test.ts).
        expect(typeof module.runService).toBe('function');
    });

    it('carries no GitHub token material', () => {
        const bundle = readFileSync(SERVICE_BUNDLE, UTF8);
        for (const pattern of TOKEN_PATTERNS) {
            expect(bundle).not.toMatch(pattern);
        }
    });
});
