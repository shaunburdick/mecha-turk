/**
 * The excerpt retention pass over `events.json` (006 T-013; FR-057; AC-147,
 * SC-115).
 *
 * The pass clears **text only**, and every case here is a seeded queue on a
 * temp directory driven by an injected clock — no network, no waiting, no live
 * host (006 FR-086). What is asserted is the pass's refusal as much as its
 * action:
 *
 * - a terminal row older than `excerptRetentionDays` is cleared **and** marked**,
 *   and the marker survives a store round trip as something distinct from a
 *   row that never carried a body;
 * - a `pending` or `in-flight` row of the same age is untouched at any age, a
 *   fresh terminal row is untouched, and a row with no lifecycle state and no
 *   usable run link is left byte-for-byte alone;
 * - **the run-layer eligibility (T-032)**: a post-003 row whose linked run is
 *   `dispatched` clears after the window, while `failed`, `dead-lettered`,
 *   `unconfirmed`, and `pending` runs keep their excerpt at any age, and the
 *   legacy `state === 'dispatched'` path still works beside it;
 * - id, state, stamps, and correlation identifier survive the clearing;
 * - exactly one `audit.trimmed` row records the clearing, **after** it, and a
 *   pass that clears nothing appends nothing — twice over, so the pass is
 *   idempotent rather than a row-per-cycle leak.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { EVENTS_FILE, createEvent, readEvents } from '../service/poll/events.ts';
import { trimExcerpts } from '../service/poll/excerpt-trim.ts';
import { applyEnqueue } from '../service/poll/runs-join.ts';
import { RUNS_FILE, emptyRunsDocument } from '../service/poll/runs.ts';
import { openStore } from '../service/store/index.ts';
import type { EventState, QueuedEvent } from '../service/poll/events.ts';
import type { RunState } from '../service/poll/runs-types.ts';
import type { ServiceConfig } from '../service/config.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';

/** Injected service clock: every fixture ages against this instant. */
const NOW = Date.parse('2026-09-30T00:00:00.000Z');

/** The stamp the pass writes as its marker, derived from the clock above. */
const CLEARED_AT = '2026-09-30T00:00:00.000Z';

/** A detection older than the default 30-day window. */
const OLD_DETECTED = '2026-06-01T00:00:00.000Z';

/** A detection inside the default window. */
const FRESH_DETECTED = '2026-09-29T00:00:00.000Z';

/** The excerpt a dispatched row carries. */
const DISPATCHED_BODY = 'the issue body this dispatch already carried';

/** The excerpt a pending row carries; it must never be cleared. */
const PENDING_BODY = 'the issue body the operator has not dispatched yet';

/** Event ids the fixtures use; one spelling each. */
const OLD_DISPATCHED = 'evt-old-dispatched';
const OLD_PENDING = 'evt-old-pending';
const OLD_IN_FLIGHT = 'evt-old-in-flight';
const FRESH_DISPATCHED = 'evt-fresh-dispatched';
const OLD_EMPTY_BODY = 'evt-old-empty-body';
const OLD_STATELESS = 'evt-old-stateless';

/** Correlation id the dispatched row keeps through the clearing. */
const RUN_CORRELATION = 'mt-run-0123456789abcdef01234567';

/** Temporary root created per test. */
let tempRoot = '';

/** Absolute data directory the store opens on. */
let dataDir = '';

/** Open store handle the cases seed and trim through. */
let store: ServiceStore;

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-excerpt-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
});

/**
 * Build a capturing logger, so the pass's own line can be asserted.
 *
 * @returns The logger plus the lines it received.
 */
function capturingLogger(): { readonly log: ServiceLogger; readonly lines: string[] } {
    const lines: string[] = [];
    const log = createLogger({
        level: 'debug',
        sink: (line: string) => {
            lines.push(line);
        },
    });

    return { log, lines };
}

