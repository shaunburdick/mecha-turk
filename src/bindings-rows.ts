/**
 * The Bindings tab's binding rows (split from `bindings-ui.ts`, MVP fix 2).
 *
 * A row is where the operator finds out *why* a bound repository is or is not
 * producing work: which account polls it, which project it dispatches to, how
 * long ago the service last scanned it, and the machine reason when that scan
 * was skipped (an unusable credential, a disabled account). The scan phrase
 * therefore always names the reason next to the stamp — "binding on, pending
 * 0, nothing happens" is exactly the ambiguity this module exists to close.
 *
 * Everything here is a pure function of panel state, so the copy the operator
 * reads is testable without a live DOM.
 *
 * Two of this tab's clauses live beside it rather than here, each because it is
 * one value with its own rule set: the prompt's presence-and-length summary
 * ({@link promptSummary}, 004/005 FR-051) and the allow-list's row clause
 * (computed in `bindings-actors.ts`, 005 FR-091/FR-092) — a **count** when the
 * binding carries a list, and the worded absent-policy warning when it does not,
 * which is the one place outside its own editor that this product says *anyone
 * may trigger this repository*. That clause is a function of three members and
 * not of the allow-list alone: a binding that is off, or that watches no
 * trigger, has no exposed surface to describe, and the row says so rather than
 * asserting a capability the machine does not have (FR-092's eight-row table,
 * FR-096, NFR-114).
 */

import type { ListItem } from '@openchamber/sdk/ui';
import { utcStamp } from './ids.ts';
import { actorsSummary } from './bindings-actors.ts';
import { historyScopeLabel } from './bindings-history.ts';
import type { BindingsTabState } from './panel-state.ts';
import type { PanelBinding } from './bindings-service.ts';

/** Milliseconds in a second. */
const SECOND_MS = 1_000;

/** Milliseconds in a minute. */
const MINUTE_MS = 60 * SECOND_MS;

/** Milliseconds in an hour. */
const HOUR_MS = 60 * MINUTE_MS;

/** Milliseconds in a day. */
const DAY_MS = 24 * HOUR_MS;

/** What a binding no scan has ever reached reads as. */
const NOT_SCANNED = 'not scanned yet';

/** The slice of one status row the binding rows read. */
interface StatusRowView {
    readonly lastScanAt: string | null;
    readonly lastError: string | null;
    readonly pendingCount: number;
}

/** One binding the rows render. */
export interface BindingView {
    readonly bindingId: string;
    readonly repository: string;
    readonly accountLogin: string;
    /** Account the binding still names, so a removed one can be told apart. */
    readonly accountNumericUserId: string;
    readonly projectId: string;
    readonly state: 'active' | 'disabled';
    /** Length of the stored prompt in code points, or `null` when there is none. */
    readonly promptLength: number | null;
    /**
     * The allow-list's row clause, or `null` when this row carries none.
     *
     * Held as **one clause rather than the list** so a login can never reach a
     * row even by accident: the count and the absent-policy warning are computed
     * once, in `bindings-actors.ts`, and the row only decides where they go.
     */
    readonly actorsClause: string | null;
    /**
     * The history scope's permitted **short label**, or `null` when the row has
     * nothing to add (002 FR-091).
     *
     * A label and not a value: 005 FR-091's reasoning is that a count is not a
     * second rendering of a value, and the same holds here — the row may *name*
     * the mode and may derive **nothing else** from it, and it is never the only
     * place the operator can see or change it (the editor control is).
     */
    readonly historyScopeLabel: string | null;
}

/**
 * Narrow one stored binding to what a row may show.
 *
 * @returns The view, with the prompt reduced to its length and the allow-list
 *   reduced to one clause.
 */
function toView(binding: PanelBinding): BindingView {
    return {
        bindingId: binding.bindingId,
        repository: binding.repository,
        accountLogin: binding.accountLogin,
        accountNumericUserId: binding.accountNumericUserId,
        projectId: binding.projectId,
        state: binding.state,
        promptLength: binding.startingPrompt === undefined ? null : [...binding.startingPrompt].length,
        actorsClause: actorsSummary(binding),
        historyScopeLabel: historyScopeLabel(binding),
    };
}

