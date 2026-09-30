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
import { describe, expect, it, vi } from 'vitest';
import { tabSpecs } from '../src/tab-bodies.ts';
import { utcStamp } from '../src/ids.ts';
import { selectedBindingDetail } from '../src/bindings-rows.ts';
import { PROJECT_REGISTRATION_ROUTES, notListedGuidance } from '../src/project-picker.ts';
import { initialBindings } from '../src/panel-state.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { BindingsTabState } from '../src/panel-state.ts';
import type { BindingStatusRow, PanelBinding } from '../src/bindings-service.ts';
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
 * @returns The handle every `mount*` primitive answers with here.
 */
function sdkHandle(): { readonly update: () => void; readonly dispose: () => void } {
    return {
        update: (): void => {
            mounts.paints += 1;
        },
        dispose: (): void => {
            mounts.disposes += 1;
        },
    };
}

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): ReturnType<typeof sdkHandle> => {
                mounts.log.push({ key, props });

                return sdkHandle();
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
function mountBindingsTab(): {
    /** The runtime the body mounted against. */
    readonly rt: ReturnType<typeof createTestRuntime>;
    /** The spec's disposer, which tears the body down. */
    readonly dispose: () => void;
} {
    mounts.log.length = 0;
    const rt = createTestRuntime(fakeHost());
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
 * Build one binding for the row and detail copy.
 *
 * @param overrides - Fields the test changes.
 * @returns One complete binding.
 */
function bindingFixture(overrides: Partial<PanelBinding> = {}): PanelBinding {
    return {
        bindingId: 'bnd-1',
        accountNumericUserId: '77331',
        accountLogin: 'octocat-mt',
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
 * @param overrides - Fields the test changes.
 * @returns One complete status row.
 */
function statusFixture(overrides: Partial<BindingStatusRow> = {}): BindingStatusRow {
    return {
        bindingId: 'bnd-1',
        repository: 'acme/widget',
        projectId: 'prj_42',
        accountLogin: 'octocat-mt',
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
        const detail = selectedBindingDetail(bindingsState({
            binding: bindingFixture(),
            status: statusFixture(),
            selected: true,
        }));

        expect(detail).toContain('enabled');
        expect(detail).toContain('not scanned yet');
        expect(detail).toContain('0 pending');
        expect(detail).toContain(`created ${utcStamp(FIXTURE_TIMESTAMP)}`);
        expect(detail).toContain(`updated ${utcStamp(FIXTURE_TIMESTAMP)}`);
    });

    it('reports how long ago the last scan ran, and that it was clean', () => {
        const detail = selectedBindingDetail(bindingsState({
            binding: bindingFixture(),
            status: statusFixture({ lastScanAt: new Date(Date.now() - 120_000).toISOString() }),
            selected: true,
        }));

        expect(detail).toContain('scan: 2m ago · ok');
    });

    it('carries the skip reason next to the stamp, and names a disabled row', () => {
        const detail = selectedBindingDetail(bindingsState({
            binding: bindingFixture({ state: 'disabled' }),
            status: statusFixture({ lastError: 'auth-failed', pendingCount: 2 }),
            selected: true,
        }));

        expect(detail).toContain('disabled');
        expect(detail).toContain('auth-failed');
        expect(detail).toContain('2 pending');
    });

    it('says nothing at all when no binding is selected', () => {
        expect(selectedBindingDetail(bindingsState({
            binding: bindingFixture(),
            status: null,
            selected: false,
        }))).toBeNull();
    });
});

describe('AC-112 the picker names every manual route and keeps the binding recoverable', () => {
    it('renders the three registration routes and the recoverable state', () => {
        const { dispose } = mountBindingsTab();
        const guidance = renderedStrings().find((line) => line.startsWith('Not listed?'));
        dispose();

        expect(guidance).toBeDefined();
        for (const route of PROJECT_REGISTRATION_ROUTES) {
            expect(guidance).toContain(route);
        }

        expect(guidance).toContain('stays in its recoverable');
        expect(guidance).toContain('the extension never creates one');
        expect(notListedGuidance()).toContain('Not listed?');
    });

    it('never offers to create a project anywhere in the panel source (FR-089)', () => {
        const root = resolve(import.meta.dirname, '..', 'src');
        const modules = readdirSync(root, { recursive: true }).map(String);
        const callers = modules
            .filter((name) => name.endsWith('.ts'))
            .filter((name) => PROJECT_CREATION_CALL.test(readFileSync(resolve(root, name), 'utf8')));

        expect(callers).toEqual([]);
    });
});

describe('T-023 the Bindings tab speaks the product vocabulary (FR-020)', () => {
    it('renders Bindings copy, never the retired noun, on every control it mounts', () => {
        const { dispose } = mountBindingsTab();
        const strings = renderedStrings();
        dispose();

        expect(strings.some((line) => line.startsWith('Bindings: '))).toBe(true);
        expect(strings).toContain('Bindings');
        expect(strings).toContain('No binding yet — add one below or refresh.');
        expect(strings).toContain('Add binding');
        expect(strings.some((line) => line.includes('Repositories'))).toBe(false);
    });

    it('carries no service-tuning field name anywhere in the bindings modules (FR-059)', () => {
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
    });
});