/** Inputs one seeded queue row is built from. */
interface QueueSeed {
    /** Event id, which dedupe and this pass both key on. */
    readonly id: string;
    /** Detection stamp the window judges. */
    readonly detectedAt: string;
    /** Lifecycle state; omitted for a post-003 row. */
    readonly state?: EventState;
    /** Payload excerpt; `''` stands in for an issue that had no body. */
    readonly excerpt?: string;
    /** Run link the clearing must preserve. */
    readonly runCorrelationId?: string;
    /** Issue number; `7` when the fixture does not care. */
    readonly issueNumber?: number;
}

/**
 * Build one complete, parseable queue row.
 *
 * @param seed - What distinguishes this row.
 * @returns The stored shape `parseStoredEvent` accepts.
 */
function queuedRow(seed: QueueSeed): Record<string, unknown> {
    return {
        id: seed.id,
        bindingId: 'bnd-excerpt-fixture',
        kind: 'assignment',
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat-mt',
        projectId: 'prj_42',
        worktreeOption: 'none',
        issueNumber: seed.issueNumber ?? 7,
        issueTitle: 'Ticket #7',
        issueUrl: 'https://github.com/acme/widget/issues/7',
        issueBodyExcerpt: seed.excerpt ?? DISPATCHED_BODY,
        headSha: null,
        baseRef: null,
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
        triggerNote: 'Issue assigned to the bound account',
        detectedAt: seed.detectedAt,
        ...(seed.state !== undefined && { state: seed.state, claimedAt: null, dispatchedAt: seed.detectedAt }),
        ...(seed.runCorrelationId !== undefined && { runCorrelationId: seed.runCorrelationId }),
    };
}

/**
 * The mixed fixture: one clearable row and five that must not be cleared.
 */
async function plantQueue(rows: readonly Record<string, unknown>[]): Promise<void> {
    await store.writeJson(EVENTS_FILE, rows);
}

/**
 * Read the queue back through the module's own reader.
 *
 * @returns The stored rows, in file order.
 */
async function storedQueue(): Promise<readonly QueuedEvent[]> {
    return await readEvents({ store, log: capturingLogger().log });
}

/**
 * Read one row out of the stored queue by id.
 *
 * @returns The row, or `undefined` when the queue has no such event.
 */
async function storedRow(id: string): Promise<QueuedEvent | undefined> {
    const queue = await storedQueue();

    return queue.find((event) => event.id === id);
}

/**
 * The configuration one pass runs on.
 *
 * @returns A complete configuration document at the documented defaults.
 */
function config(): ServiceConfig {
    return { ...DEFAULT_CONFIG };
}

/** A run link the stored run document never answers. */
const ORPHAN_RUN_CORRELATION = 'mt-run-aaaaaaaaaaaaaaaaaaaaaaaa';

/** One run-linked queue row the run-layer fixtures seed. */
interface LinkedSeed {
    /** Issue number; each seed is its own subject, so each gets its own run. */
    readonly issueNumber: number;
    /** Detection stamp the window judges. */
    readonly detectedAt: string;
    /** The run's state word; detection alone can only ever produce `pending`. */
    readonly runState: RunState;
    /** Payload excerpt; `DISPATCHED_BODY` when omitted. */
    readonly excerpt?: string;
}

/**
 * Plant a post-003 queue together with the run document its rows link to.
 *
 * Rows come from the same pure writer production uses (`createEvent`) and runs
 * from the same pure join (`applyEnqueue`), so both parse as stored; only the
 * run's `state` word is replaced, because detection can never produce
 * `failed`, `dead-lettered`, or `unconfirmed`. The run document's audit outbox
 * is emptied: this fixture records no lifecycle rows, and a pending intent
 * would be a second fixture hiding inside the first.
 *
 * @param seeds - One per run, in creation order.
 * @param extra - Queue rows stored beside them (an orphan link, say).
 * @returns The stored queue, in file order.
 */
