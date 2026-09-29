/**
 * Validators for the sub-objects a run row carries (003 data-model §2.3–§2.5).
 *
 * A run row is mostly scalars, but four lifecycle sub-objects and two lists
 * each carry their own vocabulary: the source references a delivery joined
 * with, the recorded attempt history, and the nullable lease, reservation,
 * session, and verification the dispatch model hangs off a run. Those live
 * apart from `runs-parse.ts` (document + row orchestration) purely because
 * the file-length gate will not hold types, sub-validators, and the document
 * validator in one file — this is the same contract, read side.
 *
 * Everything here is fail-closed like the rest of the read path: a present
 * value that cannot be understood answers `null`, and the row parser turns
 * that into a refused row rather than a partially trusted one.
 */

import { isRecord, readFlag, readPositiveInt, readStamp, readString, readText } from '../json.ts';
import type { EventKind } from './events-parse.ts';
import type {
    DispatchAttempt,
    ReferenceOrigin,
    RunLease,
    RunReservation,
    SessionRef,
    SourceReference,
    RunVerification,
} from './runs-types.ts';

/** Trigger kinds a source reference may carry. */
const EVENT_KINDS: ReadonlySet<string> = new Set(['assignment', 'mention', 'review']);

/** Outcomes a recorded attempt may carry, plus "still in flight". */
const ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
    'dispatched',
    'failed',
    'abandoned',
    'expired',
    'blocked',
    'unconfirmed',
]);
/**
 * Narrow a value to a trigger kind.
 *
 * @param value - Candidate kind.
 * @returns `true` for the three documented kinds.
 */
function isEventKind(value: unknown): value is EventKind {
    return typeof value === 'string' && EVENT_KINDS.has(value);
}
/**
 * Narrow a value to a reference origin.
 *
 * @param origin - Candidate origin string.
 * @returns `true` for the four documented shapes, including `comment:<id>`.
 */
function isValidOrigin(origin: string): origin is ReferenceOrigin {
    return origin === 'assignment' || origin === 'body' || origin === 'review'
        || /^comment:[1-9][0-9]*$/.test(origin);
}

/**
 * Narrow a value to an attempt outcome (`null` while in flight).
 *
 * @param value - Candidate outcome.
 * @returns `true` for `null` or one of the documented outcomes.
 */
function isOutcome(value: unknown): value is DispatchAttempt['outcome'] {
    return value === null || (typeof value === 'string' && ATTEMPT_OUTCOMES.has(value));
}

/**
 * Validate the reference sub-object.
 *
 * @param raw - Candidate value.
 * @returns The reference, or `null` when any field is missing or malformed.
 */
export function parseReference(raw: unknown): SourceReference | null {
    if (!isRecord(raw)) {
        return null;
    }

    const deliveryId = readText(raw.deliveryId);
    const sourceUrl = readText(raw.sourceUrl);
    const detectedAt = readStamp(raw.detectedAt);
    const { kind, origin } = raw;
    const present = readFlag(raw.presentAtAuthorization);
    if (
        deliveryId === null || sourceUrl === null || detectedAt === null || present === null
        || !isEventKind(kind) || typeof origin !== 'string' || !isValidOrigin(origin)
    ) {
        return null;
    }

    return { deliveryId, kind, origin, sourceUrl, detectedAt, presentAtAuthorization: present };
}

/**
 * Validate one recorded attempt.
 *
 * @param raw - Candidate value.
 * @returns The attempt record, or `null` when malformed.
 */
export function parseAttempt(raw: unknown): DispatchAttempt | null {
    if (!isRecord(raw)) {
        return null;
    }

    const attempt = readPositiveInt(raw.attempt);
    const { outcome, reservedAt, sessionId, reason } = raw;
    const token = raw.dispatchToken;
    const reportedAt = raw.resultReportedAt;
    const nullable = [token, reservedAt, sessionId, reason, reportedAt];
    if (
        attempt === null || nullable.some((value) => value !== null && typeof value !== 'string')
        || !isOutcome(outcome)
    ) {
        return null;
    }

    return {
        attempt,
        dispatchToken: token as string | null,
        reservedAt: reservedAt as string | null,
        outcome,
        sessionId: sessionId as string | null,
        reason: reason as string | null,
        resultReportedAt: reportedAt as string | null,
    };
}

