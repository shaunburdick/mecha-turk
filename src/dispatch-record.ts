/**
 * The panel's durable dispatch-attempt record
 * ([contracts/reconciliation.md](../specs/003-dispatch-integrity/contracts/reconciliation.md)).
 *
 * This is the half of the reconciliation contract the panel owns: one entry per
 * dispatch attempt, written to `host.storage` under `mecha-turk:dispatches` so
 * a report that never reached the service still leaves the truth recoverable on
 * remount. It is a **reconciliation aid, never an audit home** —
 * the service's `audit.ndjson` stays the trail.
 *
 * Three properties this module owes, in order of how badly they are missed:
 *
 * - **Ordering is enforced by the API shape, not by a comment.**
 *   {@link recordDispatchOutcome} accepts a {@link RecordedOutcome} — a session
 *   id *or* a failure reason — so a record cannot be written before the host
 *   call has produced one, and every stored record therefore already carries an
 *   outcome. A crash before this write exists means the service's own
 *   reservation is the only evidence, and the run correctly wedges to
 *   `unconfirmed` instead of being guessed at.
 * - **`acknowledged` flips only on a 2xx for that exact attempt.**
 *   {@link acknowledgeDispatch} is the only writer of `true`, and it is keyed by
 *   `correlationId` *and* attempt so an acknowledgement can never land on a
 *   later attempt of the same run.
 * - **Every write is scanned.** Writes go through `writeStorage`, which applies
 *   `assertRedacted` to the serialized document before `host.storage.set` is
 *   called. The record legitimately holds a `dispatchToken` (`dtk-…`, an
 *   authorization artifact, not a credential), which is why
 *   `SECRET_PATTERNS` deliberately does not cover that prefix: a redaction
 *   guard that refused tokens would break the feature it exists to protect.
 *
 * Parsing is fail closed (AGENTS invariant 8): a present but unusable document
 * reads as *unreadable*, never as an empty one, because silently reporting
 * "nothing to reconcile" over a corrupt record is exactly the quiet data loss
 * this module exists to prevent. An **absent** key — a fresh install, an uninstall,
 * a wiped namespace — is different: it is evidence that there is nothing to
 * reconcile, and it reads as empty.
 */

import type { JsonValue } from '@openchamber/sdk';
import { isJsonValue } from './json.ts';
import { nowIso } from './ids.ts';
import { writeStorage } from './storage-write.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Storage key holding the attempt record (AGENTS invariant 4's prefix). */
export const DISPATCH_STORAGE_KEY = 'mecha-turk:dispatches';

/** Schema version stamped on every attempt record this build writes. */
export const DISPATCH_SCHEMA_VERSION = 'dispatch-attempts-1';

/** Most attempts the record holds; eviction removes the oldest acknowledged first. */
export const MAX_RECORDED_ATTEMPTS = 50;

/** The single-use token's minted shape — the same rule the service validates. */
const DISPATCH_TOKEN_PATTERN = /^dtk-[0-9a-f]{32}$/;

/** What one dispatch attempt produced; the two facts a result report can carry. */
export type DispatchOutcomeKind = 'dispatched' | 'failed';

/**
 * The outcome of one host call, as {@link recordDispatchOutcome} requires it.
 *
 * The union is the ordering guard: there is no constructor for a record that
 * does not name what `host.startSession()` returned, so the "persist before you
 * report" rule cannot be violated by calling this function too early —
 * the call would not type-check.
 */
export type RecordedOutcome =
    /** A session was created; its id is what the result report carries. */
    | { readonly kind: 'dispatched'; readonly sessionId: string }
    /** No session was created; the reason is what the result report carries. */
    | { readonly kind: 'failed'; readonly reason: string };

