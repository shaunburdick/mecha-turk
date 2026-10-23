/**
 * Reconciliation tests (003 T-022: FR-025, AC-111;
 * `contracts/reconciliation.md` §2–§4).
 *
 * Reconciliation is the half of the contract that makes a lost result report
 * survivable, so these tests hold four promises:
 *
 * 1. **Nothing claims before it settles** — the relay's own arm defers while
 *    the pass runs, so the ordering is a property of the arm, not of which
 *    call site got there first.
 * 2. **A repeat changes nothing** — byte-identical bodies, no host call, and
 *    the record left standing so the next mount asks again (the service
 *    answers that with `dispatch.duplicate-report`).
 * 3. **Nothing is ever silent** — a refusal, a stopped budget, or an
 *    unreadable record each becomes a visible warning that names the run.
 * 4. **A wiped record reports nothing and starts nothing** (FR-025's wipe
 *    permutation: no invented outcome, no dispatch).
 *
 * Offline only: a fake host, a storage double, and a route table. The budget is
 * moved with an injected clock rather than slept through.
 */

import { describe, expect, it } from 'vitest';
import type { GuestRequest, GuestRequestResult, HostReadyContext, JsonValue } from '@openchamber/sdk';
import { begin, teardown } from '../src/app.ts';
import { RECONCILE_BUDGET_MS, reconcileDispatchAttempts } from '../src/reconcile.ts';
import {
    DISPATCH_SCHEMA_VERSION,
    DISPATCH_STORAGE_KEY,
    loadDispatchRecord,
    recordDispatchIntent,
    recordDispatchOutcome,
} from '../src/dispatch-record.ts';
import type { DispatchAttemptRecord } from '../src/dispatch-record.ts';
import { auditPath, dispatchedPath } from '../src/service-calls.ts';
import { settleReconciliation, startRelayPolling, stopRelayPolling } from '../src/relay.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import {
    DEFAULT_STATUS,
    FIXTURE_TIMESTAMP,
    LOGIN,
    PROJECT_ID,
    createStorageDouble,
    createPushHarness,
    createTestRuntime,
    fakeHost,
} from './support/panel.ts';

/** First fixture run. */
const RUN_A = 'mt-run-aaaaaaaaaaaaaaaaaaaaaaaa';

/** Second fixture run, so one budget can stop on a run the pass never reached. */
const RUN_B = 'mt-run-bbbbbbbbbbbbbbbbbbbbbbbb';

/** Run key matching {@link RUN_A}. */
const RUN_KEY_A = 'github|77331|acme/widget|issue|7|0';

/** Run key matching {@link RUN_B}. */
const RUN_KEY_B = 'github|77331|acme/widget|issue|7|1';

/** Single-use token the fixture records carry. */
const TOKEN = `dtk-${'a1b2c3d4'.repeat(4)}`;

/** The reservation the fixture attempt belongs to. */
const LEASE_A = 'lse-aaaaaaaaaaaaaaaaaaaaaaaa';

/** A later reservation cycle reusing the same attempt number. */
const LEASE_B = 'lse-bbbbbbbbbbbbbbbbbbbbbbbb';

/** Session id the fixture's dispatched outcome reports. */
const SESSION_ID = 'ses_1';

/** `GET /v1/events/pending`, the claim the relay ticks on. */
const PENDING_GET = 'GET /v1/events/pending';

/** One answer in the service-double route table. */
interface RouteAnswer {
    /** HTTP status the service answers with. */
    readonly status: number;
    /** Response body text. */
    readonly body: string;
}

/** Route table keyed by `METHOD path`. */
type RouteTable = Readonly<Record<string, RouteAnswer>>;

/** The paths reconciliation itself posts to, plus the claim the loop ticks on. */
function okRoutes(): RouteTable {
    return {
        [`POST ${dispatchedPath(RUN_A)}`]: { status: 200, body: '{"state":"dispatched"}' },
        [`POST ${dispatchedPath(RUN_B)}`]: { status: 200, body: '{"state":"dispatched"}' },
        [PENDING_GET]: { status: 200, body: '{"events":[],"status":[],"auditWritten":true}' },
    };
}

