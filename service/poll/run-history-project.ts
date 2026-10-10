/**
 * The run-history projection behind `GET /v1/events`
 * ([contracts/run-history-audit.md](../../specs/003-dispatch-integrity/contracts/run-history-audit.md)).
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
 * Four properties it owes, worst-first:
 *
 * - **Credential-free by construction.** No dispatch token (the row says *that*
 *   an authorization exists and when it dies, never *what* it is), no account
 *   login, no numeric account id — only the run's own identity, which an
 *   operator already sees everywhere else.
 * - **Hostile source text is copied, never interpreted.** The issue title,
 *   repository, and state reason are untrusted text; the panel renders them
 *   through its non-HTML path, so this module's whole job is to hand them back
 *   byte-identical.
 * - **Degradation is explicit, never silent.** The delivery row a title or PR
 *   coordinate came from can be evicted with its terminal run, so each of those
 *   falls back to a value derived from the run itself rather than to an empty
 *   string the panel's parser reads as an unusable record.
 * - **The permitted set is structurally unreachable from here.** The row carries
 *   each reference's own `actorLogin`/`actorAttribution` — the
 *   facts about who was attributed to this run, which every joining delivery
 *   records and the gate judges — beside the two-word `actorPolicy` shape. What
 *   it never carries is the *list*: this projection is a pure function of stored
 *   runs, it is handed no binding and reads no file, so a second copy of an
 *   access policy has no path into it at all.
 */

import type { PromptSource } from '../prompt.ts';
import type { EventKind, FollowUpKind, QueuedEvent } from './events-parse.ts';
import { followUpKindOf } from './events-parse.ts';
import type { Run, SourceReference } from './runs-types.ts';

/** Why a run that has never moved sits where it does. */
const WAITING_REASON = 'waiting for a panel';

/**
 * A source reference as the run history carries it.
 *
 * Exactly the stored shape: the excerpt a dispatch context is built from is
 * **not** stored on the run — it lives on the delivery, which the run points at
 * — so there is nothing here that could be omitted by accident. The three
 * counting members below the list are what keep a row from
 * being silently lossy at the 200-reference cap.
 *
 * Each entry also carries the two **actor members** exactly as stored —
 * absentable on a reference written before attribution existed, because a run is
 * history and refusing one would quarantine the whole document for it.
 */
export type HistoryReference = SourceReference;

/** The session pointer as the run history carries it. */
export interface HistorySession {
    /** Host-owned session id. */
    readonly sessionId: string;
    /** `= correlationId`; the id the session was started with. */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
}

/** The recorded agent read-back as the run history carries it. */
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

/**
 * One follow-up, as the run history carries it (002 FR-104).
 *
 * **A follow-up is not a source reference on the run**, and that is load-bearing
 * rather than tidy: 003's actor gate classifies from `sourceReferences`
 * exclusively, so a follow-up that joined that list would be re-judged by the
 * allow-list on the run's next authorization. It rides this member and the
 * queue row, never the run's reference list.
 *
 * Every member is the row's own, unchanged: the `excerpt` is the bounded,
 * delimiter-defused text the panel composes with, and the id is the relay's
 * handled key and the at-most-once key in one.
 */
export interface HistoryFollowUp {
    /** The deterministic `evt-…~followup~…` id: the relay's at-most-once key. */
    readonly deliveryId: string;
    /** Which of the two movement kinds this is. */
    readonly kind: FollowUpKind;
    /** Bounded untrusted excerpt the panel composes its message from. */
    readonly excerpt: string;
    /** The actor the movement is attributed to; credential-free by construction. */
    readonly actorLogin: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** Canonical link back to the source. */
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
}

