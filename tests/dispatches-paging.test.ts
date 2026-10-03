/**
 * The Dispatches list's paged read and its controls (005 T-015, T-017;
 * FR-042, FR-043, FR-048, FR-081).
 *
 * Four things are asserted here and nowhere else: the query the client builds
 * carries only what the operator chose (a cursor only past page one, a filter
 * only when it is on), the answer is refused as a whole when its `page` label
 * is missing or out of contract, the paging position survives a failed read
 * instead of stranding the tab on a page it cannot show — and the controls
 * around that list render the operator's own words: which range is showing,
 * which filters describe it, what an empty filtered page says, the
 * source-reference detail AC-120 opens, and the row-naming accessible names
 * FR-081 requires.
 *
 * Everything is offline: a recorded service double, no host, no network
 * (FR-086).
 */

import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { loadDispatches, resolveNoSession, selectDispatch, toggleReferences } from '../src/dispatches.ts';
import { dispatchListPath, parseDispatchListBody } from '../src/dispatches-list.ts';
import { runAffordance, utcStamp } from '../src/dispatches-rows.ts';
import {
    activeFilterLine,
    bindingFilterOptions,
    dispatchEmptyText,
    dispatchRangeLine,
    hasActiveFilters,
    referencesVisible,
    revealVisible,
    rowActionLabel,
    sourceRevealLabel,
    stateFilterOptions,
} from '../src/dispatches-controls.ts';
import { referenceDetailLines } from '../src/dispatches-detail.ts';
import {
    clearFilters,
    nextPage,
    previousPage,
    setBindingFilter,
    setPageLimit,
    setStateFilter,
} from '../src/dispatches-paging.ts';
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
import type { PanelBinding } from '../src/bindings-service.ts';
import type { RunReference, RunRow } from '../src/dispatches-service.ts';
import { FIXTURE_TIMESTAMP, ISSUE_URL, createTestRuntime, fakeHost, tick } from './support/panel.ts';

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
    it('always names the page size and nothing else when not… (+3 cases)', () => {
        // case: always names the page size and nothing else when nothing is chosen
        {
            expect(dispatchListPath(section())).toBe(PAGE_ONE_PATH);
        }
        // case: carries the cursor only once the operator has stepped past page one
        {
            const page = recordDispatchPageMeta(initialDispatchListPage(), {
                nextCursor: CURSOR_ONE,
                hasMore: true,
                total: 40,
                snapshotAt: FIXTURE_TIMESTAMP,
            });
            const advanced = advanceDispatchPage(page);

            expect(cursorFor(advanced)).toBe(CURSOR_ONE);
            expect(dispatchListPath(section(advanced))).toBe(`${PAGE_ONE_PATH}&cursor=${CURSOR_ONE}`);
        }
        // case: carries each filter only while it is on, and both when both are
        {
            const on = { bindingId: 'bnd_one', state: 'blocked:project-missing' };
            expect(dispatchListPath(section(initialDispatchListPage(), on)))
                .toBe(`${PAGE_ONE_PATH}&bindingId=bnd_one&state=blocked%3Aproject-missing`);
        }
        // case: quotes a cursor so an opaque token never breaks the query
        {
            const page = recordDispatchPageMeta(initialDispatchListPage(), {
                nextCursor: 'a b&c',
                hasMore: true,
                total: null,
                snapshotAt: FIXTURE_TIMESTAMP,
            });

            expect(dispatchListPath(section(advanceDispatchPage(page)))).toContain('cursor=a%20b%26c');
        }
    });
});

describe('the paging position machine (data-model §3.2)', () => {
    it('starts on page one with the default size and no boun… (+4 cases)', () => {
        // case: starts on page one with the default size and no boundary
        {
            const page = initialDispatchListPage();

            expect(cursorFor(page)).toBeNull();
            expect(page.pageIndex).toBe(0);
            expect(page.limit).toBe(25);
        }
        // case: advances on the boundary the answer supplied and retreats on demand
        {
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
        }
        // case: refuses to advance with no boundary, and truncates the abandoned tail
        {
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
        }
        // case: resets to page one on a filter change but keeps the page size
        {
            const positioned = { ...dispatchListPageAt(50), pageIndex: 3, cursorStack: [null, 'a', 'b', 'c'] };
            const reset = resetDispatchListPage(positioned);

            expect(reset.pageIndex).toBe(0);
            expect(reset.limit).toBe(50);
            expect(reset.cursorStack).toEqual([null]);
        }
        // case: falls back to the default page size for a size the contract does not accept
        {
            expect(dispatchListPageAt(7).limit).toBe(25);
            expect(dispatchListPageAt(100).limit).toBe(100);
        }
    });
});

