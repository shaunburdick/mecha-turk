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
import type { PlainRunState, RunRow } from './runs-service.ts';

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
 * Badge tone per plain run state.
 *
 * The badge reports the *queue's* verdict — `dispatched` means a session was
 * reported, not that the panel is done with the run — so success-green is
 * reserved for that one answered state. Every state that means "an operator
 * must decide" reads as a warning, and the one state that means "the budget is
 * spent and nothing further happens without a human" reads as an error. The
 * tone map is deliberately never success-toned for a failure (FR-040, AC-113).
 *
 * @param state - One of the seven plain states.
 * @returns The badge tone for that state.
 */
const PLAIN_STATE_TONES: Record<Exclude<PlainRunState, 'dead-lettered'>, Tone> = {
    pending: 'neutral',
    claimed: 'info',
    starting: 'info',
    dispatched: 'success',
    failed: 'warning',
    unconfirmed: 'warning',
};

/**
 * Badge tone for one of the seven plain states.
 *
 * `dead-lettered` is handled by comparison rather than as a literal key so the
 * map above stays exhaustively typed over the camel-case members only.
 *
 * @param state - One of the seven plain states.
 * @returns The badge tone for that state.
 */
function plainStateTone(state: PlainRunState): Tone {
    return state === 'dead-lettered' ? 'error' : PLAIN_STATE_TONES[state];
}

/**
 * Whether a state is one of the open `blocked:<reason>` family.
 *
 * The family is open (`blocked:project-missing`, `blocked:binding-missing`,
 * and the declared-but-not-yet-produced `blocked:credential`/`blocked:policy`),
 * so it is matched by prefix rather than by an enum that would go stale.
 *
 * @param state - State of the run.
 * @returns `true` for the family, which a plain state can never be.
 */
function isBlockedState(state: RunRow['state']): state is `blocked:${string}` {
    return state.startsWith('blocked:');
}

/**
 * Badge tone for any run state, including the `blocked:<reason>` family.
 *
 * @param state - State of the run.
 * @returns The badge tone for that state.
 */
function stateTone(state: RunRow['state']): Tone {
    return isBlockedState(state) ? 'warning' : plainStateTone(state);
}

/**
 * Whether the retry affordance applies to one run.
 *
 * The panel offers it wherever the run might still be requeued, and a click
 * that the service's own state verdict refuses still reaches that verdict —
 * the service answers each source state with its own distinct message, which
 * the row renders rather than second-guessing. Narrowing this to the states
 * the service actually accepts (`failed`, `blocked:*`) is 003 T-024's work;
 * until then a stale click is refused honestly rather than silently dropped.
 *
 * @param row - Run to judge.
 * @returns `true` when the retry control is offered.
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
