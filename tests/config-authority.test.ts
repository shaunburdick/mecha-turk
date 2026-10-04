/**
 * Configuration authority (006 T-025, T-026 — block J; FR-004, FR-090 –
 * FR-092; AC-151, AC-152, AC-153; 002 FR-041).
 *
 * Three layers, in this order, with no overlap between them — so precedence
 * is a property of the ordering rather than a tie-break (FR-090):
 *
 * 1. **Bootstrap environment**, read at process start before the store opens:
 *    the host-provided pair only, validated fail-closed and never echoed.
 * 2. **`config.json`**, authoritative for every documented field once the
 *    store opens.
 * 3. **The manifest**, which carries **no** service configuration at all —
 *    its integration card is gone entirely (product-owner order,
 *    2026-09-30), so there is no second input surface to arbitrate.
 *
 * What is asserted here is the *absence* half of that statement, which is the
 * half that rots: no `.env` of any kind ships, no dotenv-style loader exists,
 * no `MECHA_TURK_` identifier survives outside the specification corpus, and
 * the poll interval has **exactly one** operator input — the Settings row,
 * whose bounds come from the service's own declaration.
 *
 * The AC-153 scan counts **inputs** (surfaces an operator can set), not
 * constants; the panel does carry a poll cadence for its own refresh timer,
 * and the last case below argues — rather than assumes — why it is not a
 * second one.
 *
 * Offline: local files, `git ls-files`, and the pure environment reader
 * (FR-086). No network, no PAT, no live host.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { readServiceEnv } from '../service/env.ts';
import { byText } from './support/sort.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** The one document the manifest and the cards are read from. */
const MANIFEST = 'package.json';

/** The bootstrap pair the host sets and the service validates (FR-090). */
const PORT_KEY = 'OPENCHAMBER_SERVICE_PORT';

/** The second half of the bootstrap pair. */
const TOKEN_KEY = 'OPENCHAMBER_SERVICE_TOKEN';

/** A token shaped so that leaking it into a message would be obvious. */
const TOKEN_VALUE = 'the-quick-brown-fox-jumps-over-the-lazy-dog-0123456789';

/** The manifest setting 002 FR-041 removed, named once for its three scans. */
const INTERVAL_SETTING = 'poll-interval-ms';

/** The specification corpus that quotes removed identifiers as history (plan D11). */
const SPEC_CORPUS = 'specs/';

/** The service's source tree, repository-relative. */
const SERVICE_DIR = 'service';

/**
 * An environment-family identifier: the removed prefix **followed by name
 * characters**.
 *
 * The trailing characters matter. AC-151 forbids an *identifier*, and the two
 * places the bare prefix still exists are the specification corpus (excluded)
 * and a negative assertion that names what it refuses (`tests/docs-sync.test.ts`
 * spells the prefix and nothing after it) — neither is an identifier, and both
 * are records that the family is gone. Requiring a name continuation keeps the
 * rule satisfiable while every real use of the family still fails it.
 */
const ENV_IDENTIFIER = /MECHA_TURK_[A-Za-z0-9]+/g;

/**
 * One environment read: `process.env`, an indexed `env[NAME]`, or an
 * uppercase `env.NAME` property.
 *
 * Lowercase properties are deliberately absent: `options.env.port` and
 * `deps.env.token` are reads of the *validated* {@link ServiceEnv}, not of the
 * process environment, and counting them would report the pair twice.
 */
const ENV_READ = /\bprocess\.env\b|\benv\[\s*([A-Za-z_]\w*)\s*\]|\benv\.([A-Z][A-Z0-9_]*)/g;

/** One `.ts` module under a tree. */
interface SourceModule {
    /** Path relative to the repository root. */
    readonly path: string;
    /** File text as written. */
    readonly text: string;
}

/**
 * Read one tracked file's text, skipping what cannot be text.
 *
 * @param path - Repository-relative path.
 * @returns Its contents.
 */
function trackedText(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8');
}

/**
 * Every file git tracks, in index order.
 *
 * @returns The paths.
 */
function trackedFiles(): readonly string[] {
    const listed = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });

    return listed.split('\n').filter((path) => path !== '');
}

/**
 * Read every `.ts` module under one tree, recursively.
 *
 * @param dir - Repository-relative directory.
 * @returns The modules, in directory order.
 */
function sourceModules(dir: string): readonly SourceModule[] {
    const entries = readdirSync(resolve(ROOT, dir), { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith('.ts'))
        .toSorted(byText);

    return entries.map((entry) => ({ path: `${dir}/${entry}`, text: trackedText(`${dir}/${entry}`) }));
}

/**
 * The lines of a source file that are **not** comments.
 *
 * Both scans below are about code: a doc comment that *names* a retired
 * identifier or a retired setting is the record of the retirement, exactly
 * like the specification corpus.
 *
 * @param text - File text.
 * @returns The code lines, in order.
 */
function codeLines(text: string): readonly string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !/^(\/\/|\/?\*)/.test(line));
}

/**
 * The environment reads one module performs, in source order.
 *
 * @param text - File text.
 * @returns The read expressions, as written.
 */
