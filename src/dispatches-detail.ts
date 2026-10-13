/**
 * The runs-history row's **structured** members and their readers (005
 * FR-048, FR-094; 002 FR-036, FR-105): the retained source references, the
 * session pointer, the recorded agent read-back, the references' reveal, and
 * the follow-up view. Each reader answers `null` for a member it cannot
 * understand and `undefined` for one present but not the shape, so the row
 * parser refuses rather than half-applies (invariant 8); an unrecognized
 * actor basis refuses rather than defaults (002 FR-024, NFR-011), a blank
 * `expectedAgent` is the documented *no baseline configured* rather than a
 * malformed record (002 FR-029), and no permitted login ever reaches a panel
 * document (002 NFR-113, 005 FR-091).
 */

import type { ListItem } from '@openchamber/sdk/ui';
import { asRecord } from './json.ts';
import { utcStamp } from './ids.ts';
import { eventKindOf } from './bindings-service.ts';
import { actorFieldsOf, actorPhrase } from './run-actor.ts';
import type { ActorAttribution } from './run-actor.ts';
import type { FollowUpDeliveryRecord, FollowUpFailure } from './dispatch-record.ts';
import type { RunRow } from './dispatches-service.ts';

/** Trigger kinds the runs row can carry; anything else reads as `assignment`. */
export type RunKind = 'assignment' | 'mention' | 'review';

export interface RunReference {
    /** The joining delivery's unchanged id (FR-012). */
    readonly deliveryId: string;
    readonly kind: RunKind;
    /** Where it matched: `assignment`, `body`, `comment:<id>`, or `review`. */
    readonly origin: string;
    readonly sourceUrl: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
    /**
     * The actor this delivery is attributed to. **Absentable on read** — a run
     * stored before attribution existed must still parse — and rendered as *no
     * attribution recorded*: a third thing, neither an empty actor nor a
     * guessed one.
     */
    readonly actorLogin?: string;
    /**
     * How that attribution was made. `'subject-author'` is a **legacy basis** no
     * row written now carries — an earlier build attributed the list feeds to
     * the issue or pull-request author — but rows on disk still read and render
     * it, with provenance stated rather than a claim about what the provider
     * can or cannot see.
     */
    readonly actorAttribution?: ActorAttribution;
}

/** The session pointer as the run history carries it (FR-028's proof). */
export interface RunSession {
    readonly sessionId: string;
    /** `= correlationId`; the id the session was started with. */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
}

export interface RunVerification {
    /** Agent the read-back observed, or `null` when it was unreadable. */
    readonly observedAgent: string | null;
    readonly expectedAgent: string;
    /** Whether the two matched; a mismatch is a warning, never a state. */
    readonly ok: boolean;
    /** Extra note on a mismatch, or `null`. */
    readonly note: string | null;
}

export type FollowUpKind = 'comment' | 'head';

/**
 * One follow-up as the run history carries it (002 FR-104). A follow-up is
 * **not** a source reference: that list is what 003's actor gate classifies, and
 * a follow-up that joined it would be re-judged by the allow-list on the run's
 * next authorization. The `excerpt` is untrusted source text with the dispatch
 * excerpt's own handling — quoted inside the bounded, delimited frame, written
 * to no trail row (FR-035's fingerprint, length, counts).
 */
export interface RunFollowUp {
    /** The deterministic event id: the relay's at-most-once key. */
    readonly deliveryId: string;
    readonly kind: FollowUpKind;
    /** Bounded untrusted excerpt the delivery composes its message from. */
    readonly excerpt: string;
    readonly actorLogin: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    readonly sourceUrl: string;
    /** The head the run carried before this movement; head changes only. */
    readonly fromHeadSha?: string;
    /** The head this movement observed; head changes only. */
    readonly headSha?: string;
}

/**
 * @returns The value, or `null` when it is missing, not a string, or empty.
 */
