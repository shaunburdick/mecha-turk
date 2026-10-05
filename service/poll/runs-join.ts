/**
 * Coalescing: folding fresh deliveries into runs (003 FR-011–FR-013, T-003/T-006).
 *
 * The enqueue pass needs three answers per delivery — *which subject is this*,
 * *is a run open for it*, and *what does this delivery contribute* — and this
 * module owns all three so `runs.ts` stays the domain façade and `events.ts`
 * sees one pure function to call inside its chain task. The purity is the
 * point: the caller owns the chain, the two writes, and the audit rows, in
 * the order research §R4 fixes (runs first, deliveries second, audit last).
 *
 * Ambiguity never creates a run: a delivery whose subject or origin cannot be
 * derived unambiguously is enqueued **unlinked** rather than folded into a
 * wrong subject (003 Key Entities: a run is "never created implicitly for an
 * ambiguous or incomplete observation").
 */

import type { PromptSnapshot } from '../prompt.ts';
import { actorFieldsOf } from './attribution.ts';
import { subjectTypeOf } from './events-parse.ts';
import { isTerminalRun } from './runs-document.ts';
import { buildAttachmentId, buildCorrelationId, buildRunKey, buildSubjectKey } from './run-key.ts';
import { MAX_SOURCE_REFERENCES, RUNS_SCHEMA_VERSION } from './runs-parse.ts';
import type { QueuedEvent, SubjectType } from './events-parse.ts';
import type { ReferenceOrigin, Run, RunAuditIntent, RunsDocument, SourceReference } from './runs-types.ts';

/** The subject coordinates one delivery resolves to, when it resolves at all. */
interface SubjectShape {
    /** Ordinal-free key the counters and coalescing are keyed by. */
    readonly subjectKey: string;
    /** Subject shape for the run key. */
    readonly subjectType: SubjectType;
}

/**
 * Resolve one delivery's subject, refusing ambiguity.
 *
 * @param delivery - The delivery being enqueued.
 * @returns The subject, or `null` when the run key would be ambiguous.
 */
function subjectShapeOf(delivery: QueuedEvent): SubjectShape | null {
    try {
        const subjectType = subjectTypeOf(delivery);
        const subjectKey = buildSubjectKey({
            accountNumericUserId: delivery.accountNumericUserId,
            repository: delivery.repository,
            subjectType,
            subjectNumber: delivery.issueNumber,
            ordinal: 0,
        });

        return { subjectKey, subjectType };
    } catch {
        // A segment the run key refuses (a `|` in the repository, say) makes
        // the subject ambiguous: never create a run from it, just link the
        // delivery to nothing and let the operator see an unlinked row.
        return null;
    }
}

/**
 * Read where one delivery matched (FR-013's `origin`).
 *
 * The queue does not store an origin — the deterministic delivery id carries
 * it (`~mention~body`, `~mention~<commentId>`, `~review`), which is also how
 * an adopted legacy row gets its origin without being rewritten.
 *
 * @param delivery - The delivery joining a run.
 * @returns The origin, or `null` when the id carries one the parser trusts.
 */
function originOf(delivery: QueuedEvent): ReferenceOrigin | null {
    if (delivery.kind === 'assignment') {
        return 'assignment';
    }

    if (delivery.kind === 'review') {
        return 'review';
    }

    const marker = '~mention~';
    const at = delivery.id.lastIndexOf(marker);
    if (at === -1) {
        return null;
    }

    const suffix = delivery.id.slice(at + marker.length);
    if (suffix === 'body') {
        return 'body';
    }

    const commentId = Number(suffix);

    return commentId > 0 && String(commentId) === suffix ? `comment:${commentId}` : null;
}

/**
 * Build the source reference one delivery contributes.
 *
 * The delivery's **actor members ride the reference verbatim** (002 FR-043,
 * FR-044): the gate later judges one of them, and a run that recorded the
 * delivery but not who it was attributed to would leave the gate nothing to
 * judge. They are read through the attribution module's own absentable
 * readers, so a delivery stored before attribution contributed one reference
 * with neither member rather than an empty login.
 *
 * @param delivery - The delivery joining the run.
 * @param isPresentAtAuthorization - `false` when the run already held a
 *   reservation when this delivery arrived.
 * @returns The reference, or `null` when the delivery's origin is unusable.
 */
