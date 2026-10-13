/**
 * The row-text bound every audit row in this family shares (003 FR-003,
 * 006 FR-053; FR-014's own convention).
 */

/** Longest free text one detail value may carry. */
export const MAX_ROW_TEXT_CHARS = 500;

/** The marker appended to text this module had to cut. */
export const TEXT_TRUNCATION_MARKER = '… [truncated]';

/**
 * Bound one value, marking it when it was cut.
 *
 */
export function boundText(value: string): string {
    if (value.length <= MAX_ROW_TEXT_CHARS) {
        return value;
    }

    return `${value.slice(0, MAX_ROW_TEXT_CHARS)}${TEXT_TRUNCATION_MARKER}`;
}

/**
 * {@link boundText} for the optional members, which pass `null` through.
 *
 * @returns The bounded value, or `null`.
 */
export function rowText(value: string | null): string | null {
    return value === null ? null : boundText(value);
}
