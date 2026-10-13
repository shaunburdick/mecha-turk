/**
 * The scan window one binding opens on (002 FR-065 – FR-072; 006 FR-059(a)).
 * Window table: forceReplay → rescanFrom → lastScanAt−overlap → baselineAt → refused; replay beats arming (lost work).
 */

import { effectiveHistoryScope, lookBackMs } from '../bindings-history-scope.ts';
import type { StoredCreationStamp } from '../bindings-read.ts';
import type { BindingRecord } from '../bindings.ts';
import type { BindingScanState } from './scan.ts';

/**
 * The window rule's answer: a start, or the refusal that is its only other
 * outcome.
 *
 * A tagged verdict rather than `string | null` because a `null` would have to
 * mean two different things — *no window* and *a window we could not compute* —
 * and the second of those is exactly the case the pre-v1.13.0 code answered by
 * admitting everything (plan H11).
 */
export type WindowVerdict =
    /** The window this scan opens at. */
    | { readonly window: string }
    /** No window: the reason is recorded against the binding (002 FR-024, FR-072). */
    | { readonly refused: WindowRefusal };

/**
 * The short machine reasons a scan window could not be computed.
 *
 * A closed union rather than a free `string`, because these values become the
 * binding's recorded **skip reason** — the same field an upstream failure uses —
 * and a closed set is what makes "every refusal has a name in the vocabulary" a
 * compile-time fact rather than a review item (002 FR-024, FR-072).
 */
export type WindowRefusal =
    /** The binding's stored creation stamp could not establish a baseline (002 FR-072). */
    | 'baseline-unreadable'
    /** A recorded scan stamp is present and the clock cannot read it (002 FR-065). */
    | 'stamp-unreadable'
    /** The declared look-back constant has left its own bound (002 FR-059, FR-060). */
    | 'look-back-out-of-bounds';

/** Short machine reason recorded when no baseline could be derived (002 FR-072). */
export const BASELINE_UNREADABLE: WindowRefusal = 'baseline-unreadable';

/** Short machine reason recorded when the look-back constant left its own bound. */
export const LOOK_BACK_OUT_OF_BOUNDS: WindowRefusal = 'look-back-out-of-bounds';

/** Short machine reason recorded when a stamp in a slot is present and unreadable. */
export const STAMP_UNREADABLE: WindowRefusal = 'stamp-unreadable';

/**
 * Read one stamp, or `null` when it is absent or the clock cannot read it.
 */
