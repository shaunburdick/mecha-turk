/**
 * Dispatch-attempt record tests (003 T-019, FR-024, FR-025, NFR-107).
 *
 * The record is the only thing a remount has to reconcile from, so these
 * tests hold four promises: an absent key reads as empty rather than as a
 * failure (wipe semantics), a present-but-corrupt key refuses rather than
 * half-applying (fail closed), the cap evicts the oldest *acknowledged or
 * settled* attempt while never taking a record that is neither, and a stored
 * `dispatchToken` passes the redaction guard byte-identically while a real
 * credential beside it still throws.
 *
 * Everything runs offline against the storage double; no host, no network.
 */

import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@openchamber/sdk';
import {
    DISPATCH_SCHEMA_VERSION,
    DISPATCH_STORAGE_KEY,
    LEGACY_DISPATCH_SCHEMA_VERSION,
    MAX_RECORDED_ATTEMPTS,
    PREVIOUS_DISPATCH_SCHEMA_VERSION,
    acknowledgeDispatch,
    appendAttempt,
    deleteDispatchIntent,
    fillDispatchToken,
    loadDispatchRecord,
    readDispatchRecord,
    recordDispatchIntent,
    recordDispatchOutcome,
    settleAttempt,
    unacknowledgedAttempts,
} from '../src/dispatch-record.ts';
import type {
    DispatchAttemptRecord,
    DispatchRecordDocument,
    FollowUpDeliveryRecord,
} from '../src/dispatch-record.ts';
import { parseJsonValue } from '../src/json.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { RedactionError, assertRedacted } from '../src/redaction.ts';
import { createStorageDouble, createTestRuntime, fakeHost } from './support/panel.ts';
/** Correlation id used by the fixture attempt. */
const CORRELATION = 'mt-run-0123456789abcdef01234567';

/** Second run's correlation id, so one test can hold two attempts. */
const OTHER_CORRELATION = 'mt-run-89abcdef89abcdef89abcdef';

/** Run key matching {@link CORRELATION}. */
const RUN_KEY = 'github|77331|acme/widget|issue|7|0';

/** A token in the exact shape the service mints (`dtk-` + 32 hex). */
const TOKEN = `dtk-${'a1b2c3d4'.repeat(4)}`;

/** The reservation the fixture attempt belongs to. */
const LEASE_ID = 'lse-0123456789abcdef01234567';

/** A later reservation cycle reusing the same attempt number. */
const OTHER_LEASE_ID = 'lse-89abcdef89abcdef89abcdef';

/** A credential-shaped value the redaction guard must keep refusing. */
const PAT = 'ghp_abcdefghijklmnopqrstuvwx';

/** RFC 3339 stamp every fixture record carries. */
const RECORDED_AT = '2026-09-29T10:00:00.000Z';

/**
 * Build one stored attempt.
 */
function attempt(overrides: Partial<DispatchAttemptRecord> = {}): DispatchAttemptRecord {
    return {
        correlationId: CORRELATION,
        runKey: RUN_KEY,
        attempt: 1,
        leaseId: LEASE_ID,
        dispatchToken: TOKEN,
        projectId: 'prj_42',
        worktreeOption: 'generated',
        outcome: 'dispatched',
        sessionId: 'ses_1',
        reason: null,
        authorizedAt: RECORDED_AT,
        recordedAt: RECORDED_AT,
        settledAt: null,
        acknowledged: false,
        ...overrides,
    };
}

/**
 * Wrap attempts in a valid document.
 *
 * @param attempts - Records to carry, oldest first.
 * @returns The document.
 */
function document(attempts: readonly DispatchAttemptRecord[]): DispatchRecordDocument {
    return { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts };
}

/** A placeholder attempt: unknown, unacknowledged, no token, and not settled. */
function placeholder(overrides: Partial<DispatchAttemptRecord> = {}): DispatchAttemptRecord {
    return attempt({
        acknowledged: false,
        dispatchToken: null,
        outcome: 'unknown',
        sessionId: null,
        reason: null,
        authorizedAt: null,
        settledAt: null,
        ...overrides,
    });
}

/**
 * Serialize a document exactly as the host stores it.
 *
 * @returns The stored JSON value.
 */
function stored(doc: DispatchRecordDocument): JsonValue {
    return parseJsonValue(JSON.stringify(doc));
}

