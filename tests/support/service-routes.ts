/**
 * Shared helpers for the loopback service's route and store suites.
 *
 * Three shapes were rebuilt file-by-file across the service suites: the
 * `content-type` header every JSON POST carries, the capturing logger a store
 * test reads its output through, and the `GET /v1/config` envelope the settings
 * tab renders. Each lives here once, defaults to the least surprising answer,
 * and takes only what a suite deliberately varies — so a change to one of these
 * wire shapes is fixed once instead of once per suite.
 *
 * Nothing here touches a network: headers are plain maps and the logger writes
 * into an array.
 */

import { DEFAULT_CONFIG } from '../../service/config.ts';
import { configSchema } from '../../service/config-schema.ts';
import { createLogger } from '../../service/log.ts';
import type { ServiceLogger } from '../../service/log.ts';

/** The `content-type` header name every JSON request carries. */
export const CONTENT_TYPE_HEADER = 'content-type';

/**
 * Build a header map without writing HTTP header names as object keys.
 *
 * @returns The headers as `fetch` accepts them.
 */
export function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/**
 * Headers for every route that takes a JSON body.
 *
 * @returns A fresh map, safe for a caller to spread its own members into.
 */
export function jsonHeaders(): Record<string, string> {
    return headerMap([[CONTENT_TYPE_HEADER, 'application/json']]);
}

/** A logger that keeps every line it was asked to write. */
export interface LogCapture {
    /** The real logger under test; identical to what production runs. */
    readonly log: ServiceLogger;
    /** Lines the sink received, in order. */
    readonly lines: string[];
}

/**
 * Build the real logger with a sink that records instead of printing.
 *
 * @param level - Threshold the logger starts from; `debug` admits everything.
 * @returns The logger plus the lines it captures.
 */
export function capturingLogger(level: 'debug' | 'info' | 'warn' | 'error' = 'debug'): LogCapture {
    const lines: string[] = [];
    const log = createLogger({ level, sink: (line) => void lines.push(line) });

    return { log, lines };
}

/** Members a `GET /v1/config` body can carry besides its `config` document. */
export interface ConfigEnvelopeOptions {
    /** The config document; defaults to the whole of {@link DEFAULT_CONFIG}. */
    readonly config?: Record<string, unknown>;
    /** Replacement for the descriptor list. */
    readonly fields?: readonly unknown[];
    /** Replacement for the source member. */
    readonly source?: unknown;
    /** Replacement for the filled-keys list. */
    readonly defaultsApplied?: unknown;
}

/**
 * Build one `GET /v1/config` body, assembled the way the service sends it.
 *
 * The config document replaces rather than merges: a suite that varies one
 * config value passes the whole document it means (`{ ...DEFAULT_CONFIG,
 * ... }`), so a fixture can never quietly grow a field the case did not
 * arrange. The other members answer **by presence** — an explicitly supplied
 * `source` of `null` is carried through as `null`, which is exactly the
 * malformed member a refusal case plants — never by value coalescing.
 *
 * @returns The serialized envelope.
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
