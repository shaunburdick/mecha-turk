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
 * `account.verified`/`rejected`/`error`/`rotated`). Sequence numbers and the
 * recorded-consent set are seeded from the file **once per store handle** and
 * then counted in memory, and appends run through a per-store chain — a write
 * never re-reads the trail it is extending (review M6, mandatory before the
 * Wave 4 poller appends rows on every tick).
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

/** Process-local audit state for one open store (review M6/W2-2). */
interface AuditCache {
    /** Next sequence number to assign; seeded once from the file, then counted in memory. */
    nextSeq: number;
    /** Consent versions already on disk, plus claims held by in-flight writes. */
    readonly consentVersions: Set<number>;
    /** Previous write's outcome, so the next one runs only after it settles. */
    writeChain: Promise<unknown>;
}

/**
 * One cache per store handle, seeded once from the audit file.
 *
 * A `WeakMap` keyed by the handle is the ownership unit: a restarted service
 * opens a fresh handle and re-seeds from disk, while every write through the
 * same handle shares one counter and one consent set. Wave 4 appends an audit
 * row on every poll — without this cache each append would re-read the whole
 * trail to rediscover the last `seq`, so the write cost would grow with the
 * file's own history (review M6: seed once, increment in memory).
 */
const auditCaches = new WeakMap<ServiceStore, Promise<AuditCache>>();

/**
 * Read the trail once and derive the values later writes count from.
 *
 * @param store - Open store.
 * @returns The seeded cache: first free `seq` and the recorded consent set.
 * @throws {StorageUnavailableError} When the trail cannot be read — a write
 *   that cannot establish its own sequence number must fail, not guess.
 */
async function seedAuditCache(store: ServiceStore): Promise<AuditCache> {
    const entries = await readAuditEntries(store);
    let nextSeq = 1;
    const consentVersions = new Set<number>();
    for (const entry of entries) {
        nextSeq = Math.max(nextSeq, entry.seq + 1);
        if (entry.eventType !== 'consent') {
            continue;
        }

        const { version } = entry.details;
        if (typeof version === 'number' && Number.isInteger(version)) {
            consentVersions.add(version);
        }
    }

    return { nextSeq, consentVersions, writeChain: Promise.resolve() };
}

/**
 * Get the cache for one store handle, seeding it on first use.
 *
 * The seed promise is memoised synchronously, so concurrent first writers
 * share a single file read; a failed seed is dropped from the map so the next
 * attempt reads the file again instead of serving a half-built cache.
 *
 * @param store - Open store.
 * @returns The cache, seeded from the audit file.
 * @throws {StorageUnavailableError} When the trail cannot be read.
 */
function auditCacheFor(store: ServiceStore): Promise<AuditCache> {
    let cached = auditCaches.get(store);
    if (cached === undefined) {
        cached = seedAuditCache(store).catch((error: unknown) => {
            auditCaches.delete(store);
            throw error;
        });
        auditCaches.set(store, cached);
    }

    return cached;
}

/**
 * Run one audit write after every write queued before it.
 *
 * Serialising the appends keeps the file in `seq` order and makes the
 * reservation below race-free: two routes appending at once (a verify and an
 * operator delete, say) each get their own number and their own line. The
 * chain carries the previous write's *outcome*, and this write attaches both
 * handlers, so a rejection is consumed here (it can never wedge the chain)
 * while still reaching this write's own caller.
 *
 * @param cache - The store's cache, whose chain this task joins.
 * @param task - The write to run once the chain reaches it.
 * @returns This write's result or rejection, exactly as the task produced it.
 */
function inWriteChain<T>(cache: AuditCache, task: () => Promise<T>): Promise<T> {
    const run = cache.writeChain.then(task, task);
    cache.writeChain = run;

    return run;
}

/**
 * Claim the right to write the consent occurrence for one version (W2-2).
 *
 * The lookup and the claim happen in the same synchronous step after the seed
 * resolves, so two concurrent credential requests carrying the same
 * `consentVersion` cannot both decide to write: exactly one consent row exists
 * per version even when the requests race (contract §1.2, panel-service §3
 * invariant 8).
 *
 * @param store - Open store holding the audit trail.
 * @param version - Consent version being recorded.
 * @returns `true` when this caller owns the write; `false` when the version is
 *   already recorded or another writer holds the claim right now.
 * @throws {StorageUnavailableError} When the trail cannot be read to seed the
 *   claim set.
 */
export async function claimConsentVersion(store: ServiceStore, version: number): Promise<boolean> {
    const cache = await auditCacheFor(store);
    if (cache.consentVersions.has(version)) {
        return false;
    }

    cache.consentVersions.add(version);

    return true;
}

/**
 * Release a consent claim whose write failed, so a later request can retry it.
 *
 * Only a claim this caller won is ever released — a version seeded from the
 * file was never claimed and must stay in the set. Best-effort: when the
 * trail is unreadable the failed write has already surfaced the storage
 * failure, and the next claim re-seeds from disk anyway.
 *
 * @param store - Open store holding the audit trail.
 * @param version - Version whose write did not reach disk.
 */
export async function releaseConsentVersion(store: ServiceStore, version: number): Promise<void> {
    // Best-effort by design (see the doc comment): if the trail cannot even
    // be read, the failed write has already surfaced the storage failure and
    // the next claim re-seeds from disk.
    const cache = await auditCacheFor(store).catch(() => null);
    cache?.consentVersions.delete(version);
}

/**
 * Append one entry, assigning the next sequence number.
 *
 * The number is reserved inside the write chain and advanced **only** after
 * the line is durable, so concurrent writers never share a `seq`, a failed
 * append reuses its number (no gaps), and appends never re-read the file to
 * discover where the trail ended (review M6).
 *
 * @param store - Open store.
 * @param input - Caller-supplied entry (token-free by construction).
 * @returns The stored entry, including its assigned `seq` and `timestamp`.
 * @throws {StorageUnavailableError} When the append or the seed read fails.
 */
export async function appendAudit(store: ServiceStore, input: AuditInput): Promise<AuditEntry> {
    const cache = await auditCacheFor(store);
    const { details, reason, redaction } = redactInput(input);

    return await inWriteChain(cache, async () => {
        const entry: AuditEntry = {
            seq: cache.nextSeq,
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
        cache.nextSeq += 1;

        return entry;
    });
}
