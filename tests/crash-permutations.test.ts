/**
 * The enumerated crash-permutation set (003 T-031: NFR-102, AC-110, SC-102,
 * AC-101, SC-101).
 *
 * NFR-102 makes the permutation set an **automated test, not a manual check**,
 * and AC-110 states the metric: across close-before-claim, close-after-claim,
 * close-after-authorization, lost result, duplicated result, stale result, slow
 * panel, service restart, panel storage wipe, and operator retry, the sessions
 * created for one run identifier are **never greater than one** — except where
 * the operator explicitly chose *created no session*.
 *
 * Every permutation runs the real pair: the panel runtime in
 * [`dispatch-loop.ts`](./support/dispatch-loop.ts) forwards to the loopback
 * service, and `loop.sessions` records each `host.startSession()` call keyed by
 * the run's attachment id (FR-029), which is the count AC-110 measures. Sweeps
 * are driven by `sweepOnce` with stamps injected from the store's own expiries —
 * no test waits on a clock (NFR-112), and none reaches the network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainVerifications } from '../src/agent-verify.ts';
import { parsePendingBody } from '../src/claim-service.ts';
import { reconcileDispatchAttempts } from '../src/reconcile.ts';
import { dispatchClaimedRun, pollRelay } from '../src/relay.ts';
import { reservePath, servicePost } from '../src/service-calls.ts';
import { ABANDON_PATH, DISPATCHED_PATH, RESERVE_PATH } from '../service/routes/dispatch.ts';
import { REQUEUE_PATH, RESOLVE_PATH, RETRY_PATH } from '../service/routes/run-ops.ts';
import { DISPATCH_STORAGE_KEY } from '../src/dispatch-record.ts';
import type { ClaimedRun } from '../src/claim-service.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { Run } from '../service/poll/runs-types.ts';
import { NO_SESSION, SESSION_ID } from './support/panel.ts';
import { justPast, offerFor, sessionsPerRun, startDispatchLoop } from './support/dispatch-loop.ts';
import {
    bound,
    claim,
    codeOf,
    expectStatus,
    post,
    readRuns,
    readTrail,
} from './support/dispatch-corpus.ts';
import type { DispatchLoop } from './support/dispatch-loop.ts';

/** Issue every "one ordinary dispatch" permutation starts from. */
const ISSUE = 41;

/** Detection stamp a later scan carries, for the join permutation. */
const LATER_STAMP = '2026-09-20T01:00:00.000Z';

/** Trials the dual-trigger success criterion counts (SC-101). */
const TRIALS = 100;

/**
 * Time budget for the 100-trial proof, sized to its measured workload rather
 * than vitest's 5-second default.
 *
 * The body does the real thing end to end — the 150 fixture issues arrive as
 * **two scan-sized enqueues** (the batched form production uses, since the
 * 2026-10-01 de-slop pass stopped driving them one subject at a time) plus two
 * relay ticks that dispatch all 100 runs sequentially over loopback HTTP
 * (~502 requests, five per run). An idle machine measures ≈1.3 s since that
 * batching; before it, the same proof measured ≈1.7 s and still crossed 5 s on
 * a loaded CI runner (run 36836694111, while a sibling run of the same commit
 * passed), so the budget keeps an order-of-magnitude margin for a shared
 * machine without weakening what the test counts: still 100 trials, still
 * exactly one run and one session each.
 */
const TRIALS_BUDGET_MS = 30_000;

/** Trials of those whose second trigger arrives in a later scan. */
const LATER_SCAN_TRIALS = 50;

/** First issue number the dual-trigger trials use. */
const FIRST_TRIAL_ISSUE = 1_000;

/** Stamp comfortably past every configured window, for "nothing is waiting". */
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

/** Failure a fixture raises when the claim offered nothing to act on. */
const NO_OFFER = 'the claim offered nothing';