async function plantLinkedQueue(
    seeds: readonly LinkedSeed[],
    extra: readonly Record<string, unknown>[] = [],
): Promise<readonly QueuedEvent[]> {
    const rows = seeds.map((seed) =>
        createEvent({
            kind: 'assignment',
            bindingId: 'bnd-excerpt-fixture',
            repository: 'acme/widget',
            accountNumericUserId: '77331',
            accountLogin: 'octocat-mt',
            projectId: 'prj_42',
            worktreeOption: 'none',
            issue: {
                issueNumber: seed.issueNumber,
                issueTitle: `Issue #${seed.issueNumber}`,
                issueUrl: `https://github.com/acme/widget/issues/${seed.issueNumber}`,
                issueBodyExcerpt: seed.excerpt ?? DISPATCHED_BODY,
            },
            actorLogin: 'alice',
            actorAttribution: 'subject-author',
            triggerNote: 'Issue assigned to the bound account',
            detectedAt: seed.detectedAt,
        }),);
    const outcome = applyEnqueue({
        document: emptyRunsDocument(),
        deliveries: rows,
        now: seeds[0]?.detectedAt ?? OLD_DETECTED,
    });
    const runs = outcome.created.map((run, index) => {
        const seed = seeds[index];
        if (seed === undefined) {
            throw new Error('the fixture joined more runs than it seeded');
        }

        return { ...run, state: seed.runState, stateReason: 'seeded by the excerpt fixture' };
    });
    const linked = rows.map((row) => {
        const correlationId = outcome.links.get(row.id);
        if (correlationId === undefined) {
            throw new Error('the fixture produced a row that joined no run');
        }

        return { ...row, runCorrelationId: correlationId };
    });
    await store.writeJson(RUNS_FILE, { ...outcome.document, runs, auditIntents: [] });
    await store.writeJson(EVENTS_FILE, [...linked, ...extra]);

    return linked;
}

/**
 * Read one stored queue row by issue number.
 *
 * @returns The row, or `undefined` when the queue holds no such issue.
 */
function rowFor(queue: readonly QueuedEvent[], issueNumber: number): QueuedEvent | undefined {
    return queue.find((row) => row.issueNumber === issueNumber);
}

