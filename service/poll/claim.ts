/**
 * The run claim: `GET /v1/events/pending` hands a panel every **run** waiting
 * for one, each under a fresh lease (003 FR-030, FR-031, FR-037;
 * [contracts/claim-lease.md](../../specs/003-dispatch-integrity/contracts/claim-lease.md)).
 *
 * Three properties make this the only way a panel acquires the right to
 * attempt a dispatch:
 *
 * 1. **One atomic batch.** Every eligible run moves `pending → claimed` inside
 *    a single task on the chain `runs.json` and `events.json` share, so two
 *    panels calling concurrently receive disjoint sets and the second receives
 *    what remains (possibly `[]`) — never a run the first one holds.
 * 2. **Eligibility is the service's alone** (FR-037). Only `state === 'pending'`
 *    is ever offered, and a run whose history records a session is refused
 *    even if its stored state says otherwise: the impossible-by-construction
 *    rule (FR-028) is a read, not a state check.
 * 3. **The claim is a lease, not a flip** (FR-030). Each claimed run records
 *    the lease id, the attempt, the holder, and the expiry, and the sweep
 *    recovers it from that record alone.
 *
 * The answer projects only what the contract lists, and it is credential-free
 * by construction: every field is either a run identifier, a lease coordinate,
 * a snapshotted dispatch target, or source text the operator already sees on
 * the run row. Excerpts ride along because FR-014 requires the dispatch to
 * carry *every* retained source reference, bounded per reference; the run row
 * deliberately does not carry them (untrusted text lives on the claim answer).
 */

