/**
 * JSON helpers shared by the service's store and configuration layers.
 */

/** Outcome of parsing text that may not be JSON at all. */
export type JsonParseOutcome =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false };

/**
 * Parse serialized JSON without throwing.
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
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one value as non-empty text.
 */
export function readText(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read one value as display text: type-checked only, because the value is
 * reported by a caller (or the host) rather than built from validated input.
 */
export function readString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Read one value as an RFC 3339 stamp.
 */
export function readStamp(value: unknown): string | null {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Read one value as a non-negative integer.
 */
export function readCount(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Read one value as a positive integer.
 */
export function readPositiveInt(value: unknown): number | null {
    const parsed = readCount(value);

    return parsed !== null && parsed >= 1 ? parsed : null;
}

/**
 */
export function readFlag(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}
