/**
 * One run row's scalars: the state vocabulary and the counters beside it
 * (003 data-model §2.2, §1).
 */

import { readCount, readFlag, readPositiveInt, readStamp, readText } from '../json.ts';
import type { ActorPolicy, Run, RunState } from './runs-types.ts';

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

/** One run row's scalar fields after validation. */
export interface RunScalars {
    readonly state: RunState;
    /** Reason line: `null` while pending, required everywhere else. */
    readonly stateReason: string | null;
    /** Subject shape. */
    readonly subjectType: Run['subjectType'];
    readonly ordinal: number;
    readonly subjectNumber: number;
    /** Attempt count. */
    readonly attempt: number;
    /** Automatic requeues consumed. */
    readonly requeuesUsed: number;
    /** Deliveries that joined, retained or not. */
    readonly referenceCount: number;
    /** Joining triggers the cap kept off the list. */
    readonly referencesNotRetained: number;
    /** Whether the reference list was cut. */
    readonly referencesTruncated: boolean;
    /**
     * The snapshotted allow-list shape, or `null` when no authorization has
     * been recorded yet.
     */
    readonly actorPolicy: ActorPolicy | null;
    /** Creation stamp. */
    readonly createdAt: string;
    /** Last-mutation stamp. */
    readonly updatedAt: string;
    /**
     * The head SHA the run's establishing cycle observed, or `undefined` when
     * none was recorded (absent on the row, not a stored `null`).
     */
    readonly lastHeadSha: string | undefined;
}

/**
 * Check the reason half of a `blocked:<reason>` state: a non-empty kebab
 * token, never a fixed enum (data-model §1), and never an empty suffix.
 *
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
 */
export function isRunState(value: unknown): value is RunState {
    return runStateOf(value) !== null;
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
 * Read the snapshotted actor policy. Absent **or** stored `null` both read as
 * *no authorization recorded* — how every run written before the member
 * existed reads, a statement about that run rather than a hole in the record.
 * A **present** value outside the closed two-word union refuses the row
 * instead of defaulting to `'open'`, because defaulting would silently
 * upgrade an unreadable policy into permission (constitution II).
 */
function readActorPolicy(raw: Record<string, unknown>): ActorPolicy | null | undefined {
    const value = raw.actorPolicy;
    if (value === undefined || value === null) {
        return null;
    }

    return value === 'open' || value === 'restricted' ? value : undefined;
}

/**
 * Read the head-SHA seed the establishing cycle recorded. Absentable on
 * exactly the terms {@link readActorPolicy} follows, and for the same two
 * reasons: a run written before the member existed must still parse, and
 * **absent is a fact about the run** — *no seed recorded* — which the
 * follow-up detector reads as *compare nothing this cycle* rather than *the
 * head changed* (002 FR-103). A present value that is not usable text refuses
 * the row instead of being coerced: a seed the parser cannot read is
 * not a baseline it may compare against (constitution II).
 */
function readHeadSeed(raw: Record<string, unknown>): string | undefined | null {
    const value = raw.lastHeadSha;
    if (value === undefined) {
        return undefined;
    }

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Validate one run row's scalar fields as a group.
 *
 */
export function parseRunScalars(raw: Record<string, unknown>): RunScalars | null {
    const line = readStateLine(raw);
    const actorPolicy = readActorPolicy(raw);
    const lastHeadSha = readHeadSeed(raw);
    const { subjectType } = raw;
    if (line === null || actorPolicy === undefined || lastHeadSha === null
        || (subjectType !== 'issue' && subjectType !== 'pull_request')) {
        return null;
    }

    const ordinal = readCount(raw.ordinal);
    const subjectNumber = readPositiveInt(raw.subjectNumber);
    const attempt = readPositiveInt(raw.attempt);
    const requeuesUsed = readCount(raw.requeuesUsed);
    const referenceCount = readCount(raw.referenceCount);
    const notRetained = readCount(raw.referencesNotRetained);
    const truncated = readFlag(raw.referencesTruncated);
    const createdAt = readStamp(raw.createdAt);
    const updatedAt = readStamp(raw.updatedAt);
    const values = [ordinal, subjectNumber, attempt, requeuesUsed, referenceCount, notRetained, createdAt, updatedAt];
    if (truncated === null || values.includes(null)) {
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
        referencesNotRetained: notRetained as number,
        referencesTruncated: truncated,
        actorPolicy,
        lastHeadSha,
        createdAt: createdAt as string,
        updatedAt: updatedAt as string,
    };
}

/**
 * Read the text fields every stored run must carry.
 *
 */
export function runTextFieldsHold(raw: Record<string, unknown>): boolean {
    return RUN_TEXT_FIELDS.every((field) => readText(raw[field]) !== null);
}