/** One stored dispatch attempt. */
export interface DispatchAttemptRecord {
    /** Run identity; every later call is addressed by it. */
    readonly correlationId: string;
    /** The human-readable run tuple, kept so a record is readable alone. */
    readonly runKey: string;
    /** Attempt this record is for; pairs with the correlation id as the key. */
    readonly attempt: number;
    /** Single-use authorization the result report presents. */
    readonly dispatchToken: string;
    /** What the host call produced. */
    readonly outcome: DispatchOutcomeKind;
    /** Created session id on a dispatched outcome, else `null`. */
    readonly sessionId: string | null;
    /** Recorded cause on a failed outcome, else `null`. */
    readonly reason: string | null;
    /** RFC 3339 stamp of the write, i.e. before the result report. */
    readonly recordedAt: string;
    /** `true` once a 2xx for this exact attempt has come back. */
    readonly acknowledged: boolean;
}

/** The persisted document. */
export interface DispatchRecordDocument {
    /** Contract schema version. */
    readonly schemaVersion: typeof DISPATCH_SCHEMA_VERSION;
    /** Attempts, oldest first, newest last. */
    readonly attempts: readonly DispatchAttemptRecord[];
}

/** What a read of `host.storage` answered. */
export type DispatchRecordRead =
    /** The key was absent (wiped/fresh) or held a document this build understands. */
    | { readonly ok: true; readonly document: DispatchRecordDocument }
    /** Storage threw, or the key held a document this build must not half-apply. */
    | { readonly ok: false };

/**
 * Narrow a JSON value to a plain object record.
 *
 * Same rule the ledger reader applies: `null`, arrays, and primitives are not
 * documents, and narrowing here means every member read below is typed as a
 * `JsonValue` rather than as `unknown`.
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
 * The empty document: what a wiped or never-written key means.
 *
 * @returns A record with no attempts.
 */
function emptyDocument(): DispatchRecordDocument {
    return { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts: [] };
}

/**
 * Read a required, non-empty string field.
 *
 * @returns The value, or `null` when missing, not a string, or empty.
 */
