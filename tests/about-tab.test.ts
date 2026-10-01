/**
 * The About tab (005 T-028; FR-074–FR-077, FR-029, AC-132, AC-133, AC-134,
 * SC-109).
 *
 * The tab has one hard rule with two halves, so the suite leads with both:
 *
 * 1. **One source.** The rendered version equals the service's own
 *    `SERVICE_VERSION`, which equals `package.json`, and the panel source
 *    declares **no** version-shaped literal — so two version strings in one
 *    product is structurally impossible (SC-109).
 * 2. **An honest unknown.** Unreachable ⇒ the exact copy *unknown (service
 *    unreachable)*, with no digit anywhere on the version line, while the
 *    static identity content stays on screen (AC-132, AC-134).
 *
 * The path the panel reads is pinned to the route the service registers, so
 * the shipped `/health` route and the prose that names it (005 T-036's
 * truth-repair) cannot drift apart unnoticed — one pin, in this suite.
 *
 * Everything runs against the panel's doubles: recorded SDK mounts, the fake
 * DOM, and a scripted `host.serviceRequest`. No live host, no token, no
 * network (FR-086).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { healthRoute, SERVICE_VERSION } from '../service/routes/health.ts';
import { EVIDENCE_SCHEMA_VERSION } from '../src/evidence.ts';
import {
    dataDirLine,
    ledgerLines,
    phaseRecordLine,
    versionLine,
} from '../src/about-tab.ts';
import type { AboutTabState } from '../src/about-tab.ts';
import { VOCABULARY_HEADING, VOCABULARY_ITEMS, VOCABULARY_SHORT_FORM } from '../src/vocabulary.ts';
import { HEALTH_PATH } from '../src/service-calls.ts';
import { parseStatusView } from '../src/status-document.ts';
import { findSecretLeak } from '../src/redaction.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { LedgerEntry } from '../src/ledger.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';
import { DEFAULT_BODY, DEFAULT_STATUS, createTestRuntime, fakeHost, tick } from './support/panel.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });

                return {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => undefined,
                };
            };
        }
    }

    return stubbed;
});

/** The picker callbacks the shell takes; none is exercised by this suite. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** Stamp the fixtures record ledger entries with. */
const STAMP = '2026-09-30T12:00:00.000Z';

/** Time slice the ledger lines print for that stamp. */
const STAMP_TIME = '12:00:00';

/** The exact copy an unreachable service must produce (AC-134). */
const UNREACHABLE = 'Version: unknown (service unreachable)';

/** The data directory a read status projection reports. */
const DATA_DIR = '/home/agent/.config/openchamber/mecha-turk';

/** A version-shaped literal: three dot-separated numbers, not an IP address. */
const VERSION_SHAPED = /(?<![\d.])\d+\.\d+\.\d+(?![\d.])/;

/** The version line an unread tab shows before the first health answer. */
function unreadState(): AboutTabState {
    return { phase: 'idle', at: null, problem: null, version: null };
}

/** The health answer this build's own service gives (contract §0). */
const HEALTH_BODY = JSON.stringify({ status: 'ok', version: SERVICE_VERSION, schemaVersion: 1 });

/** A `GET /v1/status` body whose service block reports {@link DATA_DIR}. */
const STATUS_BODY = JSON.stringify({
    service: { status: 'ok', uptimeMs: 1000, dataDir: DATA_DIR, schemaVersion: 1, storage: { writable: true } },
    accounts: [],
    repositories: [],
    agentPin: { expectedAgent: null, lastVerification: null },
    polling: { intervalMs: 60_000, nextPollAt: null, paused: false, pausedReason: '' },
    surface: { supported: true },
});

/** What one mount of the About body recorded. */
interface AboutMount {
    /** The runtime the body mounted against. */
    readonly rt: PanelRuntime;
    /** The shell's disposer for this body. */
    readonly dispose: () => void;
    /** Every element the mount created, in creation order. */
    readonly created: readonly FakeElement[];
    /** Every request the tab made, in order. */
    readonly requests: readonly GuestRequest[];
    /** Every string the SDK mounts were handed, in order. */
    readonly strings: readonly string[];
}

