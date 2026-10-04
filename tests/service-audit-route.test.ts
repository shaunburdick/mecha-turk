/**
 * The audit read route: `GET /v1/audit` (003 T-017, FR-053, FR-064; contract
 * [run-history-audit.md](../specs/003-dispatch-integrity/contracts/run-history-audit.md) §2).
 *
 * The route exists so an operator can reconstruct one run's history from its
 * correlation identifier alone — so this suite asserts the four properties that
 * claim rests on, from outside, over the real loopback service:
 *
 * - **The filter is a byte-exact string equality.** Run rows (including the
 *   `delivery.detected` rows assigned at enqueue) come back; a poll/credential
 *   row carrying its own identifier never does (FR-052, AC-118); an unknown id
 *   is `200` with zero entries, never a `404` (contract §2).
 * - **Pagination chains.** A 250-row filtered set pages as 100 + 100 + 50 with
 *   `nextCursor` chaining and no duplicate and no gap (contract §4 invariant 3),
 *   and `limit` is clamped into `1…200`, never refused (002 §2.5).
 * - **Entries are the stored rows verbatim.** The read projects nothing and
 *   redacts nothing anew: rows were redaction-passed at write (FR-061).
 * - **Transport rules hold on this path too**: auth before routing (401 with no
 *   route oracle), `405` + `Allow` on a wrong verb, `503 storage-unavailable`
 *   when the trail cannot be read, and `500 response-too-large` — never a
 *   truncation — when a page cannot fit the response cap.
 *
 * Offline: a temp data directory per instance, rows seeded through the real
 * audit writer, no network, no host, no sleeping.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCorrelationId } from '../src/ids.ts';
import { AUDIT_FILE, appendAudit, readAuditEntries } from '../service/audit.ts';
import { createEvent, enqueueEvents } from '../service/poll/events.ts';
import { createLogger } from '../service/log.ts';
import { AUDIT_PATH } from '../service/routes/audit.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** A well-formed run id the route must answer for even with no run behind it. */
const SEEDED_RUN_ID = `mt-run-${'a'.repeat(24)}`;

/** A second well-formed run id, for the unknown-id answer. */
const UNKNOWN_RUN_ID = `mt-run-${'b'.repeat(24)}`;

/** The same seeded id with different case: a filter is a string equality. */
const WRONG_CASE_RUN_ID = SEEDED_RUN_ID.toUpperCase();

/** A non-run row's correlation id: its own, never a run's (FR-052). */
const NON_RUN_ID = newCorrelationId();

/** Rows one page-3 fixture needs beyond the two full pages (100 + 100 + 50). */
const FILTERED_ROWS = 250;

/** Rows the clamp fixture needs to make a 200-row page observable. */
const CLAMP_ROWS = 205;

/** Fat detail characters, × enough rows to cross the response cap. */
const FAT_DETAIL_CHARS = 6_000;

/** Rows the size-guard fixture needs to cross `RESPONSE_BODY_MAX_CHARS`. */
const FAT_ROWS = 50;

/** Binding, repository, and account the fixture detection names. */
const BINDING_ID = 'bnd-audit-route';
const REPOSITORY = 'acme/audit-route';
const ACCOUNT_ID = '77331';

/** Bearer prefix every request below carries. */
const BEARER = 'Bearer ';

/** A method no route declares, for the `405` assertion. */
const WRONG_METHOD = 'PATCH';

/** Log lines the fixture logger keeps out of the test output. */
const LOG_LINES: string[] = [];

/** Logger every direct store call in this suite reports through. */
const LOGGER: ServiceLogger = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

/** One answer, with its status and parsed body. */
interface AuditAnswer {
    /** HTTP status. */
    readonly status: number;
    /** Parsed body, read as an untrusted record. */
    readonly json: {
        /** Rows this answer carries, verbatim. */
        readonly entries: AuditEntry[];
        /** Where the next page starts, or `null` at the end of the set. */
        readonly nextCursor: number | null;
        /** How many rows this answer carries. */
        readonly count: number;
    };
    /** Response text, for the credential and echo scans. */
    readonly text: string;
}

