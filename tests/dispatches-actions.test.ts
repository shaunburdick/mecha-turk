/**
 * The Dispatches tab's actions against the **real loopback service** (005
 * T-018: AC-114 – AC-118, FR-044 – FR-049).
 *
 * `tests/dispatches.test.ts` drives the same actions against a recorded route
 * table, which is the right home for bodies and copy. What T-018 promises is
 * about the **service's own verdict**, and a route table cannot give one: each
 * acceptance criterion below is answered by the running service over the
 * loopback bridge, and the panel renders exactly what came back — the local
 * refusal for a state the table already forbids, the guard's own words when a
 * blocked dispatch's cause has not cleared, and the re-read row after an
 * operation the service accepted.
 *
 * Two properties are asserted that only a real service can prove: a refused
 * retry leaves the row **byte-identical to the last read** (the panel never
 * predicts a verdict), and two rapid activations of one row run **exactly one**
 * operation (the single `busy` gate lives in the one dispatch path, not in the
 * callers that all yield before they reach it).
 *
 * Offline by construction: a temp store, the loopback service, host doubles,
 * and sweeps driven at injected stamps — no live host, no PAT, no network, no
 * clock the test waits on (FR-086, NFR-112).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GuestProjectsSnapshot } from '@openchamber/sdk';
import { pollRelay } from '../src/relay.ts';
import {
    copyCorrelationId,
    loadDispatches,
    resolveNoSession,
    retryRun,
    requeueRun,
    selectDispatch,
} from '../src/dispatches.ts';
import { runAffordance } from '../src/dispatches-rows.ts';
import { reservePath, servicePost } from '../src/service-calls.ts';
import { ABANDON_PATH } from '../service/routes/dispatch.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import type { Run } from '../service/poll/runs-types.ts';
import { justPast, offerFor, startDispatchLoop } from './support/dispatch-loop.ts';
import { bound, driveToDeadLetter, post, readRuns } from './support/dispatch-corpus.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';
import type { DispatchLoop } from './support/dispatch-loop.ts';

/** Issue whose dispatch is left waiting, for the no-retry criterion (AC-114). */
const WAITING_ISSUE = 101;

/** Issue whose dispatch is wedged fail-closed, for AC-115. */
const WEDGED_ISSUE = 102;

/** Issue whose dispatch a guard holds blocked, for AC-116 and AC-118. */
const BLOCKED_ISSUE = 103;

/** Issue whose dispatch burns the requeue budget, for AC-117. */
const PARKED_ISSUE = 104;

/** Issue whose dispatch reports no session, for the busy-gate and copy tests. */
const FAILED_ISSUE = 105;

/** Failure a fixture raises when a claim offered nothing to act on. */
const NO_OFFER = 'the claim offered nothing';

/** Failure a fixture raises when a reservation carried no result deadline. */
const NO_DEADLINE = 'the reservation carried no deadline';

/** The failure copy the panel writes when the frame refuses a clipboard write. */
const CLIPBOARD_FAILURE = 'clipboard blocked by the frame';

/** Host snapshot answering with no registered project at all. */
const NO_PROJECTS: GuestProjectsSnapshot = { kind: 'projects', state: 'ready', projects: [] };

/** The service's own words when a blocked dispatch's cause has not cleared. */
const CAUSE_NOT_CLEARED = 'the cause has not cleared';

/** The loop under test. */
let loop: DispatchLoop;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    loop = await startDispatchLoop();
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await loop.shutdown();
};

afterEach(afterEachWork2);

/**
 * Read the one run a fixture issue produced.
 *
 * @param issueNumber - Issue the run is about.
 * @returns The run as the service holds it.
 * @throws {Error} When no run exists for that subject.
 */
async function runFor(issueNumber: number): Promise<Run> {
    const runs = await readRuns(loop.store);
    const run = runs.find((candidate) => candidate.subjectNumber === issueNumber);
    if (run === undefined) {
        throw new Error(`no run is stored for issue ${issueNumber}`);
    }

    return run;
}

/**
 * Read one subject's run state straight from the service.
 *
 * @param issueNumber - Issue the run is about.
 * @returns The state the service holds for it.
 */
async function stateOf(issueNumber: number): Promise<string> {
    const run = await runFor(issueNumber);

    return run.state;
}

/**
 * Read the single row the tab is showing.
 *
 * @param rt - The mounted panel.
 * @returns The one row the fixture put on screen.
 * @throws {Error} When the list held no row.
 */
function onlyRow(rt: PanelRuntime): RunRow {
    const row = rt.state.dispatches.rows[0];
    if (row === undefined) {
        throw new Error('the dispatch list held no row');
    }

    return row;
}

/**
 * Count the retry operations the panel actually put on the wire.
 *
 * @returns How many `POST …/retry` calls the loop's bridge recorded.
 */
