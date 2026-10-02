/**
 * The audit vocabulary and correlation suite (003 T-018; AC-115, AC-116,
 * FR-003, FR-062, NFR-106).
 *
 * [`dispatch-drive.ts`](./support/dispatch-drive.ts) walks one legacy run
 * through **every** transition in data-model §4.3 against the real loopback
 * service, plus a second run created the ordinary way, and hands this suite the
 * trail they wrote. What is asserted here is what the spec's `## Audit
 * Vocabulary`, its correlation table, and NFR-106 say that trail must contain:
 *
 * - **all seventeen types**, each with the actor, the decision, and the `details`
 *   keys the vocabulary table names (AC-115's "sample of every vocabulary
 *   entry … with its required `details`");
 * - **one `dispatch.refused` row per refusing operation**, including the
 *   `422` whose code is `validation` (FR-003, contract §9 as T-044 narrows it);
 * - **the run's correlation id, byte-identical, on every lifecycle row** —
 *   never a freshly generated identifier (FR-062, AC-116) — with the detection
 *   rows that were assigned the run's id at enqueue matching the same filter;
 * - **no credential material anywhere** in the trail, while the tokens the
 *   drive actually minted survive only as fingerprints (NFR-106, AC-120).
 *
 * Offline: one temp store, injected sweep stamps, no timers, no network.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findSecretLeak } from '../src/redaction.ts';
import type { AuditEntry } from '../service/audit.ts';
import { EXPECTED_AGENT, shutdownDispatchCorpus } from './support/dispatch-corpus.ts';
import { driveDispatchCorpus } from './support/dispatch-drive.ts';
import type { DispatchCorpus } from './support/dispatch-corpus.ts';

/** The correlation id shape the service mints; a fresh uuid is not one. */
const RUN_ID_PATTERN = /^mt-run-[0-9a-f]{24}$/;

/** A freshly generated identifier, in either of the shapes the service mints. */
const FRESH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-|^urn:uuid:|^[0-9a-f]{32}$/;

/** The fingerprint prefix audit rows record a dispatch token under. */
const FINGERPRINT_PATTERN = /^tokfp-/;

/** Token-shaped values that must never reach a row (T-040c). */
const TOKEN_PATTERN = /dtk-[0-9a-f]{8,}/;

/**
 * Vocabulary row names, one constant each: the seventeen lifecycle types the
 * spec's `## Audit Vocabulary` defines, the refusal row FR-003 adds, and the
 * detection row whose correlation id is assigned at enqueue (FR-050).
 */
const CREATED_ROW = 'run.created';
const COALESCED_ROW = 'run.coalesced';
const MIGRATED_ROW = 'run.migrated';
const CLAIMED_ROW = 'dispatch.claimed';
const RESERVED_ROW = 'dispatch.reserved';
const RESULT_ROW = 'dispatch.result';
const DUPLICATE_ROW = 'dispatch.duplicate-report';
const ABANDONED_ROW = 'dispatch.abandoned';
const LEASE_EXPIRED_ROW = 'dispatch.lease-expired';
const UNCONFIRMED_ROW = 'dispatch.unconfirmed';
const RETRY_ROW = 'dispatch.retry';
const RESOLVED_ROW = 'dispatch.resolved';
const BLOCKED_ROW = 'run.blocked';
const DEAD_LETTERED_ROW = 'run.dead_lettered';
const VERIFIED_ROW = 'agent.verified';
const MISMATCH_ROW = 'agent.mismatch';
const UNCOMPARED_ROW = 'agent.uncompared';
const REFUSAL_ROW = 'dispatch.refused';
const DETECTED_ROW = 'delivery.detected';

/** Every operation that can refuse a run-scoped request, as its row records it. */
const REFUSING_OPERATIONS = [
    'reserve',
    'result',
    'abandon',
    'blocked',
    'retry',
    'requeue',
    'resolve',
    'verification',
] as const;

/** One vocabulary entry: which row it is, who wrote it, and what it owes. */
interface VocabularyEntry {
    /** Vocabulary name of the row. */
    readonly eventType: string;
    /** Actor source the table names for this row. */
    readonly actor: string;
    /** Decision the row carries, or `null` when the table names none. */
    readonly decision: string | null;
    /** `details` keys the table requires on this row. */
    readonly details: readonly string[];
}

