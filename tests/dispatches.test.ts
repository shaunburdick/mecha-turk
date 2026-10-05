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
import type { ListItem, Tone } from '@openchamber/sdk/ui';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
import { initialDispatches } from '../src/panel-state.ts';
import { PLAIN_RUN_STATES } from '../src/run-state.ts';
import {
    DISPATCHES_EMPTY_STATUS,
    runAffordance,
    dispatchRows,
    dispatchesStatusText,
    selectedRun,
    stateLabel,
} from '../src/dispatches-rows.ts';
import { referenceDetailLines } from '../src/dispatches-detail.ts';
import { SUBJECT_AUTHOR_BASIS } from '../src/run-actor.ts';
import type { RunAffordance } from '../src/dispatches-rows.ts';
import {
    loadDispatches,
    openDispatch,
    requeueRun,
    resolveNoSession,
    resolveSessionCreated,
    retryRun,
    selectDispatch,
    setSessionInput,
} from '../src/dispatches.ts';
import { parseDispatchesBody } from '../src/dispatches-service.ts';
import {
    AUDIT_EMPTY_STATUS,
    AUDIT_IDLE_STATUS,
    AUDIT_ROW_LIMIT,
    auditItems,
    auditStatusText,
    initialAuditHistory,
    loadAuditHistory,
    parseAuditBody,
} from '../src/audit-view.ts';
import type { AuditViewState } from '../src/audit-view.ts';
import { EVENTS_PATH, auditPath, requeuePath, resolvePath, retryPath } from '../src/service-calls.ts';
import type { PanelRuntime, DispatchesState } from '../src/panel-state.ts';
import type { RunReference, RunRow } from '../src/dispatches-service.ts';
import type { PromptSource } from '../src/prompt.ts';
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

/** The fifth declared blocked cause, the one the actor-policy gate parks in (003 FR-078). */
const BLOCKED_ACTOR_STATE: RunRow['state'] = 'blocked:actor-not-allowed';

/** The badge tone every state needing an operator's decision reads as (FR-040). */
const DECISION_TONE: Tone = 'warning';

/** The badge label and state of the cause the actor-policy gate parks a run in. */
const ACTOR_BLOCKED_LABEL = 'blocked: actor-not-allowed';

/** The login the gate named as denied, used by 005 AC-145's fixtures. */
const DENIED_LOGIN = 'stranger';

/** The login an allowed actor is attributed as on a coalesced run. */
const ALLOWED_LOGIN = 'alice';

/**
 * Detection stamp the coalesced-run fixtures give a reference that arrived after
 * authorization: a rider on someone else's run, which is what has to stay visible
 * (003 FR-011, FR-077).
 */
const RIDER_DETECTED_AT = '2026-09-28T09:05:00.000Z';
/** Agent every read-back fixture expects (and, when matched, observes). */
const EXPECTED_AGENT = 'project-manager';

/** The waiting run's projected state reason (the fixture's, and the copy's). */
const WAITING_REASON = 'waiting for a panel';

/** Body every run operation answers with when the service accepts it. */
const ACCEPTED_BODY = '{"state":"pending"}';

/** The default `GET /v1/events` key the service double answers. */
const RUNS_GET = `GET ${EVENTS_PATH}?limit=25`;

/**
 * The `page` member a paged answer carries (005 contract §2).
 *
 * @returns The member, ready to be spread into an answer body.
 */
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
 * @returns A complete, valid row.
 */
/** Hostile markup for the tests that prove the list primitive never evaluates it. */
const HOSTILE_MARKER = '<img src=x onerror="steal()"> <script>alert(1)</script>';

/**
 * A `promptSources` slot holding markup, which the tier union forbids.
 *
 * The hostile-render test needs the value the type refuses, because the point
 * of the test is that the slot is treated as untrusted text: the list primitive
 * writes the subtitle through `textContent`, so the marker arrives verbatim and
 * nothing evaluates it.
 */
// eslint-disable-next-line llm-core/no-type-system-bypass, llm-core/no-chained-type-assertions -- not a tier
const untrustedTierText = [HOSTILE_MARKER] as unknown as readonly PromptSource[];

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
        stateReason: WAITING_REASON,
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
        promptPresent: false,
        promptFingerprint: null,
        promptLength: null,
        promptSources: null,
        // No gate has judged this run yet, so no policy shape is recorded
        // (003 FR-079) — the honest reading, never a silent `'open'`.
        actorPolicy: null,
        ...overrides,
    };
}

/**
 * Build one source reference the way the service projects it (FR-013).
 *
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
 * Build a Dispatches-section state around the given rows.
 */
function runsState(overrides: Partial<DispatchesState> = {}): DispatchesState {
    return { ...initialDispatches(), ...overrides };
}

/** Body the service answers `GET /v1/events` with for the given rows. */
function runsBody(rows: readonly RunRow[]): string {
    return JSON.stringify({ events: rows, page: pageMember(rows.length) });
}

/**
 * The rendered rows for a single ready run.
 *
 * Every reference assertion here spells out the same four-deep fixture chain,
 * so it is named once and each test reads as one line of arrangement.
 *
 * @returns The rows the panel renders.
 */
function rowsForRun(overrides: Partial<RunRow> = {}): ListItem[] {
    return dispatchRows(runsState({ rows: [runFixture(overrides)], status: 'ready' }));
}

/** A service double: recorded `METHOD path` calls plus a swappable table. */
interface ServiceDouble {
    /** `serviceRequest` member for {@link fakeHost}. */
    readonly serviceRequest: (request: GuestRequest) => Promise<GuestRequestResult>;
    /** Calls observed, in order, as `METHOD path`. */
    readonly calls: readonly string[];
    /** Bodies those calls carried, in the same order (`undefined` when none). */
    readonly bodies: readonly (string | undefined)[];
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
    const bodies: (string | undefined)[] = [];
    let routes = table;

    return {
        calls,
        bodies,
        setRoutes: (next) => {
            routes = next;
        },
        serviceRequest: async (request) => {
            const key = `${request.method} ${request.path}`;
            calls.push(key);
            bodies.push(request.body);

            return routes[key] ?? { status: DEFAULT_STATUS, body: DEFAULT_BODY };
        },
    };
}

/**
 * Build a runtime whose selected run is `row`, against the given routes.
 *
 * @returns The runtime and its service double.
 */
function retryRuntime(row: RunRow, table: RouteTable): { readonly rt: PanelRuntime; readonly service: ServiceDouble } {
    const service = serviceDouble(table);
    const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
    rt.state.dispatches = runsState({ rows: [row], status: 'ready', selectedRun: row.id });

    return { rt, service };
}

