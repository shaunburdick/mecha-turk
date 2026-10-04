/**
 * Correlation and visibility (003 T-032: AC-115, AC-116, AC-117, AC-118,
 * AC-119, SC-104, SC-105; FR-053, FR-060 – FR-064).
 *
 * US4's independent test is the one this suite encodes: take a run that has
 * been through an abandonment and a retry, copy its correlation identifier, and
 * reconstruct its history — why it was created, who dispatched it, whether a
 * session exists, and why it ended where it did — **from the product, under
 * that identifier alone, with no file access** (SC-105). Three properties make
 * that possible, and each is asserted from outside the loopback service:
 *
 * 1. **Order and identity.** One `GET /v1/audit?correlationId=` returns every
 *    lifecycle row in `seq` order, every row on the run's own identifier —
 *    never a freshly minted uuid (FR-062, AC-116).
 * 2. **Reconstruction.** Reading the ordered rows against `## Audit
 *    Vocabulary`'s own hop → state mapping reproduces the chain the run
 *    actually walked, ending at the state `GET /v1/events` reports, and the
 *    rows that record a transition with a cause name the prior state and the
 *    cause (`details.priorState`, `details.reason`) — SC-104's content.
 * 3. **Honesty when the trail cannot be written.** A failed append never rolls
 *    a durable state change back: the panel is told `auditWritten: false`, its
 *    visible warning names the run, and the service's structured log names it
 *    too (FR-063, AC-119).
 *
 * Offline: temp directories, the real loopback service, an injected sweep — no
 * host, no PAT, no network, no sleeping.
 *
 * 004 adds the fourth property, on the same route: the correlation-filtered
 * read must also answer *which tiers produced this run* (`promptSources`,
 * FR-087) while the written `audit.ndjson` carries no tier's text at all
 * (FR-050, FR-053) — asserted here as a byte scan of the file itself.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainVerifications } from '../src/agent-verify.ts';
import { parsePendingBody } from '../src/claim-service.ts';
import { pollRelay } from '../src/relay.ts';
import { reserveRun } from '../src/relay-gates.ts';
import { EVENTS_PENDING_PATH, serviceGet } from '../src/service-calls.ts';
import { AUDIT_FILE, appendAudit } from '../service/audit.ts';
import { RUNS_FILE } from '../service/poll/runs.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
import { ABANDON_PATH, RESERVE_PATH } from '../service/routes/dispatch.ts';
import { RETRY_PATH } from '../service/routes/run-ops.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { Run } from '../service/poll/runs-types.ts';
import { byText } from './support/sort.ts';
import { bound, expectStatus, post, readRun, readRuns } from './support/dispatch-corpus.ts';
import { BINDING_ID } from './support/fixture-enqueue.ts';
import { offerFor, startDispatchLoop } from './support/dispatch-loop.ts';
import { SESSION_ID } from './support/panel.ts';
import type { DispatchLoop } from './support/dispatch-loop.ts';

/** Issue the reconstructed run is about. */
const ISSUE = 61;

/** Cause the abandoned attempt reports, asserted verbatim in the trail. */
const ABANDON_REASON = 'the host call never ran';

/** Cause the operator reports when retrying, asserted verbatim in the trail. */
const RETRY_CAUSE = 'the host is healthy again';

/** Terminal state a successful dispatch leaves the run in. */
const DISPATCHED_STATE = 'dispatched';

/** The row a reservation writes (spec `## Audit Vocabulary`). */
const RESERVED_EVENT = 'dispatch.reserved';

/** The row a reported outcome writes (spec `## Audit Vocabulary`). */
const RESULT_EVENT = 'dispatch.result';

/** Issue the prompted run this suite dispatches (004 FR-050, FR-087). */
const PROMPT_ISSUE = 62;

/**
 * The binding tier's text, as two independently scannable lines.
 *
 * Each line is scanned for **on its own**: a leaked row would carry the text
 * JSON-escaped, so the joined string would never match the file even with
 * every byte of it present in it.
 */
const TIER_SENTINEL_LINES: readonly string[] = [
    'SENTINEL TIER ALPHA 4f9c: this line must never reach a row',
    'SENTINEL TIER BETA 8a13: this line must never reach a row',
];

/** The tier text exactly as the run's snapshot stores it (FR-080: one block). */
const TIER_SENTINEL = TIER_SENTINEL_LINES.join('\n');

