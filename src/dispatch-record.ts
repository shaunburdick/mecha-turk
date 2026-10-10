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
    /**
     * Follow-up delivery state, oldest first.
     *
     * **Absentable on read**: a document written before the tracking lifecycle
     * existed carries none and must still parse, so the reconciliation pass
     * simply has nothing follow-up-shaped to look at. It is the panel's own
     * durable record of what it has already delivered and what it has parked —
     * the half of at-most-once a remount needs, because the service holds no
     * record of a prompt and cannot be asked for one (002 FR-104, NFR-002).
     */
    readonly followUps?: readonly FollowUpDeliveryRecord[];
}

/**
 * What one follow-up delivery attempt produced.
 *
 * A closed union rather than a free string, because the reason a delivery parks
 * is the exact cause an operator reads on the run row and in the trail (002
 * FR-105) — and a second spelling of "the session was busy" would be two answers
 * to one question.
 *
 * **A closed panel is not a cause.** A mount that goes away mid-attempt fails
 * the in-flight host call like any other host refusal (`host-unavailable`), and
 * a mount that goes away between attempts leaves the record *due*: the durable
 * record carries the attempt count and the next-attempt stamp, so the remount
 * resumes the ladder instead of parking on a mount it cannot see (spec.md User
 * Story 7's third scenario). A "panel closed" park would be the one failure this
 * panel could never recover from, and the value it would ride has no writer.
 */
export type FollowUpFailure =
    /** The host reported no open session. */
    | 'no-session'
    /** The session was mid-turn; a retryable refusal, never a queue. */
    | 'session-busy'
    /** `host.openSession` was refused. */
    | 'navigation-refused'
    /** The composed message was over the dispatch budget. */
    | 'over-budget'
    /** The host rejected or timed out the prompt, or the transport failed. */
    | 'host-unavailable';