/**
 * Mount only the About body against the recording SDK stub.
 *
 * @param input - How the service should answer, and state to arrange first.
 * @returns The runtime, the disposer, and everything the render recorded.
 */
async function mountAbout(input: {
    /** Answers for `host.serviceRequest`; defaults to the neutral 404. */
    readonly answer?: (request: GuestRequest) => GuestRequestResult | Promise<GuestRequestResult>;
    /** State to arrange before the body mounts. */
    readonly setup?: (rt: PanelRuntime) => void;
}): Promise<AboutMount> {
    mounts.log.length = 0;
    const requests: GuestRequest[] = [];
    const host = fakeHost({
        serviceRequest: async (request) => {
            requests.push(request);

            return input.answer === undefined
                ? { status: DEFAULT_STATUS, body: DEFAULT_BODY }
                : await input.answer(request);
        },
    });
    const rt = createTestRuntime(host);
    input.setup?.(rt);

    const dom = fakeDom();
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'about');
    if (spec === undefined) {
        throw new Error('the About tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the About body mounted no disposer');
    }

    await tick();

    return {
        rt,
        dispose,
        created: dom.created,
        requests,
        strings: mounts.log.flatMap((entry) => {
            const { props } = entry;
            if (typeof props === 'string') {
                return [props];
            }

            if (typeof props !== 'object' || props === null) {
                return [];
            }

            return Object.values(props).filter((value): value is string => typeof value === 'string');
        }),
    };
}

/**
 * Answer the health route and the status read; anything else keeps the
 * neutral 404.
 *
 * @param request - The request the tab made.
 * @returns The answer for that path.
 */
function healthyService(request: GuestRequest): GuestRequestResult {
    if (request.path === HEALTH_PATH) {
        return { status: 200, body: HEALTH_BODY };
    }

    if (request.path === '/v1/status') {
        return { status: 200, body: STATUS_BODY };
    }

    return { status: DEFAULT_STATUS, body: DEFAULT_BODY };
}

/**
 * Read every ledger line a render produced.
 *
 * @param strings - Every string the SDK mounts were handed.
 * @returns The lines that describe ledger entries.
 */
function ledgerRowsIn(strings: readonly string[]): readonly string[] {
    return strings.filter((text) => text.startsWith('#'));
}

/**
 * The titles of the list the last mount rendered — the vocabulary mapping.
 *
 * `view.strings` reads only the **top-level** string props of a mount, and a
 * list's titles live one level down inside `items`, so they need their own
 * read.
 *
 * @returns The entries in paint order.
 */
function mountedVocabulary(): readonly string[] {
    const last = mounts.log.filter((entry) => entry.key === 'mountList').at(-1);
    if (last === undefined) {
        return [];
    }

    const props = last.props as { readonly items?: readonly { readonly title?: string }[] };

    return (props.items ?? []).map((item) => item.title ?? '');
}

/** Correlation id the ledger fixtures carry. */
const CORRELATION = 'mt-correlation';

/** An identity ledger entry carrying the identifier About must not show. */
function identityEntry(): LedgerEntry {
    return {
        seq: 1,
        at: STAMP,
        correlationId: CORRELATION,
        panelGeneration: 1,
        kind: 'identity',
        detail: { authenticatedLogin: 'octocat-secret', problem: 'expected login differs' },
    };
}

/** A phase ledger entry, the record Diagnostics renders (FR-075). */
function phaseEntry(): LedgerEntry {
    return {
        seq: 2,
        at: STAMP,
        correlationId: CORRELATION,
        panelGeneration: 1,
        kind: 'phase',
        phase: 'mounted',
        detail: { phase: 'mounted', note: '' },
    };
}

