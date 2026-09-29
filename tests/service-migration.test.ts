/** Non-destructive legacy queue adoption into the durable run model (003 T-005). */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_FILE, readAuditEntries } from '../service/audit.ts';
import { createLogger } from '../service/log.ts';
import { createEvent, enqueueEvents, EVENTS_FILE } from '../service/poll/events.ts';
import {
    RUNS_FILE,
    applyResult,
    claimRun,
    ensureRunsAdopted,
    readRunsDocument,
    reserveRun,
} from '../service/poll/runs.ts';
import { openStore } from '../service/store/index.ts';
import type { EventSnapshot } from '../service/poll/events.ts';
import type { ServiceStore } from '../service/store/index.ts';

const STAMP = '2026-09-28T12:00:00.000Z';
const NOW = '2026-09-28T12:30:00.000Z';
const BINDING_ID = 'bnd-migrate';
const SCAN_STATE_FILE = 'scan-state.json';
const MIGRATED_EVENT = 'run.migrated';
const LOG_LINES: string[] = [];
const LOGGER = createLogger({ level: 'error', sink: (line) => LOG_LINES.push(line) });

let tempRoot = '';
let dataDir = '';
let store: ServiceStore;

beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-migration-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
});

afterEach(async () => {
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
        legacyRow({ issueNumber: 5, state: 'dispatched', result: 'session-create-failed' }),
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
        expect(document.runs[1]?.lease?.expiresAt).toBe('2026-09-28T12:29:59.999Z');
        expect(document.runs[2]?.reservation?.reservedAt).toBe(NOW);
        expect(document.runs[2]?.reservation?.resultDeadlineAt).toBe('2026-09-28T12:32:00.000Z');
        expect(document.runs[3]?.session?.sessionId).toBe('ses_preexisting');
        expect(document.runs[4]?.stateReason).toBe('session-create-failed');
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
            leaseId: 'lease-migration-test',
            issuedAt: NOW,
            expiresAt: '2026-09-28T12:35:00.000Z',
            now: NOW,
        };
        const claim = await claimRun(claimInput);
        expect(claim.status).toBe('applied');
        const reservation = await reserveRun({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            leaseId: 'lease-migration-test',
            resultDeadlineAt: '2026-09-28T12:35:00.000Z',
            now: NOW,
        });
        expect(reservation.status).toBe('applied');
        const result = await applyResult({
            store,
            log: LOGGER,
            correlationId: run.correlationId,
            sessionId: 'ses_durable_before_loss',
            problem: null,
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
