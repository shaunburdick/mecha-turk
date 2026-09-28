/**
 * Stored schema and parser for one relay event (MVP tasks M1/M2).
 *
 * `events.json` is one flat array of {@link QueuedEvent} rows, and this module
 * owns the whole read side of that contract: the row type, the field
 * vocabulary the writer emits, and the validator the store runs before it
 * trusts a file. The parse block lives apart from `events.ts` (chain,
 * enqueue, claim, dispatch) so each module stays inside the file-length gate;
 * the queue module re-exports everything here so callers keep one import path.
 *
 * `issueNumber` is a **number** on both the writer and the wire
 * ({@link QueuedEvent.issueNumber}, `EventSnapshot.issue`), so it is
 * deliberately *not* in {@link REQUIRED_FIELDS}: that list is the text set,
 * validated with `typeof value === 'string'`, and requiring text there made
 * the writer's own output fail validation — every `events.json` was
 * quarantined on first read and the pending queue was silently lost. The
 * field keeps its own presence-and-shape check in {@link parseStoredEvent}
 * via `positiveIntOf`, so a missing, string, zero, or fractional value still
 * quarantines the file.
 */

import { isRecord } from '../json.ts';

/** Event kinds the service enqueues; M1 ships assignment only. */
export type EventKind = 'assignment' | 'mention';

/** Lifecycle of one relay event. */
export type EventState = 'pending' | 'in-flight' | 'dispatched';

/** One relay event, exactly as stored and shipped. */
export interface QueuedEvent {
    /** Deterministic `[A-Za-z0-9._~|-]`-shaped id, usable as one path segment. */
    readonly id: string;
    /** Binding that produced this event. */
    readonly bindingId: string;
    /** Trigger kind; only `assignment` is implemented at this cut. */
    readonly kind: EventKind;
    /** The repository in `owner/name` form. */
    readonly repository: string;
    /** GitHub numeric user id of the account that owns the assignment. */
    readonly accountNumericUserId: string;
    /** Display login of that account (not a credential). */
    readonly accountLogin: string;
    /** Project id the dispatch targets, snapshotted at enqueue. */
    readonly projectId: string;
    /** Worktree option snapshotted at enqueue (`none`/`generated`/`new:<name>`). */
    readonly worktreeOption: string;
    /** Issue number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text. */
    readonly issueTitle: string;
    /** Canonical GitHub issue URL. */
    readonly issueUrl: string;
    /** Truncated issue body; untrusted source text, bounded at enqueue. */
    readonly issueBodyExcerpt: string;
    /** Operator-readable trigger phrase the panel shows in the dispatch context. */
    readonly triggerNote: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** Queue state, flipped in place by a claim and a dispatch. */
    readonly state: EventState;
    /** Claim stamp when in-flight, else `null`. */
    readonly claimedAt: string | null;
    /** Dispatch stamp once the panel answered, else `null`. */
    readonly dispatchedAt: string | null;
    /** Session id or the failure text the panel reported, else `null`. */
    readonly dispatchResult: string | null;
}

/**
 * Every field a stored event must carry as non-empty text.
 *
 * `issueNumber` is absent on purpose — it is a number, checked by
 * `positiveIntOf` in {@link parseStoredEvent}; see the module header.
 */
const REQUIRED_FIELDS = [
    'id',
    'bindingId',
    'kind',
    'repository',
    'accountNumericUserId',
    'accountLogin',
    'projectId',
    'worktreeOption',
    'issueTitle',
    'issueUrl',
    'triggerNote',
    'detectedAt',
] as const;

/** Fields a row may carry as a string or a literal `null`. */
const NULLABLE_FIELDS = ['claimedAt', 'dispatchedAt', 'dispatchResult'] as const;

/** Queue states the file may carry. */
const KNOWN_STATES = new Set<string>(['pending', 'in-flight', 'dispatched']);

