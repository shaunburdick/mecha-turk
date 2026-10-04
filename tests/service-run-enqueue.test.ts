/** Durable run allocation, transitions, and coalescing (003 T-003/T-006). */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_FILE, readAuditEntries } from '../service/audit.ts';
import { createLogger } from '../service/log.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import {
    EVENTS_FILE,
    createEvent,
    enqueueEvents,
    readEvents,
} from '../service/poll/events.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import {
    MAX_TERMINAL_RUNS,
    MAX_SOURCE_REFERENCES,
    RUNS_FILE,
    claimRun,
    emptyRunsDocument,
    readRunsDocument,
    writeRunsDocument,
} from '../service/poll/runs.ts';
import { openStore } from '../service/store/index.ts';
import type { JsonReadResult, ServiceStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { Run, RunsDocument } from '../service/poll/runs-types.ts';
import { writeOpenBinding } from './support/binding-fixture.ts';

const STAMP = '2026-09-28T12:00:00.000Z';
const HOLDER = 'panel-mount-1';
// The two legal lease shapes `parseLease` accepts (T-040e): a panel claim
// mints `lse-<24 hex>`, adoption mints `migration-<correlation id>`.
const LEASE_ID = `lse-${'a'.repeat(24)}`;
const COMPETING_LEASE_ID = `lse-${'b'.repeat(24)}`;
const SESSION_ID = 'ses_once';
const RUN_SUBJECT_KEY = 'github|77331|acme/widget|issue|900';
const ISSUE_URL_PREFIX = 'https://github.com/acme/widget/issues/';
const SUBJECT_ISSUE = 22;
const DELIVERY_DETECTED = 'delivery.detected';
const RUN_CREATED_EVENT = 'run.created';
const RUN_COALESCED_EVENT = 'run.coalesced';
const CLAIM_EXPIRY = '2026-09-28T12:05:00.000Z';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-run-enqueue-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    // The gate reads `bindings.json` at authorization and denies when it cannot
    // (003 FR-076); this suite's single reserve needs the open policy so the
    // assertion stays about the enqueue path (002 FR-047).
    await writeOpenBinding({ store, bindingId: 'bnd-run-tests' });
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

/** Build an assignment fixture for one issue. */
function assignment(issueNumber: number): EventSnapshot {
    return {
        bindingId: 'bnd-run-tests',
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `${ISSUE_URL_PREFIX}${issueNumber}`,
            issueBodyExcerpt: 'body excerpt',
        },
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** Build a comment mention fixture, with a unique deterministic delivery id. */
function commentMention(issueNumber: number, commentId: number): EventSnapshot {
    return {
        ...assignment(issueNumber),
        kind: 'mention',
        origin: 'comment',
        commentId,
        actorLogin: 'alice',
        actorAttribution: 'direct',
        triggerNote: `comment ${commentId} mention`,
    };
}

/** Build an issue-body mention fixture with the assignment's same subject. */
function bodyMention(issueNumber: number): EventSnapshot {
    return {
        ...assignment(issueNumber),
        kind: 'mention',
        origin: 'body',
        actorLogin: 'alice',
        actorAttribution: 'direct',
        triggerNote: 'body mention',
    };
}

/** Enqueue a set of snapshots and return the linked rows. */
async function enqueue(snapshots: readonly EventSnapshot[]) {
    return await enqueueEvents({
        store,
        log: LOGGER,
        incoming: snapshots.map(createEvent),
    });
}

/** Create one pending run fixture through the same pure writer as production. */
function runFixture(): Run {
    const row = createEvent(assignment(900));
    const result = applyEnqueue({ document: emptyRunsDocument(), deliveries: [row], now: STAMP });
    const run = result.created[0];
    if (run === undefined) {
        throw new Error('run fixture was not created');
    }

    return run;
}

describe('T-006 run-aware enqueue', () => {
    it('coalesces assignment and body mention from one scan and correlates every audit row', async () => {
        {
            const added = await enqueue([assignment(12), bodyMention(12)]);
            const document = await readRunsDocument({ store, log: LOGGER });
            const audits = await readAuditEntries(store);

            expect(document.runs).toHaveLength(1);
            expect(document.runs[0]?.sourceReferences.map((reference) => reference.kind)).toEqual([
                'assignment',
                'mention',
            ]);
            expect(added).toHaveLength(2);
            expect(added.every((event) => event.runCorrelationId === document.runs[0]?.correlationId)).toBe(true);
            expect(audits.map((entry) => entry.eventType)).toEqual([
                RUN_CREATED_EVENT,
                RUN_COALESCED_EVENT,
                DELIVERY_DETECTED,
                DELIVERY_DETECTED,
            ]);
            expect(audits.every((entry) => entry.correlationId === document.runs[0]?.correlationId)).toBe(true);
        }
    });

    it('joins a later-scan comment to the existing non-terminal run', async () => {
        {
            await enqueue([assignment(14)]);
            await enqueue([commentMention(14, 42)]);

            const document = await readRunsDocument({ store, log: LOGGER });
            const queue = await readEvents({ store, log: LOGGER });

            expect(document.runs).toHaveLength(1);
            expect(document.runs[0]?.sourceReferences).toHaveLength(2);
            expect(queue.map((event) => event.runCorrelationId)).toEqual([
                document.runs[0]?.correlationId,
                document.runs[0]?.correlationId,
            ]);
        }
    });

    it('opens the next ordinal after the prior run has a recorded session', async () => {
        {
            const [delivery] = await enqueue([assignment(16)]);
            const first = await readRunsDocument({ store, log: LOGGER });
            const correlationId = first.runs[0]?.correlationId;
            if (correlationId === undefined) {
                throw new Error('first run missing');
            }

            const claim = await claimRun({
                store,
                log: LOGGER,
                correlationId,
                holder: HOLDER,
                leaseId: LEASE_ID,
                issuedAt: STAMP,
                expiresAt: CLAIM_EXPIRY,
                now: STAMP,
            });
            expect(claim.status).toBe('applied');
            // T-043g: the routed authorization path is the only way to authorize or
            // spend an attempt — the un-routed second minting site this suite used
            // to reach has been deleted, so the fixture drives the same modules the
            // routes do.
            const reservation = await reserveDispatch({
                store,
                log: LOGGER,
                correlationId,
                leaseId: LEASE_ID,
                attempt: 1,
                now: STAMP,
            });
            if (reservation.status !== 'applied') {
                throw new Error(`reserve did not apply: ${reservation.status}`);
            }

            const result = await reportDispatch({
                store,
                log: LOGGER,
                correlationId,
                dispatchToken: reservation.dispatchToken,
                attempt: 1,
                operation: 'result',
                outcome: { attemptOutcome: 'dispatched', sessionId: 'ses_existing', reason: null },
                now: STAMP,
            });
            expect(result.status).toBe('applied');

            const second = await enqueue([commentMention(16, 4_242)]);
            const document = await readRunsDocument({ store, log: LOGGER });

            expect(delivery?.runCorrelationId).toBe(first.runs[0]?.correlationId);
            expect(second[0]?.runCorrelationId).not.toBe(delivery?.runCorrelationId);
            expect(document.runs.map((run) => run.ordinal)).toEqual([0, 1]);
        }
    });

    it('heals a crash after runs.json by joining the redetected delivery once', async () => {
        {
            let failQueueWrite = true;
            const interruptedStore: ServiceStore = {
                ...store,
                writeJson: async (path, value) => {
                    if (path === 'events.json' && failQueueWrite) {
                        failQueueWrite = false;
                        throw new Error('simulated queue write interruption');
                    }

                    await store.writeJson(path, value);
                },
            };
            const event = createEvent(assignment(18));

            await expect(enqueueEvents({ store: interruptedStore, log: LOGGER, incoming: [event] })).rejects.toThrow(
                'simulated queue write interruption',
            );
            const recovered = await enqueueEvents({ store, log: LOGGER, incoming: [event] });
            const document = await readRunsDocument({ store, log: LOGGER });
            const audits = await readAuditEntries(store);

            expect(recovered).toHaveLength(1);
            expect(document.runs).toHaveLength(1);
            expect(document.runs[0]?.sourceReferences).toHaveLength(1);
            expect(audits.map((entry) => entry.eventType)).toEqual([
                RUN_CREATED_EVENT,
                RUN_COALESCED_EVENT,
                DELIVERY_DETECTED,
            ]);
        }
    });

    it('serializes concurrent trigger deliveries on the shared queue/run chain', async () => {
        {
            const scans = Array.from({ length: 10 }, (_unused, index) => enqueue([commentMention(20, index + 1)]));
            const concurrentClaim = claimPendingRuns({ store, log: LOGGER, holder: HOLDER, now: STAMP });
            const [results, claimed] = await Promise.all([Promise.all(scans), concurrentClaim]);
            const document = await readRunsDocument({ store, log: LOGGER });

            expect(claimed.runs).toHaveLength(1);
            expect(claimed.runs[0]?.correlationId).toBe(document.runs[0]?.correlationId);
            expect(claimed.runs[0]?.sourceReferences).toHaveLength(10);
            expect(results.reduce((total: number, rows: readonly unknown[]) => total + rows.length, 0)).toBe(10);
            expect(document.runs).toHaveLength(1);
            expect(document.runs[0]?.referenceCount).toBe(10);
            expect(document.runs[0]?.sourceReferences).toHaveLength(10);
            // The claim leases the run it was offered, so it is no longer claimable.
            const again = await claimPendingRuns({ store, log: LOGGER, holder: HOLDER, now: STAMP });
            expect(again.runs).toEqual([]);
        }
    });

    it('retains every reference up to the cap, then counts the overflow visibly', async () => {
        {
            // One assignment opens the run; 199 comment mentions fill it exactly.
            await enqueue([assignment(SUBJECT_ISSUE), ...Array.from(
                { length: MAX_SOURCE_REFERENCES - 1 },
                (_unused, index) => commentMention(SUBJECT_ISSUE, index + 1),
            )]);
            const filled = await readRunsDocument({ store, log: LOGGER });
            const full = filled.runs[0];
            const lastRetained = full?.sourceReferences.at(-1);

            expect(full?.sourceReferences).toHaveLength(MAX_SOURCE_REFERENCES);
            expect(full?.referenceCount).toBe(MAX_SOURCE_REFERENCES);
            expect(full?.referencesNotRetained).toBe(0);
            expect(full?.referencesTruncated).toBe(false);
            // FR-013 detail is complete on the reference the cap last accepted,
            // and since 002 v1.11.0 that includes the two actor members the gate
            // judges (FR-043, FR-044) — a retained reference a gate could not
            // attribute would be a reference it has to refuse.
            expect(lastRetained).toEqual({
                deliveryId: `evt-acme~widget~22~77331~mention~${MAX_SOURCE_REFERENCES - 1}`,
                kind: 'mention',
                origin: `comment:${MAX_SOURCE_REFERENCES - 1}`,
                sourceUrl: `${ISSUE_URL_PREFIX}${SUBJECT_ISSUE}`,
                detectedAt: STAMP,
                presentAtAuthorization: true,
                actorLogin: 'alice',
                actorAttribution: 'direct',
            });

            // The 201st joining trigger still joins, and says it was not retained.
            const overflow = await enqueue([commentMention(22, MAX_SOURCE_REFERENCES + 1)]);
            const document = await readRunsDocument({ store, log: LOGGER });
            const capped = document.runs[0];
            const audits = await readAuditEntries(store);
            const coalesced = audits.filter((entry) => entry.eventType === 'run.coalesced').at(-1);

            expect(overflow).toHaveLength(1);
            expect(overflow[0]?.runCorrelationId).toBe(capped?.correlationId);
            expect(capped?.sourceReferences).toHaveLength(MAX_SOURCE_REFERENCES);
            expect(capped?.referenceCount).toBe(MAX_SOURCE_REFERENCES + 1);
            expect(capped?.referencesNotRetained).toBe(1);
            expect(capped?.referencesTruncated).toBe(true);
            expect(capped?.sourceReferences.map((reference) => reference.deliveryId))
                .not.toContain(`evt-acme~widget~22~77331~mention~${MAX_SOURCE_REFERENCES + 1}`);
            // FR-016: the overflow delivery is still audited, naming the marker.
            expect(coalesced?.details).toMatchObject({
                deliveryId: `evt-acme~widget~22~77331~mention~${MAX_SOURCE_REFERENCES + 1}`,
                retained: false,
                referencesNotRetained: 1,
            });
            expect(audits.filter((entry) => entry.eventType === DELIVERY_DETECTED)).toHaveLength(
                MAX_SOURCE_REFERENCES + 1
            );
        }
    });


    it('refuses to read a run whose stored count cannot be reconciled (T-038)', async () => {
        await enqueue([assignment(23), commentMention(23, 9)]);
        const document = await readRunsDocument({ store, log: LOGGER });
        const run = document.runs[0];
        if (run === undefined) {
            throw new Error('run fixture missing');
        }

        // A hand-edited or truncated file claiming more loss than the retained
        // list can account for is quarantined rather than read (constitution II);
        // the refusal is seen by the next process to open the store.
        await store.writeJson(RUNS_FILE, { ...document, runs: [{ ...run, referencesNotRetained: 5 }] });
        const restarted = await openStore({ dataDir });

        await expect(readRunsDocument({ store: restarted, log: LOGGER })).rejects.toThrow('run document is unreadable');
    });
});

describe('T-003 run transition invariants', () => {
    it('permits one lease and one session for a run, refusing competing mutations', async () => {
        {
            const fixture = runFixture();
            await writeRunsDocument({
                store,
                log: LOGGER,
                document: {
                    ...emptyRunsDocument(),
                    subjects: { [RUN_SUBJECT_KEY]: 1 },
                    runs: [fixture],
                },
            });
            const claimInputs = {
                store,
                log: LOGGER,
                correlationId: fixture.correlationId,
                holder: HOLDER,
                leaseId: LEASE_ID,
                issuedAt: STAMP,
                expiresAt: CLAIM_EXPIRY,
                now: STAMP,
            };

            const firstClaim = claimRun(claimInputs);
            const competingClaim = claimRun({ ...claimInputs, leaseId: COMPETING_LEASE_ID });
            const claims = await Promise.all([firstClaim, competingClaim]);
            expect(claims.filter((result) => result.status === 'applied')).toHaveLength(1);
            expect(claims.filter((result) => result.status === 'refused')).toHaveLength(1);

            // T-043g: authorization and its spend are the routed modules' alone, so
            // the concurrency fixture drives them rather than the deleted store-level
            // wrappers. Exactly one reserve must survive — the loser answers
            // `already-reserved` against the winner's durable reservation.
            const reserveOnce = () => reserveDispatch({
                store,
                log: LOGGER,
                correlationId: fixture.correlationId,
                leaseId: LEASE_ID,
                attempt: 1,
                now: STAMP,
            });
            const reservations = await Promise.all([reserveOnce(), reserveOnce()]);
            expect(reservations.filter((result) => result.status === 'applied')).toHaveLength(1);
            expect(reservations.filter((result) => result.status === 'refused')).toHaveLength(1);
            const [authorized] = reservations.filter((result) => result.status === 'applied');
            if (authorized === undefined) {
                throw new Error('exactly one concurrent reserve must apply');
            }

            // Two identical reports likewise: one applies, and the chain serializes
            // the second into FR-025's idempotent repeat of the outcome already
            // recorded — never a second application (NFR-102, contract invariant 3).
            const reportOnce = () => reportDispatch({
                store,
                log: LOGGER,
                correlationId: fixture.correlationId,
                dispatchToken: authorized.dispatchToken,
                attempt: 1,
                operation: 'result',
                outcome: { attemptOutcome: 'dispatched', sessionId: SESSION_ID, reason: null },
                now: STAMP,
            });
            const results = await Promise.all([reportOnce(), reportOnce()]);
            expect(results.filter((result) => result.status === 'applied')).toHaveLength(1);
            expect(results.filter((result) => result.status === 'duplicate')).toHaveLength(1);
            const final = await readRunsDocument({ store, log: LOGGER });
            expect(final.runs[0]?.session?.sessionId).toBe(SESSION_ID);
            expect(final.runs[0]?.attempts).toHaveLength(1);
            expect(final.runs[0]?.attempts[0]?.outcome).toBe('dispatched');
            expect(final.runs[0]?.attempts[0]?.dispatchToken).toMatch(/^dtk-[0-9a-f]{32}$/);
        }
    });

    it('never reuses an ordinal after terminal-run retention evicts old rows', async () => {
        {
            let document = emptyRunsDocument();
            for (let ordinal = 0; ordinal < 501; ordinal += 1) {
                const created = applyEnqueue({
                    document,
                    deliveries: [createEvent(assignment(24))],
                    now: STAMP,
                });
                document = {
                    ...created.document,
                    runs: created.document.runs.map((run) => ({
                        ...run,
                        state: 'dispatched',
                        stateReason: 'session created',
                    })),
                };
            }

            await writeRunsDocument({ store, log: LOGGER, document });
            const retained = await readRunsDocument({ store, log: LOGGER });
            const next = applyEnqueue({
                document: retained,
                deliveries: [createEvent(commentMention(24, 777))],
                now: STAMP,
            });

            expect(retained.runs).toHaveLength(500);
            expect(retained.subjects['github|77331|acme/widget|issue|24']).toBe(501);
            expect(next.created[0]?.ordinal).toBe(501);
        }
    });

});

describe('T-037 durable run creation audit intent', () => {
    it('recovers a creation audit missed after the run and delivery writes', async () => {
        {
            let failAuditAppend = true;
            const interruptedStore: ServiceStore = {
                ...store,
                appendLine: async (path, value) => {
                    if (path === AUDIT_FILE && failAuditAppend) {
                        failAuditAppend = false;
                        throw new Error('simulated process interruption before audit append');
                    }

                    await store.appendLine(path, value);
                },
            };

            await enqueueEvents({
                store: interruptedStore,
                log: LOGGER,
                incoming: [createEvent(assignment(44))],
            });
            const auditBeforeRestart = await readAuditEntries(store);
            expect(auditBeforeRestart.filter((entry) => entry.eventType === RUN_CREATED_EVENT)).toHaveLength(0);

            const restartedStore = await openStore({ dataDir });
            const recovered = await readRunsDocument({ store: restartedStore, log: LOGGER });
            const audits = await readAuditEntries(restartedStore);

            expect(recovered.auditIntents).toEqual([]);
            expect(audits.filter((entry) => entry.eventType === RUN_CREATED_EVENT)).toHaveLength(1);
            expect(audits.filter((entry) => entry.eventType === RUN_CREATED_EVENT)[0]?.correlationId)
                .toBe(recovered.runs[0]?.correlationId);
        }
    });

    it('does not duplicate a creation audit when interrupted before retiring its intent', async () => {
        {
            let runWrites = 0;
            const interruptedStore: ServiceStore = {
                ...store,
                writeJson: async (path, value) => {
                    if (path === RUNS_FILE) {
                        runWrites += 1;
                        if (runWrites === 3) {
                            throw new Error('simulated interruption after audit append');
                        }
                    }

                    await store.writeJson(path, value);
                },
            };

            await enqueueEvents({
                store: interruptedStore,
                log: LOGGER,
                incoming: [createEvent(assignment(45))],
            });
            const auditAfterEnqueue = await readAuditEntries(store);
            expect(auditAfterEnqueue.filter((entry) => entry.eventType === RUN_CREATED_EVENT)).toHaveLength(1);

            const restartedStore = await openStore({ dataDir });
            const recovered = await readRunsDocument({ store: restartedStore, log: LOGGER });
            const audits = await readAuditEntries(restartedStore);

            expect(recovered.auditIntents).toEqual([]);
            expect(audits.filter((entry) => entry.eventType === RUN_CREATED_EVENT)).toHaveLength(1);
        }
    });

    it('refuses a pending run if attempt history already records a session', async () => {
        {
            const run = runFixture();
            const dispatchedRun: Run = {
                ...run,
                attempts: [{
                    attempt: 1,
                    dispatchToken: 'dtk-0123456789abcdef0123456789abcdef',
                    reservedAt: STAMP,
                    outcome: 'dispatched',
                    sessionId: 'ses_already_created',
                    reason: null,
                    resultReportedAt: STAMP,
                }],
            };
            const forgedDocument: RunsDocument = {
                ...emptyRunsDocument(),
                subjects: { [RUN_SUBJECT_KEY]: 1 },
                runs: [dispatchedRun],
            };
            let writes = 0;
            const corruptReadStore: ServiceStore = {
                ...store,
                readJson: async <T>(
                    path: string,
                    validate: (raw: unknown) => T | null,
                ): Promise<JsonReadResult<T>> => path === RUNS_FILE
                    ? { status: 'ok', value: forgedDocument as T }
                    : await store.readJson(path, validate),
                writeJson: async (path, value) => {
                    writes += 1;
                    await store.writeJson(path, value);
                },
            };

            const result = await claimRun({
                store: corruptReadStore,
                log: LOGGER,
                correlationId: run.correlationId,
                holder: HOLDER,
                leaseId: LEASE_ID,
                issuedAt: STAMP,
                expiresAt: CLAIM_EXPIRY,
                now: STAMP,
            });

            expect(result).toEqual({ status: 'refused', state: 'pending' });
            expect(writes).toBe(0);
        }
    });

});

describe('T-037 bounded run-linked delivery retention', () => {
    it('evicts linked state-free rows with old terminal runs and keeps legacy rows/dedupe', async () => {
        const incoming = Array.from({ length: MAX_TERMINAL_RUNS + 1 }, (_unused, index) =>
            createEvent(assignment(20_000 + index)));
        const planned = applyEnqueue({ document: emptyRunsDocument(), deliveries: incoming, now: STAMP });
        const document: RunsDocument = { ...planned.document, auditIntents: [] };
        const linked = incoming.map((event) => {
            const runCorrelationId = planned.links.get(event.id);
            if (runCorrelationId === undefined) {
                throw new Error('delivery was not linked to a run');
            }

            return { ...event, runCorrelationId };
        });
        const legacy = {
            ...createEvent(assignment(19_999)),
            state: 'dispatched' as const,
            claimedAt: STAMP,
            dispatchedAt: STAMP,
            dispatchResult: 'ses_legacy',
        };

        await writeRunsDocument({ store, log: LOGGER, document });
        await store.writeJson(EVENTS_FILE, [legacy, ...linked]);
        await writeRunsDocument({
            store,
            log: LOGGER,
            document: {
                ...document,
                runs: document.runs.map((run) => ({
                    ...run,
                    state: 'dispatched',
                    stateReason: 'session created',
                })),
            },
        });

        const retainedRuns = await readRunsDocument({ store, log: LOGGER });
        const retainedEvents = await readEvents({ store, log: LOGGER });
        const retainedIds = new Set(retainedEvents.map((event) => event.id));
        const newest = incoming.at(-1);
        if (newest === undefined) {
            throw new Error('bounded-retention fixture has no newest delivery');
        }

        expect(retainedRuns.runs).toHaveLength(MAX_TERMINAL_RUNS);
        expect(retainedEvents).toHaveLength(MAX_TERMINAL_RUNS + 1);
        expect(retainedIds.has(legacy.id)).toBe(true);
        expect(retainedIds.has(incoming[0]?.id ?? '')).toBe(false);
        expect(retainedIds.has(newest.id)).toBe(true);
        expect(retainedEvents.find((event) => event.id === legacy.id)?.dispatchResult).toBe('ses_legacy');

        const duplicate = await enqueueEvents({ store, log: LOGGER, incoming: [newest] });
        expect(duplicate).toEqual([]);
        expect(await readEvents({ store, log: LOGGER })).toHaveLength(MAX_TERMINAL_RUNS + 1);
    });
});
