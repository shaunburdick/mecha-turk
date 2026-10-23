/**
 * The panel's durable dispatch-attempt record: one entry per attempt under `mecha-turk:dispatches`, fail-closed read.
 */

import type { JsonValue } from '@openchamber/sdk';
import { isJsonValue } from './json.ts';
import { nowIso } from './ids.ts';
import { writeStorage } from './storage-write.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Storage key holding the attempt record (AGENTS invariant 4's prefix). */
export const DISPATCH_STORAGE_KEY = 'mecha-turk:dispatches';

export const DISPATCH_SCHEMA_VERSION = 'dispatch-attempts-2';

export const LEGACY_DISPATCH_SCHEMA_VERSION = 'dispatch-attempts-1';

/** Most attempts the record holds; eviction removes the oldest acknowledged or settled first. */
export const MAX_RECORDED_ATTEMPTS = 50;

/** The single-use token's minted shape — the same rule the service validates. */
const DISPATCH_TOKEN_PATTERN = /^dtk-[0-9a-f]{32}$/;

export type DispatchOutcomeKind = 'unknown' | 'dispatched' | 'failed';

type DispatchOrigin = 'v1' | 'v2';

/**
 * The outcome of one host call, as {@link recordDispatchOutcome} requires it:
 * the union is the ordering guard — no record can be constructed without naming
 * what `host.startSession()` returned, so "persist before you report" cannot be
 * violated without the call failing to type-check.
 */
export type RecordedOutcome =
    | { readonly kind: 'dispatched'; readonly sessionId: string }
    | { readonly kind: 'failed'; readonly reason: string };

export interface DispatchAttemptRecord {
    /** Run identity; every later call is addressed by it. */
    readonly correlationId: string;
    /** The human-readable run tuple, kept so a record is readable alone. */
    readonly runKey: string;
    /** Attempt this record is for; pairs with the correlation id as the key. */
    readonly attempt: number;
    /** The reservation this record belongs to; `null` on a row written before it existed. */
    readonly leaseId: string | null;
    readonly dispatchToken: string;
    readonly projectId: string | null;
    readonly worktreeOption: string | null;
    readonly outcome: DispatchOutcomeKind;
    /** Created session id on a dispatched outcome, else `null`. */
    readonly sessionId: string | null;
    /** Recorded cause on a failed outcome, else `null`. */
    readonly reason: string | null;
    readonly authorizedAt: string | null;
    readonly recordedAt: string;
    readonly settledAt: string | null;
    /** `true` once a 2xx for this exact attempt has come back. */
    readonly acknowledged: boolean;
}

export interface DispatchRecordDocument {
    readonly schemaVersion: typeof DISPATCH_SCHEMA_VERSION;
    /** Attempts, oldest first, newest last. */
    readonly attempts: readonly DispatchAttemptRecord[];
    /**
     * Follow-up delivery state, oldest first: the panel's own durable record of
     * what it has delivered and parked — the half of at-most-once a remount
     * needs, because the service holds no record of a prompt and cannot be
     * asked for one (002 FR-104, NFR-002). Absentable on read: an older
     * document must still parse.
     */
    readonly followUps?: readonly FollowUpDeliveryRecord[];
}

/** The closed vocabulary a delivery settles or waits in; a closed panel is not a cause — it has no writer. */
export type FollowUpFailure =
    | 'no-session'
    /** The fallback's waiting state: the target is not current or not observed idle; never an attempt. */
    | 'session-busy'
    /** A retry found the target no longer current (no navigation exists to refuse). */
    | 'navigation-refused'
    | 'over-budget'
    /** The host rejected or timed out the prompt, or the transport failed. */
    | 'host-unavailable'
    /** Engine-admitted and engine-held; only the service's projection writes it. */
    | 'engine-queued';

