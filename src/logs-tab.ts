/**
 * The Logs tab: the service's retained stream, its activation-scoped
 * cadence, and honest restart/failure copy (010 FR-004–FR-007).
 */

import { mountButton } from '@openchamber/sdk/ui';
import type { ButtonHandle } from '@openchamber/sdk/ui';
import { nowIso } from './ids.ts';
import { LOGS_REFRESH_LABEL, LOGS_RESTART_LINE, logRowText, logsCadenceLine, logsReadStateLine } from './logs-rows.ts';
import { parseLogsAnswer } from './logs-service.ts';
import type { LogsAnswer, LogsEntry } from './logs-service.ts';
import { LOGS_TAB } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { redact } from './redaction.ts';
import { refresh } from './panel-ui.ts';
import { LOGS_PATH, serviceGet } from './service-calls.ts';
import { createBlock, createRowList, lineRow, mountCell } from './style.ts';
import type { Block, Cell, DefRow } from './style.ts';

const LOGS_HEADING = 'Logs';

const STREAM_HEADING = 'Stream';

/**
 * The panel's hold mirrors the service ring's capacity (FR-004) — a second
 * declaration of it, like `ReferenceWindow` in `service-envelope.ts`, because
 * the extension cannot import across the extension/service boundary.
 */
const HELD_LINE_CAP = 1_000;

/**
 * The tab keeps the lines it last read even when a later read fails, because
 * the retained stream must be **marked stale** rather than swapped for a
 * reassuring blank; `stale` is exactly that mark, and it is cleared by the
 * next read that lands.
 */
export interface LogsTabState {
    phase: 'idle' | 'loading' | 'loaded' | 'failed';
    at: string | null;
    problem: string | null;
    stale: boolean;
    /** Held lines in ascending `seq`, capped at {@link HELD_LINE_CAP} drop-oldest. */
    lines: readonly LogsEntry[];
    /** The stream's process start stamp, or `null` before the first answer. */
    startedAt: number | null;
    /** Whether a read has shown the service restarted this mount (FR-006). */
    restarted: boolean;
}

/** Build the empty Logs tab state. */
export function initialLogs(): LogsTabState {
    return {
        phase: 'idle',
        at: null,
        problem: null,
        stale: false,
        lines: [],
        startedAt: null,
        restarted: false,
    };
}

export interface LogsTabUi {
    readonly overview: Block;
    /** Explicit refresh — the tab's one on-demand read, and every retry (FR-014). */
    readonly refreshButton: ButtonHandle;
    readonly readLine: Cell;
    /** One line stating the tab's own refresh cadence, or that it is not refreshing itself (FR-101). */
    readonly cadenceLine: Cell;
    /** Wrapper around the restart line, hidden until a read shows a restart. */
    readonly restartBox: HTMLElement;
    readonly restartLine: Cell;
    readonly stream: Block;
    readonly list: HTMLElement;
    rows: readonly DefRow[];
}

/**
 * Whether the runtime was torn down mid-read.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

function paintRows(ui: LogsTabUi, lines: readonly LogsEntry[]): void {
    for (const row of ui.rows) {
        row.dispose();
    }

    // Newest first: the line that just arrived is the first one on screen (FR-004).
    ui.rows = lines.toReversed().map((entry) => lineRow(ui.list, { line: logRowText(entry) }));
}

/**
 * Repaint this tab from its slice and the armed period; no-op before mount.
 */
function repaintLogsTab(rt: PanelRuntime): void {
    const ui = rt.logsUi;
    if (ui === null) {
        return;
    }

    const slice = rt.state.logsTab;
    const isLoading = slice.phase === 'loading';
    ui.refreshButton.update({ disabled: isLoading, loading: isLoading });
    ui.readLine.update(logsReadStateLine(slice));
    // The cadence is a statement about what this tab is doing, so it sits in
    // the title block beside the refresh control (FR-039, FR-101).
    ui.cadenceLine.update(logsCadenceLine(rt.logsRefreshMs));
    ui.restartBox.hidden = !slice.restarted;
    paintRows(ui, slice.lines);
}

/** Repaint the shared framing and then this tab, after one step of a read. */
function repaintAfterRead(rt: PanelRuntime): void {
    refresh(rt);
    repaintLogsTab(rt);
}

