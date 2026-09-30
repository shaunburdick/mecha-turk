/**
 * The excerpt retention pass over `events.json` (006 T-013; FR-057; AC-147,
 * SC-115).
 *
 * The pass clears **text only**, and every case here is a seeded queue on a
 * temp directory driven by an injected clock — no network, no waiting, no live
 * host (006 FR-086). What is asserted is the pass's refusal as much as its
 * action:
 *
 * - a terminal row older than `excerptRetentionDays` is cleared **and marked**,
 *   and the marker survives a store round trip as something distinct from a
 *   row that never carried a body;
 * - a `pending` or `in-flight` row of the same age is untouched at any age, a
 *   fresh terminal row is untouched, and a row with no lifecycle state at all
 *   (everything 003 enqueues) is left byte-for-byte alone;
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
import { EVENTS_FILE, readEvents } from '../service/poll/events.ts';
import { trimExcerpts } from '../service/poll/excerpt-trim.ts';
import { openStore } from '../service/store/index.ts';
import type { EventState, QueuedEvent } from '../service/poll/events.ts';
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

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-excerpt-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
});

afterEach(async () => {
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
        issueNumber: 7,
        issueTitle: 'Ticket #7',
        issueUrl: 'https://github.com/acme/widget/issues/7',
        issueBodyExcerpt: seed.excerpt ?? DISPATCHED_BODY,
        headSha: null,
        baseRef: null,
        triggerNote: 'Issue assigned to the bound account',
        detectedAt: seed.detectedAt,
        ...(seed.state === undefined ? {} : { state: seed.state, claimedAt: null, dispatchedAt: seed.detectedAt }),
        ...(seed.runCorrelationId === undefined ? {} : { runCorrelationId: seed.runCorrelationId }),
    };
}

/**
 * The mixed fixture: one clearable row and five that must not be cleared.
 *
 * @param rows - The rows to write into `events.json`.
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
 * @param id - Event id to find.
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

describe('excerpt trim: what it clears (006 T-013, FR-057, AC-147)', () => {
    it('clears and marks an old terminal row while leaving every other row alone', async () => {
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
        // row that never had a body, and a row with no lifecycle state at all.
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
    });

    it('keeps the marker across a store round trip on a reopened handle', async () => {
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
    });

    it('appends nothing when a pass clears nothing', async () => {
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
    });

    it('is idempotent: a second pass clears nothing and records nothing', async () => {
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
    });

    it('leaves the queue byte-identical and records nothing when the rewrite fails', async () => {
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
    });

    it('honours the configured window rather than a hard-coded one', async () => {
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
    });
});