/**
 * The lifecycle chain one run's trail walks: event type → the state
 * `## Dispatch State Model` leaves the run in after it, one entry per hop.
 *
 * Quoted from the specification's own `## Audit Vocabulary` and correlation
 * table, not from the implementation: this table is what makes a trail
 * reconstructable without reading the code that wrote it (AC-115, SC-104), and
 * it is the single source for both the order this suite expects and the chain
 * it derives from the answer. Two hops repeat because the run was claimed,
 * abandoned, retried, and claimed again — the trail owes both of them.
 */
const LIFECYCLE_CHAIN: readonly (readonly [string, string])[] = [
    ['run.created', 'pending'],
    ['dispatch.claimed', 'claimed'],
    [RESERVED_EVENT, 'starting'],
    ['dispatch.abandoned', 'failed'],
    ['dispatch.retry', 'pending'],
    ['dispatch.claimed', 'claimed'],
    [RESERVED_EVENT, 'starting'],
    [RESULT_EVENT, DISPATCHED_STATE],
    ['agent.verified', DISPATCHED_STATE],
];

/** The lifecycle rows one run's trail owes, in the order they were written. */
const LIFECYCLE_ORDER: readonly string[] = LIFECYCLE_CHAIN.map(([eventType]) => eventType);

/** State each lifecycle row leaves the run in, for the derived chain. */
const STATE_AFTER: Readonly<Record<string, string>> = Object.fromEntries(LIFECYCLE_CHAIN);

/** Event types this suite treats as rows that are not about a work unit. */
const NON_RUN_EVENTS: ReadonlySet<string> = new Set(['consent', 'account.verified']);

/** The running loop every case drives. */
let loop: DispatchLoop;

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    loop = await startDispatchLoop();
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    await loop.shutdown();
});

/**
 * Read one correlation identifier's rows through the product's own route.
 *
 * @param correlationId - Run identifier to filter on.
 * @returns Every row the answer carried, in the order it arrived.
 * @throws {Error} When the route answers anything but `200`.
 */
async function auditFor(correlationId: string): Promise<readonly AuditEntry[]> {
    const path = `${AUDIT_PATH}?correlationId=${encodeURIComponent(correlationId)}`;
    const response = await loop.service.call(path);
    if (response.status !== 200) {
        throw new Error(`the audit read answered ${response.status}, expected 200`);
    }

    const body = await response.json() as { entries?: unknown };
    if (!Array.isArray(body.entries)) {
        throw new TypeError('the audit read carried no entries member');
    }

    return body.entries as AuditEntry[];
}

/**
 * Read the whole trail, unfiltered, to see what the filter left behind.
 *
 * @returns Every retained row, in `seq` order.
 * @throws {Error} When the route answers anything but `200`.
 */
async function unfilteredAudit(): Promise<readonly AuditEntry[]> {
    const response = await loop.service.call(AUDIT_PATH);
    if (response.status !== 200) {
        throw new Error(`the audit read answered ${response.status}, expected 200`);
    }

    const body = await response.json() as { entries?: unknown };
    if (!Array.isArray(body.entries)) {
        throw new TypeError('the audit read carried no entries member');
    }

    return body.entries as AuditEntry[];
}

/** Claim, reserve, and abandon without a host call, as a dying panel would. */
async function claimReserveAbandon(): Promise<string> {
    const claimAnswer = await offerFor(loop.mount());
    const offered = claimAnswer[0];
    if (offered === undefined) {
        throw new Error('the claim offered nothing');
    }

    const reserved = await post({
        service: loop.service,
        path: bound(RESERVE_PATH, offered.correlationId),
        body: { correlationId: offered.correlationId, leaseId: offered.lease.leaseId, attempt: offered.attempt },
    });
    expectStatus({ step: 'reserve', answer: reserved, status: 200 });
    const token = reserved.json.dispatchToken;
    if (typeof token !== 'string') {
        throw new TypeError('the reservation carried no token');
    }

    const abandoned = await post({
        service: loop.service,
        path: bound(ABANDON_PATH, offered.correlationId),
        body: {
            correlationId: offered.correlationId,
            attempt: offered.attempt,
            dispatchToken: token,
            reason: ABANDON_REASON,
        },
    });
    expectStatus({ step: 'abandon', answer: abandoned, status: 200 });

    return offered.correlationId;
}

/**
 * Drive one run through creation, claim, reservation, abandonment, retry, and
 * an ordinary panel dispatch with its read-back.
 *
 * @returns The run as it stands when the trail is complete.
 */
async function driveLifecycle(): Promise<Run> {
    await loop.enqueue({ issueNumber: ISSUE });
    const correlationId = await claimReserveAbandon();

    const retried = await post({
        service: loop.service,
        path: bound(RETRY_PATH, correlationId),
        body: { correlationId, attempt: 1, causeCleared: true, causeReport: RETRY_CAUSE },
    });
    expectStatus({ step: 'retry', answer: retried, status: 200 });

    const rt = loop.mount();
    await pollRelay(rt);
    await drainVerifications(rt);

    return await readRun(loop.store, correlationId);
}

