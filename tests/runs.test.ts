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
import type { Tone } from '@openchamber/sdk/ui';
import { createRepositoriesHandlers } from '../src/repos-mount.ts';
import { initialRuns } from '../src/panel-state.ts';
import {
    RUNS_EMPTY_STATUS,
    RUNS_EMPTY_TEXT,
    canRetry,
    runAffordance,
    runRows,
    runsStatusText,
    selectedRun,
    stateLabel,
} from '../src/runs-rows.ts';
import { loadRuns, openRun, retryRun, selectRun } from '../src/runs.ts';
import { parseRunsBody } from '../src/runs-service.ts';
import { EVENTS_PATH, retryPath } from '../src/service-calls.ts';
import type { PanelRuntime, RunsState } from '../src/panel-state.ts';
import type { RunReference, RunRow } from '../src/runs-service.ts';
import {
    DEFAULT_BODY,
    DEFAULT_STATUS,
    FIXTURE_TIMESTAMP,
    ISSUE_URL,
    createTestRuntime,
    fakeHost,
    tick,
} from './support/panel.ts';

/** One minute in milliseconds; the fixture's row age is measured in these. */
const MINUTE_MS = 60_000;

/** How old the fixture row is, so its meta reads `2m ago`. */
const TWO_MINUTES = 2 * MINUTE_MS;

/** Correlation id every fixture row shares unless a test overrides it. */
const RUN_ID = 'mt-run-aaaabbbbccccddddeeeeffff';

/** Session id the dispatched fixture row reports. */
const SESSION_RESULT = 'ses_dispatched_1';

/** State words the suites share, so no literal is repeated across them. */
const FAILED_STATE: RunRow['state'] = 'failed';

/** The fail-closed wedge state, named once for the tables and the tests. */
const UNCONFIRMED_STATE: RunRow['state'] = 'unconfirmed';

/** The parked terminal state, named once for the tables and the tests. */
const DEAD_LETTERED_STATE: RunRow['state'] = 'dead-lettered';

/** A guard-refused state naming a project the host does not list. */
const BLOCKED_PROJECT_STATE: RunRow['state'] = 'blocked:project-missing';

/** A guard-refused state naming a binding that no longer exists. */
const BLOCKED_BINDING_STATE: RunRow['state'] = 'blocked:binding-missing';

/** Agent every read-back fixture expects (and, when matched, observes). */
const EXPECTED_AGENT = 'project-manager';

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
        id: RUN_ID,
        correlationId: RUN_ID,
        kind: 'assignment',
        repository: 'acme/widget',
        issueNumber: 7,
        issueTitle: 'Fix the flaky test',
        issueUrl: ISSUE_URL,
        state: 'pending',
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
        const sent = runFixture({ state: 'claimed', claimedAt: '2026-09-27T10:00:00.000Z' });
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

    it('accepts all eight states, including the open blocked family', () => {
        const states: readonly RunRow['state'][] = [
            'pending',
            'claimed',
            'starting',
            'dispatched',
            FAILED_STATE,
            UNCONFIRMED_STATE,
            DEAD_LETTERED_STATE,
            BLOCKED_PROJECT_STATE,
            BLOCKED_BINDING_STATE,
            'blocked:credential',
            'blocked:policy',
        ];

        for (const state of states) {
            expect(parseRunsBody(runsBody([runFixture({ state })]))?.[0]?.state).toBe(state);
        }
    });

    it('refuses the retired vocabulary and a malformed blocked reason', () => {
        const refused = ['in-flight', 'blocked:', 'blocked:Project-Missing', 'blocked:a b', 'telepathy'];

        for (const state of refused) {
            expect(parseRunsBody(JSON.stringify({ events: [{ ...runFixture(), state }] }))).toBeNull();
        }
    });

    it('round-trips a full history body with references, a session, and a read-back', () => {
        const sent = runFixture({
            state: 'dispatched',
            stateReason: 'session ses_dispatched_1 created',
            referenceCount: 2,
            sourceReferences: [
                {
                    deliveryId: 'evt-1',
                    kind: 'assignment',
                    origin: 'assignment',
                    sourceUrl: ISSUE_URL,
                    detectedAt: FIXTURE_TIMESTAMP,
                    presentAtAuthorization: true,
                },
                {
                    deliveryId: 'evt-2',
                    kind: 'mention',
                    origin: 'comment:42',
                    sourceUrl: ISSUE_URL,
                    detectedAt: FIXTURE_TIMESTAMP,
                    presentAtAuthorization: false,
                },
            ],
            session: { sessionId: SESSION_RESULT, attachmentId: RUN_ID, dispatchedAt: FIXTURE_TIMESTAMP },
            verification: { observedAgent: EXPECTED_AGENT, expectedAgent: EXPECTED_AGENT, ok: true, note: null },
            dispatchResult: SESSION_RESULT,
            dispatchedAt: FIXTURE_TIMESTAMP,
        });

        const parsed = parseRunsBody(runsBody([sent]));

        expect(parsed).toHaveLength(1);
        expect(parsed?.[0]).toEqual(sent);
    });

    it('refuses counting members that do not reconcile (T-038)', () => {
        const missing = JSON.stringify({
            events: [{ ...runFixture(), referenceCount: 5, referencesNotRetained: 1 }],
        });
        expect(parseRunsBody(missing)).toBeNull();

        const unflagged = JSON.stringify({
            events: [{ ...runFixture({ referenceCount: 1, referencesNotRetained: 1 }), referencesTruncated: false }],
        });
        expect(parseRunsBody(unflagged)).toBeNull();
    });
});

