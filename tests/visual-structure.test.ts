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
 * - **Hidden** — an element the shell hid is out of the layout, whichever
 *   author rule would otherwise paint it (`.mt-block`, the SDK's button, or an
 *   inline `style.display`).
 * - **The width regimes** — the Settings header is `none` over the
 *   one-column rail and a grid only under the 900px query, which is the
 *   answer source order gives and not the one the 560px frame got.
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
import { cascadedDisplay } from './support/cascade.ts';
import type { ProbeElement } from './support/cascade.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';
import { mediaVariants, parseStylesheet, styleText } from './support/stylesheet.ts';
import type { StyleRule } from './support/stylesheet.ts';

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

/** Panel-level handler the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
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
            actorPolicy: 'open',
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
            actorPolicy: 'open',
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

/** The shipped panel document, read once for every assertion that reads it. */
const PANEL_HTML = readFileSync(resolve(import.meta.dirname, '../panel/index.html'), 'utf8');

/** Its stylesheet, parsed once for every cascade assertion below. */
const PANEL_RULES = parseStylesheet(styleText(PANEL_HTML));

/** Every selector in the sheet that can take a hidden element out of a layout. */
const HIDING_SELECTORS: readonly string[] = ['[hidden]', '[data-body][hidden]'];

/** The media set with no `@media` in force, for an unguarded reading. */
const NO_MEDIA: ReadonlySet<string> = new Set<string>();

/**
 * The stylesheet with the named hiding rules stripped — the panel as it was
 * before them, which is the answer a non-vacuity case must fall back to.
 *
 * @param selectors - A rule is dropped when it carries any of these.
 * @returns The rules that are left, in their original order.
 */
function withoutHidingRules(source: readonly StyleRule[], selectors: readonly string[]): readonly StyleRule[] {
    return source.filter((rule) => rule.selectors.every((selector) => !selectors.includes(selector)));
}

/** The Settings header's modifier, which the narrow default and the wide return share. */
const SETTINGS_HEAD_SELECTOR = '.mt-head--settings';

/**
 * The stylesheet with the Settings header's narrow default stripped.
 *
 * This is the reading a non-vacuity case falls back to: with the rule gone
 * `.mt-head`'s `display: grid` is the only declaration left, so a narrow
 * assertion that still answered `none` would be asserting nothing.
 *
 * @returns Every rule but the unguarded one, in their original order.
 */
function withoutNarrowDefault(rules: readonly StyleRule[]): readonly StyleRule[] {
    return rules.filter((rule) => !(rule.media === null && rule.selectors.includes(SETTINGS_HEAD_SELECTOR)));
}

/**
 * The service's answers: one status document, and nothing else.
 *
 * The other reads fail closed on purpose — a tab that only renders when every
 * route answers is a tab that has not been tested against a service that is
 * still spawning (FR-003).
 *
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
        {
            const { dom } = await renderSixTabs();
            const levels = dom.created
                .filter((node) => /^h[1-6]$/.test(node.tagName))
                .map((node) => Number(node.tagName.slice(1)));

            expect(levels.filter((level) => level === 2).length).toBeGreaterThanOrEqual(15);
            expect(levels.every((level) => level === 2 || level === 3)).toBe(true);
            expect(levels).not.toContain(1);
        }
    });

    it('hands each section heading to the SDK text path, so the scans still see it', async () => {
        {
            const { log } = await renderSixTabs();
            const strings = stringsIn(log);

            for (const heading of SECTION_HEADINGS) {
                expect(strings, `${heading} never reached the SDK`).toContain(heading);
            }
        }
    });

    it('keeps the strip contract the A3 pass pinned', async () => {
        {
            expect(PANEL_HTML).toMatch(/#root > \* \{\s*flex-shrink: 0;\s*\}/);
            expect(PANEL_HTML).toMatch(/#root \{[^}]*display: flex;/);
            expect(PANEL_HTML).toMatch(/#root \{[^}]*flex-direction: column;/);
        }
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

/**
 * Settings is one column on a rail, and a header over it would only stack
 * three labels the rows below cannot line up under — so the header is a
 * wide-viewport enhancement, hidden until the query block 2 declares the
 * `18rem | 1fr | 15rem` return under.
 *
 * The 560px frame caught the opposite: `Field` / `Value` / `Shape and
 * default` painted as three orphaned words over the single column, because
 * `.mt-head--settings` used to be declared *before* `.mt-head` at equal
 * specificity (0,1,0) and the later `display: grid` won. What is pinned here
 * is therefore the cascade's answer at each width — the fix is the rule's
 * position, so a later equal-specificity rule that undoes it again is caught
 * here rather than in a screenshot.
 */