/** What one reconciliation double recorded. */
interface Harness {
    /** Runtime under test. */
    readonly rt: PanelRuntime;
    /** Every request the panel made, in order. */
    readonly timeline: readonly string[];
    /** Body of every POST the panel sent, in order. */
    readonly postBodies: readonly string[];
    /** Replace the route table, modelling the service's answer changing. */
    setRoutes: (table: RouteTable) => void;
}

/**
 * Whether a value written to the dispatch record already carries an
 * acknowledgement.
 *
 * @param value - Value the panel stored.
 * @returns `true` once any stored attempt is acknowledged.
 */
function isAcknowledged(value: JsonValue): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const { attempts } = value;
    if (!Array.isArray(attempts)) {
        return false;
    }

    return attempts.some((entry) =>
        typeof entry === 'object' && entry !== null && !Array.isArray(entry) && entry.acknowledged === true);
}

/**
 * Build a recorded double for one mounted panel.
 *
 * @param options - `failAcknowledge` makes the acknowledgement write throw, so
 *   a landed report still leaves the record unacknowledged (the case that
 *   proves a repeat is byte-identical rather than a fresh report).
 * @returns The runtime, the timeline, and the route-swap control.
 */
function harness(routes: RouteTable = okRoutes(), options: { readonly failAcknowledge?: boolean } = {}): Harness {
    const timeline: string[] = [];
    const postBodies: string[] = [];
    let table = routes;
    const storage = createStorageDouble();

    const host = fakeHost({
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            const key = `${request.method} ${request.path}`;
            timeline.push(key);
            if (request.method === 'POST') {
                postBodies.push(request.body ?? '');
            }

            return table[key] ?? { status: DEFAULT_STATUS, body: '{"error":{"code":"not-found"}}' };
        },
        storage: {
            ...storage.storage,
            set: async (key, value) => {
                if (key === DISPATCH_STORAGE_KEY && options.failAcknowledge === true && isAcknowledged(value)) {
                    timeline.push('ack-refused');

                    throw new Error('HOST_STORAGE_WRITE_FAILED');
                }

                await storage.storage.set(key, value);
            },
        },
    });
    const rt = createTestRuntime(host);
    rt.state.bindings.bindings = [
        {
            bindingId: 'bnd-recon-1',
            accountNumericUserId: '77331',
            accountLogin: LOGIN,
            repository: 'acme/widget',
            projectId: PROJECT_ID,
            worktreeOption: 'generated',
            triggers: { assignment: true, mention: false, reviewRequest: false, reviewSubmitted: false, checks: false },
            state: 'active',
            createdAt: FIXTURE_TIMESTAMP,
            updatedAt: FIXTURE_TIMESTAMP,
        },
    ];

    return {
        rt,
        timeline,
        postBodies,
        setRoutes: (next) => {
            table = next;
        },
    };
}

/**
 * Record one dispatch outcome the way the relay does, durably, unacknowledged.
 */
async function record(rt: PanelRuntime, input: {
    /** Run the attempt belongs to. */
    readonly correlationId: string;
    /** FR-010's run tuple. */
    readonly runKey: string;
    readonly attempt: number;
    /** What the host call produced. */
    readonly outcome: { readonly kind: 'dispatched'; readonly sessionId: string };
}): Promise<void> {
    const isWritten = await recordDispatchOutcome(rt, {
        leaseId: LEASE_A,
        dispatchToken: TOKEN,
        ...input,
    });
    expect(isWritten).toBe(true);
}

/** Record one authorization whose outcome never landed, the way a teardown leaves it. */
async function recordUnknown(rt: PanelRuntime, input: {
    readonly correlationId: string;
    readonly runKey: string;
    readonly attempt?: number;
    readonly leaseId?: string;
    readonly projectId?: string;
    readonly worktreeOption?: string;
}): Promise<void> {
    const isWritten = await recordDispatchIntent(rt, {
        correlationId: input.correlationId,
        runKey: input.runKey,
        attempt: input.attempt ?? 1,
        leaseId: input.leaseId ?? LEASE_A,
        dispatchToken: TOKEN,
        projectId: input.projectId ?? PROJECT_ID,
        worktreeOption: input.worktreeOption ?? 'generated',
    });
    expect(isWritten).toBe(true);
}

