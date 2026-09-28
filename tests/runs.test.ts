/**
 * Runs-list tests (M8): projection → rows, reads, and the retry wiring.
 *
 * The runs area is the operator's only view of what the loop actually did,
 * so these tests hold three promises: the projection the service ships
 * renders as rows that name the trigger, issue, state, age, and dispatch
 * result (redacted, because that field is free text); a read that fails says
 * so without blanking what was already on screen; and a retry reaches the
 * documented endpoint, refreshes the list, and explains a refusal in the
 * service's own vocabulary. The row copy is pure, so none of it needs a
 * live DOM — the same rule the binding rows live by.
 */

import { describe, expect, it } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { createRepositoriesHandlers } from '../src/repos-mount.ts';
import { initialRuns } from '../src/panel-state.ts';
import {
    RUNS_EMPTY_STATUS,
    RUNS_EMPTY_TEXT,
    canRetry,
    runRows,
    runsStatusText,
    selectedRun,
} from '../src/runs-rows.ts';
import { loadRuns, openRun, retryRun, selectRun } from '../src/runs.ts';
import { parseRunsBody } from '../src/runs-service.ts';
import { EVENTS_PATH, retryPath } from '../src/service-calls.ts';
import type { PanelRuntime, RunsState } from '../src/panel-state.ts';
import type { RunRow } from '../src/runs-service.ts';
import {
    DEFAULT_BODY,
    DEFAULT_STATUS,
    ISSUE_URL,
    createTestRuntime,
    fakeHost,
    tick,
} from './support/panel.ts';

/** One minute in milliseconds; the fixture's row age is measured in these. */
const MINUTE_MS = 60_000;

/** How old the fixture row is, so its meta reads `2m ago`. */
const TWO_MINUTES = 2 * MINUTE_MS;

/** Event id every fixture row shares unless a test overrides it. */
const EVENT_ID = 'evt-run-1';

/** Session id the dispatched fixture row reports. */
const SESSION_RESULT = 'ses_dispatched_1';

/** The default `GET /v1/events` key the service double answers. */
const RUNS_GET = `GET ${EVENTS_PATH}`;

/** One answer in a service-double route table. */
interface RouteAnswer {
    /** HTTP status the service answers with. */
    readonly status: number;
    /** Response body text. */
    readonly body: string;
}

/** Route table keyed by `METHOD path`. */
type RouteTable = Readonly<Record<string, RouteAnswer>>;

/**
 * Build one runs row the way the service projects it.
 *
 * @param overrides - Fields the test changes.
 * @returns A complete, valid row.
 */
function runFixture(overrides: Partial<RunRow> = {}): RunRow {
    return {
        id: EVENT_ID,
        kind: 'assignment',
        repository: 'acme/widget',
        issueNumber: 7,
        issueTitle: 'Fix the flaky test',
        issueUrl: ISSUE_URL,
        state: 'pending',
        detectedAt: new Date(Date.now() - TWO_MINUTES).toISOString(),
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
        bindingId: 'bnd-1',
        headSha: null,
        baseRef: null,
        ...overrides,
    };
}

/**
 * Build a Runs-section state around the given rows.
 *
 * @param overrides - Fields the test changes.
 * @returns A complete state object.
 */
function runsState(overrides: Partial<RunsState> = {}): RunsState {
    return { ...initialRuns(), ...overrides };
}

/** Body the service answers `GET /v1/events` with for the given rows. */
function runsBody(rows: readonly RunRow[]): string {
    return JSON.stringify({ events: rows });
}

/** A service double: recorded `METHOD path` calls plus a swappable table. */
interface ServiceDouble {
    /** `serviceRequest` member for {@link fakeHost}. */
    readonly serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult>;
    /** Calls observed, in order, as `METHOD path`. */
    readonly calls: readonly string[];
    /** Replace the route table, modelling the service's answer changing. */
    readonly setRoutes: (table: RouteTable) => void;
}