let tempRoot = '';
let dataDir = '';
let running: TestService | null = null;
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-audit-route-'));
    dataDir = join(tempRoot, 'store');
    LOG_LINES.length = 0;
    running = null;
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

/**
 * Start a service against this fixture's data directory.
 *
 * @param options - Pass `unreadableTrail` to plant a trail the store cannot read.
 * @returns The running instance, with its store handle open for seeding.
 */
async function startServiceForTest(options: { readonly unreadableTrail?: boolean } = {}): Promise<TestService> {
    if (options.unreadableTrail === true) {
        // A directory where the NDJSON trail belongs: the file exists, so the
        // reader reports "cannot be read" (`StorageUnavailableError`) rather
        // than the absence a missing file would be — which is the 503 case.
        await mkdir(join(dataDir, AUDIT_FILE), { recursive: true });
    }

    const service = await startTestService({ dataDir });
    running = service;
    const opened = service.handle.store;
    if (opened === null) {
        throw new Error('the harness store is unavailable');
    }

    store = opened;

    return service;
}

/**
 * Read `GET /v1/audit` with whatever query the caller names.
 *
 * @param service - The running instance to call.
 * @param query - Query string without the leading `?`; `''` for none.
 * @returns The status, parsed body, and raw text.
 */
async function readAudit(service: TestService, query: string): Promise<AuditAnswer> {
    const response = await service.call(`${AUDIT_PATH}${query === '' ? '' : `?${query}`}`);
    const text = await response.text();

    return {
        status: response.status,
        json: JSON.parse(text) as AuditAnswer['json'],
        text,
    };
}

/**
 * Seed audit rows through the real writer, so every row is redaction-passed.
 *
 * @param input - The correlation id the rows carry, how many, and any row
 *   members that differ from the default run-scoped lifecycle row.
 * @returns The stored entries, in the order they were appended.
 */
async function seedRows(input: {
    /** Correlation id every seeded row carries. */
    readonly correlationId: string;
    /** How many rows to append. */
    readonly count: number;
    /** Detail members folded into every row. */
    readonly details?: Readonly<Record<string, unknown>>;
    /** Row members that differ from the default; `entity` and id are fixed. */
    readonly row?: {
        /** Vocabulary name, when the fixture row is not a lifecycle row. */
        readonly eventType?: string;
        /** Who caused the event, when it differs from the panel. */
        readonly actorSource?: string;
        /** Decision the row records, when it records one. */
        readonly decision?: string | null;
        /** Secret-free reason text. */
        readonly reason?: string | null;
    };
}): Promise<readonly AuditEntry[]> {
    const rows: AuditEntry[] = [];
    for (let index = 0; index < input.count; index += 1) {
        rows.push(await appendAudit(store, {
            eventType: 'dispatch.reserved',
            actorSource: 'panel',
            entity: { kind: 'run', id: input.correlationId },
            correlationId: input.correlationId,
            reason: `fixture row ${index}`,
            ...(input.row ?? {}),
            details: { ...(input.details ?? {}), fixture: index },
        }));
    }

    return rows;
}

/**
 * The one detection this suite's real run is enqueued from.
 *
 * @returns A complete assignment snapshot.
 */
function detection(): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: REPOSITORY,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber: 9,
            issueTitle: 'Audit route fixture',
            issueUrl: `https://github.com/${REPOSITORY}/issues/9`,
            issueBodyExcerpt: '',
        },
        actorLogin: 'alice',
        actorAttribution: 'subject-author',
        triggerNote: 'assigned',
        detectedAt: '2026-09-28T12:00:00.000Z',
    };
}

/**
 * Enqueue one delivery so a real run exists, and return its correlation id.
 *
 * @returns The service-minted correlation id of the run the enqueue created.
 * @throws {Error} When the enqueue produced no run.
 */
