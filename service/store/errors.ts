/**
 * Failures the durable store raises when the operator's data directory cannot
 * be used.
 *
 * The HTTP layer maps {@link StorageUnavailableError} to
 * `503 storage-unavailable` (contract `panel-service.md` §4) so an unwritable
 * store surfaces as the documented setup-prerequisite failure (FR-039)
 * instead of crashing the service or failing a request with a misleading
 * generic error. Nothing in this module ever carries secret material: the
 * messages name paths and system causes only.
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

    /**
     * @param message - What failed and where; never secret material.
     * @param cause - The underlying system error, when one caused this failure.
     */
    public constructor(message: string, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
    }
}
