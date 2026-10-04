/**
 * `runs.json` schema and its fail-closed validator (003 data-model §2.2, T-002).
 *
 * Three test classes, in the order the store meets them:
 *
 * 1. **writer → reader round-trip on real bytes** — the document is written
 *    through the store's own atomic writer and read back through
 *    `parseRunsDocument`, so the accepted shape is pinned to what the run
 *    store actually persists rather than to a hand-built object (the class
 *    that silently lost the queue in 002's `issueNumber` bug);
 * 2. **every malformed shape refuses** — one table of broken documents, each
 *    of which must answer `null`, which is what the store turns into a
 *    quarantine instead of a partially applied run;
 * 3. **vocabulary** — all eight dispatch states parse, and `blocked:` is
 *    validated as prefix + non-empty kebab reason, never as a fixed enum:
 *    `blocked:` with an empty reason refuses, an unproduced reason parses.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    MAX_ATTEMPT_RECORDS,
    MAX_SOURCE_REFERENCES,
    RUNS_SCHEMA_VERSION,
    parseRun,
    parseRunsDocument,
} from '../service/poll/runs-parse.ts';
import { buildCorrelationId, buildRunKey } from '../service/poll/run-key.ts';
import { promptFingerprint } from '../service/prompt.ts';
import { openStore } from '../service/store/index.ts';
import type { JsonReadResult } from '../service/store/index.ts';
import type { DispatchAttempt, Run, RunsDocument, SourceReference } from '../service/poll/runs-types.ts';
import { runHistoryIndicatesSession } from '../service/poll/runs-document.ts';

/** Store file this suite round-trips through, named as the run store names it. */
const RUNS_FILE = 'runs.json';

/** Stamp every fixture row carries. */
const STAMP = '2026-09-28T00:00:00.000Z';

/** The fixture subject's ordinal counter key, built the way the run key is. */
const SUBJECT_COUNTER = Object.fromEntries([['github|77331|acme/widget|issue|12', 1]]);

/** A subjects map whose only key is empty, which the validator must refuse. */
const EMPTY_COUNTER = Object.fromEntries([['', 1]]);

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-runs-parse-'));
    dataDir = join(tempRoot, 'store');
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Build the one source reference every fixture run starts with.
 *
 * @returns A complete reference as the enqueue path writes one.
 */
function fixtureReference(): SourceReference {
    return {
        deliveryId: 'evt-acme~widget~12~77331',
        kind: 'assignment',
        origin: 'assignment',
        sourceUrl: 'https://github.com/acme/widget/issues/12',
        detectedAt: STAMP,
        presentAtAuthorization: true,
    };
}

/**
 * Build one in-flight attempt record.
 *
 * @returns A record the writer could have appended.
 */
function attemptRecord(): DispatchAttempt {
    return {
        attempt: 1,
        dispatchToken: null,
        reservedAt: null,
        outcome: null,
        sessionId: null,
        reason: null,
        resultReportedAt: null,
    };
}

/**
 * Build one complete run row, overridable per assertion.
 *
 * @param overrides - Fields the case under test changes.
 * @returns A row the writer could have persisted.
 */
function fixtureRun(overrides: Partial<Run> = {}): Run {
    const ordinal = overrides.ordinal !== undefined && overrides.ordinal >= 0 ? overrides.ordinal : 0;
    const subjectNumber = overrides.subjectNumber !== undefined
        && Number.isSafeInteger(overrides.subjectNumber)
        && overrides.subjectNumber > 0
        ? overrides.subjectNumber
        : 12;
    const subjectType = overrides.subjectType ?? 'issue';
    const runKey = buildRunKey({
        accountNumericUserId: '77331',
        repository: 'acme/widget',
        subjectType,
        subjectNumber,
        ordinal,
    });
    const correlationId = buildCorrelationId(runKey);
    const base: Run = {
        runKey,
        correlationId,
        attachmentId: correlationId,
        ordinal,
        subjectType,
        subjectNumber,
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        bindingId: 'bnd-runs',
        projectId: 'prj_42',
        worktreeOption: 'none',
        prompt: null,
        actorPolicy: null,
        state: 'pending',
        stateReason: null,
        attempt: 1,
        requeuesUsed: 0,
        sourceReferences: [fixtureReference()],
        referenceCount: 1,
        referencesNotRetained: 0,
        referencesTruncated: false,
        lease: null,
        reservation: null,
        attempts: [],
        session: null,
        verification: null,
        createdAt: STAMP,
        updatedAt: STAMP,
    };

    return { ...base, ...overrides };
}

