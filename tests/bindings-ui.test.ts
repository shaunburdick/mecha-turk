/**
 * The Bindings tab's own line, its copy, and its static guards (005 T-022,
 * T-023: FR-020, FR-053, FR-059, FR-089, AC-112).
 *
 * Two kinds of assertion live here, and they exist for different reasons:
 *
 * - **What the tab says** is read from the mounts themselves, with the SDK
 *   primitives stubbed to record their props. A source scan cannot prove the
 *   tab renders *Bindings* rather than *Repositories*, because the string
 *   that reaches the operator's eye is composed at runtime; the mount props
 *   are that eye.
 * - **What the tab must never say or reach for** is static: no service
 *   tuning field name anywhere in the bindings modules (FR-059), and no
 *   project-creation call anywhere in the panel at all (FR-089) — the
 *   extension registers nothing, it only points at the three routes
 *   OpenChamber provides, which AC-112 requires it to name.
 *
 * Offline: a fake host, the DOM double, and no service (FR-086).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it, vi } from 'vitest';
import { tabSpecs } from '../src/tab-bodies.ts';
import { utcStamp } from '../src/ids.ts';
import {
    ADD_BINDING_LABEL,
    accountFieldView,
    mentionTokenView,
    MENTION_IDLE,
    SAVE_CHANGES_LABEL,
} from '../src/bindings-editor.ts';
import { startEditingBinding, stopEditingBinding } from '../src/bindings-edit.ts';
import { toggleBinding } from '../src/bindings.ts';
import { stopRelayPolling } from '../src/relay.ts';
import { selectedBindingDetail } from '../src/bindings-rows.ts';
import { PROJECT_REGISTRATION_ROUTES } from '../src/project-picker.ts';
import { initialBindings } from '../src/panel-state.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { BindingsTabState } from '../src/panel-state.ts';
import type { BindingStatusRow, PanelAccount, PanelBinding } from '../src/bindings-service.ts';
import { fakeDom } from './support/dom.ts';
import { FIXTURE_TIMESTAMP, createTestRuntime, fakeHost } from './support/panel.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
    inert: 0,
    paints: 0,
    disposes: 0,
}));

/**
 * Count one stubbed handle's paint and dispose, so "mounted" stays
 * distinguishable from "constructed".
 *
 * Updates are recorded as well as counted: a control's *initial* props are
 * what it mounts with, while a repaint is what the operator is actually
 * looking at afterwards — and the assertion this file exists for is that the
 * value on screen and the value a save carries cannot disagree.
 *
 * @param key - Name of the SDK primitive the handle belongs to.
 * @returns The handle every `mount*` primitive answers with here.
 */
function sdkHandle(key: string): { readonly update: () => void; readonly dispose: () => void } {
    return {
        update: (props?: unknown): void => {
            mounts.paints += 1;
            mounts.log.push({ key: `${key}:update`, props });
        },
        dispose: (): void => {
            mounts.disposes += 1;
        },
    };
}

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): ReturnType<typeof sdkHandle> => {
                mounts.log.push({ key, props });

                return sdkHandle(key);
            };
        }
    }

    return stubbed;
});

/** The picker callbacks the Bindings body takes; none is exercised here. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => {
        mounts.inert += 1;
    },
    selectProject: (): void => {
        mounts.inert += 1;
    },
    copyProjectId: (): void => {
        mounts.inert += 1;
    },
};

/** Service configuration field names; none of them belongs to this tab (FR-059). */
const CONFIG_FIELDS: readonly string[] = [
    'intervalMs',
    'overlapMs',
    'perPage',
    'retryMaxAttempts',
    'retryBaseMs',
    'retryMaxMs',
    'auditRetentionDays',
    'auditMaxEntries',
    'excerptRetentionDays',
    'logLevel',
    'expectedAgent',
    'leaseMs',
    'resultDeadlineMs',
];

