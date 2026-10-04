import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatusView } from '../src/status-document.ts';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { parseDispatchesBody } from '../src/dispatches-service.ts';
import { parseAccountsBody } from '../src/accounts-service.ts';
import { parseConfigEnvelope } from '../src/settings-schema.ts';
import { parseAuditBody } from '../src/audit-view.ts';

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

/**
 * Read the harness's fixture document, one member per service route.
 *
 * @returns The parsed JSON, untyped: each reader below refuses its own member,
 *   so the whole document is passed through as `unknown`.
 */
function fixtures(): Record<string, unknown> {
    return JSON.parse(readFileSync(resolve(ROOT, 'tools/visual/fixtures.json'), 'utf8')) as Record<string, unknown>;
}

/**
 * Read one fixture member back as the body text a reader parses.
 *
 * @param name - The fixture member, which is also the route's answer body.
 * @returns The body text.
 */
function body(name: string): string {
    return JSON.stringify(fixtures()[name] ?? {});
}

describe('the visual capture tooling stays wired up', () => {
    it('proves its PNG codec against a file it encoded itself', () => {
        {
            const report = runSelfTest();
            const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);

            expect(failed).toEqual([]);
            expect(report.ok).toBe(true);
            expect(report.checks.length).toBeGreaterThan(2);
        }
        {
            const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as ScriptsBlock;

            expect(manifest.scripts.shot).toBe('node tools/visual/shot.js');
        }
        {
            const ignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');

            expect(ignore).toContain('screenshots/');
            expect(ignore).toContain('tools/visual/*.png');
            expect(ignore).toContain('/panel-*.png');
        }
        {
            const tool = readFileSync(resolve(ROOT, 'tools/visual/shot.js'), 'utf8');

            expect(tool).toContain("'screenshots'");
            expect(tool).not.toContain('/tmp/opencode');
        }
        {
            const tool = readFileSync(resolve(ROOT, 'tools/visual/shot.js'), 'utf8');

            // 0.45 × content region, clamped to [320, region − 400]: ≈500–715px
            // on a 1440–1920 desktop. See DEFAULT_WIDTH's evidence block.
            expect(tool).toContain('const DEFAULT_WIDTH = 720;');
            expect(tool).toContain('const NARROW_WIDTH = 560;');
            // Every tab keeps a second frame at the tight end of that band.
            expect(tool).toMatch(/panel-\$\{tab\.id\}-narrow/);
            expect(tool).not.toContain('VIEWPORT_WIDTH');
        }
        {
            const agents = readFileSync(resolve(ROOT, 'AGENTS.md'), 'utf8');

            expect(agents).toContain('tools/visual/');
            expect(agents).toContain('screenshots/');
            expect(agents).not.toContain('/tmp/opencode');
            // The narrow rail widths, not the desktop width the old text pinned.
            expect(agents).toContain('720px');
            expect(agents).toContain('560px');
            expect(agents).not.toContain('1400px');
        }
    });
});

/* -------------------------------------------------------------------- *
 * The fixture answers the panel's own fail-closed readers accept
 * -------------------------------------------------------------------- */

describe('every fixture answer is one the panel can read', () => {
    it('passes all six routes through the readers that render them', () => {
        {
            // The reader, the member, and what it produces — all six, so a new
            // route the harness serves without a fixture cannot go unchecked by
            // omission here.
            const readers = [
                ['status', () => parseStatusView(body('status'))],
                ['config', () => parseConfigEnvelope(body('config'))],
                ['bindings', () => parseBindingsBody(body('bindings'))],
                ['accounts', () => parseAccountsBody(body('accounts'))],
                ['events', () => parseDispatchesBody(body('events'))],
                ['audit', () => parseAuditBody(body('audit'))],
            ] as const;

            // Not vacuous: the readers really ran, and really held rows. A
            // reader that answered `[]` to an absent fixture would satisfy a
            // truthiness check, so emptiness is refused alongside `null`.
            const refused: string[] = [];
            const rows: string[] = [];
            for (const [name, read] of readers) {
                const answer = read();
                if (answer === null) {
                    refused.push(name);
                    continue;
                }
                if (Array.isArray(answer) && answer.length === 0) {
                    refused.push(`${name} (no rows)`);
                    continue;
                }
                rows.push(name);
            }

            expect(refused).toEqual([]);
            expect(rows).toHaveLength(readers.length);

            // And the *dispatch list* is the surface this guard was written for:
            // its rows omit `promptSources`, which `prompt-wire.ts` refuses on
            // read, so a stale fixture renders the honest refusal banner rather
            // than a list. Named here so the next editor of that file knows the
            // member is load-bearing.
            const events = fixtures().events as { readonly events?: readonly unknown[] };
            expect(Array.isArray(events.events)).toBe(true);
            for (const row of events.events ?? []) {
                expect(Object.hasOwn(row as object, 'promptSources')).toBe(true);
            }
        }
    });
});

