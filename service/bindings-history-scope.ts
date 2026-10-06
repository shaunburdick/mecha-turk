/**
 * The binding history scope's rule set (002 FR-053 – FR-062, FR-059; plan H1, H10).
 *
 * `bindings.ts` owns the record, the refusal envelope, and the whole-file
 * grant. This module owns the one field whose semantics are a **rule about when
 * a scan window starts**: the two names a binding may carry, the single reading
 * of their absence, and the look-back length the wider of the two names uses.
 * It sits beside the allow-list's rule set for the reason that module's header
 * gives — one responsibility per file, and a file that can be read on its own.
 *
 * Four properties of this field are worth stating once, because each was a
 * decision rather than a default:
 *
 * - **Two names, and no third.** The mode is a persisted vocabulary (NFR-012),
 *   so it is a closed union read by one function everywhere: the bindings
 *   write, the bindings read, and the audit writer's comparison all call
 *   {@link historyScopeOf} (FR-061). A number, a boolean, an object, an array,
 *   `''`, and an unrecognized string are all **refused whole** — never coerced,
 *   never cast, never defaulted in place, and never persisted in a form that
 *   would later read as the default (FR-024).
 * - **Absence and an explicit `null` are the same state**, and that state is the
 *   documented default `'new-only'` (FR-058, FR-062). `null` is therefore the
 *   reader's *cleared* answer rather than a third value, and the assembly omits
 *   the key entirely rather than storing a spelling of the default — so a
 *   binding written before this field and one whose field was cleared are
 *   byte-identical, which is what makes the upgrade write nothing.
 * - **The look-back length is a constant, not a value.** It is declared here,
 *   outside `ServiceConfig` and outside `NUMERIC_BOUNDS`, because the operator
 *   cannot choose it and a value nobody can change does not belong on the
 *   surface that exists for changing values (FR-059, plan H10).
 * - **No stored state can ask for an unbounded window** (FR-060). The mode is an
 *   enum, the look-back is not stored, and {@link lookBackMs} answers `null`
 *   rather than a number the constant's own bound does not cover — so a constant
 *   edited past its bound makes the wider mode *refuse*, which is the only
 *   direction a broken bound may move the window in.
 */

import type { BindingIssue } from './bindings.ts';

/**
 * The two names a binding's history scope may carry, in the order the operator
 * is offered them: watch from now on, then watch from now on **and** look back
 * over recent activity once.
 */
export type HistoryScope = 'new-only' | 'recent-history';

/**
 * What a binding with no `historyScope` member scans with (002 FR-053, FR-058).
 *
 * Also the reading of an explicit `null`, which is *cleared to this value*
 * rather than a third state (FR-062).
 */
export const DEFAULT_HISTORY_SCOPE: HistoryScope = 'new-only';

/** Both names, in presentation order — the whole of the field's domain. */
export const HISTORY_SCOPES: readonly HistoryScope[] = ['new-only', 'recent-history'];

/** The look-back one `'recent-history'` binding's first window reaches back over (7 days). */
export const LOOK_BACK_MS = 604_800_000;

/**
 * The bound the declared look-back must satisfy (002 FR-059; 1 h to 30 d).
 *
 * Exists so the constant cannot be edited into unbounded behaviour **without
 * this bound moving too** — which is the mechanism that keeps FR-060 true over
 * time rather than by convention. Deliberately not `NUMERIC_BOUNDS`: that table
 * is the Settings projection, and this value is on no Settings row.
 */
export const LOOK_BACK_BOUNDS = {
    min: 3_600_000,
    max: 2_592_000_000,
    unit: 'milliseconds',
} as const;

/** Field name every refusal on this member uses. */
const FIELD = 'historyScope';

/**
 * Remediation for a value outside the two names.
 *
 * Names **both** accepted names, because a refusal that names one of the two
 * choices leaves the operator to guess the other. Echoes **nothing** the
 * operator submitted — the same posture `bindings-allow-list.ts` takes, and the
 * one FR-061's "no submitted value is echoed back" asks for.
 */
const NOT_A_SCOPE_REMEDIATION = 'historyScope must be `new-only` (watch from this binding\'s own creation '
    + 'onward) or `recent-history` (also look back over the last seven days, once), or null to clear it '
    + 'to `new-only`; there is no "all history" option';

/**
 * Decide whether a value is one of this field's two names.
 *
 * A `Set` over the declared pair rather than a comparison chain, so the accepted
 * set is the exported vocabulary and cannot drift from the union the type
 * declares.
 *
 * @param value - The candidate value, read from a stored or submitted record.
 * @returns `true` when the value is one of the two names.
 */
function isHistoryScope(value: unknown): value is HistoryScope {
    return value === 'new-only' || value === 'recent-history';
}

/**
 * Check a look-back length against its declared bound.
 *
 * @param candidate - A length in milliseconds.
 * @returns `true` when the length sits inside {@link LOOK_BACK_BOUNDS}.
 */
export function lookBackWithinBounds(candidate: number): boolean {
    return Number.isFinite(candidate)
        && candidate >= LOOK_BACK_BOUNDS.min
        && candidate <= LOOK_BACK_BOUNDS.max;
}

/**
 * The look-back length the service will actually use, or `null` when the
 * declared constant has left its own bound.
 *
 * The one runtime guard on FR-059's bound. A constant edited past the bound is
 * not a wider window — it is a *refusal*, because the only two directions this
 * field may move a window in are "the documented period" and "no window at all,
 * with a recorded reason" (FR-060, FR-065, FR-072). Returning the number
 * unchecked would make "all history" one edit away and the bound decorative.
 *
 * @returns The declared length, or `null` when it is outside its own bound.
 */
export function lookBackMs(): number | null {
    return lookBackWithinBounds(LOOK_BACK_MS) ? LOOK_BACK_MS : null;
}

/**
 * Read one binding's optional history scope.
 *
 * **Three states, and no fourth**: absent (`scope: null`), one of the two names,
 * and the refusal that stands in for everything else. An explicit JSON `null`
 * reads as `scope: null` too — *cleared to the documented default* — because it
 * is the same state an absent key is and neither of them means "no lower bound"
 * (FR-062).
 *
 * `scope: null` is therefore what every consumer treats as the default: the
 * assembly omits the key rather than storing a spelling of it, the audit writer
 * compares effective values, and the window rule reads the mode through
 * {@link effectiveHistoryScope}. A present value outside the two names is never
 * coerced, cast, or dropped from the record (FR-061).
 *
 * @param raw - The candidate record, read for its `historyScope` member.
 * @returns The mode, `null` for unset-or-cleared, or the blocking issue.
 */
export function historyScopeOf(raw: Record<string, unknown>): {
    readonly scope: HistoryScope | null;
} | { readonly issue: BindingIssue } {
    const value = raw.historyScope;
    if (value === undefined || value === null) {
        return { scope: null };
    }

    return isHistoryScope(value)
        ? { scope: value }
        : { issue: { field: FIELD, remediation: NOT_A_SCOPE_REMEDIATION } };
}

/**
 * The mode a stored binding record scans under.
 *
 * The **single** place absence becomes the default, so the poll loop, the status
 * row, and the audit writer's comparison cannot each invent their own reading of
 * the same absent key (FR-055, FR-058, plan H13).
 *
 * @param historyScope - The stored member, absent on a binding that carries none.
 * @returns One of the two names; the documented default when the member is absent.
 */
export function effectiveHistoryScope(historyScope?: HistoryScope): HistoryScope {
    return historyScope ?? DEFAULT_HISTORY_SCOPE;
}