/**
 * Build a service double over a `METHOD path` → answer table.
 *
 * @param table - Answers keyed by `METHOD path`; anything else is the
 *   neutral 404 the default host double answers with.
 * @returns The double plus its recorded calls.
 */
function serviceDouble(table: RouteTable): ServiceDouble {
    const calls: string[] = [];
    let routes = table;

    return {
        calls,
        setRoutes: (next) => {
            routes = next;
        },
        serviceRequest: async (request) => {
            const key = `${request.method} ${request.path}`;
            calls.push(key);

            return routes[key] ?? { status: DEFAULT_STATUS, body: DEFAULT_BODY };
        },
    };
}

/**
 * Build a runtime whose selected run is `row`, against the given routes.
 *
 * @param row - The run the section holds and has selected.
 * @param table - Route table the service answers with.
 * @returns The runtime and its service double.
 */
function retryRuntime(row: RunRow, table: RouteTable): { readonly rt: PanelRuntime; readonly service: ServiceDouble } {
    const service = serviceDouble(table);
    const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
    rt.state.repos.runs = runsState({ rows: [row], status: 'ready', selectedRun: row.id });

    return { rt, service };
}

describe('parseRunsBody (the service projection, round-tripped)', () => {
    it('reads every field the runs row renders from', () => {
        const sent = runFixture({ state: 'in-flight', claimedAt: '2026-09-27T10:00:00.000Z' });
        const parsed = parseRunsBody(runsBody([sent]));

        expect(parsed).toHaveLength(1);
        expect(parsed?.[0]).toEqual(sent);
    });

    it('keeps the optional pull-request coordinates when the service sends them', () => {
        const parsed = parseRunsBody(runsBody([runFixture({ kind: 'review', headSha: 'abc123', baseRef: 'main' })]));

        expect(parsed?.[0]?.kind).toBe('review');
        expect(parsed?.[0]?.headSha).toBe('abc123');
        expect(parsed?.[0]?.baseRef).toBe('main');
    });

    it('reads rows from a future build leniently on kind, strictly elsewhere', () => {
        const unknownKind = JSON.stringify({ events: [{ ...runFixture(), kind: 'telepathy' }] });
        expect(parseRunsBody(unknownKind)?.[0]?.kind).toBe('assignment');

        const badState = JSON.stringify({ events: [{ ...runFixture(), state: 'telepathy' }] });
        expect(parseRunsBody(badState)).toBeNull();
        expect(parseRunsBody('{"events":[{"id":"half"}]}')).toBeNull();
        expect(parseRunsBody('not a document')).toBeNull();
        expect(parseRunsBody('{"runs":[]}')).toBeNull();
        expect(parseRunsBody(runsBody([]))).toEqual([]);
    });
});

