/**
 * The runs-history surface the Runs section reads (M8).
 *
 * `GET /v1/events` answers with the service's credential-free projection of
 * every queued event — pending, in-flight, and dispatched alike, newest
 * detected first, capped at 100 — so this module owns that DTO and its
 * parser, kept beside the runs actions rather than inside `repos-service.ts`
 * (the bindings/claim surface), which the file-length limit would otherwise
 * push past its own responsibility.
 *
 * Parsing follows the fail-closed rule the panel states for every service
 * body: a row that cannot be fully understood reads as *unreadable*, never
 * as a partial record the operator might trust. The two readers shared with
 * the claim parser — {@link issueNumberFrom} and {@link eventKindOf} — come
 * from `repos-service.ts` so the two parsers hold one opinion about what an
 * event row is.
 */

import { asRecord, fieldsHoldText, parseJsonObject, textOrNull } from './json.ts';
import { eventKindOf, issueNumberFrom } from './repos-service.ts';

/** One event as the runs history (`GET /v1/events`) projects it. */
export interface RunRow {
    /** Deterministic event id; the retry path segment and the row key. */
    readonly id: string;
    /** Trigger kind the event was enqueued for. */
    readonly kind: 'assignment' | 'mention' | 'review';
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** Issue (or pull request) number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text rendered as plain text only. */
    readonly issueTitle: string;
    /** Canonical issue URL the Open-issue action opens. */
    readonly issueUrl: string;
    /** Queue state: `pending`, `in-flight`, or `dispatched`. */
    readonly state: 'pending' | 'in-flight' | 'dispatched';
    /** RFC 3339 detection stamp the row's relative age derives from. */
    readonly detectedAt: string;
    /** Claim stamp when (or after) it was claimed, else `null`. */
    readonly claimedAt: string | null;
    /** Dispatch stamp once the panel answered, else `null`. */
    readonly dispatchedAt: string | null;
    /** Session id or failure text the panel reported, else `null`. */
    readonly dispatchResult: string | null;
    /** Binding that produced the event. */
    readonly bindingId: string;
    /** Head SHA of a review-event pull request; `null` on every other kind. */
    readonly headSha: string | null;
    /** Base ref of that pull request; `null` on every other kind. */
    readonly baseRef: string | null;
}

/** Fields one runs-history row must carry as plain strings. */
const RUN_STRING_FIELDS = ['id', 'repository', 'issueTitle', 'issueUrl', 'bindingId', 'detectedAt'] as const;

/**
 * Narrow one raw queue state to the three the service can answer with.
 *
 * @param value - Candidate state from a stored row.
 * @returns The state, or `null` when the row is unusable.
 */
function runStateOf(value: unknown): RunRow['state'] | null {
    return value === 'pending' || value === 'in-flight' || value === 'dispatched' ? value : null;
}

/**
 * Parse one runs-history row.
 *
 * Unlike the pending claim (which skips a row it cannot read so the relay
 * keeps moving), one unusable row fails the whole body: the runs list is a
 * *record* the operator reads, and a half-trusted record is worse than an
 * honest "unreadable" note. `kind` is the one lenient field — a row from a
 * future build's unknown trigger reads as `assignment` rather than blanking
 * the list (same rule the relay's parser applies).
 *
 * @param value - One element of the `events` array.
 * @returns The row, or `null` when its shape is unusable.
 */
function parseRunEntry(value: unknown): RunRow | null {
    const record = asRecord(value);
    if (record === null || !fieldsHoldText(record, RUN_STRING_FIELDS)) {
        return null;
    }

    const state = runStateOf(record.state);
    const issueNumber = issueNumberFrom(record);
    if (state === null || issueNumber === 0) {
        return null;
    }

    const { id, repository, issueTitle, issueUrl, bindingId, detectedAt } = record;

    return {
        id: id as string,
        kind: eventKindOf(record.kind),
        repository: repository as string,
        issueNumber,
        issueTitle: issueTitle as string,
        issueUrl: issueUrl as string,
        state,
        detectedAt: detectedAt as string,
        claimedAt: textOrNull(record, 'claimedAt'),
        dispatchedAt: textOrNull(record, 'dispatchedAt'),
        dispatchResult: textOrNull(record, 'dispatchResult'),
        bindingId: bindingId as string,
        headSha: textOrNull(record, 'headSha'),
        baseRef: textOrNull(record, 'baseRef'),
    };
}

/**
 * Parse the runs-history (`GET /v1/events`) response body.
 *
 * @param text - Response body text.
 * @returns The rows in the order the service sent them (newest detected
 *   first), or `null` when any part of the shape is unusable.
 */
export function parseRunsBody(text: string): RunRow[] | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.events)) {
        return null;
    }

    const rows: RunRow[] = [];
    for (const entry of root.events) {
        const row = parseRunEntry(entry);
        if (row === null) {
            return null;
        }

        rows.push(row);
    }

    return rows;
}
