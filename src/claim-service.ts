/**
 * The claim and reserve answers the event relay reads (003 T-021, T-023).
 *
 * This surface used to live in `bindings-service.ts`, which is where it stopped
 * fitting: the binding and account readers are the Bindings tab's, and the claim
 * answer is the relay's — a run-shaped document with a lease, a bounded list of
 * source references, and its own counting members. Splitting them is the
 * module map AGENTS.md asks for (one responsibility per module) rather than a
 * move for its own sake, and every reader below keeps the same rule the old
 * home stated: parsing fails closed.
 *
 * **One unreadable run refuses the whole claim answer, deliberately.** A claim
 * that leases runs the panel then skips is worse than a claim the panel
 * refuses — the skipped leases expire, burn an attempt and a unit of the
 * automatic requeue budget, and the panel believed it had acted. The relay
 * surfaces an unreadable answer on its own line rather than dispatching none
 * of it in silence.
 *
 * Nothing here is credential-free by accident: the answer carries a lease (a
 * fencing token, never a capability) and, on reserve, the single-use dispatch
 * token — an authorization artifact, not a credential, which is why
 * `SECRET_PATTERNS` deliberately does not cover `dtk-` (research §R3).
 */

import { readClaimPrompt } from './prompt-wire.ts';
import { asRecord, fieldsHoldText, parseJsonObject, textOrEmpty, textOrNull } from './json.ts';
import type { PromptSource } from './prompt.ts';
import type { BindingStatusRow, EventKind } from './bindings-service.ts';
import { eventKindOf, readStatusRows } from './bindings-service.ts';

/** Whether the subject is an issue or a pull request (run key component). */
export type SubjectType = 'issue' | 'pull_request';

/**
 * The lease a claim issues, as the answer reports it.
 *
 * The lease is a **fencing/consistency token, not a capability**: holding the
 * id authorizes nothing (the service's bearer token is the only authentication
 * gate) and the single-use dispatch token is the only authorization to start a
 * session. It is what proves the service handed this run to
 * this panel — the guard keys off it, not off `state`, because `state` only
 * says the run was *offered*.
 */
export interface ClaimedLease {
    /** Lease identifier echoed on reserve and block report. */
    readonly leaseId: string;
    /** Attempt the lease is issued under (the run's current attempt). */
    readonly attempt: number;
    /** Opaque per-mount id of the panel holding it; informational only. */
    readonly holder: string;
    /** RFC 3339 issue stamp (service clock). */
    readonly issuedAt: string;
    /** RFC 3339 expiry stamp; the sweep reclaims exactly here. */
    readonly expiresAt: string;
}

/** One retained source reference as the claim answer carries it. */
export interface ClaimedReference {
    /** The joining delivery's unchanged id (FR-012). */
    readonly deliveryId: string;
    /** Trigger kind the reference was detected under. */
    readonly kind: EventKind;
    /** Where it matched: `assignment`, `body`, `comment:<id>`, or `review`. */
    readonly origin: string;
    /** Canonical link back to the source. */
    readonly sourceUrl: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** Bounded trigger excerpt, or an explicit marker when it was not carried. */
    readonly excerpt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
}