/** The only project-creation vocabulary the panel is allowed to mention. */
const PROJECT_CREATION_CALL = /\b(?:createProject|addProject|registerProject|newProject)\s*\(/;

/** Fixture login the account and binding fixtures share. */
const LOGIN = 'octocat-mt';

/** The mention-token line when the rendered token is the account's own login. */
const MATCHED_TOKEN_LINE = 'Mention token in force: @octocat-mt';

/** Label the bound-account select mounts with, so its props can be found. */
const ACCOUNT_SELECT_LABEL = 'Poll as account';

/** A scan two minutes back, as the ISO stamp a stale row carries. */
const TWO_MINUTES_AGO = new Date(Date.now() - 120_000).toISOString();

/**
 * Read the string values one mount was handed.
 *
 * @param props - Whatever the SDK primitive received.
 * @returns The strings among them, in property order.
 */
function stringsIn(props: unknown): readonly string[] {
    if (typeof props === 'string') {
        return [props];
    }

    if (typeof props !== 'object' || props === null) {
        return [];
    }

    return Object.values(props).filter((value): value is string => typeof value === 'string');
}

/**
 * Read every string the mounted Bindings body handed to the SDK.
 *
 * @returns The rendered strings, in mount order.
 */
function renderedStrings(): readonly string[] {
    return mounts.log.flatMap((entry) => stringsIn(entry.props));
}

/**
 * Mount only the Bindings body, so the copy asserted is this tab's own.
 *
 * @returns The runtime and the disposer the spec handed back.
 */
function mountBindingsTab(options: {
    /** State to arrange before the body mounts, so it renders the case. */
    readonly setup?: (rt: ReturnType<typeof createTestRuntime>) => void;
    /** Host double the runtime mounts against (a recording one, when logged). */
    readonly host?: ReturnType<typeof fakeHost>;
} = {}): {
    /** The runtime the body mounted against. */
    readonly rt: ReturnType<typeof createTestRuntime>;
    /** The spec's disposer, which tears the body down. */
    readonly dispose: () => void;
} {
    mounts.log.length = 0;
    const rt = createTestRuntime(options.host ?? fakeHost());
    options.setup?.(rt);
    const dom = fakeDom();
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'bindings');
    if (spec === undefined) {
        throw new Error('the Bindings tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the Bindings body mounted no disposer');
    }

    return { rt, dispose };
}

/**
 * Read the props of one mounted — or repainted — SDK primitive.
 *
 * @param key - The primitive's name, e.g. `mountSelect`.
 * @param isMatch - Selects the call by its own props.
 * @returns The props that call received, or `undefined` when there is none.
 */
/**
 * Every call to one primitive whose props match, oldest first.
 *
 * @param key - The primitive's name, e.g. `mountSelect`.
 * @param isMatch - Filters the calls, by their own props.
 * @returns The matching props, in call order.
 */
function propsLog(
    key: string,
    isMatch: (props: Record<string, unknown>) => boolean,
): readonly Record<string, unknown>[] {
    return mounts.log
        .filter((entry) => entry.key === key || entry.key === `${key}:update`)
        .map((entry) => entry.props as Record<string, unknown>)
        .filter((props) => isMatch(props));
}

/**
 * Read the props of the first call to one primitive — what it mounted with.
 *
 * @param key - The primitive's name, e.g. `mountSelect`.
 * @param isMatch - Selects the call by its own props.
 * @returns The props that call received, or `undefined` when there is none.
 */
function propsOf(
    key: string,
    isMatch: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
    return propsLog(key, isMatch)[0];
}

/**
 * Read the props of the **last** call to one primitive — what the most recent
 * repaint handed it, which is what is on screen now.
 *
 * @param key - The primitive's name, e.g. `mountSelect`.
 * @param isMatch - Selects the call by its own props.
 * @returns The props that call received, or `undefined` when there is none.
 */
function lastPropsOf(
    key: string,
    isMatch: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
    const all = propsLog(key, isMatch);

    return all.at(-1);
}

/**
 * Build one binding for the row and detail copy.
 *
 * @returns One complete binding.
 */
function bindingFixture(overrides: Partial<PanelBinding> = {}): PanelBinding {
    return {
        bindingId: 'bnd-1',
        accountNumericUserId: '77331',
        accountLogin: LOGIN,
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'generated',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
        ...overrides,
    };
}

