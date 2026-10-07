import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostMeetsOpenChamberEngine, requestedGuestCapabilities } from '@openchamber/sdk';
import { parseManifestJson } from '@openchamber/sdk/schemas';
import { compare, minVersion, satisfies, validRange } from 'semver';
import { byText } from './support/sort.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** Repository-relative path of the merged manifest (npm package + OpenChamber extension). */
const EXTENSION_MANIFEST_PATH = 'package.json';

/** The single repository manifest: npm toolchain pin and OpenChamber manifest in one document. */
const EXTENSION_MANIFEST = JSON.parse(readFileSync(resolve(ROOT, EXTENSION_MANIFEST_PATH), 'utf8')) as PackageJson;

/** Shape of the fields these tests read from a package.json document. */
interface PackageJson {
    readonly name?: string;
    readonly version?: string;
    readonly private?: boolean;
    readonly license?: string;
    readonly engines?: { readonly node?: string };
    readonly scripts?: Record<string, string>;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly openchamber?: OpenChamberBlock;
}

/** The `openchamber` block of an extension manifest. */
interface OpenChamberBlock {
    readonly apiVersion: number;
    readonly engines?: { readonly openchamber?: string };
    readonly contributes?: {
        readonly panel?: { readonly id?: string; readonly entry?: string; readonly name?: string };
        readonly capabilities?: readonly string[];
        readonly service?: unknown;
        readonly filesystem?: unknown;
        readonly background?: unknown;
        readonly integration?: IntegrationBlock;
    };
}

/** The declared integration block. */
interface IntegrationBlock {
    readonly name?: string;
    readonly description?: string;
    readonly settings?: readonly { readonly id?: string; readonly label?: string }[];
    readonly token?: {
        readonly apiOrigin?: string;
        readonly scheme?: string;
        readonly account?: { readonly path?: string; readonly name?: string };
    };
}

/** Package whose pin these tests compare across manifests. */
const SDK_PACKAGE = '@openchamber/sdk';

/** Engine floor the contract requires for this spike. */
const ENGINE_FLOOR = '>=1.24.0';

/** Capabilities the spike is allowed to request, in manifest order. */
const ALLOWED_CAPABILITIES = ['sessions', 'prompt'];

/** OpenChamber build that meets the declared engine floor. */
const SUPPORTED_BUILD = '1.24.0';

/** OpenChamber build below the declared engine floor. */
const UNSUPPORTED_BUILD = '1.23.0';

/** Service entry the manifest declares; also the file that must ship beside it. */
const SERVICE_ENTRY = 'service/main.js';

/**
 * Read the `openchamber` block, failing the test when it is absent.
 *
 * @param manifest - Parsed package.json document.
 * @returns The manifest block.
 */
function openchamberBlock(manifest: PackageJson): OpenChamberBlock {
    if (manifest.openchamber === undefined) {
        throw new Error('package.json has no openchamber block');
    }

    return manifest.openchamber;
}

describe('manifest identity', () => {
    it('declares the documented API version', () => {
        {
            expect(openchamberBlock(EXTENSION_MANIFEST).apiVersion).toBe(1);
        }
        {
            expect(openchamberBlock(EXTENSION_MANIFEST).engines?.openchamber).toBe(ENGINE_FLOOR);
        }
        {
            expect(hostMeetsOpenChamberEngine(SUPPORTED_BUILD, ENGINE_FLOOR)).toBe(true);
            expect(hostMeetsOpenChamberEngine(UNSUPPORTED_BUILD, ENGINE_FLOOR)).toBe(false);
        }
        {
            const text = readFileSync(resolve(ROOT, EXTENSION_MANIFEST_PATH), 'utf8');
            const parsed = parseManifestJson(text);

            expect(parsed.ok).toBe(true);
            if (parsed.ok) {
                expect(parsed.manifest.apiVersion).toBe(1);
            }
        }
        {
            expect(EXTENSION_MANIFEST.version).toMatch(/^\d+\.\d+\.\d+/);
        }
        {
            const panelId = openchamberBlock(EXTENSION_MANIFEST).contributes?.panel?.id ?? '';
            expect(panelId).toMatch(/^[a-z][a-z0-9-]*$/);

            // The storage namespace is the *same* identity: every panel storage
            // key is prefixed with it, so renaming either one is a user-visible
            // storage reset. Asserted here, where the identity is declared.
            const prefixed = readdirSync(resolve(ROOT, 'src'), { recursive: true })
                .map(String)
                .filter((entry) => entry.endsWith('.ts'))
                .filter((entry) => readFileSync(resolve(ROOT, 'src', entry), 'utf8').includes(`${panelId}:`));

            expect(prefixed.length).toBeGreaterThan(0);
        }
    });
});

describe('SDK pinning', () => {
    it('pins the SDK exactly in the extension package', () => {
        {
            const pin = EXTENSION_MANIFEST.dependencies?.[SDK_PACKAGE];
            expect(pin).toBeDefined();
            expect(pin).not.toMatch(/^[~^]/);
        }
        {
            const pin = EXTENSION_MANIFEST.dependencies?.[SDK_PACKAGE];
            expect(pin).toBeDefined();
            expect(EXTENSION_MANIFEST.devDependencies?.[SDK_PACKAGE]).toBeUndefined();
        }
        {
            const pin = EXTENSION_MANIFEST.dependencies?.[SDK_PACKAGE] ?? '';
            expect(pin).not.toContain('preview');
        }
    });
});

describe('declared capabilities', () => {
    it('requests exactly the capabilities the spike uses', () => {
        {
            expect(openchamberBlock(EXTENSION_MANIFEST).contributes?.capabilities).toEqual(ALLOWED_CAPABILITIES);
        }
        {
            const { contributes } = openchamberBlock(EXTENSION_MANIFEST);
            expect(contributes?.filesystem).toBeUndefined();
            expect(contributes?.background).toBeUndefined();
        }
        {
            const capabilities = openchamberBlock(EXTENSION_MANIFEST).contributes?.capabilities ?? [];
            const documented = ['sessions', 'prompt', 'files', 'model'];
            for (const capability of capabilities) {
                expect(documented).toContain(capability);
            }
        }
    });
});