describe('runRows / runsStatusText (the copy the list renders)', () => {
    it('renders rows with kind, issue, state badge, relative age, reason, and result', () => {
        const rows = runRows(runsState({ rows: [runFixture()], status: 'ready' }));

        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({
            id: RUN_ID,
            leading: 'assign',
            title: '#7 Fix the flaky test',
            subtitle: 'acme/widget · waiting for a panel · not dispatched yet',
            meta: '2m ago',
            badge: { label: 'waiting', tone: 'neutral' },
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
                rows: [runFixture({ state: 'claimed', dispatchResult: 'problem ghp_abcdefghijklmnopqrstuvwx' })],
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

    it('offers retry only where the service accepts one (T-024’s affordance table)', () => {
        expect(canRetry(runFixture({ state: FAILED_STATE }))).toBe(true);
        expect(canRetry(runFixture({ state: BLOCKED_PROJECT_STATE }))).toBe(true);
        expect(canRetry(runFixture({ state: BLOCKED_BINDING_STATE }))).toBe(true);

        const notRetryable: readonly RunRow['state'][] = [
            'pending',
            'claimed',
            'starting',
            'dispatched',
            UNCONFIRMED_STATE,
            DEAD_LETTERED_STATE,
        ];
        for (const state of notRetryable) {
            expect(canRetry(runFixture({ state })), state).toBe(false);
        }
    });

    it('labels every state in operator vocabulary and never success-tones a failure', () => {
        const expected: readonly (readonly [RunRow['state'], string, Tone])[] = [
            ['pending', 'waiting', 'neutral'],
            ['claimed', 'claimed', 'info'],
            ['starting', 'starting', 'info'],
            ['dispatched', 'dispatched', 'success'],
            [FAILED_STATE, 'dispatch failed', 'warning'],
            [UNCONFIRMED_STATE, 'unconfirmed', 'warning'],
            [DEAD_LETTERED_STATE, 'dead-lettered', 'error'],
            [BLOCKED_PROJECT_STATE, 'blocked: project-missing', 'warning'],
            [BLOCKED_BINDING_STATE, 'blocked: binding-missing', 'warning'],
        ];
        for (const [state, label, tone] of expected) {
            const rows = runRows(runsState({ rows: [runFixture({ state })], status: 'ready' }));

            expect(rows[0]?.badge, state).toEqual({ label, tone });
        }
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

describe('T-024 honest rows (reason line, references, verification)', () => {
    it('carries a reason line for every state the model can reach (FR-074)', () => {
        const states: readonly RunRow['state'][] = [
            'pending',
            'claimed',
            'starting',
            'dispatched',
            FAILED_STATE,
            UNCONFIRMED_STATE,
            DEAD_LETTERED_STATE,
            BLOCKED_PROJECT_STATE,
        ];
        for (const state of states) {
            const rows = runRows(runsState({
                rows: [runFixture({ state, stateReason: `why the run is ${state}` })],
                status: 'ready',
            }));

            expect(rows[0]?.subtitle, state).toContain(`why the run is ${state}`);
        }
    });

    it('renders a hostile state reason as inert text (NFR-109)', () => {
        const hostile = '<img src=x onerror="steal()"> <script>alert(1)</script>';
        const rows = runRows(runsState({
            rows: [runFixture({ state: FAILED_STATE, stateReason: hostile })],
            status: 'ready',
        }));

        // The list primitive writes the subtitle through `textContent`, so the
        // text arrives verbatim and inert: no escaping that would hide the
        // reason from the operator, and no path that could evaluate it.
        expect(rows[0]?.subtitle).toBe(`acme/widget · ${hostile} · not dispatched yet`);
    });

    it('shows one reference alone, with no "+N more" affordance (FR-015)', () => {
        const rows = runRows(runsState({
            rows: [runFixture({ sourceReferences: [referenceFixture()], referenceCount: 1 })],
            status: 'ready',
        }));

        expect(rows[0]?.subtitle).toBe(
            'acme/widget · assignment 2026-09-28 09:00 · waiting for a panel · not dispatched yet',
        );
    });

    it('lists every reference with kind, origin, and detection time, marking late ones (AC-101)', () => {
        const rows = runRows(runsState({
            rows: [runFixture({
                sourceReferences: [
                    referenceFixture(),
                    referenceFixture({
                        deliveryId: 'evt-acme~widget~7~comment',
                        kind: 'mention',
                        origin: 'comment:4242',
                        detectedAt: '2026-09-28T09:05:00.000Z',
                        presentAtAuthorization: false,
                    }),
                ],
                referenceCount: 2,
            })],
            status: 'ready',
        }));
        const subtitle = rows[0]?.subtitle ?? '';

        expect(subtitle).toContain('2 reasons · assignment 2026-09-28 09:00');
        expect(subtitle).toContain('mention 2026-09-28 09:05 via comment:4242'
            + ' (after authorization, may not have been seen)');
    });

    it('states the reasons the reference cap kept off the list (T-038)', () => {
        const rows = runRows(runsState({
            rows: [runFixture({
                sourceReferences: [referenceFixture()],
                referenceCount: 3,
                referencesNotRetained: 2,
                referencesTruncated: true,
            })],
            status: 'ready',
        }));

        expect(rows[0]?.subtitle).toContain(
            '3 reasons · assignment 2026-09-28 09:00 +2 more reasons not listed',
        );
    });

    it('shows the read-back verdict and never success-tones a mismatch (FR-043, AC-125)', () => {
        const matched = runRows(runsState({
            rows: [runFixture({
                state: 'dispatched',
                dispatchResult: SESSION_RESULT,
                verification: {
                    observedAgent: EXPECTED_AGENT,
                    expectedAgent: EXPECTED_AGENT,
                    ok: true,
                    note: null,
                },
            })],
            status: 'ready',
        }))[0];
        expect(matched?.badge).toEqual({ label: 'dispatched', tone: 'success' });
        expect(matched?.subtitle).toContain('agent verified: project-manager (expected project-manager)');

        const mismatched = runRows(runsState({
            rows: [runFixture({
                state: 'dispatched',
                dispatchResult: SESSION_RESULT,
                verification: {
                    observedAgent: 'researcher',
                    expectedAgent: EXPECTED_AGENT,
                    ok: false,
                    note: 'agent pin drifted',
                },
            })],
            status: 'ready',
        }))[0];
        expect(mismatched?.badge?.tone).toBe('warning');
        expect(mismatched?.subtitle).toContain('agent mismatch: observed researcher, expected project-manager');
        expect(mismatched?.subtitle).toContain('agent pin drifted');

        const unreadable = runRows(runsState({
            rows: [runFixture({
                state: 'dispatched',
                verification: { observedAgent: null, expectedAgent: EXPECTED_AGENT, ok: false, note: 'unreadable' },
            })],
            status: 'ready',
        }))[0];
        expect(unreadable?.badge?.tone).toBe('warning');
        expect(unreadable?.subtitle).toContain('agent mismatch: observed unreadable, expected project-manager');
    });
});

describe('runAffordance (003’s state→affordance table, FR-041/FR-033/FR-027)', () => {
    it('names the control and its reason for the three actionable states', () => {
        const failed = runAffordance(runFixture({ state: FAILED_STATE }));
        expect(failed.action).toBe('retry');
        expect(failed.label).toBe('Retry run');
        expect(failed.reason).toContain('retry returns it to waiting');

        const blocked = runAffordance(runFixture({ state: BLOCKED_PROJECT_STATE }));
        expect(blocked.action).toBe('retry');
        expect(blocked.label).toBe('Retry run');
        expect(blocked.reason).toContain('project-missing');
        expect(blocked.reason).toContain('once the cause clears');

        expect(runAffordance(runFixture({ state: UNCONFIRMED_STATE }))).toMatchObject({
            action: 'resolve',
            label: 'Resolve run',
        });
        expect(runAffordance(runFixture({ state: DEAD_LETTERED_STATE }))).toMatchObject({
            action: 'requeue',
            label: 'Return to waiting',
        });
    });

    it('offers nothing — with the state’s own reason — where the service would refuse', () => {
        const refused: readonly RunRow['state'][] = ['pending', 'claimed', 'starting', 'dispatched'];
        for (const state of refused) {
            const affordance = runAffordance(runFixture({ state }));

            expect(affordance.action, state).toBe('none');
            expect(affordance.label, state).toBeNull();
            expect(affordance.reason, state).not.toBe('');
        }

        expect(runAffordance(runFixture({ state: 'dispatched' })).reason).toContain('session exists');
        expect(runAffordance(runFixture({ state: 'pending' })).reason).toContain('waiting for a panel');
    });

    it('renders an unrecognised state raw and offers nothing', () => {
        expect(stateLabel('archived')).toBe('archived');
        expect(stateLabel('blocked:archived')).toBe('blocked: archived');
        expect(runAffordance({ state: 'archived' })).toEqual({
            action: 'none',
            label: null,
            reason: 'this run reports a state the panel does not recognise — no action is offered',
        });
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
        rt.state.repos.runs.selectedRun = RUN_ID;

        await loadRuns(rt);

        expect(rt.state.repos.runs.selectedRun).toBeNull();
    });
});

describe('retryRun (POST, refresh, honest copy)', () => {
    it('requeues the selected run, then re-reads the list', async () => {
        // A failed run is where the service accepts a retry (T-024's table);
        // the list re-read answers with the run back in waiting.
        const failed = runFixture({ state: FAILED_STATE, dispatchResult: 'session-create-failed' });
        const { rt, service } = retryRuntime(failed, {
            [`POST ${retryPath(RUN_ID)}`]: { status: 200, body: '{"retried":true}' },
            [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) },
        });

        await retryRun(rt);

        expect(service.calls).toEqual([`POST ${retryPath(RUN_ID)}`, RUNS_GET]);
        expect(rt.state.repos.runs.note).toContain('Requeued #7');
        expect(rt.state.repos.runs.note).toContain('next relay poll');
        expect(rt.state.repos.runs.rows[0]?.state).toBe('pending');
    });

    it('explains a 409 invalid-transition from the service envelope', async () => {
        // The panel's row is stale (it still looks retryable, so the POST is
        // genuinely sent); the service knows better and answers 409.
        const stale = runFixture({ state: FAILED_STATE });
        const actual = runFixture({ state: 'dispatched', dispatchResult: SESSION_RESULT });
        const { rt, service } = retryRuntime(stale, {
            [`POST ${retryPath(RUN_ID)}`]: {
                status: 409,
                body: '{"error":{"code":"invalid-transition","message":"already dispatched"}}',
            },
            [RUNS_GET]: { status: 200, body: runsBody([actual]) },
        });

        await retryRun(rt);

        expect(service.calls).toEqual([`POST ${retryPath(RUN_ID)}`, RUNS_GET]);
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

        selectRun(rt, RUN_ID);
        expect(rt.state.repos.runs.selectedRun).toBe(RUN_ID);
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
        rt.state.repos.runs = runsState({ rows: [runFixture()], status: 'ready', selectedRun: RUN_ID });

        await openRun(rt);

        expect(opened).toEqual([ISSUE_URL]);
        expect(rt.state.repos.runs.note).toBe('');
    });

    it('lands an openUrl failure on the note instead of throwing', async () => {
        const host = fakeHost({ openUrl: () => Promise.reject(new Error('HOST_REJECTED')) });
        const rt = createTestRuntime(host);
        rt.state.repos.runs = runsState({ rows: [runFixture()], status: 'ready', selectedRun: RUN_ID });

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
