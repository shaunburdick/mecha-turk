/**
 * Per-binding scan state for the poll loop (MVP re-cut; three durable facts
 * added at 002 v1.13.0).
 *
 * `scan-state.json` records, per binding id, when the loop last completed a
 * scan and what (if anything) stopped it. A recorded `lastScanAt` arms the
 * incremental window from then on; a binding with none opens its first window
 * from the **baseline** its history scope fixes (`baselineAt`, added at v1.13.0
 * — 002 FR-066, FR-067). The "no completed scan replays everything" rule this
 * file used to state is retired as a window source (002 FR-065).
 *
 * **Four facts, four types, one writer each**, and the separation is structural
 * rather than a convention (002 FR-074, plan H4):
 *
 * | Member | Written by | Means |
 * | --- | --- | --- |
 * | `lastScanAt` | the poll loop, on a completing scan | a completed scan at this stamp |
 * | `baselineAt` | the poll loop, on a completing scan, **widened only** | the widest window ever scanned from |
 * | `forceReplay` | **only** the reset writes `true`; the loop may only clear it | cleared to recover a lost queue |
 * | `rescanFrom` | the bindings route alone | FR-023's one chosen lower bound for the next scan |
 *
 * The `forceReplay` row reads that way on purpose: the loop writes the member on
 * every scan, but **only the recovery path can write it `true`**, and a scan that
 * did not complete leaves a `true` value exactly where it found it (002 FR-074,
 * FR-076). `baselineAt`'s writer is the loop and its only operation is *earlier*,
 * so a replay re-covers at least everything an earlier scan covered (002 FR-073).
 *
 * "No completed scan" and "cleared to recover" must not be the same value or be
 * inferred from one another by any reader, so they are **two members**, each
 * validated independently by {@link parseBindingSlot}. A pre-amendment file —
 * carrying neither new member — still parses, and an absent `lastScanAt` is
 * never read as a flag: `forceReplay` defaults from its own absence alone.
 *
 * The slot is keyed by `bindingId` and **nothing prunes it**. The panel allocates
 * a new id per binding, so a removed-and-recreated binding gets a fresh slot and
 * a fresh baseline (002 FR-077), and a slot for a binding the document no longer
 * carries is inert because nothing reads it.
 */

import { isRecord } from '../json.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';

/** Store file holding per-binding scan state. */
export const SCAN_STATE_FILE = 'scan-state.json';

/** One binding's scan record: four facts, each with one writer. */
export interface BindingScanState {
    /** RFC 3339 stamp of the last completed scan; `null` when none has. */
    readonly lastScanAt: string | null;
    /** Short machine reason the last scan skipped, else `null`. */
    readonly lastError: string | null;
    /**
     * The retained lower bound for a binding with **no completed scan** — the
     * binding's creation boundary widened by the configured overlap under the
     * documented default mode, or one fixed look-back before that boundary under
     * the look-back mode (002 FR-066, FR-067).
     *
     * `null` means **not yet derived**, never "no baseline" and never "derive
     * this fresh": the loop derives it once and keeps it, which is what makes a
     * scan that fails three times and then succeeds still open at the window it
     * promised rather than at the last attempt's (002 FR-066, AC-036). Derived
     * from the **stored** creation stamp, because a corrupt one refuses rather
     * than silently becoming `now` (002 FR-072; plan H3).
     */
    readonly baselineAt: string | null;
    /**
     * Whether a **recovery replay** is in force: this binding's checkpoint was
     * cleared to recover a lost or quarantined event queue (002 FR-074).
     *
     * The recovery path is the only writer, and no reader infers this from an
     * absent `lastScanAt` — that absence means *never completed a scan*, which is
     * a different fact with a different window. A scan that does not complete
     * leaves it set (002 FR-076).
     */
    readonly forceReplay: boolean;
    /**
     * 002 FR-023's **one** rescan mechanism: a durable chosen lower bound for
     * this binding's next scan (plan H5).
     *
     * Its own member, never a reuse of `baselineAt`: the baseline is what a later
     * recovery replay has to cover, and overwriting it would change that. The
     * bindings route is the only writer; the loop clears it in the same atomic
     * write that advances `lastScanAt`, so a scan that does not complete leaves
     * it armed (002 FR-076; plan H7).
     */
    readonly rescanFrom: string | null;
}

/** Shape of the whole scan-state file. */
export interface ScanState {
    /**
     * One slot per binding; a slot whose `lastScanAt` is `null` records a
     * binding with no completed scan (its `lastError` says why, and its
     * `forceReplay` says whether that is because a recovery cleared it).
     */
    readonly bindings: Readonly<Record<string, BindingScanState>>;
}