/** One follow-up delivery's durable state (002 FR-104, FR-105). */
export interface FollowUpDeliveryRecord {
    /** The deterministic event id — the at-most-once key. */
    readonly deliveryId: string;
    readonly correlationId: string;
    /**
     * The session the follow-up is delivered into, or `null` when the attempt
     * never had one: a `NO_SESSION` refusal is a recorded attempt with no
     * session to name, and inventing one would put a session id no host ever
     * created into the record. Absent and empty are still refused.
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
    readonly updatedAt: string;
}

export type DispatchRecordRead =
    /** The key was absent (wiped/fresh) or held a document this build understands. */
    | { readonly ok: true; readonly document: DispatchRecordDocument }
    /** Storage threw, or the key held a document this build must not half-apply. */
    | { readonly ok: false };

/**
 * Narrow a JSON value to a plain object record: `null`, arrays, and primitives
 * are not documents, and narrowing here means every member read below is typed
 * as a `JsonValue` rather than as `unknown`.
 */
function asJsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return value;
}

/** The empty document: what a wiped or never-written key means. */
function emptyDocument(): DispatchRecordDocument {
    return { schemaVersion: DISPATCH_SCHEMA_VERSION, attempts: [] };
}

function readText(record: Record<string, JsonValue>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' && value !== '' ? value : null;
}

