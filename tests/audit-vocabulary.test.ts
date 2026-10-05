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
import { PROMPT_SOURCE_ORDER } from '../src/prompt.ts';
import { promptFingerprint } from '../service/prompt.ts';
import { buildCorrelationId, buildRunKey } from '../service/poll/run-key.ts';
import { reservedRow, resultRow } from '../service/poll/dispatch-audit.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { PromptSnapshot } from '../service/prompt.ts';
import type { Run } from '../service/poll/runs-types.ts';
import { byText } from './support/sort.ts';
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

/**
 * The `details` keys `dispatch.reserved` owes, in sorted order: the four 003
 * named, plus the four credential-free scalars 004 adds (FR-050), with
 * `promptSources` joining them (FR-087). Spelled as a whole set so a member
 * that is renamed or dropped fails here rather than silently passing a
 * "carries the key" check.
 */
const RESERVED_DETAIL_KEYS: readonly string[] = [
    // `actorPolicy` is 003 v1.8.0's one required, **value-free** addition to this
    // row (FR-079): the *shape* of the binding's allow-list at authorization,
    // beside 004's prompt members. A permitted login here would be a second copy
    // of the access policy in a file retained for months (NFR-113).
    'actorPolicy',
    'attachmentId',
    'attempt',
    'bindingId',
    'dispatchTokenFingerprint',
    'leaseId',
    'promptFingerprint',
    'promptLength',
    'promptPresent',
    'promptSources',
];

/** The same, for `dispatch.result` in its dispatched shape (no `leaseId`, a `sessionId`). */
const RESULT_DETAIL_KEYS: readonly string[] = [
    'actorPolicy',
    'attempt',
    'bindingId',
    'dispatchTokenFingerprint',
    'promptFingerprint',
    'promptLength',
    'promptPresent',
    'promptSources',
    'sessionId',
];

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
            // record what was sent (004 `### Audit Vocabulary Delta`), and
            // `promptSources` joins them at v1.3.0 beside the fingerprint
            // (FR-087 — the ordered tier list, never the text).
            'bindingId',
            'promptPresent',
            'promptFingerprint',
            'promptLength',
            'promptSources',
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
            'promptSources',
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
    const row = rowsOf(input.trail, input.eventType)
        .find((entry) => entry.correlationId === input.correlationId);

    return row === undefined ? NaN : row.seq;
}