/**
 * How many follow-ups one history row projects (002 FR-104).
 *
 * A bound on the **answer**, not on the movement: a comment flood on a busy
 * subject must not be able to grow one row without limit, so the row carries a
 * window of the queue and the rest stay there for a later read. The queue is
 * the record; this is the window onto it.
 *
 * **What the window is, stated plainly: the oldest twenty queue rows in
 * detection order, delivered or not.** The service holds no record of a
 * delivery — the panel is the only party that calls the host, and its durable
 * record lives in host storage — so a delivered follow-up row is never pruned
 * from the queue and this projection cannot skip one. The consequence is a
 * known, structural bound: on a run whose subject keeps moving, the window
 * fills with follow-ups the panel has already delivered, and the movements
 * behind them are not projected until the service can be told which ones
 * reached the session. The docblock this replaces promised "the oldest
 * undelivered ones", which no store member makes possible.
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
    /** Current attempt count. */
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
     * Live reservation's result deadline, else `null`.
     *
     * Additive beyond contract §1's table and beside the reserve answer's own
     * member of the same name (contract, dispatch-authorization §1): a reader
     * looking at a `starting` run learns when the authorization wedges into
     * `unconfirmed`, which is the one deadline an operator cannot infer from
     * anything else on the row. It reads `null` once the reservation
     * has been consumed or cleared, because a deadline that can no longer fire
     * is not a fact worth projecting.
     */
    readonly resultDeadlineAt: string | null;
    /** Every retained reference, in join order; excerpts never projected. */
    readonly sourceReferences: readonly HistoryReference[];
    /** How many triggers have joined, retained or not. */
    readonly referenceCount: number;
    /** Whether the reference list was cut at the cap. */
    readonly referencesTruncated: boolean;
    /** How many joining triggers the cap kept off the list; `0` when none. */
    readonly referencesNotRetained: number;
    /** Session pointer, or `null` when this run never produced one. */
    readonly session: HistorySession | null;
    /** Recorded agent read-back, or `null` when none was filed. */
    readonly verification: HistoryVerification | null;
    /** Trigger kind that opened the run (the earliest reference's). */
    readonly kind: EventKind;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** Issue (or pull request) number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text, copied verbatim. */
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
     * The ordered tiers that contributed, or `null` when no tier was set.
     *
     * It rides beside the fingerprint — never the text — so the row itself
     * answers *which tiers produced this run* under any retention, while the
     * projection still carries no prompt text at all. The value
     * is the snapshot's own list, copied rather than derived: ordered
     * `global → account → binding`, duplicate-free, and `null` exactly when
     * there is no snapshot to read it from.
     */
    readonly promptSources: readonly PromptSource[] | null;
    /**
     * The **shape** of the binding's allow-list at the moment of authorization,
     * snapshotted from `run.actorPolicy`.
     *
     * `null` is *no authorization recorded yet* — a freshly enqueued or adopted
     * run — and never a silent `'open'`. It is the only policy fact this
     * projection carries: the permitted set is configuration in
     * `bindings.json`, this projection is a pure function of stored runs that
     * reads no binding, and so it is structurally unable to carry a permitted
     * login however the gate judged one.
     */
    readonly actorPolicy: Run['actorPolicy'];
    /** Head SHA of a review-origin pull request; absent on every other kind. */
    readonly headSha?: string;
    /** Base ref of that pull request; absent on every other kind. */
    readonly baseRef?: string;
    /**
     * The run's follow-ups, in detection order — **absentable, and absent is the
     * ordinary case**.
     *
     * One additive member on the read the panel already performs (`GET
     * /v1/events`, the read that already projects `session` beside it), so the
     * follow-up's text and its target session ride one row and no second copy of
     * the session id exists anywhere (002 FR-104, FR-107). A run that has had
     * no movement carries no member at all, which is what every run looks like
     * until something on its subject moves — so a panel reading a row without it
     * has nothing to deliver.
     *
     * The list is a window of the queue's follow-up rows for this run, in
     * detection order — **the oldest {@link MAX_PROJECTED_FOLLOW_UPS} of them,
     * delivered or not**, because the service holds no record of a delivery and
     * so cannot skip one the panel has already sent. The panel filters what it
     * has delivered against its own durable record; this projection is the
     * movement's existence and text, and nothing about its fate. No operation,
     * path, or existing member changes (FR-104).
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
 *
 * @returns The recorded cause, or `null`.
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
 *
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
 * evicted with its terminal run while the run's row must keep parsing
 * for as long as the run is retained — a row written before this feature still
 * has to project.
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
 * member exists to prevent. The member answers one question: *by when
 * must this run report, or wedge into `unconfirmed`?*
 *
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
 * The prompt reference the run history carries — presence, fingerprint,
 * length, sources, and never the text.
 *
 * @returns The four reference members; `promptSources` is the snapshot's own
 *   list when one exists and `null` when no tier was set — there is nothing to
 *   default from, because the absence case is a statement about the run rather
 *   than a hole in the record.
 */
