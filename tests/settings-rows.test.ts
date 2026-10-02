/**
 * The Settings tab (005 T-027, superseded in part by 006 T-018; FR-014,
 * FR-022, FR-070 – FR-073, FR-078, FR-039; AC-101, AC-104, AC-106, SC-102).
 *
 * The suite has three halves now, and the middle one is the reason it exists
 * in this shape:
 *
 * 1. **The scan** (AC-106). 005's cross-check asserted that the panel's
 *    declaration matched the service's; 006 reversed it: the panel source
 *    contains **no** configuration literal at all, with exactly one
 *    documented exception (`DEFAULT_EXPECTED_AGENT`, pinned to
 *    `DEFAULT_CONFIG.expectedAgent`). The check is shown to bite by running
 *    the same rules over a pasted stand-in.
 * 2. **The rows** — built from the projection, eleven against an 006-only
 *    fixture and thirteen against the combined one, every row carrying name,
 *    unit-or-*none*, bounds-or-format, value, and the class words the service's
 *    class maps to (AC-101, SC-102, FR-014, FR-030).
 * 3. **The body** — still read-only, mounting exactly one control, keeping its
 *    static content when the service is unreachable, and releasing every handle
 *    it mounted (FR-070, FR-078, FR-017).
 *
 * Everything runs against the panel's own doubles: the SDK mounts are
 * recorded, the fake DOM creates elements, and `host.serviceRequest` answers
 * from the test. No live host, no token, no network (FR-086).
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { DEFAULT_CONFIG, LOG_LEVEL_VALUES, NUMERIC_BOUNDS } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { DEFAULT_EXPECTED_AGENT } from '../src/config.ts';
import { settingsRows } from '../src/settings-rows.ts';
import { emptyEdit } from '../src/settings-edit.ts';
import { parseConfigEnvelope } from '../src/settings-schema.ts';
import type { ConfigEnvelope, FieldDescriptor, TakeEffectClass } from '../src/settings-schema.ts';
import type { SettingsRow } from '../src/settings-rows.ts';
import { readStateLine } from '../src/settings-tab.ts';
import type { SettingsTabState } from '../src/settings-tab.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
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
                    dispose: (): void => {
                        mounts.log.push({ key: `${key}:dispose`, props: undefined });
                    },
                };
            };
        }
    }

    return stubbed;
});

/** Stamp the landed-read case reports. */
const STAMP = '2026-09-30T00:00:00.000Z';

/** Problem copy the failed-read cases report. */
const PROBLEM = 'service unreachable';

/** The picker callbacks the shell takes; none is exercised by this suite. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** The eleven fields 006 itself declares (FR-084, AC-101). */
const SPECS_006_FIELDS: readonly string[] = [
    'intervalMs',
    'logLevel',
    'overlapMs',
    'perPage',
    'retryMaxAttempts',
    'retryBaseMs',
    'retryMaxMs',
    'auditRetentionDays',
    'auditMaxEntries',
    'excerptRetentionDays',
    'expectedAgent',
];

/** Directory the zero-literals scan reads. */
const SRC_DIR = 'src';

/** One panel source file, read for the scan. */
interface PanelSource {
    /** File name, for a failure that should say where. */
    readonly name: string;
    /** File text, scanned as written (comments included). */
    readonly text: string;
}

/**
 * Read every panel source file once.
 *
 * @returns The files, in directory order.
 */
async function panelSources(): Promise<readonly PanelSource[]> {
    const entries = await readdir(SRC_DIR);
    const names = entries.filter((name) => name.endsWith('.ts')).sort();
    const sources: PanelSource[] = [];
    for (const name of names) {
        sources.push({ name, text: await readFile(join(SRC_DIR, name), 'utf8') });
    }

    return sources;
}

/** The declarations of every documented field name, for the attachment scan. */
const FIELD_NAMES: readonly string[] = Object.keys(DEFAULT_CONFIG);

/** Every class token the wire vocabulary carries (FR-030). */
const CLASS_TOKENS: readonly TakeEffectClass[] = [
    'immediate',
    'next-cycle',
    'next-dispatch',
    'restart',
    'none',
];