describe('parseDispatchListBody (005 contract §2)', () => {
    it('reads rows and their page label together (+4 cases)', () => {
        // case: reads rows and their page label together
        {
            const answer = parseDispatchListBody(answerBody([], pageMember({ total: 3, hasMore: true })));

            expect(answer?.rows).toEqual([]);
            expect(answer?.page.total).toBe(3);
            expect(answer?.page.hasMore).toBe(true);
        }
        // case: refuses an answer with no page label rather than paging blind
        {
            expect(parseDispatchListBody('{"events":[]}')).toBeNull();
        }
        // case: refuses a page size outside the four the contract accepts
        {
            expect(parseDispatchListBody(answerBody([], pageMember({ limit: 7 })))).toBeNull();
            expect(parseDispatchListBody(answerBody([], pageMember({ limit: 25 })))).not.toBeNull();
        }
        // case: refuses a filter echo that does not name both members
        {
            expect(parseDispatchListBody(answerBody([], pageMember({ filter: { bindingId: null } })))).toBeNull();
            expect(parseDispatchListBody(answerBody([], pageMember({ filter: 'all' })))).toBeNull();
        }
        // case: refuses a label whose members are the wrong type
        {
            expect(parseDispatchListBody(answerBody([], pageMember({ hasMore: 'yes' })))).toBeNull();
            expect(parseDispatchListBody(answerBody([], pageMember({ snapshotAt: 42 })))).toBeNull();
            expect(parseDispatchListBody(answerBody([], pageMember({ nextCursor: 7 })))).toBeNull();
        }
    });
});

describe('loadDispatches records where the answer sits (FR-042)', () => {
    const answer = answerBody([], pageMember({ total: 137, hasMore: true, nextCursor: CURSOR_ONE }));

    it('records the boundary, the flag, the total, and the a… (+1 cases)', async () => {
        // case: records the boundary, the flag, the total, and the answer’s stamp
        {
            const { rt } = doubleRuntime({ [PAGE_ONE]: { status: 200, body: answer } });

            await loadDispatches(rt);

            const { page, status } = rt.state.dispatches;
            expect(status).toBe('ready');
            expect(page.nextCursor).toBe(CURSOR_ONE);
            expect(page.hasMore).toBe(true);
            expect(page.total).toBe(137);
            expect(page.snapshotAt).toBe(FIXTURE_TIMESTAMP);
        }
        // case: leaves the position untouched when the answer is refused
        {
            const { rt } = doubleRuntime({ [PAGE_ONE]: { status: 503, body: '{}' } });
            const before = { ...rt.state.dispatches.page };

            await loadDispatches(rt);

            expect(rt.state.dispatches.status).toBe('error');
            expect(rt.state.dispatches.page).toEqual(before);
        }
    });
});

describe('stepping through the set (FR-042)', () => {
    it('reads the next page from its cursor and the previous… (+2 cases)', async () => {
        // case: reads the next page from its cursor and the previous one from the stack
        {
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
        }
        // case: rolls the position back when the next page is refused
        {
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
        }
        // case: steps nowhere when the answer reported no further page
        {
            const { rt, calls } = doubleRuntime({
                [PAGE_ONE]: { status: 200, body: answerBody([], pageMember()) },
            });
            await loadDispatches(rt);

            await nextPage(rt);

            expect(calls).toHaveLength(1);
        }
    });
});

