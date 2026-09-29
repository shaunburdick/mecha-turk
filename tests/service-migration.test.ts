/**
 * Non-destructive legacy queue adoption into the durable run model (003 T-005),
 * and the full upgrade script the spec's NFR-103/AC-126 promise describes
 * (003 T-030): a store written in the shipped vocabulary — every row shape, the
 * audit trail, the bindings, and the scan windows — booted by the **upgraded
 * service**, then read back over its own wire.
 *
 * Part 1 drives the adoption pass directly, which is the right shape for the
 * mapping rules. T-030 deliberately does not: an operator upgrades by starting
 * the new build against the old files, so this half starts the real loopback
 * service and asserts what the operator would find — every row adopted, every
 * window byte-identical, zero quarantine files, one `run.migrated` per run, the
 * pre-existing problem result rendered `failed` and retryable, dispatched rows
 * still terminal, and the adopted `pending` rows claimable (FR-005, AC-126).
 *
 * Offline by construction: the seeded binding is `disabled`, so the boot scan
 * cycle skips it (no poller, no network), and the seeded account is complete
 * but never re-verified.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_FILE, appendAudit, readAuditEntries } from '../service/audit.ts';
import { createLogger } from '../service/log.ts';
import { createEvent, enqueueEvents, EVENTS_FILE } from '../service/poll/events.ts';
import { reserveDispatch } from '../service/poll/dispatch-authorize.ts';
import { reportDispatch } from '../service/poll/dispatch-report.ts';
import {
    RUNS_FILE,
    claimRun,
    ensureRunsAdopted,
    readRunsDocument,
} from '../service/poll/runs.ts';
import { BINDINGS_PATH } from '../service/routes/bindings.ts';
import { EVENTS_PATH, EVENTS_PENDING_PATH } from '../service/routes/events.ts';
import { RETRY_PATH } from '../service/routes/run-ops.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/handoff.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

const STAMP = '2026-09-28T12:00:00.000Z';
const NOW = '2026-09-28T12:30:00.000Z';
const BINDING_ID = 'bnd-migrate';
const SCAN_STATE_FILE = 'scan-state.json';
/** A panel-minted lease id in the one shape `parseLease` accepts (T-040e). */
const MIGRATION_TEST_LEASE_ID = `lse-${'c'.repeat(24)}`;
const MIGRATED_EVENT = 'run.migrated';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

/** Account numeric id the shipped binding and its credential file share. */
const ACCOUNT_ID = '77331';

/** Store-relative path of the shipped account credential file. */
const ACCOUNT_FILE = `accounts/${ACCOUNT_ID}.json`;

/** Store-relative path of the shipped bindings file (shape unchanged since 002). */
const BINDINGS_FILE = 'bindings.json';

/** Login the shipped binding displays. */
const SHIPPED_LOGIN = 'octocat';

/**
 * Credential the shipped account carries.
 *
 * A fixture value, never a real one, and never printed: the account exists so
 * the binding parses and the store reads as an operator's store would.
 */
const SHIPPED_CREDENTIAL = `upgrade-fixture-credential-${'s'.repeat(24)}`;

/** Header name the POST helper sends, spelled as a computed object key. */
const CONTENT_TYPE_HEADER = 'content-type';

/** The two shipped audit event types the upgrade must retain verbatim. */
const SHIPPED_CONSENT_EVENT = 'consent';
const SHIPPED_ACCOUNT_EVENT = 'account.verified';

/** Correlation identifier one of the inherited audit rows was written on. */
const LEGACY_CORRELATION = `mt-legacy-${'e'.repeat(12)}`;

/** Result string the shipped build stored for a dispatch that made no session. */
const PROBLEM_RESULT = 'session-create-failed';

/** State the shipped build called terminal and 003 still calls terminal. */
const DISPATCHED_STATE = 'dispatched';

/** State a run waits in before any panel claims it. */
const WAITING_STATE = 'pending';

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;
/** The upgraded service T-030 boots, drained before the temp root goes. */
let running: TestService | null = null;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-migration-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
    running = null;
});

