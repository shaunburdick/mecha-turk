import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Bundled panel entry produced by `npm run build`. */
const BUNDLE = resolve(ROOT, 'extension/panel/main.js');

/** Panel HTML that loads the bundle. */
const PANEL_HTML = resolve(ROOT, 'extension/panel/index.html');

/** Encoding used when reading the shipped artifacts. */
const UTF8 = 'utf8';

/** GitHub token shapes that must never appear in shipped artifacts. */
const TOKEN_PATTERNS: readonly RegExp[] = [/\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/];

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