/**
 * Validate a lease identifier against the two shapes this build mints.
 *
 * Fail-closed on purpose: the identifier is a coordination token, so accepting
 * any non-empty string would let a stored value this build could never have
 * written decide the sweep's migration-recovery accounting. A panel claim
 * mints `lse-<24 hex>`; adoption mints `migration-<correlation id>`.
 *
 * @param leaseId - Candidate identifier.
 * @returns The identifier, or `null` when it is neither legal shape.
 */
function readLeaseId(leaseId: unknown): string | null {
    const value = readText(leaseId);
    if (value === null) {
        return null;
    }

    return /^lse-[0-9a-f]{24}$/.test(value) || /^migration-mt-run-[0-9a-f]{24}$/.test(value) ? value : null;
}

/**
 * Validate the lease sub-object, including its typed provenance.
 *
 * @param raw - Candidate value.
 * @returns The lease, or `null` when malformed.
 */
export function parseLease(raw: unknown): RunLease | null {
    if (!isRecord(raw)) {
        return null;
    }

    const { leaseId, holder, attempt, issuedAt, expiresAt, provenance } = raw;
    const values = [
        readLeaseId(leaseId),
        readText(holder),
        readPositiveInt(attempt),
        readStamp(issuedAt),
        readStamp(expiresAt),
    ];
    const source = provenance === 'panel' || provenance === 'migration' ? provenance : null;
    if (values.includes(null) || source === null) {
        return null;
    }

    return {
        leaseId: values[0] as string,
        holder: holder as string,
        attempt: attempt as number,
        issuedAt: issuedAt as string,
        expiresAt: expiresAt as string,
        provenance: source,
    };
}

/**
 * Validate the reservation sub-object.
 *
 * @param raw - Candidate value.
 * @returns The reservation, or `null` when malformed.
 */
export function parseReservation(raw: unknown): RunReservation | null {
    if (!isRecord(raw)) {
        return null;
    }

    const { dispatchToken, attempt, reservedAt, consumed } = raw;
    const deadline = raw.resultDeadlineAt;
    const values = [readText(dispatchToken), readPositiveInt(attempt), readStamp(reservedAt), readStamp(deadline)];
    const flag = readFlag(consumed);
    if (values.includes(null) || flag === null) {
        return null;
    }

    return {
        dispatchToken: dispatchToken as string,
        attempt: attempt as number,
        reservedAt: reservedAt as string,
        resultDeadlineAt: deadline as string,
        consumed: flag,
    };
}

/**
 * Validate one worktree pointer.
 *
 * @param raw - Candidate value.
 * @returns The worktree, or `null` when it carries no directory and branch.
 */
function parseWorktree(raw: unknown): { readonly directory: string; readonly branch: string } | null {
    if (!isRecord(raw)) {
        return null;
    }

    const directory = readText(raw.directory);
    const branch = readText(raw.branch);

    return directory === null || branch === null ? null : { directory, branch };
}

/**
 * Validate the session reference, including its optional worktree.
 *
 * @param raw - Candidate value.
 * @returns The session ref, or `null` when malformed.
 */
export function parseSession(raw: unknown): SessionRef | null {
    if (!isRecord(raw)) {
        return null;
    }

    const { sessionId, attachmentId, dispatchedAt, title, sourceUrl } = raw;
    const id = readText(sessionId);
    const attachment = readText(attachmentId);
    const stamped = readStamp(dispatchedAt);
    const heading = readString(title);
    const link = readString(sourceUrl);
    if (id === null || attachment === null || stamped === null || heading === null || link === null) {
        return null;
    }

    if (raw.worktree === null) {
        return {
            sessionId: id,
            attachmentId: attachment,
            dispatchedAt: stamped,
            title: heading,
            sourceUrl: link,
            worktree: null,
        };
    }

    const worktree = parseWorktree(raw.worktree);

    return worktree === null
        ? null
        : { sessionId: id, attachmentId: attachment, dispatchedAt: stamped, title: heading, sourceUrl: link, worktree };
}

/**
 * Validate the recorded verification outcome.
 *
 * @param raw - Candidate value.
 * @returns The verification, or `null` when malformed.
 */
export function parseVerification(raw: unknown): RunVerification | null {
    if (!isRecord(raw)) {
        return null;
    }

    const { expectedAgent, ok, at, observedAgent, note } = raw;
    const agent = readText(expectedAgent);
    const matched = readFlag(ok);
    const stamped = readStamp(at);
    if (
        agent === null || matched === null || stamped === null
        || (observedAgent !== null && typeof observedAgent !== 'string')
        || (note !== null && typeof note !== 'string')
    ) {
        return null;
    }

    return { observedAgent, expectedAgent: agent, ok: matched, note, at: stamped };
}
