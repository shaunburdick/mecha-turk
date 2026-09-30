/**
 * The Dispatches list's paged read (005 T-015; FR-042, FR-043, AC-121).
 *
 * Three things are asserted here and nowhere else: the query the client builds
 * carries only what the operator chose (a cursor only past page one, a filter
 * only when it is on), the answer is refused as a whole when its `page` label
 * is missing or out of contract, and the paging position survives a failed
 * read instead of stranding the tab on a page it cannot show.
 *
 * Everything is offline: a recorded service double, no host, no network
 * (FR-086).
 */

import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { dispatchListPath, loadDispatches } from '../src/dispatches.ts';
import {
    clearFilters,
    nextPage,
    previousPage,
    setBindingFilter,
    setPageLimit,
} from '../src/dispatches-paging.ts';
import { parseDispatchListBody } from '../src/dispatches-list.ts';
import {
    advanceDispatchPage,
    cursorFor,
    dispatchListPageAt,
    initialDispatchListPage,
    recordDispatchPageMeta,
    resetDispatchListPage,
    retreatDispatchPage,
} from '../src/dispatch-page.ts';
import { initialDispatches } from '../src/panel-state.ts';
import type { DispatchesState, PanelRuntime } from '../src/panel-state.ts';
import { FIXTURE_TIMESTAMP, createTestRuntime, fakeHost, tick } from './support/panel.ts';

/** Boundary token the second page starts from. */
const CURSOR_ONE = 'cursor-for-page-two';

/** Boundary token the third page starts from. */
const CURSOR_TWO = 'cursor-for-page-three';

/** Boundary a re-read supplies after the operator stepped back. */
const CURSOR_ONE_AGAIN = 'cursor-for-page-two-again';

/** Path the first page of the unfiltered set is read from. */
const PAGE_ONE = 'GET /v1/events?limit=25';

/** The same path without the method the service double's key adds. */
const PAGE_ONE_PATH = '/v1/events?limit=25';

/** Path a fifty-row first page is read from. */
const PAGE_ONE_WIDE = 'GET /v1/events?limit=50';

/** Path the first page of the binding-filtered set is read from. */
const PAGE_ONE_FILTERED = 'GET /v1/events?limit=25&bindingId=bnd_one';

/**
 * The `page` member a fixture answer carries.
 *
 * @param overrides - Members to replace.
 * @returns The member.
 */
function pageMember(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        limit: 25,
        nextCursor: null,
        hasMore: false,
        total: 0,
        snapshotAt: FIXTURE_TIMESTAMP,
        filter: { bindingId: null, state: null },
        ...overrides,
    };
}

/**
 * Build a paged answer body.
 *
 * @param rows - The `events` array.
 * @param page - The `page` member.
 * @returns The serialized body.
 */
function answerBody(rows: readonly unknown[], page: Record<string, unknown>): string {
    return JSON.stringify({ events: rows, page });
}

/**
 * Build a section state with the paging position a test needs.
 *
 * @param page - The position to start from.
 * @param filters - Filters to apply.
 * @returns The section state.
 */
function section(
    page: DispatchesState['page'] = initialDispatchListPage(),
    filters: DispatchesState['filters'] = { bindingId: null, state: null },
): DispatchesState {
    return { ...initialDispatches(), page, filters };
}

/**
 * Build a runtime whose service answers one recorded route table.
 *
 * @param table - Answers keyed by `METHOD path`.
 * @returns The runtime and the calls the service saw.
 */
function doubleRuntime(table: Record<string, { status: number; body: string }>): {
    readonly rt: PanelRuntime;
    readonly calls: string[];
} {
    const calls: string[] = [];
    const rt = createTestRuntime(fakeHost({
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            calls.push(`${request.method} ${request.path}`);
            const answer = table[`${request.method} ${request.path}`];

            return answer ?? { status: 404, body: '{}' };
        },
    }));

    return { rt, calls };
}

describe('dispatchListPath (005 contract §1)', () => {
    it('always names the page size and nothing else when nothing is chosen', () => {
        expect(dispatchListPath(section())).toBe(PAGE_ONE_PATH);
    });

    it('carries the cursor only once the operator has stepped past page one', () => {
        const page = recordDispatchPageMeta(initialDispatchListPage(), {
            nextCursor: CURSOR_ONE,
            hasMore: true,
            total: 40,
            snapshotAt: FIXTURE_TIMESTAMP,
        });
        const advanced = advanceDispatchPage(page);

        expect(cursorFor(advanced)).toBe(CURSOR_ONE);
        expect(dispatchListPath(section(advanced))).toBe(`${PAGE_ONE_PATH}&cursor=${CURSOR_ONE}`);
    });

    it('carries each filter only while it is on, and both when both are', () => {
        const on = { bindingId: 'bnd_one', state: 'blocked:project-missing' };
        expect(dispatchListPath(section(initialDispatchListPage(), on)))
            .toBe(`${PAGE_ONE_PATH}&bindingId=bnd_one&state=blocked%3Aproject-missing`);
    });

    it('quotes a cursor so an opaque token never breaks the query', () => {
        const page = recordDispatchPageMeta(initialDispatchListPage(), {
            nextCursor: 'a b&c',
            hasMore: true,
            total: null,
            snapshotAt: FIXTURE_TIMESTAMP,
        });

        expect(dispatchListPath(section(advanceDispatchPage(page)))).toContain('cursor=a%20b%26c');
    });
});