describe('changing the size and the filters (FR-042, FR-043)', () => {
    it('re-reads at a new page size from page one (+2 cases)', async () => {
        // case: re-reads at a new page size from page one
        {
            const { rt, calls } = doubleRuntime({
                [PAGE_ONE_WIDE]: { status: 200, body: answerBody([], pageMember({ limit: 50 })) },
            });

            setPageLimit(rt, 50);
            await tick();

            expect(calls[0]).toBe(PAGE_ONE_WIDE);
            expect(rt.state.dispatches.page.limit).toBe(50);
            expect(rt.state.dispatches.page.pageIndex).toBe(0);
        }
        // case: resets to page one and asks the service for the filtered set
        {
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
        }
        // case: clears both filters and returns to the unfiltered first page
        {
            const { rt, calls } = doubleRuntime({
                [PAGE_ONE]: { status: 200, body: answerBody([], pageMember()) },
            });
            rt.state.dispatches.filters = { bindingId: 'bnd_one', state: 'failed' };

            clearFilters(rt);
            await tick();

            expect(calls[0]).toBe(PAGE_ONE);
            expect(rt.state.dispatches.filters).toEqual({ bindingId: null, state: null });
        }
    });
});

/** One binding the filter line and its options can name. */
const FILTER_BINDING: PanelBinding = {
    bindingId: 'bnd_one',
    accountNumericUserId: '77331',
    accountLogin: 'octocat',
    repository: 'acme/one',
    projectId: 'prj_42',
    worktreeOption: 'none',
    triggers: { assignment: true, mention: false, reviewRequest: false },
    state: 'active',
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
};

/** Path the state-filtered first page is read from. */
const PAGE_ONE_STATE_FILTERED = 'GET /v1/events?limit=25&state=failed';

/**
 * Build one row the way the service projects it, keyed by its position.
 *
 * @param index - One-based position in the fixture set; also its issue number.
 * @param overrides - Fields the test changes.
 * @returns A complete, parseable row.
 */
function fixtureRow(index: number, overrides: Partial<RunRow> = {}): RunRow {
    const id = `mt-run-${index.toString(16).padStart(24, '0')}`;

    return {
        id,
        correlationId: id,
        kind: 'assignment',
        repository: 'acme/widget',
        issueNumber: index,
        issueTitle: `Issue ${index}`,
        issueUrl: `https://github.com/acme/widget/issues/${index}`,
        state: 'pending',
        stateReason: 'waiting for a panel',
        runKey: `github|77331|acme/widget|issue|${index}|0`,
        ordinal: 0,
        attempt: 1,
        attachmentId: id,
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
        detectedAt: FIXTURE_TIMESTAMP,
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
        bindingId: 'bnd_one',
        headSha: null,
        baseRef: null,
        promptPresent: false,
        promptFingerprint: null,
        promptLength: null,
        promptSources: null,
        // No gate has judged this run yet (003 FR-079), so no policy shape exists.
        actorPolicy: null,
        ...overrides,
    };
}

/**
 * Build one source reference the way the service projects it (FR-013).
 *
 * @param overrides - Fields the test changes.
 * @returns A complete, valid reference.
 */
function referenceFixture(overrides: Partial<RunReference> = {}): RunReference {
    return {
        deliveryId: 'evt-acme~widget~7~77331',
        kind: 'assignment',
        origin: 'assignment',
        sourceUrl: ISSUE_URL,
        detectedAt: '2026-09-28T09:00:00.000Z',
        presentAtAuthorization: true,
        ...overrides,
    };
}

/**
 * A `serviceRequest` that pages a fixed set exactly the way the contract does.
 *
 * @param rows - The whole set, in the retained order.
 * @param calls - Recorder of every path the panel asked for.
 * @returns The double {@link fakeHost} answers with.
 */
function pagedSource(
    rows: readonly RunRow[],
    calls: string[],
): (request: GuestRequest) => Promise<GuestRequestResult> {
    return async (request) => {
        const url = new URL(request.path, 'http://panel.invalid');
        const limit = Number(url.searchParams.get('limit') ?? '25');
        const start = Number(url.searchParams.get('cursor') ?? '0');
        const slice = rows.slice(start, start + limit);
        const next = start + limit;
        const hasMore = next < rows.length;
        calls.push(request.path);

        return {
            status: 200,
            body: JSON.stringify({
                events: slice,
                page: {
                    limit,
                    nextCursor: hasMore ? String(next) : null,
                    hasMore,
                    total: rows.length,
                    snapshotAt: FIXTURE_TIMESTAMP,
                    filter: { bindingId: null, state: null },
                },
            }),
        };
    };
}