function readableStamp(value: string | null): string | null {
    return value !== null && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Derive and retain the baseline one binding with no completed scan scans
 * from — derived once and retained, which is the whole of FR-066's stability
 * requirement (AC-036). The **stored** creation stamp is read, never the
 * assembled one: an `unreadable` stamp refuses rather than becoming `now −
 * overlapMs` (FR-072, plan H3). The width comes from the mode, read here and
 * only here (FR-066, FR-067), and an out-of-bound look-back refuses rather
 * than widening (FR-060).
 */
export function baselineFor(input: {
    readonly binding: BindingRecord;
    readonly stored: StoredCreationStamp;
    /** Configured overlap, for the documented default mode. */
    readonly overlapMs: number;
}): WindowVerdict {
    if (input.stored.kind === 'unreadable') {
        return { refused: BASELINE_UNREADABLE };
    }

    const createdAtMs = input.stored.kind === 'stamp'
        ? Date.parse(input.stored.at)
        : Date.parse(input.binding.createdAt);
    if (Number.isNaN(createdAtMs)) {
        return { refused: BASELINE_UNREADABLE };
    }

    let reachedBackMs = input.overlapMs;
    if (effectiveHistoryScope(input.binding.historyScope) === 'recent-history') {
        const lookBack = lookBackMs();
        if (lookBack === null) {
            return { refused: LOOK_BACK_OUT_OF_BOUNDS };
        }

        reachedBackMs = lookBack;
    }

    return { window: new Date(createdAtMs - reachedBackMs).toISOString() };
}

/**
 * Compute the lower bound this binding's next scan opens at. It reads the
 * mode **zero** times: every branch consults only the slot's own members, so
 * FR-068's *once a binding has completed a scan its mode is not consulted at
 * all* holds structurally, and so does the recovery row of the window table,
 * where the baseline governs *whatever* the mode is (FR-073; plan H8).
 */
export function windowFor(input: {
    readonly binding: BindingRecord;
    /** Scan state read at cycle start. */
    readonly scanned: BindingScanState;
    /** Configured overlap subtracted from the recorded stamp. */
    readonly overlapMs: number;
}): WindowVerdict {
    const baseline = readableStamp(input.scanned.baselineAt);

    // A recovery replay outranks everything else in the slot, including an armed
    // `rescanFrom`. FR-073 makes the replay's job re-offering the binding's
    // in-window work, and the baseline is the widest window it has ever scanned
    // from, so it is the only lower bound that satisfies that; an armed catch-up
    // request is about the scan *after* this one. The two cannot both hold, and
    // the one that would drop lost work is the one that must not (FR-073).
    if (baseline !== null && input.scanned.forceReplay) {
        return { window: baseline };
    }

    const armed = readableStamp(input.scanned.rescanFrom);
    if (armed !== null) {
        // FR-023's chosen lower bound is the most recent explicit request for
        // this binding's next scan, so it wins next. It is bounded by
        // construction: a member that must hold a parseable stamp cannot ask for
        // everything (FR-060).
        return { window: armed };
    }

    const recorded = readableStamp(input.scanned.lastScanAt);
    if (recorded !== null) {
        return { window: new Date(Date.parse(recorded) - input.overlapMs).toISOString() };
    }

    // A recorded stamp that is present but unreadable refuses rather than falling
    // through to the baseline: a slot whose scan stamp cannot be interpreted is a
    // state no reader may guess at, and the widening it would fall into is the
    // route FR-065 names.
    if (input.scanned.lastScanAt !== null) {
        return { refused: STAMP_UNREADABLE };
    }

    if (baseline !== null) {
        return { window: baseline };
    }

    return { refused: BASELINE_UNREADABLE };
}

/**
 * The retained baseline a completing scan leaves behind (002 FR-073): the
 * widest window this binding has ever scanned from, and only ever widening.
 * A recovery replay opens at `baselineAt`, so a baseline narrower than a
 * window already scanned would drop the work it must re-cover — hence
 * `min(prior, opened)`, which moves the bound earlier and never later. **The
 * only writer and the only operation**, so no reader has to know *why* a
 * bound must not shrink: keep the earlier of two parseable stamps.
 */
export function widenBaseline(inputs: {
    readonly retained: string | null;
    /** The window this scan opened at, or `null` when it refused. */
    readonly opened: string | null;
}): string | null {
    const candidates = [inputs.retained, inputs.opened]
        .filter((stamp): stamp is string => readableStamp(stamp) !== null)
        .map((stamp) => Date.parse(stamp));

    if (candidates.length === 0) {
        return null;
    }

    return new Date(Math.min(...candidates)).toISOString();
}

/**
 * Whether a scan that opened at one bound has answered an armed `rescanFrom`
 * (002 FR-075, FR-076, FR-084; plan H7). Coverage, not completion: a scan
 * that opened at or before the armed stamp covered all of it, so a baseline
 * earlier than the arming has already swept that ground. A comparison rather
 * than an equality test, because a replay opens at the retained baseline and
 * the two can differ in either direction; an unreadable stamp on either side
 * answers `false`, leaving the arming for a reader that can interpret it.
 */
export function answersCatchUp(input: {
    readonly opened: string | null;
    readonly armed: string | null;
}): boolean {
    const opened = readableStamp(input.opened);
    const armed = readableStamp(input.armed);

    return opened !== null && armed !== null && Date.parse(opened) <= Date.parse(armed);
}

/**
 * Decide whether one freshness stamp falls inside the window. **An
 * observation with no readable freshness stamp is never in-window** (002
 * FR-069): a feed entry that cannot report its own date cannot honestly
 * claim to be new — the whole fail-closed rule, and the reason FR-049's
 * per-item events read may report nothing rather than reaching for a
 * substitute. The arm that used to make a null window admit every stamp is
 * gone deliberately: `windowStart` is a `string`, so that behaviour is no
 * longer expressible here rather than merely unused (plan H11).
 */
export function stampInWindow(stamp: string | null, windowStart: string): boolean {
    if (stamp === null) {
        return false;
    }

    const observed = Date.parse(stamp);
    const start = Date.parse(windowStart);

    return !Number.isNaN(observed) && !Number.isNaN(start) && observed >= start;
}

/**
 * Which bindings this cycle must derive a baseline for (002 FR-066).
 *
 * A binding needs one exactly when it has neither a completed scan nor a
 * retained baseline — the two states in which `windowFor` would refuse. Computed
 * from the slot alone so the loop pays for {@link readStoredCreationStamps} only
 * in a cycle where something actually needs it (plan H3).
 */
export function bindingsNeedingBaseline(input: {
    readonly bindings: readonly BindingRecord[];
    /** Scan state read at cycle start. */
    readonly slots: Readonly<Record<string, BindingScanState>>;
}): readonly string[] {
    return input.bindings
        .filter((binding) => {
            const slot = input.slots[binding.bindingId];
            return (slot?.lastScanAt ?? null) === null && (slot?.baselineAt ?? null) === null;
        })
        .map((binding) => binding.bindingId);
}
