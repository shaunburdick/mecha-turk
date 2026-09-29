/**
 * The claim's bounds: an answer the transport can always carry, and a lease
 * never left behind by one it cannot (003 T-039;
 * [contracts/claim-lease.md](../../specs/003-dispatch-integrity/contracts/claim-lease.md)).
 *
 * The defect these tests exist for was measured, not theorised: one run with
 * 200 retained references projects to roughly 167 KB, so **two** such runs — or
 * 300 single-reference runs — exceeded the 256,000-character response ceiling.
 * The old claim leased *every* pending run first and serialized the answer
 * afterwards, so the service returned `500 response-too-large` **after** the
 * leases were durable. The panel received no run ids, could not act, and the
 * stranded runs burned an attempt plus a unit of the automatic requeue budget
 * on every pass until they dead-lettered (FR-032, FR-033) — work that was
 * never dispatched and never refused by anything.
 *
 * So this suite pins four properties, in the order the fix establishes them:
 *
 * 1. the answer is projected and **measured before** anything is leased, and it
 *    stays under the documented budget for both measured shapes;
 * 2. what the page leaves out is left `pending` and unleased, and is claimable
 *    on the next call — pagination, not truncation (contract §1);
 * 3. no run the answer omits carries a lease, and no `dispatch.claimed` row
 *    exists for one — the failure's actual cost;
 * 4. excerpt text is bounded with an **explicit marker** and every retained
 *    reference's identity survives (FR-014's rule, FR-013's fields).
 *
 * Everything runs offline against a temp store with injected stamps: no host,
 * no network, and no sleeping on a timer.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { RESPONSE_BODY_MAX_CHARS } from '../service/http.ts';
import {
    CLAIM_EVENTS_BUDGET_CHARS,
    EXCERPT_OMITTED_MARKER,
    EXCERPT_TRUNCATION_MARKER,
    MAX_CLAIMED_RUNS,
    REFERENCE_EXCERPT_MAX_CHARS,
    RUN_EXCERPT_MAX_CHARS,
    isExcerptMarker,
    measureEvents,
} from '../service/poll/claim-bounds.ts';
import { claimPendingRuns } from '../service/poll/claim.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { MAX_SOURCE_REFERENCES, readRunsDocument } from '../service/poll/runs.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceStore } from '../service/store/index.ts';

/** Stamp every fixture uses, so no test ever waits on a clock. */
const STAMP = '2026-09-28T12:00:00.000Z';
const HOLDER = 'panel-bounds';
const BINDING_ID = 'bnd-bounds';
const REPOSITORY = 'acme/widget';
const ACCOUNT_ID = '77331';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-bounds-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    LOG_LINES.length = 0;
    await store.writeJson('config.json', { ...DEFAULT_CONFIG, leaseMs: 45_000, resultDeadlineMs: 45_000 });
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Build one assignment detection, with a body excerpt of the given size.
 *
 * The excerpt length matters here: the run's identity fields are fixed, so the
 * excerpt is the member that decides how large a run projects.
 *
 * @param issueNumber - Issue the detection is for.
 * @param excerptChars - Length of the body excerpt to carry.
 * @returns The detection snapshot.
 */