/**
 * The stored form of a document holding exactly these attempts.
 *
 * Three combinators of nesting — `stored(document([attempt(…)]))` — is one step
 * of setup, so it is written once here rather than at each of the twelve places
 * that need it.
 *
 * @param records - The attempts the document holds.
 * @returns The stored JSON value.
 */
function storedAttempts(...records: readonly DispatchAttemptRecord[]): JsonValue {
    return stored(document(records));
}

/**
 * Build a runtime whose storage the test pre-loads.
 *
 * @param initial - Values `host.storage.get` should answer with.
 * @returns The runtime plus the storage double's records.
 */
function runtimeWith(initial: Readonly<Record<string, JsonValue>> = {}): {
    /** Runtime under test. */
    readonly rt: PanelRuntime;
    /** Storage double holding the runtime's values. */
    readonly storage: ReturnType<typeof createStorageDouble>;
} {
    const storage = createStorageDouble(initial);

    return { rt: createTestRuntime(fakeHost({ storage: storage.storage })), storage };
}

/** One follow-up delivery record, as the panel stores it. */
function followUp(): FollowUpDeliveryRecord {
    return {
        deliveryId: 'dlv-1',
        correlationId: CORRELATION,
        sessionId: null,
        attempt: 1,
        nextAttemptAtMs: null,
        delivered: false,
        reason: null,
        parked: false,
        updatedAt: RECORDED_AT,
    };
}

/** The intent writer's input for the fixture attempt. */
const INTENT_INPUT = {
    correlationId: CORRELATION,
    runKey: RUN_KEY,
    attempt: 1,
    leaseId: LEASE_ID,
    projectId: 'prj_42',
    worktreeOption: 'new:mt-{number}',
} as const;

describe('v1/v2 → v3 reading (FR-024, AC-134)', () => {
    it('reads a dispatch-attempts-1 document as v3 with every attempt intact and no invented stamp', async () => {
        {
            const legacy = parseJsonValue(JSON.stringify({
                schemaVersion: LEGACY_DISPATCH_SCHEMA_VERSION,
                attempts: [
                    {
                        correlationId: CORRELATION,
                        runKey: RUN_KEY,
                        attempt: 1,
                        dispatchToken: TOKEN,
                        outcome: 'failed',
                        sessionId: null,
                        reason: 'no-session',
                        recordedAt: RECORDED_AT,
                        acknowledged: false,
                    },
                    {
                        correlationId: OTHER_CORRELATION,
                        runKey: RUN_KEY,
                        attempt: 2,
                        dispatchToken: TOKEN,
                        outcome: 'dispatched',
                        sessionId: 'ses_9',
                        reason: null,
                        recordedAt: RECORDED_AT,
                        acknowledged: true,
                    },
                ],
            }));
            const { rt } = runtimeWith({ [DISPATCH_STORAGE_KEY]: legacy });

            const read = await loadDispatchRecord(rt);

            expect(read.ok).toBe(true);
            if (!read.ok) {
                return;
            }

            expect(read.document.schemaVersion).toBe(DISPATCH_SCHEMA_VERSION);
            expect(read.document.attempts).toHaveLength(2);
            expect(read.document.attempts.map((row) => row.outcome)).toEqual(['failed', 'dispatched']);
            for (const row of read.document.attempts) {
                expect(row.authorizedAt).toBeNull();
                expect(row.leaseId).toBeNull();
                expect(row.projectId).toBeNull();
                expect(row.worktreeOption).toBeNull();
                expect(row.settledAt).toBeNull();
                expect(row.dispatchToken).toBe(TOKEN);
            }

            // The v1 stamp stays what it was — the outcome write's time — and is
            // never presented as the authorization time the row never held.
            expect(read.document.attempts[0]?.recordedAt).toBe(RECORDED_AT);
            expect(unacknowledgedAttempts(read.document).map((row) => row.attempt)).toEqual([1]);
        }
    });

    it('reads a dispatch-attempts-2 document whole, tokens required and stamps preserved', () => {
        const previous = parseJsonValue(JSON.stringify({
            schemaVersion: PREVIOUS_DISPATCH_SCHEMA_VERSION,
            attempts: [{
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: TOKEN,
                projectId: 'prj_42',
                worktreeOption: 'generated',
                outcome: 'unknown',
                sessionId: null,
                reason: null,
                authorizedAt: RECORDED_AT,
                recordedAt: RECORDED_AT,
                settledAt: null,
                acknowledged: false,
            }],
        }));

        const read = readDispatchRecord(previous);

        expect(read?.schemaVersion).toBe(DISPATCH_SCHEMA_VERSION);
        expect(read?.attempts).toHaveLength(1);
        expect(read?.attempts[0]).toMatchObject({
            dispatchToken: TOKEN,
            leaseId: LEASE_ID,
            authorizedAt: RECORDED_AT,
            outcome: 'unknown',
        });
    });

    it('refuses a dispatch-attempts-1 or -2 row whose token is null', () => {
        for (const schemaVersion of [LEGACY_DISPATCH_SCHEMA_VERSION, PREVIOUS_DISPATCH_SCHEMA_VERSION]) {
            const nullToken = parseJsonValue(JSON.stringify({
                schemaVersion,
                attempts: [{
                    correlationId: CORRELATION,
                    runKey: RUN_KEY,
                    attempt: 1,
                    dispatchToken: null,
                    outcome: 'failed',
                    sessionId: null,
                    reason: 'no-session',
                    recordedAt: RECORDED_AT,
                    acknowledged: false,
                }],
            }));

            expect(readDispatchRecord(nullToken), `${schemaVersion} could not write a null token`).toBeNull();
        }
    });

    it('refuses a dispatch-attempts-1 document carrying an unknown row whole', () => {
        const legacy = parseJsonValue(JSON.stringify({
            schemaVersion: LEGACY_DISPATCH_SCHEMA_VERSION,
            attempts: [{
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                dispatchToken: TOKEN,
                outcome: 'unknown',
                sessionId: null,
                reason: null,
                recordedAt: RECORDED_AT,
                acknowledged: false,
            }],
        }));

        // v1 could not record an unknown outcome, so the document is not a v1
        // document this build may half-apply.
        expect(readDispatchRecord(legacy)).toBeNull();
    });

    it('reads a pre-amendment v2 row with a null lease rather than refusing it', () => {
        const preAmendment = parseJsonValue(JSON.stringify({
            schemaVersion: PREVIOUS_DISPATCH_SCHEMA_VERSION,
            attempts: [{
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                dispatchToken: TOKEN,
                projectId: 'prj_42',
                worktreeOption: 'generated',
                outcome: 'failed',
                sessionId: null,
                reason: 'no-session',
                authorizedAt: RECORDED_AT,
                recordedAt: RECORDED_AT,
                settledAt: null,
                acknowledged: false,
            }],
        }));

        const preAmendmentRead = readDispatchRecord(preAmendment);

        expect(preAmendmentRead?.attempts[0]).toMatchObject({ leaseId: null, outcome: 'failed' });
    });
});