describe('excerpt trim: what it clears (006 T-013, FR-057, AC-147)', () => {
    it('clears and marks an old terminal row while leaving every other row alone', async () => {
        {
            await plantQueue([
                queuedRow({
                    id: OLD_DISPATCHED,
                    detectedAt: OLD_DETECTED,
                    state: 'dispatched',
                    runCorrelationId: RUN_CORRELATION,
                }),
                queuedRow({ id: OLD_PENDING, detectedAt: OLD_DETECTED, state: 'pending', excerpt: PENDING_BODY }),
                queuedRow({ id: OLD_IN_FLIGHT, detectedAt: OLD_DETECTED, state: 'in-flight', excerpt: PENDING_BODY }),
                queuedRow({ id: FRESH_DISPATCHED, detectedAt: FRESH_DETECTED, state: 'dispatched' }),
                queuedRow({ id: OLD_EMPTY_BODY, detectedAt: OLD_DETECTED, state: 'dispatched', excerpt: '' }),
                queuedRow({ id: OLD_STATELESS, detectedAt: OLD_DETECTED, excerpt: PENDING_BODY }),
            ]);
            const { log, lines } = capturingLogger();

            const outcome = await trimExcerpts({ store, log, config: config(), now: NOW });

            expect(outcome.cleared).toBe(1);
            // The cleared row: text gone, marker set, everything else identical.
            const cleared = await storedRow(OLD_DISPATCHED);
            expect(cleared?.issueBodyExcerpt).toBe('');
            expect(cleared?.excerptTrimmedAt).toBe(CLEARED_AT);
            expect(cleared?.state).toBe('dispatched');
            expect(cleared?.dispatchedAt).toBe(OLD_DETECTED);
            expect(cleared?.runCorrelationId).toBe(RUN_CORRELATION);
            expect(cleared?.detectedAt).toBe(OLD_DETECTED);
            expect(cleared?.id).toBe(OLD_DISPATCHED);
            // Untouched: pending and in-flight at any age, a fresh terminal row, a
            // row that never had a body, and a row with neither a lifecycle state
            // nor a run the document can answer — the last is left alone because
            // its link is unusable, not because it is stateless (T-032: a linked
            // post-003 row *does* clear, and is exercised below).
            const pending = await storedRow(OLD_PENDING);
            expect(pending?.issueBodyExcerpt).toBe(PENDING_BODY);
            expect(pending?.excerptTrimmedAt).toBeUndefined();
            const inFlight = await storedRow(OLD_IN_FLIGHT);
            expect(inFlight?.issueBodyExcerpt).toBe(PENDING_BODY);
            expect(inFlight?.excerptTrimmedAt).toBeUndefined();
            const fresh = await storedRow(FRESH_DISPATCHED);
            expect(fresh?.issueBodyExcerpt).toBe(DISPATCHED_BODY);
            expect(fresh?.excerptTrimmedAt).toBeUndefined();
            // Never-bodied stays distinguishable: cleared rows carry a marker, this
            // one does not, so a reader can never conclude it had no body.
            const neverBodied = await storedRow(OLD_EMPTY_BODY);
            expect(neverBodied?.issueBodyExcerpt).toBe('');
            expect(neverBodied?.excerptTrimmedAt).toBeUndefined();
            const stateless = await storedRow(OLD_STATELESS);
            expect(stateless?.issueBodyExcerpt).toBe(PENDING_BODY);
            expect(stateless?.excerptTrimmedAt).toBeUndefined();
            // One row, appended after the clearing, naming the excerpt window.
            const trail = await readAuditEntries(store);
            expect(trail).toHaveLength(1);
            expect(trail[0]?.eventType).toBe('audit.trimmed');
            expect(trail[0]?.decision).toBe('trimmed');
            expect(trail[0]?.actorSource).toBe('service');
            expect(trail[0]?.entity).toEqual({ kind: 'service', id: 'configuration' });
            expect(trail[0]?.details).toEqual({
                entriesRemoved: 1,
                limitReached: 'excerpt-days',
                minimalReferencesPreserved: 0,
            });
            expect(lines.some((line) => line.includes('stored payload excerpts trimmed'))).toBe(true);
        }
    });

    it('keeps the marker across a store round trip on a reopened handle', async () => {
        {
            await plantQueue([
                queuedRow({ id: OLD_DISPATCHED, detectedAt: OLD_DETECTED, state: 'dispatched' }),
            ]);

            await trimExcerpts({ store, log: capturingLogger().log, config: config(), now: NOW });

            const reopened = await openStore({ dataDir });
            const queue = await readEvents({ store: reopened, log: capturingLogger().log });

            expect(queue).toHaveLength(1);
            expect(queue[0]?.issueBodyExcerpt).toBe('');
            expect(queue[0]?.excerptTrimmedAt).toBe(CLEARED_AT);
            // Round-trippable and typed: the marker is a date a reader can parse,
            // not a sentinel string living in the excerpt field.
            expect(Number.isNaN(Date.parse(queue[0]?.excerptTrimmedAt ?? ''))).toBe(false);
        }
    });

    it('appends nothing when a pass clears nothing', async () => {
        {
            await plantQueue([
                queuedRow({ id: FRESH_DISPATCHED, detectedAt: FRESH_DETECTED, state: 'dispatched' }),
                queuedRow({ id: OLD_PENDING, detectedAt: OLD_DETECTED, state: 'pending', excerpt: PENDING_BODY }),
            ]);
            const before = await readFile(join(dataDir, EVENTS_FILE), 'utf8');

            const outcome = await trimExcerpts({
                store,
                log: capturingLogger().log,
                config: config(),
                now: NOW,
            });

            expect(outcome.cleared).toBe(0);
            expect(await readFile(join(dataDir, EVENTS_FILE), 'utf8')).toBe(before);
            expect(await readAuditEntries(store)).toEqual([]);
        }
    });

    it('is idempotent: a second pass clears nothing and records nothing', async () => {
        {
            await plantQueue([
                queuedRow({ id: OLD_DISPATCHED, detectedAt: OLD_DETECTED, state: 'dispatched' }),
            ]);
            const { log } = capturingLogger();

            const first = await trimExcerpts({ store, log, config: config(), now: NOW });
            const afterFirst = await readFile(join(dataDir, EVENTS_FILE), 'utf8');
            const second = await trimExcerpts({ store, log, config: config(), now: NOW });

            expect(first.cleared).toBe(1);
            expect(second.cleared).toBe(0);
            expect(await readFile(join(dataDir, EVENTS_FILE), 'utf8')).toBe(afterFirst);
            const trail = await readAuditEntries(store);
            expect(trail).toHaveLength(1);
        }
    });

    it('leaves the queue byte-identical and records nothing when the rewrite fails', async () => {
        {
            await plantQueue([
                queuedRow({ id: OLD_DISPATCHED, detectedAt: OLD_DETECTED, state: 'dispatched' }),
            ]);
            const before = await readFile(join(dataDir, EVENTS_FILE), 'utf8');
            const failing: ServiceStore = {
                ...store,
                writeJson: () => Promise.reject(new Error('disk full')),
            };

            await expect(
                trimExcerpts({ store: failing, log: capturingLogger().log, config: config(), now: NOW }),
            ).rejects.toThrow('disk full');

            expect(await readFile(join(dataDir, EVENTS_FILE), 'utf8')).toBe(before);
            expect(await readAuditEntries(store)).toEqual([]);
        }
    });

    it('honours the configured window rather than a hard-coded one', async () => {
        {
            await plantQueue([
                queuedRow({ id: OLD_DISPATCHED, detectedAt: OLD_DETECTED, state: 'dispatched' }),
            ]);
            const widened = { ...DEFAULT_CONFIG, excerptRetentionDays: 365 };

            const outcome = await trimExcerpts({ store, log: capturingLogger().log, config: widened, now: NOW });

            // The fixture is 121 days old: inside a 365-day window it survives.
            expect(outcome.cleared).toBe(0);
            const untouched = await storedRow(OLD_DISPATCHED);
            expect(untouched?.excerptTrimmedAt).toBeUndefined();
            expect(await readAuditEntries(store)).toEqual([]);
        }
    });

});