describe('service contribution', () => {
    const manifestText = readFileSync(resolve(ROOT, EXTENSION_MANIFEST_PATH), 'utf8');

    it('declares a host runtime entry and no permissions key', () => {
        {
            const manifest = JSON.parse(manifestText) as PackageJson;
            const service = manifest.openchamber?.contributes?.service;

            expect(service).toEqual({ entry: SERVICE_ENTRY, runtime: 'host' });
            expect(service).not.toHaveProperty('permissions');
        }
        {
            const parsed = parseManifestJson(manifestText);

            expect(parsed.ok).toBe(true);
            if (!parsed.ok) {
                return;
            }

            const entry = parsed.manifest.contributes.service?.entry;
            expect(entry).toBe(SERVICE_ENTRY);
            expect(existsSync(resolve(ROOT, entry ?? ''))).toBe(true);
            expect(existsSync(resolve(ROOT, 'service/main.ts'))).toBe(true);
        }
        {
            const parsed = parseManifestJson(manifestText);

            expect(parsed.ok).toBe(true);
            if (parsed.ok) {
                expect(parsed.manifest.contributes.service?.runtime).toBe('host');
            }
        }
        {
            const parsed = parseManifestJson(manifestText);

            expect(parsed.ok).toBe(true);
            if (parsed.ok) {
                const requested = requestedGuestCapabilities(parsed.manifest.contributes);

                // No integration card means no implied `network`: the panel has
                // no GitHub traffic of its own (the card and its `/user`
                // diagnostic went with the install-time credential), so the only
                // implied capability left is the one `contributes.service`
                // carries (AGENTS invariant 3).
                expect([...requested].toSorted(byText)).toEqual(['prompt', 'service', 'sessions']);
            }
        }
        {
            const declared = openchamberBlock(EXTENSION_MANIFEST).contributes?.capabilities ?? [];

            expect(declared).not.toContain('service');
            expect(declared).not.toContain('network');
        }
    });
});

describe('GitHub integration card (retired 2026-09-30)', () => {
    const integration = openchamberBlock(EXTENSION_MANIFEST).contributes?.integration;

    it('declares no integration card at all', () => {
        {
            // 002 FR-011's card was the install-time credential: its `token`
            // block asked the host to hold a GitHub token for the panel, and its
            // only two products (a connected-login badge and a `/user`
            // diagnostic) are gone with it. A card left behind with an empty
            // shell in it would be a second path to a capability the service
            // accounts own.
            expect(integration).toBeUndefined();
        }
        {
            const serialized = JSON.stringify(openchamberBlock(EXTENSION_MANIFEST));

            expect(serialized).not.toContain('api.github.com');
            expect(serialized).not.toContain('/user');
            expect(serialized).not.toContain('bearer');
        }
    });
});

describe('panel entry', () => {
    it('points at a shipped HTML file', () => {
        {
            const entry = openchamberBlock(EXTENSION_MANIFEST).contributes?.panel?.entry;
            expect(entry).toBe('panel/index.html');
            expect(existsSync(resolve(ROOT, entry ?? ''))).toBe(true);
        }
        {
            const panelId = openchamberBlock(EXTENSION_MANIFEST).contributes?.panel?.id;
            const sessionSource = readFileSync(resolve(ROOT, 'src/session.ts'), 'utf8');
            expect(panelId).toBe('mecha-turk');
            expect(sessionSource).toContain("providerId: 'mecha-turk'");
        }
    });
});

/** Setting ids the manifest once declared; none may reappear (002 FR-041). */
const CARD_SETTING_IDS = [
    'expected-login',
    'project-id',
    'worktree-option',
    'poll-interval-ms',
    'expected-agent',
] as const;

/** Identifiers 002 FR-041(a) retires from the panel source. */
const RETIRED_IDENTIFIERS = [
    'SpikeSettings',
    'readSetting',
    'parseSpikeConfig',
    'resolveProjectId',
    'parseExpectedAgent',
];

/**
 * Every panel source file, as text.
 *
 * `src/**` holds the panel's logic and `panel/*.ts` its entry, which is what
 * 002 AC-021 means by "the panel source".
 *
 * @returns The path → source text of every panel TypeScript file.
 */
function panelSources(): ReadonlyMap<string, string> {
    const found = new Map<string, string>();
    for (const dir of ['src', 'panel']) {
        const root = resolve(ROOT, dir);
        const names = readdirSync(root, { recursive: true });
        for (const name of names) {
            if (typeof name !== 'string' || !name.endsWith('.ts')) {
                continue;
            }

            const path = resolve(root, name);
            found.set(path, readFileSync(path, 'utf8'));
        }
    }

    return found;
}

describe('002 FR-041 / FR-011 re-cut — the integration card is gone entirely', () => {
    const { contributes } = openchamberBlock(EXTENSION_MANIFEST);

    it('declares no integration card, so none of the six former ids has a home', () => {
        {
            expect(contributes?.integration).toBeUndefined();

            const serialized = JSON.stringify(contributes ?? {});
            for (const id of CARD_SETTING_IDS) {
                expect(serialized).not.toContain(id);
            }
            expect(serialized).not.toContain('repository');
        }
        {
            expect(contributes?.capabilities).toEqual(['sessions', 'prompt']);
            expect(contributes?.service).toEqual({
                entry: SERVICE_ENTRY,
                runtime: 'host',
            });
            expect(contributes?.panel?.id).toBe('mecha-turk');
        }
    });
});

