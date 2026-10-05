/**
 * The row-text bound every audit row in this family shares (003 FR-003,
 * 006 FR-053; FR-014's own convention).
 *
 * Split out of [`dispatch-audit.ts`](./dispatch-audit.ts) for the file-length
 * gate, and because "how long may a free-text detail be before it is cut" is a
 * **policy** with its own failure mode rather than a detail of row building: a
 * panel's `problem`, an operator's `note`, a guidance line, and the gate's denied
 * logins all land in a file nothing trims, so the bound is the only thing
 * standing between a hostile or careless value and unbounded durable growth on a
 * row that exists to be read.
 *
 * The bound is applied per **value**, not per row: a cut value is marked, so a
 * reader can tell a truncated one from a short one, and an array member is
 * bounded the same way a scalar member is.
 */

/** Longest free text one detail value may carry. */
export const MAX_ROW_TEXT_CHARS = 500;

/** The marker appended to text this module had to cut. */
export const TEXT_TRUNCATION_MARKER = '… [truncated]';

/**
 * Bound one value, marking it when it was cut.
 *
 * @param value - Panel-, operator-, or store-supplied text.
 * @returns The value within {@link MAX_ROW_TEXT_CHARS}, marked when cut.
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