/**
 * The seventeen lifecycle types, transcribed from the spec's `## Audit
 * Vocabulary` (and data-model §4.2, which spells the dead-letter row with the
 * underscore the service writes — the spec table's hyphen is the outlier its
 * own amendment history contradicts: "including `run.dead_lettered`").
 */
const VOCABULARY: readonly VocabularyEntry[] = [
    { eventType: CREATED_ROW, actor: 'service', decision: null, details: ['subject', 'ordinal', 'deliveryIds'] },
    {
        eventType: COALESCED_ROW,
        actor: 'service',
        decision: 'coalesced',
        details: ['deliveryId', 'kind', 'origin', 'presentAtAuthorization'],
    },
    { eventType: MIGRATED_ROW, actor: 'service', decision: 'adopted', details: ['deliveryIds', 'state'] },
    {
        eventType: CLAIMED_ROW,
        actor: 'panel',
        decision: null,
        details: ['leaseId', 'attempt', 'leaseExpiry', 'sourceReferenceCount'],
    },
    {
        eventType: RESERVED_ROW,
        actor: 'panel',
        decision: null,
        details: [
            'leaseId',
            'attempt',
            'dispatchTokenFingerprint',
            'attachmentId',
            // 004 adds four credential-free scalars to the two rows that
            // record what was sent (004 `### Audit Vocabulary Delta`).
            'bindingId',
            'promptPresent',
            'promptFingerprint',
            'promptLength',
        ],
    },
    {
        eventType: RESULT_ROW,
        actor: 'panel',
        decision: 'dispatched',
        details: [
            'attempt',
            'dispatchTokenFingerprint',
            'sessionId',
            'bindingId',
            'promptPresent',
            'promptFingerprint',
            'promptLength',
        ],
    },
    {
        eventType: DUPLICATE_ROW,
        actor: 'service',
        decision: 'no-change',
        details: ['attempt', 'dispatchTokenFingerprint', 'state'],
    },
    {
        eventType: ABANDONED_ROW,
        actor: 'panel',
        decision: 'no-session',
        details: ['attempt', 'dispatchTokenFingerprint', 'reason'],
    },
    {
        eventType: LEASE_EXPIRED_ROW,
        actor: 'service',
        decision: 'requeued',
        details: ['priorState', 'attemptBefore', 'attemptAfter', 'leaseId', 'leaseExpiry'],
    },
    {
        eventType: UNCONFIRMED_ROW,
        actor: 'service',
        decision: 'unconfirmed',
        details: ['priorState', 'attempt', 'dispatchTokenFingerprint', 'deadline'],
    },
    {
        eventType: RETRY_ROW,
        actor: 'operator',
        decision: 'retry',
        details: ['priorState', 'attemptBefore', 'attemptAfter', 'causeReportedCleared'],
    },
    {
        eventType: RESOLVED_ROW,
        actor: 'operator',
        decision: 'no-session',
        details: ['priorState', 'note', 'guidance'],
    },
    {
        eventType: BLOCKED_ROW,
        actor: 'panel',
        decision: 'blocked',
        details: ['blockedReason', 'priorState', 'guidance'],
    },
    {
        eventType: DEAD_LETTERED_ROW,
        actor: 'service',
        decision: 'dead-lettered',
        details: ['priorState', 'attemptBefore', 'attemptAfter'],
    },
    {
        eventType: VERIFIED_ROW,
        actor: 'panel',
        decision: 'verified',
        details: ['sessionId', 'observedAgent', 'expectedAgent'],
    },
    {
        eventType: MISMATCH_ROW,
        actor: 'panel',
        decision: 'warn',
        details: ['sessionId', 'observedAgent', 'expectedAgent', 'note'],
    },
    {
        // 003 v1.7.0's third read-back row: the provenance is required here
        // because it is the answer to *why* nothing was compared — a compared
        // row already carries the baseline it compared against.
        eventType: UNCOMPARED_ROW,
        actor: 'panel',
        decision: 'observed',
        details: ['sessionId', 'observedAgent', 'expectedAgent', 'baselineProvenance', 'note'],
    },
];