afterEach(async () => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    await rm(tempRoot, { recursive: true, force: true });
});

/** Build a complete assignment detection for a migration case. */
function snapshot(issueNumber: number): EventSnapshot {
    return {
        bindingId: BINDING_ID,
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        kind: 'assignment',
        issue: {
            issueNumber,
            issueTitle: `Issue ${issueNumber}`,
            issueUrl: `https://github.com/acme/widget/issues/${issueNumber}`,
            issueBodyExcerpt: '',
        },
        triggerNote: 'assigned to account',
        detectedAt: STAMP,
    };
}

/** Build one legacy assignment row, optionally with old lifecycle fields. */
function legacyRow(input: {
    readonly issueNumber: number;
    readonly state: 'pending' | 'in-flight' | 'dispatched';
    readonly result?: string | null;
}) {
    const { issueNumber, state, result = null } = input;
    return {
        ...createEvent(snapshot(issueNumber)),
        state,
        claimedAt: state === 'in-flight' ? STAMP : null,
        dispatchedAt: state === 'dispatched' ? STAMP : null,
        dispatchResult: result,
    };
}

/** Seed all five documented migration branches, including the synthetic reservation branch. */
async function seedLegacyQueue(): Promise<readonly { readonly id: string }[]> {
    const rows = [
        legacyRow({ issueNumber: 1, state: 'pending' }),
        legacyRow({ issueNumber: 2, state: 'in-flight' }),
        { ...legacyRow({ issueNumber: 3, state: 'in-flight' }), reservation: { reservedAt: STAMP } },
        legacyRow({ issueNumber: 4, state: 'dispatched', result: 'ses_preexisting' }),
        legacyRow({ issueNumber: 5, state: 'dispatched', result: PROBLEM_RESULT }),
        legacyRow({ issueNumber: 6, state: 'dispatched', result: 'unknown-legacy-result' }),
    ];
    await store.writeJson(EVENTS_FILE, rows);

    return rows;
}

