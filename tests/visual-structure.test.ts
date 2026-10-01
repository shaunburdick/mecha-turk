/**
 * The visual system the redesign builds every tab from (2026-09-30).
 *
 * Pixels are judged in a browser; what this suite pins is the *structure*
 * those pixels come from, so a later edit cannot quietly flatten a tab back
 * into a column of loose lines:
 *
 * - **Blocks** — every section is a real `h2`, its heading text handed to the
 *   SDK's text path (so the hostile-text and vocabulary scans still see it),
 *   and no tab skips a level or reaches for an `h1`.
 * - **Rows** — the Status tab renders definition rows and prerequisite cards,
 *   and each list surface carries the header row its columns hang from.
 * - **Chips** — the prerequisite states reach the DOM as toned badges, in all
 *   three tones FR-072 allows, with the state in the label (FR-083).
 * - **The strip contract** — the layout rules the A3 pass pinned are still in
 *   `panel/index.html`, because a redesign that squeezes the tab strip is a
 *   redesign that broke the panel.
 *
 * Offline by construction: the fake host, the fake DOM, and a recorded SDK —
 * no live OpenChamber, no token, no network (FR-086).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import { loadStatus } from '../src/status-tab.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom } from './support/dom.ts';
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

/** One SDK mount record, as the mock logged it. */
interface MountRecord {
    /** Primitive name (`mountText`, `mountBadge`, …). */
    readonly key: string;
    /** Whatever it was handed. */
    readonly props: unknown;
}

/** The six tabs FR-010 puts in the strip, in strip order. */
const TAB_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'] as const;

/** Picker callbacks the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** Stamp the fixture document's next poll points at. */
const FUTURE_STAMP = '2099-01-01T00:00:00.000Z';

/** The account every fixture row names, written once for the duplicate count. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** One healthy `GET /v1/status` document, shaped for `parseStatusView`. */
const STATUS_BODY = JSON.stringify({
    service: {
        status: 'ok',
        uptimeMs: 61_000,
        dataDir: '/home/agent/.config/openchamber/mecha-turk',
        schemaVersion: 1,
        storage: { writable: true },
    },
    accounts: [
        {
            numericUserId: '77331',
            login: ACCOUNT_LOGIN,
            connectionState: 'connected',
            rate: { remaining: null, limit: null, resetAt: null, usedLastHour: 0 },
            streams: [],
        },
        {
            numericUserId: '331468173',
            login: 'prompt-it-so',
            connectionState: 'needs reconnection',
            rate: { remaining: null, limit: null, resetAt: null, usedLastHour: 0 },
            streams: [],
        },
    ],
    repositories: [
        {
            bindingId: 'bnd_1',
            repository: 'acme/widget',
            projectId: 'prj_42',
            accountLogin: ACCOUNT_LOGIN,
            active: true,
            lastScanAt: '2026-09-28T12:00:00.000Z',
            lastError: null,
            pendingCount: 2,
            readable: true,
        },
        {
            bindingId: 'bnd_2',
            repository: 'acme/api',
            projectId: 'prj_42',
            accountLogin: ACCOUNT_LOGIN,
            active: true,
            lastScanAt: '2026-09-28T12:00:00.000Z',
            lastError: 'rate limit reached: 41 requests remaining in this window',
            pendingCount: 0,
            readable: true,
        },
    ],
    agentPin: { expectedAgent: 'project-manager', lastVerification: null },
    polling: { intervalMs: 60_000, nextPollAt: FUTURE_STAMP, paused: false, pausedReason: '' },
    surface: { supported: true },
});

/** Section headings every tab mounts, across all six. */
const SECTION_HEADINGS: readonly string[] = [
    'Service',
    'Polling',
    'Agent pin',
    'Setup prerequisites',
    'Selected dispatch',
    'Audit trail',
    'Binding editor',
    'Connect an account',
    'Selected account',
    'Configuration',
    'Save',
    'Diagnostics (read-only)',
];

/** The header row each list surface labels its columns with. */
const HEADER_CELLS: readonly (readonly [string, readonly string[]])[] = [
    ['mt-head--dispatches', ['Trigger', 'Subject', 'State', 'Age']],
    ['mt-head--bindings', ['State', 'Repository and project', 'Pending']],
    ['mt-head--accounts', ['Lifecycle', 'Account', 'Bindings']],
    ['mt-head--settings', ['Field', 'Value', 'Shape and default']],
];

/**
 * The service's answers: one status document, and nothing else.
 *
 * The other reads fail closed on purpose — a tab that only renders when every
 * route answers is a tab that has not been tested against a service that is
 * still spawning (FR-003).
 *
 * @param request - The call the panel made.
 * @returns The answer for that path.
 */