function requiredText(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read one source reference, actor members included.
 *
 * @returns The reference, or `null` when its shape is unusable.
 */
function parseReference(value: unknown): RunReference | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const deliveryId = requiredText(record, 'deliveryId');
    const origin = requiredText(record, 'origin');
    const sourceUrl = requiredText(record, 'sourceUrl');
    const detectedAt = requiredText(record, 'detectedAt');
    if (
        deliveryId === null ||
        origin === null ||
        sourceUrl === null ||
        detectedAt === null ||
        typeof record.presentAtAuthorization !== 'boolean'
    ) {
        return null;
    }

    const actor = actorFieldsOf(record);

    return actor === null
        ? null
        : {
            deliveryId,
            kind: eventKindOf(record.kind),
            origin,
            sourceUrl,
            detectedAt,
            presentAtAuthorization: record.presentAtAuthorization,
            ...actor,
        };
}

/**
 * Read the `sourceReferences` list, or `null` when any element is unusable.
 *
 * One unusable element refuses the **whole list**: a runs row that silently
 * dropped a reference would render as falsely complete, which is the exact lie
 * FR-074's fail-closed reading exists to prevent.
 */
export function parseReferences(value: unknown): RunReference[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const references: RunReference[] = [];
    for (const entry of value) {
        const reference = parseReference(entry);
        if (reference === null) {
            return null;
        }

        references.push(reference);
    }

    return references;
}

/**
 * @returns The pointer, `null` when the run has none, or `undefined` when the
 *   member is present but not a pointer this build may half-apply.
 */
export function parseSession(value: unknown): RunSession | null | undefined {
    if (value === null) {
        return null;
    }

    const record = asRecord(value);
    if (record === null) {
        return undefined;
    }

    const sessionId = requiredText(record, 'sessionId');
    const attachmentId = requiredText(record, 'attachmentId');
    const dispatchedAt = requiredText(record, 'dispatchedAt');
    if (sessionId === null || attachmentId === null || dispatchedAt === null) {
        return undefined;
    }

    return { sessionId, attachmentId, dispatchedAt };
}

/**
 * @returns The read-back, `null` when none was filed, or `undefined` when the
 *   member is present but not one this build may half-apply.
 */
export function parseVerification(value: unknown): RunVerification | null | undefined {
    if (value === null) {
        return null;
    }

    const record = asRecord(value);
    if (record === null) {
        return undefined;
    }

    // `expectedAgent` is type-checked rather than required non-empty: a blank
    // value is the documented *no baseline configured* the panel reports when the
    // operator pinned none (002 FR-029 as amended), and a run row must not
    // fail to parse over it. Its absence or a non-string still fails.
    const baseline: unknown = record.expectedAgent;
    if (typeof baseline !== 'string' || typeof record.ok !== 'boolean') {
        return undefined;
    }

    const { observedAgent } = record;
    if (observedAgent !== null && typeof observedAgent !== 'string') {
        return undefined;
    }

    const { note } = record;
    if (note !== null && typeof note !== 'string') {
        return undefined;
    }

    return { observedAgent, expectedAgent: baseline, ok: record.ok, note };
}

/**
 * Which of the two movement kinds a follow-up row may name, and nothing else.
 */
function followUpKindOfValue(value: unknown): FollowUpKind | null {
    return value === 'comment' || value === 'head' ? value : null;
}

/**
 * @returns The value, `undefined` when the member is absent, or `null` when it
 *   is present and not usable text.
 */
function optionalText(record: Record<string, unknown>, field: string): string | undefined | null {
    const value = record[field];
    if (value === undefined || value === null) {
        return undefined;
    }

    return typeof value === 'string' && value !== '' ? value : null;
}

interface FollowUpText {
    readonly excerpt: string;
    readonly actorLogin: string;
    readonly detectedAt: string;
    readonly sourceUrl: string;
}

/**
 * `excerpt` is the one member that may legitimately be **empty**: a head-SHA
 * movement carries no source text of its own, so an empty excerpt is a fact
 * about the movement, not a malformed row. The other three are required
 * non-empty — a follow-up nobody can be named on is not one this panel may
 * deliver. Answers `null` for a missing or unusable member.
 */