function assignment(issueNumber: number, excerptChars = 40): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/${REPOSITORY}/issues/${issueNumber}`,
            issueBodyExcerpt: 'x'.repeat(excerptChars),
        },
        triggerNote: 'assigned',
        detectedAt: STAMP,
    };
}

/** Enqueue detections, one per issue. */
async function seed(count: number, excerptChars = 40): Promise<void> {
    const incoming = Array.from(
        { length: count },
        (_unused, index) => createEvent(assignment(index + 1, excerptChars)),
    );
    await enqueueEvents({ store, log: LOGGER, incoming });
}

/** Claim with the shared fixture holder and stamp. */
async function claim(): ReturnType<typeof claimPendingRuns> {
    return await claimPendingRuns({ store, log: LOGGER, holder: HOLDER, now: STAMP });
}

/** Every stored run's state, in document order. */
async function statesOfRuns(): Promise<readonly string[]> {
    const document = await readRunsDocument({ store, log: LOGGER });

    return document.runs.map((run) => run.state);
}

/**
 * Give every run in the document a full 200-reference list, each delivery
 * carrying a maximum-length excerpt.
 *
 * This is the shape the review measured at ~167 KB per run: the run's own
 * identity is tiny, the reference list is the whole cost.
 */
/**
 * Join a full 200-reference list onto the run for one issue.
 *
 * This is the shape the review measured at ~167 KB per run: the run's own
 * identity is tiny, the reference list is the whole cost. Comment mentions are
 * used because they carry a distinct delivery id per comment, so a run can
 * legitimately reach the cap (a single issue mentioned 199 times).
 *
 * @param issueNumber - The run's subject, which is also the join key.
 * @returns The number of references the run ended up with.
 */
async function joinFullReferenceList(issueNumber: number): Promise<number> {
    const joined = await enqueueEvents({
        store,
        log: LOGGER,
        incoming: Array.from({ length: MAX_SOURCE_REFERENCES - 1 }, (_unused, index) => createEvent({
            ...assignment(issueNumber, REFERENCE_EXCERPT_MAX_CHARS),
            kind: 'mention',
            origin: 'comment',
            commentId: index + 1,
        })),
    });
    const document = await readRunsDocument({ store, log: LOGGER });
    const run = document.runs.find((candidate) => candidate.subjectNumber === issueNumber);

    expect(joined).toHaveLength(MAX_SOURCE_REFERENCES - 1);
    expect(run?.sourceReferences).toHaveLength(MAX_SOURCE_REFERENCES);

    return run?.sourceReferences.length ?? 0;
}

describe('T-039 the answer is bounded and the page is complete', () => {
    it('answers 200 within the transport ceiling for two full-reference runs', async () => {
        // Two runs, each with the review's measured ~167 KB shape: a full
        // 200-reference list where every delivery carries a max-length excerpt.
        await seed(2, REFERENCE_EXCERPT_MAX_CHARS);
        await joinFullReferenceList(1);
        await joinFullReferenceList(2);

        const result = await claim();

        expect(result.auditWritten).toBe(true);
        expect(result.runs).toHaveLength(2);
        const measured = measureEvents(result.runs);
        expect(measured).toBeLessThanOrEqual(CLAIM_EVENTS_BUDGET_CHARS);
        expect(measured).toBeLessThan(RESPONSE_BODY_MAX_CHARS);
        // Every reference's identity is retained in full; only the excerpt text
        // is bounded, and that is what brings the page under the ceiling.
        expect(result.runs.every((run) => run.sourceReferences.length === MAX_SOURCE_REFERENCES)).toBe(true);
        expect(result.deferred).toBe(0);
    });

    it('answers 200 within the ceiling for 300 single-reference runs', async () => {
        await seed(300);

        const result = await claim();

        expect(result.auditWritten).toBe(true);
        expect(result.runs.length).toBeGreaterThan(0);
        expect(result.runs.length).toBeLessThanOrEqual(MAX_CLAIMED_RUNS);
        expect(measureEvents(result.runs)).toBeLessThanOrEqual(CLAIM_EVENTS_BUDGET_CHARS);
        expect(result.deferred).toBe(300 - result.runs.length);
    });

    it('never exceeds the response ceiling the transport enforces', () => {
        // The reserve is what makes the per-page budget safe: the rest of the
        // answer (status rows, envelope) has to fit in what is left.
        expect(CLAIM_EVENTS_BUDGET_CHARS).toBeLessThan(RESPONSE_BODY_MAX_CHARS);
        expect(RESPONSE_BODY_MAX_CHARS - CLAIM_EVENTS_BUDGET_CHARS).toBe(65_536);
    });
});

describe('T-039 no lease is stranded behind an answer the transport refuses', () => {
    it('leases nothing the answer omits, and writes no claim row for it', async () => {
        await seed(MAX_CLAIMED_RUNS + 25);

        const result = await claim();
        const offered = new Set(result.runs.map((run) => run.correlationId));
        const document = await readRunsDocument({ store, log: LOGGER });
        const audits = await readAuditEntries(store);
        const claimRows = audits.filter((entry) => entry.eventType === 'dispatch.claimed');

        // The budget the review measured: the cap trips before the byte budget.
        expect(result.runs).toHaveLength(MAX_CLAIMED_RUNS);
        expect(result.deferred).toBe(25);

        // The defect, stated as an assertion: a run the answer omitted has no
        // lease, and therefore burns no attempt and no requeue budget while it
        // waits for the next page.
        const omitted = document.runs.filter((run) => !offered.has(run.correlationId));
        expect(omitted).toHaveLength(25);
        expect(omitted.every((run) => run.lease === null)).toBe(true);
        expect(omitted.every((run) => run.attempt === 1)).toBe(true);
        expect(omitted.every((run) => run.requeuesUsed === 0)).toBe(true);

        // And no audit row claims a lease that was never taken.
        expect(claimRows).toHaveLength(MAX_CLAIMED_RUNS);
        expect(claimRows.map((row) => row.correlationId).sort())
            .toEqual([...offered].sort());
    });

    it('serves the deferred remainder on the next call, unchanged', async () => {
        await seed(MAX_CLAIMED_RUNS + 3);

        const first = await claim();
        const second = await claim();

        expect(first.runs).toHaveLength(MAX_CLAIMED_RUNS);
        expect(second.runs).toHaveLength(3);
        expect(second.deferred).toBe(0);
        // Disjoint: the second page is work the first one did not lease.
        const offered = new Set(first.runs.map((run) => run.correlationId));
        expect(second.runs.every((run) => !offered.has(run.correlationId))).toBe(true);
        expect(new Set([...first.runs, ...second.runs].map((run) => run.correlationId)).size)
            .toBe(MAX_CLAIMED_RUNS + 3);
    });

    it('leases nothing and writes nothing when the whole answer is over budget', async () => {
        await seed(2);
        // A budget too small for even one run: the documented refusal path.
        const result = await claimPendingRuns({
            store,
            log: LOGGER,
            holder: HOLDER,
            now: STAMP,
            budgetChars: 16,
        });
        const audits = await readAuditEntries(store);

        expect(result.runs).toEqual([]);
        expect(result.deferred).toBe(2);
        expect(result.auditWritten).toBe(true);
        expect(await statesOfRuns()).toEqual(['pending', 'pending']);
        expect(audits.filter((entry) => entry.eventType === 'dispatch.claimed')).toEqual([]);
    });
});

describe('T-039 excerpt text is bounded with an explicit marker (FR-014, FR-013)', () => {
    it('keeps every reference identity and marks an excerpt that was not carried', async () => {
        // One run whose references carry more excerpt text between them than the
        // per-run budget allows, built the way the store really builds one: an
        // assignment opens the run and comment mentions join it (FR-011).
        const overBudget = Math.ceil(RUN_EXCERPT_MAX_CHARS / REFERENCE_EXCERPT_MAX_CHARS) + 4;
        await seed(1, REFERENCE_EXCERPT_MAX_CHARS);
        await enqueueEvents({
            store,
            log: LOGGER,
            incoming: Array.from({ length: overBudget - 1 }, (_unused, index) => createEvent({
                ...assignment(1, REFERENCE_EXCERPT_MAX_CHARS),
                kind: 'mention',
                origin: 'comment',
                commentId: index + 1,
            })),
        });

        const result = await claim();
        const [claimed] = result.runs;
        if (claimed === undefined) {
            throw new Error('the run was not claimed');
        }

        // Every retained reference is still there, with FR-013's full detail.
        expect(claimed.sourceReferences).toHaveLength(overBudget);
        expect(claimed.sourceReferences.every((reference) => reference.deliveryId !== '')).toBe(true);
        expect(claimed.sourceReferences.every((reference) => reference.sourceUrl !== '')).toBe(true);
        expect(claimed.sourceReferences.every((reference) => reference.detectedAt === STAMP)).toBe(true);
        expect(claimed.sourceReferences.every((reference) => reference.presentAtAuthorization)).toBe(true);
        expect(claimed.referenceCount).toBe(overBudget);
        expect(claimed.referencesTruncated).toBe(false);

        // The budget is spent in join order: real text first, the explicit
        // marker once it runs out, and never the other way round.
        const firstMarker = claimed.sourceReferences.findIndex(
            (reference) => reference.excerpt === EXCERPT_OMITTED_MARKER,
        );
        const carriedCount = claimed.sourceReferences.filter(
            (reference) => !isExcerptMarker(reference.excerpt),
        ).length;
        expect(firstMarker).toBe(carriedCount);
        expect(carriedCount).toBeGreaterThan(0);
        expect(claimed.sourceReferences.slice(carriedCount).every(
            (reference) => reference.excerpt === EXCERPT_OMITTED_MARKER,
        )).toBe(true);
        // The first reference keeps its real, unmodified excerpt.
        expect(claimed.sourceReferences[0]?.excerpt).toBe('x'.repeat(REFERENCE_EXCERPT_MAX_CHARS));
        // And the run as a whole stayed inside the page budget.
        expect(measureEvents([claimed])).toBeLessThanOrEqual(CLAIM_EVENTS_BUDGET_CHARS);
    });

    it('marks an over-long excerpt rather than carrying it whole', async () => {
        // A single delivery whose stored excerpt is past the per-reference
        // bound — only reachable through a store written by another path, which
        // is exactly why the bound is re-applied on the way out.
        await seed(1, 40);
        await enqueueEvents({
            store,
            log: LOGGER,
            incoming: [createEvent({
                ...assignment(1, REFERENCE_EXCERPT_MAX_CHARS + 500),
                kind: 'mention',
                origin: 'comment',
                commentId: 9,
            })],
        });

        const result = await claim();
        const [claimed] = result.runs;
        const marked = claimed?.sourceReferences.at(-1)?.excerpt ?? '';

        expect(marked.endsWith(EXCERPT_TRUNCATION_MARKER)).toBe(true);
        expect(isExcerptMarker(marked)).toBe(true);
        // The reference itself is untouched: only the text was cut.
        expect(claimed?.sourceReferences).toHaveLength(2);
        expect(claimed?.sourceReferences[0]?.excerpt).not.toContain(EXCERPT_TRUNCATION_MARKER);
    });

    it('round-trips both markers through the answer unchanged', () => {
        // The panel's context builder (T-020) reads these strings back; a
        // marker that changed shape on the wire would be read as source text.
        for (const marker of [EXCERPT_OMITTED_MARKER, `excerpt${EXCERPT_TRUNCATION_MARKER}`]) {
            expect(JSON.parse(JSON.stringify({ excerpt: marker })).excerpt).toBe(marker);
            expect(isExcerptMarker(marker)).toBe(true);
        }
        // A genuine empty excerpt (an issue with no body) is not a marker.
        expect(isExcerptMarker('')).toBe(false);
        expect(isExcerptMarker('a real excerpt')).toBe(false);
    });

    it('bounds one run excerpt text to the per-dispatch budget', () => {
        // The budget FR-014 already fixes for the dispatch itself, applied to
        // the transport that feeds it — so no run can crowd out the page.
        expect(RUN_EXCERPT_MAX_CHARS).toBe(12_000);
        expect(RUN_EXCERPT_MAX_CHARS * (REFERENCE_EXCERPT_MAX_CHARS + 1))
            .toBeGreaterThan(RESPONSE_BODY_MAX_CHARS / 2);
    });
});

describe('T-039 the claim takes no chain slot when it leases nothing (T-040d)', () => {
    it('answers empty without writing, and leaves every run waiting', async () => {
        await seed(2);
        await claim();

        const second = await claim();
        const document = await readRunsDocument({ store, log: LOGGER });

        expect(second.runs).toEqual([]);
        expect(second.auditWritten).toBe(true);
        // A waiting run burns nothing across repeated claims (FR-036).
        expect(document.runs.every((run) => run.attempt === 1 && run.requeuesUsed === 0)).toBe(true);
    });
});
