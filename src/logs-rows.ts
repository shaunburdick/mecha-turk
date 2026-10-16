/**
 * Pure rendering for the Logs tab: one text row per retained line, and the
 * read-state, restart, and cadence copy (010 FR-004, FR-006, FR-007).
 */

import { tryParseJson } from './json.ts';
import { cadenceLine } from './status-lines.ts';
import type { LogsEntry } from './logs-service.ts';
import type { LogsTabState } from './logs-tab.ts';

/** The one manual read and its retry, one control (010 plan pin 12). */
export const LOGS_REFRESH_LABEL = 'Refresh logs';

/** What the tab says once a read's answer showed the service restarted (FR-006's two facts). */
export const LOGS_RESTART_LINE = 'The service restarted; lines from before it are not kept.';

/** The fields the serialized line carries its head as; everything else is a field (service `log.ts`). */
const HEAD_MEMBERS = ['ts', 'level', 'message'] as const;

const HEAD_MEMBER_SET: ReadonlySet<string> = new Set<string>(HEAD_MEMBERS);

function scalarText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (value === null || typeof value !== 'object') {
        return String(value);
    }

    return JSON.stringify(value);
}

/**
 * Render one retained line as its row text, newest facts first.
 *
 * One trailing newline is trimmed for **display only** — the wire and the
 * ring keep the serialized bytes; a line that is not a JSON object renders
 * its own text rather than disappearing, because a viewer that hides a line
 * it cannot parse falsifies the stream (FR-004).
 */
export function logRowText(entry: LogsEntry): string {
    const text = entry.line.endsWith('\n') ? entry.line.slice(0, -1) : entry.line;
    const parsed = tryParseJson(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return text;
    }

    const record = parsed as Record<string, unknown>;
    const head = HEAD_MEMBERS
        .filter((member) => record[member] !== undefined)
        .map((member) => scalarText(record[member]))
        .join(' ');
    const fields = Object.entries(record)
        .filter(([member]) => !HEAD_MEMBER_SET.has(member))
        .map(([key, value]) => `${key}: ${scalarText(value)}`)
        .join(', ');
    const composed = [head, fields].filter((part) => part !== '').join(' — ');

    return composed === '' ? text : composed;
}

/**
 * The tab's own read state, in FR-019's three shapes.
 *
 * A failure keeps the lines it already holds and says so with the word
 * *stale*; a failure with nothing retained says plainly that there are none.
 */
export function logsReadStateLine(slice: LogsTabState): string {
    if (slice.phase === 'idle') {
        return 'Logs: not read yet.';
    }

    if (slice.phase === 'loading') {
        return 'Logs: reading…';
    }

    if (slice.phase === 'loaded') {
        return `Logs: read at ${slice.at ?? 'an unknown time'}.`;
    }

    const cause = slice.problem ?? 'the service did not answer';
    if (!slice.stale) {
        return `Logs could not be read: ${cause}. Nothing has been read yet.`;
    }

    return `Logs could not be re-read: ${cause}. Showing the read from ${slice.at}, which may be stale.`;
}

/** The tab's cadence statement, naming this tab's own control (FR-005, AC-006). */
export function logsCadenceLine(refreshMs: number | null): string {
    return cadenceLine({ refreshMs, refreshLabel: LOGS_REFRESH_LABEL });
}
