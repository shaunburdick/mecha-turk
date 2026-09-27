/**
 * Typed bridge between `JSON.stringify` output and the host's `JsonValue`.
 *
 * `host.storage.set` accepts only the SDK's `JsonValue`. Rather than casting an
 * `any` through `JSON.parse`, this module parses and then *checks* the shape,
 * so the value handed to the host is proven to be plain JSON before it is
 * written.
 */

import type { JsonValue } from '@openchamber/sdk';

/** Encoder reused for every byte measurement; `TextEncoder` is stateless per call. */
const UTF8_ENCODER = new TextEncoder();

/**
 * Measure text the way the host measures stored values: UTF-8 bytes.
 *
 * The host refuses a `host.storage.set` value whose UTF-8 encoding exceeds
 * `GUEST_STORAGE_VALUE_BYTES`, while `String.length` counts UTF-16 code units
 * — two units for a character the encoder writes as four bytes. Measuring in
 * bytes keeps the spike's own gate honest against the host's own limit.
 *
 * @param text - Serialized text, typically `JSON.stringify` output.
 * @returns The length of the text in UTF-8 bytes.
 */
export function utf8ByteLength(text: string): number {
    return UTF8_ENCODER.encode(text).length;
}

/**
 * Raised when serialized JSON does not parse into the host's value type.
 */
export class JsonShapeError extends Error {
    /** Stable machine-readable marker so callers can discriminate. */
    public override readonly name = 'JsonShapeError';

    /**
     * @param path - Location of the offending value inside the document.
     */
    public constructor(path: string) {
        super(`value at ${path} is not plain JSON`);
    }
}

/**
 * Check that an unknown value is a JSON value.
 *
 * @param value - Candidate value, typically straight out of `JSON.parse`.
 * @returns `true` for strings, finite numbers, booleans, arrays, and objects.
 */
export function isJsonValue(value: unknown): value is JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value);
    }

    if (Array.isArray(value)) {
        return value.every(isJsonValue);
    }

    if (typeof value === 'object') {
        return Object.values(value).every(isJsonValue);
    }

    return false;
}

/**
 * Parse serialized JSON into a `JsonValue`, checking the shape first.
 *
 * @param text - Serialized JSON produced by this extension.
 * @returns The value, safe to hand to `host.storage.set`.
 * @throws {JsonShapeError} When the document is not valid JSON.
 */
export function parseJsonValue(text: string): JsonValue {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch {
        throw new JsonShapeError('$');
    }

    if (!isJsonValue(parsed)) {
        throw new JsonShapeError('$');
    }

    return parsed;
}