/**
 * Build the document around some runs.
 *
 * @param runs - Rows the document carries, as stored or as a corrupt file
 *   would hold them.
 * @returns A complete `runs.json` document.
 */
function fixtureDocument(runs: readonly unknown[]): RunsDocument {
    return {
        schemaVersion: RUNS_SCHEMA_VERSION,
        subjects: SUBJECT_COUNTER,
        runs: runs as readonly Run[],
        auditIntents: [],
    };
}

/**
 * Build a fixture row with one field overwritten to an unusable value.
 *
 * @param field - Field to poison.
 * @param value - Value the validator must refuse.
 * @returns The row, as an untrusted record.
 */
function poisoned(field: string, value: unknown): Record<string, unknown> {
    const row: Record<string, unknown> = { ...fixtureRun() };
    row[field] = value;

    return row;
}

/**
 * Build a fixture row whose state is unusable but whose reason line is fine,
 * so a refusal can only ever come from the state itself.
 *
 * @param value - State value the validator must refuse.
 * @returns The row, as an untrusted record.
 */
function poisonedState(value: unknown): Record<string, unknown> {
    const row = poisoned('state', value);
    row.stateReason = 'refused by a guard';

    return row;
}

/**
 * Build a fixture row with some fields dropped, as a truncated file would
 * hold it.
 *
 * @param fields - Fields to remove.
 * @returns The row, missing those fields.
 */
function without(...fields: readonly string[]): Record<string, unknown> {
    const row: Record<string, unknown> = { ...fixtureRun() };
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
        if (!fields.includes(key)) {
            kept[key] = value;
        }
    }

    return kept;
}

/**
 * Build a fixture row claiming a reference list of one size.
 *
 * A count above the cap models what the writer persists: the first
 * {@link MAX_SOURCE_REFERENCES} references retained, the remainder counted in
 * `referencesNotRetained`, and the truncation flag set (T-038). The
 * `overshoot` argument plants a list one entry longer than the cap, which the
 * writer can never produce.
 *
 * @param count - How many references the row claims to have joined.
 * @param overshoot - Extra entries to force onto the stored list itself.
 * @returns The row.
 */
function withReferences(count: number, overshoot = 0): Record<string, unknown> {
    const kept = Array.from({ length: Math.min(count, MAX_SOURCE_REFERENCES) }, (_unused, index) => ({
        ...fixtureReference(),
        deliveryId: `evt-acme~widget~${index}~77331`,
    }));
    const overflow = Array.from({ length: overshoot }, (_unused, index) => ({
        ...fixtureReference(),
        deliveryId: `evt-acme~widget~extra~${index}~77331`,
    }));
    const row = poisoned('sourceReferences', [...kept, ...overflow]);
    const notRetained = Math.max(count - kept.length, 0);
    row.referenceCount = count;
    row.referencesNotRetained = notRetained;
    row.referencesTruncated = notRetained > 0;

    return row;
}

/**
 * Build a fixture row claiming an attempt history of one size.
 *
 * @param count - How many attempt records the row claims to hold.
 * @returns The row.
 */
function withAttempts(count: number): Record<string, unknown> {
    return poisoned('attempts', Array.from(
        { length: count },
        (_unused, index) => ({ ...attemptRecord(), attempt: index + 1 }),
    ));
}

/**
 * Build a subjects map whose only counter is the value under test.
 *
 * @param value - Counter value the validator must refuse.
 * @returns A document fragment carrying that counter.
 */
function badSubjects(value: unknown): unknown {
    return {
        schemaVersion: RUNS_SCHEMA_VERSION,
        subjects: Object.fromEntries([['k', value]]),
        runs: [],
    };
}

/**
 * Read one planted document back through the store's own validator.
 *
 * @param document - Document to persist first.
 * @returns What the store answered for the file.
 */
