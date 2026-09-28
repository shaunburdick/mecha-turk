/**
 * The Runs section's row copy (M8) — pure functions of panel state.
 *
 * One run is what the operator needs to judge a dispatch at a glance: which
 * trigger fired, which issue it was, what queue state it sits in now, how
 * long ago it was detected, and what the panel reported when it dispatched
 * (session id, or the problem that stopped it). Every string composed here
 * reaches the DOM through the SDK list primitives' `textContent` writes, and
 * the dispatch result — the one field a failure can put free text into —
 * additionally passes through {@link redact} as defence in depth.
 *
 * Nothing here performs IO, so the copy is testable without a live DOM.
 */

import type { ListItem, Tone } from '@openchamber/sdk/ui';
import { redact } from './redaction.ts';
import { elapsedSince } from './repos-rows.ts';
import type { RunsState } from './panel-state.ts';
import type { RunRow } from './runs-service.ts';

/** Heading above the runs list. */
export const RUNS_HEADING = 'Runs';

/** In-list placeholder while the service reports no events at all. */
export const RUNS_EMPTY_TEXT = 'No runs yet.';

/** Status line while the list is ready but empty. */
export const RUNS_EMPTY_STATUS =
    'No runs yet — a bound repository trigger appears here after the next scan.';

/** Instruction appended to the ready status line when there is something to act on. */
export const RUNS_SELECT_HINT = 'select a row to open or retry';

/** Short leading labels per trigger kind (the list's fixed-width slot). */
const KIND_LABELS: Record<RunRow['kind'], string> = {
    assignment: 'assign',
    mention: 'mention',
    review: 'review',
};

/**
 * Badge tone per queue state.
 *
 * The badge reports the *queue's* verdict — `dispatched` means the panel
 * answered the service, not that the dispatch succeeded — so success-green
 * is reserved for that answered state and the actual outcome (session id or
 * failure text) rides next to it in the row's subtitle.
 *
 * @param state - Queue state of the run.
 * @returns The badge tone for that state.
 */
function stateTone(state: RunRow['state']): Tone {
    if (state === 'pending') {
        return 'neutral';
    }

    return state === 'in-flight' ? 'info' : 'success';
}

/**
 * Whether the retry affordance applies to one run.
 *
 * The service accepts a retry for `pending` (already queued; the answer is a
 * harmless `200`) and `in-flight` (a claim the panel never finished), and
 * answers a `dispatched` run with `409 invalid-transition` — so the button
 * is enabled exactly where the service can act, and a stale click that
 * still reaches the refusal gets the service's own explanation.
 *
 * @param row - Run to judge.
 * @returns `true` when the run can be requeued.
 */
export function canRetry(row: RunRow): boolean {
    return row.state !== 'dispatched';
}

/**
 * Describe one run's dispatch result (or the honest absence of one).
 *
 * @param row - Run to describe.
 * @returns Redacted result text, or a phrase naming why there is none.
 */
function resultPhrase(row: RunRow): string {
    if (row.dispatchResult !== null) {
        return redact(row.dispatchResult);
    }

    return row.state === 'dispatched' ? 'no dispatch result recorded' : 'not dispatched yet';
}

/**
 * Compose one runs-list row.
 *
 * @param row - Run as the service projected it.
 * @returns The list row.
 */
export function runRow(row: RunRow): ListItem {
    return {
        id: row.id,
        leading: KIND_LABELS[row.kind],
        title: `#${row.issueNumber} ${row.issueTitle}`,
        subtitle: `${row.repository} · ${resultPhrase(row)}`,
        meta: elapsedSince(row.detectedAt),
        badge: { label: row.state, tone: stateTone(row.state) },
    };
}

/**
 * Build the runs list rows in the order the service sent them.
 *
 * @param runs - The Runs section's state.
 * @returns The rows, newest detected first (the service caps them at 100).
 */
export function runRows(runs: RunsState): ListItem[] {
    return runs.rows.map((row) => runRow(row));
}

/**
 * Compose the runs section's status line.
 *
 * Each lifecycle state answers in its own voice — an idle list says how to
 * load it, a failed one points at the note below — so the operator never has
 * to infer *why* the area is blank.
 *
 * @param runs - The Runs section's state.
 * @returns The status text.
 */
export function runsStatusText(runs: RunsState): string {
    if (runs.status === 'idle') {
        return 'Runs have not been read yet — press Refresh runs.';
    }

    if (runs.status === 'loading') {
        return 'Loading runs…';
    }

    if (runs.status === 'error') {
        return 'Runs list not loaded — see the note below.';
    }

    if (runs.rows.length === 0) {
        return RUNS_EMPTY_STATUS;
    }

    const noun = runs.rows.length === 1 ? 'run' : 'runs';

    return `${runs.rows.length} ${noun} · newest first · ${RUNS_SELECT_HINT}`;
}

/**
 * Find the run a run row selection points at.
 *
 * @param runs - The Runs section's state.
 * @returns The selected run, or `null` when nothing valid is selected.
 */
export function selectedRun(runs: RunsState): RunRow | null {
    return runs.rows.find((row) => row.id === runs.selectedRun) ?? null;
}