describe('parseDispatchesBody (the service projection, round-tripped)', () => {
    it('reads every field the runs row renders from', () => {
        {
            const sent = runFixture({ state: 'claimed', claimedAt: '2026-09-27T10:00:00.000Z' });
            const parsed = parseDispatchesBody(runsBody([sent]));

            expect(parsed).toHaveLength(1);
            expect(parsed?.[0]).toEqual(sent);
        }
        {
            const fixture = runFixture({ kind: 'review', headSha: 'abc123', baseRef: 'main' });
            const parsed = parseDispatchesBody(runsBody([fixture]));

            expect(parsed?.[0]?.kind).toBe('review');
            expect(parsed?.[0]?.headSha).toBe('abc123');
            expect(parsed?.[0]?.baseRef).toBe('main');
        }
        {
            const unknownKind = JSON.stringify({ events: [{ ...runFixture(), kind: 'telepathy' }] });
            expect(parseDispatchesBody(unknownKind)?.[0]?.kind).toBe('assignment');

            const badState = JSON.stringify({ events: [{ ...runFixture(), state: 'telepathy' }] });
            expect(parseDispatchesBody(badState)).toBeNull();
            expect(parseDispatchesBody('{"events":[{"id":"half"}]}')).toBeNull();
            expect(parseDispatchesBody('not a document')).toBeNull();
            expect(parseDispatchesBody('{"runs":[]}')).toBeNull();
            expect(parseDispatchesBody(runsBody([]))).toEqual([]);
        }
        {
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
                const parsed = parseDispatchesBody(runsBody([runFixture({ state })]));
                expect(parsed?.[0]?.state).toBe(state);
            }
        }
        {
            const refused = ['in-flight', 'blocked:', 'blocked:Project-Missing', 'blocked:a b', 'telepathy'];

            for (const state of refused) {
                const body = JSON.stringify({ events: [{ ...runFixture(), state }] });
                expect(parseDispatchesBody(body)).toBeNull();
            }
        }
        {
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

            const parsed = parseDispatchesBody(runsBody([sent]));

            expect(parsed).toHaveLength(1);
            expect(parsed?.[0]).toEqual(sent);
        }
    });

    it('refuses counting members that do not reconcile (T-038)', () => {
        const missing = JSON.stringify({
            events: [{ ...runFixture(), referenceCount: 5, referencesNotRetained: 1 }],
        });
        expect(parseDispatchesBody(missing)).toBeNull();

        const unflagged = JSON.stringify({
            events: [{ ...runFixture({ referenceCount: 1, referencesNotRetained: 1 }), referencesTruncated: false }],
        });
        expect(parseDispatchesBody(unflagged)).toBeNull();
    });
});

describe('dispatchRows / dispatchesStatusText (the copy the list renders)', () => {
    it('renders rows with kind, issue, state badge, relative age, reason, and result', () => {
        {
            const rows = dispatchRows(runsState({ rows: [runFixture()], status: 'ready' }));

            expect(rows).toHaveLength(1);
            expect(rows[0]).toEqual({
                id: RUN_ID,
                leading: 'assign',
                title: '#7 Fix the flaky test',
                subtitle: 'acme/widget · waiting for a panel · not dispatched yet · prompt not set',
                meta: '2m ago',
                badge: { label: 'waiting', tone: 'neutral' },
            });
        }
        {
            const rows = dispatchRows(
                runsState({ rows: [runFixture({
                    state: 'dispatched', dispatchResult: SESSION_RESULT })], status: 'ready' }),
            );

            expect(rows[0]?.badge).toEqual({ label: 'dispatched', tone: 'success' });
            expect(rows[0]?.subtitle).toContain(SESSION_RESULT);
        }
        {
            const rows = dispatchRows(
                runsState({
                    rows: [runFixture({ state: 'claimed', dispatchResult: 'problem ghp_abcdefghijklmnopqrstuvwx' })],
                    status: 'ready',
                }),
            );

            expect(rows[0]?.subtitle).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
            expect(rows[0]?.subtitle).toContain('[redacted:github-token-classic]');
        }
        {
            const canRetry = (state: RunRow['state']): boolean =>
                runAffordance(runFixture({ state })).action === 'retry';
            expect(canRetry(FAILED_STATE)).toBe(true);
            expect(canRetry(BLOCKED_PROJECT_STATE)).toBe(true);
            expect(canRetry(BLOCKED_BINDING_STATE)).toBe(true);
            // The fifth declared cause retries on exactly the same terms (FR-078):
            // the service re-checks the live policy and refuses with its own
            // reason until it clears, which is what every other cause does.
            expect(canRetry(BLOCKED_ACTOR_STATE)).toBe(true);

            const notRetryable: readonly RunRow['state'][] = [
                'pending',
                'claimed',
                'starting',
                'dispatched',
                UNCONFIRMED_STATE,
                DEAD_LETTERED_STATE,
            ];
            for (const state of notRetryable) {
                expect(canRetry(state), state).toBe(false);
            }
        }
        {
            // Every state that means "an operator must decide" — a failure, a
            // wedge, and the whole blocked family — reads as one warning tone,
            // so a refusal is never mistakable for a success at a glance (FR-040).
            const expected: readonly (readonly [RunRow['state'], string, Tone])[] = [
                ['pending', 'waiting', 'neutral'],
                ['claimed', 'claimed', 'info'],
                ['starting', 'starting', 'info'],
                ['dispatched', 'dispatched', 'success'],
                [FAILED_STATE, 'dispatch failed', DECISION_TONE],
                [UNCONFIRMED_STATE, 'unconfirmed', DECISION_TONE],
                [DEAD_LETTERED_STATE, DEAD_LETTERED_STATE, 'error'],
                [BLOCKED_PROJECT_STATE, 'blocked: project-missing', DECISION_TONE],
                [BLOCKED_BINDING_STATE, 'blocked: binding-missing', DECISION_TONE],
                [BLOCKED_ACTOR_STATE, ACTOR_BLOCKED_LABEL, DECISION_TONE],
            ];
            for (const [state, label, tone] of expected) {
                const rows = dispatchRows(runsState({ rows: [runFixture({ state })], status: 'ready' }));

                expect(rows[0]?.badge, state).toEqual({ label, tone });
            }
        }
        {
            expect(dispatchesStatusText(runsState({ status: 'ready' }))).toBe(DISPATCHES_EMPTY_STATUS);
            const oneRow = runsState({ status: 'ready', rows: [runFixture()] });
            expect(dispatchesStatusText(oneRow)).toBe(
                // The count is the range line's to state (FR-042); this lede
                // carries the order and the selection hint only.
                'newest first · select a row to open or retry',
            );
        }
    });
});

