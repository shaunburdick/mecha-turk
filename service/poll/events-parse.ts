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

/** Store file holding the event queue. */
export const EVENTS_FILE = 'events.json';

/**
 * Event kinds the service enqueues: `assignment` (M1), `mention` (M6), and
 * `review` (M7). Rows written before a kind existed still parse — the queue
 * file is append-mostly and never rewritten in bulk on upgrade.
 */
export type EventKind = 'assignment' | 'mention' | 'review';

/** Lifecycle of one relay event, as the shipped three-state queue stored it. */
export type EventState = 'pending' | 'in-flight' | 'dispatched';

/** The subject shapes a delivery can be about (003 FR-010). */
export type SubjectType = 'issue' | 'pull_request';

/** One relay event, exactly as stored and shipped. */
export interface QueuedEvent {
    /** Deterministic `[A-Za-z0-9._~|-]`-shaped id, usable as one path segment. */
    readonly id: string;
    /** Binding that produced this event. */
    readonly bindingId: string;
    /** Trigger kind: assignment, mention (M6), or review (M7). */
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
    /** Head commit SHA of a review-request pull request, else `null` (M7). */
    readonly headSha: string | null;
    /** Base ref name of that pull request, else `null` (M7). */
    readonly baseRef: string | null;
    /** Operator-readable trigger phrase the panel shows in the dispatch context. */
    readonly triggerNote: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /**
     * The run this delivery belongs to (003 FR-012), assigned at enqueue.
     *
     * Absent on rows written before the run layer and on rows whose subject
     * was too ambiguous to fold into a run; rows 003 enqueues carry it.
     */
    readonly runCorrelationId?: string;
    /**
     * Whether the subject is an issue or a pull request, captured from
     * `isPullRequest` at detection so the run key's subject type is truthful
     * (a body mention can sit on a pull request). Absent on older rows, which
     * derive it from the trigger kind.
     */
    readonly subjectType?: SubjectType;
    /**
     * Queue state, flipped in place by a claim and a dispatch.
     *
     * **Frozen legacy (003):** still parsed as migration input, still written
     * by the shipped claim and dispatch paths, and *never* written by a row
     * 003 enqueues — a post-003 row carries no lifecycle fields at all, and
     * its truth lives on the run.
     */
    readonly state?: EventState;
    /** Claim stamp when (or after) it was claimed; absent on a post-003 row. */
    readonly claimedAt?: string | null;
    /** Dispatch stamp once the panel answered; absent on a post-003 row. */
    readonly dispatchedAt?: string | null;
    /** Session id or failure text the panel reported; absent on a post-003 row. */
    readonly dispatchResult?: string | null;
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

/**
 * Fields a row may carry as text, as literal `null`, or omit entirely: the
 * Slice-2 PR coordinates *and* the frozen legacy lifecycle stamps (a row 003
 * enqueued carries neither).
 *
 * The queue file outlives the build that wrote it: every `events.json`
 * written before M7 has no `headSha`/`baseRef` at all, every row written
 * before 003 has all four lifecycle fields, and every row written after it
 * has none — all three shapes must keep parsing, because an unreadable file
 * would quarantine a healthy queue and reset every binding's window for
 * nothing (FR-005).
 */
const ABSENTABLE_FIELDS = ['headSha', 'baseRef', 'claimedAt', 'dispatchedAt', 'dispatchResult'] as const;

/** Queue states the file may carry. */
const KNOWN_STATES = new Set<string>(['pending', 'in-flight', 'dispatched']);

/** Trigger kinds the writer and migration know how to interpret. */
const KNOWN_KINDS = new Set<string>(['assignment', 'mention', 'review']);

/** Subject shapes a delivery may carry (003 FR-010). */
const SUBJECT_TYPES: ReadonlySet<string> = new Set(['issue', 'pull_request']);

/** Correlation ids are service-minted, fixed-format path segments. */
const RUN_CORRELATION_ID = /^mt-run-[0-9a-f]{24}$/;

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
 * Validate the fields a row may carry as text, as literal `null`, or omit
 * entirely (the Slice-2 coordinates and the frozen legacy lifecycle stamps).
 *
 * @param record - Parsed candidate row.
 * @param fields - Field names to check.
 * @returns `true` when every field is absent, `null`, or text.
 */
function isAbsentableTextFieldSet(record: Record<string, unknown>, fields: readonly string[]): boolean {
    return fields.every((field) => {
        const value = record[field];

        return value === undefined || value === null || typeof value === 'string';
    });
}

/**
 * Read the positive integer field the writer emits for `issueNumber`.
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
 * Read the frozen legacy `state` field.
 *
 * @param record - Parsed candidate row.
 * @returns `undefined` when the row carries no state (a post-003 row), the
 *   state when it is from the shipped vocabulary, or `null` when it is not.
 */
function readStateField(record: Record<string, unknown>): EventState | undefined | null {
    if (record.state === undefined) {
        return undefined;
    }

    return knownStateOf(record.state) as EventState | null;
}

/**
 * Read the `subjectType` field.
 *
 * @param record - Parsed candidate row.
 * @returns `undefined` when the row predates it, the subject shape, or `null`
 *   when the value is neither shape.
 */
function readSubjectTypeField(record: Record<string, unknown>): SubjectType | undefined | null {
    const value = record.subjectType;
    if (value === undefined) {
        return undefined;
    }

    return typeof value === 'string' && SUBJECT_TYPES.has(value) ? (value as SubjectType) : null;
}

/**
 * Read the `runCorrelationId` field.
 *
 * @param record - Parsed candidate row.
 * @returns `undefined` when the row has no run yet, the id, or `null` when
 *   the value is an empty string (an id is never empty).
 */
function readRunLinkField(record: Record<string, unknown>): string | undefined | null {
    const value = record.runCorrelationId;
    if (value === undefined) {
        return undefined;
    }

    return typeof value === 'string' && RUN_CORRELATION_ID.test(value) ? value : null;
}

/**
 * Validate every text, lifecycle, and run-link field of one stored row.
 *
 * @param record - Parsed candidate row.
 * @returns `true` when all fields hold usable values or are absent.
 */
function fieldsHold(record: Record<string, unknown>): boolean {
    return (
        isUsableTextFieldSet(record, REQUIRED_FIELDS)
        && isAbsentableTextFieldSet(record, ABSENTABLE_FIELDS)
        && typeof record.kind === 'string'
        && KNOWN_KINDS.has(record.kind)
        && readStateField(record) !== null
        && readSubjectTypeField(record) !== null
        && readRunLinkField(record) !== null
    );
}

/** The frozen legacy lifecycle fields one row actually carries. */
interface LifecycleFields {
    /** Queue state. */
    state?: EventState;
    /** Claim stamp. */
    claimedAt?: string | null;
    /** Dispatch stamp. */
    dispatchedAt?: string | null;
    /** Session id or failure text. */
    dispatchResult?: string | null;
}

/**
 * Read the frozen legacy lifecycle fields a row carries, omitting every one
 * it does not: a post-003 row keeps none of them (its truth lives on the
 * run), and a shipped row returns exactly what the file held — the parser
 * never fills in a value the file did not (FR-005: legacy rows keep every
 * byte, and a new row carries no lifecycle state at all).
 *
 * @param record - Parsed candidate row, already validated.
 * @param state - The row's state, or `undefined` when it carries none.
 * @returns The lifecycle fields present on this row.
 */
function lifecycleOf(record: Record<string, unknown>, state: EventState | undefined): LifecycleFields {
    const fields: LifecycleFields = {};
    if (state !== undefined) {
        fields.state = state;
    }

    if (record.claimedAt !== undefined) {
        fields.claimedAt = record.claimedAt as string | null;
    }

    if (record.dispatchedAt !== undefined) {
        fields.dispatchedAt = record.dispatchedAt as string | null;
    }

    if (record.dispatchResult !== undefined) {
        fields.dispatchResult = record.dispatchResult as string | null;
    }

    return fields;
}

/** The run-layer fields one row carries, when it carries them at all. */
interface RunLinkFields {
    /** The run this delivery belongs to, assigned at enqueue (FR-012). */
    readonly runCorrelationId?: string;
    /** Subject shape captured at detection (FR-010). */
    readonly subjectType?: SubjectType;
}

/**
 * Read the run-layer fields a row carries, omitting the ones it does not.
 *
 * @param record - Parsed candidate row, already validated.
 * @param subjectType - The row's subject shape, or `undefined`.
 * @returns The run-layer fields present on this row.
 */
function runLinkOf(record: Record<string, unknown>, subjectType: SubjectType | undefined): RunLinkFields {
    // `fieldsHold` has already refused a row whose link is anything but
    // absent or text, so only `undefined` can still reach this spread.
    const runCorrelationId = readRunLinkField(record);

    return {
        ...(runCorrelationId === undefined || runCorrelationId === null ? {} : { runCorrelationId }),
        ...(subjectType === undefined ? {} : { subjectType }),
    };
}

/**
 * Read the Slice-2 pull-request coordinates, which older rows omit outright.
 *
 * @param record - Parsed candidate row, already validated.
 * @returns The coordinates, normalized to `null` when absent.
 */
function coordinatesOf(
    record: Record<string, unknown>,
): { readonly headSha: string | null; readonly baseRef: string | null } {
    return {
        headSha: typeof record.headSha === 'string' ? record.headSha : null,
        baseRef: typeof record.baseRef === 'string' ? record.baseRef : null,
    };
}

/**
 * Parse one stored event row.
 *
 * The writer's own output is the shape this must accept: every text field
 * non-empty, `issueNumber` a positive integer, a `state` from the shipped
 * vocabulary **when the row carries one**, and an excerpt that may
 * legitimately be `''` (an issue with no body). The Slice-2 fields (`headSha`,
 * `baseRef`) may be missing outright — a row written before M7 still parses,
 * with both read as `null` — and the legacy lifecycle stamps may be missing
 * too, which is how a row 003 enqueued reads. Anything else — including a row
 * missing `issueNumber` outright, or a `state` outside the shipped three —
 * answers `null`, which the store turns into a quarantine.
 *
 * @param raw - One element from the stored array.
 * @returns The event, or `null` when the row cannot be trusted.
 */
export function parseStoredEvent(raw: unknown): QueuedEvent | null {
    const record = isRecord(raw) ? raw : null;
    if (record === null || !fieldsHold(record)) {
        return null;
    }

    const state = readStateField(record);
    const subjectType = readSubjectTypeField(record);
    const issueNumber = positiveIntOf(record.issueNumber);
    if (state === null || subjectType === null || issueNumber === null || typeof record.issueBodyExcerpt !== 'string') {
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
        ...coordinatesOf(record),
        triggerNote: record.triggerNote as string,
        detectedAt,
        ...lifecycleOf(record, state),
        ...runLinkOf(record, subjectType),
    };
}

/**
 * Read the subject shape of one delivery, falling back the way adoption does.
 *
 * A row written before the run layer carries no `subjectType`, and the run key
 * still needs one: a review trigger is the only detection that *knows* it is
 * about a pull request, so every other kind reads as an issue (data-model
 * §2.1's adopted-row rule, reused for rows detection could not classify).
 *
 * @param delivery - The stored delivery.
 * @returns `issue` or `pull_request`, never absent.
 */
export function subjectTypeOf(delivery: QueuedEvent): SubjectType {
    return delivery.subjectType ?? (delivery.kind === 'review' ? 'pull_request' : 'issue');
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