import { createHash } from 'node:crypto';
import { nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import { CONFIG_FILE, DEFAULT_CONFIG, configFromStore, parseStoredConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { readEvents } from './events.ts';
import { inQueueChain, readRunsDocument, runHistoryIndicatesSession, writeRunsDocument } from './runs-document.ts';
import { leaseRun } from './runs-transitions.ts';
import type { QueuedEvent } from './events-parse.ts';
import type { ReferenceOrigin, Run, RunsDocument } from './runs-types.ts';

/** Holder recorded on a lease when the panel sent no `holder` parameter. */
export const UNKNOWN_HOLDER = 'unknown';

/** Longest `holder` the claim accepts; longer or malformed values fall back. */
const MAX_HOLDER_CHARS = 64;

/** Hex characters taken from a lease id's digest. */
const LEASE_ID_HEX_CHARS = 24;

/** The lease a claim issues, as the answer reports it (FR-030). */
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
export interface ClaimedReference {
    /** The joining delivery's unchanged id (FR-012). */
    readonly deliveryId: string;
    /** Trigger kind the delivery was detected under. */
    readonly kind: QueuedEvent['kind'];
    /** Where it matched: assignment, issue body, a comment id, or review. */
    readonly origin: ReferenceOrigin;
    /** Canonical link back to the source. */
    readonly sourceUrl: string;
    /** That delivery's detection stamp. */
    readonly detectedAt: string;
    /** Bounded trigger excerpt (≤600 characters as detected), transport only. */
    readonly excerpt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
}

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

/** One run the claim leased, with the lease the answer reports. */
export interface ClaimRecord {
    /** The run as it now stands in `runs.json`. */
    readonly run: Run;
    /** The lease issued for it. */
    readonly lease: ClaimedLease;
}

/** What one claim pass changed, in the order the caller must persist it. */
export interface ClaimOutcome {
    /** The document to persist, with every claimed run leased. */
    readonly document: RunsDocument;
    /** Runs the claim leased, oldest run first, each with its lease. */
    readonly claims: readonly ClaimRecord[];
}

/**
 * Read the claim's `holder` parameter, refusing anything unusable.
 *
 * The holder is informational (FR-030: authorization always rides the lease
 * id and, later, the token), so a malformed value is not an error — it is
 * recorded as {@link UNKNOWN_HOLDER} rather than trusted or reflected.
 *
 * @param raw - The query parameter as it arrived, or `undefined`.
 * @returns The holder to record, never empty and never over the bound.
 */
export function holderOf(raw: string | null): string {
    if (raw === null || raw.length === 0 || raw.length > MAX_HOLDER_CHARS || !/^[A-Za-z0-9._~-]+$/.test(raw)) {
        return UNKNOWN_HOLDER;
    }

    return raw;
}

/**
 * Mint one lease identifier.
 *
 * Minted, never re-derived: the run already holds the lease, and the operations
 * that need it (reserve) compare it to the stored value rather than
 * recomputing it. The issue stamp is part of the digest so a re-claim of the
 * same attempt after an expiry is a different lease, exactly as FR-030's "a
 * fresh lease" requires.
 *
 * @param input - The run, the attempt, and the RFC 3339 issue stamp.
 * @returns `lse-<24 hex characters>` — one path-safe segment.
 */
export function buildLeaseId(input: {
    /** The run being claimed. */
    readonly correlationId: string;
    /** Attempt the lease is issued under. */
    readonly attempt: number;
    /** RFC 3339 issue stamp. */
    readonly issuedAt: string;
}): string {
    const digest = createHash('sha256')
        .update(`${input.correlationId}|${input.attempt}|${input.issuedAt}`, 'utf8')
        .digest('hex')
        .slice(0, LEASE_ID_HEX_CHARS);

    return `lse-${digest}`;
}

/**
 * Project one reference for the claim answer.
 *
 * The excerpt lives on the delivery, not on the run (data-model §2.3), so a
 * reference whose delivery row is no longer retained answers with an empty
 * excerpt rather than a missing reference — the reference itself is the
 * durable record and always travels.
 *
 * @param input - The stored reference and the delivery rows it points at.
 * @returns The claim transport row.
 */
function claimedReference(input: {
    /** The stored source reference. */
    readonly reference: Run['sourceReferences'][number];
    /** Delivery rows keyed by id, as read from the queue. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
}): ClaimedReference {
    const { reference, deliveries } = input;

    return {
        deliveryId: reference.deliveryId,
        kind: reference.kind,
        origin: reference.origin,
        sourceUrl: reference.sourceUrl,
        detectedAt: reference.detectedAt,
        excerpt: deliveries.get(reference.deliveryId)?.issueBodyExcerpt ?? '',
        presentAtAuthorization: reference.presentAtAuthorization,
    };
}

/**
 * Index the queue by delivery id so each reference finds its excerpt.
 *
 * @param queue - Every row the queue still holds.
 * @returns The rows keyed by their deterministic delivery id.
 */
function deliveriesById(queue: readonly QueuedEvent[]): Map<string, QueuedEvent> {
    return new Map(queue.map((event) => [event.id, event]));
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

/** The members of a claim answer row that only the delivery rows can supply. */
interface DeliveryView {
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
}): DeliveryView {
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
 * reads, and the PR coordinates the trigger layer captured).
 *
 * @param input - The claimed run, its lease, and the delivery rows.
 * @returns The claim answer row; every member is credential-free.
 */
function claimedRunOf(input: {
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
        sourceReferences: run.sourceReferences.map((reference) => claimedReference({ reference, deliveries })),
        referenceCount: run.referenceCount,
        referencesNotRetained: run.referencesNotRetained,
        referencesTruncated: run.referencesTruncated,
        detectedAt: primary?.detectedAt ?? run.createdAt,
        ...deliveryView({ delivery, primary }),
    };
}

/**
 * Plan one claim pass over a document, without writing anything.
 *
 * Pure, so the route can read the document once, see exactly which runs this
 * call takes, and keep every exclusion a no-write decision.
 *
 * @param input - The document, the holder, the lease duration, and the stamp.
 * @returns The document to persist plus the claims to answer and audit.
 */
export function planClaim(input: {
    /** Document as stored, before this claim. */
    readonly document: RunsDocument;
    /** Opaque per-mount id taking every lease. */
    readonly holder: string;
    /** Lease duration in milliseconds (config `leaseMs`). */
    readonly leaseMs: number;
    /** Service-clock stamp for the whole batch. */
    readonly now: string;
}): ClaimOutcome {
    const claims: ClaimRecord[] = [];
    const runs = [...input.document.runs];

    for (const [index, run] of runs.entries()) {
        if (run.state !== 'pending' || runHistoryIndicatesSession(run)) {
            continue;
        }

        const expiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
        const leaseId = buildLeaseId({ correlationId: run.correlationId, attempt: run.attempt, issuedAt: input.now });
        const claimed = leaseRun({
            run,
            lease: { leaseId, holder: input.holder, issuedAt: input.now, expiresAt },
            now: input.now,
        });
        if (claimed === null) {
            continue;
        }

        runs[index] = claimed;
        claims.push({
            run: claimed,
            lease: {
                leaseId,
                attempt: claimed.attempt,
                holder: input.holder,
                issuedAt: input.now,
                expiresAt,
            },
        });
    }

    return { claims, document: { ...input.document, runs } };
}

/**
 * Read the effective lease duration, answering the default when unreadable.
 *
 * The duration is read before the chain task so a configuration the operator
 * cannot read cannot fail a claim: the default lease is a safe answer, and the
 * sweep reads the same field.
 *
 * @param store - Open store.
 * @param log - Logger used when the config file cannot be read.
 * @returns Milliseconds a claim's lease is valid for.
 */
async function readLeaseMs(store: ServiceStore, log: ServiceLogger): Promise<number> {
    try {
        const stored = await store.readJson(CONFIG_FILE, parseStoredConfig);

        return configFromStore(stored, log).leaseMs;
    } catch (cause) {
        log.warn('lease duration read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return DEFAULT_CONFIG.leaseMs;
    }
}

/** Append one `dispatch.claimed` row; a failure never undoes the lease. */
async function appendClaimAudit(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The claim to record. */
    readonly claim: ClaimRecord;
}): Promise<void> {
    try {
        await appendAudit(input.store, {
            eventType: 'dispatch.claimed',
            actorSource: 'panel',
            entity: { kind: 'run', id: input.claim.run.correlationId },
            correlationId: input.claim.run.correlationId,
            details: {
                leaseId: input.claim.lease.leaseId,
                attempt: input.claim.lease.attempt,
                leaseExpiry: input.claim.lease.expiresAt,
                sourceReferenceCount: input.claim.run.sourceReferences.length,
                holder: input.claim.lease.holder,
            },
        });
    } catch (cause) {
        input.log.warn('dispatch claim audit row could not be appended', {
            correlationId: input.claim.run.correlationId,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });
    }
}

/**
 * Claim every waiting run for one panel, in one atomic batch.
 *
 * The durable order is runs first, then the audit rows (FR-063): a failed
 * append never rolls back a lease the panel is already acting on, and the
 * failure is logged rather than thrown at the panel.
 *
 * @param input - Store, logger, the claim's holder, and an injectable stamp.
 * @returns One projection per run this call leased; `[]` when none was.
 * @throws {StorageUnavailableError} When the store cannot be read or written.
 */
export async function claimPendingRuns(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** Opaque per-mount id taking the leases. */
    readonly holder: string;
    /** Service-clock stamp for the batch; injectable so tests never sleep. */
    readonly now?: string;
}): Promise<readonly ClaimedRun[]> {
    const now = input.now ?? nowIso();
    const leaseMs = await readLeaseMs(input.store, input.log);

    const outcome = await inQueueChain(async () => {
        const document = await readRunsDocument(input);
        const planned = planClaim({ document, holder: input.holder, leaseMs, now });
        if (planned.claims.length === 0) {
            return { ...planned, deliveries: new Map<string, QueuedEvent>() };
        }

        const persisted = await writeRunsDocument({ ...input, document: planned.document });
        const queue = await readEvents(input);

        return { ...planned, document: persisted, deliveries: deliveriesById(queue) };
    });

    for (const claim of outcome.claims) {
        await appendClaimAudit({ store: input.store, log: input.log, claim });
    }

    return outcome.claims.map((claim) => claimedRunOf({ ...claim, deliveries: outcome.deliveries }));
}
