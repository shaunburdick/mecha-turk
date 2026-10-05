/**
 * The retention wiring at both boundaries (006 T-014; FR-055, FR-057, FR-047,
 * FR-036; AC-128).
 *
 * The passes themselves are covered by `service-trim.test.ts` and
 * `service-excerpt-trim.test.ts`; what is asserted here is **where and when
 * they run** — the half that makes a saved limit a `next-cycle` fact rather
 * than a label:
 *
 * 1. **Store open** — a store seeded with an over-limit trail and an over-age
 *    excerpt queue trims once, before the listener accepts.
 * 2. **The write runs no trim** (FR-047) — a `PUT` that lowers a retention
 *    limit writes no `audit.trimmed` row of its own and removes nothing.
 * 3. **The next boundary applies it** — the same store, one cycle later, trims
 *    under the saved limit rather than the default one.
 * 4. **An unreadable configuration degrades to the documented defaults**
 *    rather than skipping the pass silently (invariant 8).
 *
 * Offline throughout: temp directories, seeded fixtures, a fake poller, and no
 * waiting of any kind — both boundaries are driven directly.
 */

import { mkdir } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { EVENTS_FILE, readEvents } from '../service/poll/events.ts';
import { runScanCycle } from '../service/poll/loop.ts';
import { openStore } from '../service/store/index.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { GitHubIssuePoller, PollIssue } from '../service/poll/poller-github.ts';
import type { JsonReadResult, ServiceStore } from '../service/store/index.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';
import { makeStoreTree, removeTempTree } from './support/temp-tree.ts';

/** Path of the configuration resource. */
const CONFIG_PATH = '/v1/config';

/** Store-relative audit trail the fixtures plant. */
const AUDIT_FILE = 'audit.ndjson';

/** Day expressed in milliseconds, the unit both windows count in. */
const DAY_MS = 86_400_000;

/** The clock these fixtures are anchored to; only their *age* matters. */
const NOW = Date.now();

/** An audit row far outside the default 180-day window (400 days old). */
const ANCIENT_SEQ = 41;

/** An audit row inside the default window but outside a saved 30-day one. */
const MIDDLE_SEQ = 7;

/** A row inside both windows; it survives every pass in this file. */
const FRESH_SEQ = 9;

/** Detection stamp of a queue row outside the default 30-day excerpt window. */
const OLD_DETECTED = new Date(NOW - 40 * DAY_MS).toISOString();

/** Event id of the excerpt fixture row. */
const OLD_EVENT = 'evt-retention-old';

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the fixtures are planted in and the service serves. */
let dataDir = '';

/** Services started by a case, shut down with the fixture. */
const running: TestService[] = [];

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    ({ root: tempRoot, dataDir } = await makeStoreTree('retention'));
    await mkdir(dataDir, { recursive: true });
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    for (const service of running.splice(0)) {
        await service.shutdown();
    }

    await removeTempTree(tempRoot);
});

/**
 * Build a capturing logger for the drive-only cases.
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

/**
 * Build a complete audit row for a seeded trail.
 *
 * @returns The stored shape `parseAuditEntry` accepts.
 */
function trailRow(seed: {
    /** Sequence number the trim must preserve or remove by rule. */
    readonly seq: number;
    /** RFC 3339 stamp the day window judges. */
    readonly timestamp: string;
    /** Event vocabulary name. */
    readonly eventType: string;
}): Record<string, unknown> {
    return {
        seq: seed.seq,
        timestamp: seed.timestamp,
        correlationId: `chain-${seed.seq}`,
        eventType: seed.eventType,
        actorSource: 'service',
        entity: { kind: 'service', id: 'retention-fixture' },
        decision: null,
        reason: null,
        redaction: { redacted: false, fields: [] },
        details: {},
    };
}

/**
 * Build a complete queue row carrying an excerpt the pass could clear.
 *
 * @param detectedAt - RFC 3339 detection stamp.
 * @returns The stored shape `parseStoredEvent` accepts.
 */
