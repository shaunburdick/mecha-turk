/**
 * Bounds on the claim answer (003 T-039; contract §1's pagination rule).
 *
 * The claim is the only route that both **takes durable leases** and **returns
 * a list the transport then has to measure** against
 * `GUEST_REQUEST_RESPONSE_MAX` (256,000 characters). Getting that order wrong is
 * not a slow path, it is a correctness bug: a lease written for a run the
 * answer could not carry is a run the panel never learns about, and it burns an
 * attempt and a unit of the automatic requeue budget on every pass until it
 * dead-letters (FR-032, FR-033) — work that was never dispatched and never
 * refused by anything.
 *
 * So the answer is bounded here, and bounded *before* anything is written:
 *
 * 1. {@link MAX_CLAIMED_RUNS} — the most runs one claim ever offers, and the
 *    ceiling a request's `limit` is validated against.
 * 2. {@link CLAIM_EVENTS_BUDGET_CHARS} — the most characters the `events`
 *    member may occupy, derived from the transport ceiling minus a documented
 *    reserve for the `status` member and the JSON envelope.
 * 3. {@link RUN_EXCERPT_MAX_CHARS} / {@link REFERENCE_EXCERPT_MAX_CHARS} — the
 *    per-run and per-reference excerpt budgets, so one run with two hundred
 *    retained references cannot consume the whole answer.
 *
 * Bounds 2 and 3 are **not** truncation of the answer. A run whose excerpt text
 * did not fit still travels with **every** reference's identity (FR-013's full
 * detail), and the excerpt field carries an explicit marker saying its text was
 * not carried — FR-014's rule, applied on the service side of the same wire.
 * What the budgets bound is how much *untrusted text* rides along, never how
 * many references the operator is shown, and never how many runs are claimable:
 * a run the answer leaves out is left exactly where it was, `pending` and
 * unleased, which is what contract §1's "paginate, never truncate" requires.
 */

import { RESPONSE_BODY_MAX_CHARS } from '../http.ts';
import type { QueuedEvent } from './events-parse.ts';
import type { SourceReference } from './runs-types.ts';

/**
 * The most runs one claim ever offers, regardless of how many are waiting.
 *
 * Pagination, not truncation: everything beyond this stays `pending` and is
 * answered by the panel's next poll on its own clock. Fifty is chosen so the
 * answer is bounded by *count* well before the byte budget could be reached by
 * many small runs — the case (a few hundred single-reference runs) where a pure
 * byte bound would hand the panel a page too large to act on inside the lease
 * durations it just issued.
 */
export const MAX_CLAIMED_RUNS = 50;

/**
 * Characters reserved beside the `events` member for the rest of the answer.
 *
 * The claim answer is `{ events, status, auditWritten, hasMore }`, where
 * `status` holds one bounded row per stored binding (at most `MAX_BINDINGS`,
 * 100). Each row is a handful of short fields — ids, a repository name, two
 * stamps — so a full list is a few tens of thousands of characters. 65,536 is a
 * deliberate, generous multiple of that, chosen so the reserve can never be the
 * reason a run goes unclaimed for a page that would have fitted anyway.
 */
const CLAIM_ANSWER_RESERVE_CHARS = 65_536;

/**
 * The most characters the `events` member may occupy, derived from the
 * transport's own response ceiling rather than from a constant of its own.
 */
export const CLAIM_EVENTS_BUDGET_CHARS = RESPONSE_BODY_MAX_CHARS - CLAIM_ANSWER_RESERVE_CHARS;

/**
 * The most excerpt characters one run's references may carry on the answer.
 *
 * FR-014's per-dispatch budget (002 FR-028: ≤12,000 characters per dispatch),
 * applied to the transport that feeds it. A run with 200 retained references
 * would otherwise carry 200 × 600 = 120,000 characters of untrusted source text
 * — nearly half the response ceiling for a single run.
 */
export const RUN_EXCERPT_MAX_CHARS = 12_000;

/**
 * The most excerpt characters one reference may carry.
 *
 * 600 is the bound the trigger layer already writes (≤600 characters as
 * detected, data-model §2.3); re-applying it here means a row written by any
 * other path, or a hand-edited store, cannot widen it.
 */
export const REFERENCE_EXCERPT_MAX_CHARS = 600;

/**
 * Appended to excerpt text this module cut (FR-014's explicit truncation marker).
 *
 * A visible marker, never a silent cut: FR-014 forbids silently truncating one
 * source without a marker, and the same rule applies to the transport that
 * carries it.
 */
export const EXCERPT_TRUNCATION_MARKER = '… [truncated]';

