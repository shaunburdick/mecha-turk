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
import { byText } from './support/sort.ts';

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

/** One fixture route's delta under a `scenes` member, as `fixtures.js` reads it. */
interface SceneRecord {
    /** What the frame shows, for the run's own report. */
    readonly summary?: string;
    /** The partial document merged **over** the base one. */
    readonly delta?: Record<string, unknown>;
}

/** The scene table `fixtures.json` carries, named by scene. */
interface SceneTable {
    /** Scene name to its fixture delta. */
    readonly scenes?: Readonly<Record<string, SceneRecord>>;
}

/** The scene 005 AC-154 needs a frame of: the Bindings tab with no accounts. */
const NO_ACCOUNTS = 'no-accounts';

/**
 * The scene in which an empty-text row renders at all.
 *
 * The base fixture carries **bindings** as well as accounts, so `no-accounts`
 * alone shows the reason line with a full list under it and leaves every one of
 * 005 FR-122's three rows invisible. Emptying the bindings list too is what puts
 * the gate and the *add an account* row on screen together.
 */
const NO_ACCOUNTS_NO_BINDINGS = 'no-accounts-no-bindings';

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
 */
function body(name: string): string {
    return JSON.stringify(fixtures()[name] ?? {});
}

/**
 * Merge one scene's delta over the fixture document, exactly as `fixtures.js`
 * does — per route, never as a replacement of the document.
 *
 * @param delta - The scene's partial fixture document.
 * @returns The base document with the delta's routes merged over it.
 */