describe('the paging position machine (data-model §3.2)', () => {
    it('starts on page one with the default size and no boundary', () => {
        const page = initialDispatchListPage();

        expect(cursorFor(page)).toBeNull();
        expect(page.pageIndex).toBe(0);
        expect(page.limit).toBe(25);
    });

    it('advances on the boundary the answer supplied and retreats on demand', () => {
        const first = recordDispatchPageMeta(initialDispatchListPage(), {
            nextCursor: CURSOR_ONE,
            hasMore: true,
            total: null,
            snapshotAt: FIXTURE_TIMESTAMP,
        });
        const second = advanceDispatchPage(first);
        const third = advanceDispatchPage(
            recordDispatchPageMeta(second, {
                nextCursor: CURSOR_TWO,
                hasMore: true,
                total: null,
                snapshotAt: FIXTURE_TIMESTAMP,
            }),
        );

        expect(third.cursorStack).toEqual([null, CURSOR_ONE, CURSOR_TWO]);
        expect(cursorFor(third)).toBe(CURSOR_TWO);

        const back = retreatDispatchPage(third);
        expect(cursorFor(back)).toBe(CURSOR_ONE);
        expect(cursorFor(retreatDispatchPage(retreatDispatchPage(back)))).toBeNull();
        expect(retreatDispatchPage(initialDispatchListPage()).pageIndex).toBe(0);
    });

    it('refuses to advance with no boundary, and truncates the abandoned tail', () => {
        const stuck = advanceDispatchPage(initialDispatchListPage());
        expect(stuck.pageIndex).toBe(0);

        const second = advanceDispatchPage(
            recordDispatchPageMeta(initialDispatchListPage(), {
                nextCursor: CURSOR_ONE,
                hasMore: true,
                total: null,
                snapshotAt: FIXTURE_TIMESTAMP,
            }),
        );
        const third = advanceDispatchPage(
            recordDispatchPageMeta(second, {
                nextCursor: CURSOR_TWO,
                hasMore: true,
                total: null,
                snapshotAt: FIXTURE_TIMESTAMP,
            }),
        );
        expect(third.cursorStack).toEqual([null, CURSOR_ONE, CURSOR_TWO]);

        // A re-read after stepping back relabels the next boundary; advancing
        // again must keep the tail the operator can still reach and drop the
        // one they walked past, or a stale cursor would skip rows silently.
        const relabelled = recordDispatchPageMeta(retreatDispatchPage(third), {
            nextCursor: CURSOR_ONE_AGAIN,
            hasMore: true,
            total: null,
            snapshotAt: FIXTURE_TIMESTAMP,
        });
        const again = advanceDispatchPage(relabelled);
        expect(again.cursorStack).toEqual([null, CURSOR_ONE, CURSOR_ONE_AGAIN]);
        expect(again.pageIndex).toBe(2);
    });

    it('resets to page one on a filter change but keeps the page size', () => {
        const positioned = { ...dispatchListPageAt(50), pageIndex: 3, cursorStack: [null, 'a', 'b', 'c'] };
        const reset = resetDispatchListPage(positioned);

        expect(reset.pageIndex).toBe(0);
        expect(reset.limit).toBe(50);
        expect(reset.cursorStack).toEqual([null]);
    });

    it('falls back to the default page size for a size the contract does not accept', () => {
        expect(dispatchListPageAt(7).limit).toBe(25);
        expect(dispatchListPageAt(100).limit).toBe(100);
    });
});

describe('parseDispatchListBody (005 contract §2)', () => {
    it('reads rows and their page label together', () => {
        const answer = parseDispatchListBody(answerBody([], pageMember({ total: 3, hasMore: true })));

        expect(answer?.rows).toEqual([]);
        expect(answer?.page.total).toBe(3);
        expect(answer?.page.hasMore).toBe(true);
    });

    it('refuses an answer with no page label rather than paging blind', () => {
        expect(parseDispatchListBody('{"events":[]}')).toBeNull();
    });

    it('refuses a page size outside the four the contract accepts', () => {
        expect(parseDispatchListBody(answerBody([], pageMember({ limit: 7 })))).toBeNull();
        expect(parseDispatchListBody(answerBody([], pageMember({ limit: 25 })))).not.toBeNull();
    });

    it('refuses a filter echo that does not name both members', () => {
        expect(parseDispatchListBody(answerBody([], pageMember({ filter: { bindingId: null } })))).toBeNull();
        expect(parseDispatchListBody(answerBody([], pageMember({ filter: 'all' })))).toBeNull();
    });

    it('refuses a label whose members are the wrong type', () => {
        expect(parseDispatchListBody(answerBody([], pageMember({ hasMore: 'yes' })))).toBeNull();
        expect(parseDispatchListBody(answerBody([], pageMember({ snapshotAt: 42 })))).toBeNull();
        expect(parseDispatchListBody(answerBody([], pageMember({ nextCursor: 7 })))).toBeNull();
    });
});

