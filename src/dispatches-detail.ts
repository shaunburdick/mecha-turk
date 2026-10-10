/**
 * The runs-history row's **structured** members and their readers.
 *
 * A `RunRow` is mostly strings and numbers; four members are not — the retained
 * source references, the session pointer, and the recorded agent read-back —
 * and each of those is a shape with its own vocabulary and its own fail-closed
 * reader. Split out of [`dispatches-service.ts`](./dispatches-service.ts) for
 * the file-length gate, and for one structural reason: these three readers are
 * **independently testable** as "what does this member mean", which is a
 * different question from "what shape does the whole row have".
 *
 * The references' **reveal** lives here too, beside their reader: one reference
 * has one description, so one module is where that description is (005 FR-048,
 * FR-094). It moved out of `dispatches-controls.ts` when the actor clause made
 * that module cross the file-length cap, and it belonged here either way — the
 * controls that *mount* the reveal stay beside the controls that mount
 * everything else on that tab.
 *
 * Named `dispatches-*` rather than `runs-*` because 005 T-003 **retired** the
 * `runs*` prefix in this directory: `runs.ts` and `runs-ui.ts` became
 * `dispatches.ts` and `dispatches-ui.ts`, and `tests/vocabulary.test.ts` fails on
 * any `src/runs*.ts` so a reverted rename cannot pass quietly. The run model is
 * still a run — the module is named for the *section* that renders it.
 *
 * The four rules these readers hold, each a decision rather than a default:
 *
 * - **Fail closed, one member at a time.** Each reader answers `null` for a
 *   member that cannot be understood and `undefined` for one that is *present
 *   but not the shape* — the distinction that lets the row parser refuse a row
 *   rather than half-apply it (AGENTS invariant 8).
 * - **The actor members are absentable, and validated when present** (002
 *   FR-043, FR-044). A reference stored before attribution existed carries
 *   neither, and must still parse: a runs-history row the panel refuses would
 *   hide an *entire* dispatch, which is a far worse lie than one reference
 *   rendering as *no attribution recorded*. A member that **is** present must be
 *   usable — an unrecognized basis refuses rather than defaulting, because
 *   defaulting would record an inference as a fact (002 FR-024, NFR-011).
 * - **A blank `expectedAgent` is a record, not a malformed one** (002 FR-029 as
 *   amended): it is the documented *no baseline configured*, which a read-back
 *   against an unpinned baseline legitimately produces.
 * - **No permitted login, ever** (002 NFR-113, 005 FR-091). The policy's *shape*
 *   is projected; its *contents* are configuration in `bindings.json` and have
 *   no path into a panel document from here.
 */

import type { ListItem } from '@openchamber/sdk/ui';
import { asRecord } from './json.ts';
import { utcStamp } from './ids.ts';
import { eventKindOf } from './bindings-service.ts';
import { actorFieldsOf, actorPhrase } from './run-actor.ts';
import type { ActorAttribution } from './run-actor.ts';
import type { RunRow } from './dispatches-service.ts';

/** Trigger kinds the runs row can carry; anything else reads as `assignment`. */
export type RunKind = 'assignment' | 'mention' | 'review';

/** One source reference as the run history carries it. */
export interface RunReference {
    /** The joining delivery's unchanged id (FR-012). */
    readonly deliveryId: string;
    /** Trigger kind the reference was detected under. */
    readonly kind: RunKind;
    /** Where it matched: `assignment`, `body`, `comment:<id>`, or `review`. */
    readonly origin: string;
    /** Canonical link back to the source. */
    readonly sourceUrl: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
    /**
     * The actor this delivery is attributed to.
     *
     * **Absentable on read**: a run stored before attribution existed carries
     * neither actor member, and a run row must never refuse over it. The panel
     * renders its absence as *no attribution recorded*, which is a third thing —
     * neither an empty actor nor a guessed one.
     */
    readonly actorLogin?: string;
    /**
     * How that attribution was made.
     *
     * `'subject-author'` is a **legacy basis** no row written now carries: an
     * earlier build attributed assignment and review triggers to the issue or
     * pull-request author because the two *list* feeds named no actor, and
     * GitHub does record both. Rows already on disk carry it, so it still reads
     * and still renders — with its provenance stated rather than with a claim
     * about what the provider can or cannot see.
     */
    readonly actorAttribution?: ActorAttribution;
}

/** The session pointer as the run history carries it (FR-028's proof). */
export interface RunSession {
    /** Host-owned session id. */
    readonly sessionId: string;
    /** `= correlationId`; the id the session was started with. */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
}

/** The recorded agent read-back as the run history carries it. */
export interface RunVerification {
    /** Agent the read-back observed, or `null` when it was unreadable. */
    readonly observedAgent: string | null;
    /** Agent the binding expected. */
    readonly expectedAgent: string;
    /** Whether the two matched; a mismatch is a warning, never a state. */
    readonly ok: boolean;
    /** Extra note on a mismatch, or `null`. */
    readonly note: string | null;
}

