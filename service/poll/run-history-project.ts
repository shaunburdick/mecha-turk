/**
 * The run-history projection behind `GET /v1/events`
 * ([contracts/run-history-audit.md](../../specs/003-dispatch-integrity/contracts/run-history-audit.md)).
 */

import type { PromptSource } from '../prompt.ts';
import type { EventKind, FollowUpKind, QueuedEvent } from './events-parse.ts';
import { followUpKindOf } from './events-parse.ts';
import type { Run, SourceReference } from './runs-types.ts';

const WAITING_REASON = 'waiting for a panel';

/**
 * A source reference as the run history carries it — exactly the stored
 * shape: the excerpt a dispatch context is built from is **not** stored on
 * the run (it lives on the delivery the run points at), so nothing here can
 * be omitted by accident, and the three counting members below the list keep
 * a row from being silently lossy at the 200-reference cap. The two **actor
 * members** ride exactly as stored, absentable because a run is history and
 * refusing one would quarantine the whole document for it.
 */
export type HistoryReference = SourceReference;

export interface HistorySession {
    readonly sessionId: string;
    /** `= correlationId`; the id the session was started with. */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
}

export interface HistoryVerification {
    /** Agent the read-back observed, or `null` when it was unreadable. */
    readonly observedAgent: string | null;
    readonly expectedAgent: string;
    /** Whether the two matched; a mismatch is a warning, never a state. */
    readonly ok: boolean;
    /** Extra note on a mismatch, or `null`. */
    readonly note: string | null;
}

/**
 * One follow-up, as the run history carries it (002 FR-104). **A follow-up is
 * not a source reference on the run**, and that is load-bearing: 003's actor
 * gate classifies from `sourceReferences` exclusively, so one that joined
 * that list would be re-judged by the allow-list on the run's next
 * authorization. Every member is the queue row's own, unchanged — the
 * bounded, delimiter-defused `excerpt` the panel composes with, and the id
 * that is both the relay's handled key and the at-most-once key.
 */
export interface HistoryFollowUp {
    /** The deterministic `evt-…~followup~…` id: the relay's at-most-once key. */
    readonly deliveryId: string;
    readonly kind: FollowUpKind;
    /** Bounded untrusted excerpt the panel composes its message from. */
    readonly excerpt: string;
    /** The actor the movement is attributed to; credential-free by construction. */
    readonly actorLogin: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    readonly sourceUrl: string;
    /**
     * The head the run carried before this movement, for a head change only.
     *
     * Derived, never stored: the first head follow-up of a run takes the run's
     * seed — the dispatch-time baseline — and every later one takes the previous
     * movement's `headSha`. Absent when neither is known, which a conforming row
     * cannot be.
     */
    readonly fromHeadSha?: string;
    /** The head this movement observed, for a head change only. */
    readonly headSha?: string;
    readonly engine?: HistoryFollowUpEngine;
}

export type HistoryFollowUpEngine =
    | { readonly state: 'queued'; readonly messageId?: string }
    | { readonly state: 'unavailable' }
    | { readonly state: 'unknown'; readonly cause: 'intent' | 'outcome' };

/**
 * How many follow-ups one history row projects (002 FR-104): a window that
 * walks, not a wall that caps — a count-only bound is what a busy subject
 * outgrows. The window is the oldest {@link MAX_PROJECTED_FOLLOW_UPS} queue
 * rows in detection order, **delivered or not**, because the service holds no
 * record of a delivery and cannot skip one the panel has already sent;
 * `followUpsFrom` moves its opening as the panel delivers (FR-104, FR-107).
 */
export const MAX_PROJECTED_FOLLOW_UPS = 20;

