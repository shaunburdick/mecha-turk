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

import { asRecord } from './json.ts';
import { eventKindOf } from './bindings-service.ts';
import { actorFieldsOf } from './run-actor.ts';
import type { ActorAttribution } from './run-actor.ts';

/** Trigger kinds the runs row can carry; anything else reads as `assignment`. */
export type RunKind = 'assignment' | 'mention' | 'review';

/** One source reference as the run history carries it (FR-013, FR-015). */
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
     * The actor this delivery is attributed to (002 FR-043).
     *
     * **Absentable on read**: a run stored before attribution existed carries
     * neither actor member, and a run row must never refuse over it. The panel
     * renders its absence as *no attribution recorded*, which is a third thing —
     * neither an empty actor nor a guessed one (002 NFR-011).
     */
    readonly actorLogin?: string;
    /**
     * How that attribution was made (002 FR-044).
     *
     * `'subject-author'` is a **documented proxy**: GitHub records the issue or
     * pull-request author and does not record who assigned or requested, so a
     * surface rendering it must say so rather than present it as a fact.
     */
    readonly actorAttribution?: ActorAttribution;
}

/** The session pointer as the run history carries it (FR-028's proof). */
export interface RunSession {
    /** Host-owned session id. */
    readonly sessionId: string;
    /** `= correlationId`; the id the session was started with (FR-029). */
    readonly attachmentId: string;
    /** RFC 3339 dispatch stamp. */
    readonly dispatchedAt: string;
}

/** The recorded agent read-back as the run history carries it (FR-043). */
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

/**
 * Read one required non-empty string member.
 *
 * @param record - Parsed row or sub-object.
 * @param field - Member name.
 * @returns The value, or `null` when it is missing, not a string, or empty.
 */
function requiredText(record: Record<string, unknown>, field: string): string | null {
    const value = record[field];

    return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read one source reference, actor members included (002 FR-043, FR-044).
 *
 * @param value - One element of the `sourceReferences` array.
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
    if (deliveryId === null || origin === null || sourceUrl === null || detectedAt === null) {
        return null;
    }

    if (typeof record.presentAtAuthorization !== 'boolean') {
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
 * @param value - The member as received.
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
