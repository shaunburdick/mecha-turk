import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@openchamber/sdk';
import {
    appendEntry,
    analyzePollingGap,
    assertLedgerRedacted,
    createLedger,
    isLifecyclePhase,
    ledgerTail,
    readLedger,
    recordPhase,
    serializeLedger,
    MAX_DETAIL_CHARS,
    MAX_LEDGER_ENTRIES,
    LEDGER_SCHEMA_VERSION,
} from '../src/ledger.ts';
import type { LifecyclePhase, SpikeLedger } from '../src/ledger.ts';
import { RedactionError } from '../src/redaction.ts';

/** Start timestamp for every timeline in these tests. */
const T0 = '2026-09-26T12:00:00.000Z';

/** Milliseconds in one second, used to build RFC 3339 offsets. */
const MS_PER_SECOND = 1000;

/** Gap measured between the closed and reopened markers in the S6 tests. */
const GAP_MS = 30_000;

/** Correlation identifier used by the fixture ledger. */
const CORRELATION = '2f6a4f0e-1e4c-4a6f-8a3a-0b1c2d3e4f50';

/** Issue number referenced by the fixture entries. */
const ISSUE_NO = 42;

/** The mounted phase, the first entry every fixture ledger carries. */
const MOUNTED: LifecyclePhase = 'mounted';

/** The five lifecycle phases the spike records, in experiment order. */
const PHASES: readonly LifecyclePhase[] = [MOUNTED, 'closed', 'paused', 'removed', 'server-switch'];

/** Length of the token body used by the redaction failure test. */
const TOKEN_BODY = 40;

/**
 * Build a timestamp offset from the fixture start.
 *
 * @param seconds - Seconds to add to `T0`.
 * @returns An RFC 3339 timestamp.
 */
function at(seconds: number): string {
    return new Date(Date.parse(T0) + seconds * MS_PER_SECOND).toISOString();
}

/**
 * Parse a serialized ledger into a JSON value for the reader under test.
 *
 * @param json - Serialized ledger.
 * @returns The parsed value.
 */
function parseJson(json: string): JsonValue {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') {
        throw new Error('fixture ledger did not serialize to an object');
    }

    return parsed as JsonValue;
}

/**
 * Deep-clone a ledger as a JSON value so a test can corrupt it safely.
 *
 * @param ledger - Ledger to clone.
 * @returns The clone, shaped as JSON.
 */
function cloneAsJson(ledger: SpikeLedger): Record<string, JsonValue> {
    const parsed = parseJson(serializeLedger(ledger));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('fixture ledger did not serialize to an object');
    }

    return parsed;
}

/**
 * Create the fixture ledger used across these tests.
 *
 * @returns A ledger with one mounted phase entry.
 */
function fixtureLedger(): SpikeLedger {
    const ledger = createLedger({
        correlationId: CORRELATION,
        panelGeneration: 1,
        storagePresentBeforeMount: false,
        createdAt: T0,
    });

    return recordPhase(ledger, { phase: MOUNTED, at: T0, note: 'first mount' });
}

describe('createLedger', () => {
    it('starts empty with the documented schema version', () => {
        const ledger = fixtureLedger();

        expect(ledger.schemaVersion).toBe(LEDGER_SCHEMA_VERSION);
        expect(ledger.entries).toHaveLength(1);
        expect(ledger.correlationId).toBe(CORRELATION);
        expect(ledger.storagePresentBeforeMount).toBe(false);
    });
});