/**
 * Build one scan-status row for the selected binding's line.
 *
 * @returns One complete status row.
 */
function statusFixture(overrides: Partial<BindingStatusRow> = {}): BindingStatusRow {
    return {
        bindingId: 'bnd-1',
        repository: 'acme/widget',
        projectId: 'prj_42',
        accountLogin: LOGIN,
        active: true,
        lastScanAt: null,
        lastError: null,
        pendingCount: 0,
        ...overrides,
    };
}

/**
 * Build a bindings state around one selected row.
 *
 * @param input - The row, its scan status, and whether one is selected.
 * @returns The state the detail line reads.
 */
function bindingsState(input: {
    /** The binding the editor opened. */
    readonly binding: PanelBinding;
    /** Its scan status, or `null` when the service reported none. */
    readonly status: BindingStatusRow | null;
    /** Whether the row is selected. */
    readonly selected: boolean;
}): BindingsTabState {
    return {
        ...initialBindings(),
        status: 'ready',
        bindings: [input.binding],
        statusRows: input.status === null ? [] : [input.status],
        selectedBinding: input.selected ? input.binding.bindingId : null,
    };
}

describe('T-022 the selected binding presents its own state, stamps, and scan (FR-053)', () => {
    it('says a fresh binding has not been scanned, with a pending count of zero', () => {
        {
            const detail = selectedBindingDetail(bindingsState({
                binding: bindingFixture(),
                status: statusFixture(),
                selected: true,
            }));

            expect(detail).toContain('enabled');
            expect(detail).toContain('0 pending');
            expect(detail).toContain(`created ${utcStamp(FIXTURE_TIMESTAMP)}`);
            expect(detail).toContain(`updated ${utcStamp(FIXTURE_TIMESTAMP)}`);
        }
        {
            const detail = selectedBindingDetail(bindingsState({
                binding: bindingFixture(),
                status: statusFixture({ lastScanAt: TWO_MINUTES_AGO }),
                selected: true,
            }));

            expect(detail).toContain('scan: 2m ago · ok');
        }
        {
            const detail = selectedBindingDetail(bindingsState({
                binding: bindingFixture({ state: 'disabled' }),
                status: statusFixture({ lastError: 'auth-failed', pendingCount: 2 }),
                selected: true,
            }));

            expect(detail).toContain('disabled');
            expect(detail).toContain('auth-failed');
            expect(detail).toContain('2 pending');
        }
        {
            const noStatus = bindingsState({ binding: bindingFixture(), status: null, selected: false });
            expect(selectedBindingDetail(noStatus)).toBeNull();
        }
    });
});

describe('AC-112 the picker names every manual route and keeps the binding recoverable', () => {
    it('renders the three registration routes and the recoverable state', () => {
        {
            const { dispose } = mountBindingsTab();
            const guidance = renderedStrings().find((line) => line.startsWith('Not listed?'));
            dispose();

            expect(guidance).toBeDefined();
            for (const route of PROJECT_REGISTRATION_ROUTES) {
                expect(guidance).toContain(route);
            }

        }
        {
            const root = resolve(import.meta.dirname, '..', 'src');
            const modules = readdirSync(root, { recursive: true }).map(String);
            const callers = modules
                .filter((name) => name.endsWith('.ts'))
                .filter((name) => PROJECT_CREATION_CALL.test(readFileSync(resolve(root, name), 'utf8')));

            expect(callers).toEqual([]);
        }
    });
});