/** The seventeen types plus the refusal row: everything a run's chain owns. */
const LIFECYCLE_TYPES: ReadonlySet<string> = new Set([...VOCABULARY.map((entry) => entry.eventType), REFUSAL_ROW]);

/** The corpus the suite asserts over, driven once for every test below. */
let corpus: DispatchCorpus | null = null;

beforeAll(async () => {
    // The drive makes ~40 round trips and four injected sweep passes; the bound
    // is generous so a slow machine never reads as a broken transition.
    corpus = await driveDispatchCorpus();
}, 120_000);

afterAll(async () => {
    if (corpus === null) {
        return;
    }

    await shutdownDispatchCorpus(corpus);
    corpus = null;
});

/** The corpus, or a failure naming the setup step that did not run. */
function driven(): DispatchCorpus {
    if (corpus === null) {
        throw new Error('the dispatch corpus was not driven');
    }

    return corpus;
}

/** Every row of one event type across the whole trail, in `seq` order. */
function rowsOf(trail: readonly AuditEntry[], eventType: string): readonly AuditEntry[] {
    return trail.filter((entry) => entry.eventType === eventType);
}

/** Every lifecycle row: the seventeen types plus the refusal row. */
function lifecycleRows(trail: readonly AuditEntry[]): readonly AuditEntry[] {
    return trail.filter((entry) => LIFECYCLE_TYPES.has(entry.eventType));
}

/** The first row of one type, or a failure naming the type that is missing. */
function firstRowOf(trail: readonly AuditEntry[], eventType: string): AuditEntry {
    const [row] = rowsOf(trail, eventType);
    if (row === undefined) {
        throw new Error(`the trail carries no ${eventType} row`);
    }

    return row;
}

/** The lowest `seq` one type carries for one run, or `NaN` when it has none. */
function firstSeqFor(input: {
    /** The trail to search. */
    readonly trail: readonly AuditEntry[];
    /** Vocabulary name of the row. */
    readonly eventType: string;
    /** The run whose row must match. */
    readonly correlationId: string;
}): number {
    const [row] = rowsOf(input.trail, input.eventType)
        .filter((entry) => entry.correlationId === input.correlationId);

    return row === undefined ? Number.NaN : row.seq;
}