async function answer(request: GuestRequest): Promise<GuestRequestResult> {
    if (request.path.startsWith('/v1/status')) {
        return { status: 200, body: STATUS_BODY };
    }

    return { status: 404, body: '{}' };
}

/**
 * Mount all six tabs once and collect everything the render produced.
 *
 * @returns The created elements and the recorded SDK mounts.
 */
async function renderSixTabs(): Promise<{ readonly dom: FakeDom; readonly log: readonly MountRecord[] }> {
    mounts.log.length = 0;
    const host = fakeHost({ serviceRequest: answer });
    const rt = createTestRuntime(host);
    const dom = fakeDom();
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });
    for (const id of TAB_IDS) {
        rt.shell?.activate(id);
    }

    // The app reads the projection once at mount (app.ts); the shell alone
    // does not, so the Status rows would render empty without this.
    await loadStatus(rt);
    await tick();
    const log = [...mounts.log];
    rt.shell?.dispose();

    return { dom, log };
}

/**
 * Every string one SDK mount was handed, at any depth.
 *
 * @param log - The recorded mounts.
 * @returns The strings among them, in property order.
 */
function stringsIn(log: readonly MountRecord[]): readonly string[] {
    const found: string[] = [];
    const walk = (value: unknown): void => {
        if (typeof value === 'string') {
            found.push(value);

            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item);
            }

            return;
        }

        if (typeof value === 'object' && value !== null) {
            for (const item of Object.values(value)) {
                walk(item);
            }
        }
    };

    for (const entry of log) {
        walk(entry.props);
    }

    return found;
}

describe('every tab is a stack of blocks with a real heading', () => {
    it('mounts at least one heading per section, and never skips a level', async () => {
        const { dom } = await renderSixTabs();
        const levels = dom.created
            .filter((node) => /^h[1-6]$/.test(node.tagName))
            .map((node) => Number(node.tagName.slice(1)));

        expect(levels.filter((level) => level === 2).length).toBeGreaterThanOrEqual(15);
        expect(levels.every((level) => level === 2 || level === 3)).toBe(true);
        expect(levels).not.toContain(1);
    });

    it('hands each section heading to the SDK text path, so the scans still see it', async () => {
        const { log } = await renderSixTabs();
        const strings = stringsIn(log);

        for (const heading of SECTION_HEADINGS) {
            expect(strings, `${heading} never reached the SDK`).toContain(heading);
        }
    });

    it('keeps the strip contract the A3 pass pinned', () => {
        const html = readFileSync(resolve(import.meta.dirname, '../panel/index.html'), 'utf8');

        expect(html).toMatch(/#root > \* \{\s*flex-shrink: 0;\s*\}/);
        expect(html).toMatch(/#root \{[^}]*display: flex;/);
        expect(html).toMatch(/#root \{[^}]*flex-direction: column;/);
    });
});

describe('the list surfaces carry the header rows their columns hang from', () => {
    it('mounts a labelled header for each of the four grids', async () => {
        const { dom } = await renderSixTabs();
        const heads = dom.created.filter((node) => node.className.startsWith('mt-head mt-head--'));
        const cellsOf = (modifier: string): readonly string[] => {
            const head = heads.find((node) => node.className.includes(modifier));

            return head === undefined ? [] : head.children.map((cell) => cell.textContent);
        };

        expect(heads.length).toBeGreaterThanOrEqual(HEADER_CELLS.length);
        for (const [modifier, cells] of HEADER_CELLS) {
            expect(cellsOf(modifier), modifier).toEqual(cells);
        }
    });
});

describe('the Status tab renders structure instead of loose lines', () => {
    it('renders definition rows and one card per prerequisite', async () => {
        const { dom } = await renderSixTabs();
        const rows = dom.created.filter(
            (node) => node.className === 'mt-def' || node.className === 'mt-def mt-def--note',
        );
        const cards = dom.created.filter((node) => node.className === 'mt-card');

        expect(rows.length).toBeGreaterThanOrEqual(14);
        expect(cards).toHaveLength(6);
    });

    it('paints the three prerequisite states as toned chips carrying the state', async () => {
        const { log } = await renderSixTabs();
        const badges = log.filter((entry) => entry.key === 'mountBadge').map(
            (entry) => entry.props as { readonly label?: string; readonly tone?: string },
        );

        expect(badges.length).toBeGreaterThanOrEqual(6);
        for (const tone of ['success', 'error', 'neutral']) {
            expect(badges.some((badge) => badge.tone === tone), `no chip carries the ${tone} tone`).toBe(true);
        }

        expect(badges.map((badge) => badge.label)).toContain('not checkable by the panel');
    });
});
