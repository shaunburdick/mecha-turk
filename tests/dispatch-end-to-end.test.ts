/**
 * One end-to-end dispatch on this branch (003 T-036, the final gate's proof ①).
 *
 * Waves 2–6 left the panel and the service temporarily out of step at
 * intermediate commits, and T-021/T-023 closed that gap; this test is the
 * release candidate's evidence that the loop still holds together against the
 * **real** loopback service and its durable store — not a route table:
 *
 * ```text
 * claim → guards → reserve → host.startSession() → result → acknowledged → verification
 * ```
 *
 * It asserts the ordered timeline the panel produced, the run the service
 * stored, and the audit trail the operator reads back — so a change on either
 * side that quietly stops the other from completing fails here.
 *
 * Offline by construction: a temp store, the loopback service, a host double
 * that records what it was asked to create, and no clock the test waits on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainVerifications } from '../src/agent-verify.ts';
import { pollRelay } from '../src/relay.ts';
import { readRuns, readTrail } from './support/dispatch-corpus.ts';
import { startDispatchLoop } from './support/dispatch-loop.ts';
import { SESSION_ID } from './support/panel.ts';
import type { DispatchLoop } from './support/dispatch-loop.ts';

/** Issue the end-to-end run is about. */
const ISSUE = 90;

/** The runs-history refresh that rides along after a report: a display read. */
const HISTORY_GET = 'GET /v1/events?limit=25';

/** The lifecycle rows a single successful dispatch owes the trail. */
const RUN_TRAIL: readonly string[] = [
    'run.created',
    'dispatch.claimed',
    'dispatch.reserved',
    'dispatch.result',
    'agent.verified',
];

/** The loop under test. */
let loop: DispatchLoop;

beforeEach(async () => {
    loop = await startDispatchLoop();
});

afterEach(async () => {
    await loop.shutdown();
});

describe('T-036 one end-to-end dispatch on this branch', () => {
    it('runs claim → guards → reserve → startSession → result → acknowledged → verification', async () => {
        await loop.enqueue({ issueNumber: ISSUE });
        const rt = loop.mount();
        await pollRelay(rt);
        // The agent read-back is detached from the tick (AC-125); drain it so
        // the order below is asserted rather than raced.
        await drainVerifications(rt);

        const runs = await readRuns(loop.store);
        const run = runs[0];
        if (run === undefined) {
            throw new Error('the end-to-end run was not created');
        }

        // The panel's side, in the order the contract makes non-negotiable:
        // authorization before the host call, the durable record before the
        // report, and the acknowledgement only after the report's own 2xx.
        const steps = loop.timeline.filter((entry) => entry !== HISTORY_GET);
        expect(steps).toEqual([
            'GET /v1/events/pending',
            `POST /v1/events/${run.correlationId}/reserve`,
            `startSession:${run.correlationId}`,
            'record',
            `POST /v1/events/${run.correlationId}/dispatched`,
            'ack',
            'GET /v1/config',
            `openSession:${SESSION_ID}`,
            `POST /v1/events/${run.correlationId}/verification`,
        ]);

        // The service's side: exactly one session for the run, a terminal
        // state, the recorded session, and a matching read-back.
        expect(loop.sessions).toEqual([run.correlationId]);
        expect(run.state).toBe('dispatched');
        expect(run.session?.sessionId).toBe(SESSION_ID);
        expect(run.verification).toMatchObject({ observedAgent: 'project-manager', ok: true });

        // And the trail an operator reconstructs it from, every row on the
        // run's own correlation identifier (FR-061, FR-062).
        const trail = await readTrail(loop.store);
        const dispatchRows = trail.filter((row) => row.entity.kind === 'run');
        expect(dispatchRows.map((row) => row.eventType)).toEqual(RUN_TRAIL);
        for (const row of trail) {
            expect(row.correlationId).toBe(run.correlationId);
        }
    });
});
