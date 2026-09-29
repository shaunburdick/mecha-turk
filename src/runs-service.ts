/**
 * The runs-history surface the Runs section reads (M8, widened by 003 T-023).
 *
 * `GET /v1/events` answers with the service's credential-free projection of
 * every **run** — all eight dispatch states, newest detected first, capped at
 * 100 — so this module owns that DTO and its parser, kept beside the runs
 * actions rather than inside `repos-service.ts` (the bindings/claim surface),
 * which the file-length limit would otherwise push past its own responsibility.
 *
 * Two rules shape the parser:
 *
 * - **Fail closed.** A row that cannot be fully understood reads as
 *   *unreadable*, never as a partial record the operator might trust — and
 *   unlike the claim parser (which skips a row so the relay keeps moving), one
 *   unusable row fails the whole body: the runs list is a *record* the operator
 *   reads, and a half-trusted record is worse than an honest "unreadable" note.
 * - **The eight states, strictly.** `state` accepts the model's seven plain
 *   states and the `blocked:<reason>` family — prefix + non-empty kebab reason,
 *   never a fixed enum, so `blocked:project-missing` and a declared-but-not-yet
 *   produced `blocked:policy` both parse while `blocked:` and a retired
 *   vocabulary word such as `in-flight` refuse the body. The rule mirrors
 *   `service/poll/runs-scalars-parse.ts`, which is the authority for it; the
 *   two are duplicated rather than imported because the panel bundle must stay
 *   free of service-tier modules.
 *
 * The two readers shared with the claim parser — {@link issueNumberFrom} and
 * {@link eventKindOf} — come from `repos-service.ts` so the two parsers hold
 * one opinion about what an event row is.
 */

import { asRecord, fieldsHoldText, parseJsonObject, textOrNull } from './json.ts';
import { eventKindOf, issueNumberFrom } from './repos-service.ts';

/** The seven states stored as a plain word; the eighth is `blocked:<reason>`. */
const PLAIN_RUN_STATES = [
    'pending',
    'claimed',
    'starting',
    'dispatched',
    'failed',
    'unconfirmed',
    'dead-lettered',
] as const;

/** One of the seven plain run states. */
export type PlainRunState = (typeof PLAIN_RUN_STATES)[number];

/** One of the eight dispatch states, `blocked:<reason>` carrying a non-empty kebab reason. */
export type RunState = PlainRunState | `blocked:${string}`;

/** Prefix of the `blocked:<reason>` family (data-model §1). */
const BLOCKED_PREFIX = 'blocked:';

/** Trigger kinds the runs row can carry; anything else reads as `assignment`. */
type RunKind = 'assignment' | 'mention' | 'review';

/** One source reference as the run history carries it (FR-013, FR-015). */
export interface RunReference {
    /** The joining delivery's unchanged id (FR-012). */
    readonly deliveryId: string;
    /** Trigger kind the reference was detected under. */
    readonly kind: RunKind;
    /** Where it matched: `assignment`, `body`, `comment:<id>`, or `review`. */
    readonly origin: string;
    /** Canonical link back to the source. */
    readonly sourceUrl: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
}

/** The session pointer as the run history carries it (FR-028's proof). */
export interface RunSession {
    /** Host-owned session id. */
    readonly sessionId: string;
    /** `= correlationId`; the id the session was started with (FR-029). */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
}

/** The recorded agent read-back as the run history carries it (FR-043). */
export interface RunVerification {
    /** Agent the read-back observed, or `null` when it was unreadable. */
    readonly observedAgent: string | null;
    /** Agent the binding expected. */
    readonly expectedAgent: string;
    /** Whether the two matched; a mismatch is a warning, never a state. */
    readonly ok: boolean;
    /** Extra note on a mismatch, or `null`. */
    readonly note: string | null;
}