async function seededRunId(): Promise<string> {
    const before = await readAuditEntries(store);
    await enqueueEvents({ store, log: LOGGER, incoming: [createEvent(detection())] });
    const entries = await readAuditEntries(store);
    const created = entries.find((entry) => entry.eventType === 'run.created' && !before.includes(entry));
    if (created === undefined) {
        throw new Error('the fixture run was not enqueued');
    }

    return created.correlationId;
}

describe('T-017 the correlation filter is a byte-exact string equality', () => {
    it('returns every run row, includes the detection rows, and never a non-run row', async () => {
        {
            const service = await startServiceForTest();
            const correlationId = await seededRunId();
            const dispatchRows = await seedRows({ correlationId, count: 2 });
            // A credential-verification row: its own identifier, and the delivery
            // identifiers it concerns, exactly as FR-052 requires of non-run rows.
            await appendAudit(store, {
                eventType: 'account.verified',
                actorSource: 'service',
                entity: { kind: 'account', id: 'acct_fixture' },
                correlationId: NON_RUN_ID,
                reason: 'fixture credential verification',
                details: { deliveryIds: ['evt-acme~audit-route~9~77331'] },
            });

            const filtered = await readAudit(service, `correlationId=${correlationId}`);
            expect(filtered.status).toBe(200);
            // Every run-scoped row the store holds under this id — the creation
            // row, the detection row (assigned at enqueue), and the two seeded —
            // comes back, and nothing else does.
            const stored = await readAuditEntries(store);
            const expected = stored.filter((entry) => entry.correlationId === correlationId);
            expect(filtered.json.entries).toEqual(expected);
            expect(filtered.json.count).toBe(expected.length);
            expect(expected.length).toBeGreaterThanOrEqual(dispatchRows.length + 2);
            expect(filtered.json.entries.every((entry) => entry.correlationId === correlationId)).toBe(true);
            expect(filtered.json.entries.some((entry) => entry.eventType === 'account.verified')).toBe(false);
            expect(filtered.json.entries.some((entry) => entry.eventType === 'delivery.detected')).toBe(true);

            const all = await readAudit(service, '');
            expect(all.status).toBe(200);
            expect(all.json.entries.some((entry) => entry.correlationId === NON_RUN_ID)).toBe(true);
            // The non-run row keeps its own id *and* names the delivery it concerns.
            const nonRun = all.json.entries.find((entry) => entry.correlationId === NON_RUN_ID);
            expect(nonRun?.entity.kind).toBe('account');
            expect(nonRun?.details.deliveryIds).toEqual(['evt-acme~audit-route~9~77331']);
        }
    });

    it('answers an unknown id with 200 and zero entries, and never widens a near-miss', async () => {
        {
            const service = await startServiceForTest();
            await seedRows({ correlationId: SEEDED_RUN_ID, count: 3 });

            const unknown = await readAudit(service, `correlationId=${UNKNOWN_RUN_ID}`);
            expect(unknown.status).toBe(200);
            expect(unknown.json.entries).toEqual([]);
            expect(unknown.json.count).toBe(0);
            expect(unknown.json.nextCursor).toBeNull();

            // Not a derivation and not a prefix match: `MT-RUN-…` is a different
            // string, so it matches nothing (FR-051's byte-identical values).
            const wrongCase = await readAudit(service, `correlationId=${WRONG_CASE_RUN_ID}`);
            expect(wrongCase.status).toBe(200);
            expect(wrongCase.json.entries).toEqual([]);

            // A *present* filter is narrowed to it and nothing else: a blank value
            // matches nothing rather than widening into a read of the whole trail.
            const blank = await readAudit(service, 'correlationId=');
            expect(blank.status).toBe(200);
            expect(blank.json.entries).toEqual([]);
            expect(blank.json.count).toBe(0);

            // Byte-exact means byte-exact: one padded space is a different string.
            const padded = await readAudit(service, `correlationId=%20${SEEDED_RUN_ID}`);
            expect(padded.status).toBe(200);
            expect(padded.json.entries).toEqual([]);
        }
    });

});

