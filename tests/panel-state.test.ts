/**
 * Panel runtime state under the six-tab shell (005 T-007; FR-012, FR-015,
 * FR-042, FR-043).
 *
 * The restructure this file pins down is the one a later wave could quietly
 * undo: a second notion of "what is showing", a tab slice that carries its own
 * `activeTab`, or a paging position that survives a filter change. Each is a
 * one-line mistake, so each gets a one-line refusal here.
 */

import { describe, expect, it } from 'vitest';
import {
    createPanelRuntime,
    initialBindings,
    initialDispatches,
    initialProjectPicker,
} from '../src/panel-state.ts';
import {
    initialDispatchFilters,
    initialDispatchListPage,
    resetDispatchListPage,
} from '../src/dispatch-page.ts';
import { fakeHost } from './support/panel.ts';

/** A runtime built the way a fresh mount builds one. */
function freshRuntime(): ReturnType<typeof createPanelRuntime> {
    return createPanelRuntime(fakeHost(), {
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
    });
}

describe('createPanelRuntime (the shell starts on Status, FR-012, FR-015)', () => {
    it('opens on Status with nothing mounted and nothing read', () => {
        {
            const rt = freshRuntime();

            expect(rt.activeTab).toBe('status');
            expect(rt.tabMounted.size).toBe(0);
            expect(rt.tabLastRead.size).toBe(0);
            expect(rt.shell).toBeNull();
        }
        {
            const rt = freshRuntime();

            expect(rt.ui).toBeNull();
            expect(rt.bindingsUi).toBeNull();
            expect(rt.dispatchesUi).toBeNull();
            expect(rt.aboutUi).toBeNull();
            expect(rt.handoffView).toBeNull();
        }
        {
            const first = freshRuntime();
            first.activeTab = 'about';

            const second = freshRuntime();

            expect(second.activeTab).toBe('status');
            expect(second.tabLastRead.size).toBe(0);
        }
    });
});

describe('the tab slices (005 T-007: one activation field, no second one)', () => {
    it('gives the Bindings slice no field that could say what is showing', () => {
        {
            const bindings = initialBindings();

            expect('activeTab' in bindings).toBe(false);
            expect(Object.keys(bindings)).not.toContain('runs');
        }
        {
            const dispatches = initialDispatches();

            expect(dispatches.filters).toEqual({ bindingId: null, state: null });
            expect(dispatches.page.cursorStack).toEqual([null]);
            expect(dispatches.page.pageIndex).toBe(0);
            expect(dispatches.page.total).toBeNull();
            expect(dispatches.page.snapshotAt).toBeNull();
        }
        {
            const rt = freshRuntime();

            expect(rt.state.dispatches.rows).toEqual([]);
            expect('dispatches' in rt.state).toBe(true);
            expect(initialProjectPicker().status).toBe('idle');
        }
    });
});

describe('dispatch page transitions (005 data-model §3.2)', () => {
    it('starts on the first page of the whole set', () => {
        {
            const page = initialDispatchListPage();

            expect(page.cursorStack).toEqual([null]);
            expect(page.pageIndex).toBe(0);
            expect(page.limit).toBe(25);
            expect(page.hasMore).toBe(false);
        }
        {
            const visited = {
                ...initialDispatchListPage(),
                cursorStack: [null, 'cursor-one', 'cursor-two'],
                pageIndex: 2,
                limit: 50,
                hasMore: true,
                total: 250,
                snapshotAt: '2026-09-28T12:00:00.000Z',
            };

            const reset = resetDispatchListPage(visited);

            expect(reset.cursorStack).toEqual([null]);
            expect(reset.pageIndex).toBe(0);
            expect(reset.limit).toBe(50);
            expect(reset.hasMore).toBe(false);
            expect(reset.total).toBeNull();
            expect(reset.snapshotAt).toBeNull();
        }
        {
            expect(initialDispatchFilters()).toEqual({ bindingId: null, state: null });
        }
    });
});
