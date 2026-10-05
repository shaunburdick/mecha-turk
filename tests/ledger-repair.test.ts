import { describe, expect, it } from 'vitest';
import { GUEST_STORAGE_VALUE_BYTES } from '@openchamber/sdk';
import { utf8ByteLength } from '../src/json.ts';
import { fitLedgerToByteBudget, LEDGER_BYTE_BUDGET, repairLedger } from '../src/ledger-repair.ts';
import { appendEntry, createLedger, MAX_LEDGER_ENTRIES, serializeLedger } from '../src/ledger.ts';
import type { PanelLedger } from '../src/ledger.ts';
import { RedactionError } from '../src/redaction.ts';

/** Correlation identifier used by the fixture ledger. */
const CORRELATION = '2f6a4f0e-1e4c-4a6f-8a3a-0b1c2d3e4f50';

/** Timestamp stamped on every fixture entry. */
const T0 = '2026-09-26T12:00:00.000Z';

/** A character that costs one UTF-16 unit but three UTF-8 bytes. */
const WIDE_CHARACTER = '€';

/** Detail value length that sits exactly at the ledger's per-value cap, in characters. */
const WIDE_VALUE_LENGTH = 200;

/** Length of the token body used by the redaction fixtures. */
const TOKEN_BODY = 40;

/**
 * Build an empty ledger for these tests.
 *
 * @returns A ledger with no entries yet.
 */
function emptyLedger(): PanelLedger {
    return createLedger({
        correlationId: CORRELATION,
        panelGeneration: 1,
        storagePresentBeforeMount: false,
        createdAt: T0,
    });
}

/**
 * Build a ledger that is over the host's byte limit but under its UTF-16 length.
 *
 * Wide characters are the point: `String.length` counts them as two units while
 * the host counts four bytes, so a ledger can look small in units and still be
 * one the host refuses.
 *
 * @returns A ledger no larger than the entry cap allows.
 */
function wideLedger(): PanelLedger {
    let ledger = emptyLedger();
    const detail = { note: WIDE_CHARACTER.repeat(WIDE_VALUE_LENGTH) };
    for (let index = 0; index < MAX_LEDGER_ENTRIES; index += 1) {
        ledger = appendEntry(ledger, { at: T0, kind: 'error', detail });
    }

    return ledger;
}

/**
 * Capture the error `serializeLedger` raises for a ledger.
 *
 * @param ledger - Ledger that must not serialize.
 * @returns The thrown error.
 */
function serializeFailure(ledger: PanelLedger): Error {
    try {
        serializeLedger(ledger);
    } catch (cause) {
        if (cause instanceof Error) {
            return cause;
        }
    }

    throw new Error('expected serializeLedger to refuse this ledger');
}

describe('serializeLedger size gate', () => {
    it('measures the ledger in UTF-8 bytes the way the host does', () => {
        {
            const ledger = wideLedger();
            const json = JSON.stringify(ledger);

            expect(json.length).toBeLessThan(GUEST_STORAGE_VALUE_BYTES);
            expect(utf8ByteLength(json)).toBeGreaterThan(GUEST_STORAGE_VALUE_BYTES);
            expect(() => serializeLedger(ledger)).toThrow('byte host.storage value limit');
        }
        {
            const repair = fitLedgerToByteBudget(emptyLedger());

            expect(repair.evicted).toBe(0);
            expect(repair.ledger.entries).toHaveLength(0);
            expect(utf8ByteLength(JSON.stringify(repair.ledger))).toBeLessThanOrEqual(LEDGER_BYTE_BUDGET);
        }
    });
});

describe('repairLedger', () => {
    it('drops the oldest entries until the ledger fits the byte budget', () => {
        {
            const ledger = wideLedger();
            const repair = repairLedger({ ledger, cause: serializeFailure(ledger) });

            expect(repair?.evicted).toBeGreaterThan(0);
            expect(repair?.quarantined).toBe(0);
            expect(repair?.ledger.entries.length).toBeLessThan(ledger.entries.length);
            expect(repair?.ledger.entries.at(-1)).toEqual(ledger.entries.at(-1));
            expect(repair?.ledger.correlationId).toBe(ledger.correlationId);
            expect(repair?.ledger.panelGeneration).toBe(ledger.panelGeneration);
            expect(() => serializeLedger(repair?.ledger ?? ledger)).not.toThrow();
            expect(utf8ByteLength(JSON.stringify(repair?.ledger ?? ledger))).toBeLessThanOrEqual(LEDGER_BYTE_BUDGET);
        }
        {
            const token = `ghp_${'a'.repeat(TOKEN_BODY)}`;
            let ledger = emptyLedger();
            ledger = appendEntry(ledger, { at: T0, kind: 'poll', detail: { inspected: 3 } });
            ledger = appendEntry(ledger, { at: T0, kind: 'error', detail: { note: token } });
            const failure = serializeFailure(ledger);
            expect(failure).toBeInstanceOf(RedactionError);

            const repair = repairLedger({ ledger, cause: failure });

            expect(repair?.quarantined).toBe(1);
            expect(repair?.evicted).toBe(0);
            expect(repair?.ledger.entries).toHaveLength(ledger.entries.length);
            expect(repair?.ledger.entries.at(-1)?.kind).toBe('error');
            expect(repair?.ledger.entries.at(-1)?.detail.note).toBe('[redacted:github-token-classic]');
            expect(repair?.ledger.entries.at(-2)?.detail.inspected).toBe(3);
            expect(() => serializeLedger(repair?.ledger ?? ledger)).not.toThrow();
        }
        {
            const repair = repairLedger({ ledger: emptyLedger(), cause: new Error('host refused the write') });

            expect(repair).toBeNull();
        }
    });
});