async function readBack(document: unknown): Promise<JsonReadResult<RunsDocument>> {
    const store = await openStore({ dataDir });
    await store.writeJson(RUNS_FILE, document);

    return await store.readJson(RUNS_FILE, parseRunsDocument);
}

describe('writer → reader round-trip (real bytes)', () => {
    it('reads back exactly what the writer persisted', async () => {
        {
            const document = fixtureDocument([
                fixtureRun(),
                fixtureRun({
                    subjectNumber: 13,
                    state: 'failed',
                    stateReason: 'session-create-failed',
                    attempt: 2,
                    requeuesUsed: 1,
                }),
            ]);

            const result = await readBack(document);

            expect(result.status).toBe('ok');
            expect(result.status === 'ok' ? result.value : null).toEqual(document);
        }
    });

    it('reads back a stacked three-tier snapshot at its own stack bound', async () => {
        {
            const body = 'x'.repeat(6_004);
            const snapshot = {
                text: body,
                fingerprint: promptFingerprint(body),
                length: 6_004,
                sources: ['global', 'account', 'binding'] as const,
            };
            const document = fixtureDocument([fixtureRun({ prompt: snapshot })]);

            const result = await readBack(document);

            expect(result.status).toBe('ok');
            expect(result.status === 'ok' ? result.value.runs[0]?.prompt : null).toEqual(snapshot);
        }
    });

    it('keeps all eight dispatch states readable, blocked family included', async () => {
        {
            const states = [
                'pending',
                'claimed',
                'starting',
                'dispatched',
                'failed',
                'unconfirmed',
                'dead-lettered',
                'blocked:project-missing',
            ] as const;
            const runs = states.map((state, index) => fixtureRun({
                subjectNumber: 12 + index,
                state,
                stateReason: state === 'pending' ? null : `sitting in ${state}`,
            }));

            const result = await readBack(fixtureDocument(runs));

            expect(result.status).toBe('ok');
            expect(result.status === 'ok' ? result.value.runs.map((run) => run.state) : []).toEqual([...states]);
        }
    });

    it('refuses the file rather than half-reading it when one row is wrong', async () => {
        {
            const result = await readBack(fixtureDocument([fixtureRun(), fixtureRun({ attempt: 0 })]));

            expect(result.status).toBe('quarantined');
        }
    });

});