describe('the version has exactly one source (FR-074, AC-133, SC-109)', () => {
    it('reads the route the service registers, not a name prose invented (T-036)', () => {
        expect(HEALTH_PATH).toBe(healthRoute.path);
        expect(HEALTH_PATH).toBe('/health');
    });

    it('has the prose naming that same route in every document that claims it (T-036)', () => {
        const claimed: readonly string[] = [
            'specs/005-panel-ia/spec.md',
            'specs/005-panel-ia/contracts/about-version.md',
            'AGENTS.md',
        ];

        for (const doc of claimed) {
            const text = readFileSync(resolve(import.meta.dirname, '..', doc), 'utf8');
            expect(text, `${doc} still claims a route the service never registers`).not.toContain('/v1/health');
            expect(text, `${doc} does not name the registered route`).toContain('/health');
        }
    });

    it('shows exactly the version the service answered (AC-133)', async () => {
        const view = await mountAbout({ answer: healthyService });
        const manifestPath = resolve(import.meta.dirname, '../package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { readonly version: string };

        expect(view.strings).toContain(`Version: ${SERVICE_VERSION}`);
        expect(SERVICE_VERSION).toBe(manifest.version);
        expect(view.rt.state.aboutTab.version).toBe(SERVICE_VERSION);
        view.dispose();
    });

    it('declares no version-shaped literal anywhere in the panel source', () => {
        const files = readdirSync(resolve(import.meta.dirname, '../src'), { recursive: true })
            .map((entry) => `src/${String(entry)}`)
            .filter((path) => path.endsWith('.ts'))
            .concat('panel/main.ts');
        const offenders: string[] = [];

        for (const path of files) {
            const text = readFileSync(resolve(import.meta.dirname, `../${path}`), 'utf8')
                .split('\n')
                // Comment lines carry the SDK pin and the spec's own version
                // in prose; a *literal* the panel could render never does.
                .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
                .join('\n');
            for (const match of text.matchAll(new RegExp(VERSION_SHAPED, 'g'))) {
                offenders.push(`${path}: ${match[0]}`);
            }
        }

        expect(files.length).toBeGreaterThan(40);
        expect(offenders).toEqual([]);
    });

    it('reports *not yet read* before the first answer, and never a number', () => {
        expect(versionLine(unreadState())).toBe('Version: not yet read');
        expect(versionLine({ ...unreadState(), phase: 'loading' })).toBe('Version: not yet read');
    });
});

describe('an unreachable service keeps the static content (AC-132, AC-134, FR-078)', () => {
    it('prints the exact unreachable copy with no digit on the version line', async () => {
        const view = await mountAbout({
            answer: () => {
                throw new Error('connection refused');
            },
        });
        // The last paint is the one on screen; the first is the mount's own
        // "not yet read" placeholder (FR-013: a body paints what state it has).
        const version = view.strings.filter((text) => text.startsWith('Version: ')).at(-1);

        expect(version).toBe(UNREACHABLE);
        expect(version).not.toMatch(/\d/);
        expect(view.strings.join('\n')).not.toMatch(VERSION_SHAPED);
        view.dispose();
    });

    it('keeps every static statement and names what could not be read', async () => {
        const view = await mountAbout({
            answer: () => {
                throw new Error('connection refused');
            },
        });
        const text = view.strings.join('\n');

        expect(text).toContain('About');
        expect(text).toContain('Mecha Turk — panel id: mecha-turk');
        expect(text).toContain('Version source: the local service');
        expect(text).toContain('not read yet — the Status tab');
        // The mapping renders as its heading (one prose line) plus its list
        // entries — `view.strings` reads only the top-level string props of a
        // mount, and a list's titles live one level down inside `items`.
        expect(text).toContain(VOCABULARY_HEADING);
        expect(mountedVocabulary()).toEqual(VOCABULARY_ITEMS);
        // …and the two still reassemble the one constant byte for byte.
        expect([VOCABULARY_HEADING, ...VOCABULARY_ITEMS.map((entry) => `- ${entry}`)].join('\n'))
            .toBe(VOCABULARY_SHORT_FORM);
        expect(text).toContain('never removes them');
        expect(text).toContain("OpenChamber's own Sessions and Worktrees surfaces");
        expect(text).toContain('pre-release');
        expect(text).toContain('Diagnostics (read-only)');
        expect(text).toContain('Version could not be read: service unreachable');
        view.dispose();
    });
});

describe('the data directory comes from the status projection (FR-075, FR-076)', () => {
    it('shows the directory once the projection is held, and names it as what to back up', () => {
        const doc = parseStatusView(STATUS_BODY);
        expect(doc).not.toBeNull();

        const rt = createTestRuntime(fakeHost());
        rt.state.statusTab.doc = doc;

        expect(dataDirLine(rt)).toBe(`Data directory: ${DATA_DIR} — this is the directory to back up.`);
    });

    it('says plainly that it has not been read when no projection is held', () => {
        const rt = createTestRuntime(fakeHost());

        expect(dataDirLine(rt)).toContain('not read yet');
        expect(dataDirLine(rt)).not.toContain('/');
    });
});

describe('Diagnostics is read-only and credential-free (FR-075, FR-076, AC-129)', () => {
    it('renders the ledger as sequence, kind, and time — never entry detail', async () => {
        const view = await mountAbout({
            answer: healthyService,
            setup: (rt) => {
                rt.state.ledger.entries.push(identityEntry(), phaseEntry());
            },
        });
        // One text handle holds every line, so the last paint is the whole
        // block the operator reads (newest first).
        const rows = ledgerRowsIn(view.strings).at(-1);

        expect(rows).toBe(`#2 · phase: mounted · ${STAMP_TIME}\n#1 · identity · ${STAMP_TIME}`);
        const text = view.strings.join('\n');
        expect(text).not.toContain('octocat-secret');
        expect(text).not.toContain('expected login differs');
        expect(text).not.toContain(CORRELATION);
        view.dispose();
    });

    it('offers one display-only list, no select, and no control but the re-read (FR-084)', async () => {
        const view = await mountAbout({ answer: healthyService });
        const keys = mounts.log.map((entry) => entry.key);

        // Exactly one list — the vocabulary mapping — and its rows are
        // definitions, never a selection the tab acts on.
        expect(keys.filter((key) => key === 'mountList')).toHaveLength(1);
        expect(keys).not.toContain('mountSelect');
        expect(keys.filter((key) => key === 'mountButton')).toHaveLength(1);
        expect(view.created.map((element) => element.tagName)).not.toContain('input');
        view.dispose();
    });

    it('shows both schema versions and the phase record (FR-075)', async () => {
        const view = await mountAbout({
            answer: healthyService,
            setup: (rt) => {
                rt.state.ledger.entries.push(phaseEntry());
            },
        });
        const text = view.strings.join('\n');

        expect(text).toContain(`Evidence schema: ${EVIDENCE_SCHEMA_VERSION} · Ledger schema: spike-ledger-1`);
        expect(text).toContain(`Phase record: mounted at ${STAMP} — read-only; this tab writes nothing.`);
        view.dispose();
    });

    it('says there is no phase record and no ledger before this mount records one', () => {
        const rt = createTestRuntime(fakeHost());

        expect(phaseRecordLine(rt)).toBe('Phase record: none recorded yet.');
        expect(ledgerLines(rt)).toBe('No ledger entries yet.');
    });

    it('carries no credential-shaped value into the rendered strings', async () => {
        const token = `ghp_${'abouttab'.repeat(4)}`;
        const view = await mountAbout({
            answer: healthyService,
            setup: (rt) => {
                rt.state.ledger.entries.push({
                    ...identityEntry(),
                    detail: { authenticatedLogin: 'octocat', problem: token },
                });
            },
        });
        const text = view.strings.join('\n');

        expect(text).not.toContain(token);
        expect(findSecretLeak(text)).toBeNull();
        view.dispose();
    });
});

describe('the short vocabulary mapping ships with the tab (FR-029)', () => {
    it('renders the retired nouns as a mapping, not as the product\'s own words', () => {
        expect(VOCABULARY_SHORT_FORM).toContain('Dispatches');
        expect(VOCABULARY_SHORT_FORM).toContain('Bindings');
        expect(VOCABULARY_SHORT_FORM).toContain('earlier builds called it Runs');
        expect(VOCABULARY_SHORT_FORM).toContain('earlier builds called it Repositories');
    });
});