function promptViewOf(run: Run): {
    /** Whether a starting prompt was set when this run was queued. */
    readonly promptPresent: boolean;
    /** The fingerprint, or `null` when none. */
    readonly promptFingerprint: string | null;
    /** The length, or `null` when none. */
    readonly promptLength: number | null;
    /** The contributing tiers in order, or `null` when no tier was set. */
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
 * Project one queue row into its follow-up entry.
 *
 * @returns The entry, or `null` when the row carries nothing a delivery can use.
 */
function followUpOf(row: QueuedEvent, previousHeadSha: string | undefined): HistoryFollowUp | null {
    const kind = followUpKindOf(row.id);
    if (kind === null) {
        return null;
    }

    const head = kind === 'head' && row.headSha !== null && row.headSha !== '' ? row.headSha : undefined;

    return {
        deliveryId: row.id,
        kind,
        excerpt: row.issueBodyExcerpt,
        actorLogin: row.actorLogin ?? '',
        detectedAt: row.detectedAt,
        sourceUrl: row.issueUrl,
        ...(head !== undefined && { fromHeadSha: previousHeadSha ?? '', headSha: head }),
    };
}

/**
 * The run's follow-ups, in detection order, head movements carrying their
 * from → to pair.
 *
 * The rows are the queue's own, filtered to the ones that joined this run and
 * whose id is one of the two follow-up forms (FR-101). Nothing about a follow-up
 * is stored on the run: its text is the row's existing bounded excerpt, its role
 * is the id's discriminator, and its from → to pair is derived here from the
 * run's seed and its own earlier movements — which is why the seed is never
 * re-based on a later observation.
 *
 * @returns The follow-ups, or `undefined` when the run has none — the ordinary
 *   case, and the reason the member is absent rather than empty.
 */
function followUpsOf(input: {
    /** The run being projected. */
    readonly run: Run;
    /** Every queued delivery row, in queue order. */
    readonly queue: readonly QueuedEvent[];
}): readonly HistoryFollowUp[] | undefined {
    const rows = input.queue.filter((row) =>
        row.runCorrelationId === input.run.correlationId && followUpKindOf(row.id) !== null);
    if (rows.length === 0) {
        return undefined;
    }

    const followUps: HistoryFollowUp[] = [];
    let previousHeadSha: string | undefined = input.run.lastHeadSha;
    for (const row of rows.slice(0, MAX_PROJECTED_FOLLOW_UPS)) {
        const followUp = followUpOf(row, previousHeadSha);
        if (followUp === null) {
            continue;
        }

        followUps.push(followUp);
        previousHeadSha = followUp.headSha ?? previousHeadSha;
    }

    return followUps;
}

/** Project one stored run into its history row. */
function historyRowOf(input: {
    /** The run being projected. */
    readonly run: Run;
    /** Delivery rows keyed by id, as read from the queue. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
    /** Every queued delivery row, in queue order, for the follow-up member. */
    readonly queue: readonly QueuedEvent[];
}): RunHistoryRow {
    const { run, deliveries, queue } = input;
    const primary = run.sourceReferences[0];
    const delivery = primary === undefined ? undefined : deliveries.get(primary.deliveryId);
    const view = deliveryView({ run, primary, delivery });
    const lease = leaseViewOf(run);
    const dispatchStamp = run.session === null ? null : run.session.dispatchedAt;
    const followUps = followUpsOf({ run, queue });

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
 *
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
    const queue = [...input.deliveries.values()];
    const rows = input.runs.map((run) => historyRowOf({ run, deliveries: input.deliveries, queue }));

    return rows
        .toSorted((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
        .slice(0, input.cap);
}