describe('loadDispatchRecord (absent is empty, corrupt is refused)', () => {
    it('reads a wiped or never-written key as an empty record', async () => {
        {
            const { rt } = runtimeWith();

            const read = await loadDispatchRecord(rt);

            expect(read.ok).toBe(true);
            if (read.ok) {
                expect(read.document.attempts).toEqual([]);
                expect(unacknowledgedAttempts(read.document)).toEqual([]);
            }
        }
    });

    it('refuses a present document this build must not half-apply', async () => {
        {
            const { rt } = runtimeWith({
                [DISPATCH_STORAGE_KEY]: { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts: [{ attempt: 1 }] },
            });

            expect(await loadDispatchRecord(rt)).toEqual({ ok: false });
        }
    });

    it('refuses an unknown schema version rather than guessing at it', async () => {
        {
            expect(readDispatchRecord({ schemaVersion: 'dispatch-attempts-99', attempts: [] })).toBeNull();
        }
    });

    it('reports a storage failure as unreadable rather than as "nothing to reconcile"', async () => {
        {
            const rt = createTestRuntime(
                fakeHost({
                    storage: {
                        ...createStorageDouble().storage,
                        get: () => Promise.reject(new Error('HOST_STORAGE_GONE')),
                    },
                }),
            );

            expect(await loadDispatchRecord(rt)).toEqual({ ok: false });
        }
    });

});