/** Read a required nullable string field: explicit `null` is a value here; `undefined` means absent or malformed. */
function readNullableText(record: Record<string, JsonValue>, field: string): string | null | undefined {
    const value = record[field];
    if (value === null) {
        return null;
    }

    return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The identity and stamp members every stored attempt carries. */
interface AttemptHead {
    readonly correlationId: string;
    readonly runKey: string;
    readonly dispatchToken: string;
    readonly recordedAt: string;
}

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

interface AttemptFlags {
    readonly attempt: number;
    readonly acknowledged: boolean;
}

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

interface AttemptOutcome {
    readonly outcome: DispatchOutcomeKind;
    readonly sessionId: string | null;
    readonly reason: string | null;
}

/** `outcome` decides which of `sessionId` / `reason` must be present; `unknown` carries neither. */
function readAttemptOutcome(record: Record<string, JsonValue>): AttemptOutcome | null {
    const { outcome } = record;
    if (outcome !== 'unknown' && outcome !== 'dispatched' && outcome !== 'failed') {
        return null;
    }

    const sessionId = readNullableText(record, 'sessionId');
    const reason = readNullableText(record, 'reason');
    if (sessionId === undefined || reason === undefined) {
        return null;
    }

    const requiresSession = outcome === 'dispatched';
    const requiresReason = outcome === 'failed';
    if (requiresSession !== (sessionId !== null) || requiresReason !== (reason !== null)) {
        return null;
    }

    return { outcome, sessionId, reason };
}

interface AttemptContext {
    readonly leaseId: string | null;
    readonly projectId: string | null;
    readonly worktreeOption: string | null;
    readonly authorizedAt: string | null;
    readonly settledAt: string | null;
}

/** Absent is `null` here: a v2 row written before `leaseId` existed is still a usable row. */
function readOptionalText(record: Record<string, JsonValue>, field: string): string | null | undefined {
    const value = record[field];
    if (value === undefined || value === null) {
        return null;
    }

    return typeof value === 'string' && value !== '' ? value : undefined;
}

type ContextFields = { readonly [K in keyof AttemptContext]: AttemptContext[K] | undefined };

function isCompleteContext(fields: ContextFields): fields is AttemptContext {
    return Object.values(fields).every((value) => value !== undefined);
}

function readContextFields(record: Record<string, JsonValue>): AttemptContext | null {
    const fields: ContextFields = {
        leaseId: readOptionalText(record, 'leaseId'),
        projectId: readNullableText(record, 'projectId'),
        worktreeOption: readNullableText(record, 'worktreeOption'),
        authorizedAt: readNullableText(record, 'authorizedAt'),
        settledAt: readNullableText(record, 'settledAt'),
    };

    return isCompleteContext(fields) ? fields : null;
}

function isStampOrNull(value: string | null): boolean {
    return value === null || !Number.isNaN(Date.parse(value));
}

/** A v1 row reads the target and every stamp as `null`: it recorded none, and the reader invents none. */
function readAttemptContext(record: Record<string, JsonValue>, origin: DispatchOrigin): AttemptContext | null {
    if (origin === 'v1') {
        return { leaseId: null, projectId: null, worktreeOption: null, authorizedAt: null, settledAt: null };
    }

    const fields = readContextFields(record);
    if (fields === null || !isStampOrNull(fields.authorizedAt) || !isStampOrNull(fields.settledAt)) {
        return null;
    }

    return fields;
}

function readAttempt(value: JsonValue, origin: DispatchOrigin): DispatchAttemptRecord | null {
    const record = asJsonRecord(value);
    if (record === null) {
        return null;
    }

    const head = readAttemptHead(record);
    const flags = readAttemptFlags(record);
    const outcome = readAttemptOutcome(record);
    const context = readAttemptContext(record, origin);
    if (
        head === null
        || flags === null
        || outcome === null
        || context === null
        || (origin === 'v1' && outcome.outcome === 'unknown')
    ) {
        return null;
    }

    return { ...head, ...context, ...flags, ...outcome };
}

function readAttempts(value: JsonValue | undefined, origin: DispatchOrigin): DispatchAttemptRecord[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const attempts: DispatchAttemptRecord[] = [];
    for (const raw of value) {
        const attempt = readAttempt(raw, origin);
        if (attempt === null) {
            return null;
        }

        attempts.push(attempt);
    }

    return attempts;
}

const FOLLOW_UP_FAILURES: ReadonlySet<string> = new Set<FollowUpFailure>([
    'no-session',
    'session-busy',
    'navigation-refused',
    'over-budget',
    'host-unavailable',
    'engine-queued',
]);

export const MAX_FOLLOW_UP_RECORDS = 50;

/** The cause, `null` when none is recorded, `undefined` when a present value is outside the closed union. */
function readFollowUpReason(record: Record<string, JsonValue>): FollowUpFailure | null | undefined {
    const value = record.reason;
    if (value === null || value === undefined) {
        return null;
    }

    return typeof value === 'string' && FOLLOW_UP_FAILURES.has(value) ? (value as FollowUpFailure) : undefined;
}

interface FollowUpFlags {
    readonly attempt: number;
    readonly delivered: boolean;
    readonly parked: boolean;
}

/** The members, or `null` when any is malformed. */
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

/** `null` for "may go now", the epoch milliseconds, or `undefined` when the value is present and unusable. */
function readNextAttemptAtMs(record: Record<string, JsonValue>): number | null | undefined {
    const value = record.nextAttemptAtMs;
    if (value === null) {
        return null;
    }

    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// A pre-amendment record parked with `session-busy` was a refused attempt, not
// delivered work: it reads back re-armed — attempt history intact, due now.
function rearmLegacySessionBusy(record: FollowUpDeliveryRecord): FollowUpDeliveryRecord {
    return record.parked && record.reason === 'session-busy'
        ? { ...record, parked: false, nextAttemptAtMs: null }
        : record;
}

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

    return rearmLegacySessionBusy({
        deliveryId,
        correlationId,
        sessionId,
        ...flags,
        nextAttemptAtMs,
        reason,
        updatedAt,
    });
}

/**
 * Absent reads as *no follow-up state recorded* — what an older document means —
 * never an error, and never an empty list that would lose what the panel already
 * delivered. Answers `null` when a present list is unusable.
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

function originOf(schema: JsonValue | undefined): DispatchOrigin | null {
    if (schema === DISPATCH_SCHEMA_VERSION) {
        return 'v2';
    }

    return schema === LEGACY_DISPATCH_SCHEMA_VERSION ? 'v1' : null;
}

/** The document for an absent or usable value; `null` for one this build must not half-apply. */
export function readDispatchRecord(value?: JsonValue): DispatchRecordDocument | null {
    if (value === undefined || value === null) {
        return emptyDocument();
    }

    const record = asJsonRecord(value);
    if (record === null) {
        return null;
    }

    const origin = originOf(record.schemaVersion);
    if (origin === null) {
        return null;
    }

    const attempts = readAttempts(record.attempts, origin);
    const followUps = readFollowUps(record.followUps);

    return attempts === null || followUps === null
        ? null
        : {
            schemaVersion: DISPATCH_SCHEMA_VERSION,
            attempts,
            ...(followUps.length > 0 && { followUps }),
        };
}

/** The document (empty when the key is wiped/absent), or `unreadable` when storage threw or the document is refused. */
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

/** Every attempts-side write carries the document's follow-ups unchanged (FR-024). */
function withAttempts(
    document: DispatchRecordDocument,
    attempts: readonly DispatchAttemptRecord[],
): DispatchRecordDocument {
    return {
        schemaVersion: DISPATCH_SCHEMA_VERSION,
        attempts,
        ...(document.followUps !== undefined && { followUps: document.followUps }),
    };
}

function trimToCap(attempts: DispatchAttemptRecord[]): void {
    while (attempts.length > MAX_RECORDED_ATTEMPTS) {
        const victim = attempts.findIndex((candidate) => candidate.acknowledged || candidate.settledAt !== null);
        if (victim === -1) {
            break;
        }

        attempts.splice(victim, 1);
    }
}

/**
 * Replace the record keyed by correlation id + attempt, never append a second, and
 * evict the oldest acknowledged-or-settled one at the cap; with no such victim the
 * cap gives way, because losing the reconciliation source to a bound is the worse trade.
 */
export function appendAttempt(
    document: DispatchRecordDocument,
    record: DispatchAttemptRecord,
): DispatchRecordDocument {
    const attempts = [...document.attempts];
    const index = attempts.findIndex((candidate) => candidate.correlationId === record.correlationId
        && candidate.attempt === record.attempt);
    if (index === -1) {
        attempts.push(record);
    } else {
        attempts[index] = record;
    }

    trimToCap(attempts);

    return withAttempts(document, attempts);
}

function outcomeFields(
    outcome: RecordedOutcome,
): Pick<DispatchAttemptRecord, 'outcome' | 'sessionId' | 'reason'> {
    return outcome.kind === 'dispatched'
        ? { outcome: 'dispatched', sessionId: outcome.sessionId, reason: null }
        : { outcome: 'failed', sessionId: null, reason: outcome.reason };
}

function upgradeOf(
    existing: DispatchAttemptRecord,
    resolved: RecordedOutcome | undefined,
): RecordedOutcome | undefined {
    if (existing.outcome !== 'unknown') {
        return undefined;
    }

    return resolved;
}

function resolvedRecord(input: {
    readonly correlationId: string;
    readonly runKey: string;
    readonly attempt: number;
    readonly leaseId: string;
    readonly dispatchToken: string;
    readonly outcome: RecordedOutcome;
}, existing: DispatchAttemptRecord | undefined): DispatchAttemptRecord {
    return {
        correlationId: input.correlationId,
        runKey: input.runKey,
        attempt: input.attempt,
        leaseId: input.leaseId,
        dispatchToken: input.dispatchToken,
        projectId: existing?.projectId ?? null,
        worktreeOption: existing?.worktreeOption ?? null,
        ...outcomeFields(input.outcome),
        authorizedAt: existing?.authorizedAt ?? null,
        recordedAt: nowIso(),
        settledAt: null,
        acknowledged: existing?.acknowledged ?? false,
    };
}

function withRecord(
    document: DispatchRecordDocument,
    record: DispatchAttemptRecord,
): DispatchRecordDocument | null {
    if (!isJsonValue(record) || readAttempt(record, 'v2') === null) {
        return null;
    }

    return appendAttempt(document, record);
}

/** Replace this reservation's record, or append it when evicted — never clobber another reservation. */
function withOutcomeRecord(
    document: DispatchRecordDocument,
    record: DispatchAttemptRecord,
): DispatchRecordDocument | null {
    if (!isJsonValue(record) || readAttempt(record, 'v2') === null) {
        return null;
    }

    const attempts = [...document.attempts];
    const index = attempts.findIndex((candidate) => candidate.correlationId === record.correlationId
        && candidate.attempt === record.attempt
        && candidate.leaseId === record.leaseId);
    if (index === -1) {
        attempts.push(record);
    } else {
        attempts[index] = record;
    }

    trimToCap(attempts);

    return withAttempts(document, attempts);
}

/** Every unacknowledged attempt, oldest first. */
export function unacknowledgedAttempts(document: DispatchRecordDocument): readonly DispatchAttemptRecord[] {
    return document.attempts.filter((attempt) => !attempt.acknowledged);
}

/**
 * Persist the record behind the redaction guard; never throws.
 */
async function persist(rt: PanelRuntime, document: DispatchRecordDocument): Promise<boolean> {
    if (!isJsonValue(document)) {
        return false;
    }

    return await writeStorage(rt, { key: DISPATCH_STORAGE_KEY, value: document });
}

/**
 * The chain every writer of {@link DISPATCH_STORAGE_KEY} serializes onto: one
 * chain for the key, not one per writer — a read-modify-write is only safe
 * because no *other* read-modify-write can land between its read and its write.
 */
const recordChain: { write: Promise<unknown> } = { write: Promise.resolve() };

/** Whatever `task` produced, once every earlier writer settled. */
function inRecordChain<T>(task: () => Promise<T>): Promise<T> {
    // eslint-disable-next-line unicorn/prefer-then-catch -- one task in both arms: a refused write cannot wedge the key
    const write = recordChain.write.then(task, task);
    recordChain.write = write;

    return write;
}

/**
 * Read, transform, and persist the dispatch record as one critical section. Checking
 * `relay.inFlight` / `relay.dispatching` before the first `await` makes only the *start* safe: a
 * relay tick writing inside the section would be overwritten by one derived from an earlier read,
 * dropping its `delivered: true` and re-offering a delivery that already happened — the second
 * prompt NFR-002 and constitution III exist to prevent. Taking turns on {@link inRecordChain} is
 * what makes it critical, where a reload-and-retry could only refuse a slow host into a lost
 * re-offer. Reads stay outside: `host.storage` answers whole, and a stale answer projects *more*
 * movements, not fewer.
 */
async function updateDispatchRecord(
    rt: PanelRuntime,
    transform: (document: DispatchRecordDocument) => DispatchRecordDocument | 'unchanged' | null,
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

        return next === 'unchanged' || await persist(rt, next);
    });
}

