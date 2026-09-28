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
 * still quarantined (never half-read), and the next scan window opens at the
 * binding's creation stamp when no scan ever completed — the baseline, not a
 * replay of the repository's whole open-issue history.
 */

import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../extension/service/log.ts';
import { windowFor } from '../extension/service/poll/loop.ts';
import { SCAN_STATE_FILE, parseStoredScanState, readScanState } from '../extension/service/poll/scan.ts';
import { openStore } from '../extension/service/store/index.ts';
import type { BindingRecord } from '../extension/service/bindings.ts';
import type { ServiceLogger } from '../extension/service/log.ts';
import type { ScanState } from '../extension/service/poll/scan.ts';
import type { ServiceStore } from '../extension/service/store/index.ts';

/** Binding id used by every fixture slot. */
const BINDING_ID = 'bnd-quarantine';

/** Creation stamp of the fixture binding; the baseline window opens here. */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** Stamp of a completed scan, for the "has scanned" contrast case. */
const SCANNED_AT = '2026-09-27T06:00:00.000Z';

/** The loop's skip reason for a credential the custody cannot use. */
const SKIP_REASON = 'auth-failed';

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Open store handle for the tests that read through the real store. */
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-scan-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Build a logger that records every line it is asked to write.
 *
 * @returns The logger plus the lines it captured.
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
 *
 * @param value - The document to plant.
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
        triggers: { assignment: true, mention: false },
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
    it('round-trips the null lastScanAt the loop writes with its skip reason', () => {
        // The operator's exact on-disk file, as it arrives after a JSON load.
        const stored = { bindings: { [BINDING_ID]: { lastScanAt: null, lastError: SKIP_REASON } } };
        const reloaded = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;

        const parsed = parseStoredScanState(reloaded);

        expect(parsed).toEqual(stored);
        expect(parsed?.bindings[BINDING_ID]).toEqual({ lastScanAt: null, lastError: SKIP_REASON });
    });

    it('round-trips a completed scan stamp alongside its reason', () => {
        const stored = { bindings: { [BINDING_ID]: { lastScanAt: SCANNED_AT, lastError: null } } };

        expect(parseStoredScanState(stored)).toEqual(stored);
    });

    it('still refuses a genuinely malformed slot so the store quarantines it', () => {
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
    });
});

describe('readScanState (real store, no more per-minute quarantine files)', () => {
    it('reads the loop-written file in place, leaving no quarantine file behind', async () => {
        await plantScanState({ bindings: { [BINDING_ID]: { lastScanAt: null, lastError: SKIP_REASON } } });
        const { log, lines } = capturingLogger();

        const state = await readScanState({ store, log });

        expect(state.bindings[BINDING_ID]).toEqual({ lastScanAt: null, lastError: SKIP_REASON });
        expect(await quarantined()).toEqual([]);
        expect(lines.filter((line) => line.includes('quarantine'))).toEqual([]);
    });

    it('quarantines a malformed file and answers an empty state instead', async () => {
        await plantScanState({ bindings: { [BINDING_ID]: { lastScanAt: 42 } } });
        const { log, lines } = capturingLogger();

        const state = await readScanState({ store, log });

        expect(state).toEqual({ bindings: {} });
        expect(await quarantined()).toHaveLength(1);
        expect(lines.some((line) => line.includes('unusable'))).toBe(true);
    });
});

describe('windowFor (the window a never-scanned binding opens from)', () => {
    it('opens at the binding creation stamp when no scan ever completed', () => {
        // Without this, the first successful scan after a fixed credential
        // would walk the repository's whole open-issue history.
        const scanned = stateWith({ lastScanAt: null, lastError: SKIP_REASON });

        expect(windowFor(fixtureBinding(), scanned)).toBe(CREATED_AT);
    });

    it('opens at the recorded stamp once a scan has completed', () => {
        const scanned = stateWith({ lastScanAt: SCANNED_AT, lastError: null });

        expect(windowFor(fixtureBinding(), scanned)).toBe(SCANNED_AT);
    });

    it('opens at the creation stamp for a binding the state file never mentions', () => {
        expect(windowFor(fixtureBinding(), stateWith(null))).toBe(CREATED_AT);
    });
});
