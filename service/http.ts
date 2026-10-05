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

/**
 * Longest serialized response accepted (`GUEST_REQUEST_RESPONSE_MAX`).
 *
 * Exported because a route that *builds* a list must bound it against this
 * ceiling itself rather than discover the ceiling at write time: a list that is
 * only discovered to be too large has already taken its side effects (the claim
 * route's leases are the case that matters — contract §1 requires pagination,
 * never truncation).
 */
export const RESPONSE_BODY_MAX_CHARS = 256_000;

/** Content type written on every response. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Longest unknown **field name** a `422` echoes back.
 *
 * A member name is submitted input too, so the envelope that restates every
 * `field: remediation` pair bounds it: a name longer than this is cut rather
 * than carried whole into `issues[].field` and the `message` built from it.
 * It lives here — beside {@link validationResponse}, the builder that restates
 * the name — so the configuration document and the account profile body read
 * one bound instead of two that could drift (006's unknown-field rule,
 * mirrored by the profile route's closed-body rule).
 */
export const MAX_ECHOED_FIELD_CHARS = 64;

/**
 * Bound one unknown field name before it is echoed back.
 *
 * @param name - The offending key, exactly as it arrived.
 * @returns The name cut to {@link MAX_ECHOED_FIELD_CHARS} with a trailing
 *   ellipsis when it is longer, otherwise the name unchanged.
 */
export function truncatedFieldName(name: string): string {
    return name.length > MAX_ECHOED_FIELD_CHARS ? `${name.slice(0, MAX_ECHOED_FIELD_CHARS)}…` : name;
}

/** HTTP status codes the service emits (contract §4 error catalog). */
export const STATUS = {
    ok: 200,
    created: 201,
    badRequest: 400,
    unauthorized: 401,
    notFound: 404,
    methodNotAllowed: 405,
    conflict: 409,
    payloadTooLarge: 413,
    validation: 422,
    tooManyRequests: 429,
    internal: 500,
    badGateway: 502,
    storageUnavailable: 503,
} as const;

/**
 * Fields of the error envelope every failure uses (contract §1).
 *
 * The optional members are the ratified supersets the §1 grammar names:
 * `issues` for `422 validation` (Wave 1) and `reasonClass` for
 * `422 credential-rejected` (SEC-03, ratified by T-009m). Every builder in
 * this module goes through {@link errorBody}, so the wire shape and the type
 * cannot drift apart (review L13).
 */
export interface ErrorDetails {
    /** Stable machine-readable code from the catalog. */
    readonly code: string;
    /** Human-readable text; never contains token material. */
    readonly message: string;
    /** Chain identifier when the failure is unexpected. */
    readonly correlationId?: string;
    /** Field-level remediation list for `422 validation` (never echoes values). */
    readonly issues?: readonly FieldIssue[];
    /** Machine-readable rejection class for `422 credential-rejected` (§4). */
    readonly reasonClass?: string;
}

/** The wire shape of an error body. */
export interface ErrorBody {
    readonly error: {
        readonly code: string;
        readonly message: string;
        readonly correlationId?: string;
        readonly issues?: readonly FieldIssue[];
        readonly reasonClass?: string;
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
 * One rejected field: its name plus how to fix it.
 *
 * The pair is the whole vocabulary a validation error may use — a received
 * value is never echoed, at any level, in any format (SEC-11 / contract §1).
 */
export interface FieldIssue {
    /** Name of the offending field, or `'body'` for a structurally invalid body. */
    readonly field: string;
    /** Operator-facing remediation text; never quotes what was received. */
    readonly remediation: string;
}

/**
 * Build the standard error envelope.
 *
 * Optional members are copied through only when present, so `exactOptional`
 * types and the JSON wire shape agree: an absent `correlationId`, `issues`, or
 * `reasonClass` is omitted from the body rather than written as `null`.
 *
 * @returns The envelope body.
 */
export function errorBody(details: ErrorDetails): ErrorBody {
    return {
        error: {
            code: details.code,
            message: details.message,
            ...(details.correlationId !== undefined && { correlationId: details.correlationId }),
            ...(details.issues !== undefined && { issues: details.issues }),
            ...(details.reasonClass !== undefined && { reasonClass: details.reasonClass }),
        },
    };
}

/**
 * Build an error response.
 */
export function errorResponse(status: number, details: ErrorDetails): HttpResponse {
    return { status, body: errorBody(details) };
}

/**
 * Build the contract's `422 validation` response for a list of field issues.
 *
 * The body is the ratified superset of the §1 error envelope: `message`
 * restates every `field: remediation` pair so an envelope-only consumer can
 * render it verbatim, while `issues` carries the structured list. No submitted
 * value appears anywhere in either form.
 *
 * @returns The `validation` error response (contract §4).
 */
export function validationResponse(issues: readonly FieldIssue[]): HttpResponse {
    return errorResponse(STATUS.validation, {
        code: 'validation',
        message: issues.map((issue) => `${issue.field}: ${issue.remediation}`).join('; '),
        issues,
    });
}

/** Response header carrying a throttle's wait time, in seconds (RFC 9110). */
const RETRY_AFTER_HEADER = 'retry-after';

/** Inputs for {@link throttleResponse}. */
export interface ThrottleOptions {
    /** HTTP status; the catalog uses `429` for both throttle codes. */
    readonly status: number;
    /** Catalog code: `verify-busy` or `rate-limited`. */
    readonly code: string;
    /** Fixed, secret-free explanation. */
    readonly message: string;
    /** Seconds the caller should wait before retrying. */
    readonly retryAfterSeconds: number;
}

/**
 * Build a throttled response that tells the caller when to come back.
 *
 * The body stays inside the error envelope so the panel can render its delay
 * copy from a code rather than from prose (contract §4 `rate-limited` /
 * `verify-busy`), and the wait travels in the documented `retry-after` header.
 *
 * @returns The response carrying the `retry-after` header.
 */
export function throttleResponse(options: ThrottleOptions): HttpResponse {
    const headers: Record<string, string> = { [RETRY_AFTER_HEADER]: String(options.retryAfterSeconds) };

    return {
        status: options.status,
        body: errorBody({ code: options.code, message: options.message }),
        headers,
    };
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
