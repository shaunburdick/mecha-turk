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
import type { Repositories } from './panel-state.ts';

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
    readonly projectId: string;
    readonly state: 'active' | 'disabled';
}

/**
 * Find the status row for one binding.
 *
 * @param bindings - Bindings state.
 * @param bindingId - Row key.
 * @returns The row, or `null` before the first poll.
 */
function statusRowOf(bindings: Repositories, bindingId: string): StatusRowView | null {
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
 * Compose one binding row.
 *
 * @param bindings - Bindings state.
 * @param binding - The binding to render.
 * @returns The list row.
 */
export function bindingRow(bindings: Repositories, binding: BindingView): ListItem {
    const row = statusRowOf(bindings, binding.bindingId);
    const scan = row === null ? 'not scanned yet' : scanPhrase(row);
    const subtitle = `polled as ${binding.accountLogin} · ${binding.projectId} · ${scan}`;

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
export function bindingRows(bindings: Repositories): ListItem[] {
    return bindings.bindings.map((binding) => bindingRow(bindings, binding));
}