function withScene(delta: Record<string, unknown>): Record<string, unknown> {
    return { ...fixtures(), ...delta };
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
            // Every tab keeps a second frame at the tight end of that band. The stem is a
            // variable now (a scene run suffixes it), so the narrow
            // frame is named from that stem rather than from the template itself.
            expect(tool).toMatch(/name: .*-narrow./u);
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

/* ------------------------------------------------------------------------- *
 * D26 — `--scene`: a fixture delta merged over the base document
 *
 * The shipped fixture holds two accounts **and** a binding, so none of 005
 * FR-122's three empty-text rows renders and FR-121's reason line is correctly
 * absent: under it, the copy 005 AC-154 governs is invisible. `no-accounts` is
 * the frame in which the **reason line** appears over a full list; an
 * **empty-text row** needs `no-accounts-no-bindings`, and the not-known row is
 * asserted by `005 AC-156`'s read-state fixtures rather than by a capture. These
 * four checks are what keep each scene a *frame* rather than a filename.
 * ------------------------------------------------------------------------- */

describe('a capture can run under a fixture scene', () => {
    it('advertises the flag, names its scenes, and refuses an unknown one', () => {
        const tool = readFileSync(resolve(ROOT, 'tools/visual/shot.js'), 'utf8');
        const table = fixtures() as SceneTable;
        const scenes = Object.keys(table.scenes ?? {});

        expect(scenes).toContain(NO_ACCOUNTS);
        // The usage line names every scene the fixture table defines, so a scene
        // added to the JSON is discoverable without reading this file — and one
        // that cannot be named cannot be reached. The scene names are read out
        // of `fixtures.json` rather than declared here, so the usage line and
        // the harness's own table cannot drift apart.
        expect(tool).toContain("'--scene'");
        expect(tool).toContain('SCENES = readScenes();');
        expect(tool).toContain('scenes: ');
        expect(tool).toContain('Object.keys(SCENES).join');
        for (const scene of scenes) {
            expect(table.scenes?.[scene]?.summary, scene).toBeDefined();
        }
        // Refused at the command line rather than reaching the browser, where an
        // unknown name would either boot the base document (publishing a picture
        // of the wrong frame) or fail with a message that names no scene.
        expect(tool).toMatch(/unknown scene .*name.*/u);
        expect(tool).toContain('function selectScene(');
    });

    it('writes scene frames under their own names, at both widths', () => {
        const tool = readFileSync(resolve(ROOT, 'tools/visual/shot.js'), 'utf8');

        // `panel-<tab>-<scene>.png` and its `-narrow` sibling, so a scene run never
        // overwrites the default captures it is meant to be read beside. The
        // stem is built from the tab id and the scene, and both frames are
        // named from it.
        expect(tool).toContain('const stem = ');
        expect(tool).toMatch(/name: stem,/u);
        expect(tool).toMatch(/name: .*-narrow./u);
        // …and it reuses each tab's **own** sentinel colours, so no probe colour,
        // index arithmetic, or diff rule changed — which is what keeps
        // AGENTS.md's "every image is proven current" machinery intact.
        expect(tool).toContain('PROBE_COLORS[WIDE_COLOR + TABS.indexOf(tab)]');
        expect(tool).toContain('PROBE_COLORS[NARROW_COLOR + TABS.indexOf(tab)]');
        // A scene is its own process, so `panel-full.png` — the base document's
        // whole-height frame — is never written under a scene's name.
        expect(tool).toContain('options.full && scene === null');
    });

    it('merges the delta over the base document, so untouched routes still answer', () => {
        const table = fixtures() as SceneTable;
        const delta = table.scenes?.[NO_ACCOUNTS]?.delta ?? {};

        // The delta names **one** route: a scene that replaced the whole document
        // could silently drop the answers the other five captures read.
        expect(Object.keys(delta)).toEqual(['accounts']);
        const merged = withScene(delta);

        // The base document's own member set is untouched by the merge — the
        // delta adds routes, it does not remove or rename any.
        const members = (document_: Record<string, unknown>): readonly string[] =>
            Object.keys(document_).toSorted(byText);

        expect(members(merged)).toEqual(members(fixtures()));
        // The named route changed …
        const accounts = merged.accounts as { readonly accounts: readonly unknown[] };

        expect(accounts.accounts).toEqual([]);
        // … and every other one is byte-identical to the base document.
        for (const route of ['status', 'bindings', 'events', 'audit', 'projects']) {
            expect(JSON.stringify(merged[route]), route).toBe(JSON.stringify(fixtures()[route]));
        }
    });

    it('puts an empty-text row on screen, which no-accounts alone cannot', () => {
        const table = fixtures() as SceneTable;
        const base = fixtures().bindings as { readonly bindings: readonly unknown[] };
        const accountsOnly = withScene(table.scenes?.[NO_ACCOUNTS]?.delta ?? {});
        const both = withScene(table.scenes?.[NO_ACCOUNTS_NO_BINDINGS]?.delta ?? {});

        // The reason alone: the list still holds the fixture's rows, so no
        // empty-text row renders and the scene photographs the gate only.
        expect((accountsOnly.bindings as { readonly bindings: readonly unknown[] }).bindings)
            .toHaveLength(base.bindings.length);
        // Gate **and** row together: this is the frame 005 FR-122's second row
        // exists to be read in.
        const emptied = both.bindings as { readonly bindings: readonly unknown[]; readonly status: readonly unknown[] };

        expect(emptied.bindings).toEqual([]);
        expect(emptied.status).toEqual([]);
        // …and both routes the panel's own readers would have to accept.
        expect(parseBindingsBody(JSON.stringify(both.bindings))).not.toBeNull();
        expect(parseAccountsBody(JSON.stringify(both.accounts))).toEqual([]);
    });

    it('yields empty account and binding lists the panel\'s own readers accept', () => {
        const table = fixtures() as SceneTable;
        const merged = withScene(table.scenes?.[NO_ACCOUNTS_NO_BINDINGS]?.delta ?? {});
        const read = parseAccountsBody(JSON.stringify(merged.accounts));

        // Not `null`: an empty list is a **readable** answer, and a scene whose
        // route the reader refused would render an error banner rather than the
        // frame this scene exists to photograph. Not the base document's two
        // accounts either — that is the frame the default run already covers.
        expect(read).not.toBeNull();
        expect(read).toEqual([]);
        expect(parseBindingsBody(JSON.stringify(merged.bindings))).toEqual({
            bindings: [],
            status: [],
        });
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
            const entries = events.events ?? [];
            for (const row of entries) {
                expect(Object.hasOwn(row as object, 'promptSources')).toBe(true);
            }
        }
    });
});