function retryPosts(): number {
    return loop.timeline.filter((entry) => entry.endsWith('/retry')).length;
}

/**
 * Claim and reserve one run through a mount's own service bridge.
 *
 * @param issueNumber - Issue to claim for.
 * @returns The claim and the single-use token the reservation issued.
 * @throws {Error} When the claim offered nothing or the reservation refused.
 */
async function claimAndReserve(issueNumber: number): Promise<{
    /** The claim the service answered with. */
    readonly run: Awaited<ReturnType<typeof offerFor>>[number];
    /** The token the reservation issued. */
    readonly token: string;
}> {
    const rt = loop.mount();
    const offered = await offerFor(rt);
    const claim = offered.find((candidate) => candidate.issueNumber === issueNumber);
    if (claim === undefined) {
        throw new Error(NO_OFFER);
    }

    const answer = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: reservePath(claim.correlationId),
        body: JSON.stringify({
            correlationId: claim.correlationId,
            leaseId: claim.lease.leaseId,
            attempt: claim.attempt,
        }),
    });
    if (!answer.ok) {
        throw new Error(`reserve refused: ${answer.code ?? answer.problem}`);
    }

    const parsed = JSON.parse(answer.body) as Record<string, unknown>;
    if (typeof parsed.dispatchToken !== 'string') {
        throw new TypeError('the reservation carried no token');
    }

    return { run: claim, token: parsed.dispatchToken };
}

/**
 * Put one subject's run in a state only the service can put it in.
 *
 * Every state below is reached through the real routes or the real sweep —
 * nothing writes `runs.json` by hand — because a fixture that forged a state
 * would only prove the fixture can forge it.
 *
 * @param input - The issue to move and the state it should reach.
 */
async function driveTo(input: {
    /** Issue whose run moves. */
    readonly issueNumber: number;
    /** The state the service should hold afterwards. */
    readonly state: 'failed' | 'unconfirmed';
}): Promise<void> {
    const { run, token } = await claimAndReserve(input.issueNumber);

    if (input.state === 'unconfirmed') {
        const reserved = await runFor(input.issueNumber);
        if (reserved.reservation === null) {
            throw new Error(NO_DEADLINE);
        }

        await loop.sweepAt(justPast(reserved.reservation.resultDeadlineAt));

        return;
    }

    await post({
        service: loop.service,
        path: bound(ABANDON_PATH, run.correlationId),
        body: {
            correlationId: run.correlationId,
            attempt: run.attempt,
            dispatchToken: token,
            reason: 'the host call never ran',
        },
    });
}

/**
 * Put one subject's run in `blocked:project-missing` the way the panel does.
 *
 * The guard runs panel-side — the service cannot call a host API — so the
 * mount is handed a project snapshot with no registered project, which is
 * exactly the world AC-116 describes.
 *
 * @returns The mounted panel holding the blocked row.
 */
async function mountBlocked(): Promise<PanelRuntime> {
    await loop.enqueue({ issueNumber: BLOCKED_ISSUE });
    const rt = loop.mount({ listProjects: async () => NO_PROJECTS });
    await pollRelay(rt);
    await loadDispatches(rt);

    return rt;
}

describe('AC-114 a waiting dispatch offers no retry and receives none', () => {
    it('refuses locally with the state’s own reason and sends nothing', async () => {
        await loop.enqueue({ issueNumber: WAITING_ISSUE });
        const rt = loop.mount();
        await loadDispatches(rt);
        const row = onlyRow(rt);
        expect(row.state).toBe('pending');

        const affordance = runAffordance(row);
        expect(affordance.action).toBe('none');
        expect(affordance.label).toBeNull();

        selectDispatch(rt, row.id);
        const before = JSON.stringify(rt.state.dispatches.rows);
        await retryRun(rt);

        expect(JSON.stringify(rt.state.dispatches.rows)).toBe(before);
        expect(retryPosts()).toBe(0);
        expect(await stateOf(WAITING_ISSUE)).toBe('pending');
    });
});

describe('AC-115 an unconfirmed dispatch names what to verify before resolving', () => {
    it('offers Resolve, states project, worktree, and attachment, then applies the verdict', async () => {
        await loop.enqueue({ issueNumber: WEDGED_ISSUE });
        await driveTo({ issueNumber: WEDGED_ISSUE, state: 'unconfirmed' });
        expect(await stateOf(WEDGED_ISSUE)).toBe('unconfirmed');

        const rt = loop.mount();
        await loadDispatches(rt);
        const row = onlyRow(rt);
        expect(runAffordance(row).action).toBe('resolve');
        selectDispatch(rt, row.id);

        await resolveNoSession(rt);

        expect(rt.state.dispatches.pendingAction).toBe('resolve-no-session');
        expect(rt.state.dispatches.note).toContain(`project ${row.projectId}`);
        expect(rt.state.dispatches.note).toContain(`worktree ${row.worktreeOption}`);
        expect(rt.state.dispatches.note).toContain(`attachment ${row.attachmentId}`);

        await resolveNoSession(rt);

        expect(rt.state.dispatches.pendingAction).toBeNull();
        expect(onlyRow(rt).state).toBe('pending');
        expect(await stateOf(WEDGED_ISSUE)).toBe('pending');
    });
});

