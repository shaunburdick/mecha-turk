/**
 * Bounded in-memory ring of the service's own emitted log lines: memory only,
 * so no file exists for it and a restart empties it.
 */

/** Retained lines, and the ceiling the logs route's `limit` clamp reads. */
export const LOG_RING_CAPACITY = 1_000;

/** One retained line under the sequence number `append` gave it. */
export interface LogRingEntry {
    /** Per-process monotonic sequence; never reused once an entry is evicted. */
    readonly seq: number;
    /** The serialized line, byte-identical to the one the sink received. */
    readonly line: string;
}

/** The retained stream: append-only, drop-oldest, read back in ascending `seq`. */
export interface LogRing {
    append(line: string): void;
    entries(): readonly LogRingEntry[];
}

/**
 * Create an empty ring. `seq` is assigned **before** the drop decision, so
 * evicting the oldest entry never renumbers a survivor or reissues its number
 * to a later line — a cursor taken across the drop still resumes correctly.
 */
export function createLogRing(): LogRing {
    const held: LogRingEntry[] = [];
    let nextSeq = 0;

    return {
        append: (line: string): void => {
            const seq = nextSeq;
            nextSeq += 1;
            held.push({ seq, line });
            if (held.length > LOG_RING_CAPACITY) {
                held.shift();
            }
        },
        entries: (): readonly LogRingEntry[] => held,
    };
}