describe('runs.json first-read adoption', () => {
    it('maps every legacy branch without changing queue bytes, windows, or quarantine state', async () => {
        const rows = await seedLegacyQueue();
        const legacyBytes = await readFile(join(dataDir, EVENTS_FILE), 'utf8');
        const scanStateBytes = JSON.stringify({ bindings: { [BINDING_ID]: { lastScanAt: STAMP, lastError: null } } });
        await store.writeJson(SCAN_STATE_FILE, JSON.parse(scanStateBytes) as unknown);
        const beforeWindow = await readFile(join(dataDir, SCAN_STATE_FILE), 'utf8');

        expect(await ensureRunsAdopted({ store, log: LOGGER, now: NOW })).toBe('adopted');
        const document = await readRunsDocument({ store, log: LOGGER });
        const audit = await readAuditEntries(store);

        expect(document.runs.map((run) => run.state)).toEqual([
            'pending',
            'claimed',
            'starting',
            'dispatched',
            'failed',
            'dispatched',
        ]);
        // The synthetic lease is already expired **at mint** for every clock
        // that could judge it: it expires with the legacy claim's own window
        // (the earlier of that stamp and the adopting stamp minus a
        // millisecond), never with a stamp only this process has seen (T-045).
        expect(document.runs[1]?.lease?.expiresAt).toBe(STAMP);
        expect(document.runs[2]?.reservation?.reservedAt).toBe(NOW);
        expect(document.runs[2]?.reservation?.resultDeadlineAt).toBe('2026-09-28T12:32:00.000Z');
        expect(document.runs[3]?.session?.sessionId).toBe('ses_preexisting');
        expect(document.runs[4]?.stateReason).toBe(PROBLEM_RESULT);
        expect(document.runs[5]?.state).toBe('dispatched');
        expect(document.runs[5]?.session?.sessionId).toBe('unknown-legacy-result');
        expect(document.runs.map((run) => run.sourceReferences[0]?.deliveryId)).toEqual(
            rows.map((row) => row.id),
        );
        expect(audit.filter((entry) => entry.eventType === MIGRATED_EVENT)).toHaveLength(6);
        expect(audit.filter((entry) => entry.eventType === MIGRATED_EVENT).map((entry) => entry.correlationId))
            .toEqual(document.runs.map((run) => run.correlationId));
        expect(await readFile(join(dataDir, EVENTS_FILE), 'utf8')).toBe(legacyBytes);
        expect(await readFile(join(dataDir, SCAN_STATE_FILE), 'utf8')).toBe(beforeWindow);
        const entries = await readdir(dataDir);
        expect(entries.filter((name) => name.includes('.corrupt-'))).toEqual([]);
    });

    it('is idempotent across a second store handle and never repeats migration audit rows', async () => {
        await seedLegacyQueue();
        await ensureRunsAdopted({ store, log: LOGGER });
        const auditBefore = await readAuditEntries(store);
        const secondStore = await openStore({ dataDir });

        expect(await ensureRunsAdopted({ store: secondStore, log: LOGGER })).toBe('present');
        const auditAfter = await readAuditEntries(secondStore);
        expect(auditAfter).toEqual(auditBefore);
        const document = await secondStore.readJson(RUNS_FILE, (value) => value);
        expect(document.status).toBe('ok');
    });

    it('recovers a migration audit missed after the adopted run document was written', async () => {
        await seedLegacyQueue();
        const interruptedStore: ServiceStore = {
            ...store,
            appendLine: async (path, value) => {
                if (path === AUDIT_FILE) {
                    throw new Error('simulated interruption before migration audit append');
                }

                await store.appendLine(path, value);
            },
        };

        expect(await ensureRunsAdopted({ store: interruptedStore, log: LOGGER, now: NOW })).toBe('adopted');
        const firstRead = await readRunsDocument({ store: interruptedStore, log: LOGGER });
        expect(firstRead.auditIntents).toHaveLength(6);
        const auditBeforeRestart = await readAuditEntries(store);
        expect(auditBeforeRestart.filter((entry) => entry.eventType === MIGRATED_EVENT)).toHaveLength(0);

        const restartedStore = await openStore({ dataDir });
        const recovered = await readRunsDocument({ store: restartedStore, log: LOGGER });
        const auditAfterRestart = await readAuditEntries(restartedStore);
        const migrations = auditAfterRestart.filter((entry) => entry.eventType === MIGRATED_EVENT);

        expect(recovered.auditIntents).toEqual([]);
        expect(migrations).toHaveLength(6);
        expect(migrations.map((entry) => entry.correlationId)).toEqual(
            recovered.runs.map((run) => run.correlationId),
        );
    });

    it('refuses to re-adopt state-free run-linked rows when runs.json was lost', async () => {
        const event = createEvent(snapshot(77));
        const [linked] = await enqueueEvents({ store, log: LOGGER, incoming: [event] });
        const before = await readRunsDocument({ store, log: LOGGER });
        const run = before.runs[0];
        if (linked === undefined || run === undefined) {
            throw new Error('run fixture was not enqueued');
        }

        const claimInput = {
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            holder: 'panel-migration-test',
            leaseId: MIGRATION_TEST_LEASE_ID,
            issuedAt: NOW,
            expiresAt: '2026-09-28T12:35:00.000Z',
            now: NOW,
        };
        const claim = await claimRun(claimInput);
        expect(claim.status).toBe('applied');
        // T-043g: the un-routed second minting site is gone, so the fixture
        // authorizes and spends through the modules the routes call — which is
        // also what makes the assertion below about a *real* durable dispatch.
        const reservation = await reserveDispatch({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            leaseId: MIGRATION_TEST_LEASE_ID,
            attempt: 1,
            now: NOW,
        });
        if (reservation.status !== 'applied') {
            throw new Error(`reserve did not apply: ${reservation.status}`);
        }

        const result = await reportDispatch({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            dispatchToken: reservation.dispatchToken,
            attempt: 1,
            operation: 'result',
            outcome: { attemptOutcome: 'dispatched', sessionId: 'ses_durable_before_loss', reason: null },
            now: NOW,
        });
        expect(result.status).toBe('applied');

        await store.removeFile(RUNS_FILE);
        const restartedStore = await openStore({ dataDir });

        const adoption = await ensureRunsAdopted({ store: restartedStore, log: LOGGER });
        expect(adoption).toBe('unreadable');
        await expect(readRunsDocument({ store: restartedStore, log: LOGGER }))
            .rejects.toThrow('refusing to serve run state');
        await expect(claimRun({ ...claimInput, store: restartedStore })).rejects.toThrow('refusing to serve run state');
        expect(await restartedStore.readJson(RUNS_FILE, (value) => value)).toEqual({ status: 'absent' });
        const finalAudits = await readAuditEntries(restartedStore);
        expect(finalAudits.filter((entry) => entry.eventType === MIGRATED_EVENT)).toHaveLength(0);
        expect(await restartedStore.readJson(EVENTS_FILE, (value) => value)).toMatchObject({ status: 'ok' });
    });
});

