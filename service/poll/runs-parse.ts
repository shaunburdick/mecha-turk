/**
 * Stored schema and parser for `runs.json` (003 data-model §2.2–§2.6).
 *
 * This module owns the read side of the run document: the vocabulary the
 * eight-state model accepts and the validator the store runs before it trusts
 * a file. The shapes themselves live beside it in `runs-types.ts`, the way
 * the queue's row type sits in `events-parse.ts`, so each module stays inside
 * the file-length gate and the run store keeps one import path.
 *
 * The parser is fail-closed in the AGENTS.md sense: it answers `null` for
 * anything it cannot fully understand — an unknown state, a `blocked:` with
 * no reason, a missing field, a wrong type, an out-of-bounds list — and the
 * store turns that `null` into a quarantine rather than handing a half-read
 * run to a decision that could dispatch twice (constitution II).
 *
 * Two shapes are deliberately *wide* so they can never quarantine a healthy
 * file: `state` accepts the `blocked:<reason>` family as prefix + non-empty
 * kebab reason (never a fixed enum — `blocked:project-missing` and a declared
 * but not-yet-produced `blocked:policy` both parse), and every lifecycle
 * sub-object (`lease`, `reservation`, `session`, `verification`) is nullable
 * because most runs sit without one. Panel- and host-reported *display text*
 * (session title, source link, verification note) is type-checked only: a
 * cosmetic value must never be able to quarantine the run store.
 */

import { isRecord, readCount, readFlag, readPositiveInt, readStamp, readText } from '../json.ts';
import { buildCorrelationId, buildRunKey, buildSubjectKey } from './run-key.ts';
import { parseRunAuditIntents } from './runs-audit-parse.ts';
import {
    parseAttempt,
    parseLease,
    parseReference,
    parseReservation,
    parseSession,
    parseVerification,
} from './runs-parts-parse.ts';
import type {
    DispatchAttempt,
    Run,
    RunLease,
    RunReservation,
    RunState,
    RunsDocument,
    SessionRef,
    RunVerification,
    SourceReference,
} from './runs-types.ts';

/**
 * The document and row types are re-exported here so this module stays the
 * one import path for the run schema (T-002); their declarations live in
 * `runs-types.ts`, which the file-length gate keeps them in.
 */
export type { Run, RunsDocument };

/** Document schema marker this build writes into (and accepts from) `runs.json`. */
export const RUNS_SCHEMA_VERSION = 1;

/** Cap on `run.sourceReferences` (FR-013 + NFR-107, plan D11). */
export const MAX_SOURCE_REFERENCES = 20;

/** Cap on `run.attempts` (NFR-107); the writer keeps the newest records. */
export const MAX_ATTEMPT_RECORDS = 50;

/** States stored as their own literal, without a suffix. */
const SIMPLE_STATES: ReadonlySet<string> = new Set([
    'pending',
    'claimed',
    'starting',
    'dispatched',
    'failed',
    'unconfirmed',
    'dead-lettered',
]);


/** Text fields every stored run carries as non-empty text. */
const RUN_TEXT_FIELDS = [
    'runKey',
    'correlationId',
    'attachmentId',
    'repository',
    'accountNumericUserId',
    'bindingId',
    'projectId',
    'worktreeOption',
] as const;


/**
 * Check the reason half of a `blocked:<reason>` state: a non-empty kebab
 * token, never a fixed enum (data-model §1), and never an empty suffix.
 *
 * @param reason - Whatever follows the `blocked:` prefix.
 * @returns `true` when every hyphen-separated part is lowercase alphanumeric.
 */
function isBlockedReason(reason: string): boolean {
    if (reason === '') {
        return false;
    }

    return reason.split('-').every((part) => part !== '' && /^[a-z0-9]+$/.test(part));
}

/**
 * Narrow a value to a run state, or `null` when it is from another
 * vocabulary.
 *
 * @param value - Candidate state.
 * @returns The state, or `null`.
 */
function runStateOf(value: unknown): RunState | null {
    if (typeof value !== 'string') {
        return null;
    }

    if (SIMPLE_STATES.has(value)) {
        return value as RunState;
    }

    const prefix = 'blocked:';
    if (!value.startsWith(prefix) || !isBlockedReason(value.slice(prefix.length))) {
        return null;
    }

    return value as RunState;
}

/**
 * Narrow a value to a run state, for callers that must *refuse* rather than
 * read (the block report validates its reason before it writes a state).
 *
 * @param value - Candidate state.
 * @returns `true` for one of the eight model states or a `blocked:<reason>`.
 */
export function isRunState(value: unknown): value is RunState {
    return runStateOf(value) !== null;
}