/** Which of the two movement kinds one follow-up row is. */
export type FollowUpKind = 'comment' | 'head';

/**
 * One follow-up as the run history carries it (002 FR-104).
 *
 * A follow-up is **not** a source reference: the row's reference list is what
 * 003's actor gate classifies, and a follow-up that joined it would be
 * re-judged by the allow-list on the run's next authorization. It rides this
 * member instead, beside the session pointer it is delivered into.
 *
 * The `excerpt` is untrusted source text with the same handling the dispatch
 * excerpt gets and no second home: it is quoted inside the bounded, delimited
 * frame the delivery composes, and it is written to no trail row (FR-035's
 * fingerprint, length, and counts).
 */
export interface RunFollowUp {
    /** The deterministic event id: the relay's at-most-once key. */
    readonly deliveryId: string;
    /** Which of the two movement kinds this is. */
    readonly kind: FollowUpKind;
    /** Bounded untrusted excerpt the delivery composes its message from. */
    readonly excerpt: string;
    /** The actor the movement is attributed to. */
    readonly actorLogin: string;
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** Canonical link back to the source. */
    readonly sourceUrl: string;
    /** The head the run carried before this movement; head changes only. */
    readonly fromHeadSha?: string;
    /** The head this movement observed; head changes only. */
    readonly headSha?: string;
}

/**
 * Read one required non-empty string member.
 *
 * @param record - Parsed row or sub-object.
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
 *
 * @returns The references, or `null`.
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
 * Read the session pointer, distinguishing `null` from an unusable value.
 *
 * @param value - The `session` member as received.
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
 * Read the recorded agent read-back, distinguishing `null` from an unusable value.
 *
 * @param value - The `verification` member as received.
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
 * Read one follow-up row, distinguishing `null` from an unusable value.
 *
 * Absentable on exactly the terms the session pointer is: a run written before
 * the member existed carries none and must still parse, because one unusable
 * row would hide an *entire* dispatch. A **present** value that is not this
 * shape refuses the whole row (AGENTS invariant 8) — the panel never delivers
 * from a follow-up it half-read.
 *
 * @param value - The `followUps` member as received.
 * @returns The list, `undefined` when the member is absent, or `null` when it
 *   is present and not a list of follow-ups this build may act on.
 */
/**
 * Which of the two movement kinds a follow-up row may name, and nothing else.
 */
function followUpKindOfValue(value: unknown): FollowUpKind | null {
    return value === 'comment' || value === 'head' ? value : null;
}

/**
 * Read one optional non-empty string member.
 *
 * @param record - Parsed row or sub-object.
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

/** One follow-up row's required text members. */
interface FollowUpText {
    readonly excerpt: string;
    readonly actorLogin: string;
    readonly detectedAt: string;
    readonly sourceUrl: string;
}

/**
 * Read the required text members of one follow-up row.
 *
 * `excerpt` is the one member that may legitimately be **empty**: a head-SHA
 * movement carries no source text of its own — its from → to pair rides the two
 * members beside it — so an empty excerpt is a fact about the movement rather
 * than a malformed row. The other three are required non-empty, because a
 * follow-up nobody can be named on is not one this panel may deliver.
 *
 * @returns The members, or `null` when any is missing or unusable.
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
 * Read one follow-up row.
 *
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
 * Read the `followUps` member, distinguishing absent from an unusable value.
 *
 * Absentable on exactly the terms the session pointer is: a run written before
 * the member existed carries none and must still parse, because one unusable row
 * would hide an *entire* dispatch. A **present** value that is not this shape
 * refuses the whole row (AGENTS invariant 8) — the panel never delivers from a
 * follow-up it half-read.
 *
 * @param value - The `followUps` member as received.
 * @returns The list, `undefined` when the member is absent, or `null` when it
 *   is present and not a list of follow-ups this build may act on.
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
 * One line per retained source reference: kind, origin, time, link, the actor
 * with its basis, and the late mark.
 *
 * The actor clause comes from `run-actor.ts` so this reveal, the row's own
 * reason list, and the Basis itself are worded in exactly one place.
 *
 * @returns The reference's line, unredacted — the caller renders it as text.
 */
function referenceLine(reference: RunReference): string {
    const late = reference.presentAtAuthorization
        ? ''
        : ' — arrived after authorization, so it may not have been seen by the agent';

    return `${reference.kind} · from ${reference.origin} · detected ${utcStamp(reference.detectedAt)}`
        + ` · ${reference.sourceUrl} · ${actorPhrase(reference)}${late}`;
}

/**
 * Every source reference of one row, as the reveal lists them.
 *
 * @returns One line per retained reference, earliest first.
 */
export function referenceDetailLines(row: RunRow): readonly string[] {
    return row.sourceReferences.map((reference) => referenceLine(reference));
}

/**
 * The same lines as list items, each keyed so the list cannot collide.
 *
 * @returns The reveal's items.
 */
export function referenceDetailItems(row: RunRow): ListItem[] {
    return referenceDetailLines(row).map((line, index) => ({ id: `${row.id}#${index}`, title: line }));
}