/**
 * The reservation identifies the attempt: a matching `(correlationId, attempt, leaseId)`
 * is a no-op, and a different lease at the same attempt is a new cycle that replaces it.
 */
export async function recordDispatchIntent(rt: PanelRuntime, input: {
    readonly correlationId: string;
    /** The run tuple, so the record reads alone. */
    readonly runKey: string;
    readonly attempt: number;
    readonly leaseId: string;
    readonly dispatchToken: string;
    readonly projectId: string;
    readonly worktreeOption: string;
}): Promise<boolean> {
    const at = nowIso();
    const record: DispatchAttemptRecord = {
        correlationId: input.correlationId,
        runKey: input.runKey,
        attempt: input.attempt,
        leaseId: input.leaseId,
        dispatchToken: input.dispatchToken,
        projectId: input.projectId,
        worktreeOption: input.worktreeOption,
        outcome: 'unknown',
        sessionId: null,
        reason: null,
        authorizedAt: at,
        recordedAt: at,
        settledAt: null,
        acknowledged: false,
    };

    return await updateDispatchRecord(rt, (document) => {
        const existing = document.attempts.find((candidate) => candidate.correlationId === input.correlationId
            && candidate.attempt === input.attempt);

        return existing?.leaseId === input.leaseId ? 'unchanged' : withRecord(document, record);
    });
}