export function referenceOf(delivery: QueuedEvent, isPresentAtAuthorization: boolean): SourceReference | null {
    const origin = originOf(delivery);
    if (origin === null) {
        return null;
    }

    return {
        deliveryId: delivery.id,
        kind: delivery.kind,
        origin,
        sourceUrl: delivery.issueUrl,
        detectedAt: delivery.detectedAt,
        presentAtAuthorization: isPresentAtAuthorization,
        ...actorFieldsOf({
            actorLogin: delivery.actorLogin,
            actorAttribution: delivery.actorAttribution,
        }),
    };
}

/**
 * One reference's fold into a run, with the retention verdict.
 */
export interface JoinResult {
    /** The run with its reference list and counters updated. */
    readonly run: Run;
    /**
     * Whether the reference is on the run's list.
     *
     * `false` only when the cap was already full — the delivery still joined
     * and still earns its audit row; it is the list entry
     * that the cap refused, and `run.referencesNotRetained` counts it.
     */
    readonly retained: boolean;
}

/**
 * Fold one reference into a run: append it, recognise it as already folded, or
 * count it as not retained when the cap is full.
 *
 * Re-folding a delivery the run already references is the self-heal research
 * §R4 depends on: a crash between the run write and the queue write leaves a
 * run referencing a delivery that was never stored, and the re-detect must
 * link it without adding a second reference (FR-013: one per delivery). The
 * list is capped at {@link MAX_SOURCE_REFERENCES} retained references; past
 * the cap the run keeps counting (`referenceCount`), counts what it could not
 * keep (`referencesNotRetained`), and says so (`referencesTruncated`), while
 * every overflow delivery still earns its own audit row.
 *
 * @param now - Mutation stamp.
 * @returns The run plus whether this reference is on its list.
 */
export function joinReference(input: {
    /** The run being joined. */
    readonly run: Run;
    /** The joining delivery's reference. */
    readonly reference: SourceReference;
    /** Mutation stamp. */
    readonly now: string;
}): JoinResult {
    const { run, reference, now } = input;
    if (run.sourceReferences.some((entry) => entry.deliveryId === reference.deliveryId)) {
        return { run: { ...run, updatedAt: now }, retained: true };
    }

    const counted = run.referenceCount + 1;
    if (run.sourceReferences.length >= MAX_SOURCE_REFERENCES) {
        return {
            run: {
                ...run,
                referenceCount: counted,
                referencesNotRetained: run.referencesNotRetained + 1,
                referencesTruncated: true,
                updatedAt: now,
            },
            retained: false,
        };
    }

    return {
        run: {
            ...run,
            sourceReferences: [...run.sourceReferences, reference],
            referenceCount: counted,
            updatedAt: now,
        },
        retained: true,
    };
}

/** Everything one run creation needs, in one named shape (004 FR-015 adds the last). */
interface RunCreationInput {
    /** The delivery that opened this run. */
    readonly delivery: QueuedEvent;
    /** Its resolved subject. */
    readonly shape: SubjectShape;
    /** The ordinal the counter yielded. */
    readonly ordinal: number;
    /** The delivery's own reference (its first). */
    readonly reference: SourceReference;
    /** Creation stamp. */
    readonly now: string;
    /** The binding's prompt snapshot at detection, or `null` when unset. */
    readonly prompt: PromptSnapshot | null;
}

/**
 * Mint the run one delivery creates, at the subject's next ordinal.
 *
 * @param input - The delivery, its subject, ordinal, reference, stamp, and the
 *   binding's prompt snapshot (004 FR-015).
 * @returns A fresh `pending` run with the FR-050 identity derived.
 */
