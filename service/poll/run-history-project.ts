/**
 * The run-history projection behind `GET /v1/events` (003 T-016;
 * [contracts/run-history-audit.md](../../specs/003-dispatch-integrity/contracts/run-history-audit.md) §1).
 *
 * The shipped route projected **delivery** rows: three queue states, no lease,
 * no attempt, no session. The contract's widened row projects **runs**, and it
 * is a widening — every member the shipped row carried is still present (the
 * contract's own "additive-within-v1" rule), beside the run's state, reason,
 * key, ordinal, attempt, attachment id, snapshotted target, lease expiry,
 * source references with their three counting members, session pointer,
 * verification outcome, and the live reservation's result deadline.
 *
 * This module sits beside [`claim-project.ts`](./claim-project.ts) for the same
 * reason that one does: the projection is a pure function of stored records, so
 * it can be tested without a socket, and [`routes/events.ts`](../routes/events.ts)
 * stays a route rather than growing a second wire shape of its own.
 *
 * Three properties it owes, worst-first:
 *
 * - **Credential-free by construction.** No dispatch token (the row says *that*
 *   an authorization exists and when it dies, never *what* it is), no account
 *   login, no numeric account id — only the run's own identity, which an
 *   operator already sees everywhere else (NFR-106, AC-120).
 * - **Hostile source text is copied, never interpreted.** The issue title,
 *   repository, and state reason are untrusted text; the panel renders them
 *   through its non-HTML path, so this module's whole job is to hand them back
 *   byte-identical (NFR-109).
 * - **Degradation is explicit, never silent.** The delivery row a title or PR
 *   coordinate came from can be evicted with its terminal run, so each of those
 *   falls back to a value derived from the run itself rather than to an empty
 *   string the panel's parser reads as an unusable record.
 */

import type { EventKind, QueuedEvent } from './events-parse.ts';
import type { Run, SourceReference } from './runs-types.ts';

/** Why a run that has never moved sits where it does (FR-074, NFR-108). */
const WAITING_REASON = 'waiting for a panel';

/**
 * A source reference as the run history carries it (FR-013, FR-015).
 *
 * Exactly the stored shape: the excerpt a dispatch context is built from is
 * **not** stored on the run (data-model §2.3 — it lives on the delivery, which
 * the run points at), so there is nothing here that could be omitted by
 * accident. The three counting members below the list are what keep a row from
 * being silently lossy at the 200-reference cap (T-038).
 */
export type HistoryReference = SourceReference;

/** The session pointer as the run history carries it (FR-028's proof). */
export interface HistorySession {
    /** Host-owned session id. */
    readonly sessionId: string;
    /** `= correlationId`; the id the session was started with (FR-029). */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
}

/** The recorded agent read-back as the run history carries it (FR-043). */
export interface HistoryVerification {
    /** Agent the read-back observed, or `null` when it was unreadable. */
    readonly observedAgent: string | null;
    /** Agent the binding expected. */
    readonly expectedAgent: string;
    /** Whether the two matched; a mismatch is a warning, never a state. */
    readonly ok: boolean;
    /** Extra note on a mismatch, or `null`. */
    readonly note: string | null;
}

