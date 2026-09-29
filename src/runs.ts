/**
 * The Runs section's actions (M8): read the history, open the issue, retry.
 *
 * The service owns the queue; this module reads its credential-free
 * projection (`GET /v1/events`, all states, newest detected first, capped at
 * 100) and requeues one non-dispatched run through
 * `POST /v1/events/:id/retry`. Nothing here dispatches: a retry only returns
 * the run to `pending`, and the relay's own loop is what starts it again.
 *
 * Every action is fail-quiet in the panel's own idiom — a refused call lands
 * on the section's note line (with the service's envelope code where one
 * exists), never as an exception that could take the panel down. The list
 * re-reads after a retry so the row the operator just acted on shows the
 * state the service actually stored, and only then is the outcome note
 * written, so a refresh can never clobber the explanation.
 */

import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { canRetry, runAffordance, selectedRun } from './runs-rows.ts';
import { EVENTS_PATH, retryPath, serviceGet, servicePost } from './service-calls.ts';
import { parseRunsBody } from './runs-service.ts';
import { describeError } from './session.ts';
import type { ServiceErrorResult } from './service-calls.ts';
import type { PanelRuntime } from './panel-state.ts';
import type { RunRow } from './runs-service.ts';

/**
 * Whether the mount still runs; a function call the analyzer never narrows.
 *
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
function stillMounted(rt: PanelRuntime): boolean {
    return rt.disposed === false;
}

/**
 * Read the runs history from the service.
 *
 * A failed or unreadable read keeps the rows the panel already holds — the
 * note explains what went wrong instead of blanking a list the operator was
 * reading — while a successful read replaces them wholesale and drops a
 * selection whose row is gone.
 *
 * @param rt - Panel runtime.
 */
export async function loadRuns(rt: PanelRuntime): Promise<void> {
    const { runs } = rt.state.repos;
    if (rt.disposed || runs.status === 'loading') {
        return;
    }

    runs.status = 'loading';
    refresh(rt);

    const result = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: EVENTS_PATH });
    if (!stillMounted(rt)) {
        return;
    }

    if (!result.ok) {
        runs.status = 'error';
        runs.note = redact(`Runs list not loaded: ${result.problem}.`);
        refresh(rt);

        return;
    }

    const rows = parseRunsBody(result.body);
    if (rows === null) {
        runs.status = 'error';
        runs.note = 'The service answered a runs list the panel could not read — refresh to retry.';
        refresh(rt);

        return;
    }

    runs.rows = rows;
    if (runs.selectedRun !== null && !rows.some((row) => row.id === runs.selectedRun)) {
        runs.selectedRun = null;
    }

    runs.status = 'ready';
    runs.note = '';
    refresh(rt);
}

/**
 * Record the run the operator selected for the open/retry buttons.
 *
 * Unknown ids are ignored rather than stored: the list only offers ids that
 * came from the service, and a stale selection must not silently target some
 * later row.
 *
 * @param rt - Panel runtime.
 * @param id - Row id the list reported.
 */
export function selectRun(rt: PanelRuntime, id: string): void {
    const { runs } = rt.state.repos;
    if (rt.disposed) {
        return;
    }

    if (runs.rows.some((row) => row.id === id)) {
        runs.selectedRun = id;
    }

    refresh(rt);
}

/**
 * Open the selected run's issue in the operator's browser.
 *
 * A host refusal lands on the runs note like every other action's failure —
 * an explicit outcome rather than a silently swallowed one — and the row
 * keeps its URL visible in the issue itself either way.
 *
 * @param rt - Panel runtime.
 */
export async function openRun(rt: PanelRuntime): Promise<void> {
    const row = selectedRun(rt.state.repos.runs);
    if (row === null) {
        return;
    }

    try {
        await rt.host.openUrl(row.issueUrl);
    } catch (cause) {
        rt.state.repos.runs.note = redact(`The issue could not be opened: ${describeError(cause)}.`);
        refresh(rt);
    }
}

/** Note shown when a dispatched run is asked for a retry (local and service refusal share it). */
const ALREADY_DISPATCHED_NOTE =
    'The service refused: this run was already dispatched, and a dispatched run cannot be retried.';

/**
 * Explain one retry answer in the operator's own vocabulary.
 *
 * The two documented refusals get their own sentences because they are
 * facts about the run (`invalid-transition`: already dispatched, terminal;
 * `not-found`: no longer in the queue), while anything else is reported as
 * the connection-level problem it is.
 *
 * @param result - The retry answer.
 * @param row - Run the retry targeted, for the success confirmation.
 * @returns The note to show after the list re-reads.
 */
function retryNoteOf(result: ServiceErrorResult, row: RunRow): string {
    if (result.ok) {
        return `Requeued #${row.issueNumber} — the next relay poll dispatches it again.`;
    }

    if (result.code === 'invalid-transition') {
        return ALREADY_DISPATCHED_NOTE;
    }

    if (result.code === 'not-found') {
        return 'The service refused: this run is no longer in the service queue.';
    }

    return redact(`The service refused the retry: ${result.problem}.`);
}

/**
 * Requeue the selected run and refresh the list (M8).
 *
 * Only a run the service still treats as retryable is sent — a dispatched
 * row is refused locally with the same message the service would answer —
 * and the list is re-read afterwards either way, so the row and the note
 * never disagree about what happened.
 *
 * @param rt - Panel runtime.
 */
export async function retryRun(rt: PanelRuntime): Promise<void> {
    const { runs } = rt.state.repos;
    const row = selectedRun(runs);
    if (row === null) {
        return;
    }

    if (!canRetry(row)) {
        // T-024 replaced the boolean with a table: every state that offers no
        // retry carries its own reason, so a click (or a stale Enter key) on
        // one lands on the fact instead of on copy written for a different
        // state.
        runs.note = redact(row.state === 'dispatched' ? ALREADY_DISPATCHED_NOTE : runAffordance(row).reason);
        refresh(rt);

        return;
    }

    const result = await servicePost({ serviceRequest: rt.host.serviceRequest, path: retryPath(row.id) });
    if (!stillMounted(rt)) {
        return;
    }

    await loadRuns(rt);
    if (!stillMounted(rt)) {
        return;
    }

    runs.note = retryNoteOf(result, row);
    refresh(rt);
}
