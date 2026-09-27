/**
 * Audit write-path tests (task T-009n, reviews M6 and W2-2).
 *
 * The trail is append-only NDJSON whose `seq` and consent-idempotency used to
 * be rediscovered by re-reading the whole file on every write — fine for
 * Wave 2's handful of rows, an O(n²) trap for the Wave 4 poller that appends
 * on every tick. These tests pin the fix: one seed per store handle, numbers
 * counted in memory, appends serialized so `seq` stays unique and ordered,
 * and a per-version claim that makes two racing writers produce exactly one
 * consent row (contract §1.2, panel-service §3 invariant 8).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../extension/src/consent.ts';
import { appendAudit, readAuditEntries } from '../extension/service/audit.ts';
import { recordConsentOccurrence } from '../extension/service/consent.ts';
import { openStore } from '../extension/service/store/index.ts';
import type { AuditInput } from '../extension/service/audit.ts';
import type { NdjsonReadResult } from '../extension/service/store/ndjson.ts';
import type { ServiceStore } from '../extension/service/store/index.ts';

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

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-audit-'));
    dataDir = join(tempRoot, 'store');
    await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
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
 * @param store - Store whose `readLines` calls should be counted.
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
 * @param entry - The line to plant, already carrying its own `seq`.
 * @returns The serialized NDJSON line.
 */
function plantedLine(entry: Readonly<Record<string, unknown>>): string {
    return `${JSON.stringify(entry)}\n`;
}

/**
 * Plant a two-row trail written by some earlier process.
 *
 * @param version - Consent version the planted consent row records.
 */
async function plantTrail(version: number): Promise<void> {
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
            details: { version, givenAt: '2026-09-27T00:00:00.000Z' },
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

describe('audit sequence and consent caching (M6, W2-2)', () => {
    it('appends without ever re-reading the audit file', async () => {
        const store = await openStore({ dataDir });
        const reads = countReads(store);

        const first = await appendAudit(store, sampleRow(STARTED_EVENT));
        await recordConsentOccurrence(store, CONSENT_VERSION);
        const third = await appendAudit(store, sampleRow(VERIFIED_EVENT));
        await recordConsentOccurrence(store, CONSENT_VERSION); // replay: no read, no row

        expect(first.seq).toBe(1);
        expect(third.seq).toBe(3);
        // Exactly the seed: three appends and two consent checks, one file read.
        expect(reads.count()).toBe(1);
    });

    it('continues a trail that existed before the store opened', async () => {
        await plantTrail(CONSENT_VERSION);
        const store = await openStore({ dataDir });
        const reads = countReads(store);

        const appended = await appendAudit(store, sampleRow(VERIFIED_EVENT));

        expect(appended.seq).toBe(9);
        expect(reads.count()).toBe(1);

        // The consent version seeded from that trail counts as recorded, so a
        // replay writes nothing and still never touches the file again.
        await recordConsentOccurrence(store, CONSENT_VERSION);
        expect(reads.count()).toBe(1);
        const stored = await readFile(join(dataDir, AUDIT_FILE), 'utf8');
        expect(stored.match(/"eventType":"consent"/g) ?? []).toHaveLength(1);
    });

    it('records exactly one consent row when three claims race (W2-2)', async () => {
        const store = await openStore({ dataDir });

        await Promise.all([
            recordConsentOccurrence(store, CONSENT_VERSION),
            recordConsentOccurrence(store, CONSENT_VERSION),
            recordConsentOccurrence(store, CONSENT_VERSION),
        ]);

        const entries = await readAuditEntries(store);
        const consent = entries.filter((entry) => entry.eventType === 'consent');
        expect(consent).toHaveLength(1);
        expect(consent[0]?.details.version).toBe(CONSENT_VERSION);

        const seqs = entries.map((entry) => entry.seq);
        expect(new Set(seqs).size).toBe(seqs.length);
    });

    it('serializes concurrent appends so seq stays unique and file-ordered', async () => {
        const store = await openStore({ dataDir });

        const written = await Promise.all([
            appendAudit(store, sampleRow(STARTED_EVENT)),
            appendAudit(store, sampleRow(VERIFIED_EVENT)),
            appendAudit(store, sampleRow('account.deleted')),
        ]);

        expect(written.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        const stored = await readAuditEntries(store);
        expect(stored.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    });
});