/** One run, as `GET /v1/events` reports it — credential-free by construction. */
export interface RunHistoryRow {
    /** **The run's correlation id**: row key and every run-operation path segment. */
    readonly id: string;
    /** One of the eight dispatch states; `blocked:<reason>` carries a non-empty suffix. */
    readonly state: Run['state'];
    /** Why the run sits there; rendered as the row's reason line (FR-074, NFR-108). */
    readonly stateReason: string;
    /** FR-010's human-readable tuple, shown beside the correlation id. */
    readonly runKey: string;
    /** 0-based ordinal of this run for its subject (FR-010). */
    readonly ordinal: number;
    /** Current attempt count. */
    readonly attempt: number;
    /** Same value as {@link RunHistoryRow.id}; the panel's copy affordance reads it (FR-053). */
    readonly correlationId: string;
    /** `= correlationId`; displayed so an operator can find the session (FR-029). */
    readonly attachmentId: string;
    /** Target project, snapshotted at enqueue (AC-124). */
    readonly projectId: string;
    /** Worktree option, snapshotted at enqueue (AC-124). */
    readonly worktreeOption: string;
    /** Live lease expiry, else `null` (the lease is fencing, not authority). */
    readonly leaseExpiresAt: string | null;
    /**
     * Live reservation's result deadline, else `null`.
     *
     * Additive beyond contract §1's table and beside the reserve answer's own
     * member of the same name (contract, dispatch-authorization §1): a reader
     * looking at a `starting` run learns when the authorization wedges into
     * `unconfirmed`, which is the one deadline an operator cannot infer from
     * anything else on the row (NFR-108). It reads `null` once the reservation
     * has been consumed or cleared, because a deadline that can no longer fire
     * is not a fact worth projecting.
     */
    readonly resultDeadlineAt: string | null;
    /** Every retained reference, in join order (FR-013); excerpts never projected. */
    readonly sourceReferences: readonly HistoryReference[];
    /** How many triggers have joined, retained or not (T-038's total). */
    readonly referenceCount: number;
    /** Whether the reference list was cut at the cap (NFR-107). */
    readonly referencesTruncated: boolean;
    /** How many joining triggers the cap kept off the list; `0` when none (T-038). */
    readonly referencesNotRetained: number;
    /** Session pointer, or `null` when this run never produced one (FR-028). */
    readonly session: HistorySession | null;
    /** Recorded agent read-back, or `null` when none was filed (FR-043). */
    readonly verification: HistoryVerification | null;
    /** Trigger kind that opened the run (the earliest reference's). */
    readonly kind: EventKind;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** Issue (or pull request) number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text, copied verbatim (NFR-109). */
    readonly issueTitle: string;
    /** Canonical issue URL. */
    readonly issueUrl: string;
    /** RFC 3339 stamp of the earliest reference; the row's age derives from it. */
    readonly detectedAt: string;
    /** Binding this run dispatches through. */
    readonly bindingId: string;
    /** Session id once one exists, else the recorded cause of a failure, else `null`. */
    readonly dispatchResult: string | null;
    /**
     * Issue stamp of the lease held **right now**, else `null`.
     *
     * The run model keeps no claim history — a lease that was spent or expired
     * is cleared — so this is the one claim stamp the stored record can state
     * truthfully. It exists because the shipped row carried the member and the
     * contract's rule is additive-within-v1: removing it would be the wire
     * change the contract forbids, while inventing a stamp for a claim the run
     * no longer holds would be worse than the honest `null`.
     */
    readonly claimedAt: string | null;
    /** RFC 3339 dispatch stamp once a session exists, else `null` (shipped member). */
    readonly dispatchedAt: string | null;
    /** Head SHA of a review-origin pull request; absent on every other kind. */
    readonly headSha?: string;
    /** Base ref of that pull request; absent on every other kind. */
    readonly baseRef?: string;
}

/**
 * Pull-request coordinates, present only on a review-origin run.
 *
 * An absent member stays absent rather than becoming an empty string the panel
 * cannot tell apart from a real value — the shipped row answered `null` there,
 * and `null` and absent read the same through the panel's DTO.
 *
 * @param delivery - The delivery that opened the run, when the queue holds it.
 * @returns The members this delivery actually has.
 */
function reviewCoordinates(delivery: QueuedEvent | undefined): { headSha?: string; baseRef?: string } {
    const head = delivery?.headSha ?? null;
    const base = delivery?.baseRef ?? null;

    return { ...(head === null ? {} : { headSha: head }), ...(base === null ? {} : { baseRef: base }) };
}

