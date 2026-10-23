/**
 * Validators for the sub-objects a run row carries (003 data-model §2.3–§2.5).
 */

import { isRecord, readCount, readFlag, readPositiveInt, readStamp, readString, readText } from '../json.ts';
import { actorFieldsOf, readActorAttributionField, readActorLoginField } from './attribution.ts';
import type { EventKind } from './events-parse.ts';
import type {
    ChecksVerdict,
    ChecksWatch,
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
 */
function isEventKind(value: unknown): value is EventKind {
    return typeof value === 'string' && EVENT_KINDS.has(value);
}
/**
 * Narrow a value to a reference origin.
 */
function isValidOrigin(origin: string): origin is ReferenceOrigin {
    return origin === 'assignment' || origin === 'body' || origin === 'review'
        || /^comment:[1-9][0-9]*$/.test(origin)
        || /^review-comment:[1-9][0-9]*$/.test(origin);
}

/**
 * Narrow a value to an attempt outcome (`null` while in flight).
 */
function isOutcome(value: unknown): value is DispatchAttempt['outcome'] {
    return value === null || (typeof value === 'string' && ATTEMPT_OUTCOMES.has(value));
}

/**
 * Validate the reference sub-object. The two actor members are **absentable
 * and validated when present** (002 FR-043, FR-044): a run stored before
 * attribution existed carries neither and must still parse, because refusing
 * it would quarantine a perfectly readable document; a present member must
 * be usable — an unrecognized basis refuses the reference rather than
 * defaulting to a guess, which is what makes the run unreadable rather than
 * silently unattributed.
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
    const isUnusable = [
        deliveryId, sourceUrl, detectedAt, present,
        readActorLoginField(raw), readActorAttributionField(raw),
    ].includes(null)
        || !isEventKind(kind)
        || typeof origin !== 'string'
        || !isValidOrigin(origin);
    if (isUnusable || deliveryId === null || sourceUrl === null || detectedAt === null || present === null) {
        return null;
    }

    return {
        deliveryId,
        kind,
        origin,
        sourceUrl,
        detectedAt,
        presentAtAuthorization: present,
        ...actorFieldsOf(raw),
    };
}

/**
 * Validate one recorded attempt.
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
    if (source === null || values.includes(null)) {
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
 */
export function parseReservation(raw: unknown): RunReservation | null {
    if (!isRecord(raw)) {
        return null;
    }

    const { dispatchToken, attempt, reservedAt, consumed } = raw;
    const deadline = raw.resultDeadlineAt;
    const values = [readText(dispatchToken), readPositiveInt(attempt), readStamp(reservedAt), readStamp(deadline)];
    const flag = readFlag(consumed);
    if (flag === null || values.includes(null)) {
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
 */
function parseWorktree(raw: unknown): { readonly directory: string; readonly branch: string } | null {
    if (!isRecord(raw)) {
        return null;
    }

    const directory = readText(raw.directory);
    const branch = readText(raw.branch);

    return directory === null || branch === null ? null : { directory, branch };
}

// Read fail-safe: absent, `null`, or non-string all read as *absent* — a fixed-shape
// destructure would drop the key on re-read; one optional member must not quarantine the document.
function directoryFieldOf(raw: Record<string, unknown>): { readonly directory?: string } {
    const reported = readString(raw.directory);

    return reported === null || reported === '' ? {} : { directory: reported };
}

/**
 * Validate the session reference, including its optional worktree.
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

    const directory = directoryFieldOf(raw);

    if (raw.worktree === null) {
        return {
            sessionId: id,
            attachmentId: attachment,
            dispatchedAt: stamped,
            title: heading,
            sourceUrl: link,
            worktree: null,
            ...directory,
        };
    }

    const worktree = parseWorktree(raw.worktree);

    return worktree === null
        ? null
        : {
            sessionId: id,
            attachmentId: attachment,
            dispatchedAt: stamped,
            title: heading,
            sourceUrl: link,
            worktree,
            ...directory,
        };
}

/** The five words a stored watch verdict may carry (FR-126). */
const CHECKS_VERDICTS: ReadonlySet<string> = new Set(['watching', 'passed', 'failed', 'expired', 'none']);

/**
 * Narrow a value to a stored verdict.
 */
function isChecksVerdict(value: unknown): value is ChecksVerdict {
    return typeof value === 'string' && CHECKS_VERDICTS.has(value);
}

/**
 * Validate one recorded check watch.
 *
 * Absent is *no watch*; a present value that cannot be read refuses the run,
 * because a watch this build cannot trust must not decide whether a red suite
 * is still unseen (FR-126, constitution II). `verdict` is required — a watch
 * was never written without it.
 */
export function parseChecksWatch(raw: unknown): ChecksWatch | undefined | null {
    if (raw === undefined) {
        return undefined;
    }

    if (!isRecord(raw)) {
        return null;
    }

    const headSha = readText(raw.headSha);
    const armedAt = readStamp(raw.armedAt);
    const polls = readCount(raw.polls);
    const { verdict } = raw;
    if (
        headSha === null || armedAt === null || polls === null
        || !/^[0-9a-f]+$/.test(headSha)
        || !isChecksVerdict(verdict)
    ) {
        return null;
    }

    return { headSha, armedAt, polls, verdict };
}

/**
 * Validate the recorded verification outcome.
 *
 * `expectedAgent` is read as a **string** rather than as non-empty text: a
 * blank value is the documented *no baseline configured* a read-back against
 * an unpinned baseline records (002 FR-029 as amended), and a run document
 * must never be quarantined over it.
 */
export function parseVerification(raw: unknown): RunVerification | null {
    if (!isRecord(raw)) {
        return null;
    }

    const { expectedAgent, ok, at, observedAgent, note } = raw;
    const agent = readString(expectedAgent);
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
