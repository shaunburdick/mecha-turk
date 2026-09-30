/**
 * Composition and accessibility over the finished Settings surface (006
 * T-021; FR-012, FR-018, FR-019, FR-039, FR-045, FR-081, FR-082; AC-141,
 * AC-142, SC-113, NFR-107).
 *
 * What this suite can honestly check without a browser is what the *panel*
 * is responsible for; what the SDK owns (focus, the focus ring, tab order
 * inside one control) is asserted as "the SDK's control, with a label and a
 * handler", which is the same division the rest of the panel suites use:
 *
 * - **Every configuration control is operable and named** (FR-018, NFR-107):
 *   a label carrying the field's name, its unit or its explicit absence, and
 *   the take-effect boundary; a handler on every one of them.
 * - **Exactly one editable rendering** of the configuration exists across all
 *   six tabs (SC-113, AC-141) — asserted by counting, so it fails at zero as
 *   well as at two.
 * - **No other tab grows a configuration control, a token input, or a
 *   credential** (AC-142, FR-017, FR-082).
 * - **One write, and only one of it** (FR-012).
 *
 * AC-143 — one relay loop and one dispatch across a Settings detour — is
 * asserted where that loop lives, in `lifecycle-proof.test.ts` (its
 * `AC-136 / SC-108` case drives the same mid-flight switch through all six
 * tabs, Settings included, and counts the dispatches), as is NFR-104's
 * "reading changes nothing" (its `FR-014` case).
 *
 * Offline: the SDK mounts are recorded, the fake DOM creates elements, and
 * `host.serviceRequest` answers 404 to everything (FR-086).
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';

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

/** The six tab ids, in the shell's order (005 FR-010). */
const TAB_IDS: readonly string[] = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'];

/** The picker callbacks the shell takes; none is exercised by this suite. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** What one tab's mounts recorded. */
interface TabRender {
    /** Tab id the mounts belong to. */
    readonly id: string;
    /** Accessible labels of every control the tab mounted. */
    readonly labels: readonly string[];
    /** Every prop the tab's controls were mounted with. */
    readonly props: readonly Record<string, unknown>[];
}

/**
 * Mount every body and attribute its mounts to it, in order.
 *
 * @param rt - Panel runtime the specs build from.
 * @returns One entry per tab, in `TAB_IDS` order.
 */
async function renderAllTabs(rt: PanelRuntime): Promise<readonly TabRender[]> {
    mounts.log.length = 0;
    const dom = fakeDom();
    const specs = tabSpecs(rt, inertHandlers);
    const renders: TabRender[] = [];
    for (const id of TAB_IDS) {
        const spec = specs.find((entry) => entry.id === id);
        if (spec === undefined) {
            throw new Error(`the ${id} tab spec is missing from the shell`);
        }

        const before = mounts.log.length;
        spec.mount(dom.root);
        // Each body reads on first activation, so let *its* read land before
        // the window closes: a row painted by that read belongs to this tab.
        await tick();
        const mounted = mounts.log.slice(before).filter((entry) => !entry.key.includes(':'));
        renders.push({
            id,
            labels: mounted
                .map((entry) => (entry.props as { readonly label?: string }).label)
                .filter((label): label is string => typeof label === 'string'),
            props: mounted
                .map((entry) => entry.props)
                .filter((props): props is Record<string, unknown> => typeof props === 'object' && props !== null),
        });
    }

    return renders;
}

/** One `GET /v1/config` body, assembled the way the service sends it. */
function envelopeBody(): string {
    return JSON.stringify({
        config: { ...DEFAULT_CONFIG },
        fields: configSchema(),
        source: 'stored',
        defaultsApplied: [],
    });
}

/** The one runtime these renders share: every path answers, `/v1/config` well. */
function runtime(): PanelRuntime {
    return createTestRuntime(
        fakeHost({
            serviceRequest: async (request) =>
                request.path === '/v1/config'
                    ? { status: 200, body: envelopeBody() }
                    : { status: 404, body: '{}' },
        }),
    );
}

