/**
 * The resolve control's arm repaint must not rebuild the dispatch list, and the
 * list must stay a bounded viewport (005 FR-042, FR-044, `005 AC-167`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
import { mountDispatchesBoard, repaintDispatchesBoard } from '../src/dispatches-ui.ts';
import type { DispatchesBoard } from '../src/dispatches-ui.ts';
import { dispatchEmptyText } from '../src/dispatches-controls.ts';
import { dispatchRows } from '../src/dispatches-rows.ts';
import { initialDispatches } from '../src/panel-state.ts';
import type { DispatchesState, PanelRuntime } from '../src/panel-state.ts';
import { resolveNoSession } from '../src/dispatches.ts';
import { EVENTS_PATH, resolvePath } from '../src/service-calls.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom, FakeElement } from './support/dom.ts';
import { cascadedProperty } from './support/cascade.ts';
import type { ProbeElement } from './support/cascade.ts';
import { parseStylesheet, styleText } from './support/stylesheet.ts';
import type { StyleRule } from './support/stylesheet.ts';
import { createTestRuntime, fakeHost, FIXTURE_TIMESTAMP } from './support/panel.ts';

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                // `mountText` keeps its node so the heading and note are readable;
                // buttons and lists stay handles, which is what the guard is about.
                let written: { textContent: string } | null = null;
                if (key === 'mountText') {
                    const holder = root as {
                        readonly ownerDocument: { createElement: (tag: string) => { textContent: string } };
                        readonly append: (node: { textContent: string }) => void;
                    };
                    const wanted = (props as { readonly text?: unknown }).text;
                    const span = holder.ownerDocument.createElement('span');
                    span.textContent = typeof wanted === 'string' ? wanted : '';
                    holder.append(span);
                    written = span;
                }

                return {
                    update: (patched?: unknown): void => {
                        const text = (patched as { readonly text?: unknown } | undefined)?.text;
                        if (written !== null && typeof text === 'string') {
                            written.textContent = text;
                        }
                    },
                    dispose: (): void => undefined,
                };
            };
        }
    }

    return stubbed;
});

/** Row key the fixture carries; also its attachment id and path segment. */
const RUN_ID = 'mt-run-aaaabbbbccccddddeeeeffff';

/** The selected dispatch block's heading, read back from the tree. */
const SELECTED_HEADING = 'Selected dispatch';

/** The list the Dispatches body mounts, as the stylesheet probe describes it. */
const LIST_PROBE: ProbeElement = { tag: 'div', classes: ['mt-list', 'mt-list--dispatches'] };

/** Media set with no `@media` in force. */
const NO_MEDIA: ReadonlySet<string> = new Set<string>();

/** The shipped panel document, read once for the cascade assertions. */
const PANEL_HTML = readFileSync(resolve(import.meta.dirname, '../panel/index.html'), 'utf8');

/** Its stylesheet, parsed once for the cascade assertions. */
const PANEL_RULES: readonly StyleRule[] = parseStylesheet(styleText(PANEL_HTML));

/** One answer in a service-double route table. */
interface RouteAnswer {
    readonly status: number;
    readonly body: string;
}

/** Route table keyed by `METHOD path`. */
type RouteTable = Readonly<Record<string, RouteAnswer>>;

/** A service double: recorded calls plus a table. */
interface ServiceDouble {
    readonly serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult>;
    readonly calls: readonly string[];
}

/**
 * Build the service double over a `METHOD path` table.
 */
function serviceDouble(table: RouteTable): ServiceDouble {
    const calls: string[] = [];

    return {
        calls,
        serviceRequest: async (request) => {
            calls.push(`${request.method} ${request.path}`);

            return table[`${request.method} ${request.path}`] ?? { status: 404, body: '{}' };
        },
    };
}

/**
 * Build one `unconfirmed` row the way the service projects it.
 */
