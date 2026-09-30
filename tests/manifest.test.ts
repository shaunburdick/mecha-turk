import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostMeetsOpenChamberEngine, requestedGuestCapabilities } from '@openchamber/sdk';
import { parseManifestJson } from '@openchamber/sdk/schemas';

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
        expect(openchamberBlock(EXTENSION_MANIFEST).apiVersion).toBe(1);
    });

    it('declares the documented engine floor', () => {
        expect(openchamberBlock(EXTENSION_MANIFEST).engines?.openchamber).toBe(ENGINE_FLOOR);
    });

    it('accepts the floor build and refuses older hosts', () => {
        expect(hostMeetsOpenChamberEngine(SUPPORTED_BUILD, ENGINE_FLOOR)).toBe(true);
        expect(hostMeetsOpenChamberEngine(UNSUPPORTED_BUILD, ENGINE_FLOOR)).toBe(false);
    });

    it('parses with the official SDK manifest parser', () => {
        const text = readFileSync(resolve(ROOT, EXTENSION_MANIFEST_PATH), 'utf8');
        const parsed = parseManifestJson(text);

        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            expect(parsed.manifest.apiVersion).toBe(1);
        }
    });

    it('ships a semver version on the extension package', () => {
        expect(EXTENSION_MANIFEST.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('keeps the kebab-case identity and its storage-key prefix (006 T-028, AGENTS 4)', () => {
        const panelId = openchamberBlock(EXTENSION_MANIFEST).contributes?.panel?.id ?? '';
        expect(panelId).toMatch(/^[a-z][a-z0-9-]*$/);

        // The storage namespace is the *same* identity: every panel storage
        // key is prefixed with it, so renaming either one is a user-visible
        // storage reset. Asserted here, where the identity is declared.
        const prefixed = readdirSync(resolve(ROOT, 'src'), { recursive: true })
            .map((entry) => String(entry))
            .filter((entry) => entry.endsWith('.ts'))
            .filter((entry) => readFileSync(resolve(ROOT, 'src', entry), 'utf8').includes(`${panelId}:`));

        expect(prefixed.length).toBeGreaterThan(0);
    });
});

describe('SDK pinning', () => {
    it('pins the SDK exactly in the extension package', () => {
        const pin = EXTENSION_MANIFEST.dependencies?.[SDK_PACKAGE];
        expect(pin).toBeDefined();
        expect(pin).not.toMatch(/^[~^]/);
    });

    it('pins the SDK in dependencies only, never duplicated in devDependencies', () => {
        const pin = EXTENSION_MANIFEST.dependencies?.[SDK_PACKAGE];
        expect(pin).toBeDefined();
        expect(EXTENSION_MANIFEST.devDependencies?.[SDK_PACKAGE]).toBeUndefined();
    });

    it('never pins a preview release', () => {
        const pin = EXTENSION_MANIFEST.dependencies?.[SDK_PACKAGE] ?? '';
        expect(pin).not.toContain('preview');
    });
});

describe('declared capabilities', () => {
    it('requests exactly the capabilities the spike uses', () => {
        expect(openchamberBlock(EXTENSION_MANIFEST).contributes?.capabilities).toEqual(ALLOWED_CAPABILITIES);
    });

    it('declares no filesystem, background, or model surface', () => {
        const { contributes } = openchamberBlock(EXTENSION_MANIFEST);
        expect(contributes?.filesystem).toBeUndefined();
        expect(contributes?.background).toBeUndefined();
    });

    it('requests no capability outside the documented set', () => {
        const capabilities = openchamberBlock(EXTENSION_MANIFEST).contributes?.capabilities ?? [];
        const documented = ['sessions', 'prompt', 'files', 'model'];
        for (const capability of capabilities) {
            expect(documented).toContain(capability);
        }
    });
});

describe('service contribution', () => {
    const manifestText = readFileSync(resolve(ROOT, EXTENSION_MANIFEST_PATH), 'utf8');

    it('declares a host runtime entry and no permissions key', () => {
        const manifest = JSON.parse(manifestText) as PackageJson;
        const service = manifest.openchamber?.contributes?.service;

        expect(service).toEqual({ entry: SERVICE_ENTRY, runtime: 'host' });
        expect(service).not.toHaveProperty('permissions');
    });

    it('ships a compiled entry beside its TypeScript source', () => {
        const parsed = parseManifestJson(manifestText);

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }

        const entry = parsed.manifest.contributes.service?.entry;
        expect(entry).toBe(SERVICE_ENTRY);
        expect(existsSync(resolve(ROOT, entry ?? ''))).toBe(true);
        expect(existsSync(resolve(ROOT, 'service/main.ts'))).toBe(true);
    });

    it('parses with the SDK service rules', () => {
        const parsed = parseManifestJson(manifestText);

        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            expect(parsed.manifest.contributes.service?.runtime).toBe('host');
        }
    });

    it('derives the implied capability set through the SDK', () => {
        const parsed = parseManifestJson(manifestText);

        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            const requested = requestedGuestCapabilities(parsed.manifest.contributes);

            // No integration card means no implied `network`: the panel has
            // no GitHub traffic of its own (the card and its `/user`
            // diagnostic went with the install-time credential), so the only
            // implied capability left is the one `contributes.service`
            // carries (AGENTS invariant 3).
            expect([...requested].sort()).toEqual(['prompt', 'service', 'sessions']);
        }
    });

    it('never lists an implied capability inside capabilities[]', () => {
        const declared = openchamberBlock(EXTENSION_MANIFEST).contributes?.capabilities ?? [];

        expect(declared).not.toContain('service');
        expect(declared).not.toContain('network');
    });
});