/**
 * The cause a `failed` run carries in its `dispatchResult`.
 *
 * The attempt history is the recorded cause (the panel's own report is what
 * wrote it); a run adopted from a pre-003 `dispatched`-with-problem row has no
 * attempt record for its failure, so its stored state reason is the same fact
 * in the same place. Anything else reports `null`: a run that is waiting,
 * blocked, or wedged has no *result*, and saying otherwise would invent one.
 *
 * @param run - The run whose result line is being projected.
 * @returns The recorded cause, or `null`.
 */
function recordedCause(run: Run): string | null {
    for (let index = run.attempts.length - 1; index >= 0; index -= 1) {
        const reason = run.attempts[index]?.reason ?? null;
        if (reason !== null) {
            return reason;
        }
    }

    return run.state === 'failed' ? run.stateReason : null;
}

/**
 * The session id or failure text the shipped `dispatchResult` member carried.
 *
 * @param run - The run being projected.
 * @returns The session id when one exists, else the recorded cause, else `null`.
 */
function dispatchResultOf(run: Run): string | null {
    if (run.session !== null) {
        return run.session.sessionId;
    }

    return recordedCause(run);
}

/**
 * The delivery-derived members: title, canonical link, and PR coordinates.
 *
 * Each degrades to a value the run itself can supply, because a delivery row is
 * evicted with its terminal run (NFR-107) while the run's row must keep parsing
 * for as long as the run is retained (FR-005: rows written before this feature
 * continue to project).
 *
 * @param input - The run, its earliest reference, and the delivery that opened it.
 * @returns The delivery-derived members of the history row.
 */
function deliveryView(input: {
    /** The run being projected. */
    readonly run: Run;
    /** The run's earliest source reference, when it has one. */
    readonly primary: SourceReference | undefined;
    /** The delivery behind that reference, when the queue still holds it. */
    readonly delivery: QueuedEvent | undefined;
}): {
    /** Issue title; never empty, so the panel's parser keeps the whole record. */
    readonly issueTitle: string;
    /** Canonical issue URL; falls back to the reference's own link. */
    readonly issueUrl: string;
} {
    const { run, primary, delivery } = input;
    const title = delivery?.issueTitle ?? '';

    return {
        // `#<number>` is the one title the run can always state: an empty
        // string fails the panel's "usable text" check and would blank the
        // whole list over one evicted delivery.
        issueTitle: title === '' ? `#${run.subjectNumber}` : title,
        issueUrl: delivery?.issueUrl ?? primary?.sourceUrl ?? '',
    };
}

/**
 * Attach the review-origin coordinates, keeping an absent member absent.
 *
 * @param row - The projected row.
 * @param delivery - The delivery behind the run's earliest reference, when the
 *   queue still holds it.
 * @returns The row, carrying `headSha`/`baseRef` only when that delivery does.
 */
function withReviewCoordinates(row: RunHistoryRow, delivery: QueuedEvent | undefined): RunHistoryRow {
    const coordinates = reviewCoordinates(delivery);
    if (coordinates.headSha === undefined && coordinates.baseRef === undefined) {
        return row;
    }

    return { ...row, ...coordinates };
}

/**
 * The result deadline an outstanding authorization still carries, else `null`.
 *
 * A consumed reservation's deadline has stopped meaning anything — the outcome
 * it was guarding is recorded — so reporting it beside `dispatched` or `failed`
 * would invite exactly the confusion the reserve answer's own `resultDeadlineAt`
 * member exists to prevent (T-043d). The member answers one question: *by when
 * must this run report, or wedge into `unconfirmed`?*
 *
 * @param run - The run being projected.
 * @returns The deadline while the reservation is live, else `null`.
 */
function liveResultDeadlineOf(run: Run): string | null {
    if (run.reservation === null || run.reservation.consumed) {
        return null;
    }

    return run.reservation.resultDeadlineAt;
}

/**
 * The lease members of the history row: expiry, and the one claim stamp the
 * stored record can state.
 *
 * @param run - The run being projected.
 * @returns The live lease's issue and expiry stamps, both `null` when no lease
 *   is held (the run model keeps no claim history — see {@link RunHistoryRow}).
 */