describe('AC-115 every vocabulary entry is present with its required details', () => {
    it('writes all seventeen types with the actor, decision, and details the table names', () => {
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
        {
            const { trail, refusals, adoptedRunId } = driven();
            expect(refusals).toHaveLength(REFUSING_OPERATIONS.length);
            expect(refusals.map((observation) => observation.operation).toSorted(byText))
                .toEqual([...REFUSING_OPERATIONS].toSorted(byText));

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
    it('reports the run id byte-identically, never a freshly generated one', () => {
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
            expect([...chain].toSorted((left, right) => left - right)).toEqual(chain);
            // Creation is the only row that belongs to the other run, and it is
            // written once — the vocabulary's first entry (AC-115's sample).
            expect(rowsOf(trail, CREATED_ROW)).toHaveLength(1);
            expect(firstRowOf(trail, CREATED_ROW).correlationId).toBe(createdRunId);
            expect(rowsOf(trail, MIGRATED_ROW)).toHaveLength(1);
        }
    });
});

/**
 * Read one row's `promptSources` as FR-087 declares it: an ordered tier list
 * when a prompt was present, `null` when none was, and nothing else standing
 * in for either.
 *
 * @returns The tier list, `null`, or `undefined` when the member is neither
 *   shape — which the caller reports as the violation it is.
 */
function tiersOf(value: unknown): readonly string[] | null | undefined {
    if (value === null) {
        return null;
    }

    if (!Array.isArray(value)) {
        return undefined;
    }

    const tiers: string[] = [];
    for (const element of value) {
        if (typeof element !== 'string') {
            return undefined;
        }

        tiers.push(element);
    }

    return tiers;
}

/**
 * Assert FR-087's presence invariant on one row: a present prompt implies a
 * non-empty list drawn from the tier vocabulary in its own order, and an
 * absent one implies `null` — never a defaulted empty list.
 *
 * Takes the pair structurally rather than a row type, so the same invariant
 * reads a stored {@link AuditEntry} and a row the builders just made.
 */
function expectSourcesMatchPrompt(input: {
    /** Vocabulary name of the row, for the failure message. */
    readonly eventType: string;
    /** The row's `details`; absent only on a row that owes none. */
    readonly details: Readonly<Record<string, unknown>> | undefined;
}): void {
    const { eventType } = input;
    const details = input.details ?? {};
    const tiers = tiersOf(details.promptSources);

    if (details.promptPresent !== true) {
        expect(tiers, `${eventType} promptSources must be null when no prompt was set`).toBeNull();

        return;
    }

    if (tiers === null || tiers === undefined) {
        throw new Error(`${eventType} promptSources must be a tier list when a prompt is present`);
    }

    expect(tiers.length, `${eventType} promptSources must not be empty`).toBeGreaterThan(0);
    const order: readonly string[] = PROMPT_SOURCE_ORDER;
    const positions = tiers.map((tier) => order.indexOf(tier));
    expect(positions.every((position) => position >= 0), `${eventType} tier vocabulary`).toBe(true);
    expect([...positions].toSorted((left, right) => left - right), `${eventType} tier order`).toEqual(positions);
    expect(new Set(tiers).size, `${eventType} tier duplicates`).toBe(tiers.length);
}

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

            // The whole set, not one key at a time: 003's members are all
            // still there and `promptSources` is the only addition, so a
            // rename or a removal fails here (FR-050's "changes none of its
            // existing fields", FR-087).
            expect(Object.keys(details).toSorted(byText), `${row.eventType} details keys`).toEqual(
                row.eventType === RESERVED_ROW ? RESERVED_DETAIL_KEYS : RESULT_DETAIL_KEYS,
            );
            expectSourcesMatchPrompt({ eventType: row.eventType, details });
        }

        // The reference is the whole of what a row records about the prompt.
        expect(JSON.stringify(trail)).not.toContain('OPERATOR STARTING PROMPT');
        expect(findSecretLeak(JSON.stringify(trail))).toBeNull();
    });
});

/**
 * One sentinel sentence per tier: text a row must never carry (FR-050,
 * FR-088).
 *
 * The driven corpus resolves a **binding-only** prompt — its fixture enqueues
 * through a single binding — so the stacked, three-tier case is pinned against
 * the row builders directly. That is where "written from the run's snapshot"
 * stops being a coincidence: the builders take one `Run` and nothing else, so
 * the list a row carries can only be the list the snapshot carried.
 */
const TIER_SENTINELS: readonly string[] = [
    'SENTINEL GLOBAL: a tier text that must never reach a row',
    'SENTINEL ACCOUNT: a tier text that must never reach a row',
    'SENTINEL BINDING: a tier text that must never reach a row',
];

/** The stacked block the sentinels build, in FR-080's order, one gap apart. */
const STACKED_BLOCK = TIER_SENTINELS.join('\n\n');

/** The snapshot a run queued with all three tiers set carries (FR-080). */
const STACKED_SNAPSHOT: PromptSnapshot = {
    text: STACKED_BLOCK,
    fingerprint: promptFingerprint(STACKED_BLOCK),
    length: [...STACKED_BLOCK].length,
    sources: ['global', 'account', 'binding'],
};

/** Lease one synthetic reservation is made under (shape only: nothing validates it here). */
const SYNTHETIC_LEASE = `lse-${'a'.repeat(24)}`;

/** Token one synthetic reservation mints; the rows record its fingerprint only. */
const SYNTHETIC_TOKEN = `dtk-${'b'.repeat(32)}`;