/**
 * The labels that name a configuration field.
 *
 * @param render - One tab's mounts.
 * @returns The labels that mention a documented field.
 */
function configurationLabels(render: TabRender): readonly string[] {
    const fields = Object.keys(DEFAULT_CONFIG);

    return render.labels.filter((label) => fields.some((field) => label.startsWith(field)));
}

describe('the configuration is editable in exactly one tab (006 AC-141, SC-113, FR-019)', () => {
    it('mounts every documented field as a control in Settings, and nowhere else', async () => {
        const renders = await renderAllTabs(runtime());

        for (const render of renders.filter((entry) => entry.id !== 'settings')) {
            expect(configurationLabels(render), `${render.id} rendered a configuration control`).toEqual([]);
        }

        const settings = renders.find((render) => render.id === 'settings');
        expect(settings).toBeDefined();
        // Counted, not listed: this fails at zero (the surface disappeared)
        // as surely as at two (a second rendering appeared).
        expect(configurationLabels(settings as TabRender)).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
    });
});

describe('the other tabs grow no configuration or credential control (006 AC-142, FR-082)', () => {
    it('mounts none on Bindings, Dispatches, Accounts, or About', async () => {
        const renders = await renderAllTabs(runtime());

        for (const id of ['bindings', 'dispatches', 'accounts', 'about']) {
            const render = renders.find((entry) => entry.id === id);
            expect(render, `${id} did not mount`).toBeDefined();
            expect(configurationLabels(render as TabRender)).toEqual([]);
        }
    });

    it('mounts no password field anywhere, and no credential word on Settings', async () => {
        const renders = await renderAllTabs(runtime());

        for (const render of renders) {
            const passworded = render.props.filter((props) => props.password === true);
            expect(passworded, `${render.id} mounted a password field`).toEqual([]);
        }

        const settings = renders.find((render) => render.id === 'settings');
        // Whole words only: `dispatch` contains the letters `pat`, and this
        // claim is about credential *labels*, not about substrings.
        const credential = /\b(token|credential|pat|password)\b/i;
        const labelled = (settings?.labels ?? []).filter((label) => credential.test(label));
        expect(labelled).toEqual([]);
    });
});

describe('every configuration control is operable and named (006 FR-018, FR-039, NFR-107)', () => {
    it('names each with its field, its unit or its absence, and its boundary', async () => {
        const renders = await renderAllTabs(runtime());
        const settings = renders.find((render) => render.id === 'settings');
        const controls = (settings?.props ?? []).filter((props) => typeof props.onChange === 'function');

        expect(controls).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        for (const props of controls) {
            const label = String(props.label);
            // The name and the boundary are the load-bearing halves (FR-039).
            const named = Object.keys(DEFAULT_CONFIG).find((field) => label.startsWith(`${field} (`));
            expect(named, `a control was mounted without naming its field: ${label}`).toBeDefined();
            // The unit slot is always filled — with the unit, or with the
            // words that say there is none (FR-014).
            expect(label).toMatch(/\(([^)]+)\)/);
            expect(label).toMatch(
                /takes effect immediately|in effect from the next poll|in effect from the next dispatch/,
            );
            // Operable: the handler that makes it so is on the mount itself.
            expect(typeof props.onChange).toBe('function');
        }
    });

    it('offers exactly one save, discard, and restore control (FR-012, FR-045)', async () => {
        const renders = await renderAllTabs(runtime());
        const settings = renders.find((render) => render.id === 'settings');
        const labels = settings?.labels ?? [];

        expect(labels.filter((label) => label === 'Save configuration')).toHaveLength(1);
        expect(labels.filter((label) => label === 'Discard changes')).toHaveLength(1);
        expect(labels.filter((label) => label === 'Restore defaults')).toHaveLength(1);
        const handlers = (settings?.props ?? []).filter(
            (props) => props.label === 'Save configuration' || props.label === 'Discard changes',
        );
        for (const props of handlers) {
            expect(typeof props.onClick).toBe('function');
        }
    });
});
