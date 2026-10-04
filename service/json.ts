/**
 * JSON helpers shared by the service's store and configuration layers.
 *
 * Every document that enters the service — a store file read from disk or a
 * request body arriving from the panel — is parsed first and *then* checked,
 * so no module downstream ever receives an unshaped value. Parsing is
 * non-throwing on purpose: a corrupt file must be quarantined and the service
 * must keep serving, never fail stuck (data-model.md, storage tier 1).
 */

/** Outcome of parsing text that may not be JSON at all. */
export type JsonParseOutcome =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false };

/**
 * Parse serialized JSON without throwing.
 *
 * @param text - Candidate JSON text.
 * @returns The parsed value, or `{ ok: false }` when the text is not JSON.
 */
export function parseJsonText(text: string): JsonParseOutcome {
    try {
        const value: unknown = JSON.parse(text);

        return { ok: true, value };
    } catch {
        return { ok: false };
    }
}

/**
 * Narrow an unknown value to a plain JSON object.
 *
 * Arrays, `null`, and primitives are rejected so callers can index into the
 * result without widening every read back to `unknown`.
 *
 * @param value - Candidate value, typically from {@link parseJsonText}.
 * @returns `true` when the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one value as non-empty text.
 *
 * @param value - Candidate value from a parsed document or body.
 * @returns The text, or `null` when it is not usable text.
 */
export function readText(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read one value as display text: type-checked only, because the value is
 * reported by a caller (or the host) rather than built from validated input.
 *
 * @param value - Candidate value.
 * @returns The text, or `null` when it is not a string.
 */
export function readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Read one value as an RFC 3339 stamp.
 *
 * @param value - Candidate value.
 * @returns The stamp, or `null` when it does not parse as a date.
 */
export function readStamp(value: unknown): string | null {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Read one value as a non-negative integer.
 *
 * @param value - Candidate value.
 * @returns The integer, or `null`.
 */
export function readCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Read one value as a positive integer.
 *
 * @param value - Candidate value.
 * @returns The integer, or `null`.
 */
export function readPositiveInt(value: unknown): number | null {
    const parsed = readCount(value);

    return parsed !== null && parsed >= 1 ? parsed : null;
}

/**
 * Read one value as a boolean.
 *
 * @param value - Candidate value.
 * @returns The flag, or `null` when it is neither `true` nor `false`.
 */
export function readFlag(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}
