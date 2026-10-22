/**
 * The type vocabulary of the run document.
 */

import type { PromptSnapshot } from '../prompt.ts';
import type { ActorAttribution } from './attribution.ts';
import type { EventKind } from './events-parse.ts';
import type { RunSubjectType } from './run-key.ts';

export type RunState =
    | 'pending'
    | 'claimed'
    | 'starting'
    | 'dispatched'
    | 'failed'
    | 'unconfirmed'
    | 'dead-lettered'
    | `blocked:${string}`;

export type ReferenceOrigin = 'assignment' | 'body' | 'review' | `comment:${number}` | `review-comment:${number}`;

export interface SourceReference {
    /** The joining delivery's unchanged id. */
    readonly deliveryId: string;
    readonly kind: EventKind;
    readonly origin: ReferenceOrigin;
    readonly sourceUrl: string;
    readonly detectedAt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
    /**
     * The actor this delivery is attributed to, copied from the queue row at join. **Absentable on
     * read, validated when present**: a pre-attribution run carries neither member and still
     * parses, because it is history — absence means *no attribution was recorded*, not an empty or
     * guessed actor, which is what makes the gate's refusal reachable rather than an admission.
     */
    readonly actorLogin?: string;
    /**
     * How that attribution was made: `direct` when GitHub named the author of the text that carried
     * the trigger, `subject-author` when the issue or pull-request author stands in as a documented
     * proxy. Absentable and validated on the same terms as {@link SourceReference.actorLogin}: an
     * unrecognized basis refuses the run rather than defaulting to a guess.
     */
    readonly actorAttribution?: ActorAttribution;
}

/**
 * The **shape** of the binding's allow-list at the moment of authorization: two words, never the
 * logins — an audit trail or run record listing who may trigger a repository is a second copy of
 * the access policy in a file retained for months, and the permitted set's home is `bindings.json`.
 * `'restricted'` therefore always means **at least one** login; an empty list is refused at save
 * *and* on read, so it can never reach here.
 */
export type ActorPolicy = 'open' | 'restricted';

/**
 * The gate's extra `dispatch.refused` details: every denied login and each one's basis — a
 * refusal a reader cannot attribute is not an explainable refusal — but never a *permitted* login,
 * since the detail set is built from the run's own references and the policy's **shape**, never
 * from the stored list. Declared here because the shared chain threads it to the row builder and
 * the run vocabulary is the one module both already import.
 */
export interface ActorGateRefusal {
    readonly bindingId: string;
    /** Shape of the allow-list in force, or `null` when it could not be read. */
    readonly actorPolicy: ActorPolicy | null;
    /**
     * Every denied login, in the order the run's references list them. **Absent** on the one
     * refusal made without a policy in hand — an unreadable bindings document, or a binding the
     * document does not carry — because nothing was compared and naming a "denial" would record a
     * verdict the gate never reached (constitution II: a missing authorization is a stop condition,
     * not a finding).
     */
    readonly deniedLogins?: readonly string[] | undefined;
    /** Each denied login's basis, index-parallel to {@link deniedLogins}. */
    readonly deniedAttributions?: readonly string[] | undefined;
    readonly unreadableReferences: number;
    /**
     * How many references the gate actually judged, beside the refusal because a truncated list is
     * what makes the verdict incomplete: the gate classifies from `sourceReferences` **exclusively**,
     * so a run cut at the cap is judged on less than it recorded, and an actor among the *dropped*
     * references is invisible under **every** policy.
     */
    readonly retainedReferences: number;
    readonly referencesNotRetained: number;
    readonly referencesTruncated: boolean;
}

/** One recorded dispatch attempt (003 Key Entities: DispatchAttempt). */
export interface DispatchAttempt {
    readonly attempt: number;
    /** Token minted at reservation, or `null` when nothing was reserved. */
    readonly dispatchToken: string | null;
    /** Reservation stamp, or `null` for a claim that never reserved. */
    readonly reservedAt: string | null;
    /** What the attempt produced, or `null` while it is in flight. */
    readonly outcome: 'dispatched' | 'failed' | 'abandoned' | 'expired' | 'blocked' | 'unconfirmed' | null;
    readonly sessionId: string | null;
    /** Failure, expiry, or block reason, else `null`. */
    readonly reason: string | null;
    /** When the service recorded the outcome, else `null`. */
    readonly resultReportedAt: string | null;
}

