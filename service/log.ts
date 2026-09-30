/**
 * Structured, secret-free logging for the service.
 *
 * Lines are single JSON objects with a static message and dynamic values in a
 * separate fields object, so the output is grep-able and machine-readable
 * without string interpolation. Before anything reaches the sink it passes
 * through the extension's redaction helpers (NFR-004): a token that ever ends
 * up in a field is replaced with `[redacted:<label>]` on the way out, making
 * "secrets never appear in logs" an executable property rather than a promise
 * (constitution Principle IV).
 */

import { redact } from '../src/redaction.ts';

/** Log verbosity, ordered from most to least chatty. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Scalar values a log field may hold; objects are stringified by the caller. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** Severity ranks used to drop entries below the configured threshold. */
const SEVERITY: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One log entry after the level filter has accepted it. */
interface PendingEntry {
    readonly level: LogLevel;
    readonly message: string;
    readonly fields: LogFields;
}

/** The service's logger surface; every method takes a static message. */
export interface ServiceLogger extends LoggerControl {
    /** Log a diagnostic entry at `debug`. */
    debug(message: string, fields?: LogFields): void;
    /** Log a normal lifecycle entry at `info`. */
    info(message: string, fields?: LogFields): void;
    /** Log a degraded-but-recoverable entry at `warn`. */
    warn(message: string, fields?: LogFields): void;
    /** Log a failure entry at `error`. */
    error(message: string, fields?: LogFields): void;
}

/**
 * The logger's movable half: the threshold stops being a construction
 * constant (006 FR-033, FR-037).
 *
 * Every logger in the tree comes from {@link createLogger}, so requiring this
 * half of the surface on {@link ServiceLogger} is enough for `startService`
 * (adopt the stored level once the store opens) and `PUT /v1/config` (apply an
 * accepted level before the answer is sent) to share one mechanism.
 */
export interface LoggerControl {
    /**
     * Move the severity threshold.
     *
     * The **next** entry is judged against the new level — there is no queue
     * to drain and no restart to survive, which is exactly what makes
     * `logLevel` `immediate` rather than `next-cycle`.
     *
     * @param level - Threshold the emit path reads from now on.
     */
    setLevel(level: LogLevel): void;
}

/** Logger construction options. */
export interface LoggerOptions {
    /** Threshold; entries below it are dropped. */
    readonly level: LogLevel;
    /** Where finished lines go; defaults to standard output. */
    readonly sink?: (line: string) => void;
}

/**
 * Turn a caught value into a log-safe one-line description.
 *
 * @param error - Any caught value.
 * @returns The error's message, or a stringified fallback for non-errors.
 */
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Serialize one entry as a JSON line, redacting secret-shaped text.
 *
 * @param entry - The entry that passed the level filter.
 * @returns The line, terminated by a newline.
 */
function serialize(entry: PendingEntry): string {
    const raw = JSON.stringify({
        ts: new Date().toISOString(),
        level: entry.level,
        message: entry.message,
        ...entry.fields,
    });

    return `${redact(raw)}\n`;
}

/**
 * Create a level-filtered logger whose threshold can be moved at runtime.
 *
 * The emit path reads the **current** threshold per entry rather than a value
 * captured at construction, so `setLevel` changes the very next line with no
 * restart (006 FR-033). The redaction pass runs after the filter, unchanged:
 * a level change can decide *whether* a line is written, never *what* it says.
 *
 * @param options - Level plus an optional sink (tests capture lines here).
 * @returns The logger handed to routes and the pipeline.
 */
export function createLogger(options: LoggerOptions): ServiceLogger {
    const sink =
        options.sink ??
        ((line: string): void => {
            process.stdout.write(line);
        });
    let threshold = SEVERITY[options.level];
    const emit = (entry: PendingEntry): void => {
        if (SEVERITY[entry.level] < threshold) {
            return;
        }

        sink(serialize(entry));
    };

    return {
        setLevel: (level: LogLevel): void => {
            threshold = SEVERITY[level];
        },
        debug: (message, fields = {}) => emit({ level: 'debug', message, fields }),
        info: (message, fields = {}) => emit({ level: 'info', message, fields }),
        warn: (message, fields = {}) => emit({ level: 'warn', message, fields }),
        error: (message, fields = {}) => emit({ level: 'error', message, fields }),
    };
}