describe('AC-115 every vocabulary entry is present with its required details', () => {
    it('writes all seventeen types with the actor, decision, a… (+3 cases)', () => {
        // case: writes all seventeen types with the actor, decision, and details the table names
        {
            const { trail } = driven();
            expect(new Set(trail.map((entry) => entry.eventType)).size).toBeGreaterThanOrEqual(
                VOCABULARY.length + 1,
            );

            for (const entry of VOCABULARY) {
                const rows = rowsOf(trail, entry.eventType);
                expect(rows.length, `${entry.eventType} must appear in the trail`).toBeGreaterThan(0);

                for (const row of rows) {
                    expect(row.actorSource, `${entry.eventType} actor`).toBe(entry.actor);
                    expect(row.decision, `${entry.eventType} decision`).toBe(entry.decision);
                    expect(row.entity.kind, `${entry.eventType} entity`).toBe('run');
                    expect(row.entity.id, `${entry.eventType} entity id`).toBe(row.correlationId);
                    // The reason *member* every row carries; several types leave
                    // its value `null` and put their prose in `details` instead,
                    // which is the shape as stored, not a projection of this read.
                    expect(Object.hasOwn(row, 'reason'), `${entry.eventType} reason member`).toBe(true);
                    for (const key of entry.details) {
                        expect(
                            Object.hasOwn(row.details, key),
                            `${entry.eventType} details must carry ${key}`,
                        ).toBe(true);
                    }
                }
            }
        }
        // case: names the reference that joined after authorization as possibly unseen (FR-015)
        {
            const { trail } = driven();
            const coalesced = rowsOf(trail, COALESCED_ROW);

            expect(coalesced).toHaveLength(1);
            expect(coalesced[0]?.details).toMatchObject({
                kind: 'mention',
                origin: 'comment:4242',
                presentAtAuthorization: false,
            });
        }
        // case: records one refusal of each of the eight refusing operations (FR-003)
        {
            const { trail, refusals, adoptedRunId } = driven();
            expect(refusals).toHaveLength(REFUSING_OPERATIONS.length);
            expect(refusals.map((observation) => observation.operation).sort())
                .toEqual([...REFUSING_OPERATIONS].sort());

            const rows = rowsOf(trail, REFUSAL_ROW);
            const operations = new Set(rows.map((row) => row.details.operation));
            for (const operation of REFUSING_OPERATIONS) {
                expect(operations.has(operation), `${REFUSAL_ROW} must record ${operation}`).toBe(true);
            }

            // T-043/T-044: a `422` about a run that exists owes its row too, and
            // its `details.code` is `validation` — the case the contract's own
            // narrowing had to be written to keep.
            const validationRows = rows.filter((row) => row.details.code === 'validation');
            expect(validationRows.length).toBeGreaterThan(0);
            expect(validationRows.every((row) => row.decision === 'refused')).toBe(true);
            const validationObservations = refusals.filter((observation) => observation.status === 422);
            expect(validationObservations.length).toBeGreaterThan(0);
            for (const observation of validationObservations) {
                expect(observation.code).toBe('validation');
            }

            // Every refusal row names the run it refused, and the verdict it held.
            for (const row of rows) {
                expect(row.actorSource).toBe('service');
                expect(row.entity.id).toBe(adoptedRunId);
                expect(typeof row.details.operation).toBe('string');
                expect(typeof row.details.code).toBe('string');
                expect(typeof row.details.priorState).toBe('string');
            }
        }
        // case: records a blank-baseline read-back as its own row, with the absence and no expectation
        {
            const { trail, adoptedRunId } = driven();
            const [uncompared] = rowsOf(trail, UNCOMPARED_ROW);
            if (uncompared === undefined) {
                throw new Error('the trail carries no agent.uncompared row');
            }

            // The Default Agent pin is blank by default (002 v1.10.0), so this
            // is the usual read-back: observed, never compared, and saying so
            // in its own words — an empty expectation, the provenance that
            // explains it, and a decision that is an observation rather than a
            // verdict (003 v1.7.0).
            expect(uncompared.actorSource).toBe('panel');
            expect(uncompared.correlationId).toBe(adoptedRunId);
            expect(uncompared.decision).toBe('observed');
            expect(uncompared.details.expectedAgent).toBe('');
            expect(uncompared.details.observedAgent).toBe(EXPECTED_AGENT);
            expect(uncompared.details.baselineProvenance).toBe('unset');

            // The contrast that keeps the third row honest: a comparison that
            // really happened still records the baseline it differed from, so
            // the empty expectation above is the absence and not a formatting
            // habit.
            const [mismatch] = rowsOf(trail, MISMATCH_ROW);
            expect(mismatch?.details.expectedAgent).toBe(EXPECTED_AGENT);
        }
    });
});