/** The stored attempts, read back through the panel's own reader. */
async function storedAttempts(rt: PanelRuntime): Promise<readonly DispatchAttemptRecord[]> {
    const read = await loadDispatchRecord(rt);

    expect(read.ok).toBe(true);

    return read.ok ? read.document.attempts : [];
}

/** One attempt's settlement stamp, or `undefined` when the panel holds no such row. */
async function settledAtOf(rt: PanelRuntime, correlationId: string): Promise<string | null | undefined> {
    const attempts = await storedAttempts(rt);
    const row = attempts.find((entry) => entry.correlationId === correlationId);

    return row?.settledAt;
}

/** One correlation-filtered audit row, shaped as the route answers it. */
function auditRow(input: {
    readonly correlationId: string;
    readonly seq: number;
    readonly eventType: string;
    readonly details?: Readonly<Record<string, JsonValue>>;
}): Record<string, JsonValue> {
    return {
        seq: input.seq,
        timestamp: FIXTURE_TIMESTAMP,
        correlationId: input.correlationId,
        eventType: input.eventType,
        actorSource: 'panel',
        decision: null,
        reason: null,
        details: input.details ?? {},
    };
}

/** One correlation-filtered audit page body. */
function auditBody(
    entries: readonly Record<string, JsonValue>[],
    nextCursor: number | null = null,
): string {
    return JSON.stringify({ entries, nextCursor, count: entries.length });
}

/** The route key the settle read asks for, cursor included (T-048's query-string fixture). */
function auditKey(correlationId: string, cursor: number | null = null): string {
    return `GET ${auditPath(correlationId, { limit: 200, cursor })}`;
}

describe('reconcile mount order (FR-025, AC-111)', () => {
    it('settles every outstanding attempt before the relay may claim', async () => {
        const relay = harness();
        await record(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, attempt: 1, outcome: {
            kind: 'dispatched',
            sessionId: SESSION_ID,
        } });

        // Any arming site may ask while reconciliation is running; each one
        // only records its intent until the gate opens.
        relay.rt.reconcileSettled = false;
        startRelayPolling(relay.rt);
        expect(relay.rt.relayArmPending).toBe(true);
        expect(relay.rt.relayArmed).toBe(false);
        expect(relay.timeline).toEqual([]);

        try {
            const outcome = await reconcileDispatchAttempts(relay.rt);
            expect(outcome.attempted).toBe(1);
            expect(outcome.acknowledged).toBe(1);
            expect(outcome.warning).toBeNull();
            expect(relay.timeline).toEqual([`POST ${dispatchedPath(RUN_A)}`]);

            settleReconciliation(relay.rt);

            expect(relay.rt.relayArmed).toBe(true);
            expect(relay.timeline).toEqual([`POST ${dispatchedPath(RUN_A)}`, PENDING_GET]);
        } finally {
            stopRelayPolling(relay.rt);
        }
    });
});

describe('reconciliation is idempotent (FR-025)', () => {
    it('re-reports byte-identically and starts nothing when the acknowledgement will not stick', async () => {
        const relay = harness(okRoutes(), { failAcknowledge: true });
        await record(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, attempt: 1, outcome: {
            kind: 'dispatched',
            sessionId: SESSION_ID,
        } });

        const first = await reconcileDispatchAttempts(relay.rt);
        const second = await reconcileDispatchAttempts(relay.rt);

        expect(first.attempted).toBe(1);
        expect(first.acknowledged).toBe(0);
        expect(relay.postBodies).toHaveLength(2);
        expect(relay.postBodies[0]).toBe(relay.postBodies[1]);
        expect(second.attempted).toBe(1);
        expect(second.outstanding).toEqual([RUN_A]);
        // Reconciliation reports; it never dispatches.
        expect(relay.timeline.filter((entry) => entry.startsWith('startSession'))).toHaveLength(0);
        expect(JSON.parse(relay.postBodies[0] ?? '{}')).toMatchObject({
            correlationId: RUN_A,
            attempt: 1,
            dispatchToken: TOKEN,
            sessionId: SESSION_ID,
        });
    });
});

