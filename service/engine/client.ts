/**
 * The stdlib fetch client for the engine's loopback API: Basic auth, a bounded
 * timeout, and no redirect following (FR-104 span A; research §2.6).
 */

import { isRecord } from '../json.ts';

/** Username the engine's Basic auth demands. */
export const ENGINE_AUTH_USERNAME = 'opencode';

/** Bound on one engine call; loopback answers in milliseconds or not at all. */
export const ENGINE_TIMEOUT_MS = 10_000;

/** One engine answer, after the transport itself has been classified. */
export type EngineAnswer =
    /** A reply arrived; `body` is the parsed JSON, or `null` when unparseable. */
    | { readonly kind: 'reply'; readonly status: number; readonly body: unknown }
    /** Connection refused: the one loopback failure that proves nothing arrived. */
    | { readonly kind: 'refused' }
    /** The bounded timeout expired; what the engine did is unknowable. */
    | { readonly kind: 'timeout' }
    /** Any other transport failure; treated as ambiguously delivered. */
    | { readonly kind: 'transport' };

export interface EngineClient {
    readonly baseUrl: string;
    request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<EngineAnswer>;
}

/** The failure kind a thrown fetch lands in once its cause chain is read. */
type FailureKind = 'refused' | 'timeout' | 'transport';

/** The error code one caught value carries, one level of `cause` deep. */
function codeOf(cause: Error): string | undefined {
    const nested: unknown = 'cause' in cause ? cause.cause : undefined;
    if (isRecord(nested) && typeof nested.code === 'string') {
        return nested.code;
    }

    const own: unknown = 'code' in cause ? cause.code : undefined;

    return typeof own === 'string' ? own : undefined;
}

/** Classify a thrown fetch failure by its error chain, one level of cause deep. */
function failureKindOf(cause: unknown): FailureKind {
    if (!(cause instanceof Error)) {
        return 'transport';
    }

    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
        return 'timeout';
    }

    return codeOf(cause) === 'ECONNREFUSED' ? 'refused' : 'transport';
}

/**
 * Build the engine client: one base URL and one password, both read per
 * attempt from the discovery and token layers, so no endpoint or credential is
 * cached across cycles (research §2.6). The timeout override exists for
 * suites, which must never wait out the live bound.
 */
export function engineClient(input: {
    readonly baseUrl: string;
    readonly password: string;
    readonly timeoutMs?: number | undefined;
}): EngineClient {
    return {
        baseUrl: input.baseUrl,
        request: async (method, path, body) => {
            const credential = Buffer.from(`${ENGINE_AUTH_USERNAME}:${input.password}`).toString('base64');
            try {
                const response = await fetch(`${input.baseUrl}${path}`, {
                    method,
                    headers: {
                        authorization: `Basic ${credential}`,
                        ...(body !== undefined && { 'content-type': 'application/json' }),
                    },
                    // A redirect could point the loopback call off-machine; the
                    // engine's own routes never issue one.
                    redirect: 'manual',
                    signal: AbortSignal.timeout(input.timeoutMs ?? ENGINE_TIMEOUT_MS),
                    ...(body !== undefined && { body: JSON.stringify(body) }),
                });

                let parsed: unknown = null;
                try {
                    parsed = JSON.parse(await response.text()) as unknown;
                } catch {
                    parsed = null;
                }

                return { kind: 'reply', status: response.status, body: parsed };
            } catch (cause) {
                return { kind: failureKindOf(cause) };
            }
        },
    };
}