describe('recordDispatchOutcome (FR-024 ordering, write, read back)', () => {
    it('appends an outcome when the attempt holds no record', async () => {
        {
            const { rt, storage } = runtimeWith();

            const isWritten = await recordDispatchOutcome(rt, {
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: TOKEN,
                outcome: { kind: 'dispatched', sessionId: 'ses_1' },
            });

            expect(isWritten).toBe(true);
            expect(storage.operations).toEqual([`get:${DISPATCH_STORAGE_KEY}`, `set:${DISPATCH_STORAGE_KEY}`]);
            const read = await loadDispatchRecord(rt);
            expect(read.ok).toBe(true);
            if (read.ok) {
                expect(read.document.attempts).toHaveLength(1);
                expect(read.document.attempts[0]).toMatchObject({
                    correlationId: CORRELATION,
                    attempt: 1,
                    outcome: 'dispatched',
                    sessionId: 'ses_1',
                    reason: null,
                    acknowledged: false,
                });
                // Nothing to copy from: the append invents no context.
                expect(read.document.attempts[0]).toMatchObject({
                    projectId: null,
                    worktreeOption: null,
                    authorizedAt: null,
                });
            }
        }
    });

    it('stores a failure reason with no session id', async () => {
        {
            const { rt } = runtimeWith();

            await recordDispatchOutcome(rt, {
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: TOKEN,
                outcome: { kind: 'failed', reason: 'bootstrap-failed' },
            });

            const read = await loadDispatchRecord(rt);
            expect(read.ok).toBe(true);
            if (read.ok) {
                expect(read.document.attempts[0]).toMatchObject({
                    outcome: 'failed',
                    sessionId: null,
                    reason: 'bootstrap-failed',
                });
            }
        }
    });

    it('refuses to persist a record its own parser would reject', async () => {
        {
            const { rt, storage } = runtimeWith();

            const isWritten = await recordDispatchOutcome(rt, {
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: 'not-a-token',
                outcome: { kind: 'dispatched', sessionId: 'ses_1' },
            });

            expect(isWritten).toBe(false);
            expect(storage.operations).not.toContain(`set:${DISPATCH_STORAGE_KEY}`);
        }
    });

    it('appends newest last so a remount replays attempts in order', async () => {
        {
            const { rt } = runtimeWith();
            const isRecorded = async (attemptNumber: number): Promise<boolean> =>
                await recordDispatchOutcome(rt, {
                    correlationId: CORRELATION,
                    runKey: RUN_KEY,
                    attempt: attemptNumber,
                    leaseId: LEASE_ID,
                    dispatchToken: TOKEN,
                    outcome: { kind: 'failed', reason: 'no-session' },
                });

            expect(await isRecorded(1)).toBe(true);
            expect(await isRecorded(2)).toBe(true);

            const read = await loadDispatchRecord(rt);
            expect(read.ok).toBe(true);
            if (read.ok) {
                expect(read.document.attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
            }
        }
    });

});

describe('acknowledgeDispatch (2xx flips exactly one attempt)', () => {
    it('flips the named attempt and leaves every other record alone', async () => {
        {
            const { rt } = runtimeWith({
                [DISPATCH_STORAGE_KEY]: storedAttempts(
                    attempt({ attempt: 1, acknowledged: false }),
                    attempt({ correlationId: OTHER_CORRELATION, attempt: 1, acknowledged: false }),
                    attempt({ attempt: 2, acknowledged: false }),
                ),
            });

            expect(await acknowledgeDispatch({
                rt,
                correlationId: CORRELATION,
                attempt: 1,
                leaseId: LEASE_ID,
            })).toBe(true);

            const read = await loadDispatchRecord(rt);
            expect(read.ok).toBe(true);
            if (read.ok) {
                expect(read.document.attempts.map((entry) => entry.acknowledged)).toEqual([true, false, false]);
            }
        }
    });

    it('changes nothing — and writes nothing — for an attempt it never recorded', async () => {
        {
            const { rt, storage } = runtimeWith({
                [DISPATCH_STORAGE_KEY]: storedAttempts(attempt({ attempt: 3, acknowledged: false })),
            });

            expect(await acknowledgeDispatch({
                rt,
                correlationId: CORRELATION,
                attempt: 4,
                leaseId: LEASE_ID,
            })).toBe(false);
            expect(storage.operations).not.toContain(`set:${DISPATCH_STORAGE_KEY}`);
        }
    });

});

describe('cap and eviction (NFR-107, FR-024 durability)', () => {
    it('holds at 50 by evicting the oldest acknowledged record first', () => {
        {
            const full = document(
                Array.from({ length: MAX_RECORDED_ATTEMPTS }, (_unused, index) =>
                    attempt({ attempt: index + 1, acknowledged: true })),
            );

            const capped = appendAttempt(full, attempt({ attempt: 99, acknowledged: false }));

            expect(capped.attempts).toHaveLength(MAX_RECORDED_ATTEMPTS);
            expect(capped.attempts[0]?.attempt).toBe(2);
            expect(capped.attempts.at(-1)?.attempt).toBe(99);
            expect(capped.attempts.at(-1)?.acknowledged).toBe(false);
        }
        {
            const mixed = document([
                attempt({ attempt: 1, acknowledged: false }),
                ...Array.from({ length: MAX_RECORDED_ATTEMPTS - 1 }, (_unused, index) =>
                    attempt({ attempt: index + 2, acknowledged: true })),
            ]);

            const capped = appendAttempt(mixed, attempt({ attempt: 99, acknowledged: false }));

            expect(capped.attempts).toHaveLength(MAX_RECORDED_ATTEMPTS);
            expect(capped.attempts[0]).toMatchObject({ attempt: 1, acknowledged: false });
            expect(capped.attempts.at(-1)?.attempt).toBe(99);
        }
        {
            // Nothing is acknowledged, so there is no victim the contract permits;
            // dropping one would destroy the only evidence a session exists.
            const allOpen = document(
                Array.from({ length: MAX_RECORDED_ATTEMPTS + 5 }, (_unused, index) =>
                    attempt({ attempt: index + 1, acknowledged: false })),
            );

            const capped = appendAttempt(allOpen, attempt({ attempt: 999, acknowledged: false }));

            expect(capped.attempts).toHaveLength(MAX_RECORDED_ATTEMPTS + 6);
            expect(capped.attempts.every((entry) => !entry.acknowledged)).toBe(true);
        }
    });

    it('evicts a settled unacknowledged record and never one that is both unacknowledged and unsettled', () => {
        {
            const full = document([
                attempt({ attempt: 1, acknowledged: false, settledAt: RECORDED_AT }),
                ...Array.from({ length: MAX_RECORDED_ATTEMPTS - 1 }, (_unused, index) =>
                    attempt({ attempt: index + 2, acknowledged: true })),
            ]);

            const capped = appendAttempt(full, attempt({ attempt: 99 }));

            expect(capped.attempts).toHaveLength(MAX_RECORDED_ATTEMPTS);
            expect(capped.attempts.some((entry) => entry.attempt === 1)).toBe(false);
        }
        {
            const open = document([
                attempt({ attempt: 1, acknowledged: false, settledAt: null }),
                ...Array.from({ length: MAX_RECORDED_ATTEMPTS - 1 }, (_unused, index) =>
                    attempt({ attempt: index + 2, acknowledged: true })),
            ]);

            const capped = appendAttempt(open, attempt({ attempt: 99 }));

            expect(capped.attempts).toHaveLength(MAX_RECORDED_ATTEMPTS);
            expect(capped.attempts[0]).toMatchObject({ attempt: 1, settledAt: null });
            expect(capped.attempts.some((entry) => entry.attempt === 2)).toBe(false);
        }
    });

    it('keeps an unsettled placeholder as the cap\'s last victim, and evicts it once settled', () => {
        {
            const full = document(
                Array.from({ length: MAX_RECORDED_ATTEMPTS }, (_unused, index) =>
                    attempt({ attempt: index + 1, acknowledged: true })),
            );

            const capped = appendAttempt(full, placeholder({ attempt: 99 }));

            expect(capped.attempts).toHaveLength(MAX_RECORDED_ATTEMPTS);
            expect(capped.attempts.at(-1)).toMatchObject({ attempt: 99, dispatchToken: null, settledAt: null });
        }
        {
            // Nothing else is evictable, so a settled placeholder is the victim —
            // which is what makes settlement the way out of the pin.
            const full = document([
                placeholder({ attempt: 1, settledAt: RECORDED_AT }),
                ...Array.from({ length: MAX_RECORDED_ATTEMPTS - 1 }, (_unused, index) =>
                    placeholder({ attempt: index + 2 })),
            ]);

            const capped = appendAttempt(full, attempt({ attempt: 99, acknowledged: true }));

            expect(capped.attempts).toHaveLength(MAX_RECORDED_ATTEMPTS);
            expect(capped.attempts.some((entry) => entry.attempt === 1)).toBe(false);
        }
    });
});

describe('redaction posture (T-019, research §R3)', () => {
    it('passes a stored dispatch token byte-identically', async () => {
        {
            const json = JSON.stringify(document([attempt()]));

            expect(() => assertRedacted(DISPATCH_STORAGE_KEY, json)).not.toThrow();
            expect(json).toContain(TOKEN);
        }
    });

    it('still refuses a credential-shaped value sitting beside the token', async () => {
        {
            const json = JSON.stringify(document([attempt({ reason: PAT })]));

            expect(() => assertRedacted(DISPATCH_STORAGE_KEY, json)).toThrow(RedactionError);
        }
    });

    it('refuses to write a document the guard rejects', async () => {
        {
            const { rt, storage } = runtimeWith({
                // Hand-edited storage carrying a credential on another attempt: the
                // record still parses (a reason is a reason), and the redaction guard
                // is what stops it from being written back out beside the new one.
                [DISPATCH_STORAGE_KEY]: storedAttempts(attempt({
                    attempt: 2, outcome: 'failed', sessionId: null, reason: PAT })),
            });

            expect(await recordDispatchOutcome(rt, {
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: TOKEN,
                outcome: { kind: 'failed', reason: 'no-session' },
            })).toBe(false);
            expect(storage.operations).not.toContain(`set:${DISPATCH_STORAGE_KEY}`);
        }
    });

});

describe('the intent, the fill, and the outcome that replaces it (FR-024, AC-134)', () => {
    it('writes a null-token placeholder, fills it, then replaces it in place', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-09-29T10:00:00.000Z'));
            const { rt } = runtimeWith();

            expect(await recordDispatchIntent(rt, INTENT_INPUT)).toBe(true);
            const intent = await loadDispatchRecord(rt);
            expect(intent.ok).toBe(true);
            if (!intent.ok) {
                return;
            }

            expect(intent.document.attempts).toHaveLength(1);
            expect(intent.document.attempts[0]).toMatchObject({
                correlationId: CORRELATION,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: null,
                outcome: 'unknown',
                sessionId: null,
                reason: null,
                projectId: 'prj_42',
                worktreeOption: 'new:mt-{number}',
                authorizedAt: null,
                recordedAt: '2026-09-29T10:00:00.000Z',
                settledAt: null,
                acknowledged: false,
            });

            vi.setSystemTime(new Date('2026-09-29T10:00:01.000Z'));
            expect(await fillDispatchToken(rt, {
                correlationId: CORRELATION,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: TOKEN,
            })).toBe(true);

            const filled = await loadDispatchRecord(rt);
            expect(filled.ok).toBe(true);
            if (!filled.ok) {
                return;
            }

            expect(filled.document.attempts[0]).toMatchObject({
                dispatchToken: TOKEN,
                authorizedAt: '2026-09-29T10:00:01.000Z',
                recordedAt: '2026-09-29T10:00:01.000Z',
                outcome: 'unknown',
            });

            vi.setSystemTime(new Date('2026-09-29T10:00:05.000Z'));
            expect(await recordDispatchOutcome(rt, {
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: TOKEN,
                outcome: { kind: 'dispatched', sessionId: 'ses_1' },
            })).toBe(true);

            const resolved = await loadDispatchRecord(rt);
            expect(resolved.ok).toBe(true);
            if (!resolved.ok) {
                return;
            }

            // One attempt is one record, never two: the outcome replaced the intent.
            expect(resolved.document.attempts).toHaveLength(1);
            expect(resolved.document.attempts[0]).toMatchObject({
                outcome: 'dispatched',
                sessionId: 'ses_1',
                authorizedAt: '2026-09-29T10:00:01.000Z',
                recordedAt: '2026-09-29T10:00:05.000Z',
            });

            // The same reservation written again is an idempotent success and never
            // downgrades the resolved outcome to `unknown`.
            expect(await recordDispatchIntent(rt, INTENT_INPUT)).toBe(true);
            const reread = await loadDispatchRecord(rt);
            expect(reread.ok).toBe(true);
            if (reread.ok) {
                expect(reread.document.attempts[0]).toMatchObject({ outcome: 'dispatched', sessionId: 'ses_1' });
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('fills idempotently: the same token changes nothing', async () => {
        const { rt, storage } = runtimeWith();
        await recordDispatchIntent(rt, INTENT_INPUT);
        const fill = {
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
            dispatchToken: TOKEN,
        } as const;
        expect(await fillDispatchToken(rt, fill)).toBe(true);
        const before = JSON.stringify(storage.values.get(DISPATCH_STORAGE_KEY));
        const writes = storage.operations.filter((operation) => operation.startsWith('set:')).length;

        expect(await fillDispatchToken(rt, fill)).toBe(true);

        expect(storage.operations.filter((operation) => operation.startsWith('set:'))).toHaveLength(writes);
        expect(JSON.stringify(storage.values.get(DISPATCH_STORAGE_KEY))).toBe(before);
    });

    it('leaves the record byte-identical when the same reservation writes again', async () => {
        const { rt, storage } = runtimeWith();

        expect(await recordDispatchIntent(rt, INTENT_INPUT)).toBe(true);
        const before = JSON.stringify(storage.values.get(DISPATCH_STORAGE_KEY));
        const writes = storage.operations.filter((operation) => operation.startsWith('set:')).length;

        expect(await recordDispatchIntent(rt, INTENT_INPUT)).toBe(true);

        expect(storage.operations.filter((operation) => operation.startsWith('set:'))).toHaveLength(writes);
        expect(JSON.stringify(storage.values.get(DISPATCH_STORAGE_KEY))).toBe(before);
    });

    it('replaces a same-attempt record carrying a different lease instead of refusing it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-09-29T10:00:00.000Z'));
            const { rt } = runtimeWith();
            await recordDispatchIntent(rt, INTENT_INPUT);

            vi.setSystemTime(new Date('2026-09-29T11:00:00.000Z'));
            expect(await recordDispatchIntent(rt, { ...INTENT_INPUT, leaseId: OTHER_LEASE_ID })).toBe(true);

            const read = await loadDispatchRecord(rt);
            expect(read.ok).toBe(true);
            if (!read.ok) {
                return;
            }

            expect(read.document.attempts).toHaveLength(1);
            expect(read.document.attempts[0]).toMatchObject({
                attempt: 1,
                leaseId: OTHER_LEASE_ID,
                dispatchToken: null,
                outcome: 'unknown',
                authorizedAt: null,
                recordedAt: '2026-09-29T11:00:00.000Z',
                acknowledged: false,
            });
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not persist a second record at an attempt whose record carries another lease', async () => {
        const { rt, storage } = runtimeWith();
        await recordDispatchIntent(rt, { ...INTENT_INPUT, leaseId: OTHER_LEASE_ID });
        const writes = storage.operations.filter((operation) => operation.startsWith('set:')).length;

        expect(await recordDispatchOutcome(rt, {
            correlationId: CORRELATION,
            runKey: RUN_KEY,
            attempt: 1,
            leaseId: LEASE_ID,
            dispatchToken: TOKEN,
            outcome: { kind: 'dispatched', sessionId: 'ses_old' },
        })).toBe(true);

        const read = await loadDispatchRecord(rt);
        expect(read.ok).toBe(true);
        if (!read.ok) {
            return;
        }

        // One attempt is one record: the newer cycle's intent stands intact and
        // the superseded outcome was reported, never stored beside it.
        expect(storage.operations.filter((operation) => operation.startsWith('set:'))).toHaveLength(writes);
        expect(read.document.attempts).toHaveLength(1);
        expect(read.document.attempts[0]).toMatchObject({
            attempt: 1,
            leaseId: OTHER_LEASE_ID,
            outcome: 'unknown',
            sessionId: null,
        });
    });

    it('refuses to persist an intent its own parser would reject', async () => {
        {
            const { rt, storage } = runtimeWith();

            expect(await recordDispatchIntent(rt, { ...INTENT_INPUT, leaseId: '' })).toBe(false);
            expect(storage.operations).not.toContain(`set:${DISPATCH_STORAGE_KEY}`);
        }
    });

    it('refuses a v3 row whose token is present but malformed', () => {
        const malformed = parseJsonValue(JSON.stringify({
            schemaVersion: DISPATCH_SCHEMA_VERSION,
            attempts: [{
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                leaseId: LEASE_ID,
                dispatchToken: 'not-a-token',
                projectId: 'prj_42',
                worktreeOption: 'generated',
                outcome: 'unknown',
                sessionId: null,
                reason: null,
                authorizedAt: null,
                recordedAt: RECORDED_AT,
                settledAt: null,
                acknowledged: false,
            }],
        }));

        expect(readDispatchRecord(malformed)).toBeNull();
    });

    it('deletes only its own lease\'s null-token record and leaves a superseded cycle alone', async () => {
        const { rt } = runtimeWith({
            [DISPATCH_STORAGE_KEY]: storedAttempts(attempt({
                leaseId: OTHER_LEASE_ID,
                outcome: 'unknown',
                sessionId: null,
                reason: null,
                dispatchToken: TOKEN,
                settledAt: null,
            })),
        });

        expect(await deleteDispatchIntent(rt, {
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
        })).toBe(true);
        const afterMiss = await loadDispatchRecord(rt);
        expect(afterMiss.ok).toBe(true);
        if (afterMiss.ok) {
            expect(afterMiss.document.attempts).toHaveLength(1);
            expect(afterMiss.document.attempts[0]?.leaseId).toBe(OTHER_LEASE_ID);
        }

        await recordDispatchIntent(rt, INTENT_INPUT);
        expect(await deleteDispatchIntent(rt, {
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
        })).toBe(true);
        const deleted = await loadDispatchRecord(rt);
        expect(deleted.ok).toBe(true);
        if (deleted.ok) {
            expect(deleted.document.attempts).toHaveLength(0);
        }
    });

    it('refuses to delete a filled record', async () => {
        const { rt } = runtimeWith();
        await recordDispatchIntent(rt, INTENT_INPUT);
        await fillDispatchToken(rt, {
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
            dispatchToken: TOKEN,
        });

        expect(await deleteDispatchIntent(rt, {
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
        })).toBe(false);
        const read = await loadDispatchRecord(rt);
        expect(read.ok).toBe(true);
        if (read.ok) {
            expect(read.document.attempts[0]?.dispatchToken).toBe(TOKEN);
        }
    });

});