describe('reconciliation is never silent (FR-025)', () => {
    it('warns with the run named when the service refuses throughout, and still polls', async () => {
        {
            const relay = harness({
                ...okRoutes(),
                [`POST ${dispatchedPath(RUN_A)}`]: {
                    status: 503,
                    body: JSON.stringify({ error: { code: 'storage-unavailable', message: 'store starting' } }),
                },
            });
            await record(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, attempt: 1, outcome: {
                kind: 'dispatched',
                sessionId: SESSION_ID,
            } });

            const outcome = await reconcileDispatchAttempts(relay.rt);

            expect(outcome.warning).not.toBeNull();
            expect(relay.rt.state.status.tone).toBe('warning');
            expect(relay.rt.state.status.body).toContain(RUN_A);

            // Reconciliation failure must not wedge the panel: it still claims.
            startRelayPolling(relay.rt);
            try {
                await Promise.resolve();
                expect(relay.timeline).toContain(PENDING_GET);
            } finally {
                stopRelayPolling(relay.rt);
            }
        }
    });

    it('puts the service\'s own refusal copy on the panel note (contract §2)', async () => {
        {
            const relay = harness({
                ...okRoutes(),
                [`POST ${dispatchedPath(RUN_A)}`]: {
                    status: 409,
                    body: JSON.stringify({ error: { code: 'invalid-transition', message: 'already dispatched' } }),
                },
            });
            await record(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, attempt: 1, outcome: {
                kind: 'dispatched',
                sessionId: SESSION_ID,
            } });

            const outcome = await reconcileDispatchAttempts(relay.rt);

            expect(outcome.outstanding).toEqual([RUN_A]);
            expect(relay.rt.state.bindings.note).toContain(RUN_A);
            expect(relay.rt.state.status.body).toContain(RUN_A);
        }
    });

    it('stops at the budget and names the run it never reached', async () => {
        {
            const relay = harness();
            await record(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, attempt: 1, outcome: {
                kind: 'dispatched',
                sessionId: SESSION_ID,
            } });
            await record(relay.rt, { correlationId: RUN_B, runKey: RUN_KEY_B, attempt: 1, outcome: {
                kind: 'dispatched',
                sessionId: SESSION_ID,
            } });

            let ticks = 0;
            const clock = (): number => {
                ticks += 1;

                // Call 1 arms the pass, call 2 admits the first run, call 3 is past
                // the budget — so the pass reports exactly one of the two.
                return ticks <= 2 ? 0 : RECONCILE_BUDGET_MS + 1_000;
            };
            const outcome = await reconcileDispatchAttempts(relay.rt, { now: clock });

            expect(outcome.attempted).toBe(1);
            expect(outcome.acknowledged).toBe(1);
            expect(outcome.outstanding).toEqual([RUN_B]);
            expect(relay.rt.state.status.body).toContain(RUN_B);
            expect(relay.rt.state.status.body).not.toContain(RUN_A);
        }
    });

    it('warns when the record itself is unreadable, and reports nothing', async () => {
        {
            const relay = harness();
            await relay.rt.host.storage.set(DISPATCH_STORAGE_KEY, {
                schemaVersion: 'dispatch-attempts-99',
                attempts: [],
            });

            const outcome = await reconcileDispatchAttempts(relay.rt);

            expect(outcome.attempted).toBe(0);
            expect(relay.timeline).toEqual([]);
            expect(relay.rt.state.status.tone).toBe('warning');
        }
    });

});

describe('reconciliation of nothing (FR-025 wipe permutation)', () => {
    it('reports nothing, starts nothing, and warns about nothing on a wiped key', async () => {
        const relay = harness();

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome).toEqual({ attempted: 0, acknowledged: 0, outstanding: [], warning: null });
        expect(relay.timeline).toEqual([]);
        expect(relay.timeline.filter((entry) => entry.startsWith('startSession'))).toHaveLength(0);
    });
});

