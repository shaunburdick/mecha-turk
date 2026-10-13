/**
 * The run claim: `GET /v1/events/pending` hands a panel every run waiting
 * for one, each under a fresh lease (003 FR-030, FR-031, FR-037;
 * [contracts/claim-lease.md](../../specs/003-dispatch-integrity/contracts/claim-lease.md)).
 */

import { createHash } from 'node:crypto';
import { nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import { CONFIG_FILE, DEFAULT_CONFIG, configFromStore, parseStoredConfig } from '../config.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { CLAIM_EVENTS_BUDGET_CHARS, MAX_CLAIMED_RUNS, measureEvents } from './claim-bounds.ts';
import { projectClaimedRun } from './claim-project.ts';
import { readEvents } from './events.ts';
import {
    inQueueChain,
    previewRunsDocument,
    readRunsDocument,
    runHistoryIndicatesSession,
    whenQueueIdle,
    writeRunsDocument,
} from './runs-document.ts';
import { leaseRun } from './runs-transitions.ts';
import type { ClaimedLease, ClaimedRun, ClaimRecord } from './claim-project.ts';
import type { QueuedEvent } from './events-parse.ts';
import type { Run, RunsDocument } from './runs-types.ts';

export type { ClaimedReference } from './claim-project.ts';
export type { ClaimedLease, ClaimedRun, ClaimRecord };

/** Holder recorded on a lease when the panel sent no `holder` parameter. */
export const UNKNOWN_HOLDER = 'unknown';

/** Longest `holder` the claim accepts; longer or malformed values fall back. */
const MAX_HOLDER_CHARS = 64;

/** Hex characters taken from a lease id's digest. */
const LEASE_ID_HEX_CHARS = 24;

/** What one claim pass changed, in the order the caller must persist it. */
export interface ClaimOutcome {
    /** The document to persist, with every claimed run leased. */
    readonly document: RunsDocument;
    /** Runs the claim leased, oldest run first, each with its lease. */
    readonly claims: readonly ClaimRecord[];
    /** Eligible runs this page left behind, still `pending` and claimable. */
    readonly deferred: number;
}

/** What {@link claimPendingRuns} hands the route. */
export interface ClaimResult {
    /** The runs this claim leased, bounded and credential-free. */
    readonly runs: readonly ClaimedRun[];
    /** How many eligible runs stayed claimable for the next call. */
    readonly deferred: number;
    /**
     * Whether every `dispatch.claimed` row reached the trail.
     *
     * `false` means the leases are durable and the rows are not — FR-063's
     * operator-visible surfacing, which used to have no mechanism outside the
     * result route and would otherwise be a silent gap in the trail.
     */
    readonly auditWritten: boolean;
}

/**
 * Read the claim's `holder` parameter, refusing anything unusable.
 *
 * The holder is informational (FR-030: authorization always rides the lease
 * id and, later, the token), so a malformed value is not an error — it is
 * recorded as {@link UNKNOWN_HOLDER} rather than trusted or reflected.
 *
 * @returns The holder to record, never empty and never over the bound.
 */
export function holderOf(raw: string | null): string {
    if (raw === null || raw.length === 0 || raw.length > MAX_HOLDER_CHARS || !/^[A-Za-z0-9._~-]+$/.test(raw)) {
        return UNKNOWN_HOLDER;
    }

    return raw;
}

/**
 * Mint one lease identifier — minted, never re-derived: the run already
 * holds the lease and reserve compares rather than recomputes it. The issue
 * stamp is part of the digest so a re-claim of the same attempt after an
 * expiry is a different lease, as FR-030's *a fresh lease* requires. It is a
 * fencing/consistency token and not a capability: it authorizes nothing (the
 * bearer token is the only authentication gate), and it is a deterministic
 * function of answer-visible inputs so an operator can recompute it from the
 * trail.
 */
export function buildLeaseId(input: {
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
 * Index the queue by delivery id so each reference finds its excerpt.
 */
function deliveriesById(queue: readonly QueuedEvent[]): Map<string, QueuedEvent> {
    return new Map(queue.map((event) => [event.id, event]));
}

/** Everything one claim pass needs to project and bound its answer. */
interface ClaimPlanInput {
    /** Document as stored, before this claim. */
    readonly document: RunsDocument;
    /** Opaque per-mount id taking every lease. */
    readonly holder: string;
    /** Lease duration in milliseconds (config `leaseMs`). */
    readonly leaseMs: number;
    /** Service-clock stamp for the whole batch. */
    readonly now: string;
    /** Delivery rows keyed by id, for the excerpt projection. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
    /** Most runs this page may offer. */
    readonly maxRuns: number;
    /** Most characters the projected `events` member may occupy. */
    readonly budgetChars: number;
}

/**
 * Project the next claimable run, without deciding whether it fits:
 * splitting this out is what makes the planner's bound honest — the
 * projection, including the lease the answer reports, is complete *before*
 * the byte budget is consulted, so a run the answer cannot carry is never
 * leased and never audited.
 */
function planOne(input: ClaimPlanInput, run: Run): ClaimRecord | null {
    const expiresAt = new Date(Date.parse(input.now) + input.leaseMs).toISOString();
    const leaseId = buildLeaseId({ correlationId: run.correlationId, attempt: run.attempt, issuedAt: input.now });
    const claimed = leaseRun({
        run,
        lease: { leaseId, holder: input.holder, issuedAt: input.now, expiresAt, provenance: 'panel' },
        now: input.now,
    });
    if (claimed === null) {
        return null;
    }

    const lease: ClaimedLease = {
        leaseId,
        attempt: claimed.attempt,
        holder: input.holder,
        issuedAt: input.now,
        expiresAt,
    };

    return { run: claimed, lease, claimed: projectClaimedRun({ run: claimed, lease, deliveries: input.deliveries }) };
}

/**
 * Plan one claim pass over a document, bounding the answer as it goes.
 * Pure, so the caller can project the whole page, measure it, and persist
 * nothing it cannot answer: runs are added in document order until one of
 * the documented bounds trips ({@link MAX_CLAIMED_RUNS} or the byte
 * budget), and every eligible run past that point is counted as deferred
 * rather than leased.
 */
export function planClaim(input: ClaimPlanInput): ClaimOutcome {
    const claims: ClaimRecord[] = [];
    const runs = [...input.document.runs];
    let eligible = 0;
    let deferred = 0;
    let used = measureEvents([]);

    for (const [index, run] of runs.entries()) {
        if (run.state !== 'pending' || runHistoryIndicatesSession(run)) {
            continue;
        }

        eligible += 1;
        const attempt = planOne(input, run);
        if (attempt === null) {
            deferred += 1;
            continue;
        }

        // `used` tracks the serialized `events` array with the same stringify the
        // transport performs, plus one comma per entry after the first, so a
        // page that fits here fits there.
        const cost = measureEvents([attempt.claimed]) + (claims.length > 0 ? 1 : 0);
        if (claims.length >= input.maxRuns || used + cost > input.budgetChars) {
            deferred += 1;
            continue;
        }

        used += cost;
        runs[index] = attempt.run;
        claims.push(attempt);
    }

    // `eligible` is the independent check on the tally: a run the transition
    // itself refused must not be counted as deferred (nothing is waiting behind
    // it), and one the budget excluded must be counted exactly once.
    return { claims, document: { ...input.document, runs }, deferred: Math.max(deferred, eligible - claims.length) };
}

/**
 * Whether any run in the document is waiting and therefore worth the chain: the same eligibility
 * rule the planner applies, read without projecting — this only decides whether a write is
 * needed, and the planner re-checks everything inside the chain before anything is leased.
 */
/**
 * Read the effective lease duration, answering the default when unreadable: the duration is read
 * before the chain task so a configuration the operator cannot read cannot fail a claim, and the
 * sweep reads the same field.
 */
async function readLeaseMs(store: ServiceStore, log: ServiceLogger): Promise<number> {
    try {
        const stored = await store.readJson(CONFIG_FILE, parseStoredConfig);

        return configFromStore(stored, log).config.leaseMs;
    } catch (cause) {
        log.warn('lease duration read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return DEFAULT_CONFIG.leaseMs;
    }
}

/** Append one `dispatch.claimed` row; a failure never undoes the lease. */
async function appendClaimAudit(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly claim: ClaimRecord;
}): Promise<boolean> {
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
                // The **retained** count, which is what the operator can verify
                // against the answer; `run.referenceCount` is the total. The
                // difference is only ever visible at the overflow marker.
                sourceReferenceCount: input.claim.claimed.sourceReferences.length,
                holder: input.claim.lease.holder,
            },
        });

        return true;
    } catch (cause) {
        input.log.warn('dispatch claim audit row could not be appended', {
            correlationId: input.claim.run.correlationId,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return false;
    }
}

/** Bounds one claim pass applies when the caller names none. */
const DEFAULT_CLAIM_BOUNDS = {
    /** Most runs one claim offers. */
    maxRuns: MAX_CLAIMED_RUNS,
    /** Most characters the projected `events` member may occupy. */
    budgetChars: CLAIM_EVENTS_BUDGET_CHARS,
} as const;

/**
 * Whether any run in the document is waiting and therefore worth the chain.
 *
 * The same eligibility rule the planner applies, read without projecting: this
 * only decides whether a write is needed, and the planner re-checks everything
 * inside the chain before anything is leased.
 */
function hasEligibleRun(document: RunsDocument): boolean {
    return document.runs.some((run) => run.state === 'pending' && !runHistoryIndicatesSession(run));
}

/**
 * Claim the waiting runs for one panel, in one bounded atomic batch. The
 * durable order is: peek the document **outside** the chain and return
 * immediately when nothing is claimable (T-040d), then take the chain,
 * re-read, re-plan, and write. Leases are durable before the audit rows,
 * which never roll back a lease the panel is already acting on; a row that
 * cannot be appended is reported as `auditWritten: false` rather than
 * swallowed.
 */
export async function claimPendingRuns(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** Opaque per-mount id taking the leases. */
    readonly holder: string;
    /** Service-clock stamp for the batch; injectable so tests never sleep. */
    readonly now?: string;
    /** Most runs to offer; the documented cap by default. */
    readonly maxRuns?: number;
    /** Most characters the projected `events` member may occupy. */
    readonly budgetChars?: number;
}): Promise<ClaimResult> {
    const now = input.now ?? nowIso();
    const maxRuns = input.maxRuns ?? DEFAULT_CLAIM_BOUNDS.maxRuns;
    const budgetChars = input.budgetChars ?? DEFAULT_CLAIM_BOUNDS.budgetChars;
    const leaseMs = await readLeaseMs(input.store, input.log);
    const deliveries = deliveriesById(await readEvents(input));

    // Outside the chain on purpose: a claim that finds nothing to lease must not
    // occupy the queue other writers are waiting on (T-040d). The chain is
    // drained *first*, so this snapshot is not one a queued enqueue is about to
    // invalidate — otherwise a claim racing a scan would report an empty queue
    // and make the panel wait a whole poll interval for work that was already
    // on its way in.
    await whenQueueIdle();
    const preview = await previewRunsDocument({ ...input, now });
    if (!hasEligibleRun(preview)) {
        return { runs: [], deferred: 0, auditWritten: true };
    }

    const outcome = await inQueueChain(async () => {
        const document = await readRunsDocument({ ...input, now });
        const planned = planClaim({ document, holder: input.holder, leaseMs, now, deliveries, maxRuns, budgetChars });
        if (planned.claims.length === 0) {
            return planned;
        }

        return { ...planned, document: await writeRunsDocument({ ...input, document: planned.document }) };
    });

    const written: boolean[] = [];
    for (const claim of outcome.claims) {
        written.push(await appendClaimAudit({ store: input.store, log: input.log, claim }));
    }

    return {
        runs: outcome.claims.map((claim) => claim.claimed),
        deferred: outcome.deferred,
        auditWritten: written.every(Boolean),
    };
}