/**
 * The prompt words a row summary may carry: presence and length, never text.
 *
 * 005 FR-051 forbids both the instruction and 004's fingerprint on the row —
 * two renderings of one operator instruction is how two versions of it start
 * to disagree — so the summary says only *whether* one exists and *how long*
 * it is, counted the way 004 caps it (code points, not UTF-16 units).
 *
 * @returns `prompt set · N chars`, or `prompt not set`.
 */
export function promptSummary(binding: BindingView): string {
    if (binding.promptLength === null) {
        return 'prompt not set';
    }

    return `prompt set · ${binding.promptLength} chars`;
}

/**
 * Find the status row for one binding.
 *
 * @returns The row, or `null` before the first poll.
 */
function statusRowOf(bindings: BindingsTabState, bindingId: string): StatusRowView | null {
    return bindings.statusRows.find((candidate) => candidate.bindingId === bindingId) ?? null;
}

/**
 * Describe a scan stamp as elapsed time, so the row reads like a status and
 * not like a log line.
 *
 * Shared with the Dispatches rows (M8), which describe `detectedAt` the same way.
 *
 * @param iso - RFC 3339 stamp of the last completed scan.
 * @returns `just now`, `2m ago`, `3h ago`, `2d ago`, or the raw stamp when
 *   it cannot be parsed (an unparseable stamp is shown, never guessed at).
 */
export function elapsedSince(iso: string): string {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) {
        return iso;
    }

    const elapsed = Date.now() - at;
    if (elapsed < MINUTE_MS) {
        return 'just now';
    }
    if (elapsed < HOUR_MS) {
        return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
    }
    if (elapsed < DAY_MS) {
        return `${Math.floor(elapsed / HOUR_MS)}h ago`;
    }

    return `${Math.floor(elapsed / DAY_MS)}d ago`;
}

/**
 * Read one status row's scan phrase.
 *
 * The phrase is the operator's only view of *why* nothing is happening on a
 * binding, so it carries the skip reason next to when the last scan ran — and
 * a binding no scan has ever reached reads *not scanned yet* rather than a
 * bare `never`, which reads like a verdict instead of an absence.
 *
 * @returns `scan: <when> · <reason|ok>`, or `not scanned yet` before the
 *   first completed scan with no recorded reason.
 */
function scanPhrase(row: StatusRowView): string {
    if (row.lastScanAt === null) {
        return row.lastError === null ? NOT_SCANNED : `scan: never · ${row.lastError}`;
    }

    return `scan: ${elapsedSince(row.lastScanAt)} · ${row.lastError ?? 'ok'}`;
}

/**
 * Why a disabled binding is not polling, when the panel can prove it.
 *
 * The service stores `state: 'disabled'` for both the operator's own toggle
 * and the cascade that follows an account removal, and it writes no reason
 * with it — so the panel checks the one fact it can establish itself: is the
 * account this binding still names in the list the service currently holds?
 * An absent account is the removal; a present one means the operator turned
 * the binding off.
 *
 * The claim is gated on a **completed** read: an accounts list the panel
 * never loaded is not evidence of a removal, and saying "account removed"
 * because a read failed would be exactly the invented value FR-003 forbids.
 *
 * @returns The reason, or `null` when the binding is enabled or the panel
 *   cannot tell.
 */
export function disabledReason(bindings: BindingsTabState, binding: BindingView): string | null {
    if (binding.state !== 'disabled' || bindings.status !== 'ready') {
        return null;
    }

    const account = bindings.accounts.find(
        (candidate) => candidate.numericUserId === binding.accountNumericUserId,
    );

    return account === undefined ? 'account removed' : null;
}

/**
 * The row's state words, including why it is off when the panel can prove it.
 *
 * Written as its own step rather than a nested conditional so the two facts —
 * *is it on*, and *if not, why* — read as one sentence instead of as
 * punctuation (FR-083: state carried by text).
 *
 * @returns `null` while the binding is enabled, else the words to render.
 */