describe('excerpt trim: the run-layer eligibility (006 T-032, FR-057, FR-052, FR-084)', () => {
    it('clears an aged dispatched run, and refuses every other run state beside it', async () => {
        {
            const planted = await plantLinkedQueue(
                [
                    { issueNumber: 1, detectedAt: OLD_DETECTED, runState: 'dispatched' },
                    { issueNumber: 2, detectedAt: OLD_DETECTED, runState: 'failed' },
                    { issueNumber: 3, detectedAt: OLD_DETECTED, runState: 'dead-lettered' },
                    { issueNumber: 4, detectedAt: OLD_DETECTED, runState: 'unconfirmed' },
                    { issueNumber: 5, detectedAt: OLD_DETECTED, runState: 'pending' },
                    { issueNumber: 6, detectedAt: FRESH_DETECTED, runState: 'dispatched' },
                ],
                [
                    // The legacy path beside it: a pre-003 row answers from its own
                    // frozen `state`, so it clears even though no run document has
                    // ever heard of its link.
                    queuedRow({
                        id: 'evt-legacy-dispatched',
                        detectedAt: OLD_DETECTED,
                        state: 'dispatched',
                        runCorrelationId: RUN_CORRELATION,
                    }),
                    // A post-003 row whose link no run answers: no usable link, so
                    // it is left alone rather than guessed at.
                    queuedRow({
                        id: 'evt-orphan-link',
                        issueNumber: 8,
                        detectedAt: OLD_DETECTED,
                        excerpt: PENDING_BODY,
                        runCorrelationId: ORPHAN_RUN_CORRELATION,
                    }),
                ],
            );
            const { log, lines } = capturingLogger();

            const outcome = await trimExcerpts({ store, log, config: config(), now: NOW });

            // Exactly two cleared: the aged run that really reached `dispatched`,
            // and the legacy row. The relay still reads the other four to dispatch,
            // retry, or return them to waiting, so their text stays **at any age**.
            expect(outcome.cleared).toBe(2);
            const stored = await storedQueue();
            const cleared = rowFor(stored, 1);
            expect(cleared?.issueBodyExcerpt).toBe('');
            expect(cleared?.excerptTrimmedAt).toBe(CLEARED_AT);
            expect(cleared?.state).toBeUndefined();
            expect(cleared?.runCorrelationId).toBe(planted[0]?.runCorrelationId);
            expect(cleared?.detectedAt).toBe(OLD_DETECTED);
            expect(cleared?.id).toBe(planted[0]?.id);
            const legacy = stored.find((row) => row.id === 'evt-legacy-dispatched');
            expect(legacy?.issueBodyExcerpt).toBe('');
            expect(legacy?.excerptTrimmedAt).toBe(CLEARED_AT);
            for (const issueNumber of [2, 3, 4]) {
                expect(rowFor(stored, issueNumber)?.issueBodyExcerpt).toBe(DISPATCHED_BODY);
                expect(rowFor(stored, issueNumber)?.excerptTrimmedAt).toBeUndefined();
            }
            // The pending row is byte-identical: every field it was planted with.
            expect(rowFor(stored, 5)).toEqual(planted[4]);
            // Inside the window, and with no usable link, are left alone too.
            expect(rowFor(stored, 6)?.issueBodyExcerpt).toBe(DISPATCHED_BODY);
            expect(rowFor(stored, 6)?.excerptTrimmedAt).toBeUndefined();
            expect(rowFor(stored, 8)?.issueBodyExcerpt).toBe(PENDING_BODY);
            expect(rowFor(stored, 8)?.excerptTrimmedAt).toBeUndefined();
            // One row records the clearing, after it, naming the excerpt window.
            const trail = await readAuditEntries(store);
            expect(trail).toHaveLength(1);
            expect(trail[0]?.eventType).toBe('audit.trimmed');
            expect(trail[0]?.details).toEqual({
                entriesRemoved: 2,
                limitReached: 'excerpt-days',
                minimalReferencesPreserved: 0,
            });
            expect(lines.some((line) => line.includes('stored payload excerpts trimmed'))).toBe(true);
        }
    });

    it('keeps a run-linked row\'s marker across a store round trip', async () => {
        {
            await plantLinkedQueue([{ issueNumber: 1, detectedAt: OLD_DETECTED, runState: 'dispatched' }]);

            await trimExcerpts({ store, log: capturingLogger().log, config: config(), now: NOW });

            const reopened = await openStore({ dataDir });
            const queue = await readEvents({ store: reopened, log: capturingLogger().log });

            expect(queue).toHaveLength(1);
            expect(queue[0]?.issueBodyExcerpt).toBe('');
            expect(queue[0]?.excerptTrimmedAt).toBe(CLEARED_AT);
            expect(Number.isNaN(Date.parse(queue[0]?.excerptTrimmedAt ?? ''))).toBe(false);
        }
    });

    it('leaves every post-003 row alone while the run document is unreadable', async () => {
        {
            await plantLinkedQueue([{ issueNumber: 1, detectedAt: OLD_DETECTED, runState: 'dispatched' }]);
            // Fail closed: a run document the store cannot parse answers "unknown",
            // and unknown never clears a post-003 row (invariant 8).
            await store.writeJson(RUNS_FILE, { schemaVersion: 'not-a-run-document' });
            const before = await readFile(join(dataDir, EVENTS_FILE), 'utf8');
            const { log, lines } = capturingLogger();

            const outcome = await trimExcerpts({ store, log, config: config(), now: NOW });

            expect(outcome.cleared).toBe(0);
            expect(await readFile(join(dataDir, EVENTS_FILE), 'utf8')).toBe(before);
            expect(await readAuditEntries(store)).toEqual([]);
            expect(lines.some((line) => line.includes('post-003 excerpts stay put'))).toBe(true);
        }
    });

});