/** Binding one synthetic run dispatches through. */
const SYNTHETIC_BINDING = 'bnd-sources';

/**
 * A stored run carrying this snapshot; every other member is a plain stored
 * value, because the row builders read only `correlationId`, `bindingId`,
 * `attempt`, `attachmentId`, and `prompt`.
 *
 * @param prompt - The snapshot this run was queued with, or `null`.
 * @returns A run `reservedRow` and `resultRow` both accept.
 */
function runWith(prompt: PromptSnapshot | null): Run {
    const runKey = buildRunKey({
        accountNumericUserId: '77331',
        repository: 'acme/widget',
        subjectType: 'issue',
        subjectNumber: 99,
        ordinal: 0,
    });
    const correlationId = buildCorrelationId(runKey);
    const stamp = '2026-09-20T00:00:00.000Z';

    return {
        runKey,
        correlationId,
        attachmentId: correlationId,
        ordinal: 0,
        subjectType: 'issue',
        subjectNumber: 99,
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        bindingId: SYNTHETIC_BINDING,
        projectId: 'prj_42',
        worktreeOption: 'none',
        prompt,
        actorPolicy: 'open',
        state: 'starting',
        stateReason: null,
        attempt: 1,
        requeuesUsed: 0,
        sourceReferences: [],
        referenceCount: 0,
        referencesNotRetained: 0,
        referencesTruncated: false,
        lease: null,
        reservation: null,
        attempts: [],
        session: null,
        verification: null,
        createdAt: stamp,
        updatedAt: stamp,
    };
}

describe('004 both rows copy the snapshot sources, never its text (FR-087)', () => {
    it('carries a stacked three-tier list verbatim, and null for a run with no prompt', () => {
        const run = runWith(STACKED_SNAPSHOT);
        const rows = [
            reservedRow({ run, leaseId: SYNTHETIC_LEASE, dispatchToken: SYNTHETIC_TOKEN }),
            resultRow({ run, dispatchToken: SYNTHETIC_TOKEN, sessionId: 'ses_stacked', problem: null }),
        ];

        for (const row of rows) {
            const { details } = row;
            if (details === undefined) {
                throw new Error(`${row.eventType} built no details`);
            }

            expect(row.correlationId).toBe(run.correlationId);
            expect(row.entity).toEqual({ kind: 'run', id: run.correlationId });
            expect(details.bindingId).toBe(SYNTHETIC_BINDING);
            expect(details.promptPresent).toBe(true);
            expect(details.promptFingerprint).toBe(STACKED_SNAPSHOT.fingerprint);
            expect(details.promptLength).toBe(STACKED_SNAPSHOT.length);
            // Verbatim: the snapshot's own list, in FR-080's order — a list
            // this builder had no say in choosing.
            expect(details.promptSources).toEqual(['global', 'account', 'binding']);
            expect(details.promptSources).toEqual(STACKED_SNAPSHOT.sources);
            expectSourcesMatchPrompt({ eventType: row.eventType, details });
        }

        // The other half of the invariant: no tier set answers `null` on the
        // whole reference, never an empty list standing in for "unset".
        const unset = reservedRow({ run: runWith(null), leaseId: SYNTHETIC_LEASE, dispatchToken: SYNTHETIC_TOKEN });
        expect(unset.details).toMatchObject({
            bindingId: SYNTHETIC_BINDING,
            promptPresent: false,
            promptFingerprint: null,
            promptLength: null,
            promptSources: null,
        });
        expectSourcesMatchPrompt({ eventType: unset.eventType, details: unset.details });

        // Neither row carries a tier's text: the whole reference is presence,
        // fingerprint, length, and sources, and nothing else (FR-050).
        const written = JSON.stringify([...rows, unset]);
        expect(written).not.toContain(STACKED_BLOCK);
        for (const sentinel of TIER_SENTINELS) {
            expect(written, 'a tier text reached a row').not.toContain(sentinel);
        }
        expect(findSecretLeak(written)).toBeNull();
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
