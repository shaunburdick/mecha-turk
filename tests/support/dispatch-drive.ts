/**
 * The drive: one legacy run walked through every transition in 003's
 * data-model §4.3, then the trail it wrote (003 T-018).
 *
 * The sequence goes through the real loopback routes and the real sweep — no
 * hand-written `runs.json`, no direct audit appends for lifecycle rows —
 * because a vocabulary row written by a fixture would prove only that the
 * fixture can write it. Its raw materials and verbs live in
 * [`dispatch-corpus.ts`](./dispatch-corpus.ts); this file is the order they run
 * in, one exported entry point ([`driveDispatchCorpus`]) for the suite.
 *
 * Order, and why it is one run: adoption writes `run.migrated`; the claim
 * gives the eight refusals a live state to refuse in (`dispatch.refused`
 * ×8, one per refusing operation); three lease expiries burn the budget and
 * the fourth parks the run (`dispatch.lease-expired` ×3, `run.dead_lettered`);
 * return to waiting, block, retry, reserve → coalesce → abandon, reserve →
 * wedge (`dispatch.unconfirmed`) → resolve, reserve → dispatch
 * (`dispatch.result`) → repeat (`dispatch.duplicate-report`) → read back three
 * ways (`agent.verified`, `agent.mismatch`, `agent.uncompared`); and one
 * subject is enqueued last so `run.created` lands on a run nothing ever claimed.
 */

import { ABANDON_PATH, BLOCKED_PATH, DISPATCHED_PATH, RESERVE_PATH } from '../../service/routes/dispatch.ts';
import { REQUEUE_PATH, RESOLVE_PATH, RETRY_PATH, VERIFICATION_PATH } from '../../service/routes/run-ops.ts';
import type { Run } from '../../service/poll/runs-types.ts';
import type { ServiceStore } from '../../service/store/index.ts';
import {
    BLOCKED_CAUSE,
    BLOCK_GUIDANCE,
    CREATED_ISSUE,
    EXPECTED_AGENT,
    OTHER_AGENT,
    SESSION_ID,
    UNKNOWN_LEASE,
    UNKNOWN_TOKEN,
    bound,
    claim,
    codeOf,
    driveToDeadLetter,
    enqueueFixture,
    expectStatus,
    leaseOf,
    post,
    readRun,
    readRuns,
    readTrail,
    startWithLegacyQueue,
    sweep,
    tokenOf,
} from './dispatch-corpus.ts';
import type { DispatchCorpus, RefusalObservation } from './dispatch-corpus.ts';
import type { TestService } from './service.ts';

/** Issue the adopted run belongs to; a later trigger coalesces onto it. */
const ADOPTED_ISSUE = 7;

/** Stamp the coalescing trigger carries; after the legacy one, still open. */
const JOINED_STAMP = '2026-09-20T00:05:00.000Z';

/** Stamp the freshly created run's trigger carries. */
const CREATED_STAMP = '2026-09-21T00:00:00.000Z';

/** Everything one phase of the drive needs to move the run on. */
interface DriveContext {
    /** The running instance the routes answer on. */
    readonly service: TestService;
    /** The open store every transition reads and writes. */
    readonly store: ServiceStore;
    /** The run every phase drives. */
    readonly correlationId: string;
}

/** The reserve body every phase posts: echo, current attempt, live lease. */
async function reserveBody(context: DriveContext): Promise<Record<string, unknown>> {
    const run = await readRun(context.store, context.correlationId);

    return { correlationId: context.correlationId, attempt: run.attempt, leaseId: leaseOf(run) };
}

/** Post one run-scoped operation and demand the `200` it owes. */
async function expectApplied(input: DriveContext & {
    /** What this step is, for the failure message. */
    readonly step: string;
    /** The concrete path to post to. */
    readonly path: string;
    /** The body to send. */
    readonly body: Record<string, unknown>;
}): Promise<void> {
    const answer = await post({ service: input.service, path: input.path, body: input.body });
    expectStatus({ step: input.step, answer, status: 200 });
}