describe('GitHub integration card (retired 2026-09-30)', () => {
    const integration = openchamberBlock(EXTENSION_MANIFEST).contributes?.integration;

    it('declares no integration card at all', () => {
        // 002 FR-011's card was the install-time credential: its `token`
        // block asked the host to hold a GitHub token for the panel, and its
        // only two products (a connected-login badge and a `/user`
        // diagnostic) are gone with it. A card left behind with an empty
        // shell in it would be a second path to a capability the service
        // accounts own.
        expect(integration).toBeUndefined();
    });

    it('keeps the panel GitHub-free: no api origin, no bearer scheme, no /user', () => {
        const serialized = JSON.stringify(openchamberBlock(EXTENSION_MANIFEST));

        expect(serialized).not.toContain('api.github.com');
        expect(serialized).not.toContain('/user');
        expect(serialized).not.toContain('bearer');
    });
});

describe('panel entry', () => {
    it('points at a shipped HTML file', () => {
        const entry = openchamberBlock(EXTENSION_MANIFEST).contributes?.panel?.entry;
        expect(entry).toBe('panel/index.html');
        expect(existsSync(resolve(ROOT, entry ?? ''))).toBe(true);
    });

    it('matches the providerId the dispatch code sends', () => {
        const panelId = openchamberBlock(EXTENSION_MANIFEST).contributes?.panel?.id;
        const sessionSource = readFileSync(resolve(ROOT, 'src/session.ts'), 'utf8');
        expect(panelId).toBe('mecha-turk');
        expect(sessionSource).toContain("providerId: 'mecha-turk'");
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
        for (const name of readdirSync(root, { recursive: true })) {
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
        expect(contributes?.integration).toBeUndefined();

        const serialized = JSON.stringify(contributes ?? {});
        for (const id of CARD_SETTING_IDS) {
            expect(serialized).not.toContain(id);
        }
        expect(serialized).not.toContain('repository');
    });

    it('leaves capabilities, the service, and the panel id untouched', () => {
        expect(contributes?.capabilities).toEqual(['sessions', 'prompt']);
        expect(contributes?.service).toEqual({
            entry: SERVICE_ENTRY,
            runtime: 'host',
        });
        expect(contributes?.panel?.id).toBe('mecha-turk');
    });
});

describe('002 AC-021 — no reader takes a card id from ctx.settings', () => {
    it('keeps every retired settings identifier out of the panel source', () => {
        for (const [path, source] of panelSources()) {
            for (const identifier of RETIRED_IDENTIFIERS) {
                expect(source, `${path} still names ${identifier}`).not.toContain(identifier);
            }
        }
    });

    it('never quotes one of the card’s kebab-case ids as a value', () => {
        // `repository` is excluded deliberately: it is also an ordinary DTO
        // field name on the wire, so its card reading is covered by the
        // "nothing indexes a settings record" assertion below instead.
        for (const [path, source] of panelSources()) {
            for (const id of CARD_SETTING_IDS) {
                const single = `'${id}'`;
                const double = `"${id}"`;
                const quoted = source.includes(single) || source.includes(double);
                expect(quoted, `${path} reads the card id ${id}`).toBe(false);
            }
        }
    });

    it('indexes no settings record anywhere in the panel source', () => {
        const indexed = /\bsettings\s*\[/;
        for (const [path, source] of panelSources()) {
            expect(indexed.test(source), `${path} indexes a settings record`).toBe(false);
        }
    });
});
