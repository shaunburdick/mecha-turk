/**
 * Per-binding scan state for the poll loop (MVP re-cut).
 *
 * `scan-state.json` records, per binding id, when the loop last completed a
 * scan and what (if anything) stopped it. A binding with no completed scan
 * (`lastScanAt: null`, or no slot at all) replays every open issue on its
 * next scan — pre-binding assignments included (product decision,
 * 2026-09-28) — and a recorded stamp arms the incremental window from then
 * on; this file is the simple stand-in for checkpoint architecture (debt
 * list).
 */

import { isRecord } from '../json.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';

/** Store file holding per-binding scan state. */
export const SCAN_STATE_FILE = 'scan-state.json';

/** One binding's last-scan record. */
export interface BindingScanState {
    /** RFC 3339 stamp of the last completed scan; `null` when none has. */
    readonly lastScanAt: string | null;
    /** Short machine reason the last scan skipped, else `null`. */
    readonly lastError: string | null;
}

/** Shape of the whole scan-state file. */
export interface ScanState {
    /**
     * One slot per binding; a slot whose `lastScanAt` is `null` records a
     * binding that has never completed a scan (its `lastError` says why).
     */
    readonly bindings: Readonly<Record<string, BindingScanState>>;
}

/**
 * Build the empty scan state.
 *
 * @returns A state with no recorded bindings.
 */
export function emptyScanState(): ScanState {
    return { bindings: {} };
}

/**
 * Validate a stored per-binding slot.
 *
 * `lastScanAt` is `string | null` exactly as {@link BindingScanState} writes
 * it: the scan loop records `null` for a binding that has never completed a
 * successful scan (a skip records the reason with no stamp), so requiring a
 * string here would refuse every file the loop itself just wrote and set the
 * whole document aside on each cycle.
 *
 * @param value - Candidate slot.
 * @returns The slot, or `null` when the shape is unusable.
 */
function parseBindingSlot(value: unknown): BindingScanState | null {
    if (!isRecord(value)) {
        return null;
    }

    const { lastScanAt, lastError } = value;
    const isStampHolds = lastScanAt === null || typeof lastScanAt === 'string';
    const isReasonHolds = lastError === null || typeof lastError === 'string';
    if (!isStampHolds || !isReasonHolds) {
        return null;
    }

    return {
        lastScanAt: typeof lastScanAt === 'string' ? lastScanAt : null,
        lastError: typeof lastError === 'string' ? lastError : null,
    };
}

/**
 * Parse a stored scan-state document.
 *
 * @returns The state, or `null` when the shape is unusable (quarantined).
 */
export function parseStoredScanState(raw: unknown): ScanState | null {
    if (!isRecord(raw) || !isRecord(raw.bindings)) {
        return null;
    }

    const bindings: Record<string, BindingScanState> = {};
    for (const [key, value] of Object.entries(raw.bindings)) {
        const slot = parseBindingSlot(value);
        if (slot === null) {
            return null;
        }

        bindings[key] = slot;
    }

    return { bindings };
}

/** In-flight chain scan-state mutations serialize onto (per-process only). */
const scanChain: { write: Promise<unknown> } = { write: Promise.resolve() };

/**
 * Serialize one scan-state read-modify-write.
 *
 * @param task - The work to chain.
 * @returns Whatever `task` produced.
 */
export function serializeScan<T>(task: () => Promise<T>): Promise<T> {
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs task on its own rejection; this runs once.
    const run = scanChain.write.then(task, task);
    scanChain.write = run;

    return run;
}

/**
 * Read the scan state, best-effort.
 *
 * @returns The state, or a fresh one when the file is absent/unusable.
 */
export async function readScanState(deps: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Logger. */
    readonly log: ServiceLogger;
}): Promise<ScanState> {
    const { store, log } = deps;
    try {
        const result = await store.readJson(SCAN_STATE_FILE, parseStoredScanState);
        if (result.status === 'ok') {
            return result.value;
        }

        if (result.status === 'quarantined') {
            log.warn('stored scan state was unusable and has been set aside', {
                quarantinePath: result.quarantinePath,
            });
        }

        return emptyScanState();
    } catch (cause) {
        log.warn('scan state read failed', { errorKind: cause instanceof Error ? cause.name : typeof cause });

        return emptyScanState();
    }
}

/**
 * Store the scan state atomically.
 */
export async function writeScanState(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** The state to keep. */
    readonly state: ScanState;
}): Promise<void> {
    await input.store.writeJson(SCAN_STATE_FILE, input.state);
}

/**
 * Set one binding's slot in the scan state.
 *
 * @param input - Current state and the slot to write.
 * @returns The next state.
 */
export function withBindingScanState(input: {
    /** Current state. */
    readonly state: ScanState;
    /** Binding whose slot is written. */
    readonly bindingId: string;
    /** The slot's new content. */
    readonly slot: BindingScanState;
}): ScanState {
    return { bindings: { ...input.state.bindings, [input.bindingId]: input.slot } };
}