/**
 * Release the refresh tick, and with it the period the tab was running on —
 * called when another tab takes over, when an answer carries no readable
 * interval (so the statement and the timer cannot disagree), and on disposal.
 */
export function stopLogsRefresh(rt: PanelRuntime): void {
    rt.logsRefreshMs = null;
    if (rt.logsRefreshTimer === null) {
        return;
    }

    clearInterval(rt.logsRefreshTimer);
    rt.logsRefreshTimer = null;
}

/**
 * Arm the tick on the interval the last landed answer reported, in
 * `armStatusRefresh`'s shape: at most one tick per panel (idempotent for an
 * unchanged period), armed only while Logs is the active tab, and never
 * derived from the read's outcome — a cadence is not a retry loop (FR-005).
 */
export function armLogsRefresh(input: {
    readonly rt: PanelRuntime;
    readonly intervalMs: number;
    readonly tick: () => void;
}): void {
    const { rt, intervalMs, tick } = input;
    if (rt.disposed || rt.activeTab !== LOGS_TAB) {
        return;
    }

    if (rt.logsRefreshMs === intervalMs && rt.logsRefreshTimer !== null) {
        return;
    }

    stopLogsRefresh(rt);
    rt.logsRefreshMs = intervalMs;
    // Unref'd like Status's tick, so an idle panel never holds a process open;
    // teardown clears it through `disposeLogsTab` (NFR-108).
    rt.logsRefreshTimer = setInterval(tick, intervalMs);
    if (typeof rt.logsRefreshTimer.unref === 'function') {
        rt.logsRefreshTimer.unref();
    }
}

/** Merge an answer's entries behind the held set's own newest `seq`, capping the hold drop-oldest (FR-004). */
function mergeLines(held: readonly LogsEntry[], entries: readonly LogsEntry[]): readonly LogsEntry[] {
    const cursor = held.at(-1)?.seq ?? null;
    const merged = cursor === null ? [...entries] : [...held, ...entries.filter((entry) => entry.seq > cursor)];

    return merged.length > HELD_LINE_CAP ? merged.slice(merged.length - HELD_LINE_CAP) : merged;
}

/** One read's classified outcome: the panel's honest answers to one page of the stream. */
type ReadOutcome =
    | { readonly kind: 'gone' }
    | { readonly kind: 'failed'; readonly problem: string }
    | { readonly kind: 'restart'; readonly view: LogsAnswer }
    | { readonly kind: 'landed'; readonly view: LogsAnswer };

/**
 * Read one page behind `cursor` and classify it; only the loading state and,
 * on a refusal, the cause are written here — everything else is the caller's
 * to apply to the slice it owns.
 */
async function readPage(rt: PanelRuntime, cursor: number | null): Promise<ReadOutcome> {
    const slice = rt.state.logsTab;
    slice.phase = 'loading';
    repaintAfterRead(rt);

    const answer = await serviceGet({
        serviceRequest: rt.host.serviceRequest,
        path: cursor === null ? LOGS_PATH : `${LOGS_PATH}?cursor=${cursor}`,
    });
    if (tornDown(rt)) {
        return { kind: 'gone' };
    }

    const view = answer.ok ? parseLogsAnswer(answer.body) : null;
    if (view === null) {
        return {
            kind: 'failed',
            problem: redact(
                answer.ok ? 'the service answered a logs document the panel could not read' : answer.problem,
            ),
        };
    }

    if (slice.startedAt !== null && view.startedAt !== slice.startedAt) {
        return { kind: 'restart', view };
    }

    return { kind: 'landed', view };
}

/** Apply a landed answer: merge the hold, stamp the read, and arm — or disarm for an interval-less answer. */
function applyLanded(rt: PanelRuntime, view: LogsAnswer, tick: () => void): void {
    const slice = rt.state.logsTab;
    slice.lines = mergeLines(slice.lines, view.entries);
    slice.startedAt = view.startedAt;
    slice.phase = 'loaded';
    slice.problem = null;
    slice.stale = false;
    slice.at = nowIso();
    rt.shell?.noteRead(LOGS_TAB, slice.at);
    // The statement and the timer are never allowed to disagree: an
    // interval-less answer disarms anything armed (plan pin 8).
    if (view.intervalMs === null) {
        stopLogsRefresh(rt);
    } else {
        armLogsRefresh({ rt, intervalMs: view.intervalMs, tick });
    }
    repaintAfterRead(rt);
}

