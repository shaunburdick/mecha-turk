import { readFileSync, existsSync } from 'node:fs';
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

        expect(service).toEqual({ entry: 'service/main.js', runtime: 'host' });
        expect(service).not.toHaveProperty('permissions');
    });

    it('ships a compiled entry beside its TypeScript source', () => {
        const parsed = parseManifestJson(manifestText);

        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }

        const entry = parsed.manifest.contributes.service?.entry;
        expect(entry).toBe('service/main.js');
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

            expect([...requested].sort()).toEqual(['network', 'prompt', 'service', 'sessions']);
        }
    });

    it('never lists an implied capability inside capabilities[]', () => {
        const declared = openchamberBlock(EXTENSION_MANIFEST).contributes?.capabilities ?? [];

        expect(declared).not.toContain('service');
        expect(declared).not.toContain('network');
    });
});

describe('GitHub integration', () => {
    const integration = openchamberBlock(EXTENSION_MANIFEST).contributes?.integration;

    it('declares the GitHub API origin', () => {
        expect(integration?.token?.apiOrigin).toBe('https://api.github.com');
    });

    it('sends the token as a bearer credential', () => {
        expect(integration?.token?.scheme).toBe('bearer');
    });

    it('discovers the account through GET /user', () => {
        expect(integration?.token?.account?.path).toBe('/user');
        expect(integration?.token?.account?.name).toBe('login');
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
        expect(panelId).toBe('mecha-turk-spike');
        expect(sessionSource).toContain("providerId: 'mecha-turk-spike'");
    });
});