function queueRow(detectedAt: string): Record<string, unknown> {
    return {
        id: OLD_EVENT,
        bindingId: 'bnd-retention-fixture',
        kind: 'assignment',
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat-mt',
        projectId: 'prj_42',
        worktreeOption: 'none',
        issueNumber: 7,
        issueTitle: 'Ticket #7',
        issueUrl: 'https://github.com/acme/widget/issues/7',
        issueBodyExcerpt: 'the issue body this dispatch already carried',
        headSha: null,
        baseRef: null,
        triggerNote: 'Issue assigned to the bound account',
        detectedAt,
        state: 'dispatched',
        claimedAt: null,
        dispatchedAt: detectedAt,
    };
}

/**
 * Plant a three-row trail spanning both retention windows.
 *
 * Row 7 is 40 days old (outside a saved 30-day window, inside the default
 * 180), row 41 is 400 days old (outside both), and row 9 is a day old (inside
 * both).
 *
 * @param target - Store handle whose data directory the fixture is written to.
 */
async function plantMixedTrail(target: ServiceStore): Promise<void> {
    await target.writeLines(AUDIT_FILE, [
        trailRow({
            seq: MIDDLE_SEQ,
            timestamp: new Date(NOW - 40 * DAY_MS).toISOString(),
            eventType: 'service.started',
        }),
        trailRow({ seq: ANCIENT_SEQ, timestamp: new Date(NOW - 400 * DAY_MS).toISOString(), eventType: 'consent' }),
        trailRow({
            seq: FRESH_SEQ,
            timestamp: new Date(NOW - DAY_MS).toISOString(),
            eventType: 'delivery.detected',
        }),
    ]);
}

/**
 * Plant the two rows that sit **inside** the default window, so a case can
 * start from a trail the open pass correctly leaves alone.
 *
 * @param target - Store handle whose data directory the fixture is written to.
 */
async function plantFreshWindowTrail(target: ServiceStore): Promise<void> {
    await target.writeLines(AUDIT_FILE, [
        trailRow({
            seq: MIDDLE_SEQ,
            timestamp: new Date(NOW - 40 * DAY_MS).toISOString(),
            eventType: 'service.started',
        }),
        trailRow({
            seq: FRESH_SEQ,
            timestamp: new Date(NOW - DAY_MS).toISOString(),
            eventType: 'delivery.detected',
        }),
    ]);
}

/**
 * Plant one dispatched queue row older than the default excerpt window.
 *
 * @param target - Store handle whose data directory the fixture is written to.
 */
async function plantQueue(target: ServiceStore): Promise<void> {
    await target.writeJson(EVENTS_FILE, [queueRow(OLD_DETECTED)]);
}

/**
 * The `audit.trimmed` rows a trail holds.
 *
 * @returns The trim rows, in trail order.
 */
function trimRows(trail: readonly AuditEntry[]): readonly AuditEntry[] {
    return trail.filter((entry) => entry.eventType === 'audit.trimmed');
}

/**
 * A poller that answers with nothing.
 *
 * The boundary runs before any binding is walked, so the fixtures never need
 * GitHub — and no test in this file may reach the network (FR-086).
 *
 * @returns The idle poller the drive uses.
 */
function idlePoller(): GitHubIssuePoller {
    return {
        listOpenIssues: async () => ({ kind: 'ok', issues: [] as readonly PollIssue[] }),
        listIssueComments: async () => ({ kind: 'ok', comments: [] }),
        listOpenPulls: async () => ({ kind: 'ok', pulls: [] }),
        listIssueEvents: async () => ({ kind: 'ok', events: [], exhausted: false }),
    };
}

/**
 * Wrap a store so every `config.json` read fails the way a bad disk would.
 *
 * @returns A store whose only difference is that refusal.
 */
function brokenConfigStore(inner: ServiceStore): ServiceStore {
    return {
        ...inner,
        readJson: async <T>(
            path: string,
            validate: (raw: unknown) => T | null,
        ): Promise<JsonReadResult<T>> => {
            if (path === CONFIG_FILE) {
                throw new Error('configuration unreadable');
            }

            return await inner.readJson(path, validate);
        },
    };
}