/** Failure a fixture raises when a reservation carried no result deadline. */
const NO_DEADLINE = 'the reservation carried no deadline';

/** Audit event type a lease expiry with no reservation writes (FR-032). */
const LEASE_EXPIRED_EVENT = 'dispatch.lease-expired';

/** The running loop every case drives. */
let loop: DispatchLoop;

beforeEach(async () => {
    loop = await startDispatchLoop();
});

afterEach(async () => {
    await loop.shutdown();
});

/**
 * Read one stored run by its subject number.
 *
 * @param issueNumber - Issue the run is about.
 * @returns The run as the service holds it.
 * @throws {Error} When no run exists for that subject.
 */
async function runOf(issueNumber: number): Promise<Run> {
    const runs = await readRuns(loop.store);
    const run = runs.find((candidate) => candidate.subjectNumber === issueNumber);
    if (run === undefined) {
        throw new Error(`no run is stored for issue ${issueNumber}`);
    }

    return run;
}

/**
 * The stored state of one subject's run, read through {@link runOf}.
 *
 * @param issueNumber - Issue the run is about.
 * @returns The run's current state.
 */
async function stateOf(issueNumber: number): Promise<string> {
    const run = await runOf(issueNumber);

    return run.state;
}

/**
 * Reserve through one mount's bridge, then let that mount die.
 *
 * @param rt - The mount that reports intent to start a session.
 * @param run - The run it claimed.
 * @returns The single-use dispatch token the service answered with.
 * @throws {Error} When the reservation was refused or unreadable.
 */
async function reserveThenDie(rt: PanelRuntime, run: ClaimedRun): Promise<string> {
    const answer = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: reservePath(run.correlationId),
        body: JSON.stringify({
            correlationId: run.correlationId,
            leaseId: run.lease.leaseId,
            attempt: run.attempt,
        }),
    });
    if (!answer.ok) {
        throw new Error(`reserve refused: ${answer.code ?? answer.problem}`);
    }

    const body = JSON.parse(answer.body) as Record<string, unknown>;
    if (typeof body.dispatchToken !== 'string') {
        throw new Error('the reservation carried no token');
    }

    loop.unmount(rt);

    return body.dispatchToken;
}

/**
 * Claim and reserve one run without any panel (a second mount's own attempt).
 *
 * @param issueNumber - Issue to claim for.
 * @returns The claimed offer and the token it reserved with.
 */
async function claimAndReserve(issueNumber: number): Promise<{ readonly run: ClaimedRun; readonly token: string }> {
    const answer = await claim(loop.service);
    expectStatus({ step: 'claim', answer, status: 200 });
    const offer = parsePendingBody(JSON.stringify(answer.json));
    const run = offer?.runs.find((candidate) => candidate.issueNumber === issueNumber);
    if (run === undefined) {
        throw new Error(`issue ${issueNumber} was not offered`);
    }

    const reserved = await post({
        service: loop.service,
        path: bound(RESERVE_PATH, run.correlationId),
        body: { correlationId: run.correlationId, leaseId: run.lease.leaseId, attempt: run.attempt },
    });
    expectStatus({ step: 'reserve', answer: reserved, status: 200 });
    const token = reserved.json.dispatchToken;
    if (typeof token !== 'string') {
        throw new Error('the reservation carried no token');
    }

    return { run, token };
}

/**
 * Burn the automatic requeue budget so the run parks (FR-033).
 *
 * @param issueNumber - Issue to exhaust.
 * @throws {Error} When the budget does not park the run within eight passes.
 */
async function exhaustRequeueBudget(issueNumber: number): Promise<void> {
    for (let pass = 0; pass < 8; pass += 1) {
        const run = await runOf(issueNumber);
        if (run.state === 'dead-lettered') {
            return;
        }

        if (run.state === 'pending') {
            const answer = await claim(loop.service);
            expectStatus({ step: 'claim for expiry', answer, status: 200 });
        }

        const held = await runOf(issueNumber);
        if (held.lease === null) {
            throw new Error(`issue ${issueNumber} holds no lease to expire`);
        }
        await loop.sweepAt(justPast(held.lease.expiresAt));
    }

    throw new Error(`issue ${issueNumber} never dead-lettered`);
}