describe('appendEntry', () => {
    it('assigns monotonic sequence numbers (+5 cases)', () => {
        // case: assigns monotonic sequence numbers
        {
            let ledger = fixtureLedger();
            ledger = appendEntry(ledger, { at: at(1), kind: 'poll', detail: { inspected: 3 } });
            ledger = appendEntry(ledger, { at: at(2), kind: 'poll', detail: { inspected: 3 } });

            expect(ledger.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        }
        // case: inherits the ledger correlation id and generation when not supplied
        {
            const ledger = appendEntry(fixtureLedger(), { at: at(1), kind: 'poll', detail: { inspected: 1 } });

            expect(ledger.entries.at(-1)?.correlationId).toBe(CORRELATION);
            expect(ledger.entries.at(-1)?.panelGeneration).toBe(1);
        }
        // case: caps the ledger and drops the oldest entries first
        {
            let ledger = fixtureLedger();
            const extra = MAX_LEDGER_ENTRIES * 2;
            for (let index = 0; index < extra; index += 1) {
                ledger = appendEntry(ledger, { at: at(index), kind: 'poll', detail: { inspected: index } });
            }

            expect(ledger.entries).toHaveLength(MAX_LEDGER_ENTRIES);
            expect(ledger.entries[0]?.seq).toBeGreaterThan(1);
            expect(ledger.entries.at(-1)?.seq).toBe(extra + 1);
        }
        // case: truncates over-long detail values
        {
            const long = 'x'.repeat(MAX_DETAIL_CHARS * 2);
            const ledger = appendEntry(fixtureLedger(), { at: at(1), kind: 'error', detail: { error: long } });
            const detail = ledger.entries.at(-1)?.detail;

            expect(String(detail?.error)).toHaveLength(MAX_DETAIL_CHARS);
        }
        // case: strips credential-named detail keys
        {
            const ledger = appendEntry(fixtureLedger(), {
                at: at(1),
                kind: 'error',
                detail: { token: 'ghp_secret', error: 'boom' },
            });
            const detail = ledger.entries.at(-1)?.detail;

            expect(detail).toEqual({ error: 'boom' });
        }
        // case: redacts a secret-shaped error message as the entry is appended
        {
            const token = `ghp_${'a'.repeat(TOKEN_BODY)}`;
            const ledger = appendEntry(fixtureLedger(), { at: at(1), kind: 'error', detail: {
                error: `boom ${token}` } });
            const detail = ledger.entries.at(-1)?.detail;

            expect(detail?.error).toBe('boom [redacted:github-token-classic]');
            expect(() => serializeLedger(ledger)).not.toThrow();
        }
    });
});

describe('recordPhase', () => {
    it('records every lifecycle phase the experiment require… (+1 cases)', () => {
        // case: records every lifecycle phase the experiment requires
        {
            let ledger = fixtureLedger();

            for (const phase of PHASES) {
                ledger = recordPhase(ledger, { phase, at: at(1), note: phase });
            }

            const recorded = ledger.entries.filter((entry) => entry.kind === 'phase').map((entry) => entry.phase);
            expect(recorded).toEqual([MOUNTED, ...PHASES]);
        }
        // case: round-trips every phase through serialization
        {
            let ledger = fixtureLedger();
            for (const phase of PHASES) {
                ledger = recordPhase(ledger, { phase, at: at(1) });
            }

            const restored = readLedger(parseJson(serializeLedger(ledger)));
            expect(restored).toEqual(ledger);
        }
    });
});

describe('serializeLedger', () => {
    it('produces plain JSON that reads back unchanged (+2 cases)', () => {
        // case: produces plain JSON that reads back unchanged
        {
            const ledger = fixtureLedger();
            expect(readLedger(parseJson(serializeLedger(ledger)))).toEqual(ledger);
        }
        // case: passes the redaction assertion for clean content
        {
            expect(() => assertLedgerRedacted(fixtureLedger())).not.toThrow();
        }
        // case: refuses to serialize secret-shaped detail content
        {
            const token = `ghp_${'a'.repeat(TOKEN_BODY)}`;
            const ledger = appendEntry(fixtureLedger(), { at: at(1), kind: 'error', detail: { note: token } });

            expect(() => serializeLedger(ledger)).toThrow(RedactionError);
        }
    });
});

describe('readLedger', () => {
    it('returns null for a missing value (+3 cases)', () => {
        // case: returns null for a missing value
        {
            expect(readLedger()).toBeNull();
        }
        // case: returns null for a foreign schema version
        {
            const stored = cloneAsJson(fixtureLedger());
            stored.schemaVersion = 'other';
            expect(readLedger(stored)).toBeNull();
        }
        // case: returns null when an entry carries an unknown kind
        {
            const ledger = appendEntry(fixtureLedger(), { at: at(1), kind: 'poll', detail: {} });
            const stored = cloneAsJson(ledger);
            const { entries } = stored;
            if (Array.isArray(entries)) {
                const first = entries.at(-1);
                if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
                    (first as Record<string, JsonValue>).kind = 'invented';
                }
            }

            expect(readLedger(stored)).toBeNull();
        }
        // case: returns null when a detail value is not a scalar
        {
            const stored = cloneAsJson(fixtureLedger());
            const { entries } = stored;
            if (Array.isArray(entries)) {
                const first = entries.at(-1);
                if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
                    (first as Record<string, JsonValue>).detail = { nested: { nope: true } };
                }
            }

            expect(readLedger(stored)).toBeNull();
        }
    });
});