describe('runRows / runsStatusText (the copy the list renders)', () => {
    it('renders rows with kind, issue, state badge, relative age, and result', () => {
        const rows = runRows(runsState({ rows: [runFixture()], status: 'ready' }));

        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({
            id: EVENT_ID,
            leading: 'assign',
            title: '#7 Fix the flaky test',
            subtitle: 'acme/widget · not dispatched yet',
            meta: '2m ago',
            badge: { label: 'pending', tone: 'neutral' },
        });
    });

    it('shows the dispatch result beside a dispatched row', () => {
        const rows = runRows(
            runsState({ rows: [runFixture({ state: 'dispatched', dispatchResult: SESSION_RESULT })], status: 'ready' }),
        );

        expect(rows[0]?.badge).toEqual({ label: 'dispatched', tone: 'success' });
        expect(rows[0]?.subtitle).toContain(SESSION_RESULT);
    });

    it('redacts secret-shaped text before it reaches the row', () => {
        const rows = runRows(
            runsState({
                rows: [runFixture({ state: 'in-flight', dispatchResult: 'problem ghp_abcdefghijklmnopqrstuvwx' })],
                status: 'ready',
            }),
        );

        expect(rows[0]?.subtitle).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
        expect(rows[0]?.subtitle).toContain('[redacted:github-token-classic]');
    });

    it('names a dispatched row whose result never arrived', () => {
        const rows = runRows(runsState({ rows: [runFixture({ state: 'dispatched' })], status: 'ready' }));

        expect(rows[0]?.subtitle).toContain('no dispatch result recorded');
    });

    it('offers retry for pending and in-flight runs but not for dispatched ones', () => {
        expect(canRetry(runFixture({ state: 'pending' }))).toBe(true);
        expect(canRetry(runFixture({ state: 'in-flight' }))).toBe(true);
        expect(canRetry(runFixture({ state: 'dispatched' }))).toBe(false);
    });

    it('phrases every list lifecycle state honestly', () => {
        expect(runsStatusText(runsState())).toContain('have not been read');
        expect(runsStatusText(runsState({ status: 'loading' }))).toBe('Loading runs…');
        expect(runsStatusText(runsState({ status: 'error' }))).toContain('see the note');
        expect(runsStatusText(runsState({ status: 'ready' }))).toBe(RUNS_EMPTY_STATUS);
        expect(runsStatusText(runsState({ status: 'ready', rows: [runFixture()] }))).toBe(
            '1 run · newest first · select a row to open or retry',
        );
        expect(RUNS_EMPTY_TEXT).toBe('No runs yet.');
    });
});

describe('loadRuns (read the history without lying about failures)', () => {
    it('lands a readable list in state and marks the section ready', async () => {
        const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) } });
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));

        await loadRuns(rt);

        expect(rt.state.repos.runs.status).toBe('ready');
        expect(rt.state.repos.runs.rows).toHaveLength(1);
        expect(rt.state.repos.runs.note).toBe('');
    });

    it('keeps the rows it holds and explains a refused refresh', async () => {
        const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) } });
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
        await loadRuns(rt);

        service.setRoutes({
            [RUNS_GET]: { status: 503, body: '{"error":{"code":"storage-unavailable"}}' },
        });
        await loadRuns(rt);

        expect(rt.state.repos.runs.status).toBe('error');
        expect(rt.state.repos.runs.note).toContain('service answered 503');
        // The rows the operator was reading survive a failed refresh.
        expect(rt.state.repos.runs.rows).toHaveLength(1);
    });

    it('reports an unreadable body as unreadable instead of half-trusting it', async () => {
        const service = serviceDouble({ [RUNS_GET]: { status: 200, body: '{"events":[{"id":"half"}]}' } });
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));

        await loadRuns(rt);

        expect(rt.state.repos.runs.status).toBe('error');
        expect(rt.state.repos.runs.note).toContain('could not read');
        expect(rt.state.repos.runs.rows).toEqual([]);
    });

    it('shows the empty state when the service has no events at all', async () => {
        const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([]) } });
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));

        await loadRuns(rt);

        expect(rt.state.repos.runs.status).toBe('ready');
        expect(rt.state.repos.runs.rows).toEqual([]);
        expect(runsStatusText(rt.state.repos.runs)).toBe(RUNS_EMPTY_STATUS);
        expect(runRows(rt.state.repos.runs)).toEqual([]);
    });

    it('drops a selection whose row disappeared', async () => {
        const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([]) } });
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
        rt.state.repos.runs.selectedRun = EVENT_ID;

        await loadRuns(rt);

        expect(rt.state.repos.runs.selectedRun).toBeNull();
    });
});