describe('follow-up preservation (FR-024, AC-134)', () => {
    it('carries the document\'s follow-ups unchanged through an intent and an outcome write', async () => {
        const record = followUp();
        const initial = parseJsonValue(JSON.stringify({
            schemaVersion: DISPATCH_SCHEMA_VERSION,
            attempts: [],
            followUps: [record],
        }));
        const { rt, storage } = runtimeWith({ [DISPATCH_STORAGE_KEY]: initial });
        const before = readDispatchRecord(initial)?.followUps;

        await recordDispatchIntent(rt, INTENT_INPUT);
        await recordDispatchOutcome(rt, {
            correlationId: CORRELATION,
            runKey: RUN_KEY,
            attempt: 1,
            leaseId: LEASE_ID,
            dispatchToken: TOKEN,
            outcome: { kind: 'failed', reason: 'no-session' },
        });

        const after = readDispatchRecord(storage.values.get(DISPATCH_STORAGE_KEY))?.followUps;
        expect(after).toEqual([record]);
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });

    it('keeps them through the pure writers too', () => {
        const start: DispatchRecordDocument = {
            schemaVersion: DISPATCH_SCHEMA_VERSION,
            attempts: [attempt()],
            followUps: [followUp()],
        };
        const unknown: DispatchRecordDocument = {
            ...start,
            attempts: [attempt({ outcome: 'unknown', sessionId: null, reason: null, settledAt: null })],
        };

        expect(appendAttempt(start, attempt({ attempt: 2 })).followUps).toEqual([followUp()]);
        const settled = settleAttempt({
            document: unknown,
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
            at: RECORDED_AT,
        });
        expect(settled?.followUps).toEqual([followUp()]);
    });
});

