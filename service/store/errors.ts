/**
 * Failures the durable store raises when the operator's data directory
 * cannot be used.
 */

/** Machine-readable code the HTTP layer returns alongside the 503. */
export const STORAGE_UNAVAILABLE_CODE = 'storage-unavailable';

/**
 * Raised when the store directory or one of its files cannot be created,
 * read, renamed, or written.
 */
export class StorageUnavailableError extends Error {
    /** Stable machine-readable marker so callers and tests can discriminate. */
    public override readonly name = 'StorageUnavailableError';

    /** Wire code returned with a 503, per the error catalog. */
    public readonly code = STORAGE_UNAVAILABLE_CODE;

    public constructor(message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
    }
}
