/**
 * The `GET /v1/logs` answer and its fail-closed reader: an unshaped body answers `null`, never a partial view (inv. 8).
 */

import { parseJsonObject } from './json.ts';

/** One retained service line, as the wire carries it. */
export interface LogsEntry {
    readonly seq: number;
    readonly line: string;
}

export interface LogsAnswer {
    readonly entries: readonly LogsEntry[];
    /** The service process's start stamp (epoch ms) — the restart signal (FR-006). */
    readonly startedAt: number;
    /** The effective polling interval, or `null` when the answer carried no readable one (FR-005). */
    readonly intervalMs: number | null;
}

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asEntry(value: unknown): LogsEntry | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    const row = value as Record<string, unknown>;
    const seq = asFiniteNumber(row.seq);
    const { line } = row;
    // A fractional `seq` would become the derived cursor the route refuses on
    // every later read — fail the whole answer instead (inv. 8).
    if (seq === null || typeof line !== 'string' || !Number.isSafeInteger(seq) || seq < 0) {
        return null;
    }

    return { seq, line };
}

/**
 * Parse a whole `GET /v1/logs` body, fail closed.
 *
 * `entries` and `startedAt` are required and refuse the whole answer over any
 * bad member; `intervalMs` is deliberately gentler — a readable finite number
 * becomes the period, and anything else becomes `null` **with the answer still
 * loaded** (FR-005: an interval-less answer arms nothing, it does not fail the
 * read).
 *
 * @returns The answer, or `null` when a required member is missing or of the
 *   wrong shape — never a partially populated view.
 */
export function parseLogsAnswer(body: string): LogsAnswer | null {
    const root = parseJsonObject(body);
    if (root === null || !Array.isArray(root.entries)) {
        return null;
    }

    const entries: LogsEntry[] = [];
    for (const member of root.entries) {
        const entry = asEntry(member);
        if (entry === null) {
            return null;
        }

        entries.push(entry);
    }

    const startedAt = asFiniteNumber(root.startedAt);
    if (startedAt === null) {
        return null;
    }

    return { entries, startedAt, intervalMs: asFiniteNumber(root.intervalMs) };
}