/** Lines of context the attachment scan looks at either side of a class token. */
const CLASS_WINDOW = 6;

/** Every unit phrase the service declares, quoted the way a copy would write it. */
const UNIT_LITERALS: readonly string[] = [...new Set(Object.values(NUMERIC_BOUNDS).map((bounds) => bounds.unit))];

/**
 * Report every configuration literal the scan looks for in one file.
 *
 * @param source - One panel source file.
 * @returns The literals found, by class (006 AC-106's five).
 */
function configurationLiteralsIn(source: PanelSource): {
    /** Unit phrases written as string literals. */
    readonly units: readonly string[];
    /** Declaration-shaped numerics: `min:` / `max:` / `defaultValue:` + a number. */
    readonly declarationNumbers: readonly string[];
    /** The level set's sentinel, which a copied enum would carry. */
    readonly levelSentinel: boolean;
    /** Default strings, by name (the allow-list keys off these). */
    readonly stringDefaults: readonly { readonly value: string; readonly line: number }[];
    /** Lines carrying a class token *and* a field name — a claim about a row. */
    readonly attachedClasses: readonly string[];
} {
    const lines = source.text.split('\n');
    const units = UNIT_LITERALS.filter((unit) => source.text.includes(`'${unit}'`));
    const declarationNumbers = [...source.text.matchAll(/\b(?:min|max|defaultValue)\s*:\s*[0-9]/g)].map(
        (match) => match[0],
    );
    const levelSentinel = source.text.includes("'debug'");
    const stringDefaults = lines
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter((line) => line.text.includes(`'${DEFAULT_CONFIG.expectedAgent}'`))
        .map((line) => ({ value: DEFAULT_CONFIG.expectedAgent, line: line.line }));
    const attachedClasses = lines.flatMap((line, index) => {
        if (!CLASS_TOKENS.some((token) => line.includes(`'${token}'`))) {
            return [];
        }

        // A declaration is a block, not a line: 005's own stand-in spread a
        // field, its bounds, and its class over a dozen lines, so the scan
        // looks at the window around the token rather than the token's line.
        const window = lines.slice(Math.max(0, index - CLASS_WINDOW), index + CLASS_WINDOW + 1).join('\n');

        return FIELD_NAMES.some((name) => window.includes(`'${name}'`)) ? [line] : [];
    });

    return { units, declarationNumbers, levelSentinel, stringDefaults, attachedClasses };
}

/**
 * A pasted stand-in: the shape 005's retired declaration had, which every
 * rule above must flag (a check that cannot fail is not a check).
 *
 * @returns One source file's worth of the old `SETTINGS_FIELDS` entry.
 */
function standInSnippet(): PanelSource {
    return {
        name: 'pasted-stand-in.ts',
        text: [
            'export const SETTINGS_FIELDS = [{',
            "    field: 'intervalMs',",
            '    bounds: { min: 15_000, max: 300_000 },',
            "    unit: 'milliseconds',",
            '    defaultValue: 60_000,',
            "    effect: 'next-cycle',",
            "    values: ['debug', 'info'],",
            "    { field: 'expectedAgent', defaultValue: 'project-manager' },",
            "    takeEffect: 'No effect in this build: nothing reads it.',",
            '}];',
        ].join('\n'),
    };
}

/**
 * Build a `GET /v1/config` body the way the service sends it.
 *
 * @param input - Members to replace; the defaults are the combined tree.
 * @returns The response body.
 */
function envelopeBody(input: {
    /** Members to merge into the document; `null` replaces it outright. */
    readonly config?: Record<string, unknown>;
    /** The descriptor list. */
    readonly fields?: readonly FieldDescriptor[];
    /** The source member. */
    readonly source?: string;
    /** The filled-keys list. */
    readonly defaultsApplied?: readonly string[];
} = {}): string {
    return JSON.stringify({
        config: input.config ?? { ...DEFAULT_CONFIG },
        fields: input.fields ?? configSchema(),
        source: input.source ?? 'stored',
        defaultsApplied: input.defaultsApplied ?? [],
    });
}