/**
 * Build the slot a binding starts with: no completed scan, no baseline derived,
 * no replay in force, nothing armed.
 *
 * One constructor rather than four object literals at the call sites, so the
 * slot's **five** members are declared once and adding a fourth fact is a change
 * in one place.
 *
 * @returns The empty slot.
 */
export function emptyBindingScan(): BindingScanState {
    return { lastScanAt: null, lastError: null, baselineAt: null, forceReplay: false, rescanFrom: null };
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
 * Whether one optional stamp member holds a shape this build can read.
 *
 * Three accepted shapes and no fourth: **absent** (`undefined`, the pre-amendment
 * case), **explicitly null**, and a **string**. Anything else refuses the slot
 * rather than being silently defaulted — a stamp the reader cannot interpret is
 * not the same fact as no stamp at all, and defaulting it would move a window on
 * a value nobody chose (invariant 8).
 *
 * @param value - The stored member.
 * @returns `true` when the member is absent, `null`, or text.
 */
function optionalStampHolds(value: unknown): boolean {
    return value === undefined || value === null || typeof value === 'string';
}

/**
 * Narrow one already-validated optional stamp member to its stamp or `null`.
 *
 * Runs only after {@link optionalStampHolds} has accepted the member, so the
 * absent, `null`, and string cases are the only ones left.
 *
 * @param value - The stored member.
 * @returns The stamp, or `null` when there is none to read.
 */
function stampMemberOf(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/**
 * Validate a stored per-binding slot, **one member at a time** (002 FR-074).
 *
 * `lastScanAt` is `string | null` exactly as {@link BindingScanState} writes
 * it: the scan loop records `null` for a binding that has never completed a
 * successful scan (a skip records the reason with no stamp), so requiring a
 * string here would refuse every file the loop itself just wrote and set the
 * whole document aside on each cycle.
 *
 * The durable facts are validated **independently** because they are independent
 * facts with one writer each:
 *
 * - the three added at v1.13.0 each default from **their own** absence, so a
 *   file written before them parses into `baselineAt: null`, `forceReplay: false`,
 *   and `rescanFrom: null` — and, critically, **an absent `lastScanAt` is never
 *   read as `forceReplay`** (plan H4);
 * - a member of an unusable *type* refuses this slot, which quarantines the
 *   document rather than half-reading it: one bad member must not leave the
 *   others silently defaulted, and a file the store sets aside is at least visible
 *   to the operator (invariant 8).
 *
 * @returns The slot, or `null` when the shape is unusable.
 */
function parseBindingSlot(value: unknown): BindingScanState | null {
    if (!isRecord(value)) {
        return null;
    }

    // Two rules, and the difference between them is a decision:
    //
    // - the two members this file has always written must be **present** — the
    //   loop's own output never omits them, so an absent one is a file this build
    //   did not write and cannot judge;
    // - the three added at v1.13.0 may be **absent**, each defaulting from its own
    //   absence, which is exactly what lets a pre-amendment file parse and keeps an
    //   absent `lastScanAt` from being read as a replay flag (plan H4).
    //
    // One `holds` per member, and a single conjunction that refuses the whole slot
    // when any one of them is a type this build cannot judge.
    const { lastScanAt, lastError, baselineAt, forceReplay, rescanFrom } = value;
    const members: readonly (readonly [boolean, unknown])[] = [
        [lastScanAt === null || typeof lastScanAt === 'string', lastScanAt],
        [lastError === null || typeof lastError === 'string', lastError],
        [optionalStampHolds(baselineAt), baselineAt],
        [forceReplay === undefined || typeof forceReplay === 'boolean', forceReplay],
        [optionalStampHolds(rescanFrom), rescanFrom],
    ];
    if (members.some(([holds]) => !holds)) {
        return null;
    }

    return {
        lastScanAt: stampMemberOf(lastScanAt),
        lastError: stampMemberOf(lastError),
        baselineAt: stampMemberOf(baselineAt),
        forceReplay: forceReplay === true,
        rescanFrom: stampMemberOf(rescanFrom),
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

/**
 * Read one binding's slot, or a fresh one when the file never mentioned it.
 *
 * Every reader of a slot needs this, and answering `undefined` at the call sites
 * would be several chances to forget that an absent slot is *never scanned, no
 * baseline derived, no replay in force* rather than *no state at all*.
 *
 * @returns The stored slot, or {@link emptyBindingScan}.
 */
export function bindingScanOf(state: ScanState, bindingId: string): BindingScanState {
    return state.bindings[bindingId] ?? emptyBindingScan();
}
