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
import type { Run, RunState } from './runs-types.ts';

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
    /** Deliveries that joined, retained or not. */
    readonly referenceCount: number;
    /** Joining triggers the cap kept off the list (T-038). */
    readonly referencesNotRetained: number;
    /** Whether the reference list was cut. */
    readonly referencesTruncated: boolean;
    /** Creation stamp. */
    readonly createdAt: string;
    /** Last-mutation stamp. */
    readonly updatedAt: string;
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
export function parseRunScalars(raw: Record<string, unknown>): RunScalars | null {
    const line = readStateLine(raw);
    const { subjectType } = raw;
    if (line === null || (subjectType !== 'issue' && subjectType !== 'pull_request')) {
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
        referencesNotRetained: notRetained as number,
        referencesTruncated: truncated,
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