/** One run the service offered in the claimed state (contract `claim-lease.md`). */
export interface ClaimedRun {
    /** Run identity on the wire; every later call is addressed by it. */
    readonly correlationId: string;
    /** FR-010's human-readable tuple, shown beside the correlation id. */
    readonly runKey: string;
    /** 0-based ordinal of this run for its subject. */
    readonly ordinal: number;
    /** Attempt this lease is issued under. */
    readonly attempt: number;
    /** The claim itself; its absence refuses the run. */
    readonly lease: ClaimedLease;
    /** The state the run was **offered** in — always `pending`. */
    readonly state: 'pending';
    /** Why the run was waiting, rendered as the row's reason line (FR-074). */
    readonly stateReason: string;
    /** Binding the run dispatches through. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** Login of the account this run is answered under; may be empty. */
    readonly accountLogin: string;
    /** Target project, snapshotted at enqueue. */
    readonly projectId: string;
    /** Worktree option, snapshotted at enqueue. */
    readonly worktreeOption: string;
    /** Whether the subject is an issue or a pull request. */
    readonly subjectType: SubjectType;
    /** Issue or pull request number. */
    readonly issueNumber: number;
    /** Issue title; untrusted source text, copied verbatim. */
    readonly issueTitle: string;
    /** Canonical issue URL; may be empty when the delivery row is gone. */
    readonly issueUrl: string;
    /** Head SHA of a review-origin pull request; `null` on every other kind. */
    readonly headSha: string | null;
    /** Base ref of that pull request; `null` on every other kind. */
    readonly baseRef: string | null;
    /** `= correlationId`; what `startSession().id` is built from. */
    readonly attachmentId: string;
    /** Every retained reference, in join order, with FR-013's full detail. */
    readonly sourceReferences: readonly ClaimedReference[];
    /** How many triggers joined the run, retained or not. */
    readonly referenceCount: number;
    /** How many joining triggers the cap kept off the list. */
    readonly referencesNotRetained: number;
    /** Whether the reference list was cut at the cap. */
    readonly referencesTruncated: boolean;
    /** Primary subject excerpt (the field the context builder already reads). */
    readonly issueBodyExcerpt: string;
    /** Earliest source reference's detection stamp (row age). */
    readonly detectedAt: string;
    /** Whether the run queued with a starting prompt. */
    readonly promptPresent: boolean;
    /** Its `mtp-…` fingerprint, or `null` when none. */
    readonly promptFingerprint: string | null;
    /** Code points of the normalised text, or `null` when none. */
    readonly promptLength: number | null;
    /**
     * Tiers that produced the block, most general first, or `null` when none:
     * a duplicate-free subsequence of `global, account, binding`.
     *
     * Read by the same closed reader as the other three members, so a list the
     * build cannot stand behind refuses the run — never a defaulted source.
     */
    readonly promptSources: readonly PromptSource[] | null;
    /**
     * The text the composition fences — **claim transport only**.
     *
     * Carried exactly like `sourceReferences[].excerpt`: so the panel can
     * build the message, never so a surface can display it. The panel never
     * writes it anywhere.
     */
    readonly promptText: string | null;
}


/** One claim answer after the parse (contract `claim-lease.md` §Response). */
export interface ClaimAnswer {
    /** The runs this panel now owns, each under a fresh lease. */
    readonly runs: readonly ClaimedRun[];
    /** Per-binding scan status; `pendingCount` is the honest "more is waiting". */
    readonly status: readonly BindingStatusRow[];
    /** FR-063: did every `dispatch.claimed` row reach the trail? */
    readonly auditWritten: boolean;
}

/** What one reserve answered with (contract `dispatch-authorization.md` §1). */
export interface ReserveAnswer {
    /** Echo of the run the path named. */
    readonly correlationId: string;
    /** Attempt the reservation was made under. */
    readonly attempt: number;
    /** The single-use authorization the result report presents. */
    readonly dispatchToken: string;
    /** RFC 3339 stamp of the lease the reservation was made under. */
    readonly tokenExpiresAt: string | null;
    /** RFC 3339 moment the sweep would wedge the run (T-043d, additive). */
    readonly resultDeadlineAt: string | null;
    /** The run's state after the reservation; always `starting`. */
    readonly state: string;
    /** FR-063: did the `dispatch.reserved` row reach the trail? */
    readonly auditWritten: boolean;
}

/** The single-use token's minted shape — the same rule the service validates. */
const DISPATCH_TOKEN_PATTERN = /^dtk-[0-9a-f]{32}$/;

/** String members every claimed run must carry as non-empty text. */
const CLAIMED_RUN_STRING_FIELDS = [
    'correlationId',
    'runKey',
    'stateReason',
    'bindingId',
    'repository',
    'projectId',
    'worktreeOption',
    'attachmentId',
    'detectedAt',
    'issueTitle',
] as const;

/** Members of one reference the claim answer must carry as non-empty text. */
const REFERENCE_STRING_FIELDS = ['deliveryId', 'origin', 'sourceUrl', 'detectedAt'] as const;

/**
 * Read one finite integer member.
 *
 * @returns The value, or `null` when it is missing or not a number.
 */
