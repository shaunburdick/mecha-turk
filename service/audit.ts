/**
 * Append-only audit trail for the service.
 */

import { newCorrelationId, nowIso } from '../src/ids.ts';
import { redact } from '../src/redaction.ts';
import { isRecord } from './json.ts';
import type { ServiceStore } from './store/index.ts';

/** Store-relative path of the append-only audit log. */
export const AUDIT_FILE = 'audit.ndjson';

/**
 * Entity id every configuration-wide audit row names.
 *
 * The configuration and trim rows both carry
 * `entity: { kind: 'service', id: <this> }`, so a reader can group them under
 * one identity without either being forced onto a run's correlation id.
 * Exported beside the trail's own path constant so the
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

function isAuditEntityKind(value: unknown): value is AuditEntityKind {
    return typeof value === 'string' && AUDIT_ENTITY_KINDS.has(value);
}

export interface AuditEntry {
    /** Monotonic sequence number assigned by the writer. */
    readonly seq: number;
    /** RFC 3339 timestamp of the write. */
    readonly timestamp: string;
    /** Correlation id tying this entry to the rest of the chain. */
    readonly correlationId: string;
    /** Event vocabulary name, e.g. `account.verified` or `binding.disabled`. */
    readonly eventType: string;
    /** Who caused the event: `panel`, `service`, or `operator`. */
    readonly actorSource: string;
    readonly entity: { readonly kind: AuditEntityKind; readonly id: string };
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
    readonly eventType: string;
    readonly actorSource: string;
    readonly entity: { readonly kind: AuditEntityKind; readonly id: string };
    /** Correlation id; a fresh one is generated when omitted. */
    readonly correlationId?: string;
    readonly decision?: string | null;
    readonly reason?: string | null;
    /** Event payload; must already be token-free. */
    readonly details?: Readonly<Record<string, unknown>>;
}

/** Outcome of the redaction pass: the cleaned values plus the paths touched. */
interface RedactedFields {
    readonly details: Record<string, unknown>;
    readonly reason: string | null;
    readonly redaction: { readonly redacted: boolean; readonly fields: readonly string[] };
}

/**
 * Redact every string inside a JSON-ish value, collecting what changed.
 */
// eslint-disable-next-line llm-core/no-unknown-returns -- input is `unknown` by design; four branches, no union.
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
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                redactDeep({ value: child, path: path === '' ? key : `${path}.${key}`, fields }),
            ]),
        );
    }

    return value;
}

/**
 * Apply the redaction pass to an audit input.
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
    readonly seq: number;
    /** RFC 3339 timestamp. */
    readonly timestamp: string;
    readonly correlationId: string;
    readonly eventType: string;
    readonly actorSource: string;
}

function isAuditHeader(raw: Record<string, unknown>): raw is AuditHeader & Record<string, unknown> {
    return (
        typeof raw.seq === 'number' &&
        typeof raw.timestamp === 'string' &&
        typeof raw.correlationId === 'string' &&
        typeof raw.eventType === 'string' &&
        typeof raw.actorSource === 'string'
    );
}

function isAuditEntity(raw: unknown): raw is { readonly kind: AuditEntityKind; readonly id: string } {
    return isRecord(raw) && isAuditEntityKind(raw.kind) && typeof raw.id === 'string';
}

/**
 * Read the redaction marker of a stored line, tolerating a missing one.
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

export interface AuditTrailRead {
    /** The entries, in file order. */
    readonly entries: readonly AuditEntry[];
    /**
     * Lines that did not parse as an {@link AuditEntry}.
     *
     * Propagated rather than discarded: a reader that only *inspects* the
     * trail can ignore them, but a reader that **rewrites** it is about to
     * erase them, and erasing a line nobody counted is the invisible loss the
     * trim pass records instead (`audit-trim.ts`).
     */
    readonly malformed: number;
}

/**
 * Read every usable audit entry **and** the count of lines that could not be
 * used, in file order.
 */
export async function readAuditTrail(store: ServiceStore): Promise<AuditTrailRead> {
    const result = await store.readLines(AUDIT_FILE, parseAuditEntry);

    return { entries: result.entries, malformed: result.malformed };
}

/**
 * Read every usable audit entry, in file order.
 */
export async function readAuditEntries(store: ServiceStore): Promise<readonly AuditEntry[]> {
    const trail = await readAuditTrail(store);

    return trail.entries;
}

/** Process-local audit state for one open store. */
interface AuditCache {
    /** Next sequence number to assign; seeded once from the file, then counted in memory. */
    nextSeq: number;
    /** Previous write's outcome, so the next one runs only after it settles. */
    writeChain: Promise<unknown>;
}

/**
 * One cache per store handle, seeded once from the audit file: a `WeakMap`
 * keyed by the handle is the ownership unit, so a restarted service re-seeds
 * from disk while every write through the same handle shares one counter.
 * The poller appends an audit row on every poll — without this cache each
 * append would re-read the whole trail to rediscover the last `seq`, and the
 * write cost would grow with the file's own history.
 */
const auditCaches = new WeakMap<ServiceStore, Promise<AuditCache>>();

/**
 * Read the trail once and derive the values later writes count from.
 *
 * Every stored line counts toward the next `seq` — including the legacy
 * `consent` rows builds before 2026-10-01 wrote, which no writer emits any
 * more but which remain ordinary, readable history.
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
 * Run one audit write after every write queued before it: serialising the
 * appends keeps the file in `seq` order and makes the reservation race-free,
 * and the chain carries the previous write's *outcome* so a rejection is
 * consumed here — it can never wedge the chain — while still reaching this
 * write's own caller.
 */
function inWriteChain<T>(cache: AuditCache, task: () => Promise<T>): Promise<T> {
    // eslint-disable-next-line unicorn/prefer-then-catch -- .catch re-runs task on its own rejection; this runs once.
    const run = cache.writeChain.then(task, task);
    cache.writeChain = run;

    return run;
}

/**
 * Run one audit-side task after every append queued before it: the retention
 * passes join the **same** chain `appendAudit` writes on, so *a pass can
 * never remove a row appended while it was computing* is true by
 * construction rather than timing — the read, the decision and the one
 * atomic rewrite happen in a slot no append can interleave with. Hold the
 * whole read-decide-write sequence inside the task; anything awaited outside
 * runs after later appends have landed. A failed append is consumed here so
 * it can never wedge the chain.
 */
export function serializeAudit<T>(store: ServiceStore, task: () => Promise<T>): Promise<T> {
    return auditCacheFor(store).then((cache) => inWriteChain(cache, task));
}

/**
 * Compose an entry exactly the way {@link appendAudit} builds one, **without
 * writing it** — redaction, `seq`, `timestamp` and the correlation id all
 * come from the one implementation the writer uses, so a row a pass embeds in
 * its own atomic rewrite is indistinguishable from an appended one. **Hold
 * the chain** ({@link serializeAudit}) while calling: outside it two writers
 * can reserve the same `seq` number. A number reserved by a pass whose rewrite
 * then fails is never used, and the gap a trim leaves is already an expected,
 * readable fact.
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
 * Append one entry, assigning the next sequence number. The number is
 * reserved inside the write chain and advanced **only** after the line is
 * durable, so concurrent writers never share a `seq`, a failed append
 * reuses its number (no gaps), and appends never re-read the file to
 * discover where the trail ended.
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