describe('unknown records are surfaced, never reported (FR-025, AC-135)', () => {
    it('posts nothing for an unknown record while a resolved attempt in the same pass is re-reported', async () => {
        const relay = harness();
        await record(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, attempt: 1, outcome: {
            kind: 'dispatched',
            sessionId: SESSION_ID,
        } });
        await recordUnknown(relay.rt, { correlationId: RUN_B, runKey: RUN_KEY_B });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        // RUN_B's audit read has no route, so it fails; the re-report of RUN_A
        // must still have happened, and RUN_B must not have been reported.
        expect(outcome.attempted).toBe(1);
        expect(outcome.acknowledged).toBe(1);
        expect(relay.postBodies).toHaveLength(1);
        expect(JSON.parse(relay.postBodies[0] ?? '{}')).toMatchObject({ correlationId: RUN_A });
        expect(relay.timeline).toContain(`POST ${dispatchedPath(RUN_A)}`);
        expect(relay.timeline).not.toContain(`POST ${dispatchedPath(RUN_B)}`);
        expect(outcome.outstanding).toEqual([RUN_B]);
        expect(relay.rt.state.status.body).toContain(RUN_B);
        expect(relay.rt.state.status.body).toContain('could not check');
        expect(await settledAtOf(relay.rt, RUN_B)).toBeNull();
    });

    it('warns with the run first, the record\'s target, the derived attachment id, and both resolutions', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: { status: 200, body: auditBody([]) },
        });
        await recordUnknown(relay.rt, {
            correlationId: RUN_A,
            runKey: RUN_KEY_A,
            projectId: PROJECT_ID,
            worktreeOption: 'new:mt-7',
        });

        const outcome = await reconcileDispatchAttempts(relay.rt);
        const { body } = relay.rt.state.status;

        expect(outcome.warning).toBe(body);
        expect(relay.rt.state.status.tone).toBe('warning');
        expect(relay.postBodies).toHaveLength(0);
        expect(body.indexOf(RUN_A)).toBeLessThan(body.indexOf(`project ${PROJECT_ID}`));
        expect(body).toContain('never recorded as producing a session');
        expect(body).toContain(`project ${PROJECT_ID}`);
        expect(body).toContain('worktree option new:mt-7');
        expect(body).toContain(`attachment ${RUN_A}`);
        expect(body).toContain('session created');
        expect(body).toContain('no session created');
        expect(body).toContain('once the run reads unconfirmed');
        expect(body).toContain('is not in the list this panel loaded');
        expect(body).toContain('Dispatches');
    });

    it('says the panel could not check when the audit read fails', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: { status: 503, body: JSON.stringify({ error: { code: 'storage-unavailable' } }) },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).not.toBeNull();
        expect(relay.rt.state.status.body).toContain('could not check');
        expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
    });

    it('does not settle when the budget stops the pass before the check, and says so', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: { status: 200, body: auditBody([]) },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        let ticks = 0;
        const clock = (): number => {
            ticks += 1;

            return ticks <= 1 ? 0 : RECONCILE_BUDGET_MS + 1_000;
        };
        const outcome = await reconcileDispatchAttempts(relay.rt, { now: clock });

        expect(outcome.warning).not.toBeNull();
        expect(relay.rt.state.status.body).toContain('could not check');
        expect(relay.timeline.filter((entry) => entry.startsWith('GET /v1/audit'))).toHaveLength(0);
        expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
    });
});

