/**
 * The eight-state dispatch vocabulary and its reader: an unknown state refuses the record (FR-074).
 */

export const PLAIN_RUN_STATES = [
    'pending',
    'claimed',
    'starting',
    'dispatched',
    'failed',
    'unconfirmed',
    'dead-lettered',
] as const;

export type PlainRunState = (typeof PLAIN_RUN_STATES)[number];

export type RunState = PlainRunState | `blocked:${string}`;

/** Prefix of the `blocked:<reason>` family (data-model §1). */
export const BLOCKED_PREFIX = 'blocked:';

/**
 * Check the reason half of a `blocked:<reason>` state: a non-empty kebab
 * token, never a fixed enum (data-model §1), and never an empty suffix.
 *
 * @returns `true` when every hyphen-separated part is lowercase alphanumeric.
 */
export function isBlockedReason(reason: string): boolean {
    if (reason === '') {
        return false;
    }

    return reason.split('-').every((part) => part !== '' && /^[a-z0-9]+$/.test(part));
}

/**
 * Narrow one raw state to the eight the service can answer with.
 *
 * An unknown state refuses the row, which refuses the body: the list must
 * never render a state it would then have to guess the tone of.
 *
 * @returns The state, or `null` when the value is unusable.
 */
export function runStateOf(value: unknown): RunState | null {
    if (typeof value !== 'string') {
        return null;
    }

    if ((PLAIN_RUN_STATES as readonly string[]).includes(value)) {
        return value as PlainRunState;
    }

    if (!value.startsWith(BLOCKED_PREFIX) || !isBlockedReason(value.slice(BLOCKED_PREFIX.length))) {
        return null;
    }

    return value as RunState;
}
