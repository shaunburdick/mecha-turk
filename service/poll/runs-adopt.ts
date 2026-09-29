/**
 * One-shot, non-destructive projection of the shipped queue into runs
 * (003 FR-005, NFR-103; data-model §1).
 *
 * Legacy delivery rows are read through their validator and never rewritten.
 * Open rows for the same subject coalesce during adoption; rows that already
 * report a session each retain a separate terminal run so historical work is
 * never mistaken for work that can safely be started again.
 */

import { nowIso } from '../../src/ids.ts';
import { DEFAULT_CONFIG } from '../config.ts';
import type { ServiceStore } from '../store/index.ts';
import { EVENTS_FILE, parseStoredEvent, subjectTypeOf } from './events-parse.ts';
import type { QueuedEvent } from './events-parse.ts';
import { buildAttachmentId, buildCorrelationId, buildDispatchToken, buildRunKey, buildSubjectKey } from './run-key.ts';
import { referenceOf, joinReference } from './runs-join.ts';
import { RUNS_SCHEMA_VERSION } from './runs-parse.ts';
import type {
    DispatchAttempt,
    Run,
    RunAuditIntent,
    RunLease,
    RunReservation,
    RunState,
    RunsDocument,
    SourceReference,
} from './runs-types.ts';

/** Legacy problem strings emitted by the shipped panel's closed vocabulary. */
const LEGACY_PROBLEMS = new Set([
    'binding-missing-at-dispatch',
    'no-session',
    'bootstrap-failed',
    'session-create-failed',
    'projects snapshot reported state "error"',
]);

/** The result deadline an adopted reservation is armed with (T-008's default). */
const RESULT_DEADLINE_MS = DEFAULT_CONFIG.resultDeadlineMs;

/** Prefix every synthetic adoption lease identifier carries (data-model §1). */
export const MIGRATION_LEASE_PREFIX = 'migration-';

/** Holder recorded on a synthetic adoption lease. */
const MIGRATION_HOLDER = 'migration';

/**
 * Mint the synthetic lease an adopted `in-flight` row is recovered under.
 *
 * The identifier is a **fencing/consistency token, not a capability**: it
 * authorizes nothing, and the service's bearer token is the only authentication
 * gate. It is a deterministic function of answer-visible inputs (the run's
 * correlation id), which is what makes it re-derivable; provenance travels as
 * the typed {@link RunLease} member beside it rather than as this prefix, so
 * `parseLease` can enforce the two legal shapes.
 *
 * @param correlationId - The adopted run's correlation id.
 * @returns `migration-<correlationId>` — one path-safe segment.
 */
export function buildMigrationLeaseId(correlationId: string): string {
    return `${MIGRATION_LEASE_PREFIX}${correlationId}`;
}

/** Input needed to build a migration plan without mutating legacy rows. */
export interface AdoptionPlanInput {
    /** Store holding `events.json`. */
    readonly store: ServiceStore;
    /** Adoption stamp; injectable so migration behavior is deterministic. */
    readonly now?: string;
}

/** One new document containing durable audit intents for its adopted runs. */
export interface AdoptionPlan {
    /** Complete run document to persist atomically. */
    readonly document: RunsDocument;
}

/** Classification of one pre-run queue row. */
interface LegacyClassification {
    /** Run state after migration. */
    readonly state: RunState;
    /** Named branch recorded in the migration audit. */
    readonly branch: string;
    /** State explanation, null only for pending. */
    readonly stateReason: string | null;
    /** Synthetic lease for an unreserved in-flight row. */
    readonly lease: RunLease | null;
    /** Reservation recovered from an explicit marker. */
    readonly reservation: RunReservation | null;
    /** Attempt record for an already-reported legacy outcome. */
    readonly attempts: readonly DispatchAttempt[];
    /** Session id when the legacy outcome was treated as a session. */
    readonly sessionId: string | null;
}

