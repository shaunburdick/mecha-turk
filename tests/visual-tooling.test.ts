import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** One outcome of the codec self-test, as `png-selftest.js` reports it. */
interface SelfTestCheck {
    readonly name: string;
    readonly ok: boolean;
}

/** The JSON answer `tools/visual/png-selftest.js` prints. */
interface SelfTestReport {
    readonly ok: boolean;
    readonly checks: readonly SelfTestCheck[];
}

/** The `scripts` block of the merged npm package / extension manifest. */
interface ScriptsBlock {
    readonly scripts: Readonly<Record<string, string>>;
}

/**
 * Run the visual tooling's own proof — offline, deterministic, no browser.
 *
 * @returns The report the self-test prints on stdout.
 */
function runSelfTest(): SelfTestReport {
    const stdout = execFileSync('node', ['tools/visual/png-selftest.js'], {
        cwd: ROOT,
        encoding: 'utf8',
    });

    return JSON.parse(stdout) as SelfTestReport;
}

describe('the visual capture tooling stays wired up', () => {
    it('proves its PNG codec against a file it encoded itself', () => {
        const report = runSelfTest();
        const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);

        expect(failed).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.checks.length).toBeGreaterThan(2);
    });

    it('is reachable in one command', () => {
        const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as ScriptsBlock;

        expect(manifest.scripts.shot).toBe('node tools/visual/shot.js');
    });

    it('keeps captures out of the repository', () => {
        const ignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');

        expect(ignore).toContain('screenshots/');
        expect(ignore).toContain('tools/visual/*.png');
        expect(ignore).toContain('/panel-*.png');
    });

    it('defaults captures to the repo-root screenshots folder', () => {
        const tool = readFileSync(resolve(ROOT, 'tools/visual/shot.js'), 'utf8');

        expect(tool).toContain("'screenshots'");
        expect(tool).not.toContain('/tmp/opencode');
    });

    it('sizes its frames to the width the host really gives a rail panel', () => {
        const tool = readFileSync(resolve(ROOT, 'tools/visual/shot.js'), 'utf8');

        // 0.45 × content region, clamped to [320, region − 400]: ≈500–715px
        // on a 1440–1920 desktop. See DEFAULT_WIDTH's evidence block.
        expect(tool).toContain('const DEFAULT_WIDTH = 720;');
        expect(tool).toContain('const NARROW_WIDTH = 560;');
        // Every tab keeps a second frame at the tight end of that band.
        expect(tool).toMatch(/panel-\$\{tab\.id\}-narrow/);
        expect(tool).not.toContain('VIEWPORT_WIDTH');
    });

    it('is documented for the agent that comes next', () => {
        const agents = readFileSync(resolve(ROOT, 'AGENTS.md'), 'utf8');

        expect(agents).toContain('tools/visual/');
        expect(agents).toContain('screenshots/');
        expect(agents).not.toContain('/tmp/opencode');
        // The narrow rail widths, not the desktop width the old text pinned.
        expect(agents).toContain('720px');
        expect(agents).toContain('560px');
        expect(agents).not.toContain('1400px');
    });
});