/** One follow-up delivery's durable state (002 FR-104, FR-105). */
export interface FollowUpDeliveryRecord {
    /** The deterministic event id — the at-most-once key. */
    readonly deliveryId: string;
    /** The run the follow-up belongs to. */
    readonly correlationId: string;
    /**
     * The session the follow-up is delivered into, or `null` when the attempt
     * never had one.
     *
     * A `NO_SESSION` refusal is a recorded attempt with no session to name:
     * inventing one — the run's attachment id, say — would put a session id in
     * the record that no host ever created. Absent and empty are still refused;
     * `null` is the honest value, and it is the same nullable shape the
     * attempts' own `sessionId` member already uses.
     */
    readonly sessionId: string | null;
    /** Attempts used so far; `1` is the first. */
    readonly attempt: number;
    /** Epoch milliseconds the next attempt may be made at; `null` when it may go now. */
    readonly nextAttemptAtMs: number | null;
    /** `true` once the host accepted the prompt. */
    readonly delivered: boolean;
    /** The exact cause of the last failed attempt, or `null` when none failed. */
    readonly reason: FollowUpFailure | null;
    /** `true` once the retry bound is exhausted and the follow-up is parked. */
    readonly parked: boolean;
    /** RFC 3339 stamp of the last write. */
    readonly updatedAt: string;
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

/** The failure causes a follow-up delivery parks with, and nothing else. */
const FOLLOW_UP_FAILURES: ReadonlySet<string> = new Set<FollowUpFailure>([
    'no-session',
    'session-busy',
    'navigation-refused',
    'over-budget',
    'host-unavailable',
]);

/** Cap on the follow-up delivery records the document holds. */
export const MAX_FOLLOW_UP_RECORDS = 50;

/**
 * Read the failure cause of a follow-up delivery record.
 *
 * @param record - Parsed follow-up row.
 * @returns The cause, `null` when none is recorded, or `undefined` when a present
 *   value is outside the closed union.
 */
function readFollowUpReason(record: Record<string, JsonValue>): FollowUpFailure | null | undefined {
    const value = record.reason;
    if (value === null || value === undefined) {
        return null;
    }

    return typeof value === 'string' && FOLLOW_UP_FAILURES.has(value) ? (value as FollowUpFailure) : undefined;
}

/** The counting and flag members of one follow-up delivery record. */
interface FollowUpFlags {
    readonly attempt: number;
    readonly delivered: boolean;
    readonly parked: boolean;
}

/**
 * Read the counting and flag members of one follow-up delivery record.
 *
 * @returns The members, or `null` when any is malformed.
 */
function readFollowUpFlags(record: Record<string, JsonValue>): FollowUpFlags | null {
    const { attempt, delivered, parked } = record;
    if (
        typeof delivered !== 'boolean'
        || typeof parked !== 'boolean'
        || typeof attempt !== 'number'
        || !Number.isSafeInteger(attempt)
        || attempt < 1
    ) {
        return null;
    }

    return { attempt, delivered, parked };
}

/**
 * Read the scheduling member of one follow-up delivery record.
 *
 * @returns `null` for "may go now", the epoch milliseconds, or `undefined` when
 *   the value is present and unusable.
 */
function readNextAttemptAtMs(record: Record<string, JsonValue>): number | null | undefined {
    const value = record.nextAttemptAtMs;
    if (value === null) {
        return null;
    }

    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate one stored follow-up delivery record.
 *
 * @returns The record, or `null` when its shape is unusable.
 */
function readFollowUp(value: JsonValue): FollowUpDeliveryRecord | null {
    const record = asJsonRecord(value);
    if (record === null) {
        return null;
    }

    const deliveryId = readText(record, 'deliveryId');
    const correlationId = readText(record, 'correlationId');
    const sessionId = readNullableText(record, 'sessionId');
    const updatedAt = readText(record, 'updatedAt');
    const reason = readFollowUpReason(record);
    const flags = readFollowUpFlags(record);
    const nextAttemptAtMs = readNextAttemptAtMs(record);
    if (
        deliveryId === null
        || correlationId === null
        || sessionId === undefined
        || updatedAt === null
        || reason === undefined
        || flags === null
        || nextAttemptAtMs === undefined
    ) {
        return null;
    }

    return { deliveryId, correlationId, sessionId, ...flags, nextAttemptAtMs, reason, updatedAt };
}

/**
 * Validate the follow-up list of a stored document.
 *
 * Absent reads as *no follow-up state recorded*, which is what a document
 * written before this section existed means — never an error, and never an empty
 * list that would lose what the panel already delivered.
 *
 * @returns The records, or `null` when a present list is unusable.
 */
function readFollowUps(value: JsonValue | undefined): readonly FollowUpDeliveryRecord[] | null {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value)) {
        return null;
    }

    const records: FollowUpDeliveryRecord[] = [];
    for (const raw of value) {
        const record = readFollowUp(raw);
        if (record === null) {
            return null;
        }

        records.push(record);
    }

    return records;
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
    const followUps = readFollowUps(record.followUps);