describe('retryRun (POST, refresh, honest copy)', () => {
    it('requeues the selected run, then re-reads the list', async () => {
        const claimed = runFixture({ state: 'in-flight', claimedAt: '2026-09-27T10:00:00.000Z' });
        const { rt, service } = retryRuntime(claimed, {
            [`POST ${retryPath(EVENT_ID)}`]: { status: 200, body: '{"retried":true}' },
            [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) },
        });

        await retryRun(rt);

        expect(service.calls).toEqual([`POST ${retryPath(EVENT_ID)}`, RUNS_GET]);
        expect(rt.state.repos.runs.note).toContain('Requeued #7');
        expect(rt.state.repos.runs.note).toContain('next relay poll');
        expect(rt.state.repos.runs.rows[0]?.state).toBe('pending');
    });

    it('explains a 409 invalid-transition from the service envelope', async () => {
        // The panel's row is stale (it still looks retryable, so the POST is
        // genuinely sent); the service knows better and answers 409.
        const stale = runFixture({ state: 'pending' });
        const actual = runFixture({ state: 'dispatched', dispatchResult: SESSION_RESULT });
        const { rt, service } = retryRuntime(stale, {
            [`POST ${retryPath(EVENT_ID)}`]: {
                status: 409,
                body: '{"error":{"code":"invalid-transition","message":"already dispatched"}}',
            },
            [RUNS_GET]: { status: 200, body: runsBody([actual]) },
        });

        await retryRun(rt);

        expect(service.calls).toEqual([`POST ${retryPath(EVENT_ID)}`, RUNS_GET]);
        expect(rt.state.repos.runs.note).toContain('already dispatched');
        expect(rt.state.repos.runs.note).toContain('cannot be retried');
        // The refresh after the refusal shows the state the service actually holds.
        expect(rt.state.repos.runs.rows[0]?.state).toBe('dispatched');
    });

    it('refuses locally — without a POST — when the selected run already dispatched', async () => {
        const dispatched = runFixture({ state: 'dispatched', dispatchResult: SESSION_RESULT });
        const { rt, service } = retryRuntime(dispatched, {
            [RUNS_GET]: { status: 200, body: runsBody([dispatched]) },
        });

        await retryRun(rt);

        expect(service.calls).toEqual([]);
        expect(rt.state.repos.runs.note).toContain('already dispatched');
    });

    it('does nothing when nothing is selected', async () => {
        const service = serviceDouble({});
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
        rt.state.repos.runs = runsState({ rows: [runFixture()], status: 'ready' });

        await retryRun(rt);

        expect(service.calls).toEqual([]);
        expect(rt.state.repos.runs.note).toBe('');
    });
});

describe('selection, open, and the pane handler table', () => {
    it('selects a known row and ignores an unknown id', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.repos.runs = runsState({ rows: [runFixture()], status: 'ready' });

        selectRun(rt, 'evt-from-the-future');
        expect(rt.state.repos.runs.selectedRun).toBeNull();

        selectRun(rt, EVENT_ID);
        expect(rt.state.repos.runs.selectedRun).toBe(EVENT_ID);
        expect(selectedRun(rt.state.repos.runs)?.issueUrl).toBe(ISSUE_URL);
    });

    it('opens the selected run’s issue through the documented host call', async () => {
        const opened: string[] = [];
        const host = fakeHost({
            openUrl: async (url) => {
                opened.push(url);
            },
        });
        const rt = createTestRuntime(host);
        rt.state.repos.runs = runsState({ rows: [runFixture()], status: 'ready', selectedRun: EVENT_ID });

        await openRun(rt);

        expect(opened).toEqual([ISSUE_URL]);
        expect(rt.state.repos.runs.note).toBe('');
    });

    it('lands an openUrl failure on the note instead of throwing', async () => {
        const host = fakeHost({ openUrl: () => Promise.reject(new Error('HOST_REJECTED')) });
        const rt = createTestRuntime(host);
        rt.state.repos.runs = runsState({ rows: [runFixture()], status: 'ready', selectedRun: EVENT_ID });

        await openRun(rt);

        expect(rt.state.repos.runs.note).toContain('could not be opened');
        expect(rt.state.repos.runs.note).toContain('HOST_REJECTED');
    });

    it('wires Refresh runs through the pane handler table to a real read', async () => {
        const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) } });
        const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
        const handlers = createRepositoriesHandlers(rt);

        handlers.refreshRuns();
        await tick();

        expect(rt.state.repos.runs.status).toBe('ready');
        expect(rt.state.repos.runs.rows).toHaveLength(1);
    });
});