/**
 * Read `GET /v1/logs` with `limit` unset and only the derived cursor (the
 * newest held `seq`; none while nothing is held).
 *
 * In-flight refusal through `phase === 'loading'`, fail-closed parse, and on
 * success the hold merges, stamps, notes the read, and arms (or disarms, for
 * an answer with no readable `intervalMs`); a failure keeps the lines marked
 * stale with the exact cause and never disarms (FR-007).
 */
export async function loadLogs(rt: PanelRuntime): Promise<void> {
    const slice = rt.state.logsTab;
    if (rt.disposed || slice.phase === 'loading') {
        return;
    }

    // One loop turn per read: an answer whose `startedAt` changed has shown a
    // restart and its page is pre-restart history, so the stream is re-read
    // from the tail — once per call (FR-006). The bound, not the responder,
    // is what makes the loop settle: a second restart is applied as landed.
    let hasReRead = false;
    for (;;) {
        const outcome = await readPage(rt, slice.lines.at(-1)?.seq ?? null);
        if (outcome.kind === 'gone') {
            return;
        }

        if (outcome.kind === 'failed') {
            slice.phase = 'failed';
            slice.problem = outcome.problem;
            slice.stale = slice.lines.length > 0;
            repaintAfterRead(rt);

            return;
        }

        if (!hasReRead && outcome.kind === 'restart') {
            // One act: the restart drops the held lines and, with them, the
            // cursor (plan pin 9) — and the note says so in words (FR-006).
            hasReRead = true;
            slice.lines = [];
            slice.startedAt = outcome.view.startedAt;
            slice.restarted = true;

            continue;
        }

        applyLanded(rt, outcome.view, () => {
            void loadLogs(rt);
        });

        return;
    }
}

/**
 * Mount the title block — the refresh control, read state, cadence, restart
 * line — and the `Stream` block's row list; the first read is the activation
 * read `tabs.ts` issues, exactly as Status's.
 */
export function mountLogsTab(input: {
    readonly rt: PanelRuntime;
    readonly parent: HTMLElement;
}): LogsTabUi {
    const { rt, parent } = input;
    // One rule across the tabs: the tab title is the first block's heading,
    // and the tab's controls live inside that block.
    const overview = createBlock(parent, { heading: LOGS_HEADING, title: true });
    const row = parent.ownerDocument.createElement('div');
    row.className = 'mt-toolbar';
    overview.body.append(row);

    const refreshButton = mountButton(row, {
        label: LOGS_REFRESH_LABEL,
        onClick: () => {
            void loadLogs(rt);
        },
    });
    const readLine = mountCell(row, { className: 'mt-lede', text: logsReadStateLine(rt.state.logsTab) });
    // Mounted already stating the honest value: the first read has not run
    // yet, so no period is known and the tab says it is not refreshing itself
    // rather than showing a number nobody reported (FR-101, NFR-112).
    const cadenceLine = mountCell(row, { className: 'mt-lede', text: logsCadenceLine(rt.logsRefreshMs) });

    const restartBox = parent.ownerDocument.createElement('div');
    restartBox.hidden = true;
    overview.body.append(restartBox);
    const restartLine = mountCell(restartBox, { className: 'mt-lede', text: LOGS_RESTART_LINE });

    const stream = createBlock(parent, { heading: STREAM_HEADING });
    const ui: LogsTabUi = {
        overview,
        refreshButton,
        readLine,
        cadenceLine,
        restartBox,
        restartLine,
        stream,
        list: createRowList(stream.body),
        rows: [],
    };
    rt.logsUi = ui;
    repaintLogsTab(rt);

    return ui;
}

/**
 * Dispose the Logs tab's handles, release its rows, and stop the tick.
 */
export function disposeLogsTab(rt: PanelRuntime): void {
    const ui = rt.logsUi;
    if (ui === null) {
        return;
    }

    for (const row of ui.rows) {
        row.dispose();
    }

    ui.refreshButton.dispose();
    ui.readLine.dispose();
    ui.cadenceLine.dispose();
    ui.restartLine.dispose();
    ui.restartBox.remove();
    ui.overview.dispose();
    ui.stream.dispose();
    rt.logsUi = null;
    stopLogsRefresh(rt);
}
