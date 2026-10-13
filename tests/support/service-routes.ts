/**
 * Shared helpers for the loopback service's route and store suites; each defaults to the least
 * surprising answer and takes only what a suite deliberately varies.
 */

import { DEFAULT_CONFIG } from '../../service/config.ts';
import { configSchema } from '../../service/config-schema.ts';
import { createLogger } from '../../service/log.ts';
import type { ServiceLogger } from '../../service/log.ts';

export const CONTENT_TYPE_HEADER = 'content-type';

/** Build a header map without writing HTTP header names as object keys. */
export function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

export function jsonHeaders(): Record<string, string> {
    return headerMap([[CONTENT_TYPE_HEADER, 'application/json']]);
}

export interface LogCapture {
    /** The real logger under test; identical to what production runs. */
    readonly log: ServiceLogger;
    /** Lines the sink received, in order. */
    readonly lines: string[];
}

export function capturingLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): LogCapture {
    const lines: string[] = [];
    const log = createLogger({ level, sink: (line) => void lines.push(line) });

    return { log, lines };
}

/** Options for {@link configEnvelope}. */
export interface ConfigEnvelopeOptions {
    readonly config?: Record<string, unknown>;
    readonly fields?: readonly unknown[];
    readonly source?: unknown;
    readonly defaultsApplied?: unknown;
}

/**
 * Build one `GET /v1/config` body, assembled the way the service sends it: the config document
 * replaces rather than merges (a suite that varies one value passes the whole document it means),
 * and the other members answer **by presence** — a supplied `source` of `null` is carried through
 * as `null`, the malformed member a refusal case plants, never coalesced away.
 */
export function configEnvelope(options: ConfigEnvelopeOptions = {}): string {
    const hasMember = (member: keyof ConfigEnvelopeOptions): boolean => Object.hasOwn(options, member);

    return JSON.stringify({
        config: options.config ?? { ...DEFAULT_CONFIG },
        fields: hasMember('fields') ? options.fields : configSchema(),
        source: hasMember('source') ? options.source : 'stored',
        defaultsApplied: hasMember('defaultsApplied') ? options.defaultsApplied : [],
    });
}