/**
 * Validate the event fields that must carry usable text.
 *
 * @param record - Parsed candidate row.
 * @param fields - Field names to check.
 * @returns `true` when every field is usable text.
 */
function isUsableTextFieldSet(record: Record<string, unknown>, fields: readonly string[]): boolean {
    return fields.every((field) => {
        const value = record[field];

        return field in record && typeof value === 'string' && value !== '';
    });
}

/**
 * Validate the event fields that carry a stamp-or-null.
 *
 * @param record - Parsed candidate row.
 * @param fields - Field names to check.
 * @returns `true` when every field is a string or literal `null`.
 */
function isNullableTextFieldSet(record: Record<string, unknown>, fields: readonly string[]): boolean {
    return fields.every((field) => {
        const value = record[field];

        return value === null || typeof value === 'string';
    });
}

/**
 * Read one positive integer field.
 *
 * @param value - Candidate value.
 * @returns The integer, or `null` when the value is not one.
 */
function positiveIntOf(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
/**
 * Validate the stored `state` field.
 *
 * @param value - Candidate value.
 * @returns The state name, or `null` when it is from another vocabulary.
 */
function knownStateOf(value: unknown): string | null {
    if (typeof value !== 'string' || !KNOWN_STATES.has(value)) {
        return null;
    }

    return value;
}

/**
 * Validate every text and nullable field of one stored row.
 *
 * @param record - Parsed candidate row.
 * @returns `true` when all fields hold usable values.
 */
function fieldsHold(record: Record<string, unknown>): boolean {
    return isUsableTextFieldSet(record, REQUIRED_FIELDS) && isNullableTextFieldSet(record, NULLABLE_FIELDS);
}

/**
 * Parse one stored event row.
 *
 * The writer's own output is the shape this must accept: every text field
 * non-empty, `issueNumber` a positive integer, `state` from the queue
 * vocabulary, and an excerpt that may legitimately be `''` (an issue with no
 * body). Anything else — including a row missing `issueNumber` outright —
 * answers `null`, which the store turns into a quarantine.
 *
 * @param raw - One element from the stored array.
 * @returns The event, or `null` when the row cannot be trusted.
 */
export function parseStoredEvent(raw: unknown): QueuedEvent | null {
    const record = isRecord(raw) ? raw : null;
    if (record === null) {
        return null;
    }

    if (!fieldsHold(record)) {
        return null;
    }

    const state = knownStateOf(record.state);
    const issueNumber = positiveIntOf(record.issueNumber);
    if (state === null || issueNumber === null || typeof record.issueBodyExcerpt !== 'string') {
        return null;
    }

    const detectedAt = record.detectedAt as string;
    if (Number.isNaN(Date.parse(detectedAt))) {
        return null;
    }

    return {
        id: record.id as string,
        bindingId: record.bindingId as string,
        kind: record.kind as EventKind,
        repository: record.repository as string,
        accountNumericUserId: record.accountNumericUserId as string,
        accountLogin: record.accountLogin as string,
        projectId: record.projectId as string,
        worktreeOption: record.worktreeOption as string,
        issueNumber,
        issueTitle: record.issueTitle as string,
        issueUrl: record.issueUrl as string,
        issueBodyExcerpt: record.issueBodyExcerpt,
        triggerNote: record.triggerNote as string,
        detectedAt,
        state: state as EventState,
        claimedAt: record.claimedAt as string | null,
        dispatchedAt: record.dispatchedAt as string | null,
        dispatchResult: record.dispatchResult as string | null,
    };
}

/**
 * Parse the whole stored queue.
 *
 * @param raw - Parsed `events.json` document.
 * @returns The queue, or `null` when the document is unusable (quarantined).
 */
export function parseStoredEvents(raw: unknown): QueuedEvent[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }

    const events: QueuedEvent[] = [];
    for (const entry of raw) {
        const event = parseStoredEvent(entry);
        if (event === null) {
            return null;
        }

        events.push(event);
    }

    return events;
}
