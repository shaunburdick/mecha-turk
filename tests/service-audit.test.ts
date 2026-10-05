/**
 * Audit write-path tests (task T-009n, reviews M6 and W2-2).
 *
 * The trail is append-only NDJSON whose `seq` used to
 * be rediscovered by re-reading the whole file on every write — fine for
 * Wave 2's handful of rows, an O(n²) trap for the Wave 4 poller that appends
 * on every tick. These tests pin the fix: one seed per store handle, numbers
 * counted in memory, and appends serialized so `seq` stays unique and ordered.
 * (The per-version consent claim this file also used to pin went with the
 * consent gate on 2026-10-01 — 002 v1.9.0 — but the seed still reads every
 * stored line, legacy `consent` rows included, so an existing trail keeps
 * extending without a gap.)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, composeAudit, readAuditEntries, serializeAudit } from '../service/audit.ts';
import { openStore } from '../service/store/index.ts';
import type { AuditEntry, AuditInput } from '../service/audit.ts';
import type { NdjsonReadResult } from '../service/store/ndjson.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { makeStoreTree, removeTempTree } from './support/temp-tree.ts';

/** Store file the audit trail lives in. */
const AUDIT_FILE = 'audit.ndjson';

/** Fixture event names reused across the append cases (sonarjs: one literal). */
const STARTED_EVENT = 'service.started';

/** Event name of the rows the append cases interleave. */
const VERIFIED_EVENT = 'account.verified';

/** Temporary root created per test. */
let tempRoot = '';

/** Absolute data directory the store is opened on. */
let dataDir = '';

/** Per-test setup: a fresh temp store and an empty log. */
beforeEach(async (): Promise<void> => {
    ({ root: tempRoot, dataDir } = await makeStoreTree('audit'));
    await mkdir(dataDir, { recursive: true });
});

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    await removeTempTree(tempRoot);
});

/**
 * Build one audit input for the fixtures (ids only, never credential material).
 *
 * @param eventType - Event vocabulary name.
 * @returns The caller-supplied entry the writer completes.
 */
function sampleRow(eventType: string): AuditInput {
    return { eventType, actorSource: 'service', entity: { kind: 'service', id: 'audit-test' } };
}

/**
 * Count reads of the store's NDJSON files through one open handle.
 *
 * @returns A counter the test asserts against after its writes.
 */
function countReads(store: ServiceStore): { readonly count: () => number } {
    const original = store.readLines.bind(store);
    let reads = 0;
    store.readLines = <T>(relativePath: string, parse: (raw: unknown) => T | null): Promise<NdjsonReadResult<T>> => {
        reads += 1;

        return original(relativePath, parse);
    };

    return { count: () => reads };
}

/**
 * Write a valid audit line directly into the trail (fixtures for "pre-existing").
 *
 * @returns The serialized NDJSON line.
 */
function plantedLine(entry: Readonly<Record<string, unknown>>): string {
    return `${JSON.stringify(entry)}\n`;
}

/**
 * Plant a two-row trail written by some earlier process — the first row is a
 * legacy `consent` entry from a build that still wrote them, so extending an
 * existing trail is asserted against the history a real install carries.
 */
async function plantTrail(): Promise<void> {
    const lines = [
        plantedLine({
            seq: 7,
            timestamp: '2026-09-27T00:00:00.000Z',
            correlationId: 'plant-1',
            eventType: 'consent',
            actorSource: 'panel',
            entity: { kind: 'service', id: 'consent' },
            decision: null,
            reason: null,
            redaction: { redacted: false, fields: [] },
            details: { version: 1, givenAt: '2026-09-27T00:00:00.000Z' },
        }),
        plantedLine({
            seq: 8,
            timestamp: '2026-09-27T00:00:01.000Z',
            correlationId: 'plant-2',
            eventType: STARTED_EVENT,
            actorSource: 'service',
            entity: { kind: 'service', id: 'audit-test' },
            decision: null,
            reason: null,
            redaction: { redacted: false, fields: [] },
            details: {},
        }),
    ];

    await writeFile(join(dataDir, AUDIT_FILE), lines.join(''), 'utf8');
}