/** Run one relay tick on a mount and settle the detached read-backs. */
async function tick(rt: PanelRuntime): Promise<void> {
    await pollRelay(rt);
    await drainVerifications(rt);
}

/** AC-110's metric, stated once: no run identifier ever produced two sessions. */
function expectAtMostOneSessionPerRun(): void {
    for (const [correlationId, count] of sessionsPerRun(loop.sessions)) {
        expect(count, `run ${correlationId} created ${count} sessions`).toBeLessThanOrEqual(1);
    }
}

/** The dispatch record the panel wrote, read without trusting its shape. */
function storedAttempts(): readonly Record<string, unknown>[] {
    const raw = loop.panelStorage.get(DISPATCH_STORAGE_KEY);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('the panel stored no dispatch record');
    }

    const { attempts } = raw as { attempts?: unknown };
    if (!Array.isArray(attempts)) {
        throw new Error('the dispatch record carries no attempts');
    }

    return attempts.map((entry) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
            throw new Error('the dispatch record held a non-record attempt');
        }

        return entry as Record<string, unknown>;
    });
}

describe('close permutations (NFR-102, AC-110)', () => {
    it('close before claim: a waiting run burns nothing and runs on the next mount', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const waiting = await runOf(ISSUE);

        // Sweeping far past every window must not touch work no panel holds
        // (FR-036): no attempt, no requeue, no dead letter.
        await loop.sweepAt(FAR_FUTURE);
        const untouched = await runOf(ISSUE);
        expect(untouched.state).toBe('pending');
        expect(untouched.attempt).toBe(1);
        expect(untouched.requeuesUsed).toBe(0);
        expect(untouched.lease).toBeNull();

        const rt = loop.mount();
        await tick(rt);

        expect(loop.sessions).toEqual([waiting.correlationId]);
        expect(await stateOf(ISSUE)).toBe('dispatched');
        expectAtMostOneSessionPerRun();
    });

    it('close after claim: the lease expires on its own, audited, and the work still runs once', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        const [offered] = await offerFor(rt);
        if (offered === undefined) {
            throw new Error(NO_OFFER);
        }
        loop.unmount(rt);

        await loop.sweepAt(justPast(offered.lease.expiresAt));

        const requeued = await runOf(ISSUE);
        expect(requeued.state).toBe('pending');
        expect(requeued.attempt).toBe(2);
        expect(requeued.lease).toBeNull();

        const trail = await readTrail(loop.store);
        const expiries = trail.filter((entry) => entry.eventType === LEASE_EXPIRED_EVENT);
        expect(expiries).toHaveLength(1);
        expect(expiries[0]).toMatchObject({
            correlationId: requeued.correlationId,
            details: { priorState: 'claimed', attemptBefore: 1, attemptAfter: 2 },
        });

        const second = loop.mount();
        await tick(second);
        expect(loop.sessions).toEqual([requeued.correlationId]);
        expectAtMostOneSessionPerRun();
    });

    it('close after authorization: the run wedges fail-closed and never self-expires', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        const [offered] = await offerFor(rt);
        if (offered === undefined) {
            throw new Error(NO_OFFER);
        }
        await reserveThenDie(rt, offered);

        const reserved = await runOf(ISSUE);
        const deadline = reserved.reservation?.resultDeadlineAt;
        if (deadline === undefined) {
            throw new Error(NO_DEADLINE);
        }
        await loop.sweepAt(justPast(deadline));
        expect(await stateOf(ISSUE)).toBe('unconfirmed');

        // Fail closed: a later mount claims nothing, starts nothing, and ten
        // further sweeps move the wedge nowhere (FR-023, AC-107).
        const second = loop.mount();
        await tick(second);
        expect(loop.sessions).toHaveLength(0);
        for (let pass = 0; pass < 10; pass += 1) {
            await loop.sweepAt(FAR_FUTURE);
        }
        expect(await stateOf(ISSUE)).toBe('unconfirmed');

        // The operator's explicit "created no session" is the re-dispatch path.
        const resolve = await post({
            service: loop.service,
            path: bound(RESOLVE_PATH, offered.correlationId),
            body: { correlationId: offered.correlationId, decision: 'no-session', note: 'checked the session list' },
        });
        expectStatus({ step: 'resolve', answer: resolve, status: 200 });
        expect(await stateOf(ISSUE)).toBe('pending');

        await tick(second);
        expect(loop.sessions).toEqual([offered.correlationId]);
        expectAtMostOneSessionPerRun();
    });
});

