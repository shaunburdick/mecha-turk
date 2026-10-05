/**
 * Request-body reading for the loopback API.
 *
 * The host only proxies JSON bodies it has already capped, but the service
 * enforces its own limit on its own listener (contract §1: 60,000 characters
 * against the host's 64,000). Reading stops early if a caller streams past
 * the byte ceiling that no legal 60,000-character body can reach, and the
 * result always reports whether the bytes were consumed — the pipeline closes
 * the connection whenever it answers without draining the body, so a refused
 * request can never be mistaken for the start of the next keep-alive one.
 */

import type { IncomingMessage } from 'node:http';
import { parseJsonText } from './json.ts';
import { REQUEST_BODY_MAX_CHARS } from './http.ts';

/** Worst-case bytes one UTF-16 code unit can occupy in UTF-8 (a 4-byte pair). */
const BYTES_PER_UTF16_UNIT = 3;

/** Hard ceiling while buffering; above this the body is certainly too large. */
const REQUEST_BODY_MAX_BYTES = REQUEST_BODY_MAX_CHARS * BYTES_PER_UTF16_UNIT;

/** Outcome of draining the request stream. */
type BufferOutcome =
    | { readonly kind: 'complete'; readonly chunks: readonly Buffer[] }
    | { readonly kind: 'too-large' }
    | { readonly kind: 'aborted' };

/** Outcome of reading and parsing one request body. */
export interface BodyReadResult {
    /** What the reader found. */
    readonly status: 'empty' | 'ok' | 'invalid-json' | 'too-large';
    /** Whether every declared byte was consumed; `false` means close the connection. */
    readonly consumed: boolean;
    /** Parsed JSON, present only when `status` is `ok`. */
    readonly value?: unknown;
}

/**
 * Drain the request stream into memory, bounded by the byte ceiling.
 *
 * @returns The collected chunks, or why collection stopped.
 */
function readBytes(request: IncomingMessage): Promise<BufferOutcome> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let isSettled = false;
        const finish = (outcome: BufferOutcome): void => {
            if (isSettled) {
                return;
            }

            isSettled = true;
            resolve(outcome);
        };

        request.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > REQUEST_BODY_MAX_BYTES) {
                // Drain what is already in flight so the 413 still reaches the
                // caller; Node's request timeout bounds a stream that never ends.
                request.resume();
                finish({ kind: 'too-large' });
                return;
            }

            chunks.push(chunk);
        });
        request.on('end', () => {
            finish({ kind: 'complete', chunks });
        });
        request.on('error', () => {
            finish({ kind: 'aborted' });
        });
        request.on('close', () => {
            finish({ kind: 'aborted' });
        });
    });
}

/**
 *
 * @param request - Incoming message from the host proxy.
 * @returns The parsed value, an empty/invalid/too-large marker, and whether
 *   the stream was fully consumed.
 */
export async function readJsonBody(request: IncomingMessage): Promise<BodyReadResult> {
    const outcome = await readBytes(request);
    if (outcome.kind === 'too-large') {
        return { status: 'too-large', consumed: false };
    }

    if (outcome.kind === 'aborted') {
        // A body that stops mid-flight is as unusable as malformed JSON; the
        // connection is gone anyway, so the caller closes rather than reuses it.
        return { status: 'invalid-json', consumed: false };
    }

    const text = Buffer.concat(outcome.chunks).toString('utf8');
    if (text === '') {
        return { status: 'empty', consumed: true };
    }

    if (text.length > REQUEST_BODY_MAX_CHARS) {
        return { status: 'too-large', consumed: true };
    }

    const parsed = parseJsonText(text);
    if (!parsed.ok) {
        return { status: 'invalid-json', consumed: true };
    }

    return { status: 'ok', consumed: true, value: parsed.value };
}
