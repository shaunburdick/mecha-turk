/**
 * The Dispatches tab's Selected dispatch block, and the Accounts rule it now
 * follows (2026-10-01).
 *
 * Once the three control rows were correctly taken out of the layout, the
 * middle block was the only thing left standing when nothing was selected: a
 * heading over an empty box. Accounts already answers that case — its
 * *Selected account* block disappears as a whole, heading included — and this
 * suite pins the same behaviour on Dispatches, plus the two things the fix
 * must not cost:
 *
 * - the outcome note stays on screen while nothing is selected, because the
 *   status line's `see the note` points at it after a read that failed; and
 * - a row that *is* selected keeps every control it opens — the transition
 *   group, FR-027's resolve group with its session-id field, and the
 *   source-reference detail.
 *
 * Visibility is read from the ancestor chain the fake document can rebuild:
 * `panel/index.html` resolves `[hidden]` to `display: none !important` for
 * every shape the panel hides (pinned by `visual-structure.test.ts`), so
 * "under a hidden ancestor" is the same claim as "not on screen".
 *
 * Offline by construction: the fake host, the fake DOM, and a stubbed SDK —
 * no live OpenChamber, no token, no network (FR-086).
 */

import { describe, expect, it, vi } from 'vitest';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
import { mountDispatchesBoard } from '../src/dispatches-ui.ts';
import type { DispatchesBoard } from '../src/dispatches-ui.ts';
import { initialDispatches } from '../src/panel-state.ts';
import type { DispatchesState, PanelRuntime } from '../src/panel-state.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom } from './support/dom.ts';
import { ISSUE_URL, createTestRuntime, fakeHost } from './support/panel.ts';

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                // The double keeps exactly one DOM effect: `mountText`
                // appends the span the SDK would append, because the fence
                // reads the heading and the note from the tree. Buttons,
                // selects, and fields stay handles with no node of their own,
                // so the control groups *around* them are what a test judges.
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

/** Heading the middle block carries, read back from the tree it renders into. */
const SELECTED_HEADING = 'Selected dispatch';

/** Row key the fixture carries; also its attachment id and path segment. */
const RUN_ID = 'mt-run-aaaabbbbccccddddeeeeffff';

/** Age the fixture row is stamped with, so its cell reads as minutes old. */
const ROW_AGE_MS = 2 * 60_000;

/** The note a failed read leaves behind, and the status line points at. */
const READ_FAILURE_NOTE = 'the list read failed — the service answered 503';

/** Any node the fence can judge: the double's element or the board's handle. */
interface HidableNode {
    /** The `hidden` flag both declarations carry; `until-found` reads as hidden. */
    readonly hidden: boolean | 'until-found';
}

/** One mounted Dispatches body: its tree and its handles. */
interface MountedDispatches {
    /** Fake document the body rendered into. */
    readonly dom: FakeDom;
    /** The board's handles, including the block wrappers the fix toggles. */
    readonly board: DispatchesBoard;
}

/**
 * Build one runs row the way the service projects it.
 */
function runRow(state: RunRow['state']): RunRow {
    return {
        id: RUN_ID,
        correlationId: RUN_ID,
        state,
        stateReason: 'waiting for a panel',
        runKey: 'github|77331|acme/widget|issue|7|0',
        ordinal: 0,
        attempt: 1,
        attachmentId: RUN_ID,
        projectId: 'prj_42',
        worktreeOption: 'generated',
        leaseExpiresAt: null,
        resultDeadlineAt: null,
        sourceReferences: [],
        referenceCount: 0,
        referencesTruncated: false,
        referencesNotRetained: 0,
        session: null,
        verification: null,
        kind: 'assignment',
        repository: 'acme/widget',
        issueNumber: 7,
        issueTitle: 'Fix the flaky test',
        issueUrl: ISSUE_URL,
        detectedAt: new Date(Date.now() - ROW_AGE_MS).toISOString(),
        bindingId: 'bnd-1',
        dispatchResult: null,
        claimedAt: null,
        dispatchedAt: null,
        headSha: null,
        baseRef: null,
        promptPresent: false,
        promptFingerprint: null,
        promptLength: null,
        promptSources: null,
        // No gate has judged this run yet (003 FR-079), so no policy shape exists.
        actorPolicy: null,
    };
}

/**
 * Build the Dispatches state a body mounts with.
 *
 * @returns A ready list holding that single row.
 */
function runsState(input: { readonly state: RunRow['state']; readonly open: boolean }): DispatchesState {
    const row = runRow(input.state);

    return {
        ...initialDispatches(),
        status: 'ready',
        rows: [row],
        selectedRun: input.open ? row.id : null,
    };
}