describe('lost and duplicated reports (NFR-102, AC-111)', () => {
    it('lost result: the recorded outcome travels on the next mount, and only then', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount({ loseFirstReport: true });
        await tick(rt);

        expect(loop.sessions).toHaveLength(1);
        expect(rt.state.bindings.note).toContain('report was refused');
        const stranded = await runOf(ISSUE);
        expect(stranded.state).toBe('starting');
        expect(stranded.session).toBeNull();

        // Remount: reconciliation reports the outstanding attempt before any
        // claim (FR-025), so the run reaches the session that already exists.
        loop.unmount(rt);
        const second = loop.mount();
        await reconcileDispatchAttempts(second);
        const reconciled = await runOf(ISSUE);
        expect(reconciled.state).toBe('dispatched');
        expect(reconciled.session?.sessionId).toBe(SESSION_ID);
        expect(loop.sessions).toHaveLength(1);

        await tick(second);
        expect(loop.sessions).toHaveLength(1);
        expectAtMostOneSessionPerRun();
    });

    it('duplicated result: the repeat changes nothing and adds exactly one audit row', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const first = loop.mount();
        await tick(first);
        expect(loop.sessions).toHaveLength(1);
        expect(storedAttempts()[0]?.acknowledged).toBe(true);

        // The report landed but the acknowledgement did not: the record still
        // reads unacknowledged, so the next mount repeats the same report.
        loop.unmount(first);
        const attempts = storedAttempts().map((entry) => ({ ...entry, acknowledged: false }));
        loop.panelStorage.set(DISPATCH_STORAGE_KEY, { schemaVersion: 'dispatch-attempts-1', attempts });

        const second = loop.mount();
        await reconcileDispatchAttempts(second);

        const repeated = await runOf(ISSUE);
        expect(repeated.state).toBe('dispatched');
        expect(repeated.session?.sessionId).toBe(SESSION_ID);
        expect(loop.sessions).toHaveLength(1);

        const trail = await readTrail(loop.store);
        expect(trail.filter((entry) => entry.eventType === 'dispatch.duplicate-report')).toHaveLength(1);
        expectAtMostOneSessionPerRun();
    });
});

