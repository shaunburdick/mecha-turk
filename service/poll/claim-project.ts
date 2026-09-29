/**
 * The claim answer's wire shapes and the projection that builds them
 * (003 T-007, T-039; [contracts/claim-lease.md](../../specs/003-dispatch-integrity/contracts/claim-lease.md)).
 *
 * The projection is pure and happens **before** any lease is persisted, which
 * is the property T-039 exists to establish: a run the answer cannot carry is
 * never leased, so it never burns an attempt and a unit of the automatic
 * requeue budget waiting for a panel that was never told about it (FR-032,
 * FR-033). The bounds that decide what "can carry" means live beside this in
 * [`claim-bounds.ts`](./claim-bounds.ts).
 *
 * Every member here is credential-free by construction: a run identifier, a
 * lease coordinate, a snapshotted dispatch target, or source text the operator
 * already sees on the run row. Excerpts ride along because FR-014 requires the
 * dispatch to carry *every* retained source reference, bounded per reference;
 * the run row deliberately does not store them (untrusted text lives on the
 * claim answer, data-model §2.3).
 */

import { projectReferences, RUN_EXCERPT_MAX_CHARS } from './claim-bounds.ts';
import type { BoundedReference } from './claim-bounds.ts';
import type { QueuedEvent } from './events-parse.ts';
import type { Run } from './runs-types.ts';

/**
 * The lease a claim issues, as the answer reports it (FR-030).
 *
 * The lease is a **fencing/consistency token, not a capability**: holding the
 * id authorizes nothing, and the service's bearer token is the only
 * authentication gate. It is a deterministic function of answer-visible inputs
 * (the run's correlation id, the attempt, and the service clock), so an
 * operator reading the trail can recompute it.
 */
export interface ClaimedLease {
    /** Lease identifier; the panel echoes it on every run operation. */
    readonly leaseId: string;
    /** Attempt this lease is issued under (the run's *current* attempt). */
    readonly attempt: number;
    /** Opaque per-mount id of the panel holding it; informational only. */
    readonly holder: string;
    /** RFC 3339 issue stamp (service clock, NFR-112). */
    readonly issuedAt: string;
    /** RFC 3339 expiry stamp; the sweep reclaims exactly here. */
    readonly expiresAt: string;
}

/** One retained source reference as the claim answer carries it (FR-013). */
export type ClaimedReference = BoundedReference;

/** One claimed run, as the panel receives it. */
export interface ClaimedRun {
    /** Run identity on the wire; every later call is addressed by it. */
    readonly correlationId: string;
    /** FR-010's human-readable tuple, shown beside the correlation id. */
    readonly runKey: string;
    /** 0-based ordinal of this run for its subject. */
    readonly ordinal: number;
    /** Attempt this lease is issued under. */
    readonly attempt: number;
    /** The claim itself. */
    readonly lease: ClaimedLease;
    /**
     * The state the run was **offered** in — always `pending` (FR-037).
     *
     * The lease member, not this string, is the proof the run is now held; a
     * reader that needs the stored state after the claim reads the run history.
     */
    readonly state: 'pending';
    /** Why the run was waiting, rendered as the row's reason line (FR-074). */
    readonly stateReason: string;
    /** Binding the run dispatches through. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** Login of the account this run is answered under. */
    readonly accountLogin: string;
    /** Target project, snapshotted at enqueue. */
    readonly projectId: string;
    /** Worktree option, snapshotted at enqueue. */
    readonly worktreeOption: string;
    /** Whether the subject is an issue or a pull request. */
    readonly subjectType: Run['subjectType'];
    /** Issue or pull request number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text. */
    readonly issueTitle: string;
    /** Canonical issue URL. */
    readonly issueUrl: string;
    /** Head SHA of a review-origin pull request; absent otherwise. */
    readonly headSha?: string;
    /** Base ref of that pull request; absent otherwise. */
    readonly baseRef?: string;
    /** `= correlationId`; the panel uses it verbatim as `startSession().id`. */
    readonly attachmentId: string;
    /** Every retained source reference, in join order (FR-014). */
    readonly sourceReferences: readonly ClaimedReference[];
    /** How many triggers joined the run, retained or not. */
    readonly referenceCount: number;
    /** How many joining triggers the cap kept off the list (T-038). */
    readonly referencesNotRetained: number;
    /** Whether the reference list was cut at the cap. */
    readonly referencesTruncated: boolean;
    /** Primary subject excerpt, the field the existing context builder reads. */
    readonly issueBodyExcerpt: string;
    /** Earliest source reference's detection stamp (row age). */
    readonly detectedAt: string;
}