describe('settling an unknown record on the service\'s evidence (FR-045, AC-135)', () => {
    it('settles on dispatch.result naming the attempt and never surfaces the record again', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.result',
                        details: { attempt: 1, sessionId: SESSION_ID },
                    }),
                ]),
            },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).toBeNull();
        expect(outcome.outstanding).toEqual([]);
        const settled = await storedAttempts(relay.rt);
        expect(settled[0]).toMatchObject({ outcome: 'unknown' });
        expect(settled[0]?.settledAt).not.toBeNull();
        expect(relay.postBodies).toHaveLength(0);

        // The trail is trimmed and the panel remounts: a settled record is not
        // consulted again, so nothing can resurrect the warning.
        relay.setRoutes(okRoutes());
        const second = await reconcileDispatchAttempts(relay.rt);

        expect(second.warning).toBeNull();
        expect(relay.timeline.filter((entry) => entry.startsWith('GET /v1/audit'))).toHaveLength(1);
    });

    it('settles on dispatch.abandoned naming the attempt', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.abandoned',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                ]),
            },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).toBeNull();
        expect(await settledAtOf(relay.rt, RUN_A)).not.toBeNull();
    });

    it('settles on a dispatch.resolved sequenced after the reserved row naming the attempt', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.resolved',
                        details: { priorState: 'unconfirmed' },
                    }),
                ]),
            },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).toBeNull();
        expect(await settledAtOf(relay.rt, RUN_A)).not.toBeNull();
    });

    it('does not settle on a dispatch.resolved it cannot order against a reserved row in the same read', async () => {
        {
            const relay = harness({
                ...okRoutes(),
                [auditKey(RUN_A)]: {
                    status: 200,
                    body: auditBody([
                        auditRow({ correlationId: RUN_A, seq: 2, eventType: 'dispatch.resolved', details: {} }),
                    ]),
                },
            });
            await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

            const outcome = await reconcileDispatchAttempts(relay.rt);

            expect(outcome.warning).not.toBeNull();
            expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
        }
        {
            const relay = harness({
                ...okRoutes(),
                [auditKey(RUN_A)]: {
                    status: 200,
                    body: auditBody([
                        auditRow({
                            correlationId: RUN_A,
                            seq: 1,
                            eventType: 'dispatch.resolved',
                            details: {},
                        }),
                        auditRow({
                            correlationId: RUN_A,
                            seq: 2,
                            eventType: 'dispatch.reserved',
                            details: { attempt: 1, leaseId: LEASE_A },
                        }),
                    ]),
                },
            });
            await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

            const outcome = await reconcileDispatchAttempts(relay.rt);

            expect(outcome.warning).not.toBeNull();
            expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
        }
    });

    it('does not treat dispatch.unconfirmed as evidence, and says the decision is still owed', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.unconfirmed',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                ]),
            },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).not.toBeNull();
        expect(relay.rt.state.status.body).toContain('still needs your decision');
        expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
    });

    it('does not treat a missing or non-numeric attempt reference as evidence', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.result',
                        details: {},
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.abandoned',
                        details: { attempt: '1' },
                    }),
                ]),
            },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).not.toBeNull();
        expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
    });

    it('pages past the audit view\'s 100-row display cap until the settling row', async () => {
        const filler = Array.from({ length: 204 }, (_unused, index) =>
            auditRow({ correlationId: RUN_A, seq: index + 1, eventType: 'dispatch.claimed' }));
        const rows = [
            ...filler,
            auditRow({
                correlationId: RUN_A,
                seq: 205,
                eventType: 'dispatch.reserved',
                details: { attempt: 1, leaseId: LEASE_A },
            }),
            auditRow({
                correlationId: RUN_A,
                seq: 206,
                eventType: 'dispatch.result',
                details: { attempt: 1, sessionId: SESSION_ID },
            }),
        ];
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: { status: 200, body: auditBody(rows.slice(0, 200), 200) },
            [auditKey(RUN_A, 200)]: { status: 200, body: auditBody(rows.slice(200)) },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).toBeNull();
        expect(await settledAtOf(relay.rt, RUN_A)).not.toBeNull();
        expect(relay.timeline.filter((entry) => entry.startsWith('GET /v1/audit'))).toHaveLength(2);
    });
});

describe('the reservation is the settle anchor (FR-045, AC-135)', () => {
    it('ignores a prior cycle\'s result at the same attempt, before the lease-matched reservation', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.result',
                        details: { attempt: 1, sessionId: SESSION_ID },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 3,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_B },
                    }),
                ]),
            },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, leaseId: LEASE_B });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).not.toBeNull();
        expect(outcome.outstanding).toEqual([RUN_A]);
        expect(relay.rt.state.status.body).toContain('no outcome recorded yet');
        expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
    });

    it('does not anchor on a reservation carrying a different lease', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.result',
                        details: { attempt: 1, sessionId: SESSION_ID },
                    }),
                ]),
            },
        });
        await recordUnknown(relay.rt, { correlationId: RUN_A, runKey: RUN_KEY_A, leaseId: LEASE_B });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).not.toBeNull();
        expect(relay.rt.state.status.body).toContain('could not check');
        expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
    });

    it('surfaces a null-lease unknown record and never settles it', async () => {
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: {
                status: 200,
                body: auditBody([
                    auditRow({
                        correlationId: RUN_A,
                        seq: 1,
                        eventType: 'dispatch.reserved',
                        details: { attempt: 1, leaseId: LEASE_A },
                    }),
                    auditRow({
                        correlationId: RUN_A,
                        seq: 2,
                        eventType: 'dispatch.result',
                        details: { attempt: 1, sessionId: SESSION_ID },
                    }),
                ]),
            },
        });
        await relay.rt.host.storage.set(DISPATCH_STORAGE_KEY, {
            schemaVersion: DISPATCH_SCHEMA_VERSION,
            attempts: [{
                correlationId: RUN_A,
                runKey: RUN_KEY_A,
                attempt: 1,
                dispatchToken: TOKEN,
                projectId: PROJECT_ID,
                worktreeOption: 'generated',
                outcome: 'unknown',
                sessionId: null,
                reason: null,
                authorizedAt: FIXTURE_TIMESTAMP,
                recordedAt: FIXTURE_TIMESTAMP,
                settledAt: null,
                acknowledged: false,
            }],
        });

        const outcome = await reconcileDispatchAttempts(relay.rt);

        expect(outcome.warning).not.toBeNull();
        expect(relay.rt.state.status.body).toContain('could not check');
        expect(await settledAtOf(relay.rt, RUN_A)).toBeNull();
    });
});