describe('002 AC-021 — no reader takes a card id from ctx.settings', () => {
    it('keeps every retired settings identifier out of the panel source', () => {
        {
            for (const [path, source] of panelSources()) {
                for (const identifier of RETIRED_IDENTIFIERS) {
                    expect(source, `${path} still names ${identifier}`).not.toContain(identifier);
                }
            }
        }
        {
            // `repository` is excluded deliberately: it is also an ordinary DTO
            // field name on the wire, so its card reading is covered by the
            // "nothing indexes a settings record" assertion below instead.
            for (const [path, source] of panelSources()) {
                for (const id of CARD_SETTING_IDS) {
                    const single = `'${id}'`;
                    const double = `"${id}"`;
                    const isQuoted = source.includes(single) || source.includes(double);
                    expect(isQuoted, `${path} reads the card id ${id}`).toBe(false);
                }
            }
        }
        {
            const indexed = /\bsettings\s*\[/;
            for (const [path, source] of panelSources()) {
                expect(indexed.test(source), `${path} indexes a settings record`).toBe(false);
            }
        }
    });
});

/* -------------------------------------------------------------------- *
 * 007 — the site is a subproject the root manifest and the root tools
 *      must not learn about (FR-006 – FR-008, FR-070 – FR-072, AC-017 – AC-021)
 * -------------------------------------------------------------------- */

/** Repository-relative path of the documentation site's own manifest. */
const SITE_MANIFEST_PATH = 'site/package.json';

/** The site's manifest — a second package.json document, and the only other one. */
const SITE_MANIFEST = JSON.parse(readFileSync(resolve(ROOT, SITE_MANIFEST_PATH), 'utf8')) as PackageJson;

/** Repository-relative path of the documentation site's directory. */
const SITE_DIR = 'site';

/** Directories under `site/` that hold installed or generated files rather than source. */
const SITE_GENERATED = new Set(['.astro', 'dist', 'node_modules']);

/** ESLint as the root install put it, so the child process resolves nothing of its own. */
const ESLINT_BIN = resolve(ROOT, 'node_modules/.bin/eslint');

/** The TypeScript compiler as the root install put it. */
const TSC_BIN = resolve(ROOT, 'node_modules/.bin/tsc');

/**
 * `package.json`'s sha256 — re-derived, not carried, on each deliberate change
 * (#17's Node floor, the `0.1.0` version bump, then the `0.1.1` and `0.1.2`
 * patch bumps — the last one carrying issue #39's rail-icon fix).
 *
 * AC-017 asks for the root manifest to be **byte-identical**, so this is a digest
 * rather than a list of the fields that must not move. That is also what keeps
 * issue #17 out of this suite: raising the root Node floor is a legitimate change
 * this test neither names nor forbids, and one that needs the digest updated
 * deliberately and a commit saying which clause of AC-017 it satisfies. That is
 * what happened — #17 moved `engines.node` to `>=24.15.0` on `main`, so the digest
 * now pins the document **as #17 left it** rather than as 007 found it. AC-017's
 * operative clause still holds: 007 added nothing to the root manifest, and the
 * `declares no workspaces and no script that reaches the site` case below is the
 * assertion that survives a floor change. The same reading covers every
 * version bump since: invariant 2's `0.1.0`, `0.1.1` and `0.1.2` each move
 * `version` (and 0.1.2 the panel icon) and nothing else.
 */
const ROOT_MANIFEST_SHA256 = '7b22ae77b85726249e5eddc2f634a316ed2aa46b9ac3f517349222ecf8b98c62';

/**
 * `.github/workflows/verify.yml`'s sha256, for the same reason and the same
 * reason not to: NFR-007 and AC-023's last clause ask for the repository's own
 * gate to be untouched, so it is compared whole rather than field by field.
 *
 * Re-derived for the same reason and at the same time as the digest above: #17
 * extended this workflow with the root Node-floor sweep, so it now pins `main`'s
 * version of the gate. The read-only-permission and fifteen-minute-budget case
 * below is the assertion that survives an additive change to the workflow.
 */
const VERIFY_WORKFLOW_SHA256 = 'd2d6fb1a63e6711e98346f596104ae6d7bf21f1558d3235dbb6095fd12d19670';

/** Repository-relative path of the repository's own gate workflow. */
const VERIFY_WORKFLOW_PATH = '.github/workflows/verify.yml';

/** Repository-relative path of the publish workflow Wave 7 writes. */
const PUBLISH_WORKFLOW_PATH = '.github/workflows/site.yml';

/** Repository-relative path of the workflow a pushed tag starts. */
const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml';

/**
 * The Node floor `astro@7.3.5` declares for itself, as `npm view astro@latest engines`
 * reported it on 2026-10-05 — `{ npm: '>=9.6.5', node: '>=22.12.0' }`.
 *
 * Recorded rather than read from `site/node_modules`, because the root gate cannot
 * assume the subproject has been installed (FR-070 keeps the site out of the root's
 * toolchain scope), and asserted so a future Astro bump that raises its own floor
 * fails here instead of passing unnoticed under a site floor that happens to be higher.
 */
const ASTRO_NODE_FLOOR = '>=22.12.0';

/** What one run of a repository tool reported. */
interface ToolRun {
    readonly status: number | null;
    readonly output: string;
}

/**
 * The ceiling one tool run gets before its process is killed, in milliseconds.
 *
 * The heaviest run here boots ESLint's whole type-aware config over the root
 * tsconfig, which costs 4.4s on an idle machine and past 5s once a full suite has
 * every core — so this is far above any honest run and exists to name a hang, not
 * to police a slow one. Vitest's watchdog kills a blocked test with a line saying
 * only that it timed out, which is no diagnosis at all: without a bound of its own
 * the child, and the command it was running, are never named.
 */
const TOOL_TIMEOUT_MS = 20_000;

/**
 * Hash one repository file.
 *
 * @param path - Repository-relative path.
 * @returns The file's sha256, lowercase hex.
 */
function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex');
}

/**
 * Every `uses:` reference in a workflow file, as `owner/name@reference`.
 *
 * Read out of the file's text rather than parsed as YAML, because the rule is
 * about what is written down: a parser accepts `uses: some/action@v4` just as
 * happily as a pinned one, so it would report the same shape either way and
 * leave the difference this exists to catch — the reference — to the caller.
 *
 * @param workflow - The workflow file's contents.
 * @returns Each reference, in file order.
 */
function actionReferences(workflow: string): string[] {
    return workflow
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('uses:') || line.startsWith('- uses:'))
        .map((line) => line.slice(line.indexOf('uses:') + 'uses:'.length).trim().split(' ', 1)[0] ?? '');
}

/**
 * Assert a workflow pins every one of its actions to a commit SHA — and pins
 * at least one, because a file with no actions would satisfy a pinning rule by
 * having nothing to pin.
 *
 * @param workflow - The workflow file's contents.
 * @param path - Repository-relative path, carried into each failure message.
 */
function expectActionsShaPinned(workflow: string, path: string): void {
    const used = actionReferences(workflow);

    expect(used.length, `${path} references no action at all, so nothing in it is pinned`).toBeGreaterThan(0);
    // Taken apart rather than matched whole, because a single pattern over
    // `owner/name@sha` is a shape the unsafe-regex rule rightly objects to, and
    // naming the halves says more about which of them is wrong anyway.
    for (const action of used) {
        const [slug = '', reference = ''] = action.split('@', 2);
        const [owner = '', repository = ''] = slug.split('/', 2);

        expect(owner, `${action} names no action owner`).toMatch(/^[\w.-]+$/);
        expect(repository, `${action} names no action repository`).toMatch(/^[\w.-]+$/);
        expect(reference, `${action} is referenced by tag rather than by commit SHA`).toMatch(/^[0-9a-f]{40}$/);
    }
}

/**
 * Run one of the repository's own tools and collect everything it said.
 *
 * `execFileSync` is no use here: a crash of ESLint's is the behaviour two of these
 * assertions are about, and throwing it away would throw the finding away with it.
 *
 * A run that was killed is reported through `output` rather than swallowed. Callers
 * assert on `output`, so the marker is what such an assertion prints — carrying the
 * command, the budget and how it died, so the failure reads as a hung subprocess and
 * not as a tool that had nothing to say.
 *
 * @param binary - An absolute path, or a name the PATH resolves.
 * @param args - The arguments to pass.
 * @returns The exit status and the combined standard output and error.
 */
