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

        expect(ignore).toContain('tools/visual/*.png');
        expect(ignore).toContain('/panel-*.png');
    });

    it('is documented for the agent that comes next', () => {
        const agents = readFileSync(resolve(ROOT, 'AGENTS.md'), 'utf8');

        expect(agents).toContain('npm run shot');
        expect(agents).toContain('tools/visual/');
    });
});