describe('fail-closed document and row validation', () => {
    /** One document shape that must never be trusted. */
    interface BadCase {
        /** Short name of the shape. */
        readonly name: string;
        /** The document to refuse. */
        readonly document: unknown;
    }

    const broken: readonly BadCase[] = [
        { name: 'not an object', document: 'runs' },
        { name: 'array document', document: [] },
        { name: 'missing schema marker', document: { subjects: {}, runs: [] } },
        { name: 'foreign schema marker', document: { schemaVersion: 2, subjects: {}, runs: [] } },
        { name: 'runs not an array', document: { schemaVersion: 1, subjects: {}, runs: {} } },
        { name: 'subjects missing', document: { schemaVersion: 1, runs: [] } },
        { name: 'negative ordinal counter', document: badSubjects(-1) },
        { name: 'fractional ordinal counter', document: badSubjects(1.5) },
        { name: 'empty subject key', document: { schemaVersion: 1, subjects: EMPTY_COUNTER, runs: [] } },
        { name: 'run not an object', document: fixtureDocument([null]) },
        { name: 'run missing its key', document: fixtureDocument([without('runKey')]) },
        { name: 'run with an empty correlation id', document: fixtureDocument([without('correlationId')]) },
        {
            name: 'correlation id does not hash the stored run key',
            document: fixtureDocument([poisoned('correlationId', 'mt-run-00000000000000000000000b')]),
        },
        {
            name: 'attachment id differs from the run correlation id',
            document: fixtureDocument([poisoned('attachmentId', 'mt-run-00000000000000000000000b')]),
        },
        { name: 'run with an unparseable stamp', document: fixtureDocument([fixtureRun({ createdAt: 'never' })]) },
        { name: 'run with a missing updated-at', document: fixtureDocument([without('updatedAt')]) },
        { name: 'run with no reason key', document: fixtureDocument([without('stateReason')]) },
        { name: 'unknown state', document: fixtureDocument([poisonedState('waiting')]) },
        { name: 'blocked with an empty reason', document: fixtureDocument([poisonedState('blocked:')]) },
        { name: 'blocked with a non-kebab reason', document: fixtureDocument([poisonedState('blocked:Project')]) },
        {
            name: 'reason empty off pending',
            document: fixtureDocument([fixtureRun({ state: 'failed', stateReason: '' })]),
        },
        { name: 'attempt below one', document: fixtureDocument([fixtureRun({ attempt: 0 })]) },
        { name: 'fractional attempt', document: fixtureDocument([fixtureRun({ attempt: 1.5 })]) },
        { name: 'negative requeue count', document: fixtureDocument([fixtureRun({ requeuesUsed: -1 })]) },
        { name: 'ordinal negative', document: fixtureDocument([fixtureRun({ ordinal: -1 })]) },
        { name: 'subject number below one', document: fixtureDocument([fixtureRun({ subjectNumber: 0 })]) },
        { name: 'unknown subject type', document: fixtureDocument([poisoned('subjectType', 'pull')]) },
        { name: 'truncated flag missing', document: fixtureDocument([without('referencesTruncated')]) },
        { name: 'not-retained count missing', document: fixtureDocument([without('referencesNotRetained')]) },
        { name: 'not-retained count negative', document: fixtureDocument([fixtureRun({ referencesNotRetained: -1 })]) },
        {
            name: 'not-retained count fractional',
            document: fixtureDocument([fixtureRun({ referencesNotRetained: 1.5 })]),
        },
        {
            name: 'references above the cap',
            document: fixtureDocument([withReferences(MAX_SOURCE_REFERENCES, 1)]),
        },
        {
            name: 'stored count above the cap without a not-retained marker',
            document: fixtureDocument([poisoned('referenceCount', MAX_SOURCE_REFERENCES + 1)]),
        },
        {
            name: 'not-retained count that cannot be reconciled with the list',
            document: fixtureDocument([fixtureRun({
                referenceCount: 9,
                referencesNotRetained: 3,
                referencesTruncated: true,
            })]),
        },
        {
            name: 'not-retained count claiming loss the flag denies',
            document: fixtureDocument([fixtureRun({
                referenceCount: 2,
                referencesNotRetained: 1,
                referencesTruncated: false,
            })]),
        },
        { name: 'reference count below the list', document: fixtureDocument([fixtureRun({ referenceCount: 0 })]) },
        { name: 'attempt records above the cap', document: fixtureDocument([withAttempts(MAX_ATTEMPT_RECORDS + 1)]) },
        {
            name: 'two runs sharing one correlation id',
            document: fixtureDocument([fixtureRun(), fixtureRun()]),
        },
        {
            name: 'two open runs share one subject',
            document: fixtureDocument([fixtureRun(), fixtureRun({ ordinal: 1 })]),
        },
        {
            name: 'prompt without its sources',
            document: fixtureDocument([poisoned('prompt', {
                text: 'x'.repeat(12),
                fingerprint: promptFingerprint('x'.repeat(12)),
                length: 12,
            })]),
        },
        {
            name: 'prompt whose length exceeds its stack bound',
            document: fixtureDocument([poisoned('prompt', {
                text: 'x'.repeat(6_005),
                fingerprint: promptFingerprint('x'.repeat(6_005)),
                length: 6_005,
                sources: ['global', 'account', 'binding'],
            })]),
        },
    ];

    it('refuses every malformed document in the table', async () => {
        {
            for (const { name, document } of broken) {
                expect(parseRunsDocument(document), `must refuse: ${name}`).toBeNull();
            }
        }
    });

    it('refuses a row whose lease, reservation, session, or verification is malformed', async () => {
        {
            const patches: readonly (readonly [string, unknown])[] = [
                ['lease', { leaseId: '', holder: 'panel', issuedAt: STAMP, expiresAt: STAMP, attempt: 1 }],
                ['lease', { leaseId: 'l', holder: 'panel', issuedAt: 'never', expiresAt: STAMP, attempt: 1 }],
                ['lease', 'not an object'],
                ['reservation', { dispatchToken: '', attempt: 1, reservedAt: STAMP, resultDeadlineAt: STAMP }],
                [
                    'reservation',
                    { dispatchToken: 'dtk-a', attempt: 0, reservedAt: STAMP, resultDeadlineAt: STAMP, consumed: false },
                ],
                [
                    'session',
                    { sessionId: 'ses_1', attachmentId: 'mt-run-0', dispatchedAt: STAMP, title: 7, sourceUrl: 'u' },
                ],
                ['session', {
                    sessionId: '', attachmentId: 'mt-run-0', dispatchedAt: STAMP, title: 't', sourceUrl: 'u' }],
                ['verification', { observedAgent: null, expectedAgent: null, ok: true, note: null, at: STAMP }],
                ['verification', { observedAgent: null, expectedAgent: 42, ok: true, note: null, at: STAMP }],
                ['verification', { observedAgent: null, expectedAgent: 'pm', ok: 'yes', note: null, at: STAMP }],
                ['sourceReferences', [{ ...fixtureReference(), origin: 'comment:abc' }]],
                ['sourceReferences', [{ ...fixtureReference(), kind: 'assignmente' }]],
                ['sourceReferences', [{ ...fixtureReference(), detectedAt: 'never' }]],
                ['attempts', [{ ...attemptRecord(), attempt: 0 }]],
                ['attempts', [{ ...attemptRecord(), outcome: 'exploded' }]],
            ];

            for (const [field, value] of patches) {
                expect(parseRun(poisoned(field, value))).toBeNull();
            }
        }
    });

    it('accepts every nullable sub-object written as null, and as absent', async () => {
        {
            expect(parseRun(fixtureRun())).not.toBeNull();
            expect(parseRun(without('lease', 'reservation', 'session', 'verification'))).not.toBeNull();
            // A read-back against no baseline is a record, not a malformed one:
            // `expectedAgent: ''` is the documented *no baseline configured*
            // (002 FR-029 as amended), so a run document never quarantines over it.
            const blankBaseline = fixtureRun({
                verification: { observedAgent: 'executor', expectedAgent: '', ok: false, note: null, at: STAMP },
            });
            expect(parseRun(blankBaseline)).not.toBeNull();
        }
    });

    it('refuses contradictory attempt history that records a session on a non-dispatched run', async () => {
        {
            const createdSessionAttempt = {
                ...attemptRecord(),
                dispatchToken: 'dtk-0123456789abcdef0123456789abcdef',
                reservedAt: STAMP,
                outcome: 'dispatched' as const,
                sessionId: 'ses_created',
                resultReportedAt: STAMP,
            };
            const pending = fixtureRun({ attempts: [createdSessionAttempt] });

            expect(parseRun(pending)).toBeNull();
            expect(runHistoryIndicatesSession(pending)).toBe(true);
        }
    });

    it('refuses an attempt session id that conflicts with the run session pointer', async () => {
        {
            const session = {
                sessionId: 'ses_pointer',
                attachmentId: fixtureRun().correlationId,
                dispatchedAt: STAMP,
                title: 'Issue session',
                sourceUrl: 'https://github.com/acme/widget/issues/12',
                worktree: null,
            };
            const run = fixtureRun({
                state: 'dispatched',
                stateReason: 'session created',
                session,
                attempts: [{
                    ...attemptRecord(),
                    outcome: 'dispatched',
                    sessionId: 'ses_other',
                    resultReportedAt: STAMP,
                }],
            });

            expect(parseRun(run)).toBeNull();
        }
    });

    it('accepts a blocked state whose reason the panel has never produced', async () => {
        {
            const run = parseRun(fixtureRun({
                state: 'blocked:policy', stateReason: 'no policy allowed this dispatch' }));

            expect(run?.state).toBe('blocked:policy');
        }
    });


    it('accepts a reference that records a comment id as its origin', async () => {
        {
            const reference = { ...fixtureReference(), kind: 'mention' as const, origin: 'comment:4242' as const };
            const run = parseRun(fixtureRun({ sourceReferences: [reference] }));

            expect(run?.sourceReferences).toEqual([reference]);
        }
    });

    it('reads a capped run whose overflow is counted rather than hidden', async () => {
        {
            const capped = withReferences(MAX_SOURCE_REFERENCES + 7);
            const run = parseRun(capped);

            expect(run?.sourceReferences).toHaveLength(MAX_SOURCE_REFERENCES);
            expect(run?.referenceCount).toBe(MAX_SOURCE_REFERENCES + 7);
            expect(run?.referencesNotRetained).toBe(7);
            expect(run?.referencesTruncated).toBe(true);
        }
    });

});