/** One run, as `GET /v1/events` projects it — credential-free by construction. */
export interface RunRow {
    /** **The run's correlation id**: row key and every run-operation path segment. */
    readonly id: string;
    /** Same value as {@link RunRow.id}; what run-operation paths are addressed by. */
    readonly correlationId: string;
    /** One of the eight dispatch states; `blocked:<reason>` carries a non-empty suffix. */
    readonly state: RunState;
    /** Why the run sits there; rendered as the row's reason line (FR-074, NFR-108). */
    readonly stateReason: string;
    /** FR-010's human-readable tuple, shown beside the correlation id. */
    readonly runKey: string;
    /** 0-based ordinal of this run for its subject (FR-010). */
    readonly ordinal: number;
    /** Attempt the run currently stands on; retry/verification bodies echo it. */
    readonly attempt: number;
    /** `= correlationId`; displayed so an operator can find the session (FR-029). */
    readonly attachmentId: string;
    /** Target project, snapshotted at enqueue (AC-124). */
    readonly projectId: string;
    /** Worktree option, snapshotted at enqueue (AC-124). */
    readonly worktreeOption: string;
    /** Live lease expiry, else `null` (the lease is fencing, not authority). */
    readonly leaseExpiresAt: string | null;
    /** Live reservation's result deadline, else `null` (contract §1). */
    readonly resultDeadlineAt: string | null;
    /** Every retained reference, in join order (FR-013); excerpts never projected. */
    readonly sourceReferences: readonly RunReference[];
    /** How many triggers have joined, retained or not (T-038's total). */
    readonly referenceCount: number;
    /** Whether the reference list was cut at the cap (NFR-107). */
    readonly referencesTruncated: boolean;
    /** How many joining triggers the cap kept off the list; `0` when none (T-038). */
    readonly referencesNotRetained: number;
    /** Session pointer, or `null` when this run never produced one (FR-028). */
    readonly session: RunSession | null;
    /** Recorded agent read-back, or `null` when none was filed (FR-043). */
    readonly verification: RunVerification | null;
    /** Trigger kind that opened the run (the earliest reference's). */
    readonly kind: RunKind;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** Issue (or pull request) number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text rendered as plain text only. */
    readonly issueTitle: string;
    /** Canonical issue URL the Open-issue action opens. */
    readonly issueUrl: string;
    /** RFC 3339 stamp of the earliest reference; the row's age derives from it. */
    readonly detectedAt: string;
    /** Binding that produced the run. */
    readonly bindingId: string;
    /** Session id once one exists, else the recorded cause of a failure, else `null`. */
    readonly dispatchResult: string | null;
    /** Issue stamp of the lease held right now, else `null`. */
    readonly claimedAt: string | null;
    /** RFC 3339 dispatch stamp once a session exists, else `null`. */
    readonly dispatchedAt: string | null;
    /** Head SHA of a review-event pull request; `null` on every other kind. */
    readonly headSha: string | null;
    /** Base ref of that pull request; `null` on every other kind. */
    readonly baseRef: string | null;
}

/**
 * The twelve string members the row renders from.
 *
 * Written as a `Pick` so the reader's return type and {@link RunRow} cannot
 * drift apart: a projection field added here has to be added to the interface
 * before this compiles, which is the check a hand-written parallel interface
 * would quietly lose.
 */
type RunScalars = Pick<
    RunRow,
    | 'id'
    | 'correlationId'
    | 'stateReason'
    | 'runKey'
    | 'attachmentId'
    | 'projectId'
    | 'worktreeOption'
    | 'repository'
    | 'issueTitle'
    | 'issueUrl'
    | 'bindingId'
    | 'detectedAt'
>;

/** The counting members of the row. */
type RunCounts = Pick<
    RunRow,
    'ordinal' | 'attempt' | 'referenceCount' | 'referencesTruncated' | 'referencesNotRetained'
>;

/** The projected detail: pointers, stamps, references, and optional coordinates. */
type RunDetail = Pick<
    RunRow,
    | 'leaseExpiresAt'
    | 'resultDeadlineAt'
    | 'sourceReferences'
    | 'session'
    | 'verification'
    | 'kind'
    | 'dispatchResult'
    | 'claimedAt'
    | 'dispatchedAt'
    | 'headSha'
    | 'baseRef'
>;

/** Fields one runs-history row must carry as plain strings. */
const RUN_STRING_FIELDS = [
    'id',
    'correlationId',
    'stateReason',
    'runKey',
    'attachmentId',
    'projectId',
    'worktreeOption',
    'repository',
    'issueTitle',
    'issueUrl',
    'bindingId',
    'detectedAt',
] as const;

/**
 * Check the reason half of a `blocked:<reason>` state: a non-empty kebab
 * token, never a fixed enum (data-model §1), and never an empty suffix.
 *
 * @param reason - Whatever follows the `blocked:` prefix.
 * @returns `true` when every hyphen-separated part is lowercase alphanumeric.
 */
function isBlockedReason(reason: string): boolean {
    if (reason === '') {
        return false;
    }

    return reason.split('-').every((part) => part !== '' && /^[a-z0-9]+$/.test(part));
}