describe('loadDispatches records where the answer sits (FR-042)', () => {
    const answer = answerBody([], pageMember({ total: 137, hasMore: true, nextCursor: CURSOR_ONE }));

    it('records the boundary, the flag, the total, and the answer’s stamp', async () => {
        const { rt } = doubleRuntime({ [PAGE_ONE]: { status: 200, body: answer } });

        await loadDispatches(rt);

        const { page, status } = rt.state.dispatches;
        expect(status).toBe('ready');
        expect(page.nextCursor).toBe(CURSOR_ONE);
        expect(page.hasMore).toBe(true);
        expect(page.total).toBe(137);
        expect(page.snapshotAt).toBe(FIXTURE_TIMESTAMP);
    });

    it('leaves the position untouched when the answer is refused', async () => {
        const { rt } = doubleRuntime({ [PAGE_ONE]: { status: 503, body: '{}' } });
        const before = { ...rt.state.dispatches.page };

        await loadDispatches(rt);

        expect(rt.state.dispatches.status).toBe('error');
        expect(rt.state.dispatches.page).toEqual(before);
    });
});

describe('stepping through the set (FR-042)', () => {
    it('reads the next page from its cursor and the previous one from the stack', async () => {
        const first = answerBody([], pageMember({ nextCursor: CURSOR_ONE, hasMore: true, total: 40 }));
        const second = answerBody([], pageMember({ nextCursor: CURSOR_TWO, hasMore: true, total: 40 }));
        const third = answerBody([], pageMember({ total: 40 }));
        const { rt, calls } = doubleRuntime({
            [PAGE_ONE]: { status: 200, body: first },
            [`GET /v1/events?limit=25&cursor=${CURSOR_ONE}`]: { status: 200, body: second },
            [`GET /v1/events?limit=25&cursor=${CURSOR_TWO}`]: { status: 200, body: third },
        });

        await loadDispatches(rt);
        await nextPage(rt);
        await nextPage(rt);

        expect(rt.state.dispatches.page.pageIndex).toBe(2);
        expect(calls).toEqual([
            PAGE_ONE,
            `GET /v1/events?limit=25&cursor=${CURSOR_ONE}`,
            `GET /v1/events?limit=25&cursor=${CURSOR_TWO}`,
        ]);

        await previousPage(rt);
        expect(rt.state.dispatches.page.pageIndex).toBe(1);
        expect(calls.at(-1)).toBe(`GET /v1/events?limit=25&cursor=${CURSOR_ONE}`);
    });

    it('rolls the position back when the next page is refused', async () => {
        const { rt } = doubleRuntime({
            [PAGE_ONE]: {
                status: 200,
                body: answerBody([], pageMember({ nextCursor: CURSOR_ONE, hasMore: true })),
            },
            [`GET /v1/events?limit=25&cursor=${CURSOR_ONE}`]: { status: 503, body: '{}' },
        });
        await loadDispatches(rt);
        const before = { ...rt.state.dispatches.page };

        await nextPage(rt);

        expect(rt.state.dispatches.status).toBe('error');
        expect(rt.state.dispatches.page).toEqual(before);
    });

    it('steps nowhere when the answer reported no further page', async () => {
        const { rt, calls } = doubleRuntime({
            [PAGE_ONE]: { status: 200, body: answerBody([], pageMember()) },
        });
        await loadDispatches(rt);

        await nextPage(rt);

        expect(calls).toHaveLength(1);
    });
});

describe('changing the size and the filters (FR-042, FR-043)', () => {
    it('re-reads at a new page size from page one', async () => {
        const { rt, calls } = doubleRuntime({
            [PAGE_ONE_WIDE]: { status: 200, body: answerBody([], pageMember({ limit: 50 })) },
        });

        setPageLimit(rt, 50);
        await tick();

        expect(calls[0]).toBe(PAGE_ONE_WIDE);
        expect(rt.state.dispatches.page.limit).toBe(50);
        expect(rt.state.dispatches.page.pageIndex).toBe(0);
    });

    it('resets to page one and asks the service for the filtered set', async () => {
        const { rt, calls } = doubleRuntime({
            [PAGE_ONE_FILTERED]: {
                status: 200,
                body: answerBody([], pageMember({ filter: { bindingId: 'bnd_one', state: null } })),
            },
        });

        setBindingFilter(rt, 'bnd_one');
        await tick();

        expect(calls[0]).toBe(PAGE_ONE_FILTERED);
        expect(rt.state.dispatches.filters.bindingId).toBe('bnd_one');
    });

    it('clears both filters and returns to the unfiltered first page', async () => {
        const { rt, calls } = doubleRuntime({
            [PAGE_ONE]: { status: 200, body: answerBody([], pageMember()) },
        });
        rt.state.dispatches.filters = { bindingId: 'bnd_one', state: 'failed' };

        clearFilters(rt);
        await tick();

        expect(calls[0]).toBe(PAGE_ONE);
        expect(rt.state.dispatches.filters).toEqual({ bindingId: null, state: null });
    });
});