/** Take one refusal and record the verdict the wire answered with. */
async function takeRefusal(input: DriveContext & {
    /** The observation list the suite asserts over. */
    readonly refusals: RefusalObservation[];
    /** Operation name the refusal row records. */
    readonly operation: string;
    /** The concrete path to post to. */
    readonly path: string;
    /** The body that makes the operation refuse. */
    readonly body: Readonly<Record<string, unknown>>;
    /** The status this refusal owes. */
    readonly status: number;
    /** The error code that status carries. */
    readonly code: string;
}): Promise<void> {
    const answer = await post({ service: input.service, path: input.path, body: input.body });
    expectStatus({ step: `refusal: ${input.operation}`, answer, status: input.status });
    const observed = codeOf(answer.json);
    if (observed !== input.code) {
        throw new Error(`refusal: ${input.operation} answered code ${observed}, expected ${input.code}`);
    }

    input.refusals.push({ operation: input.operation, status: answer.status, code: observed });
}

/** The four refusals the authorization family answers while a run is claimed. */
async function driveAuthorizationRefusals(
    context: DriveContext & { readonly refusals: RefusalObservation[] },
): Promise<void> {
    const claimed = await readRun(context.store, context.correlationId);
    const common = { correlationId: context.correlationId, attempt: claimed.attempt };

    // A state verdict: the lease presented is not this run's (FR-022).
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'reserve',
        path: bound(RESERVE_PATH, context.correlationId),
        body: { ...common, leaseId: UNKNOWN_LEASE },
        status: 409,
        code: 'stale-lease',
    });
    // Neither outcome named, so FR-040's "exactly one" refuses it (T-043).
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'result',
        path: bound(DISPATCHED_PATH, context.correlationId),
        body: { ...common, dispatchToken: UNKNOWN_TOKEN },
        status: 422,
        code: 'validation',
    });
    // No reason for the failure row the operation would have written.
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'abandon',
        path: bound(ABANDON_PATH, context.correlationId),
        body: { ...common, dispatchToken: UNKNOWN_TOKEN },
        status: 422,
        code: 'validation',
    });
    // A guard cause outside the declared four: `blocked:<reason>` would not parse.
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'blocked',
        path: bound(BLOCKED_PATH, context.correlationId),
        body: { ...common, leaseId: leaseOf(claimed), blockedReason: 'not-a-declared-cause', detail: 'probe' },
        status: 422,
        code: 'validation',
    });
}

/** The four refusals the operator actions answer, each from its own rule. */
async function driveOperatorRefusals(
    context: DriveContext & { readonly refusals: RefusalObservation[] },
): Promise<void> {
    const run = await readRun(context.store, context.correlationId);
    const common = { correlationId: context.correlationId, attempt: run.attempt };
    const id = context.correlationId;

    // A state verdict: only `failed` and `blocked:*` are retryable (FR-041).
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'retry',
        path: bound(RETRY_PATH, id),
        body: { ...common, causeCleared: true },
        status: 409,
        code: 'invalid-transition',
    });
    // The reset discards budget accounting, so it is confirmed explicitly.
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'requeue',
        path: bound(REQUEUE_PATH, id),
        body: { correlationId: id },
        status: 422,
        code: 'validation',
    });
    // Neither of FR-027's two explicit resolutions (FR-003: refuse ambiguity).
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'resolve',
        path: bound(RESOLVE_PATH, id),
        body: { correlationId: id, decision: 'later' },
        status: 422,
        code: 'validation',
    });
    // A read-back with no agent to compare against (contract §5).
    await takeRefusal({
        ...context,
        refusals: context.refusals,
        operation: 'verification',
        path: bound(VERIFICATION_PATH, id),
        body: { ...common, sessionId: SESSION_ID },
        status: 422,
        code: 'validation',
    });
}

/** Take all eight refusals while the run is claimed; none of them moves it. */
async function driveRefusals(context: DriveContext): Promise<RefusalObservation[]> {
    const refusals: RefusalObservation[] = [];
    const withRefusals = { ...context, refusals };
    expectStatus({ step: 'claim for refusals', answer: await claim(context.service), status: 200 });
    await driveAuthorizationRefusals(withRefusals);
    await driveOperatorRefusals(withRefusals);

    return refusals;
}