/* ------------------------------------------------------------------------- *
 * The run model's two actor members (002 FR-043, FR-044; 003 FR-079, FR-080)
 *
 * A reference's actor is what the authorization gate judges, so it rides the
 * run; the policy shape is what the two admitted audit rows report, so it rides
 * the run too. Both are **absentable** — a run stored before either existed is
 * history, and refusing it would quarantine the whole document — and both are
 * **validated when present**, because defaulting an unreadable attribution to a
 * guess would record an inference as a fact (002 NFR-011).
 * ------------------------------------------------------------------------- */

/** A reference carrying a direct attribution, as the enqueue path writes one. */
function attributedReference(overrides: Partial<SourceReference> = {}): SourceReference {
    return {
        ...fixtureReference(),
        actorLogin: 'alice',
        actorAttribution: 'direct',
        ...overrides,
    };
}

describe('the run model gains the actor and the policy shape (003 FR-079, FR-080)', () => {
    it('round-trips an attributed reference and both policy words', async () => {
        {
            const reference = attributedReference({ actorAttribution: 'subject-author' });
            const document = fixtureDocument([
                fixtureRun({ sourceReferences: [reference], actorPolicy: 'restricted' }),
                fixtureRun({ subjectNumber: 13, actorPolicy: 'open' }),
                fixtureRun({ subjectNumber: 14, actorPolicy: null }),
            ]);

            const result = await readBack(document);

            expect(result.status).toBe('ok');
            const runs = result.status === 'ok' ? result.value.runs : [];
            expect(runs.map((run) => run.actorPolicy)).toEqual(['restricted', 'open', null]);
            expect(runs[0]?.sourceReferences).toEqual([reference]);
        }
    });

    it('reads a run stored before either member existed (003 FR-080\'s reach)', async () => {
        {
            const row = without('actorPolicy');
            row.sourceReferences = [{ ...fixtureReference() }];

            const run = parseRun(row);

            expect(run).not.toBeNull();
            expect(run?.actorPolicy).toBeNull();
            // Absence reads as *no attribution recorded* — a third thing, never
            // silently becoming a login or a basis (002 FR-044, NFR-011).
            expect(run?.sourceReferences[0]).not.toHaveProperty('actorLogin');
            expect(run?.sourceReferences[0]).not.toHaveProperty('actorAttribution');
        }
    });

    it('refuses an unknown basis and an unusable login on a stored reference', async () => {
        {
            const bases: readonly unknown[] = ['subject_author', 'none', '', 7, null];
            for (const actorAttribution of bases) {
                const reference = { ...attributedReference(), actorAttribution };
                expect(
                    parseRun(poisoned('sourceReferences', [reference])),
                    `basis ${String(actorAttribution)}`,
                ).toBeNull();
            }

            const logins: readonly unknown[] = ['', 7, null];
            for (const actorLogin of logins) {
                const reference = { ...attributedReference(), actorLogin };
                expect(
                    parseRun(poisoned('sourceReferences', [reference])),
                    `login ${String(actorLogin)}`,
                ).toBeNull();
            }
        }
    });

    it('refuses an `actorPolicy` outside the closed two-word union', async () => {
        {
            const stored: readonly unknown[] = ['Open', 'everyone', '', 1, {}, []];
            for (const actorPolicy of stored) {
                expect(parseRun(poisoned('actorPolicy', actorPolicy)), `policy ${String(actorPolicy)}`).toBeNull();
            }

            // The two legal words and the documented `null` all parse.
            expect(parseRun(poisoned('actorPolicy', null))?.actorPolicy).toBeNull();
        }
    });

});