/**
 * Narrow one raw state to the eight the service can answer with.
 *
 * An unknown state — a retired vocabulary word, a typo, a row from a future
 * build — refuses the row, which refuses the body: the list must never render
 * a state it would then have to guess the tone and affordances for (FR-074).
 *
 * @param value - Candidate state from a stored row.
 * @returns The state, or `null` when the row is unusable.
 */
function runStateOf(value: unknown): RunState | null {
    if (typeof value !== 'string') {
        return null;
    }

    if ((PLAIN_RUN_STATES as readonly string[]).includes(value)) {
        return value as PlainRunState;
    }

    if (!value.startsWith(BLOCKED_PREFIX) || !isBlockedReason(value.slice(BLOCKED_PREFIX.length))) {
        return null;
    }

    return value as RunState;
}

/**
 * Read a required non-empty string member.
 *
 * @param record - Parsed row.
 * @param field - Member name.
 * @returns The value, or `null` when it is missing, not a string, or empty.
 */
function requiredText(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read a required finite number member.
 *
 * @param record - Parsed row.
 * @param field - Member name.
 * @returns The value, or `null` when it is missing or not a number.
 */
function requiredNumber(record: Record<string, unknown>, field: string): number | null {
    const value = record[field];

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read one source reference.
 *
 * @param value - One element of the `sourceReferences` array.
 * @returns The reference, or `null` when its shape is unusable.
 */
function parseReference(value: unknown): RunReference | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const deliveryId = requiredText(record, 'deliveryId');
    const origin = requiredText(record, 'origin');
    const sourceUrl = requiredText(record, 'sourceUrl');
    const detectedAt = requiredText(record, 'detectedAt');
    if (deliveryId === null || origin === null || sourceUrl === null || detectedAt === null) {
        return null;
    }

    if (typeof record.presentAtAuthorization !== 'boolean') {
        return null;
    }

    return {
        deliveryId,
        kind: eventKindOf(record.kind),
        origin,
        sourceUrl,
        detectedAt,
        presentAtAuthorization: record.presentAtAuthorization,
    };
}

/**
 * Read the `sourceReferences` list, or `null` when any element is unusable.
 *
 * @param value - The member as received.
 * @returns The references, or `null`.
 */
function parseReferences(value: unknown): RunReference[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const references: RunReference[] = [];
    for (const entry of value) {
        const reference = parseReference(entry);
        if (reference === null) {
            return null;
        }

        references.push(reference);
    }

    return references;
}

/**
 * Read the session pointer, distinguishing `null` from an unusable value.
 *
 * @param value - The `session` member as received.
 * @returns The pointer, `null` when the run has none, or `undefined` when the
 *   member is present but not a pointer this build may half-apply.
 */
function parseSession(value: unknown): RunSession | null | undefined {
    if (value === null) {
        return null;
    }

    const record = asRecord(value);
    if (record === null) {
        return undefined;
    }

    const sessionId = requiredText(record, 'sessionId');
    const attachmentId = requiredText(record, 'attachmentId');
    const dispatchedAt = requiredText(record, 'dispatchedAt');
    if (sessionId === null || attachmentId === null || dispatchedAt === null) {
        return undefined;
    }

    return { sessionId, attachmentId, dispatchedAt };
}

/**
 * Read the recorded agent read-back, distinguishing `null` from an unusable value.
 *
 * @param value - The `verification` member as received.
 * @returns The read-back, `null` when none was filed, or `undefined` when the
 *   member is present but not one this build may half-apply.
 */
function parseVerification(value: unknown): RunVerification | null | undefined {
    if (value === null) {
        return null;
    }

    const record = asRecord(value);
    if (record === null) {
        return undefined;
    }

    const expectedAgent = requiredText(record, 'expectedAgent');
    if (expectedAgent === null || typeof record.ok !== 'boolean') {
        return undefined;
    }

    const { observedAgent } = record;
    if (observedAgent !== null && typeof observedAgent !== 'string') {
        return undefined;
    }

    const { note } = record;
    if (note !== null && typeof note !== 'string') {
        return undefined;
    }

    return { observedAgent, expectedAgent, ok: record.ok, note };
}

/**
 * Check the run's three reference-counting members against each other.
 *
 * `referenceCount` is the total that ever joined, `sourceReferences` is what
 * was retained, and `referencesNotRetained` is the difference — so a row whose
 * three disagree would render as either silently lossy or falsely complete
 * (T-038). Refusing it is the same call the store's own parser makes.
 *
 * @param input - The counting members and the retained list's length.
 * @returns `true` when they reconcile.
 */
function countsReconcile(input: { readonly counts: RunCounts; readonly retained: number }): boolean {
    const { counts, retained } = input;
    if (counts.referenceCount !== retained + counts.referencesNotRetained) {
        return false;
    }

    return counts.referencesTruncated === counts.referencesNotRetained > 0;
}

/**
 * Bound one already-read number below, refusing a fractional value.
 *
 * @param value - The number, or `null` when the member was unusable.
 * @param min - Smallest acceptable value.
 * @returns The value, or `null` when it is missing, fractional, or too small.
 */
function atLeast(value: number | null, min: number): number | null {
    if (value === null || !Number.isInteger(value) || value < min) {
        return null;
    }

    return value;
}

/**
 * Read the twelve string members the row renders from, as one step.
 *
 * @param record - Parsed row.
 * @returns The members, or `null` when any is missing, not a string, or empty.
 */
function readRunScalars(record: Record<string, unknown>): RunScalars | null {
    if (!fieldsHoldText(record, RUN_STRING_FIELDS)) {
        return null;
    }

    const {
        id, correlationId, stateReason, runKey, attachmentId, projectId,
        worktreeOption, repository, issueTitle, issueUrl, bindingId, detectedAt,
    } = record;

    return {
        id: id as string,
        correlationId: correlationId as string,
        stateReason: stateReason as string,
        runKey: runKey as string,
        attachmentId: attachmentId as string,
        projectId: projectId as string,
        worktreeOption: worktreeOption as string,
        repository: repository as string,
        issueTitle: issueTitle as string,
        issueUrl: issueUrl as string,
        bindingId: bindingId as string,
        detectedAt: detectedAt as string,
    };
}

/**
 * Read the counting members of the row as one step.
 *
 * @param record - Parsed row.
 * @returns The members, or `null` when any is missing, fractional, or out of bounds.
 */
function readRunCounts(record: Record<string, unknown>): RunCounts | null {
    const ordinal = atLeast(requiredNumber(record, 'ordinal'), 0);
    const attempt = atLeast(requiredNumber(record, 'attempt'), 1);
    const referenceCount = atLeast(requiredNumber(record, 'referenceCount'), 0);
    const referencesNotRetained = atLeast(requiredNumber(record, 'referencesNotRetained'), 0);
    const { referencesTruncated } = record;
    if (ordinal === null || attempt === null || referenceCount === null || referencesNotRetained === null) {
        return null;
    }

    if (typeof referencesTruncated !== 'boolean') {
        return null;
    }

    return { ordinal, attempt, referenceCount, referencesNotRetained, referencesTruncated };
}

/**
 * Read the projected detail: references, pointers, stamps, and the optional
 * coordinates a delivery row can be evicted out from under.
 *
 * @param record - Parsed row.
 * @returns The members, or `null` when any structured member is unusable.
 */
function readRunDetail(record: Record<string, unknown>): RunDetail | null {
    const sourceReferences = parseReferences(record.sourceReferences);
    const session = parseSession(record.session);
    const verification = parseVerification(record.verification);
    if (sourceReferences === null || session === undefined || verification === undefined) {
        return null;
    }

    return {
        leaseExpiresAt: textOrNull(record, 'leaseExpiresAt'),
        resultDeadlineAt: textOrNull(record, 'resultDeadlineAt'),
        sourceReferences,
        session,
        verification,
        kind: eventKindOf(record.kind),
        dispatchResult: textOrNull(record, 'dispatchResult'),
        claimedAt: textOrNull(record, 'claimedAt'),
        dispatchedAt: textOrNull(record, 'dispatchedAt'),
        headSha: textOrNull(record, 'headSha'),
        baseRef: textOrNull(record, 'baseRef'),
    };
}

/**
 * Parse one runs-history row.
 *
 * Each group is read by its own named step, and the row is only assembled once
 * every step agreed — so a half-readable row is a refused row, never a
 * partially applied one (AGENTS invariant 8).
 *
 * @param value - One element of the `events` array.
 * @returns The row, or `null` when its shape is unusable.
 */
function parseRunEntry(value: unknown): RunRow | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const scalars = readRunScalars(record);
    const counts = readRunCounts(record);
    const detail = readRunDetail(record);
    const state = runStateOf(record.state);
    const issueNumber = issueNumberFrom(record);
    if (scalars === null || counts === null || detail === null || state === null || issueNumber === 0) {
        return null;
    }

    if (!countsReconcile({ counts, retained: detail.sourceReferences.length })) {
        return null;
    }

    return { ...scalars, ...counts, ...detail, state, issueNumber };
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