/** Park the run on its budget, then return it to waiting (FR-033, reset). */
async function driveBudgetPhase(context: DriveContext): Promise<void> {
    await driveToDeadLetter(context);
    await expectApplied({
        ...context,
        step: 'return to waiting from dead letter',
        path: bound(REQUEUE_PATH, context.correlationId),
        body: { correlationId: context.correlationId, confirm: true },
    });
}

/** Hold the run behind a guard refusal, then retry it once the cause clears. */
async function driveGuardPhase(context: DriveContext): Promise<void> {
    expectStatus({ step: 'claim for block', answer: await claim(context.service), status: 200 });
    const forBlock = await readRun(context.store, context.correlationId);
    await expectApplied({
        ...context,
        step: 'block report',
        path: bound(BLOCKED_PATH, context.correlationId),
        body: {
            correlationId: context.correlationId,
            attempt: forBlock.attempt,
            leaseId: leaseOf(forBlock),
            blockedReason: BLOCKED_CAUSE,
            detail: 'prj_42 is not registered in OpenChamber',
            guidance: BLOCK_GUIDANCE,
        },
    });
    const blocked = await readRun(context.store, context.correlationId);
    await expectApplied({
        ...context,
        step: 'retry from blocked',
        path: bound(RETRY_PATH, context.correlationId),
        body: {
            correlationId: context.correlationId,
            attempt: blocked.attempt,
            causeCleared: true,
            causeReport: 'the project is registered now',
        },
    });
}

/** Reserve, let a trigger join *after* the authorization, then abandon. */
async function driveAbandonPhase(context: DriveContext): Promise<Run> {
    expectStatus({ step: 'claim for reserve', answer: await claim(context.service), status: 200 });
    await expectApplied({
        ...context,
        step: 'reserve',
        path: bound(RESERVE_PATH, context.correlationId),
        body: await reserveBody(context),
    });
    // The join happens under a live reservation, so its reference is marked
    // `presentAtAuthorization: false` — FR-015's "may not have been seen".
    await enqueueFixture({
        store: context.store,
        issueNumber: ADOPTED_ISSUE,
        kind: 'mention',
        detectedAt: JOINED_STAMP,
    });
    const reserved = await readRun(context.store, context.correlationId);
    await expectApplied({
        ...context,
        step: 'abandon',
        path: bound(ABANDON_PATH, context.correlationId),
        body: {
            correlationId: context.correlationId,
            attempt: reserved.attempt,
            dispatchToken: tokenOf(reserved),
            reason: 'the host call never ran',
        },
    });
    const abandoned = await readRun(context.store, context.correlationId);
    await expectApplied({
        ...context,
        step: 'retry from failed',
        path: bound(RETRY_PATH, context.correlationId),
        body: {
            correlationId: context.correlationId,
            attempt: abandoned.attempt,
            causeCleared: true,
            causeReport: 'the panel is mounted again',
        },
    });

    return await readRun(context.store, context.correlationId);
}

/** Reserve, let the deadline pass on an injected stamp, resolve the wedge. */
async function driveWedgePhase(context: DriveContext): Promise<void> {
    expectStatus({ step: 'claim for wedge', answer: await claim(context.service), status: 200 });
    await expectApplied({
        ...context,
        step: 'reserve for wedge',
        path: bound(RESERVE_PATH, context.correlationId),
        body: await reserveBody(context),
    });
    await sweep(context.store);
    const wedged = await readRun(context.store, context.correlationId);
    if (wedged.state !== 'unconfirmed') {
        throw new Error(`the fixture run wedged as ${wedged.state}, expected unconfirmed`);
    }

    await expectApplied({
        ...context,
        step: 'resolve the wedge',
        path: bound(RESOLVE_PATH, context.correlationId),
        body: {
            correlationId: context.correlationId,
            decision: 'no-session',
            note: 'checked the session list; nothing was created',
        },
    });
}

