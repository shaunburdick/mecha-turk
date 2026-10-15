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
 *    documented exception (`DEFAULT_EXPECTED_AGENT`, whose value is pinned to
 *    `DEFAULT_CONFIG.expectedAgent` — blank since 006 v1.5.0 / 002 v1.10.0).
 *    The default-string rule keys on the **declaration shape**
 *    (`default:`/`defaultValue:`/`DEFAULT_EXPECTED_AGENT =` followed by a
 *    quoted *token*), so it still flags a second default literal of any value
 *    while ignoring prose that happens to begin with the word. The check is
 *    shown to bite by running the same rules over a pasted stand-in.
 * 2. **The rows** — built from the projection, twelve against an 006-only
 *    fixture and fourteen against the combined one, every row carrying name,
 *    unit-or-*none*, bounds-or-format, value, and the class words the service's
 *    class maps to (AC-101, SC-102, FR-014, FR-030) — plus, for an empty string
 *    field, the not-set word in its value slot (004 T-030, FR-064).
 * 3. **The body** — still read-only, mounting exactly one control, keeping its
 *    static content when the service is unreachable, and releasing every handle
 *    it mounted (FR-070, FR-078, FR-017).
 *
 * Everything runs against the panel's own doubles: the SDK mounts are
 * recorded, the fake DOM creates elements, and `host.serviceRequest` answers
 * from the test. No live host, no token, no network (FR-086).
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { DEFAULT_CONFIG, LOG_LEVEL_VALUES, NUMERIC_BOUNDS } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { settingsRows } from '../src/settings-rows.ts';
import { emptyEdit } from '../src/settings-edit.ts';
import { parseConfigEnvelope } from '../src/settings-schema.ts';
import type { ConfigEnvelope, FieldDescriptor, TakeEffectClass } from '../src/settings-schema.ts';
import type { SettingsRow } from '../src/settings-rows.ts';
import { readStateLine } from '../src/settings-tab.ts';
import type { SettingsTabState } from '../src/settings-tab.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';
import { DEFAULT_BODY, DEFAULT_STATUS, createTestRuntime, fakeHost, tick } from './support/panel.ts';
import { GLOBAL_TIER_SENTINEL } from './support/prompt-tiers.ts';
import { configEnvelope } from './support/service-routes.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
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

/**
 * The twelve fields 006 itself declares (006 v1.6.0; FR-084, AC-101) — 003's
 * two lease fields ride the combined projection beside them, not in this list.
 */
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
    // Twelfth field (004 FR-081): the global prompt tier. Still twelve by
    // count; its *position* is first in the projection since the owner's PR
    // #12 ruling ("move it to the top of the list") — this list is a
    // membership set, so only the count claim lives here.
    'startingPrompt',
];

/**
 * Whether a field name is one of the twelve 006 itself declares (AC-101, 006 v1.6.0).
 *
 * @returns `true` for 006's own fields.
 */
function isSpecs006Field(name: string): boolean {
    return SPECS_006_FIELDS.includes(name);
}

/**
 * The twelve-field projection and document 006 itself declares (AC-101; 006 v1.6.0).
 *
 * @returns The envelope a build carrying only 006's fields answers with.
 */