/** One run, as `GET /v1/events` reports it — credential-free by construction. */
export interface RunHistoryRow {
    /** **The run's correlation id**: row key and every run-operation path segment. */
    readonly id: string;
    /** One of the eight dispatch states; `blocked:<reason>` carries a non-empty suffix. */
    readonly state: Run['state'];
    /** Why the run sits there; rendered as the row's reason line. */
    readonly stateReason: string;
    /** The human-readable tuple, shown beside the correlation id. */
    readonly runKey: string;
    /** 0-based ordinal of this run for its subject. */
    readonly ordinal: number;
    readonly attempt: number;
    /** Same value as {@link RunHistoryRow.id}; the panel's copy affordance reads it. */
    readonly correlationId: string;
    /** `= correlationId`; displayed so an operator can find the session. */
    readonly attachmentId: string;
    /** Target project, snapshotted at enqueue. */
    readonly projectId: string;
    /** Worktree option, snapshotted at enqueue. */
    readonly worktreeOption: string;
    /** Live lease expiry, else `null` (the lease is fencing, not authority). */
    readonly leaseExpiresAt: string | null;
    /**
     * Live reservation's result deadline, else `null`. Additive beyond
     * contract §1's table: a reader looking at a `starting` run learns when
     * the authorization wedges into `unconfirmed`, the one deadline an
     * operator cannot infer from anything else on the row. It reads `null`
     * once the reservation has been consumed or cleared, because a deadline
     * that can no longer fire is not a fact worth projecting.
     */
    readonly resultDeadlineAt: string | null;
    /** Every retained reference, in join order; excerpts never projected. */
    readonly sourceReferences: readonly HistoryReference[];
    /** How many triggers have joined, retained or not. */
    readonly referenceCount: number;
    readonly referencesTruncated: boolean;
    readonly referencesNotRetained: number;
    /** Session pointer, or `null` when this run never produced one. */
    readonly session: HistorySession | null;
    /** Recorded agent read-back, or `null` when none was filed. */
    readonly verification: HistoryVerification | null;
    /** Trigger kind that opened the run (the earliest reference's). */
    readonly kind: EventKind;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    readonly issueNumber: number;
    /** Issue title; untrusted source text, copied verbatim. */
    readonly issueTitle: string;
    readonly issueUrl: string;
    /** RFC 3339 stamp of the earliest reference; the row's age derives from it. */
    readonly detectedAt: string;
    readonly bindingId: string;
    /** Session id once one exists, else the recorded cause of a failure, else `null`. */
    readonly dispatchResult: string | null;
    /**
     * Issue stamp of the lease held **right now**, else `null`. The run model
     * keeps no claim history — a lease that was spent or expired is cleared
     * — so this is the one claim stamp the stored record can state
     * truthfully. It exists because the shipped row carried the member and
     * the contract's rule is additive-within-v1: removing it would be the
     * wire change the contract forbids, while inventing a stamp for a claim
     * the run no longer holds would be worse than the honest `null`.
     */
    readonly claimedAt: string | null;
    /** RFC 3339 dispatch stamp once a session exists, else `null` (shipped member). */
    readonly dispatchedAt: string | null;
    /**
     * Whether a starting prompt was set when this run was queued.
     *
     * `false` for a run written before this feature — a true statement about
     * that run rather than a hole in the record.
     */
    readonly promptPresent: boolean;
    /** The prompt's `mtp-…` fingerprint, or `null` when none. */
    readonly promptFingerprint: string | null;
    /** Code points of the normalised prompt, or `null` when none. */
    readonly promptLength: number | null;
    /**
     * The ordered tiers that contributed, or `null` when no tier was set. It
     * rides beside the fingerprint — never the text — so the row itself
     * answers *which tiers produced this run* under any retention while the
     * projection still carries no prompt text at all. The value is the
     * snapshot's own list, copied rather than derived: ordered
     * `global → account → binding`, duplicate-free, and `null` exactly when
     * there is no snapshot to read it from.
     */
    readonly promptSources: readonly PromptSource[] | null;
    /**
     * The **shape** of the binding's allow-list at the moment of
     * authorization, snapshotted from `run.actorPolicy`. `null` is *no
     * authorization recorded yet* — a freshly enqueued or adopted run — and
     * never a silent `'open'`. It is the only policy fact this projection
     * carries: the permitted set is configuration in `bindings.json`, this
     * projection reads no binding, and so it is structurally unable to carry
     * a permitted login however the gate judged one.
     */
    readonly actorPolicy: Run['actorPolicy'];
    /** Head SHA of a review-origin pull request; absent on every other kind. */
    readonly headSha?: string;
    /** Base ref of that pull request; absent on every other kind. */
    readonly baseRef?: string;
    /**
     * The run's follow-ups, in detection order — **absentable, and absent is
     * the ordinary case**: a run that has had no movement carries no member, so
     * a panel reading a row without it has nothing to deliver. The list is the
     * oldest {@link MAX_PROJECTED_FOLLOW_UPS} of this run's queue rows,
     * delivered or not, and the window walks with `followUpsFrom` so a busy
     * subject stays followable past the bound (002 FR-104, FR-107). No
     * operation, path, or existing member changes.
     */
    readonly followUps?: readonly HistoryFollowUp[];
}