describe('T-017 pagination chains with no duplicate and no gap', () => {
    it('pages a 250-row filtered set as 100 + 100 + 50 behind nextCursor', async () => {
        const service = await startServiceForTest();
        const seeded = await seedRows({ correlationId: SEEDED_RUN_ID, count: FILTERED_ROWS });
        // Rows under another id must never appear in the filtered pages.
        await seedRows({ correlationId: UNKNOWN_RUN_ID, count: 5 });

        const first = await readAudit(service, `correlationId=${SEEDED_RUN_ID}&limit=100`);
        expect(first.status).toBe(200);
        expect(first.json.count).toBe(100);
        expect(first.json.nextCursor).toBe(seeded[99]?.seq ?? null);

        const second = await readAudit(
            service,
            `correlationId=${SEEDED_RUN_ID}&limit=100&cursor=${String(first.json.nextCursor)}`,
        );
        expect(second.status).toBe(200);
        expect(second.json.count).toBe(100);
        expect(second.json.nextCursor).toBe(seeded[199]?.seq ?? null);

        const third = await readAudit(
            service,
            `correlationId=${SEEDED_RUN_ID}&limit=100&cursor=${String(second.json.nextCursor)}`,
        );
        expect(third.status).toBe(200);
        expect(third.json.count).toBe(50);
        expect(third.json.nextCursor).toBeNull();

        const paged = [...first.json.entries, ...second.json.entries, ...third.json.entries];
        const seqs = paged.map((entry) => entry.seq);
        expect(new Set(seqs).size).toBe(FILTERED_ROWS);
        expect([...seqs].toSorted((left, right) => left - right)).toEqual(seqs);
        expect(paged.map((entry) => entry.seq)).toEqual(seeded.map((entry) => entry.seq));
        expect(paged.every((entry) => entry.correlationId === SEEDED_RUN_ID)).toBe(true);
    });
});

describe('T-017 limit is clamped, never refused', () => {
    it('takes the default, clamps both bounds, and treats a word as the default', async () => {
        {
            const service = await startServiceForTest();
            await seedRows({ correlationId: SEEDED_RUN_ID, count: CLAMP_ROWS });

            const absent = await readAudit(service, `correlationId=${SEEDED_RUN_ID}`);
            expect(absent.status).toBe(200);
            expect(absent.json.count).toBe(100);

            const overMax = await readAudit(service, `correlationId=${SEEDED_RUN_ID}&limit=1000`);
            expect(overMax.status).toBe(200);
            expect(overMax.json.count).toBe(200);

            const underMin = await readAudit(service, `correlationId=${SEEDED_RUN_ID}&limit=0`);
            expect(underMin.status).toBe(200);
            expect(underMin.json.count).toBe(1);

            const nonsense = await readAudit(service, `correlationId=${SEEDED_RUN_ID}&limit=lots`);
            expect(nonsense.status).toBe(200);
            expect(nonsense.json.count).toBe(100);
        }
    });

    it('refuses a cursor that is no sequence number, naming the field and not its value', async () => {
        {
            const service = await startServiceForTest();
            await seedRows({ correlationId: SEEDED_RUN_ID, count: 3 });

            const refused = await readAudit(service, 'cursor=not-a-seq');

            expect(refused.status).toBe(422);
            const body = JSON.parse(refused.text) as {
                error?: { code?: string; issues?: readonly {
                    readonly field?: string; readonly remediation?: string }[] };
            };
            expect(body.error?.code).toBe('validation');
            expect(body.error?.issues?.map((issue) => issue.field)).toContain('cursor');
            // SEC-11: the received value never reaches the answer.
            expect(refused.text).not.toContain('not-a-seq');
        }
    });

});