/** Scalar fields one run row validated as a group. */
interface RunScalars {
    /** Current state. */
    readonly state: RunState;
    /** Reason line: `null` while pending, required everywhere else (FR-074). */
    readonly stateReason: string | null;
    /** Subject shape. */
    readonly subjectType: Run['subjectType'];
    /** Ordinal. */
    readonly ordinal: number;
    /** Subject number. */
    readonly subjectNumber: number;
    /** Attempt count. */
    readonly attempt: number;
    /** Automatic requeues consumed. */
    readonly requeuesUsed: number;
    /** Deliveries that joined, capped or not. */
    readonly referenceCount: number;
    /** Whether the reference list was cut. */
    readonly referencesTruncated: boolean;
    /** Creation stamp. */
    readonly createdAt: string;
    /** Last-mutation stamp. */
    readonly updatedAt: string;
}

/** One run row's state and the reason line that must accompany it. */
interface StateLine {
    /** The state as stored. */
    readonly state: RunState;
    /** Why the run sits there; `null` only while it waits. */
    readonly reason: string | null;
}

/**
 * Read a row's state and reason line as a pair.
 *
 * `null` reasons are legal only on `pending`; every other state must carry a
 * non-empty one (FR-074, data-model §2.2), and a reason of any other type
 * refuses the row outright.
 *
 * @param raw - Candidate row, already known to be a record.
 * @returns The pair, or `null` when either half is unusable.
 */
function readStateLine(raw: Record<string, unknown>): StateLine | null {
    const state = runStateOf(raw.state);
    const { stateReason } = raw;
    if (state === null || (stateReason !== null && typeof stateReason !== 'string')) {
        return null;
    }

    if (state !== 'pending' && (stateReason === null || stateReason === '')) {
        return null;
    }

    return { state, reason: stateReason };
}

/**
 * Validate one run row's scalar fields as a group.
 *
 * @param raw - Candidate row, already known to be a record.
 * @returns The scalars, or `null` when any is missing or out of range.
 */
function parseRunScalars(raw: Record<string, unknown>): RunScalars | null {
    const line = readStateLine(raw);
    const { subjectType } = raw;
    if (line === null || (subjectType !== 'issue' && subjectType !== 'pull_request')) {
        return null;
    }

    const ordinal = readCount(raw.ordinal);
    const subjectNumber = readPositiveInt(raw.subjectNumber);
    const attempt = readPositiveInt(raw.attempt);
    const requeuesUsed = readCount(raw.requeuesUsed);
    const referenceCount = readPositiveInt(raw.referenceCount);
    const truncated = readFlag(raw.referencesTruncated);
    const createdAt = readStamp(raw.createdAt);
    const updatedAt = readStamp(raw.updatedAt);
    const values = [ordinal, subjectNumber, attempt, requeuesUsed, referenceCount, createdAt, updatedAt];
    if (values.includes(null) || truncated === null) {
        return null;
    }

    return {
        state: line.state,
        stateReason: line.reason,
        subjectType,
        ordinal: ordinal as number,
        subjectNumber: subjectNumber as number,
        attempt: attempt as number,
        requeuesUsed: requeuesUsed as number,
        referenceCount: referenceCount as number,
        referencesTruncated: truncated,
        createdAt: createdAt as string,
        updatedAt: updatedAt as string,
    };
}

/** Confirm the stored identity tuple matches its deterministic hash values. */
function runIdentityMatches(raw: Record<string, unknown>, scalars: RunScalars): boolean {
    try {
        const runKey = buildRunKey({
            accountNumericUserId: raw.accountNumericUserId as string,
            repository: raw.repository as string,
            subjectType: scalars.subjectType,
            subjectNumber: scalars.subjectNumber,
            ordinal: scalars.ordinal,
        });
        const correlationId = buildCorrelationId(runKey);

        return raw.runKey === runKey
            && raw.correlationId === correlationId
            && raw.attachmentId === correlationId;
    } catch {
        return false;
    }
}

/** Sub-objects one run row validated as a group; every one is nullable. */
interface RunObjects {
    /** Live lease. */
    readonly lease: RunLease | null;
    /** Live reservation. */
    readonly reservation: RunReservation | null;
    /** Recorded session. */
    readonly session: SessionRef | null;
    /** Recorded verification. */
    readonly verification: RunVerification | null;
}

/** One nullable lifecycle sub-object after validation. */
interface RunPart<T> {
    /** Whether a *present* value could not be trusted (refuse the row). */
    readonly malformed: boolean;
    /** The parsed value, or `null` when the run holds none. */
    readonly value: T | null;
}

/**
 * Validate one nullable lifecycle sub-object.
 *
 * A missing key and a stored `null` both mean "this run holds none"; a
 * present value must parse, because a lease or session the parser cannot
 * read is exactly the ambiguity that must never reach a dispatch decision
 * (constitution II).
 *
 * @param stored - The value as stored.
 * @param parse - Validator for the sub-object's shape.
 * @returns The parsed part, flagged when a present value was unusable.
 */