describe('T-024 honest rows (reason line, references, verification)', () => {
    it('carries a reason line for every state the model can reach', () => {
        {
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
                const rows = dispatchRows(runsState({
                    rows: [runFixture({ state, stateReason: `why the run is ${state}` })],
                    status: 'ready',
                }));

                expect(rows[0]?.subtitle, state).toContain(`why the run is ${state}`);
            }
        }
        {
            const hostile = '<img src=x onerror="steal()"> <script>alert(1)</script>';
            const rows = dispatchRows(runsState({
                rows: [runFixture({ state: FAILED_STATE, stateReason: hostile })],
                status: 'ready',
            }));

            // The list primitive writes the subtitle through `textContent`, so the
            // text arrives verbatim and inert: no escaping that would hide the
            // reason from the operator, and no path that could evaluate it.
            expect(rows[0]?.subtitle).toBe(`acme/widget · ${hostile} · not dispatched yet · prompt not set`);
        }
        {
            const rows = rowsForRun({ sourceReferences: [referenceFixture()], referenceCount: 1 });

            // 005 FR-094: the reference names its actor, and a run stored before
            // attribution says *actor not recorded* rather than naming nobody.
            expect(rows[0]?.subtitle).toBe(
                'acme/widget · assignment 2026-09-28 09:00 · actor not recorded'
                    + ' · waiting for a panel · not dispatched yet · prompt not set',
            );
        }
        {
            const fingerprint = 'mtp-0123456789abcdef0123456789abcdef';
            const set = dispatchRows(runsState({
                rows: [runFixture({
                    promptPresent: true,
                    promptFingerprint: fingerprint,
                    promptLength: 340,
                    promptSources: ['binding'],
                })],
                status: 'ready',
            }));
            expect(set[0]?.subtitle).toContain(`prompt set · binding · ${fingerprint} · 340 chars`);

            // The row never holds the instruction: there is no member for it to
            // hold, so `host.storage` can only ever receive the reference.
            const row = runFixture();
            expect('promptText' in row).toBe(false);
            expect(JSON.stringify(set)).not.toContain('promptText');
        }
        {
            // The parser refuses a fingerprint outside the `mtp-` format, so this
            // is the renderer's own posture with a value it was handed anyway.
            const hostile = '<img src=x onerror="steal()">';
            const rows = dispatchRows(runsState({
                rows: [runFixture({
                    promptPresent: true,
                    promptFingerprint: hostile,
                    promptLength: 1,
                    promptSources: ['binding'],
                })],
                status: 'ready',
            }));

            expect(rows[0]?.subtitle).toContain(hostile);
        }
        {
            const rows = rowsForRun({
                sourceReferences: [
                    referenceFixture(),
                    referenceFixture({
                        deliveryId: 'evt-acme~widget~7~comment',
                        kind: 'mention',
                        origin: 'comment:4242',
                        detectedAt: RIDER_DETECTED_AT,
                        presentAtAuthorization: false,
                    }),
                ],
                referenceCount: 2,
            });
            const subtitle = rows[0]?.subtitle ?? '';

            expect(subtitle).toContain('2 reasons · assignment 2026-09-28 09:00');
            expect(subtitle).toContain('mention 2026-09-28 09:05 via comment:4242'
                + ' (after authorization, may not have been seen) · actor not recorded');
        }
    });

    it('states the reasons the reference cap kept off the list', () => {
        {
            const rows = rowsForRun({
                sourceReferences: [referenceFixture()],
                referenceCount: 3,
                referencesNotRetained: 2,
                referencesTruncated: true,
            });

            expect(rows[0]?.subtitle).toContain('3 reasons · assignment 2026-09-28 09:00 · actor not recorded');
            expect(rows[0]?.subtitle).toContain('+2 more reasons not listed');
        }
        {
            const matched = dispatchRows(runsState({
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

            const mismatched = dispatchRows(runsState({
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

            const unreadable = dispatchRows(runsState({
                rows: [runFixture({
                    state: 'dispatched',
                    verification: { observedAgent: null, expectedAgent: EXPECTED_AGENT, ok: false, note: 'unreadable' },
                })],
                status: 'ready',
            }))[0];
            expect(unreadable?.badge?.tone).toBe('warning');
        }
        {
            // `expectedAgent: ''` is the documented *no baseline configured*: the
            // row still names the observed agent, and neither the phrase nor the
            // badge may claim a mismatch the comparison never made.
            const uncompared = dispatchRows(runsState({
                rows: [runFixture({
                    state: 'dispatched',
                    dispatchResult: SESSION_RESULT,
                    verification: {
                        observedAgent: EXPECTED_AGENT,
                        expectedAgent: '',
                        ok: false,
                        note: 'no baseline is configured, so nothing was compared',
                    },
                })],
                status: 'ready',
            }))[0];

            expect(uncompared?.subtitle).toContain(`agent read back: ${EXPECTED_AGENT}`);
            expect(uncompared?.subtitle).toContain('no baseline is configured');
            expect(uncompared?.subtitle).not.toContain('mismatch');
            // No expectation was missed, so the state keeps its own tone.
            expect(uncompared?.badge).toEqual({ label: 'dispatched', tone: 'success' });
        }
    });
});

describe('T-028 the row’s prompt line (sources, fingerprint, length — never the text)', () => {
    /** Fingerprint every set-reference case in this block carries. */
    const FINGERPRINT = 'mtp-0123456789abcdef0123456789abcdef';

    it('names the contributing tiers beside the fingerprint', () => {
        {
            const set = dispatchRows(runsState({
                rows: [runFixture({
                    promptPresent: true,
                    promptFingerprint: FINGERPRINT,
                    promptLength: 512,
                    promptSources: ['global', 'account', 'binding'],
                })],
                status: 'ready',
            }));

            expect(set[0]?.subtitle).toContain(
                `prompt set · global+account+binding · ${FINGERPRINT} · 512 chars`,
            );
        }
        {
            const partial = dispatchRows(runsState({
                rows: [runFixture({
                    promptPresent: true,
                    promptFingerprint: FINGERPRINT,
                    promptLength: 64,
                    promptSources: ['global', 'binding'],
                })],
                status: 'ready',
            }));

            expect(partial[0]?.subtitle).toContain(`prompt set · global+binding · ${FINGERPRINT} · 64 chars`);
        }
        {
            // The closed reader refuses an unknown tier before a row can parse
            // (T-027), so this is the renderer's own posture with a value it was
            // handed anyway — the same stance the hostile-fingerprint case above
            // takes. The list primitive writes the subtitle through `textContent`,
            // so the marker arrives verbatim: no escaping hides it from the
            // operator, and no path could evaluate it.
            const marker = HOSTILE_MARKER;
            const rows = dispatchRows(runsState({
                rows: [{
                    ...runFixture({
                        promptPresent: true,
                        promptFingerprint: FINGERPRINT,
                        promptLength: 12,
                    }),
                    promptSources: untrustedTierText,
                }],
                status: 'ready',
            }));
            const subtitle = rows[0]?.subtitle ?? '';

            expect(subtitle).toContain(`prompt set · ${marker} · ${FINGERPRINT} · 12 chars`);
            expect(subtitle).not.toContain('&lt;');
        }
        {
            const untiered = dispatchRows(runsState({
                rows: [runFixture({
                    promptPresent: false,
                    promptFingerprint: null,
                    promptLength: null,
                    promptSources: null,
                })],
                status: 'ready',
            }));
            expect(untiered[0]?.subtitle).toContain('prompt not set');
            expect(untiered[0]?.subtitle).not.toContain('prompt set ·');

            // A present reference with no tier to name is a state the reader
            // refuses outright, so the renderer only has to hold the line: no
            // empty source segment may print between the two separators.
            const noSources = dispatchRows(runsState({
                rows: [{
                    ...runFixture({
                        promptPresent: true,
                        promptFingerprint: FINGERPRINT,
                        promptLength: 8,
                    }),
                    promptSources: [],
                }],
                status: 'ready',
            }));
            expect(noSources[0]?.subtitle).toContain('prompt not set');
            expect(noSources[0]?.subtitle).not.toContain('prompt set ·');
        }
    });
});

describe('runAffordance (003’s state→affordance table, FR-041/FR-033/FR-027)', () => {
    it('names the control and its reason for the three actionable states', () => {
        {
            const failed = runAffordance(runFixture({ state: FAILED_STATE }));
            expect(failed.action).toBe('retry');

            const blocked = runAffordance(runFixture({ state: BLOCKED_PROJECT_STATE }));
            expect(blocked.action).toBe('retry');
            expect(blocked.reason).toContain('project-missing');

            expect(runAffordance(runFixture({ state: UNCONFIRMED_STATE }))).toMatchObject({
                action: 'resolve',
                label: 'Resolve dispatch',
            });
            expect(runAffordance(runFixture({ state: DEAD_LETTERED_STATE }))).toMatchObject({
                action: 'requeue',
                label: 'Return to waiting',
            });
        }
        {
            const refused: readonly RunRow['state'][] = ['pending', 'claimed', 'starting', 'dispatched'];
            for (const state of refused) {
                const affordance = runAffordance(runFixture({ state }));

                expect(affordance.action, state).toBe('none');
                expect(affordance.label, state).toBeNull();
                expect(affordance.reason, state).not.toBe('');
            }

            expect(runAffordance(runFixture({ state: 'pending' })).reason).toContain(WAITING_REASON);
        }
        {
            expect(runAffordance({ state: 'archived' })).toEqual({
                action: 'none',
                label: null,
                reason: 'this dispatch reports a state the panel does not recognise — no action is offered',
            });
        }
    });
});

/**
 * SC-104: one fixture per state of 003's `## Dispatch State Model`.
 *
 * The table **is** the assertion: every state the model declares appears here
 * with the label it must render and the control it must offer, and the guard
 * below refuses the table while `PLAIN_RUN_STATES` holds a state it does not
 * name — so a state added to 003 fails this suite until it is given a label
 * and an affordance, which is exactly what SC-104 asks for.
 */
/**
 * 003 v1.8.0 — the actor allow-list gate's row (FR-078; 005 FR-044, FR-046).
 *
 * The row's own two claims: the **denied login** the service named is visible,
 * and the reason line names the field that restricts the binding rather than
 * offering a retry the operator cannot act on. And the table still **fails** for
 * a cause with no row of its own — the generic clause is a fallback, not a
 * licence to render nothing.
 */
describe('003 v1.8.0 the blocked actor-not-allowed row (FR-078)', () => {
    it('names the denied login, the field, and still refuses an unknown cause', async () => {
        {
            const rows = dispatchRows(runsState({
                rows: [runFixture({
                    state: BLOCKED_ACTOR_STATE,
                    stateReason: "no source reference on this run names an actor the binding's allowedUsers "
                        + 'permits: bob (the author GitHub recorded)',
                })],
                status: 'ready',
            }));

            expect(rows[0]?.subtitle).toContain('bob');
            expect(rows[0]?.badge?.label).toBe(ACTOR_BLOCKED_LABEL);
        }
        {
            const affordance = runAffordance(runFixture({ state: BLOCKED_ACTOR_STATE }));

            expect(affordance.action).toBe('retry');
            expect(affordance.reason).toContain('allowedUsers');
            expect(affordance.reason).not.toContain('a guard refused');
            // The permitted set is configuration; the reason names the field only.
            expect(affordance.reason).not.toMatch(/@|permitted:/);
        }
        {
            // The generic clause keeps answering for a state a future build may produce
            // (FR-074) rather than guessing a control for one it does not.
            const unknown = runAffordance({ state: 'blocked:not-yet-produced' });
            expect(unknown.action).toBe('retry');
            expect(unknown.reason).toContain('not-yet-produced');

            const future = runAffordance({ state: 'archived' });
            expect(future.action).toBe('none');
            expect(future.label).toBeNull();
            expect(future.reason).toContain('does not recognise');
        }
    });
});

describe('SC-104 one fixture per state of the dispatch state model', () => {
    /** Every declared state, with the label and control it must render. */
    const TABLE: readonly {
        readonly state: RunRow['state'];
        readonly label: string;
        readonly action: RunAffordance['action'];
    }[] = [
        { state: 'pending', label: 'waiting', action: 'none' },
        { state: 'claimed', label: 'claimed', action: 'none' },
        { state: 'starting', label: 'starting', action: 'none' },
        { state: 'dispatched', label: 'dispatched', action: 'none' },
        { state: FAILED_STATE, label: 'dispatch failed', action: 'retry' },
        { state: UNCONFIRMED_STATE, label: 'unconfirmed', action: 'resolve' },
        { state: DEAD_LETTERED_STATE, label: 'dead-lettered', action: 'requeue' },
        { state: BLOCKED_PROJECT_STATE, label: 'blocked: project-missing', action: 'retry' },
        { state: BLOCKED_BINDING_STATE, label: 'blocked: binding-missing', action: 'retry' },
        { state: BLOCKED_ACTOR_STATE, label: ACTOR_BLOCKED_LABEL, action: 'retry' },
    ];

    it('names a label, a reason, and a control for every declared state', () => {
        {
            for (const row of TABLE) {
                expect(stateLabel(row.state), row.state).toBe(row.label);

                const affordance = runAffordance({ state: row.state });
                expect(affordance.action, row.state).toBe(row.action);
                expect(affordance.reason, row.state).not.toBe('');
                // Absence is meaningful: no control means no label, never a greyed one.
                expect(affordance.label === null, row.state).toBe(row.action === 'none');
            }
        }
        {
            const named = new Set(TABLE.map((row) => row.state));
            for (const state of PLAIN_RUN_STATES) {
                expect(named.has(state), `003 declared ${state} and SC-104 has no row for it`).toBe(true);
            }
        }
        {
            const retried = TABLE.filter((row) => row.action === 'retry').map((row) => row.state);
            expect(retried).toEqual([FAILED_STATE, BLOCKED_PROJECT_STATE, BLOCKED_BINDING_STATE, BLOCKED_ACTOR_STATE]);

            const resolved = TABLE.filter((row) => row.action === 'resolve').map((row) => row.state);
            expect(resolved).toEqual([UNCONFIRMED_STATE]);

            for (const state of ['pending', 'dispatched', UNCONFIRMED_STATE]) {
                expect(runAffordance({ state }).action, state).not.toBe('retry');
            }

        }
    });
});

describe('loadDispatches (read the history without lying about failures)', () => {
    it('lands a readable list in state and marks the section ready', async () => {
        {
            const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) } });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));

            await loadDispatches(rt);

            expect(rt.state.dispatches.status).toBe('ready');
            expect(rt.state.dispatches.rows).toHaveLength(1);
            expect(rt.state.dispatches.note).toBe('');
        }
    });

    it('keeps the rows it holds and explains a refused refresh', async () => {
        {
            const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) } });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
            await loadDispatches(rt);

            service.setRoutes({
                [RUNS_GET]: { status: 503, body: '{"error":{"code":"storage-unavailable"}}' },
            });
            await loadDispatches(rt);

            expect(rt.state.dispatches.status).toBe('error');
            expect(rt.state.dispatches.note).toContain('service answered 503');
            // The rows the operator was reading survive a failed refresh.
            expect(rt.state.dispatches.rows).toHaveLength(1);
        }
    });

    it('reports an unreadable body as unreadable instead of half-trusting it', async () => {
        {
            const service = serviceDouble({
                [RUNS_GET]: { status: 200, body: JSON.stringify({ events: [{ id: 'half' }], page: pageMember(1) }) },
            });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));

            await loadDispatches(rt);

            expect(rt.state.dispatches.status).toBe('error');
            expect(rt.state.dispatches.rows).toEqual([]);
        }
    });

    it('shows the empty state when the service has no events at all', async () => {
        {
            const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([]) } });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));

            await loadDispatches(rt);

            expect(rt.state.dispatches.status).toBe('ready');
            expect(rt.state.dispatches.rows).toEqual([]);
            expect(dispatchesStatusText(rt.state.dispatches)).toBe(DISPATCHES_EMPTY_STATUS);
            expect(dispatchRows(rt.state.dispatches)).toEqual([]);
        }
    });

    it('drops a selection whose row disappeared', async () => {
        {
            const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([]) } });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
            rt.state.dispatches.selectedRun = RUN_ID;

            await loadDispatches(rt);

            expect(rt.state.dispatches.selectedRun).toBeNull();
        }
    });

});

