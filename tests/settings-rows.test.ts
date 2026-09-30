/**
 * The Settings tab (005 T-027; FR-070, FR-071, FR-072, FR-073, FR-078,
 * FR-039, AC-132, AC-135).
 *
 * The tab has two ways to be wrong, so the suite has two halves:
 *
 * 1. **Drift** — the row declaration is a panel-side copy of the service's
 *    own bounds, defaults, and enum set (research Q1), so the copy is
 *    cross-checked against `service/config.ts` and the check is shown to
 *    bite. A bound changed in the service fails this file, not an operator's
 *    screen.
 * 2. **Dishonest rendering** — rows must carry value, unit, and bounds; an
 *    unreadable value must say so with its remediation and never show a
 *    default as though it were configured; a field this build declares
 *    nothing for must still render; and the tab must offer **no input
 *    control at all** (FR-070), because editing is 006's.
 *
 * Everything runs against the panel's own doubles: the SDK mounts are
 * recorded, the fake DOM creates elements, and `host.serviceRequest` answers
 * from the test. No live host, no token, no network (FR-086).
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { DEFAULT_CONFIG, LOG_LEVELS, NUMERIC_BOUNDS } from '../service/config.ts';
import { SETTINGS_FIELDS, parseConfigDocument, settingsRows } from '../src/settings-rows.ts';
import type { ConfigDocument, SettingsRow, SettingsRowDecl } from '../src/settings-rows.ts';
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

/** SDK primitives that are input controls; the tab may mount none (FR-070). */
const INPUT_MOUNTS: readonly string[] = [
    'mountTextField',
    'mountSelect',
    'mountCheckbox',
    'mountSwitch',
    'mountSearchField',
    'mountMenu',
];

/** The declaration under test, for the drift checks. */
function declarationFor(field: string): SettingsRowDecl {
    const decl = SETTINGS_FIELDS.find((candidate) => candidate.field === field);
    if (decl === undefined) {
        throw new Error(`${field} has no Settings row declaration`);
    }

    return decl;
}

/**
 * The document `GET /v1/config` is modeled as answering with this build's own
 * configuration, so "the document the service actually carries" is not a
 * hand-typed fixture that could drift from `DEFAULT_CONFIG`.
 *
 * @param overrides - Fields to replace in the document.
 * @returns A response body.
 */
function configBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ config: { ...DEFAULT_CONFIG, ...overrides } });
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

/**
 * Build the rows a document produces.
 *
 * @param body - Response body text.
 * @returns The rows; fails the test when the body is not a document.
 */
function rowsFor(body: string): readonly SettingsRow[] {
    const doc: ConfigDocument | null = parseConfigDocument(body);
    expect(doc, `${body} did not parse as a configuration document`).not.toBeNull();

    return settingsRows(doc ?? { fields: [] });
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
    return { phase: 'idle', at: null, problem: null, stale: false, doc: null, ...overrides };
}

describe('the Settings row declaration is the service\'s own (research Q1)', () => {
    it('declares exactly the fields the service configuration carries', () => {
        const declared = SETTINGS_FIELDS.map((decl) => decl.field).sort();
        const service = [...Object.keys(NUMERIC_BOUNDS), 'logLevel'].sort();

        expect(declared).toEqual(service);
        for (const field of declared) {
            expect(DEFAULT_CONFIG, `${field} is not a service configuration field`).toHaveProperty(field);
        }
    });

    it('matches NUMERIC_BOUNDS min, max, and unit for every numeric field', () => {
        for (const [field, bounds] of Object.entries(NUMERIC_BOUNDS)) {
            const decl = declarationFor(field);
            expect(decl.bounds, `${field} declares no bounds`).not.toBeNull();
            expect({ min: decl.bounds?.min, max: decl.bounds?.max, unit: decl.bounds?.unit }).toEqual({
                min: bounds.min,
                max: bounds.max,
                unit: bounds.unit,
            });
        }
    });

    it('matches DEFAULT_CONFIG defaults and the LOG_LEVELS enum set', () => {
        for (const decl of SETTINGS_FIELDS) {
            const service = DEFAULT_CONFIG[decl.field as keyof typeof DEFAULT_CONFIG];
            expect(decl.defaultValue, `${decl.field} default drifted`).toBe(service);
        }

        expect(declarationFor('logLevel').values).toEqual([...LOG_LEVELS]);
        expect(declarationFor('logLevel').bounds).toBeNull();
    });

    it('fails on a bound the service does not declare', () => {
        // The check has to bite before it can be believed (review convention):
        // a drifted copy of a real declaration must not satisfy the same
        // comparison the cross-check above runs.
        const drift = {
            ...declarationFor('intervalMs'),
            bounds: { min: 1, max: 999_999, unit: 'milliseconds' },
        };
        const own = Object.entries(NUMERIC_BOUNDS).find(([field]) => field === 'intervalMs')?.[1];

        expect(own).toBeDefined();
        expect(drift.bounds).not.toEqual({ min: own?.min, max: own?.max, unit: own?.unit });
    });
});