function parsePart<T>(stored: unknown, parse: (candidate: unknown) => T | null): RunPart<T> {
    if (stored === undefined || stored === null) {
        return { malformed: false, value: null };
    }

    const value = parse(stored);

    return value === null ? { malformed: true, value: null } : { malformed: false, value };
}

/**
 * Validate one run row's nullable lifecycle sub-objects as a group.
 *
 * @param raw - Candidate row, already known to be a record.
 * @returns The sub-objects, or `null` when a present one is malformed.
 */
function parseRunObjects(raw: Record<string, unknown>): RunObjects | null {
    const lease = parsePart(raw.lease, parseLease);
    const reservation = parsePart(raw.reservation, parseReservation);
    const session = parsePart(raw.session, parseSession);
    const verification = parsePart(raw.verification, parseVerification);
    const parts = [lease, reservation, session, verification];
    if (parts.some((part) => part.malformed)) {
        return null;
    }

    return {
        lease: lease.value,
        reservation: reservation.value,
        session: session.value,
        verification: verification.value,
    };
}

/**
 * Parse a bounded list of sub-objects.
 *
 * @param raw - Candidate array as stored.
 * @param shape - The row parser to run over every element and its inclusive
 *   length bound.
 * @returns The parsed rows, or `null` when the value is not an array, holds
 *   an unusable row, or exceeds the cap.
 */
function parseList<T>(
    raw: unknown,
    shape: { readonly parse: (candidate: unknown) => T | null; readonly cap: number },
): readonly T[] | null {
    if (!Array.isArray(raw) || raw.length > shape.cap) {
        return null;
    }

    const rows: T[] = [];
    for (const candidate of raw) {
        const row = shape.parse(candidate);
        if (row === null) {
            return null;
        }

        rows.push(row);
    }

    return rows;
}

/** The independently validated parts that form one run. */
interface ParsedRunParts {
    /** Validated scalar fields. */
    readonly scalars: RunScalars;
    /** Nullable lifecycle objects. */
    readonly objects: RunObjects;
    /** Bounded source references. */
    readonly references: readonly SourceReference[];
    /** Bounded attempt history. */
    readonly attempts: readonly DispatchAttempt[];
}

/** Require attempt and session pointers to tell one consistent story. */
function sessionHistoryHolds(input: {
    readonly state: RunState;
    readonly session: SessionRef | null;
    readonly attempts: readonly DispatchAttempt[];
}): boolean {
    const { state, session, attempts } = input;
    const sessionAttempts = attempts.filter(
        (attempt) => attempt.outcome === 'dispatched' || attempt.sessionId !== null,
    );
    const knownSessionIds = new Set(sessionAttempts.flatMap((attempt) =>
        attempt.sessionId === null ? [] : [attempt.sessionId]));
    const invalidAttemptSession = attempts.some(
        (attempt) => attempt.sessionId !== null && attempt.outcome !== 'dispatched',
    );
    const contradictorySessionHistory = sessionAttempts.length > 0 && state !== 'dispatched';
    const mismatchedSession = session !== null
        && (state !== 'dispatched' || !knownSessionIds.has(session.sessionId));

    return !invalidAttemptSession
        && !contradictorySessionHistory
        && !mismatchedSession
        && knownSessionIds.size <= 1;
}

/** Check the cross-field invariants whose combination must remain coherent. */
function runRelationsHold(input: {
    readonly scalars: RunScalars;
    readonly objects: RunObjects;
    readonly references: readonly SourceReference[];
    readonly attempts: readonly DispatchAttempt[];
    readonly attachmentId: unknown;
}): boolean {
    const { scalars, objects, references, attempts, attachmentId } = input;
    const referenceIds = new Set(references.map((reference) => reference.deliveryId));
    const basicRelationsHold = references.length <= scalars.referenceCount
        && (objects.session === null || objects.session.attachmentId === attachmentId)
        && (objects.lease === null || objects.lease.attempt === scalars.attempt)
        && (objects.reservation === null || objects.reservation.attempt === scalars.attempt)
        && referenceIds.size === references.length;

    return basicRelationsHold && sessionHistoryHolds({
        state: scalars.state,
        session: objects.session,
        attempts,
    });
}