describe('retryRun (POST, refresh, honest copy)', () => {
    it('requeues the selected run, then re-reads the list', async () => {
        {
            // A failed run is where the service accepts a retry (T-024's table);
            // the list re-read answers with the run back in waiting.
            const failed = runFixture({ state: FAILED_STATE, dispatchResult: 'session-create-failed' });
            const { rt, service } = retryRuntime(failed, {
                [`POST ${retryPath(RUN_ID)}`]: { status: 200, body: '{"retried":true}' },
                [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) },
            });

            await retryRun(rt);

            expect(service.calls).toEqual([`POST ${retryPath(RUN_ID)}`, RUNS_GET]);
            expect(rt.state.dispatches.note).toContain('Requeued #7');
            expect(rt.state.dispatches.rows[0]?.state).toBe('pending');
        }
    });

    it('explains a 409 invalid-transition from the service envelope', async () => {
        {
            // The panel's row is stale (it still looks retryable, so the POST is
            // genuinely sent); the service knows better and answers 409.
            const stale = runFixture({ state: FAILED_STATE });
            const actual = runFixture({ state: 'dispatched', dispatchResult: SESSION_RESULT });
            const { rt, service } = retryRuntime(stale, {
                [`POST ${retryPath(RUN_ID)}`]: {
                    status: 409,
                    // Contract §6's own wording: the note renders it verbatim.
                    body: '{"error":{"code":"invalid-transition",'
                        + '"message":"already dispatched; a dispatched run cannot be retried"}}',
                },
                [RUNS_GET]: { status: 200, body: runsBody([actual]) },
            });

            await retryRun(rt);

            expect(service.calls).toEqual([`POST ${retryPath(RUN_ID)}`, RUNS_GET]);
            // The refresh after the refusal shows the state the service actually holds.
            expect(rt.state.dispatches.rows[0]?.state).toBe('dispatched');
        }
    });

    it('refuses locally — without a POST — when the selected run already dispatched', async () => {
        {
            const dispatched = runFixture({ state: 'dispatched', dispatchResult: SESSION_RESULT });
            const { rt, service } = retryRuntime(dispatched, {
                [RUNS_GET]: { status: 200, body: runsBody([dispatched]) },
            });

            await retryRun(rt);

            expect(service.calls).toEqual([]);
        }
    });

    it('does nothing when nothing is selected', async () => {
        {
            const service = serviceDouble({});
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
            rt.state.dispatches = runsState({ rows: [runFixture()], status: 'ready' });

            await retryRun(rt);

            expect(service.calls).toEqual([]);
            expect(rt.state.dispatches.note).toBe('');
        }
    });

});