    return attempts === null || followUps === null
        ? null
        : {
            schemaVersion: DISPATCH_SCHEMA_VERSION,
            attempts,
            ...(followUps.length > 0 && { followUps }),
        };
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
 * The chain every writer of {@link DISPATCH_STORAGE_KEY} serializes onto.
 *
 * One chain for the key, not one per writer: a read-modify-write is only safe
 * because no *other* read-modify-write can land between its read and its write,
 * and a chain each writer kept for itself would be four chains for one key.
 */
const recordChain: { write: Promise<unknown> } = { write: Promise.resolve() };

/**
 * Take the next turn on the dispatch record's write chain.
 *
 * @returns Whatever `task` produced, once every earlier writer settled.
 */
function inRecordChain<T>(task: () => Promise<T>): Promise<T> {
    // eslint-disable-next-line unicorn/prefer-then-catch -- one task in both arms: a refused write cannot wedge the key
    const write = recordChain.write.then(task, task);
    recordChain.write = write;

    return write;
}

/**
 * Read, transform, and persist the dispatch record as one critical section.
 *
 * Every writer of the key is `load → transform → persist`, and the section spans
 * two awaits — the host's read and its write. Reading `relay.inFlight` /
 * `relay.dispatching` before the first `await` makes the *start* of that section
 * safe, not the whole of it: a relay tick that starts inside it writes its own
 * document, and a re-offer then overwrites it with one derived from its earlier
 * read. The write lost that way is the tick's `delivered: true`, and a delivery
 * the record forgets is a delivery the next tick re-offers — the second prompt
 * NFR-002 and constitution III exist to prevent. How often an operator clicks
 * during a tick decides how often that happens, not whether it can.
 *
 * Taking turns on {@link inRecordChain} is what makes the section a critical
 * section: each transform runs against the document the previous writer left
 * behind, so a concurrent writer's row is carried forward rather than dropped.
 * The alternative — re-load and re-derive immediately before `persist`, bailing
 * when the document moved — cannot tell the caller *what* moved, so its only
 * safe bail is to refuse the write and report it, which turns a slow host into a
 * lost re-offer. A chain of promises loses nothing and costs one queue.
 *
 * Reads stay outside the chain: `host.storage` answers each call whole, so a
 * reader sees either the previous document or the new one, never half of one —
 * and the stale answer is the safe direction, since it projects *more* of a run's
 * movements rather than fewer.
 *
 * @param rt - Runtime whose storage the record lives in.
 * @param transform - Derive the next document, or `null` to write nothing.
 * @returns `true` when the write landed, `false` when the record was unreadable,
 *   the transform declined, or the write was refused.
 */
async function updateDispatchRecord(
    rt: PanelRuntime,
    transform: (document: DispatchRecordDocument) => DispatchRecordDocument | null,
): Promise<boolean> {
    return await inRecordChain(async () => {
        const read = await loadDispatchRecord(rt);
        if (!read.ok) {
            return false;
        }

        const next = transform(read.document);
        if (next === null) {
            return false;
        }

        return await persist(rt, next);
    });
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

    return await updateDispatchRecord(rt, (document) => appendAttempt(document, record));
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

    return await updateDispatchRecord(rt, (document) => {
        const next = acknowledgeAttempt({ document, correlationId, attempt });
        const wasChanged = next.attempts.some((entry, index) => entry !== document.attempts[index]);
        if (!wasChanged) {
            // No matching attempt, or it was already acknowledged: writing would
            // only churn the key, and an acknowledgement for an attempt the panel
            // never recorded is not a fact worth persisting.
            return null;
        }

        return next;
    });
}

/**
 * Fold one follow-up delivery record into a document, replacing the entry with
 * the same delivery id.
 *
 * The list is bounded the same way the attempts are — oldest first, newest last
 * — but with one difference that matters: a **delivered** record is the
 * at-most-once evidence, so it is never the victim. Eviction takes the oldest
 * record that is neither delivered nor parked, which is the only kind whose loss
 * costs a retry rather than a duplicate or a missing follow-up.
 *
 * @returns The new document.
 */
export function putFollowUpRecord(
    document: DispatchRecordDocument,
    record: FollowUpDeliveryRecord,
): DispatchRecordDocument {
    const existing = document.followUps ?? [];
    const kept = existing.filter((candidate) => candidate.deliveryId !== record.deliveryId);
    const followUps = [...kept, record];
    while (followUps.length > MAX_FOLLOW_UP_RECORDS) {
        const victim = followUps.findIndex((candidate) => !candidate.delivered && !candidate.parked);
        if (victim === -1) {
            break;
        }

        followUps.splice(victim, 1);
    }

    return { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts: document.attempts, followUps };
}

/**
 * Read one follow-up delivery's durable state.
 *
 * @returns The record, or `undefined` when this panel has never touched it.
 */
export function followUpRecordOf(
    document: DispatchRecordDocument,
    deliveryId: string,
): FollowUpDeliveryRecord | undefined {
    return (document.followUps ?? []).find((candidate) => candidate.deliveryId === deliveryId);
}

/**
 * Persist one follow-up delivery record; never throws.
 *
 * The write happens **before** the host call when the record carries an intent,
 * and after it when it carries an outcome — the same "durable before you act"
 * ordering the dispatch record uses, because a delivery whose result never
 * lands has to leave the truth recoverable on this side.
 *
 * @returns `true` when the record landed, `false` when it was refused.
 */
export async function recordFollowUpDelivery(
    rt: PanelRuntime,
    record: FollowUpDeliveryRecord,
): Promise<boolean> {
    // Read back what is about to be written: a record the panel could not parse
    // on remount must never reach storage in the first place. The check goes
    // through `JsonValue` rather than the typed shape, so it is exactly the
    // validation a stored row would get on the way back in.
    const wire: JsonValue | undefined = isJsonValue(record) ? record : undefined;
    if (wire === undefined || readFollowUp(wire) === null) {
        return false;
    }

    return await updateDispatchRecord(rt, (document) => putFollowUpRecord(document, record));
}

/**
 * Move parked follow-up deliveries back to due, keyed by delivery id.
 *
 * The operator-initiated re-offer FR-105 owes a parked follow-up (AC-051). The
 * record is the at-most-once authority and this only ever moves a record — it
 * clears the two members that park a delivery (`parked` and `reason`) and makes
 * it due again. **`delivered` and `attempt` are untouched**: a delivered
 * delivery has nothing to re-offer, and an attempt count the re-offer reset
 * would re-spend the ladder the park had just exhausted, which is the duplicate
 * direction the record exists to refuse (NFR-002).
 *
 * The re-offered record goes through {@link putFollowUpRecord}'s replace, so it
 * is appended at the end of the list rather than left where it parked. That is
 * load-bearing for the walk, not tidiness: the read's window opening is derived
 * from this list ({@link followUpWindowOpening} in `follow-up.ts`), and an owed
 * record that sits *before* a delivered one would leave the read's window
 * opening past it — a re-offered follow-up the relay never sees again.
 *
 * @param input - The document, the deliveries to re-offer, and the write stamp.
 * @returns The new document, or `null` when no listed delivery is parked and
 *   undelivered — there is nothing to re-offer, and the caller writes nothing.
 */
export function reofferFollowUpRecords(input: {
    /** The panel's durable dispatch record. */
    readonly document: DispatchRecordDocument;
    /** The deterministic delivery ids to re-offer. */
    readonly deliveryIds: readonly string[];
    /** RFC 3339 stamp of the write. */
    readonly at: string;
}): DispatchRecordDocument | null {
    const { document, deliveryIds, at } = input;
    const existing = document.followUps ?? [];
    const wanted = new Set(deliveryIds);
    const reoffered = existing
        .filter((candidate) => wanted.has(candidate.deliveryId) && candidate.parked && !candidate.delivered)
        .map((candidate) => ({ ...candidate, parked: false, reason: null, nextAttemptAtMs: null, updatedAt: at }));
    if (reoffered.length === 0) {
        return null;
    }

    let next = document;
    for (const record of reoffered) {
        next = putFollowUpRecord(next, record);
    }

    return next;
}

/**
 * Re-offer parked follow-up deliveries through the durable record; never throws.
 *
 * The local half of FR-105's re-offer: no route, no service request, no run
 * state — the panel's own record is the only thing that moves, and the relay's
 * next tick is what delivers.
 *
 * @param input - The runtime and the deterministic delivery ids to re-offer.
 * @returns `true` when the record landed, `false` when nothing was parked, the
 *   record could not be read, or the write was refused.
 */
export async function reofferFollowUpDelivery(input: {
    /** Runtime whose storage the record lives in. */
    readonly rt: PanelRuntime;
    /** The deterministic delivery ids to re-offer. */
    readonly deliveryIds: readonly string[];
}): Promise<boolean> {
    const { rt, deliveryIds } = input;

    // The stamp is taken **inside** the chain, so it is the stamp of the write
    // rather than of the click that queued it: a re-offer that waited its turn
    // behind a relay tick records the moment the record actually moved.
    return await updateDispatchRecord(rt, (document) =>
        reofferFollowUpRecords({ document, deliveryIds, at: nowIso() }));
}
