import { describe, expect, it } from 'vitest';
import { analyzeLastCloseGap, buildMountContext } from '../src/lifecycle.ts';
import { appendEntry, createLedger, recordPhase } from '../src/ledger.ts';
import type { PanelLedger } from '../src/ledger.ts';

/** Correlation identifier of the fixture ledger. */
const CORRELATION = '3d1b7a1c-0d1e-4f2a-8b3c-4d5e6f7a8b9c';

/** Start timestamp for the lifecycle timelines. */
const T0 = '2026-09-26T12:00:00.000Z';

/** Milliseconds in one second, used to build RFC 3339 offsets. */
const MS_PER_SECOND = 1000;

/** Gap between the closed marker and the mount that analysed it. */
const GAP_MS = 30000;

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
 * Create a ledger whose first entry is the mounted phase.
 *
 * @returns The fixture ledger.
 */
function fixtureLedger(): PanelLedger {
    const ledger = createLedger({
        correlationId: CORRELATION,
        panelGeneration: 1,
        storagePresentBeforeMount: true,
        createdAt: T0,
    });

    return recordPhase(ledger, { phase: 'mounted', at: T0 });
}

describe('buildMountContext', () => {
    it('treats missing storage as a first generation (+1 cases)', () => {
        // case: treats missing storage as a first generation
        {
            const context = buildMountContext(null);

            expect(context).toEqual({
                panelGeneration: 1,
                storagePresent: false,
                priorCorrelationId: null,
                priorCreatedAt: null,
            });
        }
        // case: continues the generation of a stored ledger
        {
            const context = buildMountContext(fixtureLedger());

            expect(context.panelGeneration).toBe(2);
            expect(context.storagePresent).toBe(true);
            expect(context.priorCorrelationId).toBe(CORRELATION);
            expect(context.priorCreatedAt).toBe(T0);
        }
    });
});

describe('analyzeLastCloseGap', () => {
    it('has no baseline when storage was empty (+3 cases)', () => {
        // case: has no baseline when storage was empty
        {
            expect(analyzeLastCloseGap({ prior: null, mountedAt: at(60) })).toBeNull();
        }
        // case: has no baseline for an empty ledger
        {
            const empty = createLedger({
                correlationId: CORRELATION,
                panelGeneration: 1,
                storagePresentBeforeMount: false,
                createdAt: T0,
            });

            expect(analyzeLastCloseGap({ prior: empty, mountedAt: at(60) })).toBeNull();
        }
        // case: uses the recorded closed entry as the baseline
        {
            let ledger = fixtureLedger();
            ledger = recordPhase(ledger, { phase: 'closed', at: at(10) });

            const gap = analyzeLastCloseGap({ prior: ledger, mountedAt: at(40) });

            expect(gap?.verdict).toBe('polling-stopped');
            expect(gap?.closedAt).toBe(at(10));
            expect(gap?.gapMs).toBe(GAP_MS);
        }
        // case: falls back to the last stored entry when no closed entry survived
        {
            let ledger = fixtureLedger();
            ledger = appendEntry(ledger, { at: at(5), kind: 'poll', detail: { inspected: 1 } });

            const gap = analyzeLastCloseGap({ prior: ledger, mountedAt: at(20) });

            expect(gap?.closedAt).toBe(at(5));
            expect(gap?.pollEntriesInGap).toBe(0);
            expect(gap?.verdict).toBe('polling-stopped');
        }
    });
});