describe('stale and slow panels (NFR-102, AC-109)', () => {
    it('stale result: a superseded attempt cannot report a session', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        const [offered] = await offerFor(rt);
        if (offered === undefined) {
            throw new Error(NO_OFFER);
        }
        const staleToken = await reserveThenDie(rt, offered);

        const wedge = await runOf(ISSUE);
        const deadline = wedge.reservation?.resultDeadlineAt;
        if (deadline === undefined) {
            throw new Error(NO_DEADLINE);
        }
        await loop.sweepAt(justPast(deadline));

        const resolve = await post({
            service: loop.service,
            path: bound(RESOLVE_PATH, offered.correlationId),
            body: { correlationId: offered.correlationId, decision: 'no-session', note: 'checked the session list' },
        });
        expectStatus({ step: 'resolve', answer: resolve, status: 200 });

        // The chain-1 report arrives after its attempt was closed and its
        // reservation cleared: refused as stale, and no session stands for it.
        const late = await post({
            service: loop.service,
            path: bound(DISPATCHED_PATH, offered.correlationId),
            body: {
                correlationId: offered.correlationId,
                attempt: 1,
                dispatchToken: staleToken,
                sessionId: 'ses_late_from_the_old_chain',
            },
        });
        expect(late.status).toBe(409);
        expect(codeOf(late.json)).toBe('stale-lease');

        const after = await runOf(ISSUE);
        expect(after.session).toBeNull();
        expect(after.state).toBe('pending');

        const live = loop.mount();
        await tick(live);
        expect(loop.sessions).toHaveLength(1);
        expectAtMostOneSessionPerRun();
    });

    it('slow panel: a late reserve against a newer attempt never starts a session', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const slow = loop.mount();
        const [staleOffer] = await offerFor(slow);
        if (staleOffer === undefined) {
            throw new Error('the slow panel was offered nothing');
        }

        // Its lease expires and a newer mount claims the run under attempt 2.
        await loop.sweepAt(justPast(staleOffer.lease.expiresAt));
        const fresh = loop.mount();
        await tick(fresh);
        expect(loop.sessions).toHaveLength(1);

        // The slow panel reports against the lease it still holds: refused as
        // stale, and it reaches no host call (FR-022, AC-109).
        await dispatchClaimedRun(slow, staleOffer);
        expect(loop.sessions).toHaveLength(1);
        expect(slow.state.bindings.note).toContain('not authorized to start');
        expect(await stateOf(ISSUE)).toBe('dispatched');
        expectAtMostOneSessionPerRun();
    });

    it('abandoned reservation: a panel closed before the host call reports no session', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        const [offered] = await offerFor(rt);
        if (offered === undefined) {
            throw new Error(NO_OFFER);
        }
        const token = await reserveThenDie(rt, offered);

        // The panel never called the host, so it reports the abandonment the
        // contract asks for rather than leaving the run unconfirmed.
        const abandoned = await post({
            service: loop.service,
            path: bound(ABANDON_PATH, offered.correlationId),
            body: {
                correlationId: offered.correlationId,
                attempt: offered.attempt,
                dispatchToken: token,
                reason: 'the host call never ran',
            },
        });
        expectStatus({ step: 'abandon', answer: abandoned, status: 200 });
        expect(await stateOf(ISSUE)).toBe('failed');
        expect(loop.sessions).toHaveLength(0);
        expectAtMostOneSessionPerRun();
    });
});