describe('settleAttempt (FR-045)', () => {
    it('writes settledAt only onto an unsettled unknown record, leaving its outcome unknown', () => {
        const unknown = attempt({ outcome: 'unknown', sessionId: null, reason: null, settledAt: null });

        const settled = settleAttempt({
            document: document([unknown]),
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
            at: RECORDED_AT,
        });

        const alreadyResolved = settleAttempt({
            document: document([attempt()]),
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
            at: RECORDED_AT,
        });
        const alreadySettled = settleAttempt({
            document: document([{ ...unknown, settledAt: RECORDED_AT }]),
            correlationId: CORRELATION,
            attempt: 1,
            leaseId: LEASE_ID,
            at: RECORDED_AT,
        });

        expect(settled?.attempts[0]).toMatchObject({ outcome: 'unknown', settledAt: RECORDED_AT });
        expect(alreadyResolved).toBeNull();
        expect(alreadySettled).toBeNull();
    });
});

describe('unacknowledgedAttempts (the FR-025 set)', () => {
    it('is exactly the records reconciliation still owes', () => {
        const start = document([
            attempt({ attempt: 1, acknowledged: true }),
            attempt({ attempt: 2, acknowledged: false }),
            attempt({ attempt: 3, acknowledged: false }),
        ]);

        expect(unacknowledgedAttempts(start).map((entry) => entry.attempt)).toEqual([2, 3]);
    });
});