function unconfirmedRow(): RunRow {
    return {
        id: RUN_ID,
        correlationId: RUN_ID,
        state: 'unconfirmed',
        stateReason: 'the session started but no read-back has landed yet',
        runKey: 'github|77331|acme/api|issue|112|6',
        ordinal: 6,
        attempt: 2,
        attachmentId: RUN_ID,
        projectId: 'prj_42',
        worktreeOption: 'none',
        leaseExpiresAt: null,
        resultDeadlineAt: null,
        sourceReferences: [],
        referenceCount: 0,
        referencesTruncated: false,
        referencesNotRetained: 0,
        session: null,
        verification: null,
        kind: 'assignment',
        repository: 'acme/api',
        issueNumber: 112,
        issueTitle: 'Backfill the audit chain',
        issueUrl: 'https://github.com/acme/api/issues/112',
        detectedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        bindingId: 'bnd_2',
        dispatchResult: null,
        claimedAt: null,
        dispatchedAt: null,
        headSha: null,
        baseRef: null,
        promptPresent: false,
        promptFingerprint: null,
        promptLength: null,
        promptSources: null,
        actorPolicy: null,
    };
}

/** The `page` member a paged answer carries (005 contract §2). */
function pageMember(total: number): Record<string, unknown> {
    return {
        limit: 25,
        nextCursor: null,
        hasMore: false,
        total,
        snapshotAt: FIXTURE_TIMESTAMP,
        filter: { bindingId: null, state: null },
    };
}

/** Body the service answers `GET /v1/events` with for the given rows. */
function runsBody(rows: readonly RunRow[]): string {
    return JSON.stringify({ events: rows, page: pageMember(rows.length) });
}

/** One mounted Dispatches body: the tree, the board, and the runtime that paints it. */
interface Mounted {
    readonly dom: FakeDom;
    readonly board: DispatchesBoard;
    readonly rt: PanelRuntime;
}

/**
 * Mount the Dispatches body over the given state.
 */
function mountBoard(input: {
    readonly runs: DispatchesState;
    readonly table?: RouteTable;
}): Mounted {
    const service = serviceDouble(input.table ?? {});
    const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
    rt.state.dispatches = input.runs;
    const dom = fakeDom();
    const board = mountDispatchesBoard({ rt, pane: dom.root, handlers: createBindingsHandlers(rt) });
    rt.dispatchesUi = board;

    return { dom, board, rt };
}

/** Recover each node's parent from the journal the fake document keeps. */
function parentsOf(dom: FakeDom): Map<FakeElement, FakeElement> {
    const parents = new Map<FakeElement, FakeElement>();
    for (const node of dom.created) {
        for (const child of node.children) {
            parents.set(child, node);
        }
    }

    return parents;
}

/** The `section` an element sits in, following the reconstructed chain. */
function sectionAround(dom: FakeDom, node: FakeElement): FakeElement | undefined {
    const parents = parentsOf(dom);
    let current: FakeElement | undefined = node;
    while (current !== undefined) {
        if (current.tagName === 'section') {
            return current;
        }
        current = parents.get(current);
    }

    return undefined;
}