describe('analyzePollingGap', () => {
    it('reports polling-stopped when no poll ran inside the … (+3 cases)', () => {
        // case: reports polling-stopped when no poll ran inside the gap
        {
            const ledger = fixtureLedger();
            const result = analyzePollingGap({ ledger, closedAt: at(10), reopenedAt: at(40) });

            expect(result.verdict).toBe('polling-stopped');
            expect(result.pollEntriesInGap).toBe(0);
            expect(result.gapMs).toBe(GAP_MS);
        }
        // case: reports polling-continued when a poll ran inside the gap
        {
            let ledger = appendEntry(fixtureLedger(), { at: at(20), kind: 'poll', detail: { inspected: 1 } });
            ledger = recordPhase(ledger, { phase: 'closed', at: at(10) });
            const result = analyzePollingGap({ ledger, closedAt: at(10), reopenedAt: at(40) });

            expect(result.verdict).toBe('polling-continued');
            expect(result.pollEntriesInGap).toBe(1);
        }
        // case: ignores polls outside the interval
        {
            let ledger = appendEntry(fixtureLedger(), { at: at(5), kind: 'poll', detail: { inspected: 1 } });
            ledger = appendEntry(ledger, { at: at(50), kind: 'poll', detail: { inspected: 1 } });
            const result = analyzePollingGap({ ledger, closedAt: at(10), reopenedAt: at(40) });

            expect(result.verdict).toBe('polling-stopped');
            expect(result.pollEntriesInGap).toBe(0);
        }
        // case: reports no-gap when the interval is unusable
        {
            const ledger = fixtureLedger();
            const result = analyzePollingGap({ ledger, closedAt: at(40), reopenedAt: at(10) });

            expect(result.verdict).toBe('no-gap');
            expect(result.gapMs).toBe(0);
        }
    });
});

describe('ledgerTail', () => {
    it('returns the newest entries first (+1 cases)', () => {
        // case: returns the newest entries first
        {
            let ledger = fixtureLedger();
            ledger = appendEntry(ledger, { at: at(1), kind: 'poll', detail: {} });
            ledger = appendEntry(ledger, { at: at(2), kind: 'poll', detail: {} });

            expect(ledgerTail(ledger, 2).map((entry) => entry.seq)).toEqual([3, 2]);
        }
        // case: returns everything when asked for more than exists
        {
            expect(ledgerTail(fixtureLedger(), 10)).toHaveLength(1);
        }
    });
});

describe('isLifecyclePhase', () => {
    it('accepts the five documented phases (+1 cases)', () => {
        // case: accepts the five documented phases
        {
            for (const phase of ['mounted', 'closed', 'paused', 'removed', 'server-switch']) {
                expect(isLifecyclePhase(phase)).toBe(true);
            }
        }
        // case: rejects anything else
        {
            expect(isLifecyclePhase('booted')).toBe(false);
            expect(isLifecyclePhase(ISSUE_NO)).toBe(false);
        }
    });
});