describe('T-025 operator actions (confirmations, bodies, verdicts)', () => {
    /** Path of the return-to-waiting operation (contract §7). */
    const REQUEUE_POST = `POST ${requeuePath(RUN_ID)}`;

    /** Path of the resolve operation (contract §8). */
    const RESOLVE_POST = `POST ${resolvePath(RUN_ID)}`;

    /** Path of the retry operation (contract §6). */
    const RETRY_POST = `POST ${retryPath(RUN_ID)}`;

    /** A route table that answers every run operation with an accepted run. */
    function acceptedRoutes(): RouteTable {
        return {
            [REQUEUE_POST]: { status: 200, body: ACCEPTED_BODY },
            [RESOLVE_POST]: { status: 200, body: ACCEPTED_BODY },
            [RETRY_POST]: { status: 200, body: ACCEPTED_BODY },
            [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) },
        };
    }

    it('states the attempt reset before it sends a return-to-waiting', async () => {
        {
            const parked = runFixture({ state: DEAD_LETTERED_STATE });
            const { rt, service } = retryRuntime(parked, acceptedRoutes());

            await requeueRun(rt);

            expect(service.calls).toEqual([]);
            expect(rt.state.dispatches.pendingAction).toBe('requeue');
            expect(rt.state.dispatches.note).toContain('attempt count resets to 1');
            expect(rt.state.dispatches.note).toContain('requeue budget to 0');

            await requeueRun(rt);

            expect(service.calls).toEqual([REQUEUE_POST, RUNS_GET]);
            expect(JSON.parse(String(service.bodies[0]))).toEqual({ correlationId: RUN_ID, confirm: true });
            expect(rt.state.dispatches.pendingAction).toBeNull();
        }
    });

    it('reaches the two resolutions only from unconfirmed', async () => {
        {
            const waiting = runFixture({ state: 'pending' });
            const { rt, service } = retryRuntime(waiting, acceptedRoutes());

            await resolveNoSession(rt);
            await resolveSessionCreated(rt);

            expect(service.calls).toEqual([]);
            expect(rt.state.dispatches.pendingAction).toBeNull();
            expect(rt.state.dispatches.note).toContain(WAITING_REASON);
        }
    });

    it('states what to verify, warns, and shows the coordinates before resolving', async () => {
        {
            const wedge = runFixture({ state: UNCONFIRMED_STATE });
            const { rt, service } = retryRuntime(wedge, acceptedRoutes());

            await resolveSessionCreated(rt);

            expect(service.calls).toEqual([]);
            const copy = rt.state.dispatches.note;
            expect(copy).toContain('project prj_42');
            expect(copy).toContain(RUN_ID);
            expect(copy).toContain('OpenChamber');

            // The second click is the confirmation, and it refuses to guess the id.
            await resolveSessionCreated(rt);
            expect(service.calls).toEqual([]);

            setSessionInput(rt, 'ses_operator_found');
            await resolveSessionCreated(rt);

            expect(service.calls).toEqual([RESOLVE_POST, RUNS_GET]);
            const body = JSON.parse(String(service.bodies[0])) as Record<string, unknown>;
            expect(body).toMatchObject({
                correlationId: RUN_ID,
                decision: 'session-created',
                sessionId: 'ses_operator_found',
            });
        }
    });

    it('sends no-session with no session id and the guidance it showed', async () => {
        {
            const wedge = runFixture({ state: UNCONFIRMED_STATE });
            const { rt, service } = retryRuntime(wedge, acceptedRoutes());

            await resolveNoSession(rt);

            await resolveNoSession(rt);

            expect(service.calls).toEqual([RESOLVE_POST, RUNS_GET]);
            const body = JSON.parse(String(service.bodies[0])) as Record<string, unknown>;
            expect(body.decision).toBe('no-session');
            expect('sessionId' in body).toBe(false);
        }
    });

    it('echoes the run identity and the cause report a retry carries (contract §6)', async () => {
        {
            const failed = runFixture({ state: FAILED_STATE });
            const { rt, service } = retryRuntime(failed, acceptedRoutes());

            await retryRun(rt);

            expect(JSON.parse(String(service.bodies[0]))).toEqual({ correlationId: RUN_ID, attempt: 1 });

            const guarded = runFixture({ state: BLOCKED_BINDING_STATE, attempt: 3 });
            const second = retryRuntime(guarded, acceptedRoutes());
            await retryRun(second.rt);

            expect(JSON.parse(String(second.service.bodies[0]))).toEqual({
                correlationId: RUN_ID,
                attempt: 3,
                causeCleared: true,
            });

            // A cause only the operator can assert goes with what was asserted,
            // so the audit row says who reported it cleared.
            const reported = runFixture({ state: 'blocked:credential' });
            const third = retryRuntime(reported, acceptedRoutes());
            await retryRun(third.rt);

            expect(JSON.parse(String(third.service.bodies[0]))).toMatchObject({
                correlationId: RUN_ID,
                attempt: 1,
                causeCleared: true,
                causeReport: expect.stringContaining('operator confirmed'),
            });
        }
    });

    it('renders the service verdict verbatim when an operation is refused', async () => {
        {
            const parked = runFixture({ state: DEAD_LETTERED_STATE });
            const verdict = 'this run is not dead-lettered; it is already waiting';
            const { rt, service } = retryRuntime(parked, {
                ...acceptedRoutes(),
                [REQUEUE_POST]: {
                    status: 409,
                    body: `{"error":{"code":"invalid-transition","message":"${verdict}"}}`,
                },
            });

            await requeueRun(rt);
            await requeueRun(rt);

            expect(service.calls).toEqual([REQUEUE_POST, RUNS_GET]);
            expect(rt.state.dispatches.note).toBe(verdict);
        }
    });


    it('gates every run operation behind one busy flag (T-025)', async () => {
        // The double holds every answer until the test releases it, so the
        // gate is observable while an operation is genuinely in flight.
        const held: { release: () => void } = {
            release: (): void => {
                throw new Error('the gate was never armed');
            },
        };
        const gate = new Promise<void>((resolve) => {
            held.release = resolve;
        });
        const calls: string[] = [];
        const rt = createTestRuntime(fakeHost({
            serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
                calls.push(`${request.method} ${request.path}`);
                await gate;

                return { status: 200, body: runsBody([runFixture()]) };
            },
        }));
        rt.state.dispatches = runsState({
            rows: [runFixture({ state: FAILED_STATE })],
            status: 'ready',
            selectedRun: RUN_ID,
        });

        const first = retryRun(rt);
        await tick();
        expect(rt.state.dispatches.busy).toBe(true);

        // A second click while the first is in flight sends nothing.
        await retryRun(rt);
        expect(calls).toHaveLength(1);

        held.release();
        await first;

        expect(rt.state.dispatches.busy).toBe(false);
        expect(rt.state.dispatches.note).toContain('Requeued #7');
    });
});