describe('rows render the document, honestly (AC-135, FR-071, FR-072)', () => {
    it('renders one row per field the document carries, with value, unit, and bounds', () => {
        const rows = rowsFor(configBody());

        expect(rows).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        const interval = rows.find((row) => row.field === 'intervalMs');
        expect(interval?.text).toContain('60000 milliseconds');
        expect(interval?.text).toContain('bounds 15000–300000');
        expect(interval?.text).toContain('default 60000');
        expect(interval?.text).toContain('no restart');
        const level = rows.find((row) => row.field === 'logLevel');
        expect(level?.text).toContain('info · accepted: debug, info, warn, error');
    });

    it('gives 003\'s two fields the bounds 003 declared and a next-cycle statement', () => {
        const rows = rowsFor(configBody());
        const lease = rows.find((row) => row.field === 'leaseMs');
        const deadline = rows.find((row) => row.field === 'resultDeadlineMs');

        expect(lease?.text).toContain('bounds 30000–600000');
        expect(lease?.text).toContain('Takes effect at the next claim');
        expect(deadline?.text).toContain('Takes effect for the next dispatch');
        expect(declarationFor('leaseMs').effect).toBe('next-cycle');
        expect(declarationFor('resultDeadlineMs').effect).toBe('next-cycle');
    });

    it('renders an unreadable field with its remediation and never a default', () => {
        const rows = rowsFor('{"config":{"intervalMs":"soon","perPage":30}}');
        const interval = rows.find((row) => row.field === 'intervalMs');

        expect(interval?.text).toContain('intervalMs: unreadable');
        expect(interval?.text).toContain('set intervalMs to an integer between 15000 and 300000 milliseconds');
        // Never a default dressed as a configured value (FR-003, NFR-112).
        expect(interval?.text).not.toContain('60000');
        expect(interval?.text).not.toContain('default');
        // The field beside it still renders — one bad field hides nothing.
        expect(rows.find((row) => row.field === 'perPage')?.text).toContain('bounds 1–30');
    });

    it('renders a field this build declares nothing for rather than dropping it', () => {
        const rows = rowsFor('{"config":{"expectedAgent":"project-manager","intervalMs":60000}}');

        expect(rows.map((row) => row.field)).toEqual(['expectedAgent', 'intervalMs']);
        expect(rows[0]?.text).toContain('expectedAgent: project-manager');
        expect(rows[0]?.text).toContain('bounds and take-effect not declared by this build');
    });

    it('refuses a body that is not a configuration document', () => {
        expect(parseConfigDocument('not json')).toBeNull();
        expect(parseConfigDocument('[]')).toBeNull();
        expect(parseConfigDocument('{"config":null}')).toBeNull();
        expect(parseConfigDocument('{"config":[]}')).toBeNull();
        expect(parseConfigDocument('{"intervalMs":60000}')).toBeNull();
    });
});

describe('the Settings body mounts read-only (AC-135, FR-070, FR-073)', () => {
    it('renders rows with value, unit, and bounds and no input control', async () => {
        const view = await mountSettings({ answer: configAnswer(configBody()) });
        const rows = renderedRows(view.strings);

        expect(rows).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        expect(rows.join('\n')).toContain('bounds 15000–300000');

        const inputMounts = mounts.log
            .map((entry) => entry.key)
            .filter((key) => INPUT_MOUNTS.includes(key));
        expect(inputMounts).toEqual([]);
        const tags = view.created.map((element) => element.tagName);
        expect(tags).not.toContain('input');
        expect(tags).not.toContain('select');
        expect(tags).not.toContain('textarea');

        const text = view.strings.join('\n');
        expect(text).toContain('Read-only in this release');
        expect(text).toContain('feature 006');
        // FR-073: names the feature, never a version number for it.
        expect(text).not.toMatch(/\d+\.\d+\.\d+/);

        // FR-070: the tab's only request is a read of the document.
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
        expect(text).toContain('Read-only in this release');
        expect(text).toContain('No configuration has been read yet');
        expect(text).toContain('Settings could not be read: service unreachable');
        expect(text).toContain('GET /v1/config did not answer');
        expect(renderedRows(view.strings)).toEqual([]);
        view.dispose();
    });

    it('offers exactly one control: the re-read (FR-014, FR-078)', async () => {
        const view = await mountSettings({ answer: configAnswer(configBody()) });
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
        const view = await mountSettings({ answer: configAnswer(configBody()) });

        expect(view.rt.state.settingsTab.phase).toBe('loaded');
        expect(view.rt.state.statusTab.phase).toBe('idle');
        expect(view.rt.state.statusTab.configuredIntervalMs).toBeNull();
        expect(view.rt.state.settingsTab.doc?.fields).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        view.dispose();
    });

    it('releases every handle it mounted, and leaves no slot behind (FR-017)', async () => {
        const view = await mountSettings({ answer: configAnswer(configBody()) });
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
        expect(readStateLine(settingsSlice())).toBe('Settings: not read yet.');
        expect(readStateLine(settingsSlice({ phase: 'loading' }))).toBe('Settings: reading…');
        expect(readStateLine(settingsSlice({ phase: 'loaded', at: STAMP }))).toContain(`read at ${STAMP}`);
        expect(readStateLine(settingsSlice({ phase: 'failed', problem: PROBLEM })))
            .toContain('Nothing has been read yet');
        expect(readStateLine(settingsSlice({ phase: 'failed', at: STAMP, problem: PROBLEM, stale: true })))
            .toContain('may be stale');
    });
});
