/**
 * The scan window one binding opens on (006 FR-059(a); 002 FR-019).
 *
 * Split out of `loop.ts` so the window rule sits with its own rationale
 * instead of inside the cycle's coordinator — the loop still imports it and
 * re-exports it, so `windowFor` keeps one import path.
 */

import type { BindingRecord } from '../bindings.ts';
import type { ScanState } from './scan.ts';

/**
 * The window the next scan opens from: the last completed scan's stamp
 * **minus the configured overlap** when there is one, else `null` — no `since`
 * filter at all, a full replay.
 *
 * This is 002 FR-019's configurable overlap made real: the requirement has
 * asked for a ten-minute look-back since 002 v1.1.0 and nothing in the service
 * read `overlapMs` until now, so the widened window is a **conformance gap
 * closing**, not a new behaviour. The widened window re-observes what the
 * previous cycle already saw and `enqueueEvents`'s deterministic event id
 * drops the replay, so a doubled window cannot produce a second event, a
 * second dispatch, or a second session (006 FR-059(a); constitution III).
 *
 * A binding that has never completed a scan (`lastScanAt: null` in its slot,
 * or no slot at all) replays every open issue on its next scan instead of
 * opening a baseline at `createdAt`: pre-binding assignments must work
 * (product decision, 2026-09-28), so an issue assigned before the binding
 * existed is still detected. A recovery reset writes the same `null`, so the
 * reset replays too — the same contract, and deterministic event ids keep
 * both replays duplicate-free. A stamp the clock cannot read is treated the
 * same way: an unbounded window is honest, a malformed `since` is not.
 *
 * @param input - The binding being scanned, the scan state read at cycle
 *   start, and the configured overlap.
 * @returns The widened stamp, or `null` for an unbounded (replay) window.
 */
export function windowFor(input: {
    /** Binding being scanned. */
    readonly binding: BindingRecord;
    /** Scan state read at cycle start. */
    readonly scanned: ScanState;
    /** Configured overlap subtracted from the recorded stamp. */
    readonly overlapMs: number;
}): string | null {
    const recorded = input.scanned.bindings[input.binding.bindingId];
    const lastScanAt = recorded?.lastScanAt ?? null;
    if (lastScanAt === null) {
        return null;
    }

    const openedAt = Date.parse(lastScanAt) - input.overlapMs;
    if (!Number.isFinite(openedAt)) {
        return null;
    }

    return new Date(openedAt).toISOString();
}
