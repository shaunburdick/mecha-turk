/**
 * The type vocabulary of the run document (003 data-model §2.2–§2.6).
 *
 * Every shape `runs.json` holds is declared here and nowhere else: the run
 * row, the document, and the sub-objects a run carries (source reference,
 * attempt record, lease, reservation, session ref, verification). The parser
 * that validates those shapes lives beside this module in `runs-parse.ts`,
 * and the run store (`runs.ts`) imports both, so the schema has exactly one
 * home even as the transitions grow.
 *
 * The split is a file-length requirement, not a design flourish: types plus
 * validators together pass the 500-line gate only by documenting neither
 * properly.
 */

import type { PromptSnapshot } from '../prompt.ts';
import type { EventKind } from './events-parse.ts';
import type { RunSubjectType } from './run-key.ts';

/** One run's state: the eight-state vocabulary of the dispatch model. */
export type RunState =
    | 'pending'
    | 'claimed'
    | 'starting'
    | 'dispatched'
    | 'failed'
    | 'unconfirmed'
    | 'dead-lettered'
    | `blocked:${string}`;

/** A reference's origin: where the delivery matched (FR-013). */
export type ReferenceOrigin = 'assignment' | 'body' | 'review' | `comment:${number}`;

/** One delivery's membership in a run (FR-013). */
export interface SourceReference {
    /** The joining delivery's unchanged id (FR-012). */
    readonly deliveryId: string;
    /** Trigger kind the delivery was detected under. */
    readonly kind: EventKind;
    /** Where it matched: assignment, issue body, a comment id, or review. */
    readonly origin: ReferenceOrigin;
    /** Canonical link back to the source. */
    readonly sourceUrl: string;
    /** That delivery's detection stamp. */
    readonly detectedAt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
}

/** One recorded dispatch attempt (003 Key Entities: DispatchAttempt). */
export interface DispatchAttempt {
    /** Attempt number this record is for. */
    readonly attempt: number;
    /** Token minted at reservation, or `null` when nothing was reserved. */
    readonly dispatchToken: string | null;
    /** Reservation stamp, or `null` for a claim that never reserved. */
    readonly reservedAt: string | null;
    /** What the attempt produced, or `null` while it is in flight. */
    readonly outcome: 'dispatched' | 'failed' | 'abandoned' | 'expired' | 'blocked' | 'unconfirmed' | null;
    /** Session created by this attempt, else `null`. */
    readonly sessionId: string | null;
    /** Failure, expiry, or block reason, else `null`. */
    readonly reason: string | null;
    /** When the service recorded the outcome, else `null`. */
    readonly resultReportedAt: string | null;
}

/**
 * Which path minted a lease (FR-030, data-model §1).
 *
 * A lease is a **fencing/consistency token, not a capability**: its id carries
 * no authority of its own, is a deterministic function of answer-visible inputs
 * (the run's correlation id, the attempt, and the service clock), and gates
 * nothing. The service's bearer token is the only authentication gate, and the
 * single-use dispatch token (FR-020) is the only authorization to start a
 * session. Provenance is recorded as a typed member rather than as a naming
 * convention inside the id so {@link parseLease} can refuse an id shape no path
 * in this build mints, and so the sweep's migration-recovery accounting reads a
 * field instead of a string prefix.
 */
export type LeaseProvenance =
    /** A panel's live claim through `GET /v1/events/pending`. */
    | 'panel'
    /** The synthetic, already-expired lease adoption mints for a legacy `in-flight` row. */
    | 'migration';

/** The claim's time-bounded coordination record (FR-030). */
export interface RunLease {
    /** Lease identifier; one path-safe segment, `lse-` or `migration-` shaped. */
    readonly leaseId: string;
    /** Attempt the lease was issued under. */
    readonly attempt: number;
    /** Opaque mount id holding the lease; informational, never authorization. */
    readonly holder: string;
    /** RFC 3339 issue stamp. */
    readonly issuedAt: string;
    /** RFC 3339 expiry stamp; the sweep compares it to the service clock. */
    readonly expiresAt: string;
    /** Which path minted this lease; drives migration-recovery accounting. */
    readonly provenance: LeaseProvenance;
}

/** The reservation that authorizes one `host.startSession()` (FR-021). */
export interface RunReservation {
    /** The single-use token handed to the panel. */
    readonly dispatchToken: string;
    /** Attempt the reservation was made under. */
    readonly attempt: number;
    /** RFC 3339 reservation stamp. */
    readonly reservedAt: string;
    /** RFC 3339 result deadline; passing it moves the run to `unconfirmed`. */
    readonly resultDeadlineAt: string;
    /** Whether a result has consumed this reservation's token. */
    readonly consumed: boolean;
}

/** Where a run's dispatch pointed (002 Key Entities: SessionRef). */
export interface SessionRef {
    /** Host-owned session id. */
    readonly sessionId: string;
    /** Attachment id the session was started with. */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
    /** Session title as the host reported it. */
    readonly title: string;
    /** Source link the session opened from. */
    readonly sourceUrl: string;
    /** Worktree the session runs in, or `null` when it has none. */
    readonly worktree: { readonly directory: string; readonly branch: string } | null;
}

/** The recorded outcome of the post-dispatch agent read-back (FR-043). */
export interface RunVerification {
    /** Agent the read-back observed, or `null` when it was unreadable. */
    readonly observedAgent: string | null;
    /** Agent the binding expected. */
    readonly expectedAgent: string;
    /** Whether the two matched. */
    readonly ok: boolean;
    /** Extra note on a mismatch, or `null`. */
    readonly note: string | null;
    /** RFC 3339 stamp of the read-back. */
    readonly at: string;
}

