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
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly engines?: { readonly node?: string };
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