function runTool(binary: string, args: readonly string[]): ToolRun {
    const finished = spawnSync(binary, [...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: TOOL_TIMEOUT_MS,
    });
    // `error` covers both a budget overrun and a process that never started, such as
    // a missing binary. A killed run leaves a null status and whatever was said before
    // the signal, which on its own is indistinguishable from a clean silent one.
    const killed = finished.error === undefined
        ? ''
        : `\n${binary} ${args.join(' ')} died after ${String(TOOL_TIMEOUT_MS)}ms: ${finished.error.message}`;

    return { status: finished.status, output: `${finished.stdout}${finished.stderr}${killed}` };
}

/**
 * Read one line of `git`'s output.
 *
 * @param args - The git arguments.
 * @returns Standard output, trimmed.
 */
function git(args: readonly string[]): string {
    return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8' }).trim();
}

/**
 * Whether the site's own dependencies are installed under `site/`.
 *
 * The check is the package `site/astro.config.ts` itself imports, not a literal
 * `astro`, and not the mere presence of `site/node_modules`: what decides whether
 * ESLint's import resolver can load the config is whether *that* package sits
 * beside it, so a partial or stale install takes the same branch the real one
 * does. Reading the name out of the file under test keeps the two from parting
 * company.
 *
 * Deliberately not a requirement. FR-070 keeps the site out of the root
 * toolchain's scope, so the root CI job installs the repository and never the
 * subproject — this suite cannot assume the directory is there, and two of its
 * cases read the same installation for exactly that reason.
 *
 * @returns `true` when the config's own import is installed beside it.
 */
function siteInstallPresent(): boolean {
    const config = readFileSync(resolve(ROOT, SITE_DIR, 'astro.config.ts'), 'utf8');
    const specifier = /from '([^']+)'/.exec(config)?.[1];
    // A scoped name is two segments and an unscoped one is a single, which is the
    // only difference between the two spellings of the same address.
    const segments = specifier?.split('/') ?? [];
    const packageName = specifier?.startsWith('@') === true ? segments.slice(0, 2).join('/') : segments[0];

    if (packageName === undefined) {
        return false;
    }

    return existsSync(resolve(ROOT, SITE_DIR, 'node_modules', packageName, 'package.json'));
}

/**
 * Every file under `site/` that is not installed or generated.
 *
 * The three generated directories are skipped at every level rather than filtered
 * out at the end: `site/node_modules/` holds a package with a dangling symlink in
 * it, so a walk that descended first would fail on the way to being able to
 * discard what it found.
 *
 * @param sub - A `/`-separated path below `site/`, `''` for the directory itself.
 * @returns Repository-relative paths, sorted.
 */
function siteFiles(sub: string): readonly string[] {
    const found: string[] = [];
    const entries = readdirSync(resolve(ROOT, SITE_DIR, sub), { withFileTypes: true });

    for (const entry of entries) {
        if (SITE_GENERATED.has(entry.name)) {
            continue;
        }

        const path = sub === '' ? entry.name : `${sub}/${entry.name}`;
        if (entry.isDirectory()) {
            found.push(...siteFiles(path));
        } else if (entry.isFile()) {
            found.push(`${SITE_DIR}/${path}`);
        }
    }

    return found.toSorted(byText);
}

/**
 * A `>=x.y.z` Node floor as one comparable number.
 *
 * The root's floor is read from the manifest and **never written into this suite** —
 * issue #17 raised it once already, and a suite that named it would turn the next
 * legitimate change into a failure here rather than in the pull request that made it.
 * That is why the comparison below is an ordering against a value read at run time
 * and not an equality against a recorded literal. `1_000_000` is the weight of a major
 * and `1_000` of a minor, which orders any two releases this repository could declare.
 *
 * @param range - A `>=x.y.z` range, or whatever the manifest wrote.
 * @returns The floor, or `0` for a range that does not parse.
 */
function nodeFloor(range: string | undefined): number {
    const parts = (/^>=(\d+)\.(\d+)\.(\d+)$/.exec(range ?? '') ?? []).slice(1, 4).map(Number);

    return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
}

describe('007 FR-007 / AC-017 — the root manifest is the document it was before the site', () => {
    it('is byte-identical to the pre-feature manifest', () => {
        {
            expect(
                sha256(EXTENSION_MANIFEST_PATH),
                'package.json changed. The site must add nothing to it (FR-007); if a change is intended, update '
                    + 'this digest deliberately and say in the commit which clause of AC-017 it satisfies.'
            ).toBe(ROOT_MANIFEST_SHA256);
        }
    });

    it('declares no workspaces and no script that reaches the site', () => {
        {
            // Invariant 2 states the prohibition in its own words, so it is
            // asserted in its own words as well as inside the digest above: a
            // `workspaces` key is the one edit that would put the site's
            // `node_modules` and its own Node floor into the root install.
            expect(EXTENSION_MANIFEST).not.toHaveProperty('workspaces');
        }
        {
            const scripts = Object.entries(EXTENSION_MANIFEST.scripts ?? {});

            expect(scripts.length).toBeGreaterThan(0);
            // FR-070: the root verification command must not lint, type-check, or
            // build the site. `verify` is four steps of the repository's own work.
            for (const [name, command] of scripts) {
                expect(command, `the root script ${name} reaches the site`).not.toMatch(/\b(?:astro|site)\b/);
            }
        }
    });
});