function readFollowUpText(record: Record<string, unknown>): FollowUpText | null {
    const { excerpt } = record;
    const actorLogin = requiredText(record, 'actorLogin');
    const detectedAt = requiredText(record, 'detectedAt');
    const sourceUrl = requiredText(record, 'sourceUrl');
    if (typeof excerpt !== 'string' || actorLogin === null || detectedAt === null || sourceUrl === null) {
        return null;
    }

    return { excerpt, actorLogin, detectedAt, sourceUrl };
}

/**
 * The two optional members are read rather than defaulted: an absent `headSha`
 * on a comment follow-up and an absent `fromHeadSha` on the first head movement
 * are both legitimate, and inventing either would name a head nobody observed.
 *
 * @returns The follow-up, or `null` when its shape is unusable.
 */
function parseFollowUp(value: unknown): RunFollowUp | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const deliveryId = requiredText(record, 'deliveryId');
    const kind = followUpKindOfValue(record.kind);
    const fromHeadSha = optionalText(record, 'fromHeadSha');
    const headSha = optionalText(record, 'headSha');
    const text = readFollowUpText(record);
    if (deliveryId === null || kind === null || fromHeadSha === null || headSha === null || text === null) {
        return null;
    }

    return {
        deliveryId,
        kind,
        ...text,
        ...(fromHeadSha !== undefined && { fromHeadSha }),
        ...(headSha !== undefined && { headSha }),
    };
}

/**
 * Absentable on exactly the terms the session pointer is: an older run must
 * still parse, because one unusable row would hide an *entire* dispatch, while
 * a **present** value that is not this shape refuses the whole row (invariant
 * 8) — the panel never delivers from a follow-up it half-read. `undefined` for
 * absence, `null` for a present list this build may not act on.
 */
export function parseFollowUps(value: unknown): readonly RunFollowUp[] | undefined | null {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        return null;
    }

    const rows: RunFollowUp[] = [];
    for (const entry of value) {
        const row = parseFollowUp(entry);
        if (row === null) {
            return null;
        }

        rows.push(row);
    }

    return rows;
}

/**
 * The cause each park reason carries, in the operator's words (002 FR-105): a
 * closed map over the closed union, so the run row and the trail name one cause
 * the same way — and a record whose `reason` is `null` renders through
 * {@link followUpRowView}'s fallback rather than as nothing at all.
 */
const PARKED_CAUSES: Readonly<Record<FollowUpFailure, string>> = {
    'no-session': 'no session was open for the run',
    'session-busy': 'the session was mid-turn',
    'navigation-refused': 'the host refused to open the session',
    'over-budget': 'the composed message was over the dispatch budget',
    'host-unavailable': 'the host refused or timed out the prompt',
};

/** One parked follow-up, as the run row names it (002 FR-105). */
export interface ParkedFollowUp {
    /** The deterministic delivery id, so the reason is traceable to one movement. */
    readonly deliveryId: string;
    /** Attempts the delivery used before the bound was exhausted. */
    readonly attempt: number;
    /** The cause in the operator's words. */
    readonly cause: string;
}

/**
 * What the panel's own record says about one row's follow-ups: **waiting**
 * means not yet in its session and not parked; **parked** is excluded from
 * automatic handling until an operator re-offers it (FR-105), so it is never
 * counted as waiting — the row says *parked*, with its cause.
 */
export interface FollowUpRowView {
    readonly delivered: number;
    readonly waiting: number;
    readonly parked: readonly ParkedFollowUp[];
}

/**
 * The records that belong to one row: by the delivery ids the row projects, or
 * by the correlation id naming its run — the second arm keeps a follow-up whose
 * row fell out of the projection window (or whose run left the page) visible on
 * the run it belongs to.
 */
function followUpRecordsFor(
    row: RunRow,
    records: readonly FollowUpDeliveryRecord[],
): readonly FollowUpDeliveryRecord[] {
    const projected = row.followUps ?? [];

    return records.filter((record) =>
        record.correlationId === row.correlationId
        || projected.some((followUp) => followUp.deliveryId === record.deliveryId));
}

/**
 * Classify one row's follow-ups against the panel's durable record: the service
 * can say a follow-up *exists* and quote its text, but only the panel knows
 * what happened to it, because only the panel calls the host — the row alone
 * would show every delivered follow-up as still waiting, the false claim
 * FR-036's amended clause forbids. `null` when the row carries no follow-up
 * state at all (the ordinary case).
 */