/** Parse and cross-check the typed fields of one stored run row. */
function parseRunParts(raw: Record<string, unknown>): ParsedRunParts | null {
    const scalars = parseRunScalars(raw);
    const objects = parseRunObjects(raw);
    const references = parseList(raw.sourceReferences, { parse: parseReference, cap: MAX_SOURCE_REFERENCES });
    const attempts = parseList(raw.attempts, { parse: parseAttempt, cap: MAX_ATTEMPT_RECORDS });
    if (
        scalars === null
        || !runIdentityMatches(raw, scalars)
        || objects === null
        || references === null
        || attempts === null
    ) {
        return null;
    }

    if (!runRelationsHold({ scalars, objects, references, attempts, attachmentId: raw.attachmentId })) {
        return null;
    }

    return { scalars, objects, references, attempts };
}

/** Project validated storage fields into the run model. */
function runFromParts(raw: Record<string, unknown>, parts: ParsedRunParts): Run {
    const { scalars, objects, references, attempts } = parts;
    return {
        runKey: raw.runKey as string,
        correlationId: raw.correlationId as string,
        attachmentId: raw.attachmentId as string,
        ordinal: scalars.ordinal,
        subjectType: scalars.subjectType,
        subjectNumber: scalars.subjectNumber,
        repository: raw.repository as string,
        accountNumericUserId: raw.accountNumericUserId as string,
        bindingId: raw.bindingId as string,
        projectId: raw.projectId as string,
        worktreeOption: raw.worktreeOption as string,
        state: scalars.state,
        stateReason: scalars.stateReason,
        attempt: scalars.attempt,
        requeuesUsed: scalars.requeuesUsed,
        sourceReferences: references,
        referenceCount: scalars.referenceCount,
        referencesTruncated: scalars.referencesTruncated,
        lease: objects.lease,
        reservation: objects.reservation,
        attempts,
        session: objects.session,
        verification: objects.verification,
        createdAt: scalars.createdAt,
        updatedAt: scalars.updatedAt,
    };
}

/**
 * Parse one stored run row, answering `null` for anything unusable.
 *
 * @param raw - One element from `runs.json`'s `runs` array.
 * @returns The run, or `null` when the row cannot be trusted.
 */
export function parseRun(raw: unknown): Run | null {
    if (!isRecord(raw) || !RUN_TEXT_FIELDS.every((field) => readText(raw[field]) !== null)) {
        return null;
    }

    const parts = parseRunParts(raw);

    return parts === null ? null : runFromParts(raw, parts);
}

/**
 * Validate the ordinal counters map.
 *
 * @param raw - Candidate `subjects` value.
 * @returns The counters, or `null` when any value is not a non-negative
 *   integer (an empty key is unusable too — it is what the run key is
 *   re-derived from).
 */
function parseSubjects(raw: unknown): Record<string, number> | null {
    if (!isRecord(raw)) {
        return null;
    }

    const entries: [string, number][] = [];
    for (const [key, value] of Object.entries(raw)) {
        const next = readCount(value);
        if (key === '' || next === null) {
            return null;
        }

        entries.push([key, next]);
    }

    return Object.fromEntries(entries);
}

/** Parse the durable audit-intent outbox while retaining its narrow vocabulary. */
/** Parse rows while enforcing unique ids and a single open run per subject. */
function parseRunRows(raw: readonly unknown[]): readonly Run[] | null {
    const runs: Run[] = [];
    const seen = new Set<string>();
    const openSubjects = new Set<string>();
    for (const candidate of raw) {
        const run = parseRun(candidate);
        if (run === null || seen.has(run.correlationId)) {
            return null;
        }

        seen.add(run.correlationId);
        if (run.state !== 'dispatched' && run.state !== 'dead-lettered') {
            const subjectKey = buildSubjectKey({
                accountNumericUserId: run.accountNumericUserId,
                repository: run.repository,
                subjectType: run.subjectType,
                subjectNumber: run.subjectNumber,
                ordinal: run.ordinal,
            });
            if (openSubjects.has(subjectKey)) {
                return null;
            }

            openSubjects.add(subjectKey);
        }

        runs.push(run);
    }

    return runs;
}

/**
 * Parse the whole `runs.json` document.
 *
 * @param raw - Parsed document.
 * @returns The document, or `null` when it is unusable (quarantined): the
 *   schema marker must be the one this build understands, the ordinal
 *   counters must be non-negative integers, every run must parse, and no two
 *   runs may share a correlation id.
 */
export function parseRunsDocument(raw: unknown): RunsDocument | null {
    if (!isRecord(raw) || raw.schemaVersion !== RUNS_SCHEMA_VERSION || !Array.isArray(raw.runs)) {
        return null;
    }

    const subjects = parseSubjects(raw.subjects);
    const runs = parseRunRows(raw.runs);
    const auditIntents = parseRunAuditIntents(raw.auditIntents);
    if (subjects === null || runs === null || auditIntents === null) {
        return null;
    }

    return { schemaVersion: RUNS_SCHEMA_VERSION, subjects, runs, auditIntents };
}