describe('007 FR-006 / FR-007 / FR-008 — the site is its own pinned package', () => {
    it('declares no extension manifest and no version of its own', () => {
        {
            expect(SITE_MANIFEST).not.toHaveProperty('openchamber');
            expect(SITE_MANIFEST).not.toHaveProperty('version');
            // `private` because the site is published by Pages and by nothing
            // else: a `version` is how npm learns to publish something.
            expect(SITE_MANIFEST.private).toBe(true);
        }
        {
            // FR-007's other half, and the one `npm ci` in the site's build job
            // depends on: a committed lockfile of its own, naming its package.
            expect(git(['ls-files', '--error-unmatch', 'site/package-lock.json'])).toBe('site/package-lock.json');
            const lock = JSON.parse(readFileSync(resolve(ROOT, 'site/package-lock.json'), 'utf8')) as { name?: string };

            expect(lock.name).toBe(SITE_MANIFEST.name);
        }
    });

    it('pins every one of its build tools to an exact version', () => {
        {
            const pins = [
                ...Object.entries(SITE_MANIFEST.dependencies ?? {}),
                ...Object.entries(SITE_MANIFEST.devDependencies ?? {}),
            ];

            expect(pins.length).toBeGreaterThan(0);
            // By analogy with invariant 6, which pins the SDK exactly for the
            // same reason: a range is a second place a breaking release can enter
            // from, and the site's gate is the only one that runs.
            for (const [name, pin] of pins) {
                expect(pin, `${name} must not carry a range operator or a prerelease`)
                    .toMatch(/^\d+\.\d+\.\d+$/);
            }
        }
    });

    it('declares a Node floor that satisfies Astro and is not below the root\'s', () => {
        {
            // The site's floor is pinned here on purpose: raising it is a reviewed
            // diff rather than a silent edit. It is *not* Astro's requirement
            // (`>=22.12.0`, measured via `npm view astro@latest engines` and
            // recorded in specs/007-homepage-docs/research.md §1.4) — issue #17
            // raised the repository's floor above that, and the product owner had
            // the site's follow it, so the floor here is the repository's, with
            // Astro's requirement satisfied underneath it and asserted below.
            expect(SITE_MANIFEST.engines?.node).toBe('>=24.15.0');
        }
        {
            // FR-008 as re-cut at 007 v1.3.0: **not lower than** the root's, not
            // higher. The two manifests legitimately declare the same number, so
            // `>` would assert a difference the product has decided against. What
            // the comparison still forbids is the direction that would be a real
            // defect — a subproject claiming a Node older than the repository
            // itself refuses to install on — and it is a comparison of the two
            // values **read at run time**, so it is not weakened by equality: a
            // floor dropped below the root's, or raised without a reviewed edit to
            // the pin above, each fail here.
            expect(nodeFloor(SITE_MANIFEST.engines?.node)).toBeGreaterThanOrEqual(
                nodeFloor(EXTENSION_MANIFEST.engines?.node),
            );
        }
        {
            // And the floor really does satisfy the build tool, so the number is
            // not merely inherited. Astro's own requirement is *recorded* rather
            // than read from `site/node_modules` — the root gate must not depend
            // on the subproject's install having happened — which is why it is a
            // constant here and why a future Astro bump has to update it.
            expect(nodeFloor(SITE_MANIFEST.engines?.node)).toBeGreaterThanOrEqual(nodeFloor(ASTRO_NODE_FLOOR));
        }
    });
});

describe('007 FR-070 / AC-019 — the root tools report no file under site/', () => {
    it('has the site directory in the root lint config\'s ignores', () => {
        {
            expect(readFileSync(resolve(ROOT, 'eslint.config.mjs'), 'utf8')).toContain("'site/**'");
        }
    });

    it('refuses the site directory outright when asked to lint it', () => {
        {
            const linted = runTool(ESLINT_BIN, ['site/']);

            // Not "linted nothing, quietly": ESLint stops with a non-zero status
            // and says the glob matched nothing but ignored files, so a root lint
            // that stopped reaching `site/` cannot read as a clean tree.
            expect(linted.status).not.toBe(0);
            expect(linted.output).toContain('are ignored');
        }
    });

    // The budget is vitest's default 5s multiplied by the cost of the one run here
    // that a full suite can starve: it boots ESLint's type-aware config over the root
    // tsconfig, measured at 4.4s idle and 5.4s with every core busy, so the default
    // turned a passing assertion red on load alone. Set above `TOOL_TIMEOUT_MS` on
    // purpose — a genuine hang is reported by the subprocess bound, which names the
    // command, while this figure only has to leave an honest run alone.
    it('refuses to lint a site file cleanly once that ignore is neutralised', () => {
        {
            // The reason `site/**` is in `ignores` and not merely tidy. With the
            // ignore neutralised, the import resolver inherits the root tsconfig,
            // in which `site/` is not a project, and ESLint aborts — a crash of
            // the repository's own gate, not a finding.
            //
            // **What it says is asserted as the invariant, not as one install
            // layout's spelling of it.** The claim is that neutralising the
            // ignore puts the repository's own lint command over a file it has
            // been told to skip, and that ESLint cannot return success while
            // doing so. How that refusal arrives depends on whether `site/` has
            // been installed here, and both of those refusals are the same fact:
            //   - installed: the resolver loads `astro/config` through the site tsconfig,
            //     which the root project does not extend, and ESLint dies with
            //     `EslintPluginImportResolveError` — the crash the config comment names.
            //   - not installed, as in the root CI job, which never installs the
            //     subproject (FR-070): there is no `astro/config` to resolve either,
            //     so the rule reports an ordinary `import-x/no-unresolved` finding.
            // Asserting the crash class unconditionally would have made this suite
            // depend on an install the gate is not allowed to assume; asserting
            // only "non-zero" would have passed for any reason at all.
            const crashed = runTool(ESLINT_BIN, ['--no-ignore', 'site/astro.config.ts']);

            expect(crashed.status).not.toBe(0);
            // The finding is against a file under `site/` — the load-bearing half,
            // and the half that holds whichever way the refusal is expressed. Both
            // spellings head their output with the offending path.
            expect(crashed.output).toContain(resolve(SITE_DIR, 'astro.config.ts'));
            // And it is the file the assertion neutralised, not something ESLint
            // picked up on its own: the ignore is what used to keep it unread.
            expect(crashed.output).not.toContain('are ignored');
        }
        {
            // The crash class itself, asserted only where the site *is* installed,
            // because the error and the rule are the two things a future dependency
            // bump would change last — and the bump can only change them here, since
            // this is the only install in which the resolver gets far enough to have
            // an opinion about the cycle.
            if (siteInstallPresent()) {
                const crashed = runTool(ESLINT_BIN, ['--no-ignore', 'site/astro.config.ts']);

                expect(crashed.status).not.toBe(0);
                expect(crashed.output).toContain('EslintPluginImportResolveError');
                expect(crashed.output).toContain('import-x/no-cycle');
            }
        }
    }, 30_000);

    it('keeps the site out of the root TypeScript project', () => {
        {
            const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf8')) as {
                readonly include?: readonly string[];
            };

            // Not one `site` glob: adding `site/**/*.ts` would put Astro's own
            // types and the site's `astro/tsconfigs/strictest` settings under
            // this repository's compiler options, which are the other half of
            // FR-070.
            expect((tsconfig.include ?? []).filter((entry) => entry.includes(SITE_DIR))).toEqual([]);
            expect(tsconfig.include?.length ?? 0).toBeGreaterThan(0);
        }
        {
            const listed = runTool(TSC_BIN, ['--noEmit', '--listFilesOnly']);
            const files = listed.output.split('\n').filter((line) => line !== '');

            expect(listed.status).toBe(0);
            // Not vacuous: the project is hundreds of files, and they are the
            // panel's, the service's and the tests'.
            expect(files.filter((file) => file.endsWith('.ts')).length).toBeGreaterThan(100);
            expect(files.filter((file) => file.startsWith(`${resolve(ROOT, SITE_DIR)}/`))).toEqual([]);
        }
    });
});