/** The ordinary success: reserve, report a session, then repeat the report. */
async function driveResultPhase(context: DriveContext): Promise<Run> {
    expectStatus({ step: 'claim for dispatch', answer: await claim(context.service), status: 200 });
    await expectApplied({
        ...context,
        step: 'reserve for dispatch',
        path: bound(RESERVE_PATH, context.correlationId),
        body: await reserveBody(context),
    });
    const authorized = await readRun(context.store, context.correlationId);
    const body = {
        correlationId: context.correlationId,
        attempt: authorized.attempt,
        dispatchToken: tokenOf(authorized),
        sessionId: SESSION_ID,
    };
    const path = bound(DISPATCHED_PATH, context.correlationId);
    await expectApplied({ ...context, step: 'result', path, body });
    // An identical repeat changes nothing and is audited as a duplicate (FR-025).
    await expectApplied({ ...context, step: 'repeated result', path, body });

    return await readRun(context.store, context.correlationId);
}

/**
 * File the read-back three ways: matching, mismatching, and with no baseline
 * to compare against at all (FR-043; 003 v1.7.0's third row).
 *
 * The third report is the one a fresh install produces by default — the
 * Default Agent pin is blank — so the corpus drives it deliberately: it must
 * land as `agent.uncompared` beside the other two, never as a mismatch for a
 * comparison that never happened.
 */
async function driveVerificationPhase(context: DriveContext & { readonly run: Run }): Promise<void> {
    const readBack = {
        correlationId: context.correlationId,
        attempt: context.run.attempt,
        sessionId: SESSION_ID,
        expectedAgent: EXPECTED_AGENT,
        baselineProvenance: 'configured',
    };
    const path = bound(VERIFICATION_PATH, context.correlationId);

    await expectApplied({
        ...context,
        step: 'matching read-back',
        path,
        body: { ...readBack, observedAgent: EXPECTED_AGENT, ok: true },
    });
    await expectApplied({
        ...context,
        step: 'mismatching read-back',
        path,
        body: { ...readBack, observedAgent: OTHER_AGENT, ok: false, note: 'the read-back named a different agent' },
    });
    await expectApplied({
        ...context,
        step: 'read-back with no baseline',
        path,
        body: {
            ...readBack,
            expectedAgent: '',
            baselineProvenance: 'unset',
            observedAgent: EXPECTED_AGENT,
            ok: false,
            note: 'no baseline is configured, so nothing was compared',
        },
    });
}

/**
 * Drive the corpus and read the trail it wrote.
 *
 * @returns The service, the trail, both run ids, and the eight refusals.
 * @throws {Error} When any step answers anything but its own verdict, so a
 *   broken fixture fails here rather than as a confusing assertion downstream.
 */
export async function driveDispatchCorpus(): Promise<DispatchCorpus> {
    const { service, store } = await startWithLegacyQueue();

    // Adoption already ran at boot: the first stored run is the adopted one.
    const stored = await readRuns(store);
    const [adopted] = stored;
    if (adopted === undefined) {
        throw new Error('adoption produced no run');
    }

    const context: DriveContext = { service, store, correlationId: adopted.correlationId };
    const refusals = await driveRefusals(context);
    await driveBudgetPhase(context);
    await driveGuardPhase(context);
    await driveAbandonPhase(context);
    await driveWedgePhase(context);
    const dispatched = await driveResultPhase(context);
    await driveVerificationPhase({ ...context, run: dispatched });

    // One more subject, created the ordinary way: nothing ever claims it, so
    // its `run.created` row is the vocabulary's first entry and stays untouched.
    await enqueueFixture({
        store,
        issueNumber: CREATED_ISSUE,
        kind: 'assignment',
        detectedAt: CREATED_STAMP,
    });
    const afterCreation = await readRuns(store);
    const created = afterCreation.find((run) => run.subjectNumber === CREATED_ISSUE);
    if (created === undefined) {
        throw new Error('the fixture run was not created');
    }

    return {
        service,
        trail: await readTrail(store),
        adoptedRunId: adopted.correlationId,
        createdRunId: created.correlationId,
        refusals,
    };
}
