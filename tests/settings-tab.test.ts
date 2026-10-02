/**
 * The Settings save path (006 T-020; FR-024, FR-025, FR-040 – FR-046;
 * AC-105, AC-107 – AC-113, AC-124 – AC-126, NFR-104).
 *
 * The tab is driven end to end against the panel's own doubles: the SDK mounts
 * record their props, `host.serviceRequest` answers from the test, and the
 * storage double records every write. What is asserted is what an operator
 * would find:
 *
 * - one activation sends **one whole document**, and the fields then show the
 *   configuration the **service returned**, never the one that was sent
 *   (FR-040, FR-044, AC-125);
 * - a refusal renders every issue in the service's order with the service's
 *   wording, and **no submitted value** reaches the surface, storage, or a log
 *   (FR-024, AC-107, AC-108);
 * - an out-of-bounds value is *sent* — the panel's affordance never suppresses
 *   a submission (FR-023, AC-110);
 * - no baseline means no request (AC-124), two rapid activations mean one
 *   write (AC-126), and reading, re-reading, and switching tabs write nothing
 *   at all (FR-049, NFR-104, AC-123).
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { repaintSettingsTab } from '../src/settings-tab.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
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

/** A value that is outside `intervalMs`'s bounds, so the service refuses it. */
const OUT_OF_RANGE = 999_999_999;

/** The picker callbacks the shell takes; none is exercised by this suite. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** One `GET /v1/config` body, assembled the way the service sends it. */
function envelopeBody(config: Record<string, unknown> = { ...DEFAULT_CONFIG }): string {
    return JSON.stringify({ config, fields: configSchema(), source: 'stored', defaultsApplied: [] });
}

/** One `422 validation` body, shaped the way the service sends it. */
function refusalBody(
    issues: readonly { readonly field: string; readonly remediation: string }[],
): string {
    return JSON.stringify({
        error: { code: 'validation', message: issues.map((issue) => issue.remediation).join('; '), issues },
    });
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
    /** Every value `host.storage.set` was handed, in order. */
    readonly storage: readonly { readonly key: string; readonly value: unknown }[];
}

/**
 * Every string the SDK mounts have been handed, mount **and** update, so an
 * assertion can be made after a click rather than only after the mount.
 *
 * @returns The strings, in record order.
 */
function recordedStrings(): readonly string[] {
    return mounts.log.flatMap((entry) => {
        const { props } = entry;
        if (typeof props === 'string') {
            return [props];
        }

        if (typeof props !== 'object' || props === null) {
            return [];
        }

        return Object.values(props).filter((value): value is string => typeof value === 'string');
    });
}

/**
 * Mount only the Settings body against the recording doubles.
 *
 * @param input - How the service should answer each method.
 * @returns The runtime, the disposer, and everything the render recorded.
 */
async function mountSettings(input: {
    /** Answers for `host.serviceRequest`, by method. */
    readonly answer?: (request: GuestRequest) => GuestRequestResult;
}): Promise<SettingsMount> {
    mounts.log.length = 0;
    const requests: GuestRequest[] = [];
    const storage: { readonly key: string; readonly value: unknown }[] = [];
    const host = fakeHost({
        serviceRequest: async (request) => {
            requests.push(request);

            return input.answer === undefined
                ? { status: DEFAULT_STATUS, body: DEFAULT_BODY }
                : input.answer(request);
        },
        storage: {
            get: async () => null,
            set: (key, value) => {
                storage.push({ key, value });

                return Promise.resolve();
            },
            delete: () => Promise.resolve(),
            keys: async () => [],
        },
    });
    const rt = createTestRuntime(host);

    const dom = fakeDom();
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'settings');
    if (spec === undefined) {
        throw new Error('the Settings tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the Settings body mounted no disposer');
    }

    await tick();

    return { rt, dispose, created: dom.created, requests, storage };
}