describe('AC-121 250 dispatches page through with none dropped at a boundary (FR-042)', () => {
    it('walks 100 + 100 + 50, names each range, and stops at the last page', async () => {
        const rows = Array.from({ length: 250 }, (_, index) => fixtureRow(index + 1));
        const calls: string[] = [];
        const rt = createTestRuntime(fakeHost({ serviceRequest: pagedSource(rows, calls) }));
        const seen: string[] = [];
        const ranges: string[] = [];
        const readCurrent = (): void => {
            seen.push(...rt.state.dispatches.rows.map((row) => row.id));
            ranges.push(dispatchRangeLine(rt.state.dispatches));
        };

        setPageLimit(rt, 100);
        await tick();
        readCurrent();
        await nextPage(rt);
        readCurrent();
        await nextPage(rt);
        readCurrent();

        expect(calls).toEqual([
            '/v1/events?limit=100',
            '/v1/events?limit=100&cursor=100',
            '/v1/events?limit=100&cursor=200',
        ]);
        expect(seen).toHaveLength(250);
        expect(new Set(seen).size).toBe(250);
        const stamp = utcStamp(FIXTURE_TIMESTAMP);
        expect(ranges).toEqual([
            `Showing 1–100 · 250 dispatches in this set · read ${stamp}`,
            `Showing 101–200 · 250 dispatches in this set · read ${stamp}`,
            `Showing 201–250 · 250 dispatches in this set · read ${stamp}`,
        ]);

        await nextPage(rt);
        expect(calls).toHaveLength(3);
        expect(rt.state.dispatches.page.hasMore).toBe(false);
    });

});

describe('AC-122 a filter that matched nothing says so and offers the way out (FR-043)', () => {
    it('never reports the honest empty while a filter is on (+3 cases)', async () => {
        // case: never reports the honest empty while a filter is on
        {
            const { rt } = doubleRuntime({
                [PAGE_ONE_FILTERED]: {
                    status: 200,
                    body: answerBody([], pageMember({ total: 0, filter: { bindingId: 'bnd_one', state: null } })),
                },
            });

            setBindingFilter(rt, 'bnd_one');
            await tick();

            expect(rt.state.dispatches.rows).toEqual([]);
            expect(hasActiveFilters(rt.state.dispatches)).toBe(true);
            expect(dispatchEmptyText(rt.state.dispatches)).toBe(
                'The filter matched nothing — use Clear filters to show every dispatch.',
            );
            expect(activeFilterLine(rt.state.dispatches, [FILTER_BINDING])).toBe(
                'Filters: binding acme/one · all states',
            );
        }
        // case: keeps both filters visible even when neither is on
        {
            const unfiltered = section();

            expect(hasActiveFilters(unfiltered)).toBe(false);
        }
        // case: applies a state filter server-side and resets to its first page
        {
            const { rt, calls } = doubleRuntime({
                [PAGE_ONE_STATE_FILTERED]: {
                    status: 200,
                    body: answerBody([], pageMember({ filter: { bindingId: null, state: 'failed' } })),
                },
            });

            setStateFilter(rt, 'failed');
            await tick();

            expect(calls[0]).toBe(PAGE_ONE_STATE_FILTERED);
            expect(rt.state.dispatches.page.pageIndex).toBe(0);
        }
        // case: offers an explicit "all" alongside every binding and state token
        {
            expect(bindingFilterOptions([FILTER_BINDING]).map((option) => option.id)).toEqual(['all', 'bnd_one']);
            const states = stateFilterOptions().map((option) => option.id);

            expect(states[0]).toBe('all');
            expect(states).toContain('failed');
            expect(states).toContain('blocked');
            expect(stateFilterOptions().find((option) => option.id === 'blocked')?.label).toBe(
                'blocked — every guarded state',
            );
        }
    });
});