describe('007 FR-071 / AC-021 — nothing the site builds is tracked', () => {
    it('ignores all three of its directories, and tracks none of them', () => {
        {
            const ignored = readFileSync(resolve(ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());

            // Unanchored, so each matches at any depth — which is the whole of
            // why `site/` needs no line of its own and why `node_modules/` needs
            // none under it either.
            for (const pattern of ['dist/', '.astro/', 'node_modules/']) {
                expect(ignored, `${pattern} must be unanchored so it matches under site/`).toContain(pattern);
            }
        }
        {
            // The site repeats the first two on purpose: the file says so, and the
            // reason is that the directory then carries its own rule if it is ever
            // moved, copied, or vendored away from this repository root. It carries
            // no `node_modules/` line because the root's pattern already covers it.
            const own = readFileSync(resolve(ROOT, SITE_DIR, '.gitignore'), 'utf8')
                .split('\n')
                .map((line) => line.trim());

            expect(own).toContain('dist/');
            expect(own).toContain('.astro/');
            expect(own).not.toContain('node_modules/');
        }
        {
            // Live, and true whether or not a build has run here: the three real
            // paths, each matched by the pattern this suite says it should be.
            // `check-ignore -v` writes `<source>:<line>:<pattern>\t<path>`, so the
            // pattern is the part after the second colon rather than a field.
            const probes = ['site/dist/index.html', 'site/.astro/types.d.ts', 'site/node_modules/astro/package.json'];
            const checked = runTool('git', ['check-ignore', '-v', ...probes]);
            const verdicts = checked.output.split('\n').map((line) => {
                const [where, probe] = line.split('\t', 2);

                return { probe: probe ?? '', pattern: (where ?? '').replace(/^.*:\d+:/, '') };
            });
            const patternFor = (probe: string): string => verdicts.find((row) => row.probe === probe)?.pattern ?? '';

            expect(checked.status).toBe(0);
            expect(patternFor(probes[0] ?? '')).toBe('dist/');
            expect(patternFor(probes[1] ?? '')).toBe('.astro/');
            // Read off the root `.gitignore`, which is the claim the site's own
            // file makes in its comment and which nothing would otherwise check.
            expect(patternFor(probes[2] ?? '')).toBe('node_modules/');
        }
        {
            const paths = git(['ls-files']).split('\n');

            expect(paths.filter((path) => path.startsWith('site/dist/'))).toEqual([]);
            expect(paths.filter((path) => path.startsWith('site/.astro/'))).toEqual([]);
            expect(paths.filter((path) => path.startsWith('site/node_modules/'))).toEqual([]);
        }
        {
            // The "untracked once they exist, with no untracked-file exception
            // needed" half of AC-021, observed rather than assumed — and
            // observed only where there is something to observe.
            //
            // Conditional, and the condition is the point: the root CI job runs
            // `npm run verify`, which builds `panel/` and `service/` and never the
            // site (FR-070 keeps `site/` out of the root toolchain's scope), so
            // none of the three directories exists there. Asserting that
            // `site/dist/` does would have been asserting a fact about whichever
            // developer's machine ran it. Ignored and untracked is what AC-021
            // requires and what the two cases above check with or without the
            // directories present; this case adds the observation that real files
            // under them leave the working tree clean.
            if ([...SITE_GENERATED].some((name) => existsSync(resolve(ROOT, SITE_DIR, name)))) {
                const dirty = git(['status', '--porcelain']).split('\n')
                    .filter((line) => /site\/(?:dist|\.astro|node_modules)\//.test(line));

                expect(dirty).toEqual([]);
            }
        }
    });
});

describe('007 FR-070 — the site\'s tests stay out of the root test glob', () => {
    it('ships no *.test.* file, because the root vitest has no config file', () => {
        {
            const shipped = siteFiles('');

            expect(shipped.length).toBeGreaterThan(20);
            expect(shipped.filter((path) => path.includes('.test.'))).toEqual([]);
        }
        {
            // Why, since a site that grows a normal test file will not think about
            // it: the root `npm test` is a bare `vitest run` with no config file,
            // so its default include globs every `*.test.*` from the repository
            // root and would collect it into the repository's own gate, which
            // FR-070 forbids. The site's suite is `node --test` over
            // `tests/**/*.assertions.mjs`, which is why that is the name it uses.
            const own = siteFiles('tests');

            expect(own.filter((path) => path.endsWith('.assertions.mjs')).length).toBeGreaterThan(0);
        }
    });
});

describe('007 AC-018 / AC-023 — the repository\'s own gate workflow is untouched', () => {
    it('is byte-identical to the workflow this feature found', () => {
        {
            expect(
                sha256(VERIFY_WORKFLOW_PATH),
                'verify.yml changed. Nothing in this feature may touch it; if a change is intended, update this '
                    + 'digest deliberately and say why.'
            ).toBe(VERIFY_WORKFLOW_SHA256);
        }
    });

    it('keeps its read-only permission and its fifteen-minute budget', () => {
        {
            const workflow = readFileSync(resolve(ROOT, VERIFY_WORKFLOW_PATH), 'utf8');

            expect(workflow).toContain('permissions:\n  contents: read');
            expect(workflow).toContain('timeout-minutes: 15');
            expect(workflow).toContain('run: npm run verify');
        }
    });
});

describe('007 AC-023 / FR-066 / FR-067 — the publish workflow', () => {
    // Wave 7 (T-037) writes this file, so these two assertions were written
    // while it did not exist and skipped themselves until it landed. Wave 7 has
    // landed, and a `skipIf` on "the workflow file is missing" would convert the
    // one condition AC-023 cares about into a silent skip — deleting
    // `site.yml` would turn both of these green. So the file's presence is now
    // asserted outright, once, here: a missing workflow fails this suite loudly
    // instead of quietly emptying it.
    it('exists, because both of its properties below are asserted against it', () => {
        {
            expect(existsSync(resolve(ROOT, PUBLISH_WORKFLOW_PATH))).toBe(true);
        }
    });

    it('references every action by a commit SHA', () => {
        {
            expectActionsShaPinned(readFileSync(resolve(ROOT, PUBLISH_WORKFLOW_PATH), 'utf8'), PUBLISH_WORKFLOW_PATH);
        }
    });

    it('grants exactly the permissions a Pages deployment needs, and nothing else', () => {
        {
            const workflow = readFileSync(resolve(ROOT, PUBLISH_WORKFLOW_PATH), 'utf8');
            const granted = [...workflow.matchAll(/^\s*[a-z][a-z-]*:\s*(?:read|write)\s*$/gm)]
                .map((match) => match[0].trim());

            // The workflow reads the repository; the deploy job writes Pages and
            // presents an OIDC token and nothing else. A fourth grant is the
            // failure this is here to catch, and a whole-file list of grants is
            // what catches it — `contents: write` would otherwise pass unnoticed
            // beside the three that are correct.
            expect(granted).toEqual(['contents: read', 'pages: write', 'id-token: write']);
        }
    });
});

describe('the release workflow — one write grant, and a tag the manifest agrees with', () => {
    // The same reasoning as the publish workflow above: the properties are
    // asserted outright rather than skipped when the file is missing, so
    // deleting `release.yml` fails here instead of quietly emptying this suite.
    it('exists, because every property below is asserted against it', () => {
        {
            expect(existsSync(resolve(ROOT, RELEASE_WORKFLOW_PATH))).toBe(true);
        }
    });

    // The one third-party piece of code the repository runs: the release action.
    // Pinned like the others, so a tag push executes the bytes that were reviewed
    // rather than whatever the moving `v3` tag points at on the day.
    it('references every action by a commit SHA', () => {
        {
            expectActionsShaPinned(readFileSync(resolve(ROOT, RELEASE_WORKFLOW_PATH), 'utf8'), RELEASE_WORKFLOW_PATH);
        }
    });

    it('grants exactly a read-only gate and one job-scoped write', () => {
        {
            const workflow = readFileSync(resolve(ROOT, RELEASE_WORKFLOW_PATH), 'utf8');
            const granted = [...workflow.matchAll(/^\s*[a-z][a-z-]*:\s*(?:read|write)\s*$/gm)]
                .map((match) => match[0].trim());

            // The whole-file list is the assertion, for the reason the one above
            // gives: `contents: write` is granted to the publish job alone, so
            // the release action can create the Release object and nothing else
            // in the file can move a ref. The gate job reads the checkout and
            // inherits the workflow's `contents: read` — it states no block of
            // its own — so a third grant, or one it does not need, is the
            // failure this catches.
            expect(granted).toEqual(['contents: read', 'contents: write']);
        }
    });

    it('takes the gate result from the commit\'s own CI run instead of buying a second one', () => {
        {
            // Comment lines are dropped first: the file's prose is *about* the
            // duplicate install, and a rule that read the prose would refuse a
            // sentence discussing it. What is checked is what GitHub executes.
            const executed = readFileSync(resolve(ROOT, RELEASE_WORKFLOW_PATH), 'utf8')
                .split('\n')
                .filter((line) => !line.trimStart().startsWith('#'))
                .join('\n');

            // The link, and the three strings that would undo it. A commit is
            // content-addressed, so CI's pass on this SHA is a statement about
            // these bytes: a second install here would add a copy of the gate
            // to keep in step, not a fact — and polling the Actions API would
            // add a second system to disagree with the first. Ancestry is read
            // from the checkout, and the branch's required checks are what make
            // ancestry mean the bytes were green. Re-introducing either
            // mechanism is a deliberate change, and it fails here first.
            expect(executed).toContain('--is-ancestor');
            expect(executed).toContain('needs: gate');
            expect(executed).not.toContain('npm ci');
            expect(executed).not.toContain('npm run verify');
            expect(executed).not.toContain('gh run list');
        }
    });

    it('refuses a tag that does not name the version the manifest ships', () => {
        {
            const workflow = readFileSync(resolve(ROOT, RELEASE_WORKFLOW_PATH), 'utf8');

            // Asserted by the two load-bearing lines rather than by the message
            // around them: the comparison is made against the pushed ref name,
            // and a run that reaches `exit 1` publishes nothing.
            expect(workflow).toContain('GITHUB_REF_NAME');
            expect(workflow).toContain('exit 1');
        }
    });
});

describe('007 FR-074 / FR-075 / AC-029 — the license is the standard MIT text and nothing else', () => {
    /**
     * The standard MIT template, one entry per clause.
     *
     * Written out whole rather than spot-checked, because FR-074 asks for "the
     * **full** MIT license text — every grant, condition, disclaimer, and
     * warranty waiver of the standard template, not a summary, not an excerpt, and
     * not a substitute notice", and a test that looks for three of the clauses
     * cannot tell an omitted fourth from a present one.
     */
    const MIT_TEMPLATE: readonly string[] = [
        'MIT License',
        'Copyright (c) 2026 Shaun Burdick',
        'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated '
            + 'documentation files (the "Software"), to deal in the Software without restriction, including without '
            + 'limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies '
            + 'of the Software, and to permit persons to whom the Software is furnished to do so, subject to the '
            + 'following conditions:',
        'The above copyright notice and this permission notice shall be included in all copies or substantial portions '
            + 'of the Software.',
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED '
            + 'TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT '
            + 'SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN '
            + 'AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR '
            + 'THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
    ];

    it('carries the whole template, and the copyright line verbatim', () => {
        {
            // Whitespace-normalised on both sides before the comparison, and that
            // is load-bearing rather than cosmetic: the real template wraps the
            // disclaimer paragraph mid-sentence, so a single-line substring check
            // on that clause would false-fail on a correct file. Normalising first
            // is what lets the comparison be exact instead of approximate.
            const license = readFileSync(resolve(ROOT, 'LICENSE'), 'utf8').replaceAll(/\s+/gu, ' ').trim();

            expect(license).toBe(MIT_TEMPLATE.join(' '));
        }
    });

    it('is the license the manifest declares and the README points at', () => {
        {
            expect(EXTENSION_MANIFEST.license).toBe('MIT');
        }
        {
            const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
            const section = readme.indexOf('## License');

            expect(section).toBeGreaterThan(-1);
            expect(readme.slice(section)).toContain('MIT');
            expect(readme.slice(section)).toContain('[LICENSE](LICENSE)');
        }
    });
});

describe('007 FR-077 / AC-008 — the README and the install page\'s table agree with the manifest', () => {
    /** Every capability token this product has ever discussed (002 FR-011, invariant 3). */
    const CAPABILITY_TOKENS = new Set([
        'background',
        'files',
        'model',
        'network',
        'prompt',
        'service',
        'sessions',
    ]);

    it('names every capability the manifest requests, implied ones included, and no other', () => {
        {
            // The README-side half of AC-008, and the drift FR-077 was added to
            // correct: a `network` row, or the "exactly these four things" claim,
            // copied out of the readme that is being retired and into the
            // documentation that outlives it. Whole backtick contents only, so
            // `service/main.js` in the bundle paragraph is not read as the
            // capability.
            const named = new Set(
                [...readFileSync(resolve(ROOT, 'README.md'), 'utf8').matchAll(/`([a-z][a-z-]*)`/g)]
                    .map((match) => match[1] ?? '')
                    .filter((token) => CAPABILITY_TOKENS.has(token))
            );
            const parsed = parseManifestJson(readFileSync(resolve(ROOT, EXTENSION_MANIFEST_PATH), 'utf8'));

            expect(parsed.ok).toBe(true);
            if (!parsed.ok) {
                throw new Error('package.json is not an OpenChamber manifest, so it requests no capabilities at all');
            }

            expect([...named].toSorted(byText)).toEqual(
                [...requestedGuestCapabilities(parsed.manifest.contributes)].toSorted(byText)
            );
        }
    });

    it('builds the install page\'s permission table out of the manifest declaration', () => {
        {
            // The page-side half of AC-008. Read as source text rather than
            // imported, because a root test must not reach into `site/` (FR-070):
            // an import would pull Astro and a second `node_modules` into this
            // repository's gate. The derivation is what makes the comparison
            // above hold for the page as well as for the readme — the table
            // cannot name a capability the manifest does not request, or omit one
            // it does, because it never holds a list of its own.
            const declarations = readFileSync(resolve(ROOT, SITE_DIR, 'src/data/declarations.ts'), 'utf8');

            expect(declarations).toContain("import manifest from '../../../package.json'");
            expect(declarations).toMatch(/manifest\.openchamber\.contributes\.capabilities\.map/);
            expect(declarations).toMatch(/manifest\.openchamber\.contributes\.service === undefined/);
        }
    });
});

/** Repository-relative path of the npm lockfile: the only record of what the tree admits. */
const LOCKFILE_PATH = 'package-lock.json';

/**
 * Node floor `engines.node` must declare, pinned so that raising it is a
 * deliberate edit in two places rather than a silent one in the manifest.
 */
const NODE_ENGINE_FLOOR = '>=24.15.0';

/**
 * Distance between sampled majors. Node promotes a major to LTS only on an
 * even number, and never promotes an odd one at all.
 */
const LTS_MAJOR_INTERVAL = 2;

/**
 * How far past the floor's own major the grid keeps walking. Three LTS lines
 * of headroom is enough to notice a dependency that stops admitting a later
 * major, which is the failure mode a floor alone cannot see: the manifest
 * promises a version nobody can install.
 */
const SAMPLED_MAJOR_SPAN = 6;

/** Highest minor the grid samples; well past every minor Node has shipped. */
const SAMPLED_MAX_MINOR = 20;

/** Highest patch the grid samples; well past every patch Node has shipped. */
const SAMPLED_MAX_PATCH = 40;

/** The fields of one lockfile entry that the floor guard reads. */
interface LockEntry {
    readonly engines?: { readonly node?: string };
}

/** The shape of a lockfileVersion 3 npm lockfile, as this suite reads it. */
interface Lockfile {
    readonly lockfileVersion?: number;
    readonly packages?: Readonly<Record<string, LockEntry>>;
}

/**
 * Every Node version the floor admits, ascending.
 *
 * The grid is sampled on the LTS interval for a reason, and the reason is the
 * dependency ranges rather than taste: `vitest` declares `^22.12.0 ||
 * ^24.0.0 || >=26.0.0`, which covers 24 and everything from 26 up but leaves
 * 25 to nobody, so a strict subset over all of semver would go red on an odd
 * major that this project neither targets nor tests. That is a deliberate
 * scope limit — the claim is "no version on a supported line is rejected",
 * not "no version anywhere in semver is rejected".
 *
 * The grid is dense (every minor and patch within the ceilings above, on each
 * sampled major) so that it straddles an exact boundary like `^22.22.2`
 * instead of stepping over it between two samples, and it starts from the
 * floor's own minimum rather than a hardcoded major, so raising the floor
 * moves the grid with it. The floor's own minimum joins the grid explicitly
 * so a floor set to a Current-only (odd) major is still checked against
 * itself rather than passing on an empty sample.
 *
 * @param floor - The `engines.node` range under test.
 * @returns Admitted versions, ascending.
 */
function admittedVersions(floor: string): readonly string[] {
    const lowest = minVersion(floor);
    if (lowest === null) {
        throw new Error(`engines.node "${floor}" is not a range semver can resolve`);
    }

    const firstMajor = Math.floor(lowest.major / LTS_MAJOR_INTERVAL) * LTS_MAJOR_INTERVAL;
    const versions: string[] = [];
    for (let major = firstMajor; major <= firstMajor + SAMPLED_MAJOR_SPAN; major += LTS_MAJOR_INTERVAL) {
        for (let minor = 0; minor <= SAMPLED_MAX_MINOR; minor += 1) {
            for (let patch = 0; patch <= SAMPLED_MAX_PATCH; patch += 1) {
                versions.push(`${major}.${minor}.${patch}`);
            }
        }
    }

    versions.push(lowest.version);
    return versions.filter((version) => satisfies(version, floor)).toSorted((left, right) => compare(left, right));
}

describe('Node engine floor', () => {
    const lock = JSON.parse(readFileSync(resolve(ROOT, LOCKFILE_PATH), 'utf8')) as Lockfile;
    const floor = EXTENSION_MANIFEST.engines?.node ?? '';
    const admitted = admittedVersions(floor);

    it('declares the floor, read from the lockfile package map', () => {
        {
            expect(floor).toBe(NODE_ENGINE_FLOOR);
        }
        {
            // v3 is the shape this suite reads: `packages` carries every entry's
            // `engines` block, while the v1/v2 `dependencies` map does not have
            // them at all, so a downgrade would empty the sweep below.
            expect(lock.lockfileVersion).toBe(3);
            expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(0);
        }
    });

    it('admits no version that any dependency in the lockfile rejects', () => {
        const entries = Object.entries(lock.packages ?? {});
        const conflicts: string[] = [];
        for (const [path, entry] of entries) {
            // The root entry mirrors the floor under test, and a package that
            // declares no range cannot reject anything.
            if (path === '' || typeof entry.engines?.node !== 'string') {
                continue;
            }

            const range = entry.engines.node;
            if (validRange(range) === null) {
                throw new Error(`${path} declares engines.node "${range}", which semver cannot parse`);
            }

            // The lowest rejection is the actionable one: it is the closest
            // version to the floor that this package refuses, so it names the
            // release the floor has to move to.
            const rejected = admitted.find((version) => !satisfies(version, range));
            if (rejected !== undefined) {
                conflicts.push(
                    `${path} declares engines.node "${range}", which rejects ${rejected} — admitted by "${floor}"`,
                );
            }
        }

        expect(
            conflicts,
            `engines.node "${floor}" admits a version the tree cannot install. Raise the floor above the lowest ` +
                'rejection above, or pin a dependency whose floor moved.',
        ).toEqual([]);
    });
});