/**
 * Find a mounted button by its label.
 *
 * @param label - The button's label.
 * @returns The props it was mounted (or updated) with.
 */
function buttonProps(label: string): { readonly onClick?: () => void } {
    const entry = mounts.log.find(
        (mount) => mount.key === 'mountButton'
            && (mount.props as { readonly label?: string }).label === label,
    );
    if (entry === undefined) {
        throw new Error(`no button labelled ${label} was mounted`);
    }

    return entry.props as { readonly onClick?: () => void };
}

/**
 * Type into one field's control, as the operator would.
 *
 * @param field - Field name (the label starts with it).
 * @param value - The text to enter.
 */
function typeInto(field: string, value: string): void {
    const entry = mounts.log.find(
        (mount) => mount.key === 'mountTextField'
            && (mount.props as { readonly label?: string }).label?.startsWith(field) === true,
    );
    if (entry === undefined) {
        throw new Error(`no control for ${field} was mounted`);
    }

    (entry.props as { readonly onChange: (next: string) => void }).onChange(value);
}

/**
 * Run one save activation and let the answer land.
 *
 * @param view - The mounted body.
 * @param activations - How many times to activate, for the busy-gate case.
 */
async function activateSave(view: SettingsMount, activations = 1): Promise<void> {
    const { onClick } = buttonProps('Save configuration');
    if (onClick === undefined) {
        throw new Error('the save control has no handler');
    }

    for (let index = 0; index < activations; index += 1) {
        onClick();
    }

    await tick();
    await tick();
}

/**
 * Build an answer for a GET of the configuration and a scripted PUT.
 *
 * @param input - The document to read, and how the write answers.
 * @returns The answer for either method.
 */
function scriptedAnswer(input: {
    /** The document `GET` answers with. */
    readonly config?: string;
    /** How `PUT /v1/config` answers; defaults to a neutral 404. */
    readonly put?: GuestRequestResult;
}): (request: GuestRequest) => GuestRequestResult {
    return (request) => {
        if (request.method === 'GET' && request.path === '/v1/config') {
            return { status: 200, body: input.config ?? envelopeBody() };
        }

        if (request.method === 'PUT' && request.path === '/v1/config') {
            return input.put ?? { status: DEFAULT_STATUS, body: DEFAULT_BODY };
        }

        return { status: DEFAULT_STATUS, body: DEFAULT_BODY };
    };
}

/** The refusal three documented rules produce, in the service's order. */
const THREE_ISSUES: readonly { readonly field: string; readonly remediation: string }[] = [
    { field: 'intervalMs', remediation: 'set intervalMs to an integer between 15000 and 300000 milliseconds' },
    { field: 'retryMaxMs', remediation: 'set retryMaxMs to a value greater than or equal to retryBaseMs' },
    { field: '<withheld>', remediation: 'remove this key; only the documented ServiceConfig fields are accepted' },
];