describe('T-032 one run reconstructs from its correlation identifier alone', () => {
    it('returns every lifecycle row in order, on the run’s own id, ending where the run stands', async () => {
        {
            const run = await driveLifecycle();
            expect(run.state).toBe(DISPATCHED_STATE);

            const rows = await auditFor(run.correlationId);

            // In order and complete: `seq` ascends, never repeats, never gaps
            // (SC-104's "reconstructable ... with prior state, new state, reason").
            const seqs = rows.map((row) => row.seq);
            expect(seqs.length).toBeGreaterThan(LIFECYCLE_ORDER.length);
            expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
            expect(new Set(seqs).size).toBe(seqs.length);

            // The correlation identifier is the run's, byte-identically, on every
            // row — the specific defect 003 closed (FR-062, AC-116).
            for (const row of rows) {
                expect(row.correlationId).toBe(run.correlationId);
            }

            // The chain itself, in the order the product answers it.
            const lifecycle = rows.filter((row) => Object.hasOwn(STATE_AFTER, row.eventType));
            expect(lifecycle.map((row) => row.eventType)).toEqual(LIFECYCLE_ORDER);
            for (const row of lifecycle) {
                expect(row.entity).toEqual({ kind: 'run', id: run.correlationId });
            }

            // Reading that chain against the vocabulary ends at the state the run
            // history reports — the reconstruction is faithful, not merely present.
            const chain = lifecycle.map((row) => STATE_AFTER[row.eventType]);
            expect(chain.at(-1)).toBe(run.state);
            expect(run.session?.sessionId).toBe(SESSION_ID);

            // The rows that record a transition with a cause name it: prior state,
            // the attempt before and after, and the operator's own words.
            const retry = lifecycle.find((row) => row.eventType === 'dispatch.retry');
            expect(retry?.details).toMatchObject({
                priorState: 'failed',
                attemptBefore: 1,
                attemptAfter: 2,
                causeReport: RETRY_CAUSE,
            });
            const abandoned = lifecycle.find((row) => row.eventType === 'dispatch.abandoned');
            expect(abandoned?.decision).toBe('no-session');
            expect(abandoned?.details).toMatchObject({ reason: ABANDON_REASON });
            const result = lifecycle.find((row) => row.eventType === RESULT_EVENT);
            expect(result?.decision).toBe('dispatched');
            expect(result?.details).toMatchObject({ sessionId: SESSION_ID });
        }
    });

    it('excludes rows that are not about a run while keeping their own identifiers', async () => {
        {
            await appendAudit(loop.store, {
                eventType: 'consent',
                actorSource: 'panel',
                entity: { kind: 'service', id: 'mecha-turk' },
                reason: 'service capability granted',
            });
            await appendAudit(loop.store, {
                eventType: 'account.verified',
                actorSource: 'service',
                entity: { kind: 'account', id: '77331' },
                reason: 'credential verified',
            });
            const run = await driveLifecycle();

            const filtered = await auditFor(run.correlationId);
            const types = filtered.map((row) => row.eventType);
            expect(types.filter((type) => NON_RUN_EVENTS.has(type))).toEqual([]);
            // Forward traceability still holds: the run's own detections match it
            // (FR-050's correlation table), so a scan observation is traceable
            // forwards into the run that absorbed it (AC-118).
            expect(types).toContain('delivery.detected');

            const all = await unfilteredAudit();
            const foreign = all.filter((row) => NON_RUN_EVENTS.has(row.eventType));
            expect(foreign).toHaveLength(NON_RUN_EVENTS.size);
            for (const row of foreign) {
                expect(row.correlationId).not.toBe(run.correlationId);
                expect(row.entity.kind).not.toBe('run');
            }
        }
    });

});