describe('T-017 the transport rules hold on the audit path', () => {
    it('answers a page that cannot fit the response cap with response-too-large, never a truncation', async () => {
        {
            const service = await startServiceForTest();
            await seedRows({
                correlationId: SEEDED_RUN_ID,
                count: FAT_ROWS,
                details: { blob: 'x'.repeat(FAT_DETAIL_CHARS) },
            });

            const oversized = await readAudit(service, `correlationId=${SEEDED_RUN_ID}&limit=200`);

            // Contract §2: the guard measures and answers; it never ships half a row.
            expect(oversized.status).toBe(500);
            expect(JSON.parse(oversized.text)).toMatchObject({ error: { code: 'response-too-large' } });

            // A page that fits still answers normally, so the guard is a bound and
            // not a broken route.
            const small = await readAudit(service, `correlationId=${SEEDED_RUN_ID}&limit=1`);
            expect(small.status).toBe(200);
            expect(small.json.count).toBe(1);
        }
    });

    it('requires the bearer token before routing, with no route oracle', async () => {
        {
            const service = await startServiceForTest();

            const missing = await fetch(`${service.baseUrl}${AUDIT_PATH}`);
            const wrong = await fetch(`${service.baseUrl}${AUDIT_PATH}`, {
                headers: { authorization: `${BEARER}wrong-wrong-wrong-wrong` },
            });
            const invented = await fetch(`${service.baseUrl}/v1/audit-not-a-route`);

            expect(missing.status).toBe(401);
            expect(wrong.status).toBe(401);
            expect(invented.status).toBe(401);
            const missingText = await missing.text();
            expect(await wrong.text()).toBe(missingText);
            expect(await invented.text()).toBe(missingText);
        }
    });

    it('answers a wrong verb with 405 and an Allow header naming GET', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call(AUDIT_PATH, { method: WRONG_METHOD });

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET');
            const body = (await response.json()) as { error?: { code?: string } };
            expect(body.error?.code).toBe('method-not-allowed');
        }
    });

    it('answers an unreadable trail with 503 storage-unavailable, not a 500', async () => {
        {
            const service = await startServiceForTest({ unreadableTrail: true });

            const response = await service.call(AUDIT_PATH);
            const body = (await response.json()) as { error?: { code?: string } };

            expect(response.status).toBe(503);
            expect(body.error?.code).toBe('storage-unavailable');
        }
    });

});

describe('T-017 entries come back as stored, projected by nothing', () => {
    it('returns the stored row verbatim, with the whole documented member set', async () => {
        {
            const service = await startServiceForTest();
            const [seeded] = await seedRows({
                correlationId: SEEDED_RUN_ID,
                count: 1,
                row: { reason: 'the operator retried after the cause cleared' },
            });
            if (seeded === undefined) {
                throw new Error('the fixture row was not seeded');
            }

            const answer = await readAudit(service, `correlationId=${SEEDED_RUN_ID}`);

            expect(answer.json.entries).toEqual([seeded]);
            expect(Object.keys(answer.json.entries[0] ?? {})).toEqual([
                'seq',
                'timestamp',
                'correlationId',
                'eventType',
                'actorSource',
                'entity',
                'decision',
                'reason',
                'redaction',
                'details',
            ]);
            // Nothing is re-redacted on the way out: rows were redaction-passed at
            // write (FR-061), so an unchanged marker is the honest answer.
            expect(answer.json.entries[0]?.redaction).toEqual({ redacted: false, fields: [] });
            expect(answer.json.entries[0]?.details.fixture).toBe(0);
        }
    });

    it('sees a row appended after the last answer, with no repair step in between', async () => {
        {
            // The trail this route reads is the same file the writer appends to —
            // no second copy, no derived index — so a row appended after the last
            // answer is visible to the next one without any repair step.
            const service = await startServiceForTest();
            await seedRows({ correlationId: SEEDED_RUN_ID, count: 1 });
            const before = await readAudit(service, `correlationId=${SEEDED_RUN_ID}`);
            expect(before.json.count).toBe(1);

            await seedRows({ correlationId: SEEDED_RUN_ID, count: 1 });
            const after = await readAudit(service, `correlationId=${SEEDED_RUN_ID}`);

            expect(after.json.count).toBe(2);
            expect(after.json.entries[0]?.seq).toBe(before.json.entries[0]?.seq);
        }
    });

});