/** One run: the unit of dispatch (FR-010, data-model §2.2). */
export interface Run {
    /** FR-010 tuple, human-readable by design. */
    readonly runKey: string;
    /** `mt-run-<hash>` — the id every hop of the chain carries (FR-050). */
    readonly correlationId: string;
    /** Attachment id for `host.startSession()`; the correlation id itself. */
    readonly attachmentId: string;
    /** 0-based ordinal of this run for its subject. */
    readonly ordinal: number;
    /** Whether the subject is an issue or a pull request. */
    readonly subjectType: RunSubjectType;
    /** Issue or pull request number. */
    readonly subjectNumber: number;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** GitHub numeric user id of the account the work is under. */
    readonly accountNumericUserId: string;
    /** Binding this run dispatches through. */
    readonly bindingId: string;
    /** Project snapshotted at enqueue. */
    readonly projectId: string;
    /** Worktree option snapshotted at enqueue. */
    readonly worktreeOption: string;
    /**
     * The binding's starting prompt as it stood when this run was enqueued
     * (004 FR-015; data-model §3).
     *
     * `null` for a run queued with no prompt — which includes every run
     * written before this field existed, so absence keeps its plain reading.
     * It is never re-read from the binding: an edit, a clear, or a delete
     * changes nothing about a stored run, and a retry (003 FR-041) reuses it
     * and therefore composes a byte-identical message (004 AC-138).
     */
    readonly prompt: PromptSnapshot | null;
    /** Current state: one of the eight model states, or `blocked:<reason>`. */
    readonly state: RunState;
    /** Why the run sits where it does; required off `pending` (FR-074). */
    readonly stateReason: string | null;
    /** Attempt count; starts at 1, incremented by expiry, retry, and resolve. */
    readonly attempt: number;
    /** Automatic requeues consumed so far (`0…MAX_AUTO_REQUEUES`). */
    readonly requeuesUsed: number;
    /**
     * One entry per joining delivery, capped at {@link MAX_SOURCE_REFERENCES}.
     *
     * Every retained entry carries FR-013's full detail; the cap is the only
     * thing that ever removes one, and what it removed is counted rather than
     * hidden (T-038).
     */
    readonly sourceReferences: readonly SourceReference[];
    /** How many deliveries have joined, retained or not. */
    readonly referenceCount: number;
    /**
     * How many joining triggers were **not** retained (T-038).
     *
     * The marker is additive: it never stands in for a reference, and every
     * delivery it counts still earns its own `run.coalesced` audit row (FR-016),
     * so the operator can see that a row is lossy instead of inferring it.
     */
    readonly referencesNotRetained: number;
    /** Whether the reference list was cut at the cap (NFR-107, T-038). */
    readonly referencesTruncated: boolean;
    /** The live lease, or `null` when no panel holds the run. */
    readonly lease: RunLease | null;
    /** The live reservation, or `null` when nothing was authorized. */
    readonly reservation: RunReservation | null;
    /** Ordered attempt history, bounded by the attempt-record cap. */
    readonly attempts: readonly DispatchAttempt[];
    /** The session this run produced, at most one ever (FR-028). */
    readonly session: SessionRef | null;
    /** Recorded verification outcome, or `null` when none was reported. */
    readonly verification: RunVerification | null;
    /** RFC 3339 creation stamp. */
    readonly createdAt: string;
    /** RFC 3339 stamp of the last mutation. */
    readonly updatedAt: string;
}

/** Structured, credential-free details a lifecycle audit row records. */
export type RunAuditDetails = Readonly<Record<string, string | number | boolean | null>>;

/** Durable intent for an audit row whose append can span a crash (T-037, T-040b). */
export type RunAuditIntent =
    | {
        /** A newly created run needs its creation row. */
        readonly eventType: 'run.created';
        /** The service-minted run identity. */
        readonly correlationId: string;
        /** Deliveries folded into the initial run. */
        readonly deliveryIds: readonly string[];
    }
    | {
        /** A legacy run needs its one migration row. */
        readonly eventType: 'run.migrated';
        /** The service-minted run identity. */
        readonly correlationId: string;
        /** Legacy deliveries represented by the adopted run. */
        readonly deliveryIds: readonly string[];
        /** Classification branches used during adoption. */
        readonly stateBranches: readonly string[];
        /** Adopted state at the moment of migration. */
        readonly state: RunState;
    }
    | {
        /**
         * A sweep recovery needs its lifecycle row (T-040b).
         *
         * The sweep has no caller to answer, so its trail is the only record an
         * operator has of an automatic recovery; the intent is what makes a
         * failed append recoverable rather than lost.
         */
        readonly eventType: 'dispatch.lease-expired' | 'run.dead_lettered' | 'dispatch.unconfirmed';
        /** The run's identity (FR-062: never a fresh identifier). */
        readonly correlationId: string;
        /** The decision the row records. */
        readonly decision: string;
        /** Secret-free reason naming the exact cause. */
        readonly reason: string;
        /** Structured, credential-free details; never a dispatch token value. */
        readonly details: RunAuditDetails;
        /**
         * What distinguishes this row from an earlier one for the same run.
         *
         * The outbox retires an intent by finding a matching row, and a run can
         * be lease-expired three times — without a discriminator the second
         * recovery would match the first row and never be written at all.
         */
        readonly sequence: string;
    };

/** The `runs.json` document: schema marker, ordinal counters, and runs. */
export interface RunsDocument {
    /** Document schema version this build understands. */
    readonly schemaVersion: number;
    /** Next ordinal per subject key; never pruned (data-model §2.6). */
    readonly subjects: Readonly<Record<string, number>>;
    /** Every retained run, in creation order. */
    readonly runs: readonly Run[];
    /** Audits committed to storage but not yet durably appended, if any. */
    readonly auditIntents?: readonly RunAuditIntent[];
}