function statePhrase(state: BindingView['state'], reason: string | null): string | null {
    if (state === 'active') {
        return null;
    }

    return reason === null ? 'disabled' : `disabled — ${reason}`;
}

/**
 * Why a binding cannot poll because its account cannot.
 *
 * A binding whose account is unusable is the thing the operator is actually
 * looking at when nothing arrives, so the consequence is stated on *this*
 * row rather than left to a visit to the Accounts tab. The claim is gated on
 * a completed accounts read for the same reason {@link disabledReason} is:
 * a list the panel never loaded is not evidence that an account is unusable.
 *
 * @returns The consequence phrase, or `null` when the account can poll or the
 *   panel cannot tell.
 */
export function accountConsequencePhrase(
    bindings: BindingsTabState,
    binding: BindingView,
): string | null {
    if (bindings.status !== 'ready') {
        return null;
    }

    const account = bindings.accounts.find(
        (candidate) => candidate.numericUserId === binding.accountNumericUserId,
    );
    if (account === undefined || account.usable) {
        return null;
    }

    const reason =
        account.state === 'error' && typeof account.errorReason === 'string'
            ? account.errorReason
            : account.state ?? account.connectionState ?? 'not reported';

    return `account cannot poll (${reason})`;
}

/**
 * Compose one binding row.
 *
 * @returns The list row.
 */
export function bindingRow(bindings: BindingsTabState, binding: BindingView): ListItem {
    const row = statusRowOf(bindings, binding.bindingId);
    const scan = row === null ? NOT_SCANNED : scanPhrase(row);
    const reason = disabledReason(bindings, binding);
    const state = statePhrase(binding.state, reason);
    const consequence = accountConsequencePhrase(bindings, binding);
    const parts = [
        state,
        `polled as ${binding.accountLogin}`,
        consequence,
        binding.projectId,
        promptSummary(binding),
        binding.actorsClause,
        // The one label a row may carry from the history scope — and nothing else
        // derived from it (002 FR-091).
        binding.historyScopeLabel,
        scan,
    ];
    const subtitle = parts.filter((part): part is string => part !== null).join(' · ');

    return {
        id: binding.bindingId,
        leading: binding.state === 'active' ? 'on' : 'off',
        title: `${binding.repository} → ${binding.projectId}`,
        subtitle,
        meta: String(row === null ? 0 : row.pendingCount),
    };
}

/**
 * Build the bindings list rows from state.
 *
 * @returns The list rows, in stored order.
 */
export function bindingRows(bindings: BindingsTabState): ListItem[] {
    return bindings.bindings.map((binding) => bindingRow(bindings, toView(binding)));
}

/**
 * The selected binding's own line: state, stamps, and its scan (005 FR-053).
 *
 * These are the three facts that describe *this row* rather than the form
 * around it: whether it polls, when it was created and last changed, and what
 * the service's scan has done with it. A binding no scan has reached yet
 * reads `not scanned yet` with a pending count of zero — never a blank, and
 * never an invented "it is fine".
 *
 * **The window in force is deliberately not here** (002 FR-091). A row summary may
 * name the mode's short label and may derive **nothing else** from it, and a bare
 * `window from <stamp>` is exactly that: a second rendering of the window, on a
 * surface with none of FR-092's "the service computed this" labelling beside it, so
 * it reads as something the operator chose. The editor's own line carries both ends
 * of the window with that labelling, and the row carries the label alone.
 *
 * @returns The detail line, or `null` when no binding is selected.
 */
export function selectedBindingDetail(bindings: BindingsTabState): string | null {
    const binding = bindings.bindings.find((candidate) => candidate.bindingId === bindings.selectedBinding);
    if (binding === undefined) {
        return null;
    }

    const status = bindings.statusRows.find((row) => row.bindingId === binding.bindingId) ?? null;
    const scan = status === null ? NOT_SCANNED : scanPhrase(status);
    const pending = status === null ? 0 : status.pendingCount;
    const state = binding.state === 'active' ? 'enabled' : 'disabled';

    return `${state} · created ${utcStamp(binding.createdAt)} · updated ${utcStamp(binding.updatedAt)}`
        + ` · ${scan} · ${pending} pending`;
}
