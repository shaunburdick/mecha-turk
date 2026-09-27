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