/**
 * Build one audit entry the way the trail stores it (contract §2).
 */
function auditEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        seq: 1,
        timestamp: '2026-09-28T09:00:00.000Z',
        correlationId: RUN_ID,
        eventType: 'run.created',
        actorSource: 'service',
        entity: { kind: 'run', id: RUN_ID },
        decision: null,
        reason: 'run created from a detected delivery',
        redaction: { redacted: false, fields: [] },
        details: { subject: 'issue' },
        ...overrides,
    };
}

/** The response body the audit read answers with. */
function auditBody(entries: readonly Record<string, unknown>[]): string {
    return JSON.stringify({ entries });
}

/** The audit view's state around a selected fixture run. */
function auditState(overrides: Partial<AuditViewState> = {}): AuditViewState {
    return { ...initialAuditHistory(), ...overrides };
}

describe('T-026 audit history (keyed by the selected run, plain text)', () => {
    /** The one request the view is allowed to make: rows for this run. */
    const AUDIT_GET = `GET ${auditPath(RUN_ID)}`;

    it('fetches by the selected row correlation id and nothing else', async () => {
        {
            const service = serviceDouble({
                [AUDIT_GET]: {
                    status: 200,
                    body: auditBody([auditEntry(), auditEntry({
                        seq: 2, eventType: 'dispatch.retry', decision: 'retry' })]),
                },
            });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
            rt.state.dispatches = runsState({ rows: [runFixture()], status: 'ready', selectedRun: RUN_ID });

            await loadAuditHistory(rt);

            expect(service.calls).toEqual([AUDIT_GET]);
            expect(rt.state.dispatches.audit.status).toBe('ready');
            expect(rt.state.dispatches.audit.correlationId).toBe(RUN_ID);
            expect(rt.state.dispatches.audit.rows.map((row) => row.seq)).toEqual([1, 2]);
            expect(auditStatusText(rt.state.dispatches.audit)).toContain('2 rows');
            expect(auditStatusText(rt.state.dispatches.audit)).toContain(RUN_ID);

            const items = auditItems(rt.state.dispatches.audit);
            expect(items[0]).toEqual({
                id: '1',
                leading: '1',
                title: 'run.created · service',
                subtitle: 'run created from a detected delivery · {"subject":"issue"}',
                meta: '2026-09-28 09:00',
            });
        }
    });

    it('starts idle, says so, and resets with the selection', async () => {
        {
            expect(auditStatusText(initialAuditHistory())).toBe(AUDIT_IDLE_STATUS);
            // The control is disabled while nothing is selected, so the idle line
            // names the precondition instead of pointing at a button the same
            // screen refuses to enable (2026-10-01 review).
            expect(auditStatusText(auditState({ status: 'ready' }))).toBe(AUDIT_EMPTY_STATUS);
            expect(auditStatusText(auditState({ status: 'loading' }))).toContain('Reading');

            const service = serviceDouble({ [AUDIT_GET]: { status: 200, body: auditBody([auditEntry()]) } });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
            const other = runFixture({
                id: 'mt-run-bbbbccccddddeeeeffff00',
                correlationId: 'mt-run-bbbbccccddddeeeeffff00',
            });
            rt.state.dispatches = runsState({ rows: [runFixture(), other], status: 'ready', selectedRun: RUN_ID });

            await loadAuditHistory(rt);
            expect(rt.state.dispatches.audit.status).toBe('ready');

            selectDispatch(rt, other.id);

            expect(rt.state.dispatches.audit.status).toBe('idle');
            expect(rt.state.dispatches.audit.rows).toEqual([]);
        }
    });

    it('refuses an unreadable body instead of half-showing it (fail closed)', async () => {
        {
            const service = serviceDouble({
                [AUDIT_GET]: { status: 200, body: '{"entries":[{"seq":"one"}]}' },
            });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
            rt.state.dispatches = runsState({ rows: [runFixture()], status: 'ready', selectedRun: RUN_ID });

            await loadAuditHistory(rt);

            expect(rt.state.dispatches.audit.status).toBe('error');
            expect(rt.state.dispatches.audit.rows).toEqual([]);
            expect(parseAuditBody('{"entries":[]}')).toEqual([]);
            expect(parseAuditBody('{"nope":[]}')).toBeNull();
        }
    });

    it('renders hostile reason and details as inert text', async () => {
        {
            const hostile = auditEntry({
                reason: '<img src=x onerror="steal()">',
                details: { note: '<script>alert(1)</script>' },
            });
            const rows = parseAuditBody(auditBody([hostile]));

            expect(rows).not.toBeNull();
            const items = auditItems(auditState({ status: 'ready', correlationId: RUN_ID, rows: rows ?? [] }));
            expect(items[0]?.subtitle).toBe('<img src=x onerror="steal()"> · {"note":"<script>alert(1)</script>"}');
        }
    });

    it('bounds the list and marks every cut', async () => {
        {
            const many = Array.from({ length: AUDIT_ROW_LIMIT + 50 }, (_value, index) => auditEntry({
                seq: index + 1 }));
            const rows = parseAuditBody(auditBody(many));

            expect(rows).toHaveLength(AUDIT_ROW_LIMIT);
            const items = auditItems(auditState({ status: 'ready', correlationId: RUN_ID, rows: rows ?? [] }));
            expect(items).toHaveLength(AUDIT_ROW_LIMIT);

            const blob = 'x'.repeat(500);
            const loud = parseAuditBody(auditBody([auditEntry({ reason: null, details: { blob } })]));
            const subtitle = auditItems(auditState({ status: 'ready', correlationId: RUN_ID, rows: loud ?? [] }))[0]
                ?.subtitle ?? '';
            expect(subtitle.endsWith('…')).toBe(true);
            expect(subtitle.length).toBeLessThanOrEqual(161);
        }
    });

    it('warns when the service cannot be reached, and keeps nothing', async () => {
        {
            const rt = createTestRuntime(fakeHost({
                serviceRequest: async () => {
                    throw new Error('ECONNREFUSED');
                },
            }));
            rt.state.dispatches = runsState({ rows: [runFixture()], status: 'ready', selectedRun: RUN_ID });

            await loadAuditHistory(rt);

            expect(rt.state.dispatches.audit.status).toBe('error');
            expect(rt.state.dispatches.audit.rows).toEqual([]);
            expect(rt.state.dispatches.audit.note).toContain('unreachable');
        }
    });

});

