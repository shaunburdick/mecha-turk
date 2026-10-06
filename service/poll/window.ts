/**
 * The scan window one binding opens on (002 FR-065 – FR-072; 006 FR-059(a)).
 *
 * Split out of `loop.ts` so the window rule sits with its own rationale
 * instead of inside the cycle's coordinator — the loop still imports it and
 * re-exports it, so `windowFor` keeps one import path.
 *
 * **There is no window without a lower bound.** Before v1.13.0 `windowFor`
 * returned `string | null` and a `null` meant *no window at all* — a full replay
 * admitting every observation the feed returned, which was also what a
 * stamp the clock could not read fell back to. Both conditions are retired as
 * window sources (002 FR-065), so the function now returns a **verdict**: either
 * a window start or a refusal with a reason (plan H11). There is consequently no
 * value left that means *unbounded*, and `stampInWindow` below has lost the arm
 * that made every stamp in-window.
 *
 * Resolution order, and every branch is bounded (002 FR-065):
 *
 * 1. **an armed `rescanFrom`** — FR-023's one chosen lower bound, which wins
 *    because it is the most recent explicit request for this binding's next scan
 *    (plan H5, FR-084);
 * 2. **a recorded `lastScanAt` minus the configured overlap** — the ordinary
 *    incremental window, and the whole of every scan after the first (FR-019);
 * 3. **the retained `baselineAt`** — what a binding with no completed scan scans
 *    from, whatever its history scope is, which is what makes a recovery replay
 *    work in both modes (FR-073; plan H8);
 * 4. **`refused`** — the only state in which a binding opens no window, and it
 *    never falls open to admit every observation (FR-072).
 *
 * The **comparison** the window exists for lives here too, beside the window
 * start it is compared against, and for the same reason: three detectors match
 * their own feed's freshness stamp against the same start, and one of them
 * (`poller-events.ts`) matches an `issue-event`'s `created_at` rather than a
 * listing's `updated_at`. Two spellings of one comparison would be two answers
 * to "is this inside the window", and the second one would be the one nobody
 * tested.
 *
 * **The mode is not an input to anything but the baseline** (002 FR-068). It is
 * read once per binding per scan, by {@link baselineFor}, to decide *which* lower
 * bound a no-completed-scan window opens at; it never reaches
 * {@link stampInWindow}, the page-walk stop rule, or any detector, because the
 * moment it appeared in one of those it would need a rule the others do not have
 * (plan H9). The structural proof is that it is not a parameter of any of them.
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
 *
 * @param value - The stored member.
 * @returns The stamp, or `null`.
 */
function readableStamp(value: string | null): string | null {
    return value !== null && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Derive and retain the baseline one binding with no completed scan scans from.
 *
 * **Derived once and retained**, which is the whole of FR-066's stability
 * requirement: a scan that fails three times and then succeeds opens at the
 * binding's creation boundary, not at the last attempt's, and a binding whose
 * credential stays broken returns the same window it promised rather than a later
 * one that would quietly exclude work it never failed to scan (AC-036).
 *
 * The derivation reads the **stored** creation stamp, and the three-way answer
 * is what makes FR-072 reachable at all:
 *
 * - **`absent`** — the row stores no stamp, which is legitimate for a
 *   panel-created row, so the assembled `binding.createdAt` (the moment it was
 *   first stored) is the baseline's source;
 * - **`stamp`** — used as it stands;
 * - **`unreadable`** — a stored stamp the clock cannot parse. The baseline is
 *   **never written**, the scan opens no window, and the reason is recorded
 *   against that binding. Deriving from the assembled stamp instead would read
 *   `now` here — because `assembleBinding` substitutes a clock reading for
 *   exactly this case — and FR-072's refusal would silently become a window of
 *   `now − overlapMs` (plan H3).
 *
 * The width comes from the mode, read **here and only here**: the documented
 * default widens the creation boundary by the configured overlap, the look-back
 * mode reaches one fixed look-back before that boundary (FR-066, FR-067). A
 * look-back length outside its own declared bound refuses rather than widening —
 * the only two directions this field may move a window in (FR-060).
 *
 * @returns The baseline stamp, or the refusal that keeps it unwritten.
 */
export function baselineFor(input: {
    /** The binding being scanned. */
    readonly binding: BindingRecord;
    /** What the stored row says about its creation stamp. */
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
 * Compute the lower bound this binding's next scan opens at.
 *
 * Reads the mode **zero** times: every branch consults only the slot's own
 * members, so once a binding has a baseline the mode is not consulted again —
 * FR-068's "once a binding has completed a scan its mode is not consulted at
 * all" holds structurally, and so does the recovery row of the window table,
 * where the baseline governs *whatever* the mode is (FR-073; plan H8).
 *
 * @returns The window start, or the refusal the binding records as its skip
 *   reason.
 */
export function windowFor(input: {
    /** Binding being scanned. */
    readonly binding: BindingRecord;
    /** Scan state read at cycle start. */
    readonly scanned: BindingScanState;
    /** Configured overlap subtracted from the recorded stamp. */
    readonly overlapMs: number;
}): WindowVerdict {
    const armed = readableStamp(input.scanned.rescanFrom);
    if (armed !== null) {
        // FR-023's chosen lower bound is the most recent explicit request for
        // this binding's next scan, so it wins. It is bounded by construction: a
        // member that must hold a parseable stamp cannot ask for everything
        // (FR-060).
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

    const baseline = readableStamp(input.scanned.baselineAt);
    if (baseline !== null) {
        return { window: baseline };
    }

    return { refused: BASELINE_UNREADABLE };
}

/**
 * Decide whether one freshness stamp falls inside the window.
 *
 * **An observation with no readable freshness stamp is never in-window** (002
 * FR-069): a feed entry that cannot report its own date cannot honestly claim to
 * be new, which is the whole fail-closed rule and the reason 002 FR-049's
 * per-item events read may report nothing rather than reaching for a substitute.
 *
 * The arm that used to read "no window means every stamp is in-window" is gone,
 * and deliberately so: `windowStart` is a `string`, so that behaviour is no longer
 * expressible here rather than merely unused (plan H11).
 *
 * @param stamp - The observation's own timestamp (`updated_at` on a listing,
 *   `created_at` on an issue event), or `null` when GitHub sent none.
 * @param windowStart - The window this scan opened.
 * @returns `true` when the stamp is inside the window.
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
 *
 * @returns The ids needing a baseline, in binding order.
 */
export function bindingsNeedingBaseline(input: {
    /** The bindings this cycle would scan. */
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
