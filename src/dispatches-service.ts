/**
 * The runs-history surface the Dispatches section reads (M8, widened by 003 T-023).
 *
 * `GET /v1/events` answers with the service's credential-free projection of
 * every **run** — all eight dispatch states, newest detected first, paged
 * (default 25, selectable 10/25/50/100) and filterable server-side — so this
 * module owns that DTO and its two readers, kept beside the runs actions
 * rather than inside `bindings-service.ts` (the bindings/claim surface), which
 * the file-length limit would otherwise push past its own responsibility.
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
 * {@link eventKindOf} — come from `bindings-service.ts` so the two parsers hold
 * one opinion about what an event row is.
 */

import { asRecord, fieldsHoldText, parseJsonObject, textOrNull } from './json.ts';
import { readPromptReference } from './prompt-wire.ts';
import { eventKindOf, issueNumberFrom } from './bindings-service.ts';
import { readActorPolicy } from './run-actor.ts';
import { parseReferences, parseSession, parseVerification } from './dispatches-detail.ts';
import type { RunKind, RunReference, RunSession, RunVerification } from './dispatches-detail.ts';
import { runStateOf } from './run-state.ts';
import type { ActorPolicy } from './run-actor.ts';
import type { PromptReference } from './prompt.ts';
import type { RunState } from './run-state.ts';

/** Re-exported: the runs row stays the one import path for the state vocabulary. */
export { BLOCKED_PREFIX } from './run-state.ts';
export type { PlainRunState, RunState } from './run-state.ts';


/** The runs row's structured members and their readers, one module per concern. */
export type { RunKind, RunReference, RunSession, RunVerification } from './dispatches-detail.ts';

/**
 * The two closed vocabularies a runs row adds, read from
 * [`run-actor.ts`](./run-actor.ts) and re-exported so this module stays the one
 * import path for a runs-history row — the panel bundle is free of service-tier
 * modules, so the vocabulary cannot live there, and a *second* import path would
 * let the row's declared types and its reader drift apart.
 */
export type { ActorAttribution, ActorPolicy } from './run-actor.ts';

/** One run, as `GET /v1/events` projects it: credential-free, and carrying the
 * prompt's {@link PromptReference} — presence, the ordered `promptSources`
 * tier list, fingerprint, length, never text. */
export interface RunRow extends PromptReference {
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
    /**
     * The **shape** of the binding's allow-list at the moment of authorization
     * (003 FR-079).
     *
     * `null` is *no authorization recorded yet* — a waiting or adopted run — and
     * is never read as `'open'` (005 FR-093: the panel computes no policy
     * verdict of its own). An unrecognized value refuses the row, so a policy
     * word from a future build cannot render as one this build would mis-tint.
     */
    readonly actorPolicy: ActorPolicy | null;
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
    | 'actorPolicy'
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
 * Check the run's three reference-counting members against each other.
 *
 * `referenceCount` is the total that ever joined, `sourceReferences` is what
 * was retained, and `referencesNotRetained` is the difference — so a row whose
 * three disagree would render as either silently lossy or falsely complete.
 * Refusing it is the same call the store's own parser makes.
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
    const actorPolicy = readActorPolicy(record);
    if (sourceReferences === null || session === undefined || verification === undefined || !actorPolicy.usable) {
        return null;
    }

    return {
        leaseExpiresAt: textOrNull(record, 'leaseExpiresAt'),
        resultDeadlineAt: textOrNull(record, 'resultDeadlineAt'),
        sourceReferences,
        actorPolicy: actorPolicy.policy,
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
    // Read fail-closed like every other member: an unusable prompt reference
    // refuses the row, so a half-read answer never renders a prompt line (004 FR-052).
    const prompt = readPromptReference(record);
    if (scalars === null || counts === null || detail === null || state === null) {
        return null;
    }

    if (issueNumber === 0 || prompt === null) {
        return null;
    }

    if (!countsReconcile({ counts, retained: detail.sourceReferences.length })) {
        return null;
    }

    return { ...scalars, ...counts, ...detail, state, issueNumber, ...prompt };
}

/**
 * Parse the runs-history (`GET /v1/events`) response body.
 *
 * @param text - Response body text.
 * @returns The rows in the order the service sent them (newest detected
 *   first), or `null` when any part of the shape is unusable.
 */
/**
 * Read one homogeneous element array; one unusable element refuses the answer.
 *
 * Exported because the paged reader in `dispatches-list.ts` builds on the same
 * row rule: one row the panel cannot fully understand refuses the list rather
 * than being skipped, because a list with a hole in it is a record an operator
 * would misread.
 *
 * @param events - The `events` member (unchecked).
 * @returns The rows, or `null` when the member is not an array or a row fails.
 */
export function parseEventRows(events: unknown): RunRow[] | null {
    if (!Array.isArray(events)) {
        return null;
    }

    const rows: RunRow[] = [];
    for (const entry of events) {
        const row = parseRunEntry(entry);
        if (row === null) {
            return null;
        }

        rows.push(row);
    }

    return rows;
}

/**
 * Parse the runs-history (`GET /v1/events`) response body's rows alone.
 *
 * @param text - Response body text.
 * @returns The rows in the order the service sent them (newest detected
 *   first), or `null` when any part of the shape is unusable.
 */
export function parseDispatchesBody(text: string): RunRow[] | null {
    const root = parseJsonObject(text);
    if (root === null) {
        return null;
    }

    return parseEventRows(root.events);
}