function readInteger(record: Record<string, unknown>, field: string): number | null {
    const value = record[field];

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Bound one already-read number below, refusing a fractional value.
 *
 * @returns The value, or `null` when it is missing, fractional, or too small.
 */
function atLeast(value: number | null, min: number): number | null {
    if (value === null || !Number.isSafeInteger(value) || value < min) {
        return null;
    }

    return value;
}

/**
 * Read the claim's lease, which is what proves the service handed the run over.
 *
 * A run the answer does not lease is a run the panel must not dispatch,
 * so an absent or malformed lease refuses the row rather than being
 * defaulted — the guard keys off this member, never off `state`.
 *
 * @returns The lease, or `null`.
 */
function parseLease(value: unknown): ClaimedLease | null {
    const record = asRecord(value);
    if (record === null || !fieldsHoldText(record, ['leaseId', 'holder', 'issuedAt', 'expiresAt'])) {
        return null;
    }

    const attempt = atLeast(readInteger(record, 'attempt'), 1);
    if (attempt === null) {
        return null;
    }

    const { leaseId, holder, issuedAt, expiresAt } = record;

    return {
        leaseId: leaseId as string,
        attempt,
        holder: holder as string,
        issuedAt: issuedAt as string,
        expiresAt: expiresAt as string,
    };
}

/**
 * Read one retained source reference off the claim answer.
 *
 * @returns The reference, or `null` when its shape is unusable.
 */
function parseClaimReference(value: unknown): ClaimedReference | null {
    const record = asRecord(value);
    if (
        record === null ||
        !fieldsHoldText(record, REFERENCE_STRING_FIELDS) ||
        typeof record.excerpt !== 'string' ||
        typeof record.presentAtAuthorization !== 'boolean'
    ) {
        return null;
    }

    const { deliveryId, origin, sourceUrl, detectedAt } = record;

    return {
        deliveryId: deliveryId as string,
        kind: eventKindOf(record.kind),
        origin: origin as string,
        sourceUrl: sourceUrl as string,
        detectedAt: detectedAt as string,
        excerpt: record.excerpt,
        presentAtAuthorization: record.presentAtAuthorization,
    };
}

/**
 * Read the `sourceReferences` list, or `null` when any element is unusable.
 *
 * @returns The references, or `null`.
 */
function parseClaimReferences(value: unknown): ClaimedReference[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const references: ClaimedReference[] = [];
    for (const entry of value) {
        const reference = parseClaimReference(entry);
        if (reference === null) {
            return null;
        }

        references.push(reference);
    }

    return references;
}

/**
 * Check the answer's three reference-counting members against each other.
 *
 * @returns `true` when they reconcile.
 */
function claimCountsReconcile(counts: ClaimNumbers, retained: number): boolean {
    if (counts.referenceCount !== retained + counts.referencesNotRetained) {
        return false;
    }

    return counts.referencesTruncated === counts.referencesNotRetained > 0;
}

/** The identity members of one offered run, read as one step. */
type ClaimScalars = Pick<
    ClaimedRun,
    | 'correlationId'
    | 'runKey'
    | 'stateReason'
    | 'bindingId'
    | 'repository'
    | 'projectId'
    | 'worktreeOption'
    | 'attachmentId'
    | 'detectedAt'
    | 'issueTitle'
>;

/** The counting members of one offered run. */
type ClaimNumbers = Pick<
    ClaimedRun,
    'ordinal' | 'attempt' | 'referenceCount' | 'referencesNotRetained' | 'referencesTruncated'
>;

/** The subject coordinates of one offered run. */
type ClaimSubject = Pick<ClaimedRun, 'subjectType' | 'issueNumber' | 'headSha' | 'baseRef'>;

/**
 * Read the identity members of one offered run.
 *
 * @returns The members, or `null` when any is missing, not a string, or empty.
 */
function readClaimScalars(record: Record<string, unknown>): ClaimScalars | null {
    if (!fieldsHoldText(record, CLAIMED_RUN_STRING_FIELDS)) {
        return null;
    }

    const {
        correlationId, runKey, stateReason, bindingId, repository,
        projectId, worktreeOption, attachmentId, detectedAt, issueTitle,
    } = record;

    return {
        correlationId: correlationId as string,
        runKey: runKey as string,
        stateReason: stateReason as string,
        bindingId: bindingId as string,
        repository: repository as string,
        projectId: projectId as string,
        worktreeOption: worktreeOption as string,
        attachmentId: attachmentId as string,
        detectedAt: detectedAt as string,
        issueTitle: issueTitle as string,
    };
}

/**
 * Read the counting members of one offered run.
 *
 * @returns The members, or `null` when any is missing, fractional, or out of bounds.
 */
function readClaimNumbers(record: Record<string, unknown>): ClaimNumbers | null {
    const ordinal = atLeast(readInteger(record, 'ordinal'), 0);
    const attempt = atLeast(readInteger(record, 'attempt'), 1);
    const referenceCount = atLeast(readInteger(record, 'referenceCount'), 0);
    const referencesNotRetained = atLeast(readInteger(record, 'referencesNotRetained'), 0);
    const { referencesTruncated } = record;
    if (
        ordinal === null ||
        attempt === null ||
        referenceCount === null ||
        referencesNotRetained === null ||
        typeof referencesTruncated !== 'boolean'
    ) {
        return null;
    }

    return { ordinal, attempt, referenceCount, referencesNotRetained, referencesTruncated };
}

/**
 * Read the subject coordinates of one offered run.
 *
 * An absent `headSha`/`baseRef` reads as `null`, exactly as the runs history
 * normalizes it: for the panel the two are the same fact, and the run-key
 * component that matters (`subjectType`) is refused rather than defaulted.
 *
 * @returns The members, or `null` when the subject cannot be identified.
 */
function readClaimSubject(record: Record<string, unknown>): ClaimSubject | null {
    const issueNumber = atLeast(readInteger(record, 'issueNumber'), 1);
    const { subjectType } = record;
    if (issueNumber === null || subjectType !== 'issue' && subjectType !== 'pull_request') {
        return null;
    }

    const headSha = typeof record.headSha === 'string' && record.headSha !== '' ? record.headSha : null;
    const baseRef = typeof record.baseRef === 'string' && record.baseRef !== '' ? record.baseRef : null;

    return { subjectType, issueNumber, headSha, baseRef };
}

/**
 * Parse one offered run.
 *
 * Each group is read by its own named step, and the offer is only assembled
 * once every step agreed — so a half-readable offer is a refused offer, never
 * a partially applied one (AGENTS invariant 8).
 *
 * @returns The run, or `null` when its shape is unusable.
 */
function parseClaimedRun(value: unknown): ClaimedRun | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const scalars = readClaimScalars(record);
    const numbers = readClaimNumbers(record);
    const subject = readClaimSubject(record);
    const lease = parseLease(record.lease);
    const references = parseClaimReferences(record.sourceReferences);
    const prompt = readClaimPrompt(record);
    if (
        scalars === null
        || numbers === null
        || subject === null
        || lease === null
        || references === null
        || prompt === null
        || record.state !== 'pending'
        || !claimCountsReconcile(numbers, references.length)
    ) {
        return null;
    }

    return {
        ...scalars,
        ...numbers,
        ...subject,
        lease,
        state: 'pending',
        accountLogin: textOrEmpty(record, 'accountLogin'),
        issueUrl: textOrEmpty(record, 'issueUrl'),
        issueBodyExcerpt: textOrEmpty(record, 'issueBodyExcerpt'),
        sourceReferences: references,
        ...prompt,
    };
}