/**
 * Which path minted a lease (FR-030, data-model §1). A lease is a fencing/consistency token and not
 * a capability: its id carries no authority of its own and gates nothing — the bearer token
 * authenticates and the single-use dispatch token authorizes. Provenance is a typed member rather
 * than a naming convention inside the id so {@link parseLease} can refuse an id shape no path in
 * this build mints.
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

/** The reservation that authorizes one `host.startSession()`. */
export interface RunReservation {
    /** The single-use token handed to the panel. */
    readonly dispatchToken: string;
    readonly attempt: number;
    /** RFC 3339 reservation stamp. */
    readonly reservedAt: string;
    /** RFC 3339 result deadline; passing it moves the run to `unconfirmed`. */
    readonly resultDeadlineAt: string;
    readonly consumed: boolean;
}

/** Where a run's dispatch pointed (002 Key Entities: SessionRef). */
export interface SessionRef {
    readonly sessionId: string;
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
    /** Session title as the host reported it. */
    readonly title: string;
    readonly sourceUrl: string;
    readonly worktree: { readonly directory: string; readonly branch: string } | null;
    /** Absentable and store-internal — rides no wire surface; absence fails the pre-check safe to the fallback. */
    readonly directory?: string;
}

export interface RunVerification {
    /** Agent the read-back observed, or `null` when it was unreadable. */
    readonly observedAgent: string | null;
    readonly expectedAgent: string;
    readonly ok: boolean;
    /** Extra note on a mismatch, or `null`. */
    readonly note: string | null;
    /** RFC 3339 stamp of the read-back. */
    readonly at: string;
}

/**
 * Where a verification report's comparison baseline came from — only the panel can know this, it is
 * the party that read `GET /v1/config`, so it travels on the report and lands on the
 * `agent.uncompared` row beside the observed agent as the answer to *why* nothing was compared,
 * recorded rather than inferred. The service checks it against the baseline's emptiness instead of
 * trusting it: `configured` exactly when `expectedAgent` is non-blank, the others when it is empty.
 */
export type BaselineProvenance = 'configured' | 'defaulted' | 'unset';

/**
 * The bounded check watch one tracked pull request's run carries (FR-126).
 *
 * It belongs to the run, not to a registry: arming replaces it for a new head,
 * and dropping it is the only way it ends short of the run's own eviction.
 */
export interface ChecksWatch {
    /** The current head the watch belongs to. */
    readonly headSha: string;
    /** RFC 3339 arm stamp, service clock. */
    readonly armedAt: string;
    /** Check-runs reads spent on this watch, `0` at arm. */
    readonly polls: number;
}