describe('the Settings header is hidden over the single-column rail', () => {
    /** The `@media` prelude block 2 declares the three-column return under. */
    const WIDE = '@media (min-width: 900px)';

    /** The header as `src/settings-mount.ts` mounts it: two class words. */
    const settingsHead: ProbeElement = {
        tag: 'div',
        classes: ['mt-head', 'mt-head--settings'],
        position: 1,
        childCount: 3,
    };

    /**
     * Resolve the header's `display` under one set of media.
     *
     * @param media - The media preludes in force.
     * @returns The winning declaration, or null when none declares `display`.
     */
    function settingsHeadDisplay(media: ReadonlySet<string>): string | null {
        return cascadedDisplay({ rules: PANEL_RULES, element: settingsHead, media });
    }

    it('reads the narrow default and the wide return as two distinct rules', () => {
        {
            const narrow = PANEL_RULES.filter(
                (rule) => rule.media === null && rule.selectors.includes(SETTINGS_HEAD_SELECTOR),
            );
            const wide = PANEL_RULES.filter(
                (rule) => rule.media === WIDE && rule.selectors.includes(SETTINGS_HEAD_SELECTOR),
            );

            expect(narrow, 'the unguarded narrow default').toHaveLength(1);
            expect(wide, 'the guarded wide return').toHaveLength(1);
            expect(mediaVariants(PANEL_RULES).some((media) => media.has(WIDE))).toBe(true);
            expect(mediaVariants(PANEL_RULES).some((media) => !media.has(WIDE))).toBe(true);
        }
        {
            for (const media of mediaVariants(PANEL_RULES)) {
                if (media.has(WIDE)) {
                    continue;
                }

                const reading = [...media].join(', ');

                expect(settingsHeadDisplay(media), `settings head at ${reading === '' ? 'the rail' : reading}`).toBe(
                    'none',
                );
            }
        }
        {
            for (const media of mediaVariants(PANEL_RULES)) {
                if (!media.has(WIDE)) {
                    continue;
                }

                expect(settingsHeadDisplay(media), `settings head at ${[...media].join(', ')}`).toBe('grid');
            }
        }
        {
            const without = withoutNarrowDefault(PANEL_RULES);

            expect(without).toHaveLength(PANEL_RULES.length - 1);
            expect(
                cascadedDisplay({ rules: without, element: settingsHead, media: NO_MEDIA }),
                'the header the stripped sheet would paint',
            ).toBe('grid');
        }
    });
});

describe('the Status tab renders structure instead of loose lines', () => {
    it('renders definition rows and one card per prerequisite', async () => {
        {
            const { dom } = await renderSixTabs();
            const rows = dom.created.filter(
                (node) => node.className === 'mt-def' || node.className === 'mt-def mt-def--note',
            );
            const cards = dom.created.filter((node) => node.className === 'mt-card');

            expect(rows.length).toBeGreaterThanOrEqual(14);
            expect(cards).toHaveLength(5);
        }
    });

    it('paints the three prerequisite states as toned chips carrying the state', async () => {
        {
            const { log } = await renderSixTabs();
            const badges = log.filter((entry) => entry.key === 'mountBadge').map(
                (entry) => entry.props as { readonly label?: string; readonly tone?: string },
            );

            expect(badges.length).toBeGreaterThanOrEqual(5);
            for (const tone of ['success', 'error', 'neutral']) {
                expect(badges.some((badge) => badge.tone === tone), `no chip carries the ${tone} tone`).toBe(true);
            }

        }
    });

});

/**
 * The shell paints with the `hidden` attribute; only the cascade can take a
 * body out of the layout. The defect the screenshot harness caught was here:
 * the author rule `[data-body] { display: flex }` outranks the UA sheet's
 * `[hidden]`, so all six bodies stayed in the region, its `scrollHeight` summed
 * them, and a tab click moved only the pill. The fake DOM this suite mounts
 * into computes no styles, so these assertions read the shipped stylesheet and
 * resolve it instead — and the last case proves the fence is not vacuous.
 */
describe('exactly one tab body is in the layout', () => {
    const rules = PANEL_RULES;

    /** The region the six bodies hang from, as `src/tabs.ts` builds it. */
    const region: ProbeElement = {
        tag: 'div',
        attributes: Object.fromEntries([['data-body-region', 'true']]),
        childCount: TAB_IDS.length,
    };

    /**
     * One body container: classless, so only attribute selectors can reach it.
     *
     * @returns The element the cascade is asked about.
     */
    function bodyProbe(input: { readonly id: string; readonly hidden: boolean }): ProbeElement {
        const attributes: Record<string, string> = { role: 'tabpanel' , ['data-body']: input.id, };

        if (input.hidden) {
            attributes.hidden = '';
        }

        return {
            tag: 'div',
            classes: [],
            attributes,
            position: 1,
            childCount: TAB_IDS.length,
            parent: region,
        };
    }

    /**
     * Resolve one body's `display` under one set of media.
     *
     * @returns The winning `display`, or null when no rule declares one.
     */
    function displayOf(input: {
        readonly id: string;
        readonly hidden: boolean;
        readonly media: ReadonlySet<string>;
    }): string | null {
        return cascadedDisplay({
            rules,
            element: bodyProbe({ id: input.id, hidden: input.hidden }),
            media: input.media,
        });
    }

    it('parses a real stylesheet rather than a fragment of one', () => {
        {
            expect(rules.length).toBeGreaterThan(30);
            expect(mediaVariants(rules).length).toBeGreaterThan(1);
        }
        {
            for (const media of mediaVariants(rules)) {
                for (const id of TAB_IDS) {
                    const joined = [...media].join(', ');
                    const reading = joined === '' ? 'no media' : joined;

                    expect(displayOf({ id, hidden: true, media }), `${id} hidden at ${reading}`).toBe('none');
                }
            }
        }
        {
            for (const media of mediaVariants(rules)) {
                expect(displayOf({ id: 'status', hidden: false, media }), 'status shown').toBe('flex');
            }
        }
        {
            const without = withoutHidingRules(rules, HIDING_SELECTORS);

            expect(without).toHaveLength(rules.length - HIDING_SELECTORS.length);
            expect(
                cascadedDisplay({
                    rules: without,
                    element: bodyProbe({ id: 'settings', hidden: true }),
                    media: NO_MEDIA,
                }),
            ).toBe('flex');
        }
    });
});