describe('selection, open, and the pane handler table', () => {
    it('selects a known row and ignores an unknown id', async () => {
        {
            const rt = createTestRuntime(fakeHost());
            rt.state.dispatches = runsState({ rows: [runFixture()], status: 'ready' });

            selectDispatch(rt, 'evt-from-the-future');
            expect(rt.state.dispatches.selectedRun).toBeNull();

            selectDispatch(rt, RUN_ID);
            expect(rt.state.dispatches.selectedRun).toBe(RUN_ID);
            expect(selectedRun(rt.state.dispatches)?.issueUrl).toBe(ISSUE_URL);
        }
    });

    it('opens the selected run’s issue through the documented host call', async () => {
        {
            const opened: string[] = [];
            const host = fakeHost({
                openUrl: async (url) => {
                    opened.push(url);
                },
            });
            const rt = createTestRuntime(host);
            rt.state.dispatches = runsState({ rows: [runFixture()], status: 'ready', selectedRun: RUN_ID });

            await openDispatch(rt);

            expect(opened).toEqual([ISSUE_URL]);
            expect(rt.state.dispatches.note).toBe('');
        }
    });

    it('lands an openUrl failure on the note instead of throwing', async () => {
        {
            const host = fakeHost({ openUrl: () => Promise.reject(new Error('HOST_REJECTED')) });
            const rt = createTestRuntime(host);
            rt.state.dispatches = runsState({ rows: [runFixture()], status: 'ready', selectedRun: RUN_ID });

            await openDispatch(rt);

            expect(rt.state.dispatches.note).toContain('HOST_REJECTED');
        }
    });

    it('wires Refresh dispatches through the pane handler table to a real read', async () => {
        {
            const service = serviceDouble({ [RUNS_GET]: { status: 200, body: runsBody([runFixture()]) } });
            const rt = createTestRuntime(fakeHost({ serviceRequest: service.serviceRequest }));
            const handlers = createBindingsHandlers(rt);

            handlers.refreshDispatches();
            await tick();

            expect(rt.state.dispatches.status).toBe('ready');
            expect(rt.state.dispatches.rows).toHaveLength(1);
        }
    });

});

/* -------------------------------------------------------------------- *
 * 005 AC-145 — the attributed actor, its basis, and the refused run
 * -------------------------------------------------------------------- */

/**
 * The claim 005 v1.13.0 withdraws, in every wording the old copy used
 * (002 NFR-011 as re-cut at v1.12.0).
 *
 * Both the panel's clause and the gate's refusal reason carried a version of
 * *"GitHub does not record who assigned"*, which is **false** — GitHub records
 * both, in `assigner` and `review_requester` on the item's own event list. The
 * scan exists so a future edit cannot quietly put the falsehood back, and it
 * matches on the substance (a claim about what the provider does not record)
 * rather than on one exact sentence, so a rewording does not slip past it.
 */
const WITHDRAWN_CLAIM =
    /does not record|never (?:who|records)|records no (?:assigner|requester|assign)|is a proxy|a proxy\b/i;

/** A login the legacy-basis fixtures attribute a row to, named once (sonarjs). */
const LEGACY_ACTOR_LOGIN = 'bob';

/**
 * The legacy attribution basis, readable and produced by nothing (002 FR-044 as
 * re-cut at v1.12.0) — named once so the fixtures below cannot drift apart from
 * the clause they are asserting the panel renders beside it.
 */
const LEGACY_BASIS = 'subject-author';


