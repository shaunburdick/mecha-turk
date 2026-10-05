/**
 * Dispatch-attempt record tests (003 T-019, FR-024, FR-025, NFR-107).
 *
 * The record is the only thing a remount has to reconcile from, so these
 * tests hold four promises: an absent key reads as empty rather than as a
 * failure (wipe semantics), a present-but-corrupt key refuses rather than
 * half-applying (fail closed), the cap evicts the oldest *acknowledged*
 * attempt while never taking an unacknowledged one, and a stored
 * `dispatchToken` passes the redaction guard byte-identically while a real
 * credential beside it still throws.
 *
 * Everything runs offline against the storage double; no host, no network.
 */

import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@openchamber/sdk';
import {
    DISPATCH_SCHEMA_VERSION,
    DISPATCH_STORAGE_KEY,
    MAX_RECORDED_ATTEMPTS,
    acknowledgeAttempt,
    acknowledgeDispatch,
    appendAttempt,
    loadDispatchRecord,
    readDispatchRecord,
    recordDispatchOutcome,
    unacknowledgedAttempts,
} from '../src/dispatch-record.ts';
import type { DispatchAttemptRecord, DispatchRecordDocument } from '../src/dispatch-record.ts';
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

/** A credential-shaped value the redaction guard must keep refusing. */
const PAT = 'ghp_abcdefghijklmnopqrstuvwx';

/** RFC 3339 stamp every fixture record carries. */
const RECORDED_AT = '2026-09-29T10:00:00.000Z';

/**
 * Build one stored attempt.
 *
 * @returns A complete, parseable record.
 */
function attempt(overrides: Partial<DispatchAttemptRecord> = {}): DispatchAttemptRecord {
    return {
        correlationId: CORRELATION,
        runKey: RUN_KEY,
        attempt: 1,
        dispatchToken: TOKEN,
        outcome: 'dispatched',
        sessionId: 'ses_1',
        reason: null,
        recordedAt: RECORDED_AT,
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

/**
 * Serialize a document exactly as the host stores it.
 *
 * @param doc - Document to place in storage.
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
    it('stores the outcome with acknowledged false, before any report', async () => {
        {
            const { rt, storage } = runtimeWith();

            const isWritten = await recordDispatchOutcome(rt, {
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
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

            expect(await acknowledgeDispatch({ rt, correlationId: CORRELATION, attempt: 1 })).toBe(true);

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

            expect(await acknowledgeDispatch({ rt, correlationId: CORRELATION, attempt: 4 })).toBe(false);
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
                // Hand-edited storage carrying a credential: the record still parses
                // (a reason is a reason), and the redaction guard is what stops it
                // from being written back out.
                [DISPATCH_STORAGE_KEY]: storedAttempts(attempt({
                    outcome: 'failed', sessionId: null, reason: PAT })),
            });

            expect(await recordDispatchOutcome(rt, {
                correlationId: CORRELATION,
                runKey: RUN_KEY,
                attempt: 1,
                dispatchToken: TOKEN,
                outcome: { kind: 'failed', reason: 'no-session' },
            })).toBe(false);
            expect(storage.operations).not.toContain(`set:${DISPATCH_STORAGE_KEY}`);
        }
    });

});

describe('acknowledgeAttempt (pure flip)', () => {
    it('keys the flip on correlation id and attempt together', () => {
        const start = document([attempt({ attempt: 1 }), attempt({ correlationId: OTHER_CORRELATION, attempt: 1 })]);

        const next = acknowledgeAttempt({ document: start, correlationId: OTHER_CORRELATION, attempt: 1 });

        expect(next.attempts.map((entry) => entry.acknowledged)).toEqual([false, true]);
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