/**
 * Replace the record carrying this reservation with its resolved outcome before the
 * result POST, so a report that never lands is still recoverable and re-sendable.
 */
export async function recordDispatchOutcome(rt: PanelRuntime, input: {
    readonly correlationId: string;
    readonly runKey: string;
    readonly attempt: number;
    readonly leaseId: string;
    readonly dispatchToken: string;
    readonly outcome: RecordedOutcome;
}): Promise<boolean> {
    return await updateDispatchRecord(rt, (document) => {
        const existing = document.attempts.find((candidate) => candidate.correlationId === input.correlationId
            && candidate.attempt === input.attempt
            && candidate.leaseId === input.leaseId);

        return withOutcomeRecord(document, resolvedRecord(input, existing));
    });
}

/**
 * Flip `acknowledged` on the record carrying this reservation; when the outcome
 * write did not land, carry the resolved outcome into the same write, so no
 * acknowledged record is left `unknown`.
 */
export async function acknowledgeDispatch(input: {
    readonly rt: PanelRuntime;
    readonly correlationId: string;
    readonly attempt: number;
    readonly leaseId: string | null;
    readonly resolved?: {
        readonly runKey: string;
        readonly dispatchToken: string;
        readonly outcome: RecordedOutcome;
    };
}): Promise<boolean> {
    const { rt, correlationId, attempt, leaseId, resolved } = input;

    return await updateDispatchRecord(rt, (document) => {
        const index = document.attempts.findIndex((candidate) => candidate.correlationId === correlationId
            && candidate.attempt === attempt
            && candidate.leaseId === leaseId);
        const existing = document.attempts[index];
        if (existing === undefined) {
            return null;
        }

        const upgrade = upgradeOf(existing, resolved?.outcome);
        if (upgrade === undefined && existing.acknowledged) {
            return null;
        }

        const record: DispatchAttemptRecord = upgrade === undefined
            ? { ...existing, acknowledged: true }
            : {
                ...existing,
                ...outcomeFields(upgrade),
                recordedAt: nowIso(),
                settledAt: null,
                acknowledged: true,
            };

        return withRecord(document, record);
    });
}