describe('the list paint guard (FR-042, 005 AC-167)', () => {
    it('arms the resolution and renders its confirm copy without touching the list', async () => {
        const row = unconfirmedRow();
        const { dom, board, rt } = mountBoard({
            runs: { ...initialDispatches(), status: 'ready', rows: [row], selectedRun: row.id },
        });
        const listUpdate = vi.spyOn(board.dispatchesList, 'update');
        const resolveUpdate = vi.spyOn(board.resolveNoSession, 'update');

        await resolveNoSession(rt);

        expect(board.resolveBox.hidden).toBe(false);
        expect(rt.state.dispatches.pendingAction).toBe('resolve-no-session');
        expect(resolveUpdate).toHaveBeenCalledWith({
            label: expect.stringContaining('Confirm: no session was created'),
            disabled: false,
        });
        expect(dom.created.some((node) => node.textContent === rt.state.dispatches.note)).toBe(true);
        expect(rt.state.dispatches.note).toContain('Verify first:');
        expect(listUpdate).not.toHaveBeenCalled();
        expect(board.listPaint).toEqual({
            items: dispatchRows(rt.state.dispatches),
            selectedId: rt.state.dispatches.selectedRun,
            emptyText: dispatchEmptyText(rt.state.dispatches),
        });
    });

    it('posts exactly one request on the second activation', async () => {
        const row = unconfirmedRow();
        const service = serviceDouble({
            [`POST ${resolvePath(RUN_ID)}`]: { status: 200, body: '{"state":"pending"}' },
            [`GET ${EVENTS_PATH}?limit=25`]: { status: 200, body: runsBody([row]) },
        });
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
        rt.state.dispatches = {
            ...initialDispatches(),
            status: 'ready',
            rows: [row],
            selectedRun: row.id,
        };
        const dom = fakeDom();
        const board = mountDispatchesBoard({ rt, pane: dom.root, handlers: createBindingsHandlers(rt) });
        rt.dispatchesUi = board;

        await resolveNoSession(rt);
        expect(service.calls).toEqual([]);

        await resolveNoSession(rt);

        expect(service.calls).toEqual([`POST ${resolvePath(RUN_ID)}`, `GET ${EVENTS_PATH}?limit=25`]);
    });

    it('still paints when the derived items change', () => {
        const row = unconfirmedRow();
        const { board, rt } = mountBoard({
            runs: { ...initialDispatches(), status: 'ready', rows: [row], selectedRun: row.id },
        });
        const listUpdate = vi.spyOn(board.dispatchesList, 'update');

        rt.state.dispatches.rows = [row, { ...row, id: 'mt-run-second', correlationId: 'mt-run-second' }];
        repaintDispatchesBoard(rt, board);

        expect(listUpdate).toHaveBeenCalledTimes(1);
    });

    it('still paints when only the selection changes', () => {
        const row = unconfirmedRow();
        const { board, rt } = mountBoard({
            runs: { ...initialDispatches(), status: 'ready', rows: [row] },
        });
        const listUpdate = vi.spyOn(board.dispatchesList, 'update');

        rt.state.dispatches.selectedRun = row.id;
        repaintDispatchesBoard(rt, board);

        expect(listUpdate).toHaveBeenCalledTimes(1);
    });

    it('still paints when only the filter-dependent empty text changes', () => {
        const { board, rt } = mountBoard({
            runs: { ...initialDispatches(), status: 'ready', rows: [] },
        });
        const listUpdate = vi.spyOn(board.dispatchesList, 'update');

        rt.state.dispatches.filters = { bindingId: null, state: 'failed' };
        repaintDispatchesBoard(rt, board);

        expect(listUpdate).toHaveBeenCalledTimes(1);
        expect(listUpdate).toHaveBeenCalledWith({
            items: [],
            selectedId: null,
            emptyText: 'The filter matched nothing — use Clear filters to show every dispatch.',
        });
    });
});

describe('the bounded list viewport and the Selected block (FR-044, 005 AC-167)', () => {
    it('resolves a finite, viewport-relative max-height and its own overflow-y', () => {
        const maxHeight = cascadedProperty({
            rules: PANEL_RULES,
            element: LIST_PROBE,
            media: NO_MEDIA,
            property: 'max-height',
        });
        const overflow = cascadedProperty({
            rules: PANEL_RULES,
            element: LIST_PROBE,
            media: NO_MEDIA,
            property: 'overflow-y',
        });

        expect(maxHeight).not.toBeNull();
        expect(maxHeight).not.toBe('none');
        expect(maxHeight).toContain('vh');
        expect(Number.isNaN(Number(maxHeight))).toBe(true);
        expect(overflow).toBe('auto');
    });

    it('puts the Selected dispatch block immediately after the block holding the list', () => {
        const row = unconfirmedRow();
        const { dom } = mountBoard({
            runs: { ...initialDispatches(), status: 'ready', rows: [row], selectedRun: row.id },
        });
        const grid = dom.created.find((node) => node.className === 'mt-list mt-list--dispatches');
        const heading = dom.created.find((node) => node.textContent === SELECTED_HEADING);
        expect(grid).toBeDefined();
        expect(heading).toBeDefined();

        const listBlock = grid === undefined ? undefined : sectionAround(dom, grid);
        const selectedBlock = heading === undefined ? undefined : sectionAround(dom, heading);
        const siblings = dom.rootElement.children;
        const index = listBlock === undefined ? -1 : siblings.indexOf(listBlock);

        expect(listBlock).toBeDefined();
        expect(selectedBlock).toBeDefined();
        expect(index).toBeGreaterThanOrEqual(0);
        expect(siblings[index + 1]).toBe(selectedBlock);
        expect(selectedBlock?.className).toContain('mt-block');
    });
});