/**
 * Whether a field name is one of the eleven 006 itself declares (AC-101).
 *
 * @param name - Document member name.
 * @returns `true` for 006's own fields.
 */
function isSpecs006Field(name: string): boolean {
    return SPECS_006_FIELDS.includes(name);
}

/**
 * The eleven-field projection and document 006 itself declares (AC-101).
 *
 * @returns The envelope a build carrying only 006's fields answers with.
 */
function specs006OnlyEnvelope(): ConfigEnvelope {
    const config: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(DEFAULT_CONFIG)) {
        if (isSpecs006Field(name)) {
            config[name] = value;
        }
    }

    const parsed = parseConfigEnvelope(
        envelopeBody({
            config,
            fields: configSchema().filter((descriptor) => isSpecs006Field(descriptor.name)),
        }),
    );
    if (parsed === null) {
        throw new Error('the 006-only fixture did not parse');
    }

    return parsed;
}

/**
 * Read an envelope, failing the test when the body is not one.
 *
 * @param body - Response body text.
 * @returns The envelope.
 */
function envelopeFor(body: string): ConfigEnvelope {
    const envelope = parseConfigEnvelope(body);
    if (envelope === null) {
        throw new Error(`${body.slice(0, 120)} did not parse as an envelope`);
    }

    return envelope;
}

/**
 * The phrase a row must carry for one declared class (FR-030).
 *
 * The words this assertion looks for, spelled here rather than read back out
 * of the panel module — a test that imports the string it asserts would pass
 * no matter what the panel printed. `restart` and `none` answer `''` because
 * no field in this feature declares them; if one ever did, this is the line
 * that would have to grow with it.
 *
 * @param takesEffect - The class the service declared.
 * @returns The phrase the row must contain.
 */
function classWords(takesEffect: TakeEffectClass): string {
    if (takesEffect === 'next-cycle') {
        return 'in effect from the next poll';
    }

    if (takesEffect === 'immediate') {
        return 'takes effect immediately';
    }

    if (takesEffect === 'next-dispatch') {
        return 'in effect from the next dispatch';
    }

    return '';
}

/** The combined-tree envelope, the one the service in this repo answers with. */
function combinedEnvelope(): ConfigEnvelope {
    return envelopeFor(envelopeBody());
}

/**
 * Build the rows a body produces.
 *
 * @param body - Response body text.
 * @returns The rows, in paint order.
 */
function rowsFor(body: string): readonly SettingsRow[] {
    return settingsRows(envelopeFor(body));
}

/**
 * Read every row line a render produced.
 *
 * @param strings - Every string the SDK mounts were handed.
 * @returns The row lines, in paint order.
 */
function renderedRows(strings: readonly string[]): readonly string[] {
    return strings.filter((text) => /^[a-z][A-Za-z0-9]*: (?:unreadable|[0-9a-z])/.test(text));
}

/** What one mount of the Settings body recorded. */
interface SettingsMount {
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
 * Mount only the Settings body against the recording SDK stub.
 *
 * @param input - How the service should answer, and state to arrange first.
 * @returns The runtime, the disposer, and everything the render recorded.
 */
async function mountSettings(input: {
    /** Answers for `host.serviceRequest`; defaults to the neutral 404. */
    readonly answer?: (request: GuestRequest) => GuestRequestResult | Promise<GuestRequestResult>;
    /** State to arrange before the body mounts. */
    readonly setup?: (rt: PanelRuntime) => void;
}): Promise<SettingsMount> {
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
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'settings');
    if (spec === undefined) {
        throw new Error('the Settings tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the Settings body mounted no disposer');
    }