/* ------------------------------------------------------------------------- *
 * T-030 — the full upgrade script (FR-005, NFR-103, AC-126)
 * ------------------------------------------------------------------------- */

/** The shipped binding row, in the format the previous release wrote.
 *
 * It is `disabled` on purpose: a binding the boot scan cycle skips is a
 * binding whose scan window the upgrade cannot touch, which is exactly the
 * property AC-126 pins down — and it keeps the suite offline, because an
 * active binding would send the default poller at `api.github.com`.
 *
 * @returns One complete, valid binding record.
 */
function shippedBinding(): Record<string, unknown> {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: SHIPPED_LOGIN,
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: true, reviewRequest: false },
        state: 'disabled',
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/**
 * The shipped account credential file, in the format the previous release wrote.
 *
 * Complete and `active`, so the binding parses and startup reconciliation
 * examines nothing (it only re-verifies `pending_handoff`/`verifying`).
 *
 * @returns One complete, valid stored account.
 */
function shippedAccount(): Record<string, unknown> {
    return {
        numericUserId: ACCOUNT_ID,
        login: SHIPPED_LOGIN,
        expectedLogin: null,
        verifiedAt: STAMP,
        errorReason: null,
        createdAt: STAMP,
        updatedAt: STAMP,
        credential: { token: SHIPPED_CREDENTIAL, kind: 'classic', verifiedAt: STAMP },
        scopeCheck: { checkedAt: STAMP, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
    };
}

/** What the upgrade must not move: the delivery bytes and the window bytes. */
interface ShippedBytes {
    /** `events.json` exactly as the previous release left it. */
    readonly events: string;
    /** `scan-state.json` exactly as the previous release left it. */
    readonly window: string;
}

/**
 * Seed a complete store in the shipped vocabulary: every row shape, the audit
 * trail, the bindings, the account they reference, and the scan windows.
 *
 * @returns The bytes the upgrade is forbidden to rewrite.
 */
async function seedShippedStore(): Promise<ShippedBytes> {
    await seedLegacyQueue();
    const events = await readFile(join(dataDir, EVENTS_FILE), 'utf8');

    await store.writeJson(BINDINGS_FILE, [shippedBinding()]);
    await store.writeJson(ACCOUNT_FILE, shippedAccount());

    const windowDocument = JSON.stringify({
        bindings: { [BINDING_ID]: { lastScanAt: STAMP, lastError: null } },
    });
    await store.writeJson(SCAN_STATE_FILE, JSON.parse(windowDocument) as unknown);
    const window = await readFile(join(dataDir, SCAN_STATE_FILE), 'utf8');

    // Two shipped audit rows, each on its own identifier (FR-052): the
    // upgrade must retain the trail it inherited, not start a new one.
    await appendAudit(store, {
        eventType: SHIPPED_CONSENT_EVENT,
        actorSource: 'panel',
        entity: { kind: 'service', id: 'mecha-turk' },
        reason: 'service capability granted',
    });
    await appendAudit(store, {
        eventType: SHIPPED_ACCOUNT_EVENT,
        actorSource: 'service',
        entity: { kind: 'account', id: ACCOUNT_ID },
        correlationId: LEGACY_CORRELATION,
        reason: 'credential verified',
    });

    return { events, window };
}

/**
 * One wire answer, read as an untrusted record.
 *
 * @param input - The running instance, the path, and an optional JSON body
 *   (sent as a POST when present).
 * @returns The parsed body.
 * @throws {Error} When the route answers anything but `200`.
 */
async function answer(input: {
    /** Running instance to call. */
    readonly service: TestService;
    /** Path to fetch. */
    readonly path: string;
    /** Body to POST, when the operation takes one. */
    readonly body?: Readonly<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
    const init: RequestInit = input.body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { [CONTENT_TYPE_HEADER]: 'application/json' },
            body: JSON.stringify(input.body),
        };
    const response = await input.service.call(input.path, init);
    if (response.status !== 200) {
        throw new Error(`${input.path} answered ${response.status}, expected 200`);
    }

    return await response.json() as Record<string, unknown>;
}

/**
 * The `events` (or `bindings`) member of an answer, as records.
 *
 * @param body - The parsed answer.
 * @param member - Member name to read.
 * @returns Every entry, each read without trusting its shape.
 * @throws {Error} When the member is missing or holds a non-record entry.
 */
function rowsOf(body: Record<string, unknown>, member: string): readonly Record<string, unknown>[] {
    const rows = body[member];
    if (!Array.isArray(rows)) {
        throw new Error(`the answer carried no ${member} member`);
    }

    return rows.map((row) => {
        if (typeof row !== 'object' || row === null || Array.isArray(row)) {
            throw new Error(`the ${member} member held a non-record entry`);
        }

        return row as Record<string, unknown>;
    });
}

/**
 * One string member of a wire row, demanded rather than defaulted.
 *
 * @param row - The row to read.
 * @param key - Member to read.
 * @returns The value as a string.
 * @throws {Error} When the member is absent or not a string.
 */
function textOf(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    if (typeof value !== 'string') {
        throw new Error(`the row carried no string member ${key}`);
    }

    return value;
}

/**
 * The row whose subject is one issue number.
 *
 * @param rows - Run-history or claim rows.
 * @param issueNumber - Subject number to find.
 * @returns The row for that subject.
 * @throws {Error} When no row names that subject.
 */
function rowFor(rows: readonly Record<string, unknown>[], issueNumber: number): Record<string, unknown> {
    const found = rows.find((row) => row.issueNumber === issueNumber);
    if (found === undefined) {
        throw new Error(`no row carries issue ${issueNumber}`);
    }

    return found;
}

describe('T-030 the shipped store boots through the upgraded service (NFR-103, AC-126)', () => {
    it('adopts every row, keeps every window, and quarantines nothing', async () => {
        const seed = await seedShippedStore();
        const service = await startTestService({ dataDir });
        running = service;
        // The boot sweep is awaited before the listener binds (FR-032), so the
        // adoption pass its first run-document read performs has finished.
        await service.handle.swept;

        // Every shipped row is a run now, mapped by the migration table: the
        // stranded `in-flight` row was requeued once as a migration recovery
        // (attempt 1→2), so it waits again instead of holding a dead lease.
        const history = rowsOf(await answer({ service, path: EVENTS_PATH }), 'events');
        expect(history).toHaveLength(6);
        expect(textOf(rowFor(history, 1), 'state')).toBe(WAITING_STATE);
        expect(textOf(rowFor(history, 2), 'state')).toBe(WAITING_STATE);
        expect(rowFor(history, 2).attempt).toBe(2);
        expect(rowFor(history, 2).leaseExpiresAt).toBeNull();
        expect(textOf(rowFor(history, 3), 'state')).toBe('starting');
        expect(textOf(rowFor(history, 4), 'state')).toBe(DISPATCHED_STATE);
        expect(textOf(rowFor(history, 4), 'stateReason')).toContain('ses_preexisting');
        expect(textOf(rowFor(history, 5), 'state')).toBe('failed');
        expect(textOf(rowFor(history, 5), 'stateReason')).toBe(PROBLEM_RESULT);
        expect(textOf(rowFor(history, 6), 'state')).toBe(DISPATCHED_STATE);
        // One run per legacy row, none merged and none invented.
        expect(new Set(history.map((row) => textOf(row, 'correlationId'))).size).toBe(6);

        // The bindings file was read, not dropped or quarantined.
        const bindings = rowsOf(await answer({ service, path: BINDINGS_PATH }), 'bindings');
        expect(bindings.map((row) => row.bindingId)).toEqual([BINDING_ID]);

        // The adopted `pending` rows are claimable; nothing else is offered.
        const claimed = rowsOf(
            await answer({ service, path: `${EVENTS_PENDING_PATH}?holder=panel-upgrade` }),
            'events',
        );
        expect(claimed.map((row) => row.issueNumber).sort((left, right) => Number(left) - Number(right)))
            .toEqual([1, 2]);
        const leased = rowFor(claimed, 1);
        expect(typeof leased.attachmentId).toBe('string');
        expect(leased.lease).toMatchObject({ holder: 'panel-upgrade' });

        // The shipped problem result is a failure now, and a failure retries
        // under the same run key with its references intact (FR-040, FR-041).
        const failed = rowFor(history, 5);
        const retry = await answer({
            service,
            path: RETRY_PATH.replace(':correlationId', textOf(failed, 'correlationId')),
            body: {
                correlationId: failed.correlationId,
                attempt: failed.attempt,
                causeCleared: true,
                causeReport: 'the shipped build recorded this problem as a success',
            },
        });
        expect(retry.state).toBe(WAITING_STATE);
        expect(retry.attempt).toBe(2);
        expect(Array.isArray(failed.sourceReferences)).toBe(true);

        // A terminal row stays terminal: dispatch was reported, so a retry
        // answers its own distinct refusal (FR-041).
        const dispatched = rowFor(history, 4);
        const refused = await service.call(
            RETRY_PATH.replace(':correlationId', textOf(dispatched, 'correlationId')),
            {
                method: 'POST',
                headers: { [CONTENT_TYPE_HEADER]: 'application/json' },
                body: JSON.stringify({ correlationId: dispatched.correlationId, attempt: dispatched.attempt }),
            },
        );
        expect(refused.status).toBe(409);
        const refusalBody = await refused.json() as { error?: { code?: unknown } };
        expect(refusalBody.error?.code).toBe('invalid-transition');

        // Nothing the upgrade read was rewritten, and nothing was quarantined.
        expect(await readFile(join(dataDir, EVENTS_FILE), 'utf8')).toBe(seed.events);
        expect(await readFile(join(dataDir, SCAN_STATE_FILE), 'utf8')).toBe(seed.window);
        const entries = await readdir(dataDir);
        expect(entries.filter((name) => name.includes('.corrupt-'))).toEqual([]);

        // Exactly one adoption row per adopted run, on the run's own id.
        const opened = service.handle.store;
        if (opened === null) {
            throw new Error('the upgraded service opened no store');
        }
        const runs = await readRunsDocument({ store: opened, log: LOGGER });
        const audit = await readAuditEntries(opened);
        const migrated = audit.filter((entry) => entry.eventType === MIGRATED_EVENT);
        expect(migrated).toHaveLength(runs.runs.length);
        expect(migrated.map((entry) => entry.correlationId)).toEqual(runs.runs.map((run) => run.correlationId));

        // The inherited trail is retained: the shipped rows are still there,
        // with the identifiers they were written on (FR-005, FR-052).
        const inherited = audit.filter((entry) => entry.eventType === SHIPPED_CONSENT_EVENT
            || entry.eventType === SHIPPED_ACCOUNT_EVENT);
        expect(inherited.map((entry) => entry.eventType)).toEqual([SHIPPED_CONSENT_EVENT, SHIPPED_ACCOUNT_EVENT]);
        expect(inherited[1]?.correlationId).toBe(LEGACY_CORRELATION);
    });
});