/**
 * Stands in for excerpt text that was **not carried** at all.
 *
 * Distinct from the truncation marker on purpose: a trimmed excerpt is a
 * partial source the reader can still trust as a prefix, while an omitted
 * excerpt says the answer had no room for this source's text — and the
 * reference it belongs to is still there, with all of FR-013's identity fields.
 */
export const EXCERPT_OMITTED_MARKER = '[excerpt omitted: the claim answer carried this reference without its text]';

/** One reference as the claim answer carries it. */
export interface BoundedReference {
    /** The joining delivery's unchanged id (FR-012). */
    readonly deliveryId: string;
    /** Trigger kind the delivery was detected under. */
    readonly kind: QueuedEvent['kind'];
    /** Where it matched: assignment, issue body, a comment id, or review. */
    readonly origin: SourceReference['origin'];
    /** Canonical link back to the source. */
    readonly sourceUrl: string;
    /** That delivery's detection stamp. */
    readonly detectedAt: string;
    /** Bounded trigger excerpt, or an explicit marker when it was not carried. */
    readonly excerpt: string;
    /** `false` iff the run already held a reservation when this arrived. */
    readonly presentAtAuthorization: boolean;
}

/**
 * Whether an excerpt field is one of this module's explicit markers.
 *
 * Exported so the panel side (T-020's context builder) can tell an omitted
 * excerpt from genuinely empty source text without re-deriving the constants,
 * and so the round-trip test can assert a marker survives serialization.
 *
 * @returns `true` for either marker this module writes.
 */
export function isExcerptMarker(excerpt: string): boolean {
    return excerpt === EXCERPT_OMITTED_MARKER || excerpt.endsWith(EXCERPT_TRUNCATION_MARKER);
}

/**
 * Cut one excerpt to its per-reference bound, marking that it was cut.
 *
 * @param excerpt - Excerpt text as stored on the delivery row.
 * @returns The excerpt, marked when it was longer than the bound.
 */
function boundedExcerpt(excerpt: string): string {
    if (excerpt.length <= REFERENCE_EXCERPT_MAX_CHARS) {
        return excerpt;
    }

    return `${excerpt.slice(0, REFERENCE_EXCERPT_MAX_CHARS)}${EXCERPT_TRUNCATION_MARKER}`;
}

/**
 * What one excerpt costs against the per-run budget.
 *
 * An omitted reference costs nothing: the marker is a constant the module
 * writes, and charging it would make a 200-reference run's *markers* exhaust a
 * budget sized for source text. The bound that matters — the number of
 * references on the answer — is {@link MAX_SOURCE_REFERENCES} and the parser,
 * not this budget.
 *
 * @returns Characters added to the run's excerpt total.
 */
function excerptCost(excerpt: string): number {
    return excerpt === EXCERPT_OMITTED_MARKER ? 0 : excerpt.length;
}

/**
 * Project one run's references under the per-run excerpt budget.
 *
 * References are walked in join order and the budget is spent in that order, so
 * the answer is deterministic: the same run and the same stored rows always
 * produce the same answer. Every reference is returned — FR-013's identity
 * fields are never dropped — and a reference whose excerpt did not fit carries
 * {@link EXCERPT_OMITTED_MARKER}.
 *
 * @returns One claim-transport row per reference, in join order.
 */
export function projectReferences(input: {
    /** The run's retained references, in join order. */
    readonly references: readonly SourceReference[];
    /** Delivery rows keyed by id, as read from the queue. */
    readonly deliveries: ReadonlyMap<string, QueuedEvent>;
    /** Characters this run's excerpts may occupy in total. */
    readonly budget: number;
}): readonly BoundedReference[] {
    let remaining = input.budget;

    return input.references.map((reference) => {
        const stored = input.deliveries.get(reference.deliveryId)?.issueBodyExcerpt ?? '';
        const bounded = boundedExcerpt(stored);
        const excerpt = remaining >= excerptCost(bounded) ? bounded : EXCERPT_OMITTED_MARKER;
        remaining -= excerptCost(excerpt);

        return {
            deliveryId: reference.deliveryId,
            kind: reference.kind,
            origin: reference.origin,
            sourceUrl: reference.sourceUrl,
            detectedAt: reference.detectedAt,
            excerpt,
            presentAtAuthorization: reference.presentAtAuthorization,
        };
    });
}

/**
 * Measure the serialized size of a candidate claim answer's `events` member.
 *
 * `JSON.stringify` is the same measurement the transport performs before it
 * writes, so a page that fits here fits there; the difference between this and
 * the transport's own check is exactly the envelope members the reserve covers.
 *
 * @returns The serialized length in characters.
 */
export function measureEvents(runs: readonly unknown[]): number {
    return JSON.stringify(runs).length;
}