describe('the banner cannot lose a run (FR-025, AC-135)', () => {
    it('shows two unsettled runs and both verdicts, bounding each detail line visibly', async () => {
        const longProject = `prj_${'a'.repeat(700)}`;
        const relay = harness({
            ...okRoutes(),
            [auditKey(RUN_A)]: { status: 200, body: auditBody([]) },
            [auditKey(RUN_B)]: { status: 200, body: auditBody([]) },
        });
        await recordUnknown(relay.rt, {
            correlationId: RUN_A,
            runKey: RUN_KEY_A,
            leaseId: LEASE_A,
            projectId: longProject,
        });
        await recordUnknown(relay.rt, {
            correlationId: RUN_B,
            runKey: RUN_KEY_B,
            leaseId: LEASE_B,
            projectId: longProject,
        });

        const outcome = await reconcileDispatchAttempts(relay.rt);
        const { body } = relay.rt.state.status;

        expect(outcome.outstanding).toEqual([RUN_A, RUN_B]);
        expect(body).toContain(`${RUN_A} (could not check)`);
        expect(body).toContain(`${RUN_B} (could not check)`);
        expect(body.length).toBeGreaterThan(600);
        expect(body).toContain(`… See ${RUN_A}'s row in Dispatches for the full detail.`);
        expect(body).toContain(`… See ${RUN_B}'s row in Dispatches for the full detail.`);
    });
});

describe('mount order (FR-025, AC-135)', () => {
    it('awaits the Dispatches list before reconciling', async () => {
        const timeline: string[] = [];
        const storage = createStorageDouble();
        const eventsPage = JSON.stringify({
            events: [],
            page: {
                limit: 25,
                nextCursor: null,
                hasMore: false,
                total: 0,
                snapshotAt: FIXTURE_TIMESTAMP,
                filter: { bindingId: null, state: null },
            },
        });
        const push = createPushHarness({
            serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
                timeline.push(`${request.method} ${request.path}`);
                if (request.path.startsWith('/v1/events?')) {
                    return { status: 200, body: eventsPage };
                }

                if (request.path.startsWith('/v1/audit?')) {
                    return { status: 200, body: auditBody([]) };
                }

                return { status: 404, body: '{"error":{"code":"not-found","message":"unrouted"}}' };
            },
            storage: storage.storage,
        });
        const rt = createTestRuntime(push.host);
        rt.started = true;
        const capture: { ready: HostReadyContext | null } = { ready: null };
        push.host.onReady((context): void => {
            capture.ready = context;
        });
        push.emitReady(null);
        if (capture.ready === null) {
            throw new Error('the harness never fired ready');
        }

        await recordUnknown(rt, { correlationId: RUN_A, runKey: RUN_KEY_A });
        try {
            await begin(rt, capture.ready);
        } finally {
            teardown(rt);
        }

        const listAt = timeline.findIndex((entry) => entry.startsWith('GET /v1/events?'));
        const auditAt = timeline.findIndex((entry) => entry.startsWith('GET /v1/audit?'));

        expect(listAt).toBeGreaterThanOrEqual(0);
        expect(auditAt).toBeGreaterThan(listAt);
    });
});
