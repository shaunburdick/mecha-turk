/**
 * Append-only audit trail for the service (data-model.md `audit.ndjson`).
 *
 * One JSON object per line, `seq` monotonic, appended with the store's
 * fsync'd NDJSON writer so an entry reaches disk whole or not at all
 * (FR-033/FR-035, constitution Principle IV). Everything written here goes
 * through {@link redactValue} first: the writer's *input* is already a
 * token-free structure by construction — routes never hand a credential to
 * this module — and the redaction pass is the second, independent guard that
 * makes "no token material in audit" executable rather than promised
 * (contract §4 rule 2).
 *
 * Retention trimming and the correlation-indexed read API belong to task
 * T-027; this module ships the write path Wave 2 needs (consent occurrences,
 * `account.verified`/`rejected`/`error`/`rotated`).
 */

import { newCorrelationId, nowIso } from '../src/ids.ts';
import { redact } from '../src/redaction.ts';
import { isRecord } from './json.ts';
import type { ServiceStore } from './store/index.ts';

/** Store-relative path of the append-only audit log. */
export const AUDIT_FILE = 'audit.ndjson';

/** Entity kinds the audit trail can reference; `service` covers process-wide events. */
export type AuditEntityKind = 'service' | 'account' | 'binding' | 'run' | 'delivery';

/** Every legal entity kind, in one place for the runtime guard. */
const AUDIT_ENTITY_KINDS: ReadonlySet<string> = new Set<AuditEntityKind>([
    'service',
    'account',
    'binding',
    'run',
    'delivery',
]);

/**
 * Narrow an unknown value to an entity kind.
 *
 * @param value - Candidate value from a stored audit line.
 * @returns `true` only for one of the documented kinds.
 */
function isAuditEntityKind(value: unknown): value is AuditEntityKind {
    return typeof value === 'string' && AUDIT_ENTITY_KINDS.has(value);
}

/** One durable audit record (data-model.md AuditEntry). */
export interface AuditEntry {
    /** Monotonic sequence number assigned by the writer. */
    readonly seq: number;
    /** RFC 3339 timestamp of the write. */
    readonly timestamp: string;
    /** Correlation id tying this entry to the rest of the chain (NFR-007). */
    readonly correlationId: string;
    /** Event vocabulary name, e.g. `consent` or `account.verified`. */
    readonly eventType: string;
    /** Who caused the event: `panel`, `service`, or `operator`. */
    readonly actorSource: string;
    /** The entity this entry is about. */
    readonly entity: { readonly kind: AuditEntityKind; readonly id: string };
    /** Decision recorded with the event, when it is a decision. */
    readonly decision: string | null;
    /** Secret-free reason text. */
    readonly reason: string | null;
    /** Which fields the redaction pass stripped, if any. */
    readonly redaction: { readonly redacted: boolean; readonly fields: readonly string[] };
    /** Event payload — never credential material, even before redaction. */
    readonly details: Readonly<Record<string, unknown>>;
}

/** What a caller supplies; `seq` and `timestamp` are assigned by the writer. */
export interface AuditInput {
    /** Event vocabulary name. */
    readonly eventType: string;
    /** Who caused the event. */
    readonly actorSource: string;
    /** The entity this entry is about. */
    readonly entity: { readonly kind: AuditEntityKind; readonly id: string };
    /** Correlation id; a fresh one is generated when omitted. */
    readonly correlationId?: string;
    /** Decision, when the event records one. */
    readonly decision?: string | null;
    /** Secret-free reason text. */
    readonly reason?: string | null;
    /** Event payload; must already be token-free. */
    readonly details?: Readonly<Record<string, unknown>>;
}

/** Outcome of the redaction pass: the cleaned values plus the paths touched. */
interface RedactedFields {
    /** Details with every secret-shaped string replaced. */
    readonly details: Record<string, unknown>;
    /** Reason with every secret-shaped string replaced. */
    readonly reason: string | null;
    /** Whether the pass changed anything, and which paths it rewrote. */
    readonly redaction: { readonly redacted: boolean; readonly fields: readonly string[] };
}

/**
 * Redact every string inside a JSON-ish value, collecting what changed.
 *
 * @param input - Candidate value (already token-free by design), its dotted
 *   path, and the accumulator collecting rewritten paths.
 * @returns The value with secret-shaped strings replaced.
 */
function redactDeep(input: { readonly value: unknown; readonly path: string; readonly fields: string[] }): unknown {
    const { value, path, fields } = input;
    if (typeof value === 'string') {
        const cleaned = redact(value);
        if (cleaned !== value) {
            fields.push(path);
        }

        return cleaned;
    }

    if (Array.isArray(value)) {
        return value.map((item, index) => redactDeep({ value: item, path: `${path}[${index}]`, fields }));
    }

    if (isRecord(value)) {
        const result: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            result[key] = redactDeep({ value: child, path: path === '' ? key : `${path}.${key}`, fields });
        }

        return result;
    }

    return value;
}