/**
 * Mark one `unknown` attempt past, leaving the outcome `unknown`: the panel learned
 * only that the attempt is past, never what the host returned (FR-045).
 */
export function settleAttempt(input: {
    readonly document: DispatchRecordDocument;
    readonly correlationId: string;
    readonly attempt: number;
    readonly leaseId: string | null;
    readonly at: string;
}): DispatchRecordDocument | null {
    const index = input.document.attempts.findIndex((candidate) => candidate.correlationId === input.correlationId
        && candidate.attempt === input.attempt
        && candidate.leaseId === input.leaseId);
    const existing = input.document.attempts[index];
    if (existing?.outcome !== 'unknown' || existing.settledAt !== null) {
        return null;
    }

    const attempts = [...input.document.attempts];
    attempts[index] = { ...existing, settledAt: input.at };

    return withAttempts(input.document, attempts);
}

export async function settleDispatchAttempt(input: {
    readonly rt: PanelRuntime;
    readonly correlationId: string;
    readonly attempt: number;
    readonly leaseId: string | null;
}): Promise<boolean> {
    return await updateDispatchRecord(input.rt, (document) => settleAttempt({
        document,
        correlationId: input.correlationId,
        attempt: input.attempt,
        leaseId: input.leaseId,
        at: nowIso(),
    }));
}

export interface FollowUpSeed {
    readonly deliveryId: string;
    readonly correlationId: string;
    readonly sessionId: string | null;
}