describe('T-023 the Bindings tab speaks the product vocabulary (FR-020)', () => {
    it('renders Bindings copy, never the retired noun, on every control it mounts', () => {
        {
            const { dispose } = mountBindingsTab();
            const strings = renderedStrings();
            dispose();

            expect(strings.some((line) => line.startsWith('Bindings: '))).toBe(true);
            expect(strings).toContain('Bindings');
            expect(strings.some((line) => line.includes('Repositories'))).toBe(false);
        }
        {
            const root = resolve(import.meta.dirname, '..', 'src');
            const modules = readdirSync(root, { recursive: true })
                .map(String)
                .filter((name) => name.startsWith('bindings'));
            const offenders: string[] = [];

            for (const name of modules) {
                const source = readFileSync(resolve(root, name), 'utf8');
                for (const field of CONFIG_FIELDS) {
                    if (source.includes(field)) {
                        offenders.push(`${name}: ${field}`);
                    }
                }
            }

            expect(modules.length).toBeGreaterThan(0);
            expect(offenders).toEqual([]);
        }
        {
            const { dispose } = mountBindingsTab();
            const strings = renderedStrings();
            dispose();

            // The account-removal affordance lives on the Accounts tab, where its
            // cascade statement is (FR-065); this tab shows only the accounts a
            // binding refers to.
            expect(strings.some((line) => line.includes('Remove account'))).toBe(false);
            expect(strings.some((line) => line.includes('Confirm remove'))).toBe(false);
            expect(strings.some((line) => line.includes('Rotate token'))).toBe(false);
        }
    });
});

/**
 * Build one credential-free account the editor's fixtures offer.
 *
 * @returns One complete account.
 */
function accountFixture(overrides: Partial<PanelAccount> = {}): PanelAccount {
    return {
        numericUserId: '77331',
        login: LOGIN,
        displayName: null,
        usable: true,
        ...overrides,
    };
}

/**
 * Read one select's option list out of the props it was handed.
 *
 * @param props - The mount or repaint props of the select.
 * @returns Its `{ id, label }` options, or an empty list when it has none.
 */
function optionsOf(props: Record<string, unknown> | undefined): readonly { id: string; label: string }[] {
    const options = props?.options;
    if (!Array.isArray(options)) {
        return [];
    }

    return options as readonly { id: string; label: string }[];
}

describe('T-022 the mention token in force, marked only when it differs (FR-057)', () => {
    it('renders the value the service matches on, with no override mark', () => {
        {
            const state = {
                ...bindingsState({ binding: bindingFixture(), status: statusFixture(), selected: true }),
                accounts: [accountFixture()],
            };

            const view = mentionTokenView(state);

            expect(view.line).toBe(MATCHED_TOKEN_LINE);
            expect(view.override).toBe(false);
            expect(view.line).not.toContain('override');
        }
        {
            // Upstream rename: the binding keeps the login it was bound under,
            // which is exactly what `mentionsLogin` goes on matching.
            const state = {
                ...bindingsState({ binding: bindingFixture(), status: statusFixture(), selected: true }),
                accounts: [accountFixture({ login: 'octocat-renamed' })],
            };

            const view = mentionTokenView(state);

            expect(view.override).toBe(true);
            expect(view.line).toContain(MATCHED_TOKEN_LINE);
            expect(view.line).toContain('override');
            expect(view.line).toContain('@octocat-renamed');
        }
        {
            const state = {
                ...bindingsState({ binding: bindingFixture(), status: statusFixture(), selected: true }),
                accounts: [],
            };

            const view = mentionTokenView(state);

            expect(view.line).toBe(MATCHED_TOKEN_LINE);
            expect(view.override).toBe(false);
        }
        {
            const state = {
                ...bindingsState({ binding: bindingFixture(), status: statusFixture(), selected: true }),
                accounts: [accountFixture({ login: 'OctoCat-MT' })],
            };

            expect(mentionTokenView(state).override).toBe(false);
        }
        {
            const state: BindingsTabState = {
                ...initialBindings(),
                status: 'ready',
                accounts: [accountFixture()],
                accountSelection: '77331',
            };

            const view = mentionTokenView(state);

            expect(view.line).toBe(MATCHED_TOKEN_LINE);
            expect(view.override).toBe(false);
        }
        {
            const view = mentionTokenView(initialBindings());

            expect(view.line).toBe(MENTION_IDLE);
            expect(view.override).toBe(false);
        }
    });

    it('renders the line on the pane itself', () => {
        const { dispose } = mountBindingsTab();
        const strings = renderedStrings();
        dispose();

        expect(strings).toContain(MENTION_IDLE);
    });
});