describe('005 AC-145 the row names the actor, its basis, and the denied login', () => {
    it('states each reference\'s own actor, and a legacy basis as its provenance', () => {
        // all** — GitHub named the identity that performed the act, so there is
        // nothing to qualify (005 FR-094 as re-cut at v1.13.0)
        {
            const rows = rowsForRun({
                sourceReferences: [referenceFixture({ actorLogin: ALLOWED_LOGIN, actorAttribution: 'direct' })],
                referenceCount: 1,
            });

            expect(rows[0]?.subtitle).toContain(`actor ${ALLOWED_LOGIN}`);
            expect(rows[0]?.subtitle).not.toContain(SUBJECT_AUTHOR_BASIS);
            // The whole point of the re-cut: not merely a different clause, but
            // **none** on the basis every row written now carries.
            expect(rows[0]?.subtitle).not.toContain('attributed');
            expect(rows[0]?.subtitle).not.toContain('basis');
        }

        // in force when it was written — and claims nothing about GitHub
        {
            const rows = rowsForRun({
                sourceReferences: [referenceFixture({
                    actorLogin: LEGACY_ACTOR_LOGIN,
                    actorAttribution: LEGACY_BASIS,
                })],
                referenceCount: 1,
            });
            const subtitle = rows[0]?.subtitle ?? '';

            expect(subtitle).toContain(`actor ${LEGACY_ACTOR_LOGIN}`);
            expect(subtitle).toContain(SUBJECT_AUTHOR_BASIS);
            expect(subtitle).toContain('under the rule in force when this row was written');
            // 002 NFR-011 in the negative, and the claim this amendment withdrew:
            // nothing says bob assigned the issue, and nothing says GitHub does
            // not record who assigned — because it does, in `assigner`.
            expect(subtitle).not.toContain(`${LEGACY_ACTOR_LOGIN} assigned`);
            expect(subtitle).not.toContain('does not record');
            expect(subtitle).not.toContain('is a proxy');
        }

        // outside rider is visible rather than silent (003 FR-011, FR-077)
        {
            const row = runFixture({
                sourceReferences: [
                    referenceFixture({ actorLogin: ALLOWED_LOGIN, actorAttribution: 'direct' }),
                    referenceFixture({
                        deliveryId: 'evt-acme~widget~7~comment',
                        kind: 'mention',
                        origin: 'comment:4242',
                        detectedAt: RIDER_DETECTED_AT,
                        presentAtAuthorization: false,
                        actorLogin: DENIED_LOGIN,
                        actorAttribution: LEGACY_BASIS,
                    }),
                ],
                referenceCount: 2,
            });
            const [rendered] = dispatchRows(runsState({ rows: [row], status: 'ready' }));
            const revealed = referenceDetailLines(row);

            // Both surfaces name both actors…
            for (const line of [String(rendered?.subtitle), revealed.join(' ')]) {
                expect(line).toContain(`actor ${ALLOWED_LOGIN}`);
                expect(line).toContain(`actor ${DENIED_LOGIN}`);
                expect(line).toContain(SUBJECT_AUTHOR_BASIS);
            }
            // …one per line, because each reference carries **its own** actor
            // and basis rather than inheriting the first reference's.
            expect(revealed[0]).toContain(`actor ${ALLOWED_LOGIN}`);
            expect(revealed[0]).not.toContain(`actor ${DENIED_LOGIN}`);
            expect(revealed[1]).toContain(`actor ${DENIED_LOGIN}`);
            expect(revealed[1]).toContain('arrived after authorization');
        }

        {
            const [rendered] = rowsForRun({ sourceReferences: [referenceFixture()], referenceCount: 1 });

            // Absence is named, never filled in: printing a plausible login
            // would record an inference as a fact (002 FR-024).
            expect(rendered?.subtitle).toContain('actor not recorded');
        }
    });

    it('names the denied login and 003\'s reason on the refused run, and offers Retry', () => {
        {
            const reason = "no source reference on this run names an actor the binding's allowedUsers permits: "
                + `${LEGACY_ACTOR_LOGIN} (the issue or pull-request author, attributed under the rule `
                + 'in force when this row was written)';
            const [row] = dispatchRows(runsState({
                rows: [runFixture({ state: BLOCKED_ACTOR_STATE, stateReason: reason })],
                status: 'ready',
            }));

            expect(row?.badge?.label).toBe(ACTOR_BLOCKED_LABEL);
            expect(row?.subtitle).toContain(LEGACY_ACTOR_LOGIN);
            expect(row?.subtitle).toContain('allowedUsers');
            // The panel renders the verdict it was given and never predicts one
            // (FR-046): the reason is the service's message, verbatim.
            expect(row?.subtitle).toContain(reason);
        }

        // service answers (005 AC-145, 003 FR-041)
        {
            const row = runFixture({ state: BLOCKED_ACTOR_STATE, stateReason: 'bob is not on the allow-list' });
            const before = dispatchRows(runsState({ rows: [row], status: 'ready' }));
            const affordance = runAffordance(row);

            expect(affordance.action).toBe('retry');
            expect(affordance.label).toBe('Retry dispatch');
            // Rendering is not deciding: a second render of an unchanged row is
            // byte-identical, which is what "no local verdict" looks like.
            expect(dispatchRows(runsState({ rows: [row], status: 'ready' }))).toEqual(before);
        }

        // proved non-vacuous by a fixture that still renders the legacy basis
        // (005 AC-145 as re-cut at v1.13.0)
        {
            // The scan needs to *find* the withdrawn claim, so it is first shown
            // to bite: the scanner matches the sentence the pre-v1.13.0 clause
            // carried, and that sentence is not what this build renders.
            expect(WITHDRAWN_CLAIM.test('it does not record who assigned it or requested the review')).toBe(true);
            expect(WITHDRAWN_CLAIM.test(SUBJECT_AUTHOR_BASIS)).toBe(false);

            // Every user-facing string composed from a run's actor rows, on both
            // the row and in the reveal — the two surfaces that name an actor.
            const row = runFixture({
                sourceReferences: [
                    referenceFixture({ actorLogin: 'dana', actorAttribution: 'direct' }),
                    referenceFixture({
                        deliveryId: 'evt-acme~widget~7~legacy',
                        kind: 'assignment',
                        origin: 'assignment',
                        detectedAt: RIDER_DETECTED_AT,
                        presentAtAuthorization: false,
                        actorLogin: LEGACY_ACTOR_LOGIN,
                        actorAttribution: LEGACY_BASIS,
                    }),
                ],
                referenceCount: 2,
            });
            const subtitles = dispatchRows(runsState({ rows: [row], status: 'ready' }))
                .map((rendered) => String(rendered.subtitle));
            const composed = [...subtitles, ...referenceDetailLines(row)].join('\n');

            // Non-vacuity: the legacy fixture still renders its clause, so the
            // scan is looking at live output rather than passing because the
            // branch is gone.
            expect(composed).toContain(SUBJECT_AUTHOR_BASIS);
            expect(WITHDRAWN_CLAIM.test(composed), composed).toBe(false);
        }
    });
});