/**
 * Fold one follow-up delivery record into a document, replacing the entry with
 * the same delivery id. Eviction takes the oldest record that is neither
 * delivered nor parked: a **delivered** record is the at-most-once evidence and
 * never the victim, and the other kind's loss costs a retry rather than a
 * duplicate or a missing follow-up.
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

/** The record, or `undefined` when this panel has never touched it. */
export function followUpRecordOf(
    document: DispatchRecordDocument,
    deliveryId: string,
): FollowUpDeliveryRecord | undefined {
    return (document.followUps ?? []).find((candidate) => candidate.deliveryId === deliveryId);
}

/**
 * Persist one follow-up delivery record; never throws. The write happens
 * **before** the host call when the record carries an intent and after it when
 * it carries an outcome — the same "durable before you act" ordering the
 * dispatch record uses, because a result that never lands must leave the truth
 * recoverable on this side.
 */
export async function recordFollowUpDelivery(
    rt: PanelRuntime,
    record: FollowUpDeliveryRecord,
): Promise<boolean> {
    // Read back what is about to be written — through `JsonValue`, exactly the
    // validation a stored row gets on the way back in: a record the panel could
    // not parse on remount must never reach storage.
    const wire: JsonValue | undefined = isJsonValue(record) ? record : undefined;
    if (wire === undefined || readFollowUp(wire) === null) {
        return false;
    }

    return await updateDispatchRecord(rt, (document) => putFollowUpRecord(document, record));
}

/**
 * Move parked follow-up deliveries back to due — the operator's re-offer. It clears only `parked` and `reason`:
 * `attempt` would re-spend the ladder. Re-appended last: `followUpWindowOpening` reads the window from list order.
 */
export function reofferFollowUpRecords(input: {
    readonly document: DispatchRecordDocument;
    readonly deliveryIds: readonly string[];
    readonly at: string;
    readonly seeds?: readonly FollowUpSeed[];
}): DispatchRecordDocument | null {
    const { document, deliveryIds, at } = input;
    const existing = document.followUps ?? [];
    const wanted = new Set(deliveryIds);
    const reoffered = existing
        .filter((candidate) => wanted.has(candidate.deliveryId) && candidate.parked && !candidate.delivered)
        .map((candidate) => ({ ...candidate, parked: false, reason: null, nextAttemptAtMs: null, updatedAt: at }));
    // A record-less seed appends a fresh due record — the engine-unconfirmed
    // row's accepted attempt; an id the panel already holds is never re-seeded.
    const seeded = (input.seeds ?? [])
        .filter((seed) =>
            wanted.has(seed.deliveryId)
            && existing.every((candidate) => candidate.deliveryId !== seed.deliveryId))
        .map((seed): FollowUpDeliveryRecord => ({
            deliveryId: seed.deliveryId,
            correlationId: seed.correlationId,
            sessionId: seed.sessionId,
            attempt: 1,
            nextAttemptAtMs: null,
            delivered: false,
            reason: null,
            parked: false,
            updatedAt: at,
        }));
    if (reoffered.length === 0 && seeded.length === 0) {
        return null;
    }

    let next = document;
    for (const record of [...reoffered, ...seeded]) {
        next = putFollowUpRecord(next, record);
    }

    return next;
}

/**
 * The local half of FR-105's re-offer: no route, no service request, no run state — the panel's own
 * record is the only thing that moves; the relay's next tick delivers. Never throws; `false` when nothing changed.
 */
export async function reofferFollowUpDelivery(input: {
    readonly rt: PanelRuntime;
    readonly deliveryIds: readonly string[];
    readonly seeds?: readonly FollowUpSeed[];
}): Promise<boolean> {
    const { rt, deliveryIds } = input;

    // The stamp is taken **inside** the chain, so it is the stamp of the write
    // rather than of the click that queued it.
    return await updateDispatchRecord(rt, (document) =>
        reofferFollowUpRecords({
            document,
            deliveryIds,
            at: nowIso(),
            ...(input.seeds !== undefined && { seeds: input.seeds }),
        }));
}