describe('restart, wipe, and retry (NFR-102, AC-110)', () => {
    it('service restart: a lease that is still live is left exactly alone', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        const [offered] = await offerFor(rt);
        if (offered === undefined) {
            throw new Error(NO_OFFER);
        }
        loop.unmount(rt);

        await loop.restart();

        // Nothing expired, so nothing is recovered: the same lease stands, no
        // attempt moved, and no audit row was written (FR-036, T-045).
        const held = await runOf(ISSUE);
        expect(held.state).toBe('claimed');
        expect(held.attempt).toBe(1);
        expect(held.lease?.expiresAt).toBe(offered.lease.expiresAt);
        const trail = await readTrail(loop.store);
        expect(trail.filter((entry) => entry.eventType === LEASE_EXPIRED_EVENT)).toHaveLength(0);
    });

    it('service restart: the boot sweep recovers a lease the downtime outlived', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        const [offered] = await offerFor(rt);
        if (offered === undefined) {
            throw new Error(NO_OFFER);
        }
        loop.unmount(rt);

        // The lease outlived the outage; the boot sweep runs before the
        // listener binds, so the stranded claim is already recovered by the
        // time any panel can ask for work (FR-032).
        await loop.ageLeases();
        await loop.restart();

        const recovered = await runOf(ISSUE);
        expect(recovered.state).toBe('pending');
        expect(recovered.attempt).toBe(2);
        expect(recovered.lease).toBeNull();

        const trail = await readTrail(loop.store);
        const expiries = trail.filter((entry) => entry.eventType === LEASE_EXPIRED_EVENT);
        expect(expiries).toHaveLength(1);
        expect(expiries[0]?.correlationId).toBe(recovered.correlationId);

        const second = loop.mount();
        await tick(second);
        expect(loop.sessions).toEqual([recovered.correlationId]);
        expectAtMostOneSessionPerRun();
    });

    it('panel storage wipe: nothing reconciles, nothing re-dispatches, the operator decides', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        const [offered] = await offerFor(rt);
        if (offered === undefined) {
            throw new Error(NO_OFFER);
        }
        await reserveThenDie(rt, offered);

        const reserved = await runOf(ISSUE);
        const deadline = reserved.reservation?.resultDeadlineAt;
        if (deadline === undefined) {
            throw new Error(NO_DEADLINE);
        }
        await loop.sweepAt(justPast(deadline));
        expect(await stateOf(ISSUE)).toBe('unconfirmed');

        // Host storage is gone (uninstall, or a wipe): the panel has nothing
        // to reconcile from, so it must not guess (spec Assumptions).
        loop.panelStorage.clear();
        const second = loop.mount();
        await reconcileDispatchAttempts(second);
        await tick(second);
        expect(loop.sessions).toHaveLength(0);
        expect(await stateOf(ISSUE)).toBe('unconfirmed');

        // The operator names the session they found in OpenChamber's own list.
        const resolve = await post({
            service: loop.service,
            path: bound(RESOLVE_PATH, offered.correlationId),
            body: {
                correlationId: offered.correlationId,
                decision: 'session-created',
                sessionId: 'ses_found_by_the_operator',
            },
        });
        expectStatus({ step: 'resolve', answer: resolve, status: 200 });
        expect(await stateOf(ISSUE)).toBe('dispatched');

        await tick(second);
        expect(loop.sessions).toHaveLength(0);
        expectAtMostOneSessionPerRun();
    });

    it('operator retry: a failed dispatch retries under the same run key and runs once', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const failing = loop.mount({
            startSession: async () => NO_SESSION,
        });
        await tick(failing);

        const failed = await runOf(ISSUE);
        expect(failed.state).toBe('failed');
        expect(failed.session).toBeNull();
        expect(loop.sessions).toHaveLength(0);

        const retry = await post({
            service: loop.service,
            path: bound(RETRY_PATH, failed.correlationId),
            body: {
                correlationId: failed.correlationId,
                attempt: failed.attempt,
                causeCleared: true,
                causeReport: 'the host is healthy again',
            },
        });
        expectStatus({ step: 'retry', answer: retry, status: 200 });
        loop.unmount(failing);

        const waiting = await runOf(ISSUE);
        expect(waiting.state).toBe('pending');
        expect(waiting.runKey).toBe(failed.runKey);
        expect(waiting.attempt).toBe(2);
        expect(waiting.sourceReferences).toHaveLength(1);

        const healthy = loop.mount();
        await tick(healthy);
        expect(loop.sessions).toEqual([waiting.correlationId]);
        expect(await stateOf(ISSUE)).toBe('dispatched');
        expectAtMostOneSessionPerRun();
    });
});