/**
 * Pull-request coordinates, present only on a review-origin run.
 *
 * An absent member stays absent rather than becoming an empty string the panel
 * cannot tell apart from a real value — the shipped row answered `null` there,
 * and `null` and absent read the same through the panel's DTO.
 */
function reviewCoordinates(delivery: QueuedEvent | undefined): { headSha?: string; baseRef?: string } {
    const head = delivery?.headSha ?? null;
    const base = delivery?.baseRef ?? null;

    return { ...(head !== null && { headSha: head }), ...(base !== null && { baseRef: base }) };
}

/**
 * The cause a `failed` run carries in its `dispatchResult`.
 *
 * The attempt history is the recorded cause (the panel's own report is what
 * wrote it); a run adopted from an older `dispatched`-with-problem row has no
 * attempt record for its failure, so its stored state reason is the same fact
 * in the same place. Anything else reports `null`: a run that is waiting,
 * blocked, or wedged has no *result*, and saying otherwise would invent one.
 */
function recordedCause(run: Run): string | null {
    for (let index = run.attempts.length - 1; index !== -1; index -= 1) {
        const reason = run.attempts[index]?.reason ?? null;
        if (reason !== null) {
            return reason;
        }
    }

    return run.state === 'failed' ? run.stateReason : null;
}

/**
 * The session id or failure text the shipped `dispatchResult` member carried.
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
 * evicted with its terminal run while the run's row must keep parsing
 * for as long as the run is retained — a row written before this feature still
 * has to project.
 */
