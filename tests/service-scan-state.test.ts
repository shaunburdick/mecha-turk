/**
 * Scan-state persistence tests (MVP fix 1 — quarantine storm, 2026-09-27).
 *
 * The loop records `lastScanAt: null` for a binding that has never completed
 * a successful scan (a skip stores the reason with no stamp), and the
 * operator's on-disk file is exactly that shape:
 * `{bindings:{<id>:{lastScanAt:null,lastError:'auth-failed'}}}`. The parser
 * used to require a string there, so every cycle set the whole document aside
 * and left one `scan-state.json.corrupt-*` file per minute behind it.
 *
 * These tests pin both halves of the fix: the never-scanned slot round-trips
 * through the real store without quarantining, a genuinely malformed slot is
 * still quarantined (never half-read), and a binding with no completed scan
 * opens its next window with no `since` filter at all — a full replay of the
 * open-issue list, including issues last updated before the binding existed
 * (product decision, 2026-09-28: the first scan is a replay, not a baseline).
 */

import { readdir, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../service/log.ts';
import { windowFor } from '../service/poll/loop.ts';
import { SCAN_STATE_FILE, parseStoredScanState, readScanState } from '../service/poll/scan.ts';
import { openStore } from '../service/store/index.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ScanState } from '../service/poll/scan.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { makeTempTree, removeTempTree } from './support/temp-tree.ts';

/** Binding id used by every fixture slot. */
const BINDING_ID = 'bnd-quarantine';

/** Creation stamp of the fixture binding (no longer a window source — kept for a complete record). */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** Stamp of a completed scan, for the "has scanned" contrast case. */
const SCANNED_AT = '2026-09-27T06:00:00.000Z';

/** Configured overlap this suite widens windows by (006 FR-059(a)). */
const OVERLAP_MS = 600_000;

/** The window a recorded stamp opens once the overlap is subtracted. */
const WIDENED_AT = new Date(Date.parse(SCANNED_AT) - OVERLAP_MS).toISOString();

/** The loop's skip reason for a credential the custody cannot use. */
const SKIP_REASON = 'auth-failed';

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Open store handle for the tests that read through the real store. */
let store: ServiceStore;

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    tempRoot = await makeTempTree('scan');
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    await removeTempTree(tempRoot);
});

/**
 * Build a logger that records every line it is asked to write.
 */
function capturingLogger(): { readonly log: ServiceLogger; readonly lines: string[] } {
    const lines: string[] = [];
    const log = createLogger({
        level: 'debug',
        sink: (line: string) => {
            lines.push(line);
        },
    });

    return { log, lines };
}

/**
 * Write one scan-state document straight into the store directory.
 *
 * The bytes are exactly what the loop writes: serialized JSON, no formatting.
 */
async function plantScanState(value: unknown): Promise<void> {
    await writeFile(join(dataDir, SCAN_STATE_FILE), JSON.stringify(value), 'utf8');
}

/**
 * List the quarantine files the store left in the data directory.
 *
 * @returns File names carrying the quarantine marker.
 */
async function quarantined(): Promise<string[]> {
    const entries = await readdir(dataDir);

    return entries.filter((entry) => entry.includes('.corrupt-'));
}

/**
 * Build the fixture binding record the window calculation reads.
 *
 * @returns A complete stored binding row.
 */
function fixtureBinding(): BindingRecord {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: '77331',
        accountLogin: 'octocat-mt',
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

/**
 * Build the scan state holding one fixture slot.
 *
 * @param slot - The stored slot, or `null` for a binding the file omits.
 * @returns The state the window calculation reads.
 */
function stateWith(slot: { readonly lastScanAt: string | null; readonly lastError: string | null } | null): ScanState {
    return { bindings: slot === null ? {} : { [BINDING_ID]: slot } };
}

describe('parseStoredScanState (never-scanned slot, MVP fix 1)', () => {
    it('round-trips the null lastScanAt the loop writes with its skip reason', async () => {
        {
            // The operator's exact on-disk file, as it arrives after a JSON load.
            const stored = { bindings: { [BINDING_ID]: { lastScanAt: null, lastError: SKIP_REASON } } };
            const reloaded = structuredClone(stored) as Record<string, unknown>;

            const parsed = parseStoredScanState(reloaded);

            expect(parsed).toEqual(stored);
            expect(parsed?.bindings[BINDING_ID]).toEqual({ lastScanAt: null, lastError: SKIP_REASON });
        }
    });

    it('round-trips a completed scan stamp alongside its reason', async () => {
        {
            const stored = { bindings: { [BINDING_ID]: { lastScanAt: SCANNED_AT, lastError: null } } };

            expect(parseStoredScanState(stored)).toEqual(stored);
        }
    });

    it('still refuses a genuinely malformed slot so the store quarantines it', async () => {
        {
            const malformed: readonly unknown[] = [
                { bindings: { [BINDING_ID]: { lastScanAt: 1_758_950_400, lastError: null } } },
                { bindings: { [BINDING_ID]: { lastScanAt: { iso: SCANNED_AT } } } },
                { bindings: { [BINDING_ID]: { lastError: SKIP_REASON } } },
                { bindings: { [BINDING_ID]: { lastScanAt: SCANNED_AT, lastError: 42 } } },
                { bindings: { [BINDING_ID]: 'not-a-record' } },
            ];

            for (const document of malformed) {
                expect(parseStoredScanState(document)).toBeNull();
            }
        }
    });

});

describe('readScanState (real store, no more per-minute quarantine files)', () => {
    it('reads the loop-written file in place, leaving no quarantine file behind', async () => {
        {
            await plantScanState({ bindings: { [BINDING_ID]: { lastScanAt: null, lastError: SKIP_REASON } } });
            const { log, lines } = capturingLogger();

            const state = await readScanState({ store, log });

            expect(state.bindings[BINDING_ID]).toEqual({ lastScanAt: null, lastError: SKIP_REASON });
            expect(await quarantined()).toEqual([]);
            expect(lines.filter((line) => line.includes('quarantine'))).toEqual([]);
        }
    });

    it('quarantines a malformed file and answers an empty state instead', async () => {
        {
            await plantScanState({ bindings: { [BINDING_ID]: { lastScanAt: 42 } } });
            const { log, lines } = capturingLogger();

            const state = await readScanState({ store, log });

            expect(state).toEqual({ bindings: {} });
            expect(await quarantined()).toHaveLength(1);
            expect(lines.some((line) => line.includes('unusable'))).toBe(true);
        }
    });

});

describe('windowFor (never-scanned opens a replay, scanned opens widened)', () => {
    it('opens with no window when no scan ever completed — a full replay', async () => {
        {
            // Product decision 2026-09-28: pre-binding assignments must work, so
            // the first scan lists every open issue instead of a createdAt
            // baseline that would reject an issue assigned before the binding.
            const scanned = stateWith({ lastScanAt: null, lastError: SKIP_REASON });

            expect(windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS })).toBeNull();
        }
    });

    it('opens at the recorded stamp minus the configured overlap (006 FR-059(a))', async () => {
        {
            const scanned = stateWith({ lastScanAt: SCANNED_AT, lastError: null });

            const widened = windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS });
            expect(widened).toBe(WIDENED_AT);
            expect(Date.parse(WIDENED_AT)).toBeLessThan(Date.parse(SCANNED_AT));
        }
    });

    it('opens with no window for a binding the state file never mentions', async () => {
        {
            const scanned = stateWith(null);

            expect(windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS })).toBeNull();
        }
    });

});
