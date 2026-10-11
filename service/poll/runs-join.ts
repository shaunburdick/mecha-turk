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
import { followUpKindOf, subjectTypeOf } from './events-parse.ts';
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
 * **A follow-up id carries no origin, and answers `null` here on purpose**: a
 * follow-up is not a source reference on the run (003's actor gate classifies
 * from `sourceReferences` exclusively, so a follow-up that joined that list
 * would be re-judged by the allow-list on the run's next authorization). It
 * still *joins* the run and is still linked to it — {@link foldDelivery} reads
 * that distinction — it simply leaves the reference list alone.
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

/** Which of the two follow-up kinds one delivery is, from its deterministic id. */
function followUpKindOfDelivery(delivery: QueuedEvent): 'comment' | 'head' | null {
    return followUpKindOf(delivery.id);
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

/**
 * Read the head-SHA seed one run should carry after this pass.
 *
 * The seed is the **dispatch-time baseline** and is never re-based on a later
 * observation (002 FR-103), which is why the arms are ordered the way they
 * are:
 *
 * - a run that already holds a seed keeps it, because re-basing would make the
 *   from → to pair a follow-up names unrecoverable — the earlier value would
 *   have been overwritten;
 * - otherwise the establishing delivery row's own `headSha` is the baseline,
 *   which a review-request or review-assignment row carries (FR-103(a));
 * - otherwise the head this same cycle observed for the subject becomes the
 *   baseline, which is FR-103(b): a `null`-seed run's first cycle records a
 *   real value so the following cycle has something to compare against.
 *
 * The observation is looked up under the run's own {@link subjectKeyOfRun},
 * and the observations are keyed with `pull_request` as the shape — so an
 * issue run's key finds nothing there and no seed is ever recorded for an
 * issue subject, which never produces a push follow-up at all.
 *
 * @returns The seed to write, or `undefined` when this pass records none.
 */
function headSeedOf(input: {
    /** The seed the run already carries, or `undefined` when it has none. */
    readonly recorded: string | undefined;
    /** The establishing delivery row's own head SHA, when there is one. */
    readonly established?: string | null;
    /** Observed heads keyed by subject key; absent when the scan read no pulls. */
    readonly observations: ReadonlyMap<string, string> | undefined;
    /** The subject key the observation is looked up under. */
    readonly subjectKey: string;
}): string | undefined {
    if (input.recorded !== undefined) {
        return input.recorded;
    }

    if (input.established !== undefined && input.established !== null) {
        return input.established;
    }

    return input.observations?.get(input.subjectKey);
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
    /**
     * The head SHA this same cycle observed for the subject, keyed by subject
     * key. Only consulted for a delivery whose own row carries no `headSha`,
     * which is FR-103(b)'s arm.
     */
    readonly observedHeads?: ReadonlyMap<string, string>;
}

/**
 * Mint the run one delivery creates, at the subject's next ordinal.
 *
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
    const headSha = headSeedOf({
        recorded: undefined,
        established: delivery.headSha,
        observations: input.observedHeads,
        subjectKey: shape.subjectKey,
    });

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
        // The establishing cycle's head-SHA seed. A review-request or
        // review-assignment row carries one, so its run's baseline is the head
        // that already existed at dispatch (FR-103(a)). Every other subject
        // leaves it absent unless this same cycle observed a head, and an issue
        // subject never does — so absent reads as *no seed recorded*, never as
        // *the head changed*.
        ...(headSha !== undefined && { lastHeadSha: headSha }),
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

/** One follow-up that joined a run, for its `follow_up.observed` audit row. */
export interface FollowUpJoin {
    /** The run the follow-up joined. */
    readonly run: Run;
    /** The joining delivery's unchanged id. */
    readonly deliveryId: string;
    /** Which of the two movement kinds the follow-up records. */
    readonly kind: 'comment' | 'head';
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
    /** Follow-ups this pass folded: one `follow_up.observed` row each. */
    readonly followUps: readonly FollowUpJoin[];
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
    /**
     * The head SHA each tracked pull request was observed carrying this cycle,
     * keyed by the ordinal-free subject key of a `pull_request` subject.
     *
     * Read for **one** purpose: the establishing cycle of a run that carries no
     * seed yet records the head it observed, so the following cycle compares
     * against a real value rather than against a `null` that would read as
     * *the head changed* (002 FR-103(b)). A run that already holds a seed — and
     * every issue subject, whose key is not in this map — is untouched by it.
     *
     * Absent reads as *no head was observed*, which is what every caller
     * outside the poll loop behaves like.
     */
    readonly observedHeads?: ReadonlyMap<string, string>;
}

/**
 * Find the run one delivery joins, or `undefined` when it opens the next ordinal.
 *
 * **The join is the one coalescing rule** (003 FR-011, 002 FR-100). A delivery
 * joins its subject's run when that run is non-terminal — 003's original rule,
 * unchanged — **or** when the run carries a recorded session, which is the
 * recorded-session predicate `run.session !== null`. That second arm is the
 * whole of the tracking lifecycle's correction: the moment a run dispatches, a
 * further delivery for its subject joins it as a follow-up instead of opening
 * the next ordinal and a second, disjoint session. A `dead-lettered` run holds
 * no session and is therefore still terminal for coalescing, so a new delivery
 * for its subject opens the next ordinal exactly as it always did.
 *
 * @returns The run and its position, or `undefined`.
 */
function findJoinableRun(
    runs: readonly Run[],
    subjectKey: string,
): { readonly index: number; readonly open: Run } | undefined {
    for (const [index, run] of runs.entries()) {
        if (subjectKeyOfRun(run) === subjectKey && (!isTerminalRun(run) || run.session !== null)) {
            return { index, open: run };
        }
    }

    return undefined;
}

/**
 * Record the head-SHA seed on every run this pass touched that has none.
 *
 * This is the establishing cycle for a run whose delivery row carried no
 * `headSha`: the pass writes the head it observed, so the following cycle
 * compares against a real value rather than against a `null` that would read as
 * *the head changed* (FR-103(b)). Only a run that **carries a session** is
 * seeded, because only such a run can produce a push follow-up at all.
 *
 * The write rides the same two writes the deliveries do, so a crash between the
 * seed and a follow-up row cannot produce a second one: the row's id is
 * deterministic and the queue's own dedupe absorbs the repeat.
 */
function recordHeadSeeds(
    runs: Run[],
    observations: ReadonlyMap<string, string>,
): void {
    for (const [position, run] of runs.entries()) {
        if (run.session === null) {
            continue;
        }

        const seed = headSeedOf({
            recorded: run.lastHeadSha,
            observations,
            subjectKey: subjectKeyOfRun(run),
        });
        if (seed === undefined) {
            continue;
        }

        runs[position] = { ...run, lastHeadSha: seed };
    }
}

/**
 * Fold one delivery into the document's runs and counters.
 *
 * The join is the one coalescing rule (003 FR-011, 002 FR-100): see
 * {@link findJoinableRun} for the two arms, and `applyEnqueue` for the chain of
 * them.
 */
function foldDelivery(input: {
    /** The delivery being folded. */
    readonly delivery: QueuedEvent;
    /** Runs this pass has built so far, mutated in place. */
    readonly runs: Run[];
    /** Ordinal counters, mutated in place. */
    readonly subjects: Record<string, number>;
    /** Delivery id → run correlation id, written as the pass proceeds. */
    readonly links: Map<string, string>;
    /** Runs this pass created, for the `run.created` intents. */
    readonly created: Run[];
    /** Joins this pass made, for the `run.coalesced` rows. */
    readonly joins: EnqueueJoin[];
    /** Follow-ups this pass folded, for the `follow_up.observed` rows. */
    readonly followUps: FollowUpJoin[];
    /** Service-clock stamp for every run this pass touches. */
    readonly now: string;
    /** The binding's prompt snapshot, or `null`. */
    readonly prompt: PromptSnapshot | null;
    /** Observed heads keyed by subject key, when the scan read any. */
    readonly observedHeads: ReadonlyMap<string, string> | undefined;
}): void {
    const {
        delivery, runs, subjects, links, created, joins, followUps, now, prompt, observedHeads,
    } = input;
    const shape = subjectShapeOf(delivery);
    if (shape === null) {
        return;
    }

    const joinable = findJoinableRun(runs, shape.subjectKey);
    if (joinable === undefined) {
        // A follow-up with no joinable run opens nothing: the detector only
        // emits one for a subject whose run carries a recorded session, so
        // reaching this arm means the run is gone — and minting a run for a
        // follow-up is the second-session defect in a new dress. The row lands
        // in the queue unlinked, exactly as an ambiguous subject's does.
        if (followUpKindOfDelivery(delivery) !== null) {
            return;
        }

        const reference = referenceOf(delivery, true);
        if (reference === null) {
            return;
        }

        const ordinal = subjects[shape.subjectKey] ?? 0;
        subjects[shape.subjectKey] = ordinal + 1;
        const run = runForDelivery({
            delivery,
            shape,
            ordinal,
            reference,
            now,
            prompt,
            ...(observedHeads !== undefined && { observedHeads }),
        });
        runs.push(run);
        created.push(run);
        links.set(delivery.id, run.correlationId);

        return;
    }

    const { index, open } = joinable;
    links.set(delivery.id, open.correlationId);
    const kind = followUpKindOfDelivery(delivery);
    if (kind === null) {
        const reference = referenceOf(delivery, true);
        if (reference === null) {
            return;
        }

        const authorizedReference = { ...reference, presentAtAuthorization: open.reservation === null };
        const folded = joinReference({ run: open, reference: authorizedReference, now });
        runs[index] = folded.run;
        joins.push({ run: folded.run, reference: authorizedReference, retained: folded.retained });

        return;
    }

    // A follow-up rides the run it joins and never the run's reference list
    // (FR-104): its own delivery id is the only place its role lives.
    runs[index] = { ...open, updatedAt: now };
    followUps.push({ run: runs[index], deliveryId: delivery.id, kind });
}

/**
 * Fold fresh deliveries into runs: join the subject's open run, else create
 * the next ordinal. Pure — the caller owns the chain, the two
 * writes, and the audit rows, in that order.
 *
 * @returns The document to persist plus the effects to audit and link.
 */
export function applyEnqueue(input: EnqueueInput): EnqueueOutcome {
    const prompt = input.prompt ?? null;
    const runs = [...input.document.runs];
    const subjects = { ...input.document.subjects };
    const links = new Map<string, string>();
    const created: Run[] = [];
    const joins: EnqueueJoin[] = [];
    const followUps: FollowUpJoin[] = [];

    for (const delivery of input.deliveries) {
        foldDelivery({
            delivery,
            runs,
            subjects,
            links,
            created,
            joins,
            followUps,
            now: input.now,
            prompt,
            observedHeads: input.observedHeads,
        });
    }

    if (input.observedHeads !== undefined) {
        recordHeadSeeds(runs, input.observedHeads);
    }

    const auditIntents: RunAuditIntent[] = [
        ...(input.document.auditIntents ?? []),
        ...created.map((run): RunAuditIntent => ({
            eventType: 'run.created',
            correlationId: run.correlationId,
            deliveryIds: run.sourceReferences.map((reference) => reference.deliveryId),
        })),
    ];

    return {
        document: { schemaVersion: RUNS_SCHEMA_VERSION, subjects, runs, auditIntents },
        links,
        created,
        joins,
        followUps,
    };
}
