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
 * Sequence numbers are seeded from the file
 * **once per store handle** and then counted in memory, and appends run
 * through a per-store chain — a write never re-reads the trail it is
 * extending (review M6, mandatory before the Wave 4 poller appends rows on
 * every tick).
 *
 * The **correlation-indexed read API** still belongs to task T-027 and is not
 * here; this module ships the write path — `account.verified`/
 * `rejected`/`error`/`rotated`, and every row the run and
 * dispatch layers append. Retention trimming, added by 006, lives in
 * `audit-trim.ts` and does **not** rewrite this module: it joins this module's
 * chain through {@link serializeAudit} and composes its row through
 * {@link composeAudit}, so `redactDeep` and `seq` assignment keep exactly one
 * implementation.
 */

import { newCorrelationId, nowIso } from '../src/ids.ts';
import { redact } from '../src/redaction.ts';
import { isRecord } from './json.ts';
import type { ServiceStore } from './store/index.ts';

/** Store-relative path of the append-only audit log. */
export const AUDIT_FILE = 'audit.ndjson';

/**
 * Entity id every configuration-wide audit row names (006 FR-070, FR-073).
 *
 * The two rows 006 fills — `config.changed` and `audit.trimmed` — both carry
 * `entity: { kind: 'service', id: <this> }`, so a reader can group them under
 * one identity without either being forced onto a run's correlation id (003
 * FR-052, 006 FR-074). Exported beside the trail's own path constant so the
 * trim pass and the configuration route cannot spell it differently.
 */
export const CONFIGURATION_ENTITY_ID = 'configuration';

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
    /** Event vocabulary name, e.g. `account.verified` or `binding.disabled`. */
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

/** One read of the trail: the usable rows, plus the lines the reader refused. */
export interface AuditTrailRead {
    /** The entries, in file order. */
    readonly entries: readonly AuditEntry[];
    /**
     * Lines that did not parse as an {@link AuditEntry}.
     *
     * Propagated rather than discarded: a reader that only *inspects* the
     * trail can ignore them, but a reader that **rewrites** it is about to
     * erase them, and erasing a line nobody counted is the invisible loss the
     * trim pass records instead (`audit-trim.ts`, 006 FR-053's "any removal
     * retention causes MUST be audited").
     */
    readonly malformed: number;
}

/**
 * Read every usable audit entry **and** the count of lines that could not be
 * used, in file order.
 *
 * @param store - Open store.
 * @returns The entries plus the unreadable-line count.
 */
export async function readAuditTrail(store: ServiceStore): Promise<AuditTrailRead> {
    const result = await store.readLines(AUDIT_FILE, parseAuditEntry);

    return { entries: result.entries, malformed: result.malformed };
}

/**
 * Read every usable audit entry, in file order.
 *
 * @param store - Open store.
 * @returns The entries; unreadable lines are skipped. A reader that goes on to
 *   **rewrite** the trail must use {@link readAuditTrail} instead, so the skip
 *   can be counted before the rewrite erases it.
 */
export async function readAuditEntries(store: ServiceStore): Promise<readonly AuditEntry[]> {
    const trail = await readAuditTrail(store);

    return trail.entries;
}

/** Process-local audit state for one open store (review M6/W2-2). */
interface AuditCache {
    /** Next sequence number to assign; seeded once from the file, then counted in memory. */
    nextSeq: number;
    /** Previous write's outcome, so the next one runs only after it settles. */
    writeChain: Promise<unknown>;
}

/**
 * One cache per store handle, seeded once from the audit file.
 *
 * A `WeakMap` keyed by the handle is the ownership unit: a restarted service
 * opens a fresh handle and re-seeds from disk, while every write through the
 * same handle shares one counter. Wave 4 appends an audit
 * row on every poll — without this cache each append would re-read the whole
 * trail to rediscover the last `seq`, so the write cost would grow with the
 * file's own history (review M6: seed once, increment in memory).
 */
const auditCaches = new WeakMap<ServiceStore, Promise<AuditCache>>();

/**
 * Read the trail once and derive the values later writes count from.
 *
 * Every stored line counts toward the next `seq` — including the legacy
 * `consent` rows builds before 2026-10-01 wrote, which no writer emits any
 * more but which remain ordinary, readable history.
 *
 * @param store - Open store.
 * @returns The seeded cache: the first free `seq`.
 * @throws {StorageUnavailableError} When the trail cannot be read — a write
 *   that cannot establish its own sequence number must fail, not guess.
 */
async function seedAuditCache(store: ServiceStore): Promise<AuditCache> {
    const entries = await readAuditEntries(store);
    let nextSeq = 1;
    for (const entry of entries) {
        nextSeq = Math.max(nextSeq, entry.seq + 1);
    }

    return { nextSeq, writeChain: Promise.resolve() };
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
 * Run one audit-side task after every append queued before it (006 FR-055).
 *
 * The retention passes join the **same** chain `appendAudit` writes on, which
 * is what makes "a pass can never remove a row appended while it was computing"
 * true by construction rather than by timing: the trail read, the removal
 * decision, and the one atomic rewrite all happen inside a slot no append can
 * interleave with. The join carries the previous write's outcome the
 * same way {@link inWriteChain} does, so a failed append is consumed here
 * (it can never wedge the chain) while still reaching this task's caller.
 *
 * @param store - Open store whose audit chain this task joins.
 * @param task - Work to run once the chain reaches it; it should hold its
 *   whole read-decide-write sequence, because anything it awaits outside the
 *   task would run after later appends have already landed.
 * @returns This task's result or rejection, exactly as the task produced it.
 * @throws {StorageUnavailableError} When seeding the chain's `seq` counter
 *   fails — the trail cannot be read, so nothing can be composed against it.
 */
export function serializeAudit<T>(store: ServiceStore, task: () => Promise<T>): Promise<T> {
    return auditCacheFor(store).then((cache) => inWriteChain(cache, task));
}

/**
 * Compose an entry exactly the way {@link appendAudit} builds one, **without
 * writing it** (006 T-011).
 *
 * Redaction, `seq`, `timestamp`, and the generated correlation id all come from
 * the one implementation the writer uses, so a row a pass embeds in its own
 * atomic rewrite is indistinguishable from an appended one — the trim row is
 * composed here and written by the pass in the same rename as the removals it
 * describes (plan D4: no crash can leave a removal without its record, and a
 * restart cannot re-seed `nextSeq` below a number already used).
 *
 * **Precondition**: call it while holding the chain via {@link serializeAudit}.
 * The reservation reads and advances the shared `seq` counter, and every other
 * writer mutates that counter inside its own chain task; a composer called
 * outside the chain could therefore reserve the same number an in-flight
 * append is writing. A number reserved by a pass whose rewrite then fails is
 * simply never used — the gap a trim leaves is already an expected, readable
 * fact.
 *
 * @param store - Open store holding the trail this entry will join.
 * @param input - Caller-supplied entry (token-free by construction).
 * @returns The composed entry, with `seq` and `timestamp` assigned.
 * @throws {StorageUnavailableError} When the trail cannot be read to seed the
 *   sequence counter.
 */
export async function composeAudit(store: ServiceStore, input: AuditInput): Promise<AuditEntry> {
    const cache = await auditCacheFor(store);
    const { details, reason, redaction } = redactInput(input);

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
    cache.nextSeq += 1;

    return entry;
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
