/** The stdlib fetch client for the engine's loopback API: Basic auth, a bounded timeout, no redirect following. */

import { isRecord } from '../json.ts';

export const ENGINE_AUTH_USERNAME = 'opencode';

export const ENGINE_TIMEOUT_MS = 10_000;

export type EngineAnswer =
    | { readonly kind: 'reply'; readonly status: number; readonly body: unknown }
    /** The one loopback failure that proves nothing arrived. */
    | { readonly kind: 'refused' }
    /** What the engine did is unknowable. */
    | { readonly kind: 'timeout' }
    | { readonly kind: 'transport' };

export interface EngineClient {
    readonly baseUrl: string;
    request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<EngineAnswer>;
}

type FailureKind = 'refused' | 'timeout' | 'transport';

function codeOf(cause: Error): string | undefined {
    const nested: unknown = 'cause' in cause ? cause.cause : undefined;
    if (isRecord(nested) && typeof nested.code === 'string') {
        return nested.code;
    }

    const own: unknown = 'code' in cause ? cause.code : undefined;

    return typeof own === 'string' ? own : undefined;
}

function failureKindOf(cause: unknown): FailureKind {
    if (!(cause instanceof Error)) {
        return 'transport';
    }

    if (cause.name === 'TimeoutError' || cause.name === 'AbortError') {
        return 'timeout';
    }

    return codeOf(cause) === 'ECONNREFUSED' ? 'refused' : 'transport';
}

// Built per attempt: no endpoint or credential is cached across cycles. The
// timeout override exists only so suites never wait out the live bound.
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