/**
 * The SDK's own sheet, at the one declaration that painted a hidden button.
 *
 * `@openchamber/sdk` injects this into the same document, so it competes as
 * an author rule like any other — but it does not live in `panel/index.html`,
 * and without it the button case below would resolve against nothing at all
 * rather than against the `inline-flex` the live panel computed.
 */
const SDK_SHEET = '.oc-sdk-btn { display: inline-flex; }';

/** The panel's stylesheet read with the SDK's, as one document's rules. */
const COMBINED_RULES = parseStylesheet(`${styleText(PANEL_HTML)}\n${SDK_SHEET}`);

/** One shape the sweep found: what it is, and what it painted while hidden. */
interface HiddenShape {
    /** How the case names itself in a failure message. */
    readonly name: string;
    /** Lower-case tag name. */
    readonly tag: string;
    /** Class words the element carries. */
    readonly classes: readonly string[];
    /** The `style` attribute's text, when the element writes one inline. */
    readonly style?: string;
    /** The `display` it computed while the panel had it hidden. */
    readonly painted: string;
}

/** The three shapes behind the five painted elements the sweep found. */
const HIDDEN_SHAPES: readonly HiddenShape[] = [
    { name: 'section.mt-block', tag: 'section', classes: ['mt-block'], painted: 'flex' },
    { name: 'button.oc-sdk-btn', tag: 'button', classes: ['oc-sdk', 'oc-sdk-btn'], painted: 'inline-flex' },
    { name: 'inline style.display', tag: 'div', classes: [], style: 'display: flex', painted: 'flex' },
];

/**
 * One of those shapes as the cascade sees it.
 *
 * @returns The probe to resolve a `display` for.
 */
function shapeProbe(shape: HiddenShape, isHidden: boolean): ProbeElement {
    const attributes: Record<string, string> = {};

    if (isHidden) {
        attributes.hidden = '';
    }

    if (shape.style !== undefined) {
        attributes.style = shape.style;
    }

    return { tag: shape.tag, classes: shape.classes, attributes, position: 1, childCount: 1 };
}

/**
 * The `[hidden]` fence, and the shapes behind every element it hides.
 *
 * A sweep of the live panel at `219f093` found five elements carrying the
 * `hidden` attribute that the cascade still gave a box, all with the tab
 * body's root cause: the UA sheet's `[hidden] { display: none }` is
 * origin-weak, so an author rule naming the element paints it anyway.
 * `section.mt-block` answered `flex`, the SDK's `button.oc-sdk-btn` answered
 * `inline-flex`, and three plain Dispatches control rows answered `flex` from
 * an inline `style.display`.
 *
 * `panel/index.html` closes the class in one rule —
 * `[hidden] { display: none !important }` — whose `!important` is what makes
 * it one rule: importance is compared before specificity, before source
 * order, and before the style attribute, so no *normal* author declaration
 * from any stylesheet can reach an element the panel marked hidden.
 */
describe('no element the panel hid is still painted', () => {
    it('takes every hidden one out of the layout, under every media reading', () => {
        {
            for (const media of mediaVariants(COMBINED_RULES)) {
                const joined = [...media].join(', ');
                const reading = joined === '' ? 'no media' : joined;

                for (const shape of HIDDEN_SHAPES) {
                    expect(
                        cascadedDisplay({ rules: COMBINED_RULES, element: shapeProbe(shape, true), media }),
                        `${shape.name} hidden at ${reading}`,
                    ).toBe('none');
                }
            }
        }
        {
            for (const shape of HIDDEN_SHAPES) {
                expect(
                    cascadedDisplay({ rules: COMBINED_RULES, element: shapeProbe(shape, false), media: NO_MEDIA }),
                    `${shape.name} shown`,
                ).toBe(shape.painted);
            }
        }
        {
            const without = withoutHidingRules(COMBINED_RULES, ['[hidden]']);

            expect(without).toHaveLength(COMBINED_RULES.length - 1);
            for (const shape of HIDDEN_SHAPES) {
                expect(
                    cascadedDisplay({ rules: without, element: shapeProbe(shape, true), media: NO_MEDIA }),
                    `${shape.name} without the fence`,
                ).toBe(shape.painted);
            }
        }
    });
});