function runForDelivery(input: RunCreationInput): Run {
    const { delivery, shape, ordinal, reference, now, prompt } = input;
    const runKey = buildRunKey({
        accountNumericUserId: delivery.accountNumericUserId,
        repository: delivery.repository,
        subjectType: shape.subjectType,
        subjectNumber: delivery.issueNumber,
        ordinal,
    });
    const correlationId = buildCorrelationId(runKey);

    return {
        runKey,
        correlationId,
        attachmentId: buildAttachmentId(correlationId),
        ordinal,
        subjectType: shape.subjectType,
        subjectNumber: delivery.issueNumber,
        repository: delivery.repository,
        accountNumericUserId: delivery.accountNumericUserId,
        bindingId: delivery.bindingId,
        projectId: delivery.projectId,
        worktreeOption: delivery.worktreeOption,
        prompt,
        // The policy in force is decided at **authorization**, not
        // here: an enqueue pass reads no binding, and a run that predated the
        // gate would otherwise carry a policy no gate ever judged.
        actorPolicy: null,
        state: 'pending',
        stateReason: null,
        attempt: 1,
        requeuesUsed: 0,
        sourceReferences: [reference],
        referenceCount: 1,
        referencesNotRetained: 0,
        referencesTruncated: false,
        lease: null,
        reservation: null,
        attempts: [],
        session: null,
        verification: null,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * Read the ordinal-free subject key a run belongs to.
 *
 * @returns `github|<account>|<repository>|<subjectType>|<subjectNumber>`.
 */
function subjectKeyOfRun(run: Run): string {
    return buildSubjectKey({
        accountNumericUserId: run.accountNumericUserId,
        repository: run.repository,
        subjectType: run.subjectType,
        subjectNumber: run.subjectNumber,
        ordinal: 0,
    });
}

/** One delivery joining an existing run. */
export interface EnqueueJoin {
    /** The run it joined. */
    readonly run: Run;
    /** The reference recorded for it. */
    readonly reference: SourceReference;
    /**
     * Whether the reference is on the run's list.
     *
     * `false` means the cap was full: the delivery joined the run and still
     * earns this row, but its detail is counted in `referencesNotRetained`
     * rather than stored — the operator reads the marker instead of a
     * silently missing reference.
     */
    readonly retained: boolean;
}

/** What one enqueue pass changed, in the order the caller must persist it. */
export interface EnqueueOutcome {
    /** The document to persist **first** (research §R4). */
    readonly document: RunsDocument;
    /** Delivery id → run correlation id, for the rows the caller links. */
    readonly links: ReadonlyMap<string, string>;
    /** Runs created this pass: one `run.created` row each. */
    readonly created: readonly Run[];
    /** Joins this pass made: one `run.coalesced` row each. */
    readonly joins: readonly EnqueueJoin[];
}

/** Everything one enqueue pass needs, in one named shape. */
export interface EnqueueInput {
    /** Document as stored, before this pass. */
    readonly document: RunsDocument;
    /** Deliveries this scan actually enqueued. */
    readonly deliveries: readonly QueuedEvent[];
    /** Service-clock stamp for every run this pass touches. */
    readonly now: string;
    /**
     * The scanning binding's prompt snapshot, snapshotted with the same
     * binding object that produced `projectId`/`worktreeOption`.
     *
     * Absent reads as `null`: a run opened with no prompt, which is also how
     * every caller outside the poll loop behaves.
     */
    readonly prompt?: PromptSnapshot | null;
}

/**
 * Fold fresh deliveries into runs: join the subject's open run, else create
 * the next ordinal. Pure — the caller owns the chain, the two
 * writes, and the audit rows, in that order.
 *
 * @param input - The stored document, the deduped deliveries, the stamp, and
 *   the binding's prompt snapshot.
 * @returns The document to persist plus the effects to audit and link.
 */
export function applyEnqueue(input: EnqueueInput): EnqueueOutcome {
    const prompt = input.prompt ?? null;
    const runs = [...input.document.runs];
    const subjects = { ...input.document.subjects };
    const links = new Map<string, string>();
    const created: Run[] = [];
    const joins: EnqueueJoin[] = [];

    for (const delivery of input.deliveries) {
        const shape = subjectShapeOf(delivery);
        const reference = shape === null ? null : referenceOf(delivery, true);
        if (shape === null || reference === null) {
            continue;
        }

        const index = runs.findIndex((run) => !isTerminalRun(run) && subjectKeyOfRun(run) === shape.subjectKey);
        const open = index === -1 ? undefined : runs[index];
        if (open !== undefined) {
            const authorizedReference = { ...reference, presentAtAuthorization: open.reservation === null };
            const folded = joinReference({ run: open, reference: authorizedReference, now: input.now });
            runs[index] = folded.run;
            joins.push({ run: folded.run, reference: authorizedReference, retained: folded.retained });
            links.set(delivery.id, folded.run.correlationId);
            continue;
        }

        const ordinal = subjects[shape.subjectKey] ?? 0;
        subjects[shape.subjectKey] = ordinal + 1;
        const run = runForDelivery({ delivery, shape, ordinal, reference, now: input.now, prompt });
        runs.push(run);
        created.push(run);
        links.set(delivery.id, run.correlationId);
    }

    const auditIntents: RunAuditIntent[] = [
        ...(input.document.auditIntents ?? []),
        ...created.map((run): RunAuditIntent => ({
            eventType: 'run.created',
            correlationId: run.correlationId,
            deliveryIds: run.sourceReferences.map((reference) => reference.deliveryId),
        })),
    ];

    return { document: { schemaVersion: RUNS_SCHEMA_VERSION, subjects, runs, auditIntents }, links, created, joins };
}
