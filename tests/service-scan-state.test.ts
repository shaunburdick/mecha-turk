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
 * through the real store without quarantining and a genuinely malformed slot is
 * still quarantined (never half-read).
 *
 * **Re-cut at 002 v1.13.0.** This suite also asserted that a binding with no
 * completed scan opened its next window with **no `since` filter at all** — "the
 * first scan is a replay, not a baseline", the 2026-09-28 product decision. That
 * rule is retired as a window source (002 FR-065): `windowFor` now returns a
 * **verdict**, and the states it used to answer `null` for either open at the
 * binding's retained **baseline** or **refuse** with a reason. The suite below is
 * therefore the wave's structural proof of FR-060/SC-013 — across every stored
 * slot and both modes, `windowFor` returns a window or a refusal and never a
 * value meaning "unbounded".
 */

import { readdir, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../service/log.ts';
import { windowFor } from '../service/poll/loop.ts';
import { BASELINE_UNREADABLE, STAMP_UNREADABLE } from '../service/poll/window.ts';
import {
    SCAN_STATE_FILE,
    bindingScanOf,
    emptyBindingScan,
    parseStoredScanState,
    readScanState,
} from '../service/poll/scan.ts';
import { openStore } from '../service/store/index.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { BindingScanState } from '../service/poll/scan.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { makeStoreTree, removeTempTree } from './support/temp-tree.ts';

/** Binding id used by every fixture slot. */
const BINDING_ID = 'bnd-quarantine';

/** Creation stamp of the fixture binding; the source of this suite's baseline (002 FR-066). */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** Stamp of a completed scan, for the "has scanned" contrast case. */
const SCANNED_AT = '2026-09-27T06:00:00.000Z';

/** Configured overlap this suite widens windows by (006 FR-059(a)). */
const OVERLAP_MS = 600_000;

/** The window a recorded stamp opens once the overlap is subtracted. */
const WIDENED_AT = new Date(Date.parse(SCANNED_AT) - OVERLAP_MS).toISOString();

/**
 * The baseline a default-mode binding derives from its creation stamp: the
 * creation boundary widened by the configured overlap (002 FR-066).
 */
const BASELINE_AT = new Date(Date.parse(CREATED_AT) - OVERLAP_MS).toISOString();

/**
 * An armed catch-up's lower bound (002 FR-023, FR-084): one fixed seven-day
 * look-back measured from a moment well after creation, so it is distinguishable
 * from both the baseline and the recorded-stamp window in every assertion here.
 */
const RESCAN_AT = new Date(Date.parse(SCANNED_AT) - 604_800_000).toISOString();

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
    ({ root: tempRoot, dataDir } = await makeStoreTree('scan'));
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
 * The fixture binding's slot, or the **absent-slot** answer when `null`.
 *
 * `windowFor` takes a slot, not a document, since v1.13.0 — the loop resolves the
 * document to per-binding slots before it computes any window — so a suite that
 * drives the rule directly needs the same shape, and `bindingScanOf` is what
 * answers the "the file never mentioned this binding" case.
 *
 * @param slot - The stored slot, or `null` for a binding the file omits.
 * @returns The slot the window rule reads.
 */
function stateWith(slot: BindingScanState | null): BindingScanState {
    return slot ?? bindingScanOf({ bindings: {} }, BINDING_ID);
}

/**
 * One fixture slot, with the three v1.13.0 members at their absent defaults.
 *
 * Written as an object spread over {@link emptyBindingScan} rather than as a
 * literal so a suite that only cares about `lastScanAt` does not have to name
 * the other four, and cannot drift from what the parser defaults them to.
 *
 * @param slot - The two members this suite varies.
 * @returns A complete stored slot.
 */
function fixtureSlot(slot: {
    readonly lastScanAt: string | null;
    readonly lastError?: string | null;
}): BindingScanState {
    return { ...emptyBindingScan(), lastScanAt: slot.lastScanAt, lastError: slot.lastError ?? null };
}

describe('parseStoredScanState (never-scanned slot, MVP fix 1)', () => {
    it('round-trips the null lastScanAt the loop writes with its skip reason', async () => {
        {
            // The operator's exact on-disk file, as it arrives after a JSON load.
            // A pre-v1.13.0 file carries **only** these two members, and each new
            // one defaults from its own absence (plan H4) rather than from another
            // member's value — which is what keeps an absent `lastScanAt` from
            // being read as `forceReplay` (002 FR-074).
            const stored = { bindings: { [BINDING_ID]: { lastScanAt: null, lastError: SKIP_REASON } } };
            const reloaded = structuredClone(stored) as Record<string, unknown>;

            const parsed = parseStoredScanState(reloaded);

            expect(parsed?.bindings[BINDING_ID]).toEqual(fixtureSlot({ lastScanAt: null, lastError: SKIP_REASON }));
        }
    });

    it('round-trips a completed scan stamp alongside its reason', async () => {
        {
            const stored = { bindings: { [BINDING_ID]: { lastScanAt: SCANNED_AT, lastError: null } } };

            expect(parseStoredScanState(stored)?.bindings[BINDING_ID]).toEqual(
                fixtureSlot({ lastScanAt: SCANNED_AT }),
            );
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

    it('refuses a slot whose new members are unusable rather than half-reading it', async () => {
        {
            // Each durable fact has its own validator, and a member of the wrong
            // type takes the slot with it: silently defaulting an armed operator
            // request or a set replay flag to `false` would be a fact the file
            // never said (invariant 8, 002 FR-074).
            const malformed: readonly unknown[] = [
                { bindings: { [BINDING_ID]: { lastScanAt: null, lastError: null, baselineAt: 7 } } },
                { bindings: { [BINDING_ID]: { lastScanAt: null, lastError: null, forceReplay: 'yes' } } },
                { bindings: { [BINDING_ID]: { lastScanAt: null, lastError: null, rescanFrom: 7 } } },
                { bindings: { [BINDING_ID]: { lastScanAt: null, lastError: null, rescanFrom: { at: SCANNED_AT } } } },
            ];

            for (const document of malformed) {
                expect(parseStoredScanState(document)).toBeNull();
            }
        }
    });

    it('accepts all five members, and each is independently distinguishable', async () => {
        {
            const stored = {
                bindings: {
                    [BINDING_ID]: {
                        lastScanAt: SCANNED_AT,
                        lastError: null,
                        baselineAt: BASELINE_AT,
                        forceReplay: true,
                        rescanFrom: RESCAN_AT,
                    },
                },
            };

            expect(parseStoredScanState(stored)).toEqual(stored);
        }
    });
});

describe('readScanState (real store, no more per-minute quarantine files)', () => {
    it('reads the loop-written file in place, leaving no quarantine file behind', async () => {
        {
            await plantScanState({ bindings: { [BINDING_ID]: { lastScanAt: null, lastError: SKIP_REASON } } });
            const { log, lines } = capturingLogger();

            const state = await readScanState({ store, log });

            expect(state.bindings[BINDING_ID]).toEqual(fixtureSlot({ lastScanAt: null, lastError: SKIP_REASON }));
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

describe('windowFor (a verdict, never "no window")', () => {
    it('opens at the recorded stamp minus the configured overlap (006 FR-059(a))', async () => {
        {
            const scanned = stateWith(fixtureSlot({ lastScanAt: SCANNED_AT }));

            const verdict = windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS });
            expect(verdict).toEqual({ window: WIDENED_AT });
            expect(Date.parse(WIDENED_AT)).toBeLessThan(Date.parse(SCANNED_AT));
        }
    });

    it('opens at the retained baseline when no scan ever completed (002 FR-066)', async () => {
        {
            const scanned = stateWith({
                ...emptyBindingScan(),
                lastScanAt: null,
                lastError: SKIP_REASON,
                baselineAt: BASELINE_AT,
            });

            expect(windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS })).toEqual({
                window: BASELINE_AT,
            });
        }
    });

    it('**refuses** for a binding with neither a completed scan nor a baseline (002 FR-072)', async () => {
        {
            // Retired at v1.13.0: this used to answer `null`, which meant *no
            // window at all* — the branch that admitted every observation the feed
            // returned. The verdict now refuses, so the only state in which a scan
            // opens nothing carries a recorded reason (FR-065, FR-072).
            const scanned = stateWith(fixtureSlot({ lastScanAt: null, lastError: SKIP_REASON }));

            expect(windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS })).toEqual({
                refused: BASELINE_UNREADABLE,
            });
        }
    });

    it('**refuses** for a binding the state file never mentions', async () => {
        {
            expect(windowFor({
                binding: fixtureBinding(),
                scanned: stateWith(null),
                overlapMs: OVERLAP_MS,
            })).toEqual({ refused: BASELINE_UNREADABLE });
        }
    });

    it('opens at an armed rescanFrom ahead of every other source (002 FR-023, FR-084)', async () => {
        {
            // The mechanism wins because it is the most recent explicit request for
            // this binding's next scan, and it is bounded by construction: a member
            // that must hold a parseable stamp cannot ask for everything (FR-060).
            const scanned = stateWith({
                ...emptyBindingScan(),
                lastScanAt: SCANNED_AT,
                baselineAt: BASELINE_AT,
                rescanFrom: RESCAN_AT,
            });

            expect(windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS })).toEqual({
                window: RESCAN_AT,
            });
        }
    });

    it('opens at the baseline during a recovery replay, whatever the binding\'s mode (002 FR-073)', async () => {
        {
            // The flag changes **no** window: after a reset the binding has no
            // recorded stamp, so the retained baseline governs — and the baseline
            // was derived under whatever mode the binding held (plan H8). What the
            // flag buys is precedence, visibility, and a first scan that cannot be
            // mistaken for a replay (FR-074, FR-078).
            const scanned = stateWith({
                ...emptyBindingScan(),
                lastScanAt: null,
                baselineAt: BASELINE_AT,
                forceReplay: true,
            });

            for (const scope of [undefined, 'new-only', 'recent-history'] as const) {
                const binding = { ...fixtureBinding(), ...(scope !== undefined && { historyScope: scope }) };

                expect(windowFor({ binding, scanned, overlapMs: OVERLAP_MS })).toEqual({ window: BASELINE_AT });
            }
        }
    });

    it('refuses a recorded stamp the clock cannot read rather than widening (002 FR-065)', async () => {
        {
            const scanned = stateWith({ ...emptyBindingScan(), lastScanAt: 'not-a-stamp', baselineAt: BASELINE_AT });

            expect(windowFor({ binding: fixtureBinding(), scanned, overlapMs: OVERLAP_MS })).toEqual({
                refused: STAMP_UNREADABLE,
            });
        }
    });

    it('never answers an unbounded window, for any stored state at all (002 FR-060, SC-013)', async () => {
        {
            // The reachability claim as a test rather than as prose: every stored
            // slot this suite can build answers a window **or** a refusal, and no
            // answer means *admit everything* (plan H11).
            const slots: readonly BindingScanState[] = [
                emptyBindingScan(),
                fixtureSlot({ lastScanAt: null, lastError: SKIP_REASON }),
                fixtureSlot({ lastScanAt: SCANNED_AT }),
                { ...emptyBindingScan(), lastScanAt: SCANNED_AT, baselineAt: BASELINE_AT, rescanFrom: RESCAN_AT },
                { ...emptyBindingScan(), lastScanAt: null, baselineAt: BASELINE_AT, forceReplay: true },
                { ...emptyBindingScan(), lastScanAt: 'nonsense' },
                { ...emptyBindingScan(), rescanFrom: 'nonsense' },
            ];
            const scopes = [undefined, 'new-only', 'recent-history'] as const;

            for (const slot of slots) {
                for (const scope of scopes) {
                    const binding = { ...fixtureBinding(), ...(scope !== undefined && { historyScope: scope }) };
                    const verdict = windowFor({ binding, scanned: slot, overlapMs: OVERLAP_MS });

                    expect(Object.keys(verdict).length, JSON.stringify({ slot, scope })).toBe(1);
                    expect('window' in verdict ? verdict.window : verdict.refused).not.toBeNull();
                }
            }
        }
    });
});