/** One run: the unit of dispatch (FR-010, data-model §2.2). */
export interface Run {
    /** FR-010 tuple, human-readable by design. */
    readonly runKey: string;
    /** `mt-run-<hash>` — the id every hop of the chain carries. */
    readonly correlationId: string;
    /** Attachment id for `host.startSession()`; the correlation id itself. */
    readonly attachmentId: string;
    /** 0-based ordinal of this run for its subject. */
    readonly ordinal: number;
    readonly subjectType: RunSubjectType;
    readonly subjectNumber: number;
    /** Repository in `owner/name` form. */
    readonly repository: string;
    /** GitHub numeric user id of the account the work is under. */
    readonly accountNumericUserId: string;
    readonly bindingId: string;
    /** Project snapshotted at enqueue. */
    readonly projectId: string;
    /** Worktree option snapshotted at enqueue. */
    readonly worktreeOption: string;
    /**
     * The binding's starting prompt as it stood when this run was enqueued — `null` for a run
     * queued with no prompt, which includes every run written before this field existed. It is
     * never re-read from the binding: an edit, a clear, or a delete changes nothing about a stored
     * run, and a retry reuses it and therefore composes a byte-identical message.
     */
    readonly prompt: PromptSnapshot | null;
    /**
     * The shape of the binding's allow-list **in force when this run was authorized**, snapshotted
     * by the gate from the same read that made its decision so `dispatch.reserved` and
     * `dispatch.result` provably describe one policy. `null` means **no authorization has been
     * recorded yet** — a freshly enqueued run, an adopted pre-`actorPolicy` row, or one the gate
     * refused (a refusal writes nothing). A statement about the run, never a default of `'open'`,
     * and never a permitted login.
     */
    readonly actorPolicy: ActorPolicy | null;
    /** Current state: one of the eight model states, or `blocked:<reason>`. */
    readonly state: RunState;
    /** Why the run sits where it does; required off `pending`. */
    readonly stateReason: string | null;
    /** Attempt count; starts at 1, incremented by expiry, retry, and resolve. */
    readonly attempt: number;
    /** Automatic requeues consumed so far (`0…MAX_AUTO_REQUEUES`). */
    readonly requeuesUsed: number;
    /**
     * One entry per joining delivery, capped at {@link MAX_SOURCE_REFERENCES}: every retained entry
     * carries the reference's full detail, and the cap is the only thing that ever removes one —
     * what it removed is counted rather than hidden.
     */
    readonly sourceReferences: readonly SourceReference[];
    /** How many deliveries have joined, retained or not. */
    readonly referenceCount: number;
    /**
     * How many joining triggers were **not** retained. The marker is additive: it never stands in
     * for a reference, and every delivery it counts still earns its own `run.coalesced` audit row,
     * so the operator can see a lossy row instead of inferring it.
     */
    readonly referencesNotRetained: number;
    readonly referencesTruncated: boolean;
    /** The live lease, or `null` when no panel holds the run. */
    readonly lease: RunLease | null;
    /** The live reservation, or `null` when nothing was authorized. */
    readonly reservation: RunReservation | null;
    /** Ordered attempt history, bounded by the attempt-record cap. */
    readonly attempts: readonly DispatchAttempt[];
    /** The session this run produced, at most one ever. */
    readonly session: SessionRef | null;
    /**
     * The head SHA this run's establishing cycle observed, so the next cycle can tell a push from
     * the state that already existed at dispatch. **Absentable and validated when present** —
     * absent means *no seed recorded*, never *the head changed* (002 FR-103). The seed is the
     * **dispatch-time baseline**, never re-based, which is what makes the from → to pair
     * recoverable from the run's own history. An **issue** subject carries no seed and never
     * produces a head follow-up, so the member is absent on every issue run forever.
     */
    readonly lastHeadSha?: string;
    /**
     * The live check watch, or absent when none is armed. **Absentable and
     * validated when present**: absent means *no watch*, never *the suite
     * passed* (FR-126).
     */
    readonly checksWatch?: ChecksWatch | undefined;
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
        readonly correlationId: string;
        readonly deliveryIds: readonly string[];
    }
    | {
        /** A legacy run needs its one migration row. */
        readonly eventType: 'run.migrated';
        readonly correlationId: string;
        /** Legacy deliveries represented by the adopted run. */
        readonly deliveryIds: readonly string[];
        readonly stateBranches: readonly string[];
        /** Adopted state at the moment of migration. */
        readonly state: RunState;
    }
    | {
        /**
         * A sweep recovery needs its lifecycle row: the sweep has no caller to answer, so its trail
         * is the only record an operator has of an automatic recovery, and the intent is what makes
         * a failed append recoverable rather than lost.
         */
        readonly eventType: 'dispatch.lease-expired' | 'run.dead_lettered' | 'dispatch.unconfirmed';
        /** The run's identity, never a fresh identifier. */
        readonly correlationId: string;
        readonly decision: string;
        /** Secret-free reason naming the exact cause. */
        readonly reason: string;
        /** Structured, credential-free details; never a dispatch token value. */
        readonly details: RunAuditDetails;
        /**
         * What distinguishes this row from an earlier one for the same run: the outbox retires an
         * intent by finding a matching row, and a run can be lease-expired three times — without a
         * discriminator the second recovery would match the first and never be written at all.
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