describe('audit sequence and chain (M6, W2-2)', () => {
    it('appends without ever re-reading the audit file', async () => {
        {
            const store = await openStore({ dataDir });
            const reads = countReads(store);

            const first = await appendAudit(store, sampleRow(STARTED_EVENT));
            const second = await appendAudit(store, sampleRow(VERIFIED_EVENT));
            const third = await appendAudit(store, sampleRow('account.deleted'));

            expect(first.seq).toBe(1);
            expect(second.seq).toBe(2);
            expect(third.seq).toBe(3);
            // Exactly the seed: three appends, one file read.
            expect(reads.count()).toBe(1);
        }
    });

    it('continues a trail that existed before the store opened', async () => {
        {
            await plantTrail();
            const store = await openStore({ dataDir });
            const reads = countReads(store);

            const appended = await appendAudit(store, sampleRow(VERIFIED_EVENT));

            expect(appended.seq).toBe(9);
            expect(reads.count()).toBe(1);

            // The legacy `consent` row still reads as ordinary history, and no
            // append after the seed touches the file read again.
            const stored = await readFile(join(dataDir, AUDIT_FILE), 'utf8');
            expect(stored.match(/"eventType":"consent"/g) ?? []).toHaveLength(1);
            await appendAudit(store, sampleRow(STARTED_EVENT));
            expect(reads.count()).toBe(1);
        }
    });

    it('serializes concurrent appends so seq stays unique and file-ordered', async () => {
        {
            const store = await openStore({ dataDir });

            const written = await Promise.all([
                appendAudit(store, sampleRow(STARTED_EVENT)),
                appendAudit(store, sampleRow(VERIFIED_EVENT)),
                appendAudit(store, sampleRow('account.deleted')),
            ]);

            expect(written.map((entry) => entry.seq)).toEqual([1, 2, 3]);
            const stored = await readAuditEntries(store);
            expect(stored.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        }
    });

});

/** Let every pending microtask plus one macrotask turn run; never sleeps. */
async function flush(): Promise<void> {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

/** Order markers the serialisation case asserts on; one spelling each. */
const FIRST_START = 'first:start';
const FIRST_END = 'first:end';
const SECOND_RUN = 'second:run';

/**
 * Compare two entries without the wall-clock stamp each one records.
 *
 * @returns The entry with its timestamp replaced by a fixed marker.
 */
function stampless(entry: AuditEntry): AuditEntry {
    return { ...entry, timestamp: 'STAMP' };
}

describe('chain join and entry composer (006 T-011)', () => {
    it('serialises chained tasks so the second starts only after the first settles', async () => {
        {
            const store = await openStore({ dataDir });
            const order: string[] = [];
            let release: (() => void) | undefined;
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- ES2024, not on our target.
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            let markStarted: (() => void) | undefined;
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- ES2024, not on our target.
            const started = new Promise<void>((resolve) => {
                markStarted = resolve;
            });

            const first = serializeAudit(store, async () => {
                order.push(FIRST_START);
                markStarted?.();
                await gate;
                order.push(FIRST_END);

                return 'first';
            });
            const second = serializeAudit(store, async () => {
                order.push(SECOND_RUN);

                return 'second';
            });

            await started;
            await flush();
            // The first task is parked on the gate and the second has not run: it
            // is queued behind the first on the one chain `appendAudit` uses.
            expect(order).toEqual([FIRST_START]);
            release?.();

            expect(await Promise.all([first, second])).toEqual(['first', 'second']);
            expect(order).toEqual([FIRST_START, FIRST_END, SECOND_RUN]);
        }
    });

    it('composes the entry appendAudit would write, without writing a line', async () => {
        {
            const composing = await openStore({ dataDir });
            const appending = await openStore({ dataDir: join(tempRoot, 'appended-store') });
            const input: AuditInput = { ...sampleRow(STARTED_EVENT), correlationId: 'compose-1' };

            const composed = await serializeAudit(composing, async () => await composeAudit(composing, input));
            const appended = await appendAudit(appending, input);

            expect(stampless(composed)).toEqual(stampless(appended));
            expect(composed.seq).toBe(1);
            // The composer wrote nothing — the trail it composed for is still empty.
            expect(await readAuditEntries(composing)).toEqual([]);
            // …and its number is reserved, so the next append cannot reuse it.
            const next = await appendAudit(composing, input);
            expect(next.seq).toBe(2);
        }
    });

    it('runs the writer’s redaction pass over a composed entry', async () => {
        {
            const store = await openStore({ dataDir });
            const input: AuditInput = {
                ...sampleRow(STARTED_EVENT),
                correlationId: 'compose-redacted',
                details: { note: 'credential ghp_1234567890123456789012345678901234' },
            };

            const composed = await serializeAudit(store, async () => await composeAudit(store, input));

            expect(composed.redaction.redacted).toBe(true);
            expect(JSON.stringify(composed)).not.toContain('ghp_');
            expect(JSON.stringify(composed)).toContain('[redacted:github-token-classic]');
        }
    });

});