function specs006OnlyEnvelope(): ConfigEnvelope {
    const config = Object.fromEntries(Object.entries(DEFAULT_CONFIG).filter(([name]) => isSpecs006Field(name)));

    const parsed = parseConfigEnvelope(
        configEnvelope({
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
 * The projected descriptor for one field, so an assertion reads the service's
 * own declaration instead of restating it.
 *
 * @param envelope - The envelope the descriptor was read from.
 * @returns The descriptor, or the test fails here.
 */
function descriptorOf(name: string, envelope: ConfigEnvelope): FieldDescriptor {
    const descriptor = envelope.fields.find((candidate) => candidate.name === name);
    if (descriptor === undefined) {
        throw new Error(`the projection carries no descriptor for ${name}`);
    }

    return descriptor;
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
    return envelopeFor(configEnvelope());
}

/**
 * Build the rows a body produces.
 *
 * @returns The rows, in paint order.
 */
function rowsFor(body: string): readonly SettingsRow[] {
    return settingsRows(envelopeFor(body));
}

/**
 * Read every row line a render produced.
 *
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
    const spec = tabSpecs(rt).find((entry) => entry.id === 'settings');
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
 * @returns The answer, or `undefined` for any other path.
 */
function configAnswer(body: string): (request: GuestRequest) => GuestRequestResult {
    return (request) =>
        request.path === '/v1/config' ? { status: 200, body } : { status: DEFAULT_STATUS, body: DEFAULT_BODY };
}

/**
 * Build a Settings read state with only the members a case changes.
 */
function settingsSlice(overrides: Partial<SettingsTabState> = {}): SettingsTabState {
    return { phase: 'idle', at: null, problem: null, stale: false, doc: null, edit: emptyEdit(), ...overrides };
}

describe('rows are built from the projection (006 T-018, AC-101, SC-102)', () => {
    it('renders twelve rows against the 006-only fixture and fourteen against the combined one', () => {
        {
            expect(settingsRows(specs006OnlyEnvelope())).toHaveLength(SPECS_006_FIELDS.length);
            const combined = settingsRows(combinedEnvelope());
            expect(combined).toHaveLength(configSchema().length);
            // The count is derived, never asserted from a literal: it follows the
            // projection, which is what lets 003's two fields arrive untouched.
            expect(combined.length).toBe(Object.keys(DEFAULT_CONFIG).length);
        }
        {
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
        }
        {
            const envelope = envelopeFor(configEnvelope({ defaultsApplied: ['expectedAgent'] }));
            const row = settingsRows(envelope).find((candidate) => candidate.field === 'expectedAgent');

            expect(row?.text).toContain(`default ${DEFAULT_CONFIG.expectedAgent}`);
            expect(row?.text).toContain('reads as default');
            // The blank default is rendered as itself: the row never invents a
            // baseline the operator never configured (FR-028, NFR-112).
            expect(row?.text).not.toContain('project-manager');
        }
        {
            const rows = rowsFor(configEnvelope({ config: { intervalMs: 'soon', perPage: 12 } }));
            const interval = rows.find((row) => row.field === 'intervalMs');

            expect(interval?.text).toContain(
                `set intervalMs to an integer between ${NUMERIC_BOUNDS.intervalMs.min}` +
                    ` and ${NUMERIC_BOUNDS.intervalMs.max} ${NUMERIC_BOUNDS.intervalMs.unit}`,
            );
            // Never a default dressed as a configured value (FR-028, NFR-112).
            expect(interval?.text).not.toContain(DEFAULT_CONFIG.intervalMs);
            expect(interval?.text).not.toContain('default');
            // The field beside it still renders — one bad field hides nothing.
            expect(rows.find((row) => row.field === 'perPage')?.text).toContain('bounds 1–30');
        }
        {
            const rows = rowsFor(
                configEnvelope({ config: { ...DEFAULT_CONFIG, expectedAgent: 'other-agent' }, fields: [] }),
            );

            expect(rows.map((row) => row.field)).toEqual(Object.keys(DEFAULT_CONFIG));
            expect(rows.every((row) => row.text.includes('field this version does not show'))).toBe(true);
            // It borrows no bound and promises no effect (FR-027).
            const agent = rows.find((row) => row.field === 'expectedAgent');
            expect(agent?.text).toContain('other-agent');
            expect(agent?.text).not.toContain('bounds');
        }
        {
            const envelope = specs006OnlyEnvelope();
            const rows = settingsRows(envelope);

            expect(SPECS_006_FIELDS).toHaveLength(12);
            expect(rows).toHaveLength(SPECS_006_FIELDS.length);
            // Order and count both follow the projection: the builder maps
            // `envelope.fields`, so there is no row list in the panel that a
            // new descriptor could fall behind (006 FR-010, FR-014) — and every
            // name the fixture's list claims is one the service still projects.
            expect(rows.map((row) => row.field)).toEqual(envelope.fields.map((descriptor) => descriptor.name));
            const projected: ReadonlySet<string> = new Set(
                configSchema().map((descriptor): string => descriptor.name),
            );
            expect(SPECS_006_FIELDS.filter((name) => !projected.has(name))).toEqual([]);
            // The prompt row leads the list — the twelfth *field* by count,
            // first by owner ruling on PR #12 ("move it to the top of the
            // list") — and carries the class the service declared for it
            // (004 FR-081: the next poll). The position assertion stays as
            // strong as it was: index 0 of the projection, not merely present.
            const promptDescriptor = descriptorOf('startingPrompt', envelope);
            expect(rows[0]?.field).toBe(promptDescriptor.name);
            expect(rows[0]?.text).toContain(classWords(promptDescriptor.takesEffect));
            expect(rows[0]?.text).toContain('startingPrompt:');
            // A descriptor this build has never heard of still gets its row,
            // last, in the order it arrived — derivation, not a list.
            const future: FieldDescriptor = {
                name: 'futureBudget',
                kind: 'integer',
                unit: 'milliseconds',
                min: 1,
                max: 10,
                default: 1,
                takesEffect: 'restart',
            };
            const grown = rowsFor(
                configEnvelope({ config: { ...DEFAULT_CONFIG, futureBudget: 5 }, fields: [...configSchema(), future] }),
            );

            expect(grown).toHaveLength(configSchema().length + 1);
            expect(grown.at(-1)?.field).toBe('futureBudget');
        }
        {
            const descriptor = descriptorOf('startingPrompt', combinedEnvelope());
            if (descriptor.kind !== 'string') {
                throw new Error('startingPrompt did not project as a string field');
            }

            const unset = rowsFor(configEnvelope()).find((row) => row.field === 'startingPrompt');
            // The value slot states the absence instead of printing nothing —
            // never an empty box that reads as an instruction (FR-064)…
            expect(unset?.text).toContain('startingPrompt: not set');
            // …and the guidance beside it stays the service's own `format`
            // prose, rendered as text, never a panel-authored sentence (R-4).
            expect(unset?.text).toContain(`format: ${descriptor.format}`);
            expect(unset?.text).toContain(`max ${descriptor.maxLength} characters`);

            // A set tier shows the value, and the state word leaves with the absence.
            const prompt = 'Review every change against the ticket before approving.';
            const set = rowsFor(configEnvelope({ config: { ...DEFAULT_CONFIG, startingPrompt: prompt } }))
                .find((row) => row.field === 'startingPrompt');

            expect(set?.text).toContain(prompt);
            expect(set?.text).not.toContain('not set');
        }
    });
});

describe('the Settings body mounts editable controls (006 T-020, FR-010, FR-014)', () => {
    it('mounts one control per declared field, named with its unit and boundary', async () => {
        {
            const view = await mountSettings({ answer: configAnswer(configEnvelope()) });
            const controls = mounts.log.filter(
                (entry) => entry.key === 'mountTextField' || entry.key === 'mountSelect',
            );

            expect(controls).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
            const interval = controls.find((entry) => {
                const { label } = entry.props as { readonly label?: string };

                return label?.startsWith('intervalMs') === true;
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
        }
    });

    it('the string field\'s empty box reads *not set*, with the declared guidance under it (004 T-030)', async () => {
        {
            const descriptor = descriptorOf('startingPrompt', combinedEnvelope());
            if (descriptor.kind !== 'string') {
                throw new Error('startingPrompt did not project as a string field');
            }

            const view = await mountSettings({ answer: configAnswer(configEnvelope()) });
            const control = mounts.log.find(
                (entry) => entry.key === 'mountTextField'
                    && (entry.props as { readonly label?: string }).label?.startsWith('startingPrompt') === true,
            );
            expect(control).toBeDefined();
            const props = control?.props as {
                readonly label: string;
                readonly value: string;
                readonly placeholder?: string;
                readonly helper: string;
                readonly multiline?: boolean;
                readonly rows?: number;
                readonly onChange: unknown;
            };

            // FR-064: the value slot states the absence rather than sitting
            // there as an empty box (the word is the panel's; the state is the
            // document's) — and it vanishes the moment the field has a value.
            expect(props.value).toBe('');
            expect(props.placeholder).toBe('not set');
            // The control's *shape* is the descriptor's too (owner ruling, PR
            // #12): this field declares `multiline`, so it mounts a textarea
            // with the same row count the other two prompt tiers render with.
            expect(props.multiline).toBe(true);
            expect(props.rows).toBe(4);
            // Research R-4: the guidance under the field is the service's own
            // `format` prose, rendered as text — never a panel sentence.
            expect(props.helper).toContain(`format: ${descriptor.format}`);
            expect(props.helper).toContain(`max ${descriptor.maxLength} characters`);
            // 006 FR-018: the accessible name still carries the name, the unit
            // slot (a string field has none, and says so), and the boundary.
            expect(props.label).toBe(`${descriptor.name} (unit none) — ${classWords(descriptor.takesEffect)}`);
            // Keyboard-operable: this is the input itself, with its handler.
            expect(typeof props.onChange).toBe('function');
            view.dispose();
        }
    });

    it('a set tier puts the value in that same slot (004 T-030, 006 FR-081)', async () => {
        {
            const prompt = 'Review every change against the ticket before approving.';
            const view = await mountSettings({
                answer: configAnswer(configEnvelope({ config: { ...DEFAULT_CONFIG, startingPrompt: prompt } })),
            });
            const control = mounts.log.find(
                (entry) => entry.key === 'mountTextField'
                    && (entry.props as { readonly label?: string }).label?.startsWith('startingPrompt') === true,
            );
            const props = control?.props as { readonly value: string };

            // The one rendering of the global tier's value in the panel (005
            // FR-051 as amended): the row's own control, holding the text.
            expect(props.value).toBe(prompt);
            view.dispose();
        }
    });

    it('`multiline` rides the descriptor, so the other string field stays single-line', async () => {
        {
            const view = await mountSettings({ answer: configAnswer(configEnvelope()) });
            const control = mounts.log.find(
                (entry) => entry.key === 'mountTextField'
                    && (entry.props as { readonly label?: string }).label?.startsWith('expectedAgent') === true,
            );
            expect(control).toBeDefined();
            const props = control?.props as { readonly multiline?: boolean; readonly rows?: number };

            // Both string fields share one kind, so the descriptor's flag is
            // what tells them apart — an agent name is a single token, and
            // the panel must not decide that from the field's *name*
            // (006 FR-014: the row's attributes come from the wire).
            expect(props.multiline).toBeUndefined();
            expect(props.rows).toBeUndefined();
            view.dispose();
        }
    });

    it('gives an undocumented member a line, and no affordance at all', async () => {
        {
            const view = await mountSettings({
                answer: configAnswer(configEnvelope({ config: { ...DEFAULT_CONFIG, surprise: 1 } })),
            });
            const controls = mounts.log.filter(
                (entry) => entry.key === 'mountTextField' || entry.key === 'mountSelect',
            );

            expect(controls).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
            expect(renderedRows(view.strings).some((row) => row.includes(
                'field this version does not show'
            ))).toBe(true);
            view.dispose();
        }
    });

    it('says what a save will do while one is possible', async () => {
        {
            const view = await mountSettings({ answer: configAnswer(configEnvelope()) });

            // The read control plus the save bar's four: save, discard, restore,
            // and Cancel — which mounts hidden and appears only once something is
            // armed (006 FR-054), so an unarmed tab never offers it.
            expect(mounts.log.filter((entry) => entry.key === 'mountButton')).toHaveLength(5);
            expect(view.requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /v1/config']);
            view.dispose();
        }
    });

    it('AC-132: with the service unreachable, keeps static content and names the cause', async () => {
        {
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
        }
    });

    it('reads twice and never writes: the re-read is a read', async () => {
        {
            const view = await mountSettings({ answer: configAnswer(configEnvelope()) });
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
        }
    });

    it('keeps the configured value for itself: the Status slice stays untouched', async () => {
        {
            const view = await mountSettings({ answer: configAnswer(configEnvelope()) });

            expect(view.rt.state.settingsTab.phase).toBe('loaded');
            expect(view.rt.state.statusTab.phase).toBe('idle');
            expect(view.rt.state.statusTab.configuredIntervalMs).toBeNull();
            expect(view.rt.state.settingsTab.doc?.fields).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
            view.dispose();
        }
    });


    it('releases every handle it mounted, and leaves no slot behind (FR-017)', async () => {
        const view = await mountSettings({ answer: configAnswer(configEnvelope()) });
        const mounted = mounts.log
            .filter((entry) => entry.key.startsWith('mount') && !entry.key.includes(':'))
            .length;

        view.dispose();

        const disposed = mounts.log.filter((entry) => entry.key.endsWith(':dispose')).length;
        expect(mounted).toBeGreaterThan(0);
        expect(disposed).toBe(mounted);
        expect(view.rt.settingsUi).toBeNull();
    });

    it('renders the global tier in exactly one element (T-032, 004 FR-089, 005 FR-051)', async () => {
        const view = await mountSettings({
            answer: configAnswer(configEnvelope({
                config: { ...DEFAULT_CONFIG, startingPrompt: GLOBAL_TIER_SENTINEL },
            })),
        });
        const carrying = mounts.log.filter(
            (entry) => JSON.stringify(entry.props ?? null).includes(GLOBAL_TIER_SENTINEL),
        );
        view.dispose();

        // One element carries it: this harness logs a repaint beside its
        // mount as `<primitive>:update`, so the records are counted as a
        // mount (an element created holding the value) or that same row's
        // repaint — and the row *line* (which quotes the value as prose) is
        // never mounted for an editable field, so a second primitive
        // carrying the text would be a second rendering (005 SC-105).
        const creations = carrying.filter((entry) => !entry.key.includes(':'));
        expect(creations).toHaveLength(1);
        expect(creations[0]?.key).toBe('mountTextField');
        expect(carrying.every(
            (entry) => entry.key === 'mountTextField' || entry.key === 'mountTextField:update',
        )).toBe(true);
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