describe('T-032 an unwritable trail never rolls back a state change (AC-119, FR-063)', () => {
    it('keeps the state, reports auditWritten false, and names the run in panel and log', async () => {
        await loop.enqueue({ issueNumber: ISSUE });

        // The trail becomes unwritable mid-dispatch: every append to the audit
        // file fails from here on, while every state write still succeeds.
        const { store } = loop;
        const appendable = store.appendLine.bind(store);
        store.appendLine = async (path: string, entry: unknown): Promise<void> => {
            if (path === AUDIT_FILE) {
                throw new Error('simulated audit append failure');
            }

            await appendable(path, entry);
        };

        const rt = loop.mount();
        const claimed = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: EVENTS_PENDING_PATH });
        if (!claimed.ok) {
            throw new Error(`the claim failed: ${claimed.problem}`);
        }
        const offer = parsePendingBody(claimed.body);
        const offered = offer?.runs[0];
        if (offer === null || offered === undefined) {
            throw new Error('the claim answer could not be read');
        }
        // The answer tells the panel its leases are durable and its rows are
        // not — the member FR-063 exists for.
        expect(offer.auditWritten).toBe(false);

        const reserved = await reserveRun(rt, offered);
        expect(reserved.kind).toBe('reserved');
        expect(reserved.kind === 'reserved' ? reserved.reservation.auditWritten : null).toBe(false);

        // The state change stands: no rollback, no half-applied run, and no
        // `dispatch.reserved` row pretending the trail has what it does not.
        const run = await readRun(loop.store, offered.correlationId);
        expect(run.state).toBe('starting');
        const rows = await auditFor(run.correlationId);
        expect(rows.filter((row) => row.eventType === RESERVED_EVENT)).toHaveLength(0);

        // The panel's visible warning names the run (AC-119's "surfaces"), and
        // it says what is missing rather than implying traceability.
        expect(rt.state.bindings.note).toContain(run.correlationId);

        // The service's own structured log names the run too.
        const warnings = loop.service.logLines
            .filter((line) => line.includes('dispatch operation could not record its row'));
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.some((line) => line.includes(run.correlationId))).toBe(true);
    });
});

describe('004 the dispatch rows name the prompt sources without its text (FR-050, FR-087)', () => {
    it('answers both rows with presence, fingerprint, length, and sources under the run’s id', async () => {
        // The run snapshots the sentinel at enqueue — the one place FR-053
        // allows the text to live — so the file scan below has something to
        // find and cannot pass by having nothing to search for.
        await loop.enqueue({ issueNumber: PROMPT_ISSUE, prompt: TIER_SENTINEL });
        const rt = loop.mount();
        await pollRelay(rt);
        await drainVerifications(rt);

        const runs = await readRuns(loop.store);
        expect(runs).toHaveLength(1);
        const [run] = runs;
        if (run === undefined) {
            throw new Error('the prompted run was not stored');
        }

        const snapshot = run.prompt;
        if (snapshot === null) {
            throw new Error('the prompted run stored no prompt snapshot');
        }

        // The correlation-filtered read is the product's own route, so what it
        // answers is what an operator would reconstruct from the identifier
        // alone (SC-124, AC-117).
        const rows = await auditFor(run.correlationId);
        const sent = rows.filter((row) =>
            row.eventType === RESERVED_EVENT || row.eventType === RESULT_EVENT);
        expect(sent.map((row) => row.eventType).toSorted(byText))
            .toEqual([RESERVED_EVENT, RESULT_EVENT].toSorted(byText));

        for (const row of sent) {
            expect(row.correlationId, `${row.eventType} correlation id`).toBe(run.correlationId);
            expect(row.entity).toEqual({ kind: 'run', id: run.correlationId });
            const { details } = row;
            expect(details.bindingId, `${row.eventType} bindingId`).toBe(BINDING_ID);
            expect(details.promptPresent, `${row.eventType} promptPresent`).toBe(true);
            expect(details.promptFingerprint, `${row.eventType} promptFingerprint`)
                .toBe(snapshot.fingerprint);
            expect(details.promptLength, `${row.eventType} promptLength`).toBe(snapshot.length);
            // Sources are the snapshot's own list — this run stacked exactly
            // the binding tier, so the ordered answer is exactly that.
            expect(details.promptSources, `${row.eventType} promptSources`).toEqual(['binding']);
            expect(details.promptSources, `${row.eventType} promptSources`).toEqual(snapshot.sources);
        }

        // The written file, scanned byte for byte: `runs.json` holding the
        // sentinel is what proves this scan can bite, and `audit.ndjson` —
        // every retained row of it, not only this run's — must not hold a
        // single line of it.
        const runsBytes = await readFile(join(loop.service.dataDir, RUNS_FILE), 'utf8');
        for (const line of TIER_SENTINEL_LINES) {
            expect(runsBytes, 'the sentinel was never stored, so the scan proves nothing').toContain(line);
        }

        const auditBytes = await readFile(join(loop.service.dataDir, AUDIT_FILE), 'utf8');
        expect(auditBytes, 'the trail holds no rows for the scan').toContain(run.correlationId);
        expect(auditBytes, 'promptSources never reached the written trail').toContain('"promptSources"');
        for (const line of TIER_SENTINEL_LINES) {
            expect(auditBytes, `audit.ndjson carried a tier's text (${line})`).not.toContain(line);
        }
    });
});