function deliveryView(input: {
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
 * member exists to prevent. The member answers one question: *by when
 * must this run report, or wedge into `unconfirmed`?*
 */
function liveResultDeadlineOf(run: Run): string | null {
    if (run.reservation === null || run.reservation.consumed) {
        return null;
    }

    return run.reservation.resultDeadlineAt;
}

function leaseViewOf(run: Run): { readonly leaseExpiresAt: string | null; readonly claimedAt: string | null } {
    if (run.lease === null) {
        return { leaseExpiresAt: null, claimedAt: null };
    }

    return { leaseExpiresAt: run.lease.expiresAt, claimedAt: run.lease.issuedAt };
}

/**
 * The session pointer, reduced to the three members the contract names.
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
 * The prompt reference the run history carries — presence, fingerprint,
 * length, sources, and never the text.
 */
function promptViewOf(run: Run): {
    readonly promptPresent: boolean;
    readonly promptFingerprint: string | null;
    readonly promptLength: number | null;
    readonly promptSources: readonly PromptSource[] | null;
} {
    if (run.prompt === null) {
        return {
            promptPresent: false,
            promptFingerprint: null,
            promptLength: null,
            promptSources: null,
        };
    }

    return {
        promptPresent: true,
        promptFingerprint: run.prompt.fingerprint,
        promptLength: run.prompt.length,
        promptSources: run.prompt.sources,
    };
}

/**
 * The head SHA one queue row observed, for a head movement only.
 *
 * Split out of {@link followUpOf} because the from → to chain has to be
 * carried **past** the window's opening: a row the window skips still advances
 * the chain, so the first projected head follow-up names the head the movement
 * before it observed rather than the run's dispatch-time seed.
 */
function headShaOfRow(row: QueuedEvent): string | undefined {
    if (followUpKindOf(row.id) !== 'head') {
        return undefined;
    }

    return row.headSha !== null && row.headSha !== '' ? row.headSha : undefined;
}

/** Sourced one-to-one from the queue row's own member: `admitted` renders as `queued`; absent stays absent. */
function engineViewOf(engine: QueuedEvent['engine']): HistoryFollowUpEngine | undefined {
    if (engine === undefined) {
        return undefined;
    }

    if (engine.state === 'admitted') {
        return { state: 'queued', messageId: engine.messageId };
    }

    if (engine.state === 'unknown') {
        return { state: 'unknown', cause: engine.cause };
    }

    return { state: 'unavailable' };
}

function followUpOf(row: QueuedEvent, previousHeadSha: string | undefined): HistoryFollowUp | null {
    const kind = followUpKindOf(row.id);
    if (kind === null) {
        return null;
    }

    const head = headShaOfRow(row);
    const engine = engineViewOf(row.engine);

    return {
        deliveryId: row.id,
        kind,
        excerpt: row.issueBodyExcerpt,
        actorLogin: row.actorLogin ?? '',
        detectedAt: row.detectedAt,
        sourceUrl: row.issueUrl,
        ...(head !== undefined && { fromHeadSha: previousHeadSha ?? '', headSha: head }),
        ...(engine !== undefined && { engine }),
    };
}

/**
 * Where one run's follow-up window opens, in the run's own detection order:
 * the named id is looked up **in this run's list**, because one read carries
 * a value for a whole page of runs and an id belonging to a different
 * subject is not a position in this one. Skipping the lookup and starting
 * from the end would silently narrow every other row's answer, which FR-003's
 * rule forbids; opening from the start can only ever project a run's
 * movements earlier than asked, never fewer of them.
 */
function windowStartOf(from: string | null, rows: readonly QueuedEvent[]): number {
    if (from === null) {
        return 0;
    }

    const found = rows.findIndex((row) => row.id === from);

    return found === -1 ? 0 : found;
}

/**
 * The run's follow-ups, in detection order, head movements carrying their
 * from → to pair. The rows are the queue's own, filtered to the two
 * follow-up id forms (FR-101); nothing about a follow-up is stored on the
 * run, so the pair is derived from the seed and the row's own earlier
 * movements — which is why the seed is never re-based. `from` walks the
 * window while every row is still walked, so the head chain stays exact and
 * only the projection is gated. `undefined` when the run has none: the
 * ordinary case, and the reason the member is absent rather than empty.
 */
function followUpsOf(input: {
    readonly run: Run;
    /** Every queued delivery row, in queue order. */
    readonly queue: readonly QueuedEvent[];
    /** Where the window opens, or `null` for the start as it was before. */
    readonly from: string | null;
}): readonly HistoryFollowUp[] | undefined {
    const rows = input.queue.filter((row) =>
        row.runCorrelationId === input.run.correlationId && followUpKindOf(row.id) !== null);
    if (rows.length === 0) {
        return undefined;
    }

    const start = windowStartOf(input.from, rows);
    const followUps: HistoryFollowUp[] = [];
    let previousHeadSha: string | undefined = input.run.lastHeadSha;
    // Every row is walked, not only the projected ones: the from → to pair is
    // derived from the movement before it, so a row the window skips still
    // advances the chain.
    for (const [index, row] of rows.entries()) {
        if (index >= start && followUps.length < MAX_PROJECTED_FOLLOW_UPS) {
            const followUp = followUpOf(row, previousHeadSha);
            if (followUp !== null) {
                followUps.push(followUp);
            }
        }

        previousHeadSha = headShaOfRow(row) ?? previousHeadSha;
    }

    return followUps;
}

function historyRowOf(input: {
    readonly run: Run;
    /** Delivery rows keyed by id, as read from the queue. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
    /** Every queued delivery row, in queue order, for the follow-up member. */
    readonly queue: readonly QueuedEvent[];
    /** Where this run's follow-up window opens, or `null` for the start. */
    readonly followUpsFrom: string | null;
}): RunHistoryRow {
    const { run, deliveries, queue } = input;
    const primary = run.sourceReferences[0];
    const delivery = primary === undefined ? undefined : deliveries.get(primary.deliveryId);
    const view = deliveryView({ run, primary, delivery });
    const lease = leaseViewOf(run);
    const dispatchStamp = run.session === null ? null : run.session.dispatchedAt;
    const followUps = followUpsOf({ run, queue, from: input.followUpsFrom });

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
        ...promptViewOf(run),
        actorPolicy: run.actorPolicy,
        ...(followUps !== undefined && { followUps }),
    }, delivery);
}

/**
 * Project the runs history: newest detected first, capped, never claiming.
 */
export function projectRunHistory(input: {
    /** Every retained run, in creation order. */
    readonly runs: readonly Run[];
    /** Delivery rows keyed by id, for the members a run does not store. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
    /** Most rows one answer may carry (`MAX_LISTED_EVENTS`). */
    readonly cap: number;
    /** Where the follow-up window opens, or `null` for the start (FR-104). */
    readonly followUpsFrom?: string | null;
}): RunHistoryRow[] {
    const queue = [...input.deliveries.values()];
    const followUpsFrom = input.followUpsFrom ?? null;
    const rows = input.runs.map((run) => historyRowOf({ run, deliveries: input.deliveries, queue, followUpsFrom }));

    return rows
        .toSorted((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
        .slice(0, input.cap);
}