function leaseViewOf(run: Run): { readonly leaseExpiresAt: string | null; readonly claimedAt: string | null } {
    if (run.lease === null) {
        return { leaseExpiresAt: null, claimedAt: null };
    }

    return { leaseExpiresAt: run.lease.expiresAt, claimedAt: run.lease.issuedAt };
}

/**
 * The session pointer, reduced to the three members the contract names.
 *
 * @param run - The run being projected.
 * @returns The pointer, or `null` when the run never produced a session.
 */
function sessionViewOf(run: Run): HistorySession | null {
    if (run.session === null) {
        return null;
    }

    return {
        sessionId: run.session.sessionId,
        attachmentId: run.session.attachmentId,
        dispatchedAt: run.session.dispatchedAt,
    };
}

/**
 * The recorded agent read-back, reduced to the four members the contract names.
 *
 * @param run - The run being projected.
 * @returns The read-back, or `null` when none was filed.
 */
function verificationViewOf(run: Run): HistoryVerification | null {
    if (run.verification === null) {
        return null;
    }

    return {
        observedAgent: run.verification.observedAgent,
        expectedAgent: run.verification.expectedAgent,
        ok: run.verification.ok,
        note: run.verification.note,
    };
}

/**
 * Project one stored run into its history row.
 *
 * @param input - The run, the delivery rows keyed by id, and the reference that
 *   opened the run (its earliest) for the identity members the run does not store.
 * @returns The credential-free row.
 */
function historyRowOf(input: {
    /** The run being projected. */
    readonly run: Run;
    /** Delivery rows keyed by id, as read from the queue. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
}): RunHistoryRow {
    const { run, deliveries } = input;
    const primary = run.sourceReferences[0];
    const delivery = primary === undefined ? undefined : deliveries.get(primary.deliveryId);
    const view = deliveryView({ run, primary, delivery });
    const lease = leaseViewOf(run);
    const dispatchStamp = run.session === null ? null : run.session.dispatchedAt;

    return withReviewCoordinates({
        id: run.correlationId,
        state: run.state,
        stateReason: run.stateReason ?? WAITING_REASON,
        runKey: run.runKey,
        ordinal: run.ordinal,
        attempt: run.attempt,
        correlationId: run.correlationId,
        attachmentId: run.attachmentId,
        projectId: run.projectId,
        worktreeOption: run.worktreeOption,
        leaseExpiresAt: lease.leaseExpiresAt,
        resultDeadlineAt: liveResultDeadlineOf(run),
        sourceReferences: run.sourceReferences,
        referenceCount: run.referenceCount,
        referencesTruncated: run.referencesTruncated,
        referencesNotRetained: run.referencesNotRetained,
        session: sessionViewOf(run),
        verification: verificationViewOf(run),
        kind: primary?.kind ?? 'assignment',
        repository: run.repository,
        issueNumber: run.subjectNumber,
        issueTitle: view.issueTitle,
        issueUrl: view.issueUrl,
        detectedAt: primary?.detectedAt ?? run.createdAt,
        bindingId: run.bindingId,
        dispatchResult: dispatchResultOf(run),
        claimedAt: lease.claimedAt,
        dispatchedAt: dispatchStamp,
    }, delivery);
}

/**
 * Project the runs history: newest detected first, capped, never claiming.
 *
 * @param input - Every retained run, the delivery rows, and the row cap.
 * @returns At most `cap` rows, freshest detection first; oldest runs dropped first.
 */
export function projectRunHistory(input: {
    /** Every retained run, in creation order. */
    readonly runs: readonly Run[];
    /** Delivery rows keyed by id, for the members a run does not store. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
    /** Most rows one answer may carry (`MAX_LISTED_EVENTS`). */
    readonly cap: number;
}): RunHistoryRow[] {
    const rows = input.runs.map((run) => historyRowOf({ run, deliveries: input.deliveries }));

    return rows
        .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
        .slice(0, input.cap);
}