describe('retention runs at store open (006 T-014, FR-055(a))', () => {
    it('trims an over-limit trail and clears an over-age excerpt before the listener accepts', async () => {
        const seed = await openStore({ dataDir });
        await plantMixedTrail(seed);
        await plantQueue(seed);

        const service = await startTestService({ dataDir });
        running.push(service);
        const { store } = service.handle;
        expect(store).not.toBeNull();
        if (store === null) {
            return;
        }

        const trail = await readAuditEntries(store);
        const trims = trimRows(trail);
        // One row per pass, in the order the boundary runs them, each naming
        // the limit it reached — and neither row claims a removal the other
        // pass made.
        expect(trims).toHaveLength(2);
        expect(trims.map((entry) => entry.details.limitReached)).toEqual(['day-window', 'excerpt-days']);
        expect(trail.some((entry) => entry.seq === ANCIENT_SEQ)).toBe(false);
        expect(trail.some((entry) => entry.seq === FRESH_SEQ)).toBe(true);
        const { log } = capturingLogger();
        const queue = await readEvents({ store, log });
        expect(queue).toHaveLength(1);
        expect(queue[0]?.issueBodyExcerpt).toBe('');
        expect(queue[0]?.excerptTrimmedAt).toBeDefined();
    });
});

describe('a configuration write runs no trim (006 T-014, FR-047, AC-128)', () => {
    it('applies a lowered retention limit at the next cycle boundary, not at the write', async () => {
        {
            const seed = await openStore({ dataDir });
            await plantFreshWindowTrail(seed);
            const service = await startTestService({ dataDir });
            running.push(service);
            const { store } = service.handle;
            expect(store).not.toBeNull();
            if (store === null) {
                return;
            }
            const { log } = capturingLogger();

            // Opened at the default 180-day window: a 40-day-old row is inside it,
            // so the open pass has nothing to take and writes nothing.
            const opened = await readAuditEntries(store);
            expect(trimRows(opened)).toEqual([]);
            expect(opened.some((entry) => entry.seq === MIDDLE_SEQ)).toBe(true);

            // The save lowers the limit; the route runs no pass of its own.
            const put = await service.call(CONFIG_PATH, {
                method: 'PUT',
                body: JSON.stringify({ ...DEFAULT_CONFIG, auditRetentionDays: 30 }),
            });
            expect(put.status).toBe(200);
            const afterWrite = await readAuditEntries(store);
            expect(trimRows(afterWrite)).toEqual([]);
            expect(afterWrite.some((entry) => entry.seq === MIDDLE_SEQ)).toBe(true);
            expect(service.logLines.some((line) => line.includes('trimmed'))).toBe(false);

            // The next boundary is what applies it: the same row is now outside
            // the saved 30-day window and goes, with one row recording the taking.
            await runScanCycle({ store, log, poller: idlePoller() });
            const afterCycle = await readAuditEntries(store);
            const trims = trimRows(afterCycle);
            expect(trims).toHaveLength(1);
            expect(trims[0]?.details.limitReached).toBe('day-window');
            expect(afterCycle.some((entry) => entry.seq === MIDDLE_SEQ)).toBe(false);
            expect(afterCycle.some((entry) => entry.seq === FRESH_SEQ)).toBe(true);
        }
    });

    it('degrades an unreadable configuration at the boundary to the documented defaults', async () => {
        {
            const seed = await openStore({ dataDir });
            await plantMixedTrail(seed);
            const { log, lines } = capturingLogger();

            await runScanCycle({ store: brokenConfigStore(seed), log, poller: idlePoller() });

            expect(lines.some((line) => line.includes('cycle configuration read failed'))).toBe(true);
            // The pass ran at the documented defaults rather than not at all: the
            // 400-day row is outside the default 180-day window and went, while
            // the 40-day row is inside it and stayed.
            const trail = await readAuditEntries(seed);
            expect(trimRows(trail)).toHaveLength(1);
            expect(trail.some((entry) => entry.seq === ANCIENT_SEQ)).toBe(false);
            expect(trail.some((entry) => entry.seq === MIDDLE_SEQ)).toBe(true);
        }
    });

});