function readText(record: Record<string, JsonValue>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read a required nullable string field: explicit `null` is a value here.
 *
 * @returns The value, `null`, or `undefined` when the member is absent or malformed.
 */
function readNullableText(record: Record<string, JsonValue>, field: string): string | null | undefined {
    const value = record[field];
    if (value === null) {
        return null;
    }

    return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The identity and stamp members every stored attempt carries. */
interface AttemptHead {
    /** Run identity. */
    readonly correlationId: string;
    readonly runKey: string;
    /** Single-use token. */
    readonly dispatchToken: string;
    /** RFC 3339 write stamp. */
    readonly recordedAt: string;
}

/**
 * Read the identity and stamp members of one stored attempt.
 *
 * @returns The members, or `null` when any is missing or malformed.
 */
function readAttemptHead(record: Record<string, JsonValue>): AttemptHead | null {
    const correlationId = readText(record, 'correlationId');
    const runKey = readText(record, 'runKey');
    const dispatchToken = readText(record, 'dispatchToken');
    const recordedAt = readText(record, 'recordedAt');
    if (
        correlationId === null ||
        runKey === null ||
        dispatchToken === null ||
        recordedAt === null ||
        !DISPATCH_TOKEN_PATTERN.test(dispatchToken) ||
        Number.isNaN(Date.parse(recordedAt))
    ) {
        return null;
    }

    return { correlationId, runKey, dispatchToken, recordedAt };
}

/** The two bookkeeping members of one stored attempt. */
interface AttemptFlags {
    readonly attempt: number;
    /** Whether its 2xx has come back. */
    readonly acknowledged: boolean;
}

/**
 * Read the attempt number and the acknowledgement flag.
 *
 * @returns The members, or `null` when either is malformed.
 */
function readAttemptFlags(record: Record<string, JsonValue>): AttemptFlags | null {
    const { attempt, acknowledged } = record;
    if (
        typeof attempt !== 'number' ||
        typeof acknowledged !== 'boolean' ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1
    ) {
        return null;
    }

    return { attempt, acknowledged };
}

/** The outcome members of one stored attempt. */
interface AttemptOutcome {
    /** What the host call produced. */
    readonly outcome: DispatchOutcomeKind;
    /** Session id on a dispatched outcome, else `null`. */
    readonly sessionId: string | null;
    /** Cause on a failed outcome, else `null`. */
    readonly reason: string | null;
}

/**
 * Read the outcome of one stored attempt, exactly as the host reported it.
 *
 * `outcome` decides which of `sessionId` / `reason` must be present, mirroring
 * the service's own "report exactly one outcome" rule: a record that
 * carried both, or neither, would be a fact the reconciliation loop could not
 * turn into a single honest report.
 *
 * @returns The outcome, or `null` when it is not a fact this build can re-send.
 */
function readAttemptOutcome(record: Record<string, JsonValue>): AttemptOutcome | null {
    const { outcome } = record;
    if (outcome !== 'dispatched' && outcome !== 'failed') {
        return null;
    }

    const sessionId = readNullableText(record, 'sessionId');
    const reason = readNullableText(record, 'reason');
    if (sessionId === undefined || reason === undefined) {
        return null;
    }

    const wasDispatched = outcome === 'dispatched';
    if (wasDispatched !== (sessionId !== null) || wasDispatched === (reason !== null)) {
        return null;
    }

    return { outcome, sessionId, reason };
}

/**
 * Validate one stored attempt.
 *
 * @returns The attempt, or `null` when its shape is unusable.
 */
function readAttempt(value: JsonValue): DispatchAttemptRecord | null {
    const record = asJsonRecord(value);
    if (record === null) {
        return null;
    }

    const head = readAttemptHead(record);
    const flags = readAttemptFlags(record);
    const outcome = readAttemptOutcome(record);
    if (head === null || flags === null || outcome === null) {
        return null;
    }

    return { ...head, ...flags, ...outcome };
}

/**
 * Validate the attempt list of a stored document.
 *
 * @returns The attempts, or `null` when any element is unusable.
 */
function readAttempts(value: JsonValue | undefined): DispatchAttemptRecord[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const attempts: DispatchAttemptRecord[] = [];
    for (const raw of value) {
        const attempt = readAttempt(raw);
        if (attempt === null) {
            return null;
        }

        attempts.push(attempt);
    }

    return attempts;
}

/**
 * Read the attempt record back from `host.storage`.
 *
 * @returns The document for an absent or usable value; `null` when the value is
 *   present but not a document this build may half-apply.
 */
export function readDispatchRecord(value?: JsonValue): DispatchRecordDocument | null {
    if (value === undefined || value === null) {
        return emptyDocument();
    }

    const record = asJsonRecord(value);
    if (record?.schemaVersion !== DISPATCH_SCHEMA_VERSION) {
        return null;
    }

    const attempts = readAttempts(record.attempts);

    return attempts === null ? null : { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts };
}

/**
 * Load the attempt record from the panel's storage.
 *
 * @returns The document (empty when the key is wiped/absent), or `unreadable`
 *   when storage threw or held a document this build refuses.
 */
export async function loadDispatchRecord(rt: PanelRuntime): Promise<DispatchRecordRead> {
    let stored: JsonValue | undefined;
    try {
        stored = await rt.host.storage.get(DISPATCH_STORAGE_KEY);
    } catch {
        return { ok: false };
    }

    const document = readDispatchRecord(stored);

    return document === null ? { ok: false } : { ok: true, document };
}

/**
 * Append one attempt, evicting to the cap if the write pushes it over.
 *
 * Pure, so the cap and the eviction preference are testable without storage.
 * The victim is always the **oldest acknowledged** record; an unacknowledged
 * record is the only evidence that a session may exist, so eviction never takes
 * one. When nothing is acknowledged the cap gives way to that rule — losing the
 * reconciliation source to a bookkeeping bound would be the wrong trade — one
 * honest bound beats a bound that is merely persisted.
 *
 * @returns The new document.
 */
export function appendAttempt(
    document: DispatchRecordDocument,
    record: DispatchAttemptRecord,
): DispatchRecordDocument {
    const attempts = [...document.attempts, record];
    while (attempts.length > MAX_RECORDED_ATTEMPTS) {
        const victim = attempts.findIndex((candidate) => candidate.acknowledged);
        if (victim === -1) {
            break;
        }

        attempts.splice(victim, 1);
    }

    return { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts };
}

/**
 * Flip `acknowledged` on exactly one attempt.
 *
 * Keyed by correlation id **and** attempt, so an acknowledgement for an earlier
 * attempt can never mark a later one as seen — the same discipline the handled
 * list uses in the relay.
 *
 * @returns The new document.
 */
export function acknowledgeAttempt(input: {
    /** Current document. */
    readonly document: DispatchRecordDocument;
    /** Run the 2xx was for. */
    readonly correlationId: string;
    /** Attempt the 2xx was for. */
    readonly attempt: number;
}): DispatchRecordDocument {
    const { document, correlationId, attempt } = input;
    const attempts = document.attempts.map(
        (candidate) =>
            candidate.correlationId === correlationId && candidate.attempt === attempt && !candidate.acknowledged
                ? { ...candidate, acknowledged: true }
                : candidate,
    );

    return { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts };
}

/**
 * The attempts reconciliation still owes the service.
 *
 * @returns Every unacknowledged attempt, oldest first.
 */
export function unacknowledgedAttempts(document: DispatchRecordDocument): readonly DispatchAttemptRecord[] {
    return document.attempts.filter((attempt) => !attempt.acknowledged);
}

/**
 * Persist the record behind the redaction guard; never throws.
 *
 * @returns `true` when the write landed, `false` when it was refused.
 */
async function persist(rt: PanelRuntime, document: DispatchRecordDocument): Promise<boolean> {
    if (!isJsonValue(document)) {
        return false;
    }

    // `writeStorage` runs `assertRedacted` over the serialized document before
    // the host is called — the "every write is scanned" half of the guard.
    return await writeStorage(rt, { key: DISPATCH_STORAGE_KEY, value: document });
}

/**
 * Record the outcome of one dispatch attempt, durably, before it is reported.
 *
 * This is the durable write: the relay calls it after `host.startSession()`
 * returns and before the result POST goes out, so a report that never lands
 * still leaves a record reconciliation can re-send on the next mount.
 *
 * @returns `true` when the record landed; `false` when the value was refused.
 */
export async function recordDispatchOutcome(rt: PanelRuntime, input: {
    /** Run the attempt belongs to. */
    readonly correlationId: string;
    /** The run tuple, so the record reads alone. */
    readonly runKey: string;
    /** Attempt number this outcome is for. */
    readonly attempt: number;
    /** Single-use token the result report will present. */
    readonly dispatchToken: string;
    /** What the host call produced. */
    readonly outcome: RecordedOutcome;
}): Promise<boolean> {
    const read = await loadDispatchRecord(rt);
    if (!read.ok) {
        return false;
    }

    const record: DispatchAttemptRecord = {
        correlationId: input.correlationId,
        runKey: input.runKey,
        attempt: input.attempt,
        dispatchToken: input.dispatchToken,
        outcome: input.outcome.kind,
        sessionId: input.outcome.kind === 'dispatched' ? input.outcome.sessionId : null,
        reason: input.outcome.kind === 'failed' ? input.outcome.reason : null,
        recordedAt: nowIso(),
        acknowledged: false,
    };
    // Read back what is about to be written: a record the panel could not parse
    // on remount must never reach storage in the first place.
    if (!isJsonValue(record) || readAttempt(record) === null) {
        return false;
    }

    return await persist(rt, appendAttempt(read.document, record));
}

/**
 * Mark one attempt acknowledged after its 2xx came back.
 *
 * @returns `true` when the flip landed, `false` when nothing changed or the
 *   write could not be persisted.
 */
export async function acknowledgeDispatch(input: {
    readonly rt: PanelRuntime;
    /** Run the 2xx was for. */
    readonly correlationId: string;
    /** Attempt the 2xx was for. */
    readonly attempt: number;
}): Promise<boolean> {
    const { rt, correlationId, attempt } = input;
    const read = await loadDispatchRecord(rt);
    if (!read.ok) {
        return false;
    }

    const next = acknowledgeAttempt({ document: read.document, correlationId, attempt });
    const wasChanged = next.attempts.some((entry, index) => entry !== read.document.attempts[index]);
    if (!wasChanged) {
        // No matching attempt, or it was already acknowledged: writing would
        // only churn the key, and an acknowledgement for an attempt the panel
        // never recorded is not a fact worth persisting.
        return false;
    }

    return await persist(rt, next);
}