describe('FR-062 every lifecycle row carries the run correlation id', () => {
    it('reports the run id byte-identically, never a freshly… (+1 cases)', () => {
        // case: reports the run id byte-identically, never a freshly generated one (AC-116)
        {
            const { trail, adoptedRunId, createdRunId } = driven();
            const lifecycle = lifecycleRows(trail);

            expect(lifecycle.length).toBeGreaterThan(0);
            for (const row of lifecycle) {
                expect(row.correlationId, `${row.eventType} correlation id`).toMatch(RUN_ID_PATTERN);
                expect(row.entity.id, `${row.eventType} entity id`).toBe(row.correlationId);
                // A fresh uuid would still parse as an id and never look wrong to
                // a casual reader — which is exactly the failure AC-116 forbids.
                expect(row.correlationId).not.toMatch(FRESH_ID_PATTERN);
                const expected = row.eventType === CREATED_ROW ? createdRunId : adoptedRunId;
                expect(row.correlationId, `${row.eventType} must name its run`).toBe(expected);
            }

            // Detection rows were assigned the run's id at enqueue, so the same
            // filter finds them — the forwards half of FR-052's traceability.
            const detected = rowsOf(trail, DETECTED_ROW);
            expect(detected.length).toBeGreaterThan(0);
            for (const row of detected) {
                expect([adoptedRunId, createdRunId]).toContain(row.correlationId);
            }
        }
        // case: orders the trail the way the transitions happened
        {
            const { trail, adoptedRunId, createdRunId } = driven();
            // The drive's own order: adoption, the claim that gave the refusals a
            // live state, the budget parking the run and its return to waiting, the
            // guard, the authorization the second trigger joined behind, the wedge
            // and its resolution, then the dispatch and its read-backs.
            const chain = [
                MIGRATED_ROW,
                CLAIMED_ROW,
                DEAD_LETTERED_ROW,
                RETRY_ROW,
                BLOCKED_ROW,
                RESERVED_ROW,
                COALESCED_ROW,
                ABANDONED_ROW,
                UNCONFIRMED_ROW,
                RESOLVED_ROW,
                RESULT_ROW,
                DUPLICATE_ROW,
                VERIFIED_ROW,
                MISMATCH_ROW,
                UNCOMPARED_ROW,
            ].map((eventType) => firstSeqFor({ trail, eventType, correlationId: adoptedRunId }));

            expect(chain.every((seq) => !Number.isNaN(seq))).toBe(true);
            expect([...chain].sort((left, right) => left - right)).toEqual(chain);
            // Creation is the only row that belongs to the other run, and it is
            // written once — the vocabulary's first entry (AC-115's sample).
            expect(rowsOf(trail, CREATED_ROW)).toHaveLength(1);
            expect(firstRowOf(trail, CREATED_ROW).correlationId).toBe(createdRunId);
            expect(rowsOf(trail, MIGRATED_ROW)).toHaveLength(1);
        }
    });
});

describe('004 the two rows that record what was sent carry the prompt reference (AC-139)', () => {
    it('names the binding and a well-shaped reference, never the text', () => {
        const { trail } = driven();
        const fingerprint = /^mtp-[0-9a-f]{32}$/;
        const sent = trail.filter((row) =>
            row.eventType === RESERVED_ROW || row.eventType === RESULT_ROW);
        expect(sent.length).toBeGreaterThan(0);

        for (const row of sent) {
            const { details } = row;
            expect(typeof details.bindingId, `${row.eventType} bindingId`).toBe('string');
            expect(String(details.bindingId).length).toBeGreaterThan(0);
            expect(typeof details.promptPresent, `${row.eventType} promptPresent`).toBe('boolean');
            expect(details.promptFingerprint === null
                || fingerprint.test(String(details.promptFingerprint))).toBe(true);
            expect(details.promptLength === null || typeof details.promptLength === 'number').toBe(true);
            expect(row.correlationId, `${row.eventType} correlation id`).toMatch(RUN_ID_PATTERN);
        }

        // The reference is the whole of what a row records about the prompt.
        expect(JSON.stringify(trail)).not.toContain('OPERATOR STARTING PROMPT');
        expect(findSecretLeak(JSON.stringify(trail))).toBeNull();
    });
});

describe('NFR-106 no credential material reaches a row', () => {
    it('carries no token value, while the tokens it minted survive as fingerprints', () => {
        const { trail } = driven();
        expect(trail.length).toBeGreaterThan(0);

        let fingerprints = 0;
        for (const entry of trail) {
            const row = JSON.stringify(entry);
            expect(row, `${entry.eventType} carried a token value`).not.toMatch(TOKEN_PATTERN);
            expect(findSecretLeak(row), `${entry.eventType} carried credential material`).toBeNull();
            fingerprints += Object.values(entry.details).filter(
                (value) => typeof value === 'string' && FINGERPRINT_PATTERN.test(value),
            ).length;
        }

        // The scan above is only meaningful if tokens were actually minted:
        // reservations happened, and every row that had to name one named the
        // fingerprint instead (T-040c).
        expect(fingerprints).toBeGreaterThan(0);
    });
});
