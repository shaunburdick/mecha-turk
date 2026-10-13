/**
 * The panel's test ledger (`host.storage`): attempts, dispatches, verification (NFR-007), writes redaction-checked.
 */

import { GUEST_STORAGE_VALUE_BYTES } from '@openchamber/sdk';
import type { JsonValue } from '@openchamber/sdk';
import { utf8ByteLength } from './json.ts';
import { assertRedacted, redact, stripCredentialKeys } from './redaction.ts';

/** Schema version stamped on every ledger. */
export const LEDGER_SCHEMA_VERSION = 'spike-ledger-1';

export const LEDGER_STORAGE_KEY = 'mecha-turk:ledger';

export const MAX_LEDGER_ENTRIES = 100;

export const MAX_DETAIL_CHARS = 200;

export type LifecyclePhase = 'mounted' | 'closed' | 'paused' | 'removed' | 'server-switch';

export const LIFECYCLE_PHASES: readonly LifecyclePhase[] = ['mounted', 'closed', 'paused', 'removed', 'server-switch'];

/**
 * Every entry kind the ledger accepts, used to validate stored values.
 *
 * The runtime list is the single source of truth for {@link LedgerEntryKind},
 * so the type and the validator cannot drift apart.
 */
const LEDGER_KINDS = [
    'phase', 'identity', 'poll', 'match', 'evidence',
    'session', 'host-verify', 'lifecycle', 'error',
] as const;

export type LedgerEntryKind = (typeof LEDGER_KINDS)[number];

/** Scalar values allowed inside a ledger detail; keeps storage JSON-safe. */
export type LedgerScalar = string | number | boolean | null;

/** Bounded, credential-free detail payload for one entry. */
export type LedgerDetail = Record<string, LedgerScalar>;

export interface LedgerEntry {
    readonly seq: number;
    readonly at: string;
    readonly correlationId: string;
    readonly panelGeneration: number;
    readonly kind: LedgerEntryKind;
    readonly detail: LedgerDetail;
    readonly phase?: LifecyclePhase;
}

export interface PanelLedger {
    readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
    readonly correlationId: string;
    readonly panelGeneration: number;
    /** `true` when the key already existed at this mount (absence is evidence). */
    readonly storagePresentBeforeMount: boolean;
    readonly createdAt: string;
    entries: LedgerEntry[];
}

/**
 * Narrow a JSON value to an object record.
 *
 * @returns The value as a record, or `null` for anything else.
 */
function asJsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return value;
}

/**
 * Read a non-empty string field from a record.
 *
 * @returns The value, or `null` when it is missing or empty.
 */