/**
 * Apply the redaction pass to an audit input.
 *
 * @param input - Caller-supplied entry.
 * @returns The entry with redacted details/reason and the changed field list.
 */
function redactInput(input: AuditInput): RedactedFields {
    const fields: string[] = [];
    const details = redactDeep({ value: input.details ?? {}, path: 'details', fields });
    const reason =
        typeof input.reason === 'string'
            ? (redactDeep({ value: input.reason, path: 'reason', fields }) as string)
            : null;

    return {
        details: isRecord(details) ? details : {},
        reason,
        redaction: { redacted: fields.length > 0, fields },
    };
}

/** Scalar header fields every stored audit line must carry. */
interface AuditHeader {
    /** Monotonic sequence number. */
    readonly seq: number;
    /** RFC 3339 timestamp. */
    readonly timestamp: string;
    /** Correlation id for the chain. */
    readonly correlationId: string;
    /** Event vocabulary name. */
    readonly eventType: string;
    /** Who caused the event. */
    readonly actorSource: string;
}

/**
 * Check and narrow the scalar header fields of a stored line.
 *
 * @param raw - Parsed document already known to be a record.
 * @returns `true` when every header field has its documented type.
 */
function isAuditHeader(raw: Record<string, unknown>): raw is AuditHeader & Record<string, unknown> {
    return (
        typeof raw.seq === 'number' &&
        typeof raw.timestamp === 'string' &&
        typeof raw.correlationId === 'string' &&
        typeof raw.eventType === 'string' &&
        typeof raw.actorSource === 'string'
    );
}

/**
 * Check and narrow the entity of a stored line.
 *
 * @param raw - Candidate value for the `entity` field.
 * @returns `true` for a documented kind plus a string id.
 */
function isAuditEntity(raw: unknown): raw is { readonly kind: AuditEntityKind; readonly id: string } {
    return isRecord(raw) && isAuditEntityKind(raw.kind) && typeof raw.id === 'string';
}

/**
 * Read the redaction marker of a stored line, tolerating a missing one.
 *
 * @param raw - Candidate value for the `redaction` field.
 * @returns The marker; older lines without one report nothing was redacted.
 */
function readRedaction(raw: unknown): { readonly redacted: boolean; readonly fields: readonly string[] } {
    if (!isRecord(raw)) {
        return { redacted: false, fields: [] };
    }

    const fields = Array.isArray(raw.fields)
        ? raw.fields.filter((entry): entry is string => typeof entry === 'string')
        : [];

    return { redacted: raw.redacted === true, fields };
}

/**
 * Parse a stored line back into an entry, rejecting anything malformed.
 *
 * @param raw - One parsed NDJSON document.
 * @returns The entry, or `null` when the line does not carry the required
 *   shape (counted as malformed by the reader, never thrown).
 */
export function parseAuditEntry(raw: unknown): AuditEntry | null {
    if (!isRecord(raw) || !isAuditHeader(raw) || !isAuditEntity(raw.entity) || !isRecord(raw.details)) {
        return null;
    }

    return {
        seq: raw.seq,
        timestamp: raw.timestamp,
        correlationId: raw.correlationId,
        eventType: raw.eventType,
        actorSource: raw.actorSource,
        entity: raw.entity,
        decision: typeof raw.decision === 'string' ? raw.decision : null,
        reason: typeof raw.reason === 'string' ? raw.reason : null,
        redaction: readRedaction(raw.redaction),
        details: raw.details,
    };
}

/**
 * Read every usable audit entry, in file order.
 *
 * @param store - Open store.
 * @returns The entries; malformed lines are skipped by the reader.
 */
export async function readAuditEntries(store: ServiceStore): Promise<readonly AuditEntry[]> {
    const result = await store.readLines(AUDIT_FILE, parseAuditEntry);

    return result.entries;
}

/**
 * Append one entry, assigning the next sequence number.
 *
 * @param store - Open store.
 * @param input - Caller-supplied entry (token-free by construction).
 * @returns The stored entry, including its assigned `seq` and `timestamp`.
 * @throws {StorageUnavailableError} When the append or the read fails.
 */
export async function appendAudit(store: ServiceStore, input: AuditInput): Promise<AuditEntry> {
    const existing = await readAuditEntries(store);
    const nextSeq = existing.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
    const { details, reason, redaction } = redactInput(input);
    const entry: AuditEntry = {
        seq: nextSeq,
        timestamp: nowIso(),
        correlationId: input.correlationId ?? newCorrelationId(),
        eventType: input.eventType,
        actorSource: input.actorSource,
        entity: input.entity,
        decision: input.decision ?? null,
        reason,
        redaction,
        details,
    };

    await store.appendLine(AUDIT_FILE, entry);

    return entry;
}