/** Narrow an untrusted row to a plain record. */
function recordOf(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/** Recognize a reservation marker in a synthetic legacy fixture. */
function hasReservation(value: unknown): boolean {
    const record = recordOf(value);
    return record !== null && 'reservation' in record && record.reservation !== null;
}

/** Classify the shipped panel's known problem strings; unknowns assume a session. */
function isLegacyProblem(value: string): boolean {
    return LEGACY_PROBLEMS.has(value)
        || (value.startsWith('project "') && value.endsWith('" is not registered in OpenChamber'))
        || value.startsWith('listProjects failed: ');
}

/** Create a complete dispatch-attempt record for the adoption branch. */
function attemptOf(input: {
    readonly outcome: DispatchAttempt['outcome'];
    readonly token?: string;
    readonly reservedAt?: string;
    readonly sessionId?: string | null;
    readonly reason?: string | null;
    readonly resultReportedAt?: string | null;
}): DispatchAttempt {
    return {
        attempt: 1,
        dispatchToken: input.token ?? null,
        reservedAt: input.reservedAt ?? null,
        outcome: input.outcome,
        sessionId: input.sessionId ?? null,
        reason: input.reason ?? null,
        resultReportedAt: input.resultReportedAt ?? null,
    };
}

/** Build the safe terminal projection for a legacy outcome. */
function classifyDispatched(event: QueuedEvent, now: string): LegacyClassification {
    const result = event.dispatchResult ?? null;
    if (result !== null && isLegacyProblem(result)) {
        return {
            state: 'failed',
            branch: 'dispatched-problem',
            stateReason: result,
            lease: null,
            reservation: null,
            attempts: [attemptOf({ outcome: 'failed', reason: result, resultReportedAt: event.dispatchedAt ?? now })],
            sessionId: null,
        };
    }

    const branch = result === null ? 'dispatched-unknown-outcome' : 'dispatched-session';
    const reason = result === null
        ? 'legacy dispatch was terminal; outcome identifier unavailable'
        : `session ${result} created`;

    return {
        state: 'dispatched',
        branch,
        stateReason: reason,
        lease: null,
        reservation: null,
        attempts: [attemptOf({
            outcome: 'dispatched',
            sessionId: result,
            resultReportedAt: event.dispatchedAt ?? now,
        })],
        sessionId: result,
    };
}

/** Build the fail-closed projection for an in-flight row with a reservation. */
function classifyReserved(input: { readonly runKey: string; readonly now: string }): LegacyClassification {
    const reservedAt = input.now;
    const dispatchToken = buildDispatchToken(input.runKey, 1);

    return {
        state: 'starting',
        branch: 'in-flight-reserved',
        stateReason: 'adopted legacy reservation; awaiting its result',
        lease: null,
        reservation: {
            dispatchToken,
            attempt: 1,
            reservedAt,
            resultDeadlineAt: new Date(Date.parse(reservedAt) + RESULT_DEADLINE_MS).toISOString(),
            consumed: false,
        },
        attempts: [attemptOf({ outcome: null, token: dispatchToken, reservedAt })],
        sessionId: null,
    };
}

/** Build the synthetic already-expired lease for an in-flight legacy row. */
function classifyInFlight(input: {
    readonly event: QueuedEvent;
    readonly correlationId: string;
    readonly now: string;
}): LegacyClassification {
    const { event, correlationId, now } = input;
    const issuedAt = event.claimedAt ?? event.detectedAt;

    return {
        state: 'claimed',
        branch: 'in-flight-no-reservation',
        stateReason: 'adopted legacy in-flight delivery; synthetic lease is expired',
        lease: {
            leaseId: buildMigrationLeaseId(correlationId),
            attempt: 1,
            holder: MIGRATION_HOLDER,
            issuedAt,
            expiresAt: new Date(Date.parse(now) - 1).toISOString(),
            provenance: 'migration',
        },
        reservation: null,
        attempts: [attemptOf({ outcome: null })],
        sessionId: null,
    };
}

/** Classify one row from the shipped three-state vocabulary. */
function classifyLegacy(input: {
    readonly event: QueuedEvent;
    readonly runKey: string;
    readonly correlationId: string;
    readonly now: string;
    readonly reserved: boolean;
}): LegacyClassification {
    if (input.event.state === 'dispatched') {
        return classifyDispatched(input.event, input.now);
    }

    if (input.reserved) {
        return classifyReserved({ runKey: input.runKey, now: input.now });
    }

    if (input.event.state === 'in-flight') {
        return classifyInFlight({ event: input.event, correlationId: input.correlationId, now: input.now });
    }

    return {
        state: 'pending',
        branch: 'pending',
        stateReason: null,
        lease: null,
        reservation: null,
        attempts: [],
        sessionId: null,
    };
}

/** Build the host-session pointer for a recognized legacy session id. */
function sessionReference(input: {
    readonly event: QueuedEvent;
    readonly correlationId: string;
    readonly sessionId: string | null;
}): Run['session'] {
    const { event, correlationId, sessionId } = input;
    if (sessionId === null) {
        return null;
    }

    return {
        sessionId,
        attachmentId: correlationId,
        dispatchedAt: event.dispatchedAt ?? event.detectedAt,
        title: event.issueTitle,
        sourceUrl: event.issueUrl,
        worktree: null,
    };
}

/**
 * The three reference members every migrated run starts with.
 *
 * A legacy delivery whose origin cannot be derived contributes a run with no
 * reference rather than none at all — the row the operator sees is the
 * evidence, and an empty list is honest where a guessed origin is not.
 *
 * @param reference - The delivery's own reference, when it has one.
 * @returns The list, the joined count, and the two overflow markers.
 */
function retainedReferences(reference: SourceReference | null): {
    readonly sourceReferences: readonly SourceReference[];
    readonly referenceCount: number;
    readonly referencesNotRetained: number;
    readonly referencesTruncated: boolean;
} {
    return {
        sourceReferences: reference === null ? [] : [reference],
        referenceCount: reference === null ? 0 : 1,
        referencesNotRetained: 0,
        referencesTruncated: false,
    };
}

/** Construct one migrated run from its first legacy delivery. */
function migratedRun(input: {
    readonly event: QueuedEvent;
    readonly ordinal: number;
    readonly now: string;
    readonly reserved: boolean;
}): { readonly run: Run; readonly branch: string } {
    const { event, ordinal, now, reserved } = input;
    const subjectType = subjectTypeOf(event);
    const keyInput = {
        accountNumericUserId: event.accountNumericUserId,
        repository: event.repository,
        subjectType,
        subjectNumber: event.issueNumber,
        ordinal,
    };
    const runKey = buildRunKey(keyInput);
    const correlationId = buildCorrelationId(runKey);
    const classification = classifyLegacy({ event, runKey, correlationId, now, reserved });
    const reference = referenceOf(event, true);

    return {
        branch: classification.branch,
        run: {
            runKey,
            correlationId,
            attachmentId: buildAttachmentId(correlationId),
            ordinal,
            subjectType,
            subjectNumber: event.issueNumber,
            repository: event.repository,
            accountNumericUserId: event.accountNumericUserId,
            bindingId: event.bindingId,
            projectId: event.projectId,
            worktreeOption: event.worktreeOption,
            state: classification.state,
            stateReason: classification.stateReason,
            attempt: 1,
            requeuesUsed: 0,
            ...retainedReferences(reference),
            lease: classification.lease,
            reservation: classification.reservation,
            attempts: classification.attempts,
            session: sessionReference({ event, correlationId, sessionId: classification.sessionId }),
            verification: null,
            createdAt: event.detectedAt,
            updatedAt: now,
        },
    };
}

/** Read valid queue rows while preserving the optional synthetic reservation marker. */
async function readLegacyRows(store: ServiceStore): Promise<readonly { event: QueuedEvent; reserved: boolean }[]> {
    const stored = await store.readJson('events.json', (raw) => {
        if (!Array.isArray(raw) || raw.some((row) => parseStoredEvent(row) === null)) {
            return null;
        }

        return raw;
    });
    if (stored.status !== 'ok') {
        return [];
    }

    return stored.value.flatMap((raw) => {
        const event = parseStoredEvent(raw);
        return event === null ? [] : [{ event, reserved: hasReservation(raw) }];
    });
}

/** Derive the stable subject counter key for one event. */
function subjectKeyOf(event: QueuedEvent): string {
    return buildSubjectKey({
        accountNumericUserId: event.accountNumericUserId,
        repository: event.repository,
        subjectType: subjectTypeOf(event),
        subjectNumber: event.issueNumber,
        ordinal: 0,
    });
}

/** Derive the same stable subject key from an already-built run. */
function subjectKeyOfRun(run: Run): string {
    return buildSubjectKey({
        accountNumericUserId: run.accountNumericUserId,
        repository: run.repository,
        subjectType: run.subjectType,
        subjectNumber: run.subjectNumber,
        ordinal: run.ordinal,
    });
}

/** Whether this legacy outcome already created a host session. */
function isTerminalLegacyOutcome(event: QueuedEvent): boolean {
    return event.state === 'dispatched'
        && event.dispatchResult !== null
        && event.dispatchResult !== undefined
        && !isLegacyProblem(event.dispatchResult);
}

/** Add a new run and its first migration branch. */
function addMigratedRun(input: {
    readonly runs: Run[];
    readonly record: { readonly event: QueuedEvent; readonly reserved: boolean };
    readonly now: string;
    readonly subjects: Record<string, number>;
    readonly branches: Map<string, string[]>;
    readonly key: string;
}): void {
    const ordinal = input.subjects[input.key] ?? 0;
    input.subjects[input.key] = ordinal + 1;
    const adopted = migratedRun({ ...input.record, ordinal, now: input.now });
    input.runs.push(adopted.run);
    input.branches.set(adopted.run.correlationId, [adopted.branch]);
}

/** Preserve the more cautious state when multiple old rows map to one run. */
function promoteLifecycle(run: Run, candidate: Run): Run {
    const rank: Readonly<Record<string, number>> = { pending: 0, failed: 1, claimed: 2, starting: 3 };
    if ((rank[candidate.state] ?? 0) <= (rank[run.state] ?? 0)) {
        return run;
    }

    return {
        ...run,
        state: candidate.state,
        stateReason: candidate.stateReason,
        lease: candidate.lease,
        reservation: candidate.reservation,
        attempts: candidate.attempts,
        updatedAt: candidate.updatedAt,
    };
}

/** Coalesce a legacy open delivery and retain the most cautious lifecycle state. */
function mergeLegacyRow(input: {
    readonly runs: Run[];
    readonly openIndex: number;
    readonly record: { readonly event: QueuedEvent; readonly reserved: boolean };
    readonly now: string;
    readonly branches: Map<string, string[]>;
}): void {
    const run = input.runs[input.openIndex];
    if (run === undefined) {
        return;
    }

    const reference = referenceOf(input.record.event, run.reservation === null);
    const folded = reference === null ? run : joinReference({ run, reference, now: input.now }).run;
    const migrated = migratedRun({
        event: input.record.event,
        ordinal: run.ordinal,
        now: input.now,
        reserved: input.record.reserved,
    });
    const promoted = promoteLifecycle(folded, migrated.run);
    input.runs[input.openIndex] = promoted;
    const recorded = input.branches.get(run.correlationId) ?? [];
    recorded.push(migrated.branch);
    input.branches.set(run.correlationId, recorded);
}

/** Build the complete first-read adoption plan without changing legacy bytes. */
export async function planAdoption(input: AdoptionPlanInput): Promise<AdoptionPlan> {
    const now = input.now ?? nowIso();
    const records = await readLegacyRows(input.store);
    const runs: Run[] = [];
    const branches = new Map<string, string[]>();
    const subjects: Record<string, number> = {};

    for (const record of records) {
        const key = subjectKeyOf(record.event);
        const openIndex = runs.findIndex((run) => run.state !== 'dispatched'
            && run.state !== 'dead-lettered' && subjectKeyOfRun(run) === key);
        if (openIndex >= 0 && !isTerminalLegacyOutcome(record.event)) {
            mergeLegacyRow({ runs, openIndex, record, now, branches });
        } else {
            addMigratedRun({ runs, record, now, subjects, branches, key });
        }
    }

    const auditIntents: RunAuditIntent[] = runs.map((run) => ({
        eventType: 'run.migrated',
        correlationId: run.correlationId,
        deliveryIds: run.sourceReferences.map((reference) => reference.deliveryId),
        stateBranches: branches.get(run.correlationId) ?? [],
        state: run.state,
    }));

    return { document: { schemaVersion: RUNS_SCHEMA_VERSION, subjects, runs, auditIntents } };
}

/** Detect post-run-layer delivery rows before considering a legacy adoption. */
export async function hasPostRunDeliveries(store: ServiceStore): Promise<boolean> {
    const stored = await store.readJson(EVENTS_FILE, (raw) => raw);
    if (stored.status !== 'ok' || !Array.isArray(stored.value)) {
        return false;
    }

    return stored.value.some((raw) => {
        const row = recordOf(raw);
        return row !== null && (row.state === undefined || row.runCorrelationId !== undefined);
    });
}