describe('AC-116 a blocked dispatch refuses the retry without spending budget', () => {
    it('renders the guard’s own reason and leaves the attempt where it was', async () => {
        const rt = await mountBlocked();
        const row = onlyRow(rt);
        expect(row.state).toBe('blocked:project-missing');
        expect(runAffordance(row).action).toBe('retry');

        selectDispatch(rt, row.id);
        await retryRun(rt);

        expect(rt.state.dispatches.note).toContain(CAUSE_NOT_CLEARED);
        expect(rt.state.dispatches.note).not.toContain('retry once the cause clears');
        expect(retryPosts()).toBe(1);
        const stored = await runFor(BLOCKED_ISSUE);
        expect(stored.attempt).toBe(row.attempt);
        expect(stored.state).toBe('blocked:project-missing');
    });
});

describe('AC-117 return to waiting states the reset before it happens', () => {
    it('arms with the attempt reset, then applies it through the service', async () => {
        await loop.enqueue({ issueNumber: PARKED_ISSUE });
        const parked = await runFor(PARKED_ISSUE);
        await driveToDeadLetter({
            service: loop.service,
            store: loop.store,
            correlationId: parked.correlationId,
        });
        expect(await stateOf(PARKED_ISSUE)).toBe('dead-lettered');

        const rt = loop.mount();
        await loadDispatches(rt);
        const row = onlyRow(rt);
        expect(runAffordance(row).action).toBe('requeue');
        selectDispatch(rt, row.id);

        await requeueRun(rt);

        expect(rt.state.dispatches.pendingAction).toBe('requeue');
        expect(rt.state.dispatches.note).toContain('attempt count resets to 1');
        expect(onlyRow(rt).state).toBe('dead-lettered');

        await requeueRun(rt);

        expect(onlyRow(rt).state).toBe('pending');
        expect(onlyRow(rt).attempt).toBe(1);
    });
});

describe('AC-118 a refused retry renders the service verdict and changes no row', () => {
    it('leaves the row byte-identical to the last read', async () => {
        const rt = await mountBlocked();
        selectDispatch(rt, onlyRow(rt).id);
        const before = JSON.stringify(rt.state.dispatches.rows);

        await retryRun(rt);

        expect(rt.state.dispatches.note).toContain(CAUSE_NOT_CLEARED);
        expect(rt.state.dispatches.note).not.toBe('');
        expect(JSON.stringify(rt.state.dispatches.rows)).toBe(before);
        expect(rt.state.dispatches.busy).toBe(false);
    });
});

describe('FR-049 one action dispatch path and one correlation id per row', () => {
    it('runs exactly one action when the same row is activated twice', async () => {
        {
            await loop.enqueue({ issueNumber: FAILED_ISSUE });
            await driveTo({ issueNumber: FAILED_ISSUE, state: 'failed' });
            expect(await stateOf(FAILED_ISSUE)).toBe('failed');

            const rt = loop.mount();
            await loadDispatches(rt);
            selectDispatch(rt, onlyRow(rt).id);

            await Promise.all([retryRun(rt), retryRun(rt)]);

            expect(retryPosts()).toBe(1);
            expect(onlyRow(rt).state).toBe('pending');
            expect(rt.state.dispatches.busy).toBe(false);
        }
    });

    it('copies the correlation id from the selected row', async () => {
        {
            await loop.enqueue({ issueNumber: FAILED_ISSUE });
            const rt = loop.mount();
            await loadDispatches(rt);
            const row = onlyRow(rt);

            await copyCorrelationId(rt);

            selectDispatch(rt, row.id);
            await copyCorrelationId(rt);

            expect(rt.state.dispatches.note).toBe(`Correlation id ${row.correlationId} copied.`);
        }
    });

    it('says why the correlation id could not be copied', async () => {
        {
            const clipboard = createTestRuntime(
                fakeHost({ writeClipboard: () => Promise.reject(new Error(CLIPBOARD_FAILURE)) }),
            );
            await loop.enqueue({ issueNumber: FAILED_ISSUE });
            const source = loop.mount();
            await loadDispatches(source);
            clipboard.state.dispatches.rows = source.state.dispatches.rows;
            selectDispatch(clipboard, onlyRow(clipboard).id);

            await copyCorrelationId(clipboard);

            expect(clipboard.state.dispatches.note).toContain(CLIPBOARD_FAILURE);
        }
    });

});