describe('the cross-chain replay (FR-020, FR-028, AC-110)', () => {
    it('refuses a chain-1 report after reset, requeue, and a fresh chain-2 reserve', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const first = await claimAndReserve(ISSUE);

        // Chain 1 ends honestly: a report that created no session.
        const failed = await post({
            service: loop.service,
            path: bound(DISPATCHED_PATH, first.run.correlationId),
            body: {
                correlationId: first.run.correlationId,
                attempt: 1,
                dispatchToken: first.token,
                problem: 'the host call failed',
            },
        });
        expectStatus({ step: 'chain-1 result', answer: failed, status: 200 });

        const retry = await post({
            service: loop.service,
            path: bound(RETRY_PATH, first.run.correlationId),
            body: { correlationId: first.run.correlationId, attempt: 1, causeCleared: true },
        });
        expectStatus({ step: 'retry', answer: retry, status: 200 });

        await exhaustRequeueBudget(ISSUE);
        const parked = await runOf(ISSUE);
        expect(parked.state).toBe('dead-lettered');

        const returned = await post({
            service: loop.service,
            path: bound(REQUEUE_PATH, first.run.correlationId),
            body: { correlationId: first.run.correlationId, confirm: true },
        });
        expectStatus({ step: 'return to waiting', answer: returned, status: 200 });

        // The reset re-derives the *same* token (FR-020 pins the derivation to
        // run key + attempt), which is exactly what makes the replay possible.
        const second = await claimAndReserve(ISSUE);
        expect(second.token).toBe(first.token);

        const replay = await post({
            service: loop.service,
            path: bound(DISPATCHED_PATH, first.run.correlationId),
            body: {
                correlationId: first.run.correlationId,
                attempt: 1,
                dispatchToken: first.token,
                sessionId: 'ses_from_chain_one',
            },
        });
        expect(replay.status).toBe(409);
        expect(codeOf(replay.json)).toBe('stale-lease');

        const stored = await runOf(ISSUE);
        expect(stored.session).toBeNull();
        expect(stored.state).toBe('starting');
        expect(loop.sessions).toHaveLength(0);
        expectAtMostOneSessionPerRun();
    });
});

describe('SC-101: two triggers, one run, one session (AC-101)', () => {
    it(`answers ${TRIALS} dual-trigger trials with one run and one session each`, async () => {
        // One scan's worth of detections per call — exactly how the production
        // loop hands a binding's scan to the queue (`service/poll/loop.ts`).
        // Scan A carries both triggers for half the trials and one for the
        // rest; scan B brings the second trigger for that half in a later
        // window. Both shapes must coalesce onto a single run (FR-011).
        await loop.enqueueScan(
            Array.from({ length: TRIALS }, (_unused, index) => ({
                issueNumber: FIRST_TRIAL_ISSUE + index,
                triggers: index < LATER_SCAN_TRIALS
                    ? (['assignment', 'body-mention'] as const)
                    : (['assignment'] as const),
            })),
        );
        await loop.enqueueScan(
            Array.from({ length: TRIALS - LATER_SCAN_TRIALS }, (_unused, index) => ({
                issueNumber: FIRST_TRIAL_ISSUE + LATER_SCAN_TRIALS + index,
                triggers: ['body-mention'] as const,
                detectedAt: LATER_STAMP,
            })),
        );

        const rt = loop.mount();
        // The claim is paginated (contract `claim-lease.md`), so one tick can
        // never see all of them.
        await tick(rt);
        await tick(rt);

        const runs = await readRuns(loop.store);
        expect(runs).toHaveLength(TRIALS);
        expect(loop.sessions).toHaveLength(TRIALS);
        expect(new Set(loop.sessions).size).toBe(TRIALS);
        expect(runs.filter((run) => run.state === 'dispatched')).toHaveLength(TRIALS);
        expect(runs.filter((run) => run.sourceReferences.length === 2)).toHaveLength(TRIALS);
        expect(runs.filter((run) => run.referenceCount === 2)).toHaveLength(TRIALS);

        const kinds = new Set(runs.flatMap((run) => run.sourceReferences.map((reference) => reference.kind)));
        expect([...kinds].sort()).toEqual(['assignment', 'mention']);
        expectAtMostOneSessionPerRun();
    }, TRIALS_BUDGET_MS);
});