describe('T-022 a displayed bound account and a saved one can never disagree (PM ruling 5)', () => {
    it('fixes the field to the selected binding own account in edit mode', async () => {
        {
            const binding = bindingFixture();
            const state = {
                ...bindingsState({ binding, status: statusFixture(), selected: true }),
                accounts: [accountFixture({ login: 'octocat-renamed' })],
            };

            const field = accountFieldView(state);

            expect(field.mode).toBe('edit');
            expect(field.disabled).toBe(true);
            expect(field.value).toBe(binding.accountNumericUserId);
            // The label is the binding's own login — what a save carries — not the
            // account list's current one, so the two can never be read apart.
            expect(field.options).toEqual([
                { id: binding.accountNumericUserId, label: binding.accountLogin },
            ]);
        }
    });

    it('lists the accounts available to bind in add mode, and never an unusable one', async () => {
        {
            const state: BindingsTabState = {
                ...initialBindings(),
                status: 'ready',
                accounts: [
                    accountFixture(),
                    accountFixture({ numericUserId: '11111', login: 'revoked-bot', usable: false }),
                ],
            };

            const field = accountFieldView(state);

            expect(field.mode).toBe('add');
            expect(field.disabled).toBe(false);
            expect(field.options).toEqual([{ id: '77331', label: LOGIN }]);
        }
    });

    it('shows the account fixed on screen and saves exactly that account (ruling 5)', async () => {
        {
            const binding = bindingFixture();
            const requests: GuestRequest[] = [];
            const host = fakeHost({
                serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
                    requests.push(request);

                    return { status: 200, body: JSON.stringify({ bindings: [binding], status: [] }) };
                },
            });
            const { rt, dispose } = mountBindingsTab({
                host,
                setup: (runtime): void => {
                    runtime.state.bindings = {
                        ...initialBindings(),
                        status: 'ready',
                        bindings: [binding],
                        accounts: [accountFixture()],
                        selectedBinding: binding.bindingId,
                    };
                },
            });
            const mounted = optionsOf(propsOf('mountSelect', (props) => props.label === ACCOUNT_SELECT_LABEL));

            await toggleBinding(rt);
            const repaint = optionsOf(lastPropsOf('mountSelect', (props) => props.label === ACCOUNT_SELECT_LABEL));
            const put = requests.find((request) => request.method === 'PUT');
            expect(put).toBeDefined();
            const saved = JSON.parse(String(put?.body)) as {
                readonly bindings: readonly { accountNumericUserId: string; accountLogin: string }[];
            };
            const savedRow = saved.bindings[0];
            stopRelayPolling(rt);
            dispose();

            // What the field showed at mount, what the repaint keeps showing, and
            // what the whole-file grant stored are one and the same account.
            expect(mounted).toEqual([{ id: '77331', label: LOGIN }]);
            expect(repaint).toEqual(mounted);
            expect(String(lastPropsOf('mountSelect', (props) => props.label === ACCOUNT_SELECT_LABEL)?.value))
                .toBe('77331');
            expect(savedRow?.accountNumericUserId).toBe('77331');
            expect(savedRow?.accountLogin).toBe(LOGIN);
        }
    });

});

/**
 * Read the props of the primary control — the one whose label states what
 * its own click writes — as the last repaint left them.
 *
 * @returns Those props, or `undefined` when no primary control mounted.
 */
function primaryControl(): Record<string, unknown> | undefined {
    return lastPropsOf(
        'mountButton',
        (props) => props.label === ADD_BINDING_LABEL || props.label === SAVE_CHANGES_LABEL,
    );
}

/**
 * Arrange a ready list holding exactly the fixture row.
 *
 * @param rt - Runtime the Bindings body is about to mount against.
 */
function withSelectedRow(rt: ReturnType<typeof createTestRuntime>): void {
    rt.state.bindings.status = 'ready';
    rt.state.bindings.bindings = [bindingFixture()];
    rt.state.bindings.selectedBinding = 'bnd-1';
}