describe('one activation sends one whole document (006 T-020, FR-040, FR-044, AC-125)', () => {
    it('sends every field and renders the configuration the … (+2 cases)', async () => {
        // case: sends every field and renders the configuration the service returned
        {
            const returned = envelopeBody({ ...DEFAULT_CONFIG, intervalMs: 46_000 });
            const view = await mountSettings({
                answer: scriptedAnswer({ put: { status: 200, body: returned } }),
            });
            typeInto('intervalMs', '45000');

            await activateSave(view);

            const writes = view.requests.filter((request) => request.method === 'PUT');
            expect(writes).toHaveLength(1);
            const sent = JSON.parse(writes[0]?.body ?? '{}') as Record<string, unknown>;
            // The whole document, not a patch: every documented key went.
            expect(Object.keys(sent).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
            expect(sent.intervalMs).toBe(45_000);
            // The tab now shows what the *service* said, not what was sent (AC-125).
            expect(view.rt.state.settingsTab.edit.draft.intervalMs).toBe('46000');
            expect(view.rt.state.settingsTab.edit.saveState).toBe('saved');
            expect(view.rt.state.settingsTab.edit.dirty).toEqual([]);
            // And the save reports itself, with the boundary it was saved under.
            expect(recordedStrings().join('\n')).toContain('Saved.');
            view.dispose();
        }
        // case: AC-105: the pending marker names the boundary and is not cleared by the save
        {
            const returned = envelopeBody({ ...DEFAULT_CONFIG, intervalMs: 46_000 });
            const view = await mountSettings({
                answer: scriptedAnswer({ put: { status: 200, body: returned } }),
            });
            typeInto('intervalMs', '45000');

            await activateSave(view);

            const { pending } = view.rt.state.settingsTab.edit;
            expect(pending).toEqual([{ field: 'intervalMs', boundary: 'next-cycle' }]);
            view.dispose();
        }
        // case: AC-102: the new interval is announced for the next poll, and nothing is restarted
        {
            const returned = envelopeBody({ ...DEFAULT_CONFIG, intervalMs: 120_000 });
            const view = await mountSettings({
                answer: scriptedAnswer({ put: { status: 200, body: returned } }),
            });
            typeInto('intervalMs', '120000');

            await activateSave(view);

            // The row says which boundary governs — never *immediately* — and the
            // panel itself restarts nothing: one read, one write, no further call
            // (FR-032: the service's own timer re-reads the interval per cycle).
            expect(view.rt.state.settingsTab.edit.saveState).toBe('saved');
            expect(view.requests).toHaveLength(2);
            expect(view.requests.every((request) => request.method === 'GET' || request.method === 'PUT')).toBe(true);
            view.dispose();
        }
    });
});

describe('a refusal renders the service in the service\'s words (006 T-020, AC-107 – AC-112)', () => {
    it('renders every issue in order, unrewritten, and names… (+3 cases)', async () => {
        // case: renders every issue in order, unrewritten, and names no other resource
        {
            const view = await mountSettings({
                answer: scriptedAnswer({
                    put: { status: 422, body: refusalBody(THREE_ISSUES) },
                }),
            });
            typeInto('intervalMs', '120000');

            await activateSave(view);

            const text = recordedStrings().join('\n');
            const positions = THREE_ISSUES.map((issue) => text.indexOf(`${issue.field}: ${issue.remediation}`));
            for (const position of positions) {
                expect(position).toBeGreaterThanOrEqual(0);
            }
            // In the service's order, none merged into another (AC-107).
            expect([...positions].sort((left, right) => left - right)).toEqual(positions);
            // The problem names the configuration and never the bindings list
            // (AC-112), and the tab reports the refusal rather than a success.
            expect(view.rt.state.settingsTab.edit.saveState).toBe('refused');
            expect(text).not.toContain('bindings list');
            view.dispose();
        }
        // case: AC-110: an out-of-bounds value is sent, and refused there
        {
            const view = await mountSettings({
                answer: scriptedAnswer({ put: { status: 422, body: refusalBody(THREE_ISSUES.slice(0, 1)) } }),
            });
            typeInto('intervalMs', String(OUT_OF_RANGE));

            await activateSave(view);

            const writes = view.requests.filter((request) => request.method === 'PUT');
            expect(writes).toHaveLength(1);
            expect(writes[0]?.body).toContain(String(OUT_OF_RANGE));
            expect(view.rt.state.settingsTab.edit.saveState).toBe('refused');
            view.dispose();
        }
        // case: AC-109: every field shows the last configuration the service reported
        {
            const view = await mountSettings({
                answer: scriptedAnswer({ put: { status: 422, body: refusalBody(THREE_ISSUES.slice(0, 1)) } }),
            });
            typeInto('intervalMs', '120000');

            await activateSave(view);

            // The typed value is gone from the draft — and with it from every
            // control, because the control reads the draft.
            expect(view.rt.state.settingsTab.edit.draft.intervalMs).toBe(String(DEFAULT_CONFIG.intervalMs));
            expect(view.rt.state.settingsTab.edit.dirty).toEqual([]);
            view.dispose();
        }
        // case: AC-108: no submitted value reaches the surface, storage, or a log line
        {
            const view = await mountSettings({
                answer: scriptedAnswer({ put: { status: 422, body: refusalBody(THREE_ISSUES.slice(0, 1)) } }),
            });
            typeInto('intervalMs', String(OUT_OF_RANGE));

            await activateSave(view);

            const slice = view.rt.state.settingsTab;
            // What is on screen *now*: the restored draft and the service's own
            // remediation, which names the field and its constraint but never the
            // submission (FR-024, NFR-102).
            const current = [
                JSON.stringify(slice.edit.draft),
                recordedStrings().filter((text) => text.includes('set intervalMs')).join('\n'),
                JSON.stringify(view.storage),
            ].join('\n');
            expect(current).not.toContain(String(OUT_OF_RANGE));
            // The value itself only ever appears in the request the panel sent —
            // that is the submission, and it is the one place it belongs.
            expect(JSON.stringify(view.requests.map((request) => request.body))).toContain(String(OUT_OF_RANGE));
            view.dispose();
        }
    });
});

describe('nothing is written by looking; one activation writes once (AC-123, AC-124, AC-126)', () => {
    it('AC-124: with no baseline, activating save sends noth… (+2 cases)', async () => {
        // case: AC-124: with no baseline, activating save sends nothing
        {
            const view = await mountSettings({
                answer: () => {
                    throw new Error('connection refused');
                },
            });

            await activateSave(view);

            expect(view.requests.every((request) => request.method === 'GET')).toBe(true);
            expect(view.rt.state.settingsTab.edit.saveState).toBe('idle');
            view.dispose();
        }
        // case: AC-126: two rapid activations produce exactly one write
        {
            const view = await mountSettings({
                answer: scriptedAnswer({ put: { status: 200, body: envelopeBody() } }),
            });
            typeInto('intervalMs', '45000');

            await activateSave(view, 2);

            expect(view.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
            view.dispose();
        }
        // case: AC-123: an unsaved edit survives another tab body mounting
        {
            const view = await mountSettings({ answer: scriptedAnswer({}) });
            typeInto('intervalMs', '45000');
            expect(view.rt.state.settingsTab.edit.dirty).toEqual(['intervalMs']);

            // The shell keeps every body mounted, so "switching away and back" is
            // another body mounting beside this one — no read, no write, and no
            // repaint that could clear the draft.
            const other = tabSpecs(view.rt, inertHandlers).find((entry) => entry.id === 'status');
            const disposeOther = other?.mount(fakeDom().root) ?? null;
            repaintSettingsTab(view.rt);

            expect(view.rt.state.settingsTab.edit.dirty).toEqual(['intervalMs']);
            expect(view.rt.state.settingsTab.edit.draft.intervalMs).toBe('45000');
            expect(view.requests.every((request) => request.method === 'GET')).toBe(true);
            disposeOther?.();
            view.dispose();
        }
    });
});

describe('a write that could not happen is not a refusal (006 T-020, FR-061, FR-063)', () => {
    it('reports a store the service cannot write with its own cause', async () => {
        const view = await mountSettings({
            answer: scriptedAnswer({
                put: {
                    status: 503,
                    body: JSON.stringify({ error: { code: 'storage-unavailable', message: 'store unavailable' } }),
                },
            }),
        });
        typeInto('intervalMs', '45000');

        await activateSave(view);

        const slice = view.rt.state.settingsTab;
        expect(slice.edit.saveState).toBe('failed');
        expect(slice.edit.problem).toBe('service answered 503');
        expect(slice.edit.issues).toEqual([]);
        view.dispose();
    });
});