describe('AC-115 the resolve detail names what the operator has to check (FR-044)', () => {
    it('offers Resolve — never Retry on a waiting row — and names every coordinate first', async () => {
        const row = fixtureRow(412, { state: 'unconfirmed', stateReason: 'no result arrived before the deadline' });
        const { rt } = doubleRuntime({});
        rt.state.dispatches.rows = [row];
        selectDispatch(rt, row.id);

        expect(runAffordance(row).action).toBe('resolve');
        expect(runAffordance({ state: 'pending' }).label).toBeNull();

        await resolveNoSession(rt);

        expect(rt.state.dispatches.pendingAction).toBe('resolve-no-session');
        expect(rt.state.dispatches.note).toContain('project prj_42');
        expect(rt.state.dispatches.note).toContain(`attachment ${row.attachmentId}`);
        expect(rt.state.dispatches.rows).toEqual([row]);
    });
});

describe('AC-120 the row detail lists every source reference (FR-048)', () => {
    it('lists kind, origin, link, and detection time, markin… (+1 cases)', () => {
        // case: lists kind, origin, link, and detection time, marking the late one
        {
            const row = fixtureRow(412, {
                referenceCount: 3,
                sourceReferences: [
                    referenceFixture(),
                    referenceFixture({
                        deliveryId: 'evt-b',
                        kind: 'mention',
                        origin: 'comment',
                        detectedAt: '2026-09-28T09:05:00.000Z',
                    }),
                    referenceFixture({
                        deliveryId: 'evt-c',
                        kind: 'mention',
                        origin: 'body',
                        detectedAt: '2026-09-28T09:10:00.000Z',
                        presentAtAuthorization: false,
                    }),
                ],
            });

            const lines = referenceDetailLines(row);

            expect(lines).toHaveLength(3);
            // 005 FR-094: every revealed reference names its own actor, and a fixture
            // with no attribution says so rather than naming nobody.
            expect(lines[0]).toBe(`assignment · from assignment · detected 2026-09-28 09:00 · ${ISSUE_URL}`
                + ' · actor not recorded');
            expect(lines[1]).toContain('2026-09-28 09:05');
            expect(lines[2]).toContain(ISSUE_URL);
        }
        // case: reveals only when the operator asks, and never on a single-reference row
        {
            const three = fixtureRow(1, {
                referenceCount: 3,
                sourceReferences: [referenceFixture(), referenceFixture(), referenceFixture()],
            });
            const single = fixtureRow(2, { referenceCount: 1, sourceReferences: [referenceFixture()] });
            const rt = createTestRuntime(fakeHost());
            rt.state.dispatches.rows = [three, single];
            selectDispatch(rt, three.id);

            expect(revealVisible(three)).toBe(true);
            expect(referencesVisible(three, false)).toBe(false);

            toggleReferences(rt);

            expect(rt.state.dispatches.referencesOpen).toBe(true);
            expect(referencesVisible(three, rt.state.dispatches.referencesOpen)).toBe(true);

            // FR-048: exactly one reference carries no "+N more" affordance, and
            // its single reference is listed as soon as the row is opened.
            expect(revealVisible(single)).toBe(false);
            expect(referencesVisible(single, false)).toBe(true);

            selectDispatch(rt, single.id);
            expect(rt.state.dispatches.referencesOpen).toBe(false);
            expect(referencesVisible(three, rt.state.dispatches.referencesOpen)).toBe(false);
        }
    });
});

describe('FR-081 every row-level action names its row', () => {
    it('composes accessible names from the action and the row', () => {
        const failed = fixtureRow(412, { state: 'failed', referenceCount: 3 });
        const retry = runAffordance(failed).label ?? '';

        expect(rowActionLabel(retry, failed)).toBe('Retry dispatch for #412 in acme/widget');
        expect(rowActionLabel('Open issue', failed)).toBe('Open issue for #412 in acme/widget');
        expect(rowActionLabel('Copy correlation id', failed)).toBe('Copy correlation id for #412 in acme/widget');
        expect(sourceRevealLabel(false, failed)).toBe('Show 3 reasons for #412 in acme/widget');
        expect(sourceRevealLabel(true, failed)).toBe('Hide the source references for #412 in acme/widget');
    });
});