describe('T-036 the editor opens on request and states what it holds (FR-050, FR-053)', () => {
    it('shows the list first, with New binding beside the row controls and no Edit button', () => {
        {
            const { rt, dispose } = mountBindingsTab({ setup: withSelectedRow });
            const strings = renderedStrings();
            const isEditorOpen = rt.bindingsUi?.editorBox.hidden === false;
            dispose();

            // The list is the tab: the editor block is shut until a row click or
            // New binding opens it (2026-10-01 review).
            expect(isEditorOpen).toBe(false);
            expect(strings).toContain('Remove');
            // One primary control with a contextual label; the separate Edit row
            // button is gone — the row click *is* the Edit affordance.
            expect(strings).not.toContain('Edit binding');
            expect(primaryControl()?.label).toBe(ADD_BINDING_LABEL);
            // The prompt is a field of this form, not a section with its own save.
            expect(strings).not.toContain('Save starting prompt');
        }
        {
            const { rt, dispose } = mountBindingsTab({ setup: withSelectedRow });

            startEditingBinding(rt);
            // The label is the promise: activating it writes what it now says,
            // because the same control is the whole-file grant's one entry point.
            expect(rt.bindingsUi?.editorBox.hidden).toBe(false);
            expect(primaryControl()?.label).toBe(SAVE_CHANGES_LABEL);
            expect(primaryControl()?.disabled).toBe(false);
            expect(rt.state.bindings.repoInput).toBe(bindingFixture().repository);
            expect(rt.state.bindings.editing).toBe(true);

            stopEditingBinding(rt, null);
            expect(rt.bindingsUi?.editorBox.hidden).toBe(true);
            expect(primaryControl()?.label).toBe(ADD_BINDING_LABEL);
            expect(rt.state.bindings.editing).toBe(false);
            dispose();
        }
        {
            const { rt, dispose } = mountBindingsTab({
                setup: (runtime): void => {
                    withSelectedRow(runtime);
                    runtime.state.bindings.bindings = [bindingFixture({ state: 'disabled' })];
                },
            });

            startEditingBinding(rt);
            const strings = renderedStrings();
            dispose();

            // …and the enabled row states its own truth, not the last one painted.
            expect(strings.filter((line) => line.startsWith('State: '))).not.toContain('State: enabled');
        }
    });
});

/**
 * Read the rows the bindings list was last painted with — the frame the
 * operator is looking at now.
 *
 * The list mounts empty (`items: []`) and its rows arrive only through a
 * repaint, so the last `mountList` call of any kind is the frame on screen:
 * at mount that is the update the body issues itself, with no read in between.
 *
 * @returns The rows, in paint order; an empty list when none were painted.
 */
function paintedListItems(): readonly { readonly title?: string; readonly subtitle?: string }[] {
    const paints = mounts.log.filter(
        (entry) => entry.key === 'mountList' || entry.key === 'mountList:update',
    );
    const frame = paints.at(-1);
    const items = (frame?.props as { readonly items?: unknown } | undefined)?.items;

    return Array.isArray(items)
        ? (items as readonly { readonly title?: string; readonly subtitle?: string }[])
        : [];
}

describe('FR-013 the Bindings body paints its stored list on first activation', () => {
    it('renders the bindings the runtime holds at mount, before any read runs', () => {
        const requests: GuestRequest[] = [];
        const host = fakeHost({
            serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
                requests.push(request);

                return { status: 200, body: JSON.stringify({ bindings: [], status: [] }) };
            },
        });
        // The runtime already knows one binding — the state a refresh tick
        // would otherwise be the first thing to show.
        const { dispose } = mountBindingsTab({ host, setup: withSelectedRow });
        const painted = paintedListItems();
        const statusLine = renderedStrings().find((line) => line.startsWith('Bindings: '));
        dispose();

        // Nothing was read to get here, so this *is* the first frame: the
        // status line's count and the list it counts down to agree, and the
        // empty-state text is not what the list is showing (the mount always
        // carries it as the list's `emptyText`, so emptiness is read from the
        // rows actually painted, not from the prop's presence).
        expect(requests).toEqual([]);
        expect(statusLine).toBe('Bindings: 1 (1 enabled) · Accounts: 0');
        expect(painted).toHaveLength(1);
        expect(painted[0]?.title).toBe('acme/widget → prj_42');
    });
});
