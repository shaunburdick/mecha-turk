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
 */

import type { ListItem } from '@openchamber/sdk/ui';
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
}

/**
 * Narrow one stored binding to what a row may show.
 *
 * @param binding - The binding as the service projected it.
 * @returns The view, with the prompt reduced to its length.
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
 * @param binding - The binding being rendered.
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
 * @param bindings - Bindings state.
 * @param bindingId - Row key.
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
 * binding, so it carries the skip reason next to when the last scan ran (or
 * that none ever did).
 *
 * @param row - The status row.
 * @returns `scan: <when> · <reason|ok>`, or `scan: never` before the first
 *   completed scan with no recorded reason.
 */
function scanPhrase(row: StatusRowView): string {
    if (row.lastScanAt === null) {
        return row.lastError === null ? 'scan: never' : `scan: never · ${row.lastError}`;
    }

    return `scan: ${elapsedSince(row.lastScanAt)} · ${row.lastError ?? 'ok'}`;
}

/**
 * Why a disabled binding is not polling, when the panel can prove it (FR-054).
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
 * @param bindings - Bindings state.
 * @param binding - The binding being judged.
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
 * @param state - The binding's own state.
 * @param reason - The reason {@link disabledReason} proved, if any.
 * @returns `null` while the binding is enabled, else the words to render.
 */
function statePhrase(state: BindingView['state'], reason: string | null): string | null {
    if (state === 'active') {
        return null;
    }

    return reason === null ? 'disabled' : `disabled — ${reason}`;
}

/**
 * Compose one binding row.
 *
 * @param bindings - Bindings state.
 * @param binding - The binding to render.
 * @returns The list row.
 */
export function bindingRow(bindings: BindingsTabState, binding: BindingView): ListItem {
    const row = statusRowOf(bindings, binding.bindingId);
    const scan = row === null ? 'not scanned yet' : scanPhrase(row);
    const reason = disabledReason(bindings, binding);
    const state = statePhrase(binding.state, reason);
    const parts = [state, `polled as ${binding.accountLogin}`, binding.projectId, promptSummary(binding), scan];
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
 * @param bindings - The Bindings tab's state.
 * @returns The list rows, in stored order.
 */
export function bindingRows(bindings: BindingsTabState): ListItem[] {
    return bindings.bindings.map((binding) => bindingRow(bindings, toView(binding)));
}