/** One run the claim leased, with the lease and the answer row it produced. */
export interface ClaimRecord {
    /** The run as it now stands in `runs.json`. */
    readonly run: Run;
    /** The lease issued for it. */
    readonly lease: ClaimedLease;
    /** The answer row, projected before the lease was persisted. */
    readonly claimed: ClaimedRun;
}

/**
 * Pull-request coordinates, present only on a review-origin run.
 *
 * The contract marks both members optional: an issue-origin run carries
 * neither, and a member that is absent stays absent rather than becoming an
 * empty string the panel cannot tell apart from a real value.
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
 * The members only the delivery rows can supply: the account login, the
 * untrusted title and excerpt, and the PR coordinates. Every one of them
 * degrades to an empty or absent member when the queue row is gone, so a
 * missing delivery can never blank the run's own identity.
 *
 * @param input - The delivery that opened the run and the run's first link.
 * @returns The delivery-derived members of the claim answer row.
 */
function deliveryView(input: {
    /** The delivery that opened the run, when the queue still holds it. */
    readonly delivery: QueuedEvent | undefined;
    /** The run's first source reference, which names the subject's link. */
    readonly primary: Run['sourceReferences'][number] | undefined;
}): {
    /** Login of the account the run is answered under. */
    readonly accountLogin: string;
    /** Issue title; untrusted source text. */
    readonly issueTitle: string;
    /** Canonical issue URL. */
    readonly issueUrl: string;
    /** Primary subject excerpt, the field the existing context builder reads. */
    readonly issueBodyExcerpt: string;
    /** Head SHA of a review-origin pull request. */
    readonly headSha?: string;
    /** Base ref of that pull request. */
    readonly baseRef?: string;
} {
    const { delivery, primary } = input;

    return {
        accountLogin: delivery?.accountLogin ?? '',
        issueTitle: delivery?.issueTitle ?? '',
        issueUrl: primary?.sourceUrl ?? '',
        issueBodyExcerpt: delivery?.issueBodyExcerpt ?? '',
        ...reviewCoordinates(delivery),
    };
}

/**
 * Project one claimed run for the wire.
 *
 * The run is the record; the delivery rows supply only the things the run
 * deliberately does not store (untrusted excerpt text, the title the operator
 * reads, and the PR coordinates the trigger layer captured). Excerpt text is
 * bounded by [`claim-bounds.ts`](./claim-bounds.ts) so one run's sources cannot
 * crowd out the rest of the answer.
 *
 * @param input - The claimed run, its lease, and the delivery rows.
 * @returns The claim answer row; every member is credential-free.
 */
export function projectClaimedRun(input: {
    /** The claimed run. */
    readonly run: Run;
    /** The lease issued for it. */
    readonly lease: ClaimedLease;
    /** Delivery rows keyed by id, as read from the queue. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
}): ClaimedRun {
    const { run, lease, deliveries } = input;
    const primary = run.sourceReferences[0];
    const delivery = primary === undefined ? undefined : deliveries.get(primary.deliveryId);

    return {
        correlationId: run.correlationId,
        runKey: run.runKey,
        ordinal: run.ordinal,
        attempt: run.attempt,
        lease,
        state: 'pending',
        stateReason: `waiting for a panel; leased until ${lease.expiresAt}`,
        bindingId: run.bindingId,
        repository: run.repository,
        projectId: run.projectId,
        worktreeOption: run.worktreeOption,
        subjectType: run.subjectType,
        issueNumber: run.subjectNumber,
        attachmentId: run.attachmentId,
        sourceReferences: projectReferences({
            references: run.sourceReferences,
            deliveries,
            budget: RUN_EXCERPT_MAX_CHARS,
        }),
        referenceCount: run.referenceCount,
        referencesNotRetained: run.referencesNotRetained,
        referencesTruncated: run.referencesTruncated,
        detectedAt: primary?.detectedAt ?? run.createdAt,
        ...deliveryView({ delivery, primary }),
    };
}