export function followUpRowView(
    row: RunRow,
    records: readonly FollowUpDeliveryRecord[],
): FollowUpRowView | null {
    const projected = row.followUps ?? [];
    const relevant = followUpRecordsFor(row, records);
    if (projected.length === 0 && relevant.length === 0) {
        return null;
    }

    const projectedIds = new Set(projected.map((followUp) => followUp.deliveryId));
    const parked: ParkedFollowUp[] = [];
    let delivered = 0;
    for (const record of relevant) {
        if (record.delivered) {
            delivered += 1;
        } else if (record.parked) {
            parked.push({
                deliveryId: record.deliveryId,
                attempt: record.attempt,
                cause: record.reason === null
                    ? 'the retry bound was exhausted'
                    : PARKED_CAUSES[record.reason],
            });
        }
    }

    // A projected follow-up with no record has never been attempted — it is
    // waiting. One with a record that is neither delivered nor parked is
    // waiting too. The second arm counts the records whose follow-up has left
    // the projection window: the movement still exists in the queue, and the
    // panel still owes the session a prompt for it.
    const waiting = projected.filter((followUp) => {
        const record = relevant.find((candidate) => candidate.deliveryId === followUp.deliveryId);

        return record === undefined || (!record.delivered && !record.parked);
    }).length
        + relevant.filter((record) =>
            !record.delivered && !record.parked && !projectedIds.has(record.deliveryId)).length;

    return { delivered, waiting, parked };
}

/**
 * Exactly {@link followUpRowView}'s parked set: a follow-up that exhausted the
 * retry ladder, never reached its session, and sits out automatic handling
 * until someone asks for it again (FR-105). The two absences are the honesty:
 * an already **delivered** follow-up is not here — nothing to send again — and
 * one never attempted is not here either, because it is already due and the
 * relay's tick will deliver it unaided.
 */
export function reofferableFollowUps(
    row: RunRow,
    records: readonly FollowUpDeliveryRecord[],
): readonly ParkedFollowUp[] {
    return followUpRowView(row, records)?.parked ?? [];
}

/**
 * The sum over the rows, plus the records whose run is outside the view
 * entirely: a follow-up attempted on a run the panel no longer holds is still
 * waiting, and counting only what is on screen would understate the queue by
 * exactly the work the operator cannot see. Never a claim about follow-ups this
 * panel has no record of and no row for.
 */
export function waitingFollowUps(
    rows: readonly RunRow[],
    records: readonly FollowUpDeliveryRecord[],
): number {
    const runIds = new Set(rows.map((row) => row.correlationId));
    const onRows = rows.reduce(
        (total, row) => total + (followUpRowView(row, records)?.waiting ?? 0),
        0,
    );
    const orphans = records.filter((record) =>
        !record.delivered && !record.parked && !runIds.has(record.correlationId));

    return onRows + orphans.length;
}

/**
 * One line per retained source reference: kind, origin, time, link, the actor
 * with its basis, and the late mark. The actor clause comes from
 * `run-actor.ts`, so this reveal, the row's own reason list, and the Basis
 * itself are worded in exactly one place. The line is unredacted — the caller
 * renders it as text.
 */
function referenceLine(reference: RunReference): string {
    const late = reference.presentAtAuthorization
        ? ''
        : ' — arrived after authorization, so it may not have been seen by the agent';

    return `${reference.kind} · from ${reference.origin} · detected ${utcStamp(reference.detectedAt)}`
        + ` · ${reference.sourceUrl} · ${actorPhrase(reference)}${late}`;
}

/**
 * @returns One line per retained reference, earliest first.
 */
export function referenceDetailLines(row: RunRow): readonly string[] {
    return row.sourceReferences.map((reference) => referenceLine(reference));
}

/**
 * The same lines as list items, each keyed so the list cannot collide.
 */
export function referenceDetailItems(row: RunRow): ListItem[] {
    return referenceDetailLines(row).map((line, index) => ({ id: `${row.id}#${index}`, title: line }));
}
