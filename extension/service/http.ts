/**
 * Loopback HTTP transport rules shared by the pipeline and every route.
 *
 * The numbers here are the pinned guest-contract legs (`contract.d.ts` via
 * 002 research R4) restated for the service side: path ≤ 2,000 characters,
 * request body ≤ 60,000 characters (the host caps at 64,000 and the service
 * keeps a margin), response ≤ 256,000 characters with pagination rather than
 * truncation, methods `GET`/`POST`/`PUT`/`DELETE`. Errors always use the
 * `{ error: { code, message, correlationId? } }` envelope from contract §1.
 */

/** The single interface the service binds; never `0.0.0.0`. */
export const LOOPBACK_HOST = '127.0.0.1';

/** Longest request target accepted (`GUEST_REQUEST_PATH_MAX`). */
const MAX_TARGET_CHARS = 2_000;

/** Longest request body accepted, in characters (contract §1). */
export const REQUEST_BODY_MAX_CHARS = 60_000;

/** Longest serialized response accepted (`GUEST_REQUEST_RESPONSE_MAX`). */
const RESPONSE_BODY_MAX_CHARS = 256_000;

/** Content type written on every response. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** HTTP status codes the service emits (contract §4 error catalog). */
export const STATUS = {
    ok: 200,
    badRequest: 400,
    unauthorized: 401,
    notFound: 404,
    methodNotAllowed: 405,
    payloadTooLarge: 413,
    validation: 422,
    internal: 500,
    storageUnavailable: 503,
} as const;

/** Fields of the error envelope every failure uses (contract §1). */
export interface ErrorDetails {
    /** Stable machine-readable code from the catalog. */
    readonly code: string;
    /** Human-readable text; never contains token material. */
    readonly message: string;
    /** Chain identifier when the failure is unexpected. */
    readonly correlationId?: string;
}

/** The wire shape of an error body. */
export interface ErrorBody {
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly correlationId?: string;
    };
}

/** One response the pipeline writes to the host proxy. */
export interface HttpResponse {
    /** HTTP status code. */
    readonly status: number;
    /** JSON-serialisable body. */
    readonly body: unknown;
    /** Extra headers, merged over the defaults. */
    readonly headers?: Readonly<Record<string, string>>;
}

/** Outcome of serializing a response body against the leg's size cap. */
export type SerializedBody =
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly fallback: HttpResponse };

/**
 * Build the standard error envelope.
 *
 * @param details - Code, message, and optional correlation id.
 * @returns The envelope body.
 */
export function errorBody(details: ErrorDetails): ErrorBody {
    if (details.correlationId === undefined) {
        return { error: { code: details.code, message: details.message } };
    }

    return { error: { code: details.code, message: details.message, correlationId: details.correlationId } };
}

/**
 * Build an error response.
 *
 * @param status - HTTP status code.
 * @param details - Code, message, and optional correlation id.
 * @returns The response to write.
 */
export function errorResponse(status: number, details: ErrorDetails): HttpResponse {
    return { status, body: errorBody(details) };
}

/**
 * The one definition of the 401 response.
 *
 * Missing, malformed, and wrong tokens all reach this function, which is what
 * makes the refusal byte-identical across them (contract §3 invariant 1: no
 * authentication oracle).
 *
 * @returns The uniform unauthorized response.
 */
export function unauthorizedResponse(): HttpResponse {
    return errorResponse(STATUS.unauthorized, {
        code: 'unauthorized',
        message: 'service authentication failed',
    });
}

/**
 * The documented refusal when the data directory cannot serve a request.
 *
 * FR-039 names unavailable storage as a setup prerequisite failure the panel
 * must surface explicitly rather than start degraded, which is why this is a
 * stable code the panel can render guidance for.
 *
 * @returns The `503 storage-unavailable` response (contract §4).
 */
export function storageUnavailableResponse(): HttpResponse {
    return errorResponse(STATUS.storageUnavailable, {
        code: 'storage-unavailable',
        message: 'the data directory is not writable; setup cannot continue until it is',
    });
}

/**
 * Parse and confine a request target to this service.
 *
 * @param raw - `req.url`, normally an origin-form path with an optional query.
 * @returns The parsed URL, or `null` when the target is absolute-form,
 *   protocol-relative, overlong, or aimed at another host.
 */
export function parseRequestTarget(raw: string | undefined): URL | null {
    if (raw === undefined || !raw.startsWith('/') || raw.length > MAX_TARGET_CHARS) {
        return null;
    }

    try {
        const url = new URL(raw, `http://${LOOPBACK_HOST}`);

        return url.host === LOOPBACK_HOST ? url : null;
    } catch {
        return null;
    }
}

/**
 * Serialize a response body against the documented size cap.
 *
 * A body over the cap is replaced by an explicit error rather than truncated
 * silently: contract §1 says the service measures before writing and never
 * ships half a payload.
 *
 * @param body - JSON-serialisable response body.
 * @returns The serialized text, or a small fallback response to send instead.
 */
export function serializeBody(body: unknown): SerializedBody {
    try {
        const text = JSON.stringify(body);
        if (text.length > RESPONSE_BODY_MAX_CHARS) {
            return {
                ok: false,
                fallback: errorResponse(STATUS.internal, {
                    code: 'response-too-large',
                    message: 'response exceeded the documented size cap; paginate instead',
                }),
            };
        }

        return { ok: true, text };
    } catch {
        return {
            ok: false,
            fallback: errorResponse(STATUS.internal, {
                code: 'internal',
                message: 'response could not be serialized',
            }),
        };
    }
}