    // The mount fires the tab's one read; a macrotask is enough for it to
    // land, exactly as the other tab suites settle their reads.
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
 * Build an answer for a successful `GET /v1/config`.
 *
 * @param body - Response body text.
 * @returns The answer, or `undefined` for any other path.
 */
function configAnswer(body: string): (request: GuestRequest) => GuestRequestResult {
    return (request) =>
        request.path === '/v1/config' ? { status: 200, body } : { status: DEFAULT_STATUS, body: DEFAULT_BODY };
}

/**
 * Build a Settings read state with only the members a case changes.
 *
 * @param overrides - Members to replace.
 * @returns A complete Settings read state.
 */
function settingsSlice(overrides: Partial<SettingsTabState> = {}): SettingsTabState {
    return { phase: 'idle', at: null, problem: null, stale: false, doc: null, edit: emptyEdit(), ...overrides };
}

describe('the panel source carries no configuration literal (006 AC-106)', () => {
    it('carries no unit phrase, no declaration-shaped bound, and no level set', async () => {
        const sources = await panelSources();
        const offending = sources.filter((source) => {
            const found = configurationLiteralsIn(source);

            return found.units.length > 0 || found.declarationNumbers.length > 0 || found.levelSentinel;
        });

        expect(offending.map((source) => source.name)).toEqual([]);
    });

    it('carries the single documented default exception, pinned to the service default', async () => {
        const sources = await panelSources();
        const occurrences = sources.flatMap((source) =>
            configurationLiteralsIn(source).stringDefaults.map((entry) => ({ file: source.name, line: entry.line })),);

        // Exactly one entry in the allow-list, and it is the pinned constant
        // plan X7 records (research Q3's ruling): the verification baseline
        // that has to exist before the first successful config read.
        expect(occurrences).toHaveLength(1);
        expect(occurrences[0]?.file).toBe('config.ts');
        expect(DEFAULT_EXPECTED_AGENT).toBe(DEFAULT_CONFIG.expectedAgent);
    });

    it('never attaches a take-effect class to a field', async () => {
        const sources = await panelSources();
        const offending = sources.filter((source) => configurationLiteralsIn(source).attachedClasses.length > 0);

        expect(offending.map((source) => source.name)).toEqual([]);
    });

    it('never claims a value changes nothing in this build', async () => {
        const sources = await panelSources();
        const forbidden = /changes nothing in this build|no effect in this build/i;
        const offending = sources.filter((source) => forbidden.test(source.text));

        expect(offending.map((source) => source.name)).toEqual([]);
        // The declaration 005 retired is gone with it: nothing in `src/` still
        // answers to the old `SETTINGS_FIELDS` name, so no second source of
        // truth can be mistaken for the projection.
        expect(sources.filter((source) => source.text.includes('SETTINGS_FIELDS'))).toEqual([]);
    });

    it('bites: every rule flags a pasted stand-in', () => {
        const found = configurationLiteralsIn(standInSnippet());

        expect(found.units).toEqual(['milliseconds']);
        expect(found.declarationNumbers.length).toBeGreaterThan(0);
        expect(found.levelSentinel).toBe(true);
        expect(found.stringDefaults).toHaveLength(1);
        expect(found.attachedClasses.length).toBeGreaterThan(0);
    });
});

describe('rows are built from the projection (006 T-018, AC-101, SC-102)', () => {
    it('renders eleven rows against the 006-only fixture and thirteen against the combined one', () => {
        expect(settingsRows(specs006OnlyEnvelope())).toHaveLength(SPECS_006_FIELDS.length);
        const combined = settingsRows(combinedEnvelope());
        expect(combined).toHaveLength(configSchema().length);
        // The count is derived, never asserted from a literal: it follows the
        // projection, which is what lets 003's two fields arrive untouched.
        expect(combined.length).toBe(Object.keys(DEFAULT_CONFIG).length);
    });

    it('gives every one of 006\'s eleven fields its five attributes', () => {
        const envelope = combinedEnvelope();
        const rows = settingsRows(envelope);
        expect(rows).toHaveLength(configSchema().length);

        for (const name of SPECS_006_FIELDS) {
            const descriptor = envelope.fields.find((candidate) => candidate.name === name);
            expect(descriptor, `${name} is missing from the projection`).toBeDefined();
            const row = rows.find((candidate) => candidate.field === name);
            expect(row, `${name} rendered no row`).toBeDefined();

            // 1. the documented name, 2. its value as the document holds it.
            expect(row?.text.startsWith(`${name}: `)).toBe(true);
            expect(row?.text).toContain(String(envelope.config[name]));

            // 3. unit-or-none and 4. bounds-or-format, both from the wire.
            if (descriptor?.kind === 'integer') {
                expect(row?.text).toContain(descriptor.unit);
                expect(row?.text).toContain(`bounds ${descriptor.min}–${descriptor.max}`);
            } else if (descriptor?.kind === 'enum') {
                expect(row?.text).toContain(`accepted: ${descriptor.values.join(', ')}`);
            } else if (descriptor !== undefined) {
                expect(row?.text).toContain(`format: ${descriptor.format}`);
            }

            // 5. the class, in the product's words, and the declared default.
            const words = descriptor === undefined ? '' : classWords(descriptor.takesEffect);
            expect(row?.text).toContain(words);
            expect(row?.text).toContain(`default ${String(descriptor?.default)}`);
        }
    });

    it('marks a row the stored document lacked as default, not as configured', () => {
        const envelope = envelopeFor(envelopeBody({ defaultsApplied: ['expectedAgent'] }));
        const row = settingsRows(envelope).find((candidate) => candidate.field === 'expectedAgent');

        expect(row?.text).toContain(`default ${DEFAULT_CONFIG.expectedAgent}`);
    });

    it('renders an unreadable value with its remediation and never a default (AC-116)', () => {
        const rows = rowsFor(envelopeBody({ config: { intervalMs: 'soon', perPage: 12 } }));
        const interval = rows.find((row) => row.field === 'intervalMs');

        expect(interval?.text).toContain(
            `set intervalMs to an integer between ${NUMERIC_BOUNDS.intervalMs.min}` +
                ` and ${NUMERIC_BOUNDS.intervalMs.max} ${NUMERIC_BOUNDS.intervalMs.unit}`,
        );
        // Never a default dressed as a configured value (FR-028, NFR-112).
        expect(interval?.text).not.toContain(`${DEFAULT_CONFIG.intervalMs}`);
        expect(interval?.text).not.toContain('default');
        // The field beside it still renders — one bad field hides nothing.
        expect(rows.find((row) => row.field === 'perPage')?.text).toContain('bounds 1–30');
    });

    it('renders a member with no descriptor as this version not showing it (AC-115)', () => {
        const rows = rowsFor(
            envelopeBody({ config: { ...DEFAULT_CONFIG, expectedAgent: 'other-agent' }, fields: [] }),
        );

        expect(rows.map((row) => row.field)).toEqual(Object.keys(DEFAULT_CONFIG));
        expect(rows.every((row) => row.text.includes('field this version does not show'))).toBe(true);
        // It borrows no bound and promises no effect (FR-027).
        const agent = rows.find((row) => row.field === 'expectedAgent');
        expect(agent?.text).toContain('other-agent');
        expect(agent?.text).not.toContain('bounds');
    });
});

describe('the Settings body mounts editable controls (006 T-020, FR-010, FR-014)', () => {
    it('mounts one control per declared field, named with its unit and boundary', async () => {
        const view = await mountSettings({ answer: configAnswer(envelopeBody()) });
        const controls = mounts.log.filter(
            (entry) => entry.key === 'mountTextField' || entry.key === 'mountSelect',
        );

        expect(controls).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        const interval = controls.find((entry) => {
            const { label } = entry.props as { readonly label?: string };

            return label === undefined ? false : label.startsWith('intervalMs');
        });
        expect(interval).toBeDefined();
        const { label } = (interval?.props as { readonly label: string });
        // The accessible name carries the unit and the boundary (FR-018, FR-039).
        expect(label).toContain(NUMERIC_BOUNDS.intervalMs.unit);
        // The affordance carries bounds and the default — and gates nothing
        // (FR-023: these shape the control and the hint and nothing else).
        const { helper } = (interval?.props as { readonly helper: string });
        expect(helper).toContain(`bounds ${NUMERIC_BOUNDS.intervalMs.min}–${NUMERIC_BOUNDS.intervalMs.max}`);
        expect(helper).toContain(`default ${DEFAULT_CONFIG.intervalMs}`);
        expect((interval?.props as { readonly value: string }).value).toBe(String(DEFAULT_CONFIG.intervalMs));
        const level = controls.find((entry) => entry.key === 'mountSelect');
        expect((level?.props as { readonly options: readonly { readonly id: string }[] }).options.map(
            (option) => option.id,
        )).toEqual([...LOG_LEVEL_VALUES]);
        view.dispose();
    });

    it('gives an undocumented member a line, and no affordance at all (AC-115)', async () => {
        const view = await mountSettings({
            answer: configAnswer(envelopeBody({ config: { ...DEFAULT_CONFIG, surprise: 1 } })),
        });
        const controls = mounts.log.filter(
            (entry) => entry.key === 'mountTextField' || entry.key === 'mountSelect',
        );

        expect(controls).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        expect(renderedRows(view.strings).some((row) => row.includes('field this version does not show'))).toBe(true);
        view.dispose();
    });

    it('says what a save will do while one is possible (FR-045)', async () => {
        const view = await mountSettings({ answer: configAnswer(envelopeBody()) });

        // The read control plus the save bar's four: save, discard, restore,
        // and Cancel — which mounts hidden and appears only once something is
        // armed (006 FR-054), so an unarmed tab never offers it.
        expect(mounts.log.filter((entry) => entry.key === 'mountButton')).toHaveLength(5);
        expect(view.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /v1/config']);
        view.dispose();
    });

    it('AC-132: with the service unreachable, keeps static content and names the cause', async () => {
        const view = await mountSettings({
            answer: () => {
                throw new Error('connection refused');
            },
        });
        const text = view.strings.join('\n');

        expect(text).toContain('Settings');
        expect(text).toContain('GET /v1/config did not answer');
        expect(renderedRows(view.strings)).toEqual([]);
        view.dispose();
    });

    it('reads twice and never writes: the re-read is a read (FR-014, NFR-104)', async () => {
        const view = await mountSettings({ answer: configAnswer(envelopeBody()) });
        expect(view.requests).toHaveLength(1);

        const button = mounts.log.find(
            (entry) => entry.key === 'mountButton'
                && (entry.props as { readonly label?: string }).label === 'Refresh configuration',
        );
        expect(button).toBeDefined();
        (button?.props as { readonly onClick: () => void }).onClick();
        await tick();

        expect(view.requests).toHaveLength(2);
        expect(view.requests.every((request) => request.method === 'GET')).toBe(true);
        view.dispose();
    });

    it('keeps the configured value for itself: the Status slice stays untouched (FR-039)', async () => {
        const view = await mountSettings({ answer: configAnswer(envelopeBody()) });

        expect(view.rt.state.settingsTab.phase).toBe('loaded');
        expect(view.rt.state.statusTab.phase).toBe('idle');
        expect(view.rt.state.statusTab.configuredIntervalMs).toBeNull();
        expect(view.rt.state.settingsTab.doc?.fields).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        view.dispose();
    });

    it('releases every handle it mounted, and leaves no slot behind (FR-017)', async () => {
        const view = await mountSettings({ answer: configAnswer(envelopeBody()) });
        const mounted = mounts.log
            .filter((entry) => entry.key.startsWith('mount') && !entry.key.includes(':'))
            .length;

        view.dispose();

        const disposed = mounts.log.filter((entry) => entry.key.endsWith(':dispose')).length;
        expect(mounted).toBeGreaterThan(0);
        expect(disposed).toBe(mounted);
        expect(view.rt.settingsUi).toBeNull();
    });
});

describe('the read-state line speaks in FR-019\'s three shapes', () => {
    it('reports idle, loading, landed, failed, and stale', () => {
        expect(readStateLine(settingsSlice({ phase: 'loaded', at: STAMP }))).toContain(`read at ${STAMP}`);
        expect(readStateLine(settingsSlice({ phase: 'failed', problem: PROBLEM })))
            .toContain('Nothing has been read yet');
        expect(readStateLine(settingsSlice({ phase: 'failed', at: STAMP, problem: PROBLEM, stale: true })))
            .toContain('may be stale');
    });
});