function readStringField(record: Record<string, JsonValue>, field: string): string | null {
    const value = record[field];
    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read a finite number field from a record.
 *
 * @returns The value, or `null` when it is missing or not a number.
 */
function readNumberField(record: Record<string, JsonValue>, field: string): number | null {
    const value = record[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBooleanField(record: Record<string, JsonValue>, field: string): boolean | null {
    const value = record[field];
    return typeof value === 'boolean' ? value : null;
}

/**
 * Check that a JSON value is a ledger scalar.
 *
 * @returns `true` for strings, finite numbers, booleans, and `null`.
 */
function isScalar(value: JsonValue): value is LedgerScalar {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return true;
    }

    return typeof value === 'number' && Number.isFinite(value);
}

export function isLifecyclePhase(value: unknown): value is LifecyclePhase {
    return typeof value === 'string' && (LIFECYCLE_PHASES as readonly string[]).includes(value);
}

interface EntryHead {
    readonly seq: number;
    readonly at: string;
    readonly correlationId: string;
    readonly panelGeneration: number;
}

/**
 * Validate the identity fields of a stored entry.
 *
 * @returns The identity fields, or `null` when any of them is malformed.
 */
function readEntryHead(record: Record<string, JsonValue>): EntryHead | null {
    const seq = readNumberField(record, 'seq');
    const at = readStringField(record, 'at');
    const correlationId = readStringField(record, 'correlationId');
    const panelGeneration = readNumberField(record, 'panelGeneration');
    if (
        seq === null ||
        at === null ||
        correlationId === null ||
        panelGeneration === null ||
        Number.isNaN(Date.parse(at))
    ) {
        return null;
    }

    return { seq, at, correlationId, panelGeneration };
}

/**
 * Validate the `kind` of a stored entry.
 *
 * @returns The kind, or `null` when it is unknown.
 */
function readKindField(record: Record<string, JsonValue>): LedgerEntryKind | null {
    const kind = readStringField(record, 'kind');
    if (kind === null) {
        return null;
    }

    return LEDGER_KINDS.find((candidate) => candidate === kind) ?? null;
}

/**
 * Validate the `detail` payload of a stored entry.
 *
 * @returns The detail map, or `null` when a value is not a scalar.
 */
function readDetailField(record: Record<string, JsonValue>): LedgerDetail | null {
    const detail = asJsonRecord(record.detail);
    if (detail === null) {
        return null;
    }

    const result: LedgerDetail = {};
    for (const [key, value] of Object.entries(detail)) {
        if (!isScalar(value)) {
            return null;
        }

        result[key] = value;
    }

    return result;
}

/**
 * Validate the optional `phase` of a stored entry.
 *
 * @returns `undefined` when absent, the phase when valid, or `null` when invalid.
 */
function readPhaseField(record: Record<string, JsonValue>): LifecyclePhase | null | undefined {
    const { phase } = record;
    if (phase === undefined || phase === null) {
        return undefined;
    }

    return isLifecyclePhase(phase) ? phase : null;
}

/**
 * Validate one stored entry.
 *
 * @returns The entry, or `null` when its shape is unusable.
 */
function readEntry(value: JsonValue): LedgerEntry | null {
    const record = asJsonRecord(value);
    if (record === null) {
        return null;
    }

    const head = readEntryHead(record);
    const kind = readKindField(record);
    const detail = readDetailField(record);
    const phase = readPhaseField(record);
    if (head === null || kind === null || detail === null || phase === null) {
        return null;
    }

    return { ...head, kind, detail, ...(phase !== undefined && { phase }) };
}

/**
 * Validate a stored entry list.
 *
 * @returns The entries, or `null` when any element is unusable.
 */
function readEntries(value: JsonValue | undefined): LedgerEntry[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const entries: LedgerEntry[] = [];
    for (const raw of value) {
        const entry = readEntry(raw);
        if (entry === null) {
            return null;
        }

        entries.push(entry);
    }

    return entries;
}

interface LedgerHeader {
    readonly correlationId: string;
    readonly createdAt: string;
    readonly panelGeneration: number;
    readonly storagePresentBeforeMount: boolean;
}

/**
 * Validate the scalar header fields of a stored ledger.
 *
 * @returns The header, or `null` when any field is missing or malformed.
 */
function readLedgerHeader(record: Record<string, JsonValue>): LedgerHeader | null {
    const correlationId = readStringField(record, 'correlationId');
    const createdAt = readStringField(record, 'createdAt');
    const panelGeneration = readNumberField(record, 'panelGeneration');
    const storagePresent = readBooleanField(record, 'storagePresentBeforeMount');
    if (
        correlationId === null ||
        createdAt === null ||
        panelGeneration === null ||
        storagePresent === null ||
        Number.isNaN(Date.parse(createdAt))
    ) {
        return null;
    }

    return { correlationId, createdAt, panelGeneration, storagePresentBeforeMount: storagePresent };
}

/**
 * Read a ledger back from `host.storage`.
 *
 * @returns The validated ledger, or `null` when unusable.
 */
export function readLedger(value?: JsonValue): PanelLedger | null {
    const record = asJsonRecord(value);
    if (record?.schemaVersion !== LEDGER_SCHEMA_VERSION) {
        return null;
    }

    const header = readLedgerHeader(record);
    const entries = readEntries(record.entries);
    if (header === null || entries === null) {
        return null;
    }

    return { schemaVersion: LEDGER_SCHEMA_VERSION, ...header, entries };
}

export interface CreateLedgerInput {
    readonly correlationId: string;
    readonly panelGeneration: number;
    readonly storagePresentBeforeMount: boolean;
    readonly createdAt: string;
}

export function createLedger(input: CreateLedgerInput): PanelLedger {
    return {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        correlationId: input.correlationId,
        panelGeneration: input.panelGeneration,
        storagePresentBeforeMount: input.storagePresentBeforeMount,
        createdAt: input.createdAt,
        entries: [],
    };
}

/**
 * Truncate, de-credential, and redact a detail payload before it is appended:
 * `error` is the one free-form field — it stringifies whatever was thrown, so a
 * provider message could carry a secret shape — and redacting it here
 * neutralizes the value at append time instead of leaving the persist gate to
 * discover it. Returns a copy whose strings are bounded, credential-free, and
 * redacted.
 */
function sanitizeDetail(detail: LedgerDetail): LedgerDetail {
    const clean = stripCredentialKeys(detail);
    for (const [key, value] of Object.entries(clean)) {
        if (typeof value !== 'string') {
            continue;
        }

        const safe = key === 'error' ? redact(value) : value;
        clean[key] = safe.length > MAX_DETAIL_CHARS ? `${safe.slice(0, MAX_DETAIL_CHARS - 1)}…` : safe;
    }

    return clean;
}

export interface LedgerEntryInput {
    readonly at: string;
    readonly kind: LedgerEntryKind;
    readonly detail: LedgerDetail;
    readonly correlationId?: string;
    readonly panelGeneration?: number;
    readonly phase?: LifecyclePhase;
}

/**
 * Append one entry, returning a new ledger.
 *
 * when {@link MAX_LEDGER_ENTRIES} would be exceeded.
 */
export function appendEntry(ledger: PanelLedger, input: LedgerEntryInput): PanelLedger {
    const lastSeq = ledger.entries.at(-1)?.seq ?? 0;
    const entry: LedgerEntry = {
        seq: lastSeq + 1,
        at: input.at,
        correlationId: input.correlationId ?? ledger.correlationId,
        panelGeneration: input.panelGeneration ?? ledger.panelGeneration,
        kind: input.kind,
        detail: sanitizeDetail(input.detail),
        ...(input.phase !== undefined && { phase: input.phase }),
    };

    const entries = [...ledger.entries, entry];
    while (entries.length > MAX_LEDGER_ENTRIES) {
        entries.shift();
    }

    return { ...ledger, entries };
}

export interface PhaseInput {
    readonly phase: LifecyclePhase;
    readonly at: string;
    readonly note?: string;
}

export function recordPhase(ledger: PanelLedger, input: PhaseInput): PanelLedger {
    return appendEntry(ledger, {
        at: input.at,
        kind: 'phase',
        phase: input.phase,
        detail: { phase: input.phase, note: input.note ?? '' },
    });
}

/**
 * Serialize a ledger for storage. Size is measured in UTF-8 bytes, exactly like
 * the host's own gate, because `String.length` under-counts non-ASCII content
 * and would let a ledger the host refuses pass here. Compact JSON asserted
 * secret-free and within the host's value limit; throws `RedactionError` on a
 * secret shape, `Error` past the 64 KiB limit.
 */
export function serializeLedger(ledger: PanelLedger): string {
    const json = JSON.stringify(ledger);
    assertRedacted('mecha-turk ledger', json);
    if (utf8ByteLength(json) > GUEST_STORAGE_VALUE_BYTES) {
        throw new Error(`mecha-turk ledger exceeds the ${GUEST_STORAGE_VALUE_BYTES} byte host.storage value limit`);
    }

    return json;
}

/**
 * Assert that a ledger can be persisted without carrying secret material.
 */
export function assertLedgerRedacted(ledger: PanelLedger): void {
    serializeLedger(ledger);
}

/**
 * Check that an entry timestamp falls strictly inside an interval.
 *
 * @returns `true` when the timestamp is inside the open interval.
 */
function isInside(input: { at: string; start: number; end: number }): boolean {
    const parsed = Date.parse(input.at);
    return !Number.isNaN(parsed) && parsed > input.start && parsed < input.end;
}

export type GapVerdict = 'polling-continued' | 'polling-stopped' | 'no-gap';

export interface GapAnalysis {
    readonly verdict: GapVerdict;
    readonly pollEntriesInGap: number;
    readonly closedAt: string;
    readonly reopenedAt: string;
    readonly gapMs: number;
}

/**
 * Analyse whether polling continued while the panel was closed: the ledger only
 * receives `poll` entries from a running panel, so a gap with no poll entries is
 * direct evidence the loop stopped with the frame — computed from stored
 * entries, never inferred from an open panel. Answers the verdict plus the
 * number of poll entries inside the interval.
 */
export function analyzePollingGap(input: { ledger: PanelLedger; closedAt: string; reopenedAt: string }): GapAnalysis {
    const { ledger, closedAt, reopenedAt } = input;
    const closed = Date.parse(closedAt);
    const reopened = Date.parse(reopenedAt);
    if (Number.isNaN(closed) || Number.isNaN(reopened) || reopened <= closed) {
        return { verdict: 'no-gap', pollEntriesInGap: 0, closedAt, reopenedAt, gapMs: 0 };
    }

    const inside = { start: closed, end: reopened };
    const isPollInGap = (entry: LedgerEntry): boolean => entry.kind === 'poll' && isInside({ at: entry.at, ...inside });
    const pollEntriesInGap = ledger.entries.filter((entry) => isPollInGap(entry)).length;
    const verdict: GapVerdict = pollEntriesInGap > 0 ? 'polling-continued' : 'polling-stopped';

    return { verdict, pollEntriesInGap, closedAt, reopenedAt, gapMs: reopened - closed };
}

/**
 * Return the most recent entries, newest first, for display.
 */
export function ledgerTail(ledger: PanelLedger, count: number): readonly LedgerEntry[] {
    return ledger.entries.slice(-count).toReversed();
}