function envReadsIn(text: string): readonly string[] {
    return [...codeLines(text).join('\n').matchAll(ENV_READ)].map((match) => match[0]);
}

/**
 * Capture the message one call refused with.
 *
 * @param run - The call that is expected to throw.
 * @returns The error's message.
 */
function messageOf(run: () => unknown): string {
    try {
        run();
    } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
    }

    throw new Error('expected the environment to be refused');
}

/** The manifest, parsed once for the assertions that read its shape. */
interface ManifestShape {
    /** The host-extension contribution block. */
    readonly openchamber: {
        /** The contribution block the manifest identity rules apply to. */
        readonly contributes: {
            /** The capability list the install gate checks (FR-004). */
            readonly capabilities: readonly string[];
            /** The integration card, which no longer exists (owner order 2026-09-30). */
            readonly integration?: Record<string, unknown>;
            /** The service entry. */
            readonly service: Record<string, unknown>;
        };
    };
}

/**
 * Read the manifest fail-closed: a shape this test cannot read is a failure,
 * not a pass.
 *
 * @returns The parsed manifest.
 */
function manifest(): ManifestShape {
    const parsed: unknown = JSON.parse(trackedText(MANIFEST));

    return parsed as ManifestShape;
}

describe('FR-091: the operator environment file is gone, not rewritten (T-025, AC-151)', () => {
    it('ships no `.env` and no `.env.example`, and no replacement template', () => {
        expect(existsSync(resolve(ROOT, '.env'))).toBe(false);
        expect(existsSync(resolve(ROOT, '.env.example'))).toBe(false);
        // A replacement template would invite the very file the requirement
        // removes — the two surviving variables are host-set (FR-091(c)).
        const templates = trackedFiles().filter((path) => /^\.env(\.example|\.template|\.sample)?$/.test(path));

        expect(templates).toEqual([]);
    });

    it('keeps `.gitignore` covering `.env*` with no negation left', () => {
        const rules = trackedText('.gitignore')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('.env') || line.startsWith('!'));

        expect(rules).toEqual(['.env', '.env.*']);
    });

    it('carries no environment-family identifier outside the specification corpus', () => {
        const paths = trackedFiles().filter((path) => !path.startsWith(SPEC_CORPUS));
        expect(paths.length).toBeGreaterThan(200);
        // The bundles are tracked files, so this reads them too — which is the
        // "or in either committed bundle" half of AC-151, not a second rule.
        expect(paths).toContain('panel/main.js');
        expect(paths).toContain('service/main.js');

        const offenders: string[] = [];
        for (const path of paths) {
            const matches = trackedText(path).match(ENV_IDENTIFIER);
            if (matches !== null) {
                offenders.push(`${path}: ${matches.join(', ')}`);
            }
        }

        expect(offenders).toEqual([]);
    });

    it('performs no dotenv-style load anywhere in the service', () => {
        const loaders = sourceModules(SERVICE_DIR).filter(
            (module) => /\bdotenv\b|loadEnvFile|['"`]\.env['"`]|['"`]\.env\./.test(module.text),
        );

        expect(loaders.map((module) => module.path)).toEqual([]);
    });

    it('records the removal in the handoff contract instead of editing the sentence', () => {
        const handoff = trackedText('specs/002-agent-event-extension/contracts/token-handoff.md');

        expect(handoff).toContain('was removed on 2026-09-28');
    });
});

describe('FR-090 / AC-152: the bootstrap pair is the only configuration environment', () => {
    it('starts from exactly the host-provided pair, ignoring anything else', () => {
        {
            const decoy = 'SOME_UNRELATED_VARIABLE';
            const env = readServiceEnv({
                [PORT_KEY]: '0',
                [TOKEN_KEY]: TOKEN_VALUE,
                [decoy]: 'ignored',
            });

            expect(env).toEqual({ port: 0, token: TOKEN_VALUE });
        }
        {
            const missingPort = messageOf(() => readServiceEnv({ [TOKEN_KEY]: TOKEN_VALUE }));
            const missingToken = messageOf(() => readServiceEnv({ [PORT_KEY]: '0' }));

            expect(missingPort).toContain(PORT_KEY);
            expect(missingPort).not.toContain(TOKEN_VALUE);
            expect(missingToken).toContain(TOKEN_KEY);
            expect(missingToken).not.toContain(TOKEN_VALUE);
        }
        {
            const badPort = 'not-a-port';
            const shortToken = 'too-short';
            const portMessage = messageOf(() => readServiceEnv({ [PORT_KEY]: badPort, [TOKEN_KEY]: TOKEN_VALUE }));
            const tokenMessage = messageOf(() => readServiceEnv({ [PORT_KEY]: '0', [TOKEN_KEY]: shortToken }));

            expect(portMessage).toContain(PORT_KEY);
            expect(tokenMessage).toContain(TOKEN_KEY);
            // Neither the token nor the malformed submission is echoed anywhere
            // (002 `token-handoff.md` F16; constitution: secrets never in logs).
            expect(portMessage).not.toContain(TOKEN_VALUE);
            expect(portMessage).not.toContain(badPort);
            expect(tokenMessage).not.toContain(TOKEN_VALUE);
            expect(tokenMessage).not.toContain(shortToken);
        }
        {
            const configModule = sourceModules(SERVICE_DIR).find((
                module
            ) => module.path === `${SERVICE_DIR}/config.ts`);

            expect(configModule).toBeDefined();
            expect(envReadsIn(configModule?.text ?? '')).toEqual([]);
        }
        {
            const reads = sourceModules(SERVICE_DIR)
                .map((module) => ({ path: module.path, tokens: envReadsIn(module.text) }))
                .filter((entry) => entry.tokens.length > 0)
                .toSorted((left, right) => left.path.localeCompare(right.path));

            // HOME locates the store directory and configures nothing (GUEST_SERVICES.md).
            expect(reads.map((entry) => entry.path)).toEqual([
                `${SERVICE_DIR}/env.ts`,
                `${SERVICE_DIR}/main.ts`,
                `${SERVICE_DIR}/store/dir.ts`,
            ]);
            expect(reads[0]?.tokens).toEqual(['env[PORT_VARIABLE]', 'env[TOKEN_VARIABLE]']);
            expect(reads[2]?.tokens).toEqual(['env.HOME']);
            // The declarations those two indexes resolve to are the pair itself —
            // and there are exactly two of them, so no third variable hides behind
            // the same spelling.
            const declarations = trackedText(`${SERVICE_DIR}/env.ts`)
                .split('\n')
                .filter((line) => line.startsWith('const ') && line.includes('_VARIABLE = '));
            const declared = declarations.join('\n');

            expect(declarations).toHaveLength(2);
            expect(declared).toContain(PORT_KEY);
            expect(declared).toContain(TOKEN_KEY);
        }
    });
});

describe('FR-092 / AC-153: exactly one operator input per field, the interval being the example', () => {
    it('the manifest declares no integration card and no integration setting (002 FR-041)', () => {
        {
            // The card that used to carry `poll-interval-ms` is gone entirely
            // (owner order 2026-09-30), so the setting has no home in the
            // manifest at all — not an empty array, no manifest entry.
            expect(manifest().openchamber.contributes.integration).toBeUndefined();
            expect(trackedText(MANIFEST)).not.toContain(INTERVAL_SETTING);
        }
        {
            const reads = sourceModules('src')
                .filter((module) => codeLines(module.text).some((line) => line.includes(INTERVAL_SETTING)))
                .map((module) => module.path);

            expect(reads).toEqual([]);
        }
        {
            const derived = sourceModules(SERVICE_DIR).filter(
                (module) => codeLines(module.text).some((line) => line.includes(INTERVAL_SETTING)),
            );

            expect(derived.map((module) => module.path)).toEqual([]);
            // …and the configuration module reads no environment at all, which is
            // the other half of AC-152's "no environment variable influences it".
            expect(envReadsIn(trackedText(`${SERVICE_DIR}/config.ts`))).toEqual([]);
        }
        {
            const descriptor = configSchema().find((entry) => entry.name === 'intervalMs');
            if (descriptor?.kind !== 'integer') {
                throw new Error('the projection declares no integer intervalMs row');
            }

            expect(descriptor.min).toBe(15_000);
            expect(descriptor.max).toBe(300_000);
            expect(descriptor.unit).toBe('milliseconds');
            // The row is the surface: the panel renders one control per projected
            // descriptor and derives no bounds of its own (FR-022, FR-023).
            expect(Object.keys(DEFAULT_CONFIG)).toContain('intervalMs');
            expect(Object.keys(DEFAULT_CONFIG)).not.toContain('pollIntervalMs');
        }
        {
            // AC-153's "exactly one" is an argument about *inputs*, and the panel
            // does carry a cadence of its own for its refresh timer. Here is why
            // it is not a second one — asserted, not assumed:
            //
            // 1. it is a `const` literal, so nothing in the tree can assign it;
            expect(trackedText('src/config.ts')).toContain('export const DEFAULT_POLL_INTERVAL_MS = 60_000;');
            // 2. its only appearances in panel source are that declaration and the
            //    one dispatch-context default built from it — no control, storage
            //    key, manifest setting, or environment read writes it;
            const users = sourceModules('src')
                .filter((module) => module.text.includes('DEFAULT_POLL_INTERVAL_MS'))
                .map((module) => module.path)
                .toSorted(byText);

            expect(users).toEqual(['src/bindings-mode.ts', 'src/config.ts']);
            expect(trackedText('src/bindings-mode.ts')).toContain('pollIntervalMs: DEFAULT_POLL_INTERVAL_MS');
            // 3. it is not a member of the service's document, so the projection
            //    declares no row for it — and a field with no row has no input.
            const projected: readonly string[] = configSchema().map((entry) => entry.name);

            expect(projected).not.toContain('pollIntervalMs');
            // The row builder itself knows nothing about the panel cadence: it
            // mounts one control per projected descriptor and no other (FR-014).
            expect(trackedText('src/settings-rows.ts')).not.toContain('pollIntervalMs');
        }
    });
});