/**
 * Mount the Dispatches body against a fresh fake document.
 *
 * @param setup - Arranges the state the body mounts with; the default is a
 *   panel that has never read the list.
 * @returns The tree and the board's handles.
 */
function mountBoard(setup?: (rt: PanelRuntime) => void): MountedDispatches {
    const rt = createTestRuntime(fakeHost());
    setup?.(rt);
    const dom = fakeDom();
    const board = mountDispatchesBoard({ rt, pane: dom.root, handlers: createBindingsHandlers(rt) });

    return { dom, board };
}

/**
 * Recover each node's parent from the journal the fake document keeps.
 *
 * The double keeps `parent` private — it is the walk's own bookkeeping — so a
 * test that needs an ancestor chain rebuilds it from `append`. The chain is
 * what proves *where* a node sits: a heading under a hidden block is not on
 * screen, whatever its own flags say.
 *
 * @returns Every child mapped to the node that appended it.
 */
function parentsOf(dom: FakeDom): Map<HidableNode, HidableNode> {
    const parents = new Map<HidableNode, HidableNode>();
    for (const node of dom.created) {
        for (const child of node.children) {
            parents.set(child, node);
        }
    }

    return parents;
}

/**
 * Whether the panel has taken a node out of the layout.
 *
 * @param parents - The ancestor index {@link parentsOf} built.
 * @param node - Node to judge, following it up to the mount root.
 * @returns `true` when the node itself, or any ancestor, is hidden.
 */
function isOutOfLayout(parents: Map<HidableNode, HidableNode>, node: HidableNode): boolean {
    let current: HidableNode | undefined = node;
    while (current !== undefined) {
        // Only `false` means "in the layout": `until-found` is the flag that
        // keeps a node out until a search reaches it, so it reads as hidden.
        if (current.hidden !== false) {
            return true;
        }
        current = parents.get(current);
    }

    return false;
}

/**
 * The node the panel rendered `text` into.
 *
 * The heading's own words live in the span `mountText` appended, so a missing
 * answer is a heading the panel never mounted at all — a failure that says so
 * rather than an `undefined` assertion downstream.
 *
 * @returns The first node carrying it.
 * @throws {Error} When no node carries the text.
 */
function textIn(dom: FakeDom, text: string): HidableNode {
    const found = dom.created.find((node) => node.textContent === text);
    if (found === undefined) {
        throw new Error(`no node in the mounted tree carries ${JSON.stringify(text)}`);
    }

    return found;
}

describe('the Selected dispatch block disappears when nothing is selected (Accounts rule)', () => {
    it('takes the whole block, heading included, out of the layout', () => {
        {
            const { dom, board } = mountBoard();
            const heading = textIn(dom, SELECTED_HEADING);

            expect(isOutOfLayout(parentsOf(dom), heading)).toBe(true);
            expect(board.selectedBox.hidden).toBe(true);
        }
        {
            const { dom, board } = mountBoard((rt) => {
                rt.state.dispatches = { ...initialDispatches(), status: 'error', note: READ_FAILURE_NOTE };
            });
            const note = textIn(dom, READ_FAILURE_NOTE);

            expect(board.selectedBox.hidden).toBe(true);
            expect(isOutOfLayout(parentsOf(dom), note)).toBe(false);
        }
    });
});

describe('a selected dispatch keeps every control its row opens', () => {
    it('shows the block, the retry group, and the source-reference detail for a failed row', () => {
        {
            const { dom, board } = mountBoard((rt) => {
                rt.state.dispatches = runsState({ state: 'failed', open: true });
            });
            const parents = parentsOf(dom);

            expect(board.selectedBox.hidden).toBe(false);
            expect(isOutOfLayout(parents, textIn(dom, SELECTED_HEADING))).toBe(false);
            expect(board.retryRunBox.hidden).toBe(false);
            expect(isOutOfLayout(parents, board.retryRunBox)).toBe(false);
            expect(board.controls.detailBox.hidden).toBe(false);
            expect(isOutOfLayout(parents, board.controls.detailBox)).toBe(false);
            // FR-027's group is a different row's control: it stays out rather
            // than greying out, because a disabled control still promises a send.
            expect(board.resolveBox.hidden).toBe(true);
        }
        {
            const { dom, board } = mountBoard((rt) => {
                rt.state.dispatches = runsState({ state: 'unconfirmed', open: true });
            });
            const parents = parentsOf(dom);

            expect(board.selectedBox.hidden).toBe(false);
            expect(board.resolveBox.hidden).toBe(false);
            expect(isOutOfLayout(parents, board.resolveBox)).toBe(false);
            expect(isOutOfLayout(parents, textIn(dom, SELECTED_HEADING))).toBe(false);
            expect(board.retryRunBox.hidden).toBe(true);
        }
    });
});