/**
 * Parse the claim answer (`GET /v1/events/pending`).
 *
 * Strict, and deliberately so: one unreadable run refuses the whole answer.
 * A claim that leases runs the panel then skips is worse than a claim the
 * panel refuses — the skipped leases expire, burn an attempt and a unit of the
 * automatic requeue budget, and the panel believed it had acted. The caller
 * surfaces an unreadable answer on its own line rather than dispatching none
 * of it in silence.
 *
 * `auditWritten` is additive: absent reads as `false`, so a build that
 * does not send it reports a degraded trail rather than claiming one it cannot
 * prove — a member that is present but not a boolean refuses the body.
 *
 * @returns The claim answer, or `null` when the shape is unusable.
 */
export function parsePendingBody(text: string): ClaimAnswer | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.events)) {
        return null;
    }

    const runs: ClaimedRun[] = [];
    for (const entry of root.events) {
        const run = parseClaimedRun(entry);
        if (run === null) {
            return null;
        }

        runs.push(run);
    }

    if ('auditWritten' in root && typeof root.auditWritten !== 'boolean') {
        return null;
    }

    const status = Array.isArray(root.status) ? root.status : [];

    return { runs, status: readStatusRows(status), auditWritten: root.auditWritten === true };
}

/**
 * Parse the reserve answer (`POST /v1/events/:correlationId/reserve`).
 *
 * Both deadlines ride beside the token (contract §1, T-043d): `tokenExpiresAt`
 * is the lease the reservation was made under and `resultDeadlineAt` is when
 * the sweep would wedge the run. Neither is a reason to skip the result report
 * — the authorization outlives the lease — so this reader accepts both and
 * gates on nothing but the token itself.
 *
 * @returns The answer, or `null` when the shape is unusable.
 */
export function parseReserveBody(text: string): ReserveAnswer | null {
    const root = parseJsonObject(text);
    if (root === null || !fieldsHoldText(root, ['correlationId', 'dispatchToken', 'state'])) {
        return null;
    }

    const attempt = atLeast(readInteger(root, 'attempt'), 1);
    if (
        attempt === null ||
        !DISPATCH_TOKEN_PATTERN.test(root.dispatchToken as string) ||
        'auditWritten' in root && typeof root.auditWritten !== 'boolean'
    ) {
        return null;
    }

    return {
        correlationId: root.correlationId as string,
        attempt,
        dispatchToken: root.dispatchToken as string,
        tokenExpiresAt: textOrNull(root, 'tokenExpiresAt'),
        resultDeadlineAt: textOrNull(root, 'resultDeadlineAt'),
        state: root.state as string,
        auditWritten: root.auditWritten === true,
    };
}
