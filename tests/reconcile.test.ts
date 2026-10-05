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
import type { GuestRequest, GuestRequestResult, JsonValue } from '@openchamber/sdk';
import { RECONCILE_BUDGET_MS, reconcileDispatchAttempts } from '../src/reconcile.ts';
import { DISPATCH_STORAGE_KEY, recordDispatchOutcome } from '../src/dispatch-record.ts';
import { dispatchedPath } from '../src/service-calls.ts';
import { settleReconciliation, startRelayPolling, stopRelayPolling } from '../src/relay.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import {
    DEFAULT_STATUS,
    FIXTURE_TIMESTAMP,
    LOGIN,
    PROJECT_ID,
    createStorageDouble,
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
            triggers: { assignment: true, mention: false, reviewRequest: false },
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
 *
 * @param input - The run, its attempt, and the outcome.
 */
async function record(rt: PanelRuntime, input: {
    /** Run the attempt belongs to. */
    readonly correlationId: string;
    /** FR-010's run tuple. */
    readonly runKey: string;
    /** Attempt number. */
    readonly attempt: number;
    /** What the host call produced. */
    readonly outcome: { readonly kind: 'dispatched'; readonly sessionId: string };
}): Promise<void> {
    const isWritten = await recordDispatchOutcome(rt, { dispatchToken: TOKEN, ...input });
    expect(isWritten).toBe(true);
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
