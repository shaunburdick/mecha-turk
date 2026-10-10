/**
 * One run row's scalars: the state vocabulary and the counters beside it
 * (003 data-model §2.2, §1).
 *
 * Split from `runs-parse.ts` for the same reason its sub-objects live in
 * `runs-parts-parse.ts`: the state line and the counters have their own
 * vocabulary and their own cross-field rules, and the file-length gate will not
 * hold them beside the document orchestration. Everything here is fail-closed —
 * a value it cannot fully understand answers `null`, which the row parser turns
 * into a refused row rather than a partially trusted one.
 *
 * Two rules are deliberately *wide* so a healthy file can never be
 * quarantined: the state vocabulary accepts the `blocked:<reason>` family as
 * prefix + non-empty kebab reason (never a fixed enum — `blocked:project-missing`
 * and a declared but not-yet-produced `blocked:policy` both parse), and a
 * `null` reason line is legal only on `pending` (FR-074, NFR-108).
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
    /** Current state. */
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
 * @returns `true` for one of the eight model states or a `blocked:<reason>`.
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
 * Read the snapshotted actor policy.
 *
 * Absent **or** stored `null` both read as *no authorization recorded*, which
 * is how every run written before this member existed reads — a statement
 * about that run rather than a hole in the record. A **present** value outside
 * the closed two-word union refuses the row instead of defaulting to `'open'`,
 * because defaulting would silently upgrade an unreadable policy into
 * permission (constitution II).
 *
 * @param raw - Candidate row, already known to be a record.
 * @returns The policy, `null` for "none recorded", or `undefined` when a
 *   present value is unusable.
 */
function readActorPolicy(raw: Record<string, unknown>): ActorPolicy | null | undefined {
    const value = raw.actorPolicy;
    if (value === undefined || value === null) {
        return null;
    }

    return value === 'open' || value === 'restricted' ? value : undefined;
}

/**
 * Read the head-SHA seed the establishing cycle recorded.
 *
 * Absentable on exactly the terms {@link readActorPolicy} follows, and for the
 * same two reasons: a run written before the member existed carries none and
 * must still parse, and **absent is a fact about the run** — *no seed recorded*,
 * which the follow-up detector reads as "compare nothing this cycle" rather
 * than as "the head changed" (002 FR-103). A present value that is not usable
 * text refuses the row instead of being coerced: a seed the parser cannot read
 * is not a baseline it may compare against (constitution II).
 *
 * @param raw - Candidate row, already known to be a record.
 * @returns The seed, `undefined` when none was recorded, or `null` when a
 *   present value is unusable.
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
 * @param raw - Candidate row, already known to be a record.
 * @returns The scalars, or `null` when any is missing or out of range.
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
 * @param raw - Candidate row, already known to be a record.
 * @returns `true` when every required text field is a non-empty string.
 */
export function runTextFieldsHold(raw: Record<string, unknown>): boolean {
    return RUN_TEXT_FIELDS.every((field) => readText(raw[field]) !== null);
}
