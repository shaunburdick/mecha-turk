/**
 * The sweep in the service lifecycle (003 FR-032; T-010).
 *
 * The guarantee is an **ordering** guarantee, not a behaviour one: a claim
 * stranded by a crash or a restart must already be recovered by the time the
 * HTTP listener answers its first claim. Testing that needs a store that
 * predates the process — a seeded `in-flight` legacy row, adopted on the first
 * read — and a service started against it, so the suite seeds one, starts the
 * real loopback service, and only then calls the claim route.
 *
 * The other two properties are structural: the periodic sweep runs on an
 * unref'd timer (an idle process must still be able to exit) and it stops on
 * shutdown with everything else.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { startSweep } from '../service/poll/sweep.ts';
import { openStore } from '../service/store/index.ts';
import { createLogger } from '../service/log.ts';
import type { ClaimedRun } from '../service/poll/claim.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Path of the claim route the panel polls. */
const CLAIM_PATH = '/v1/events/pending';

/** Legacy stamp a pre-run build wrote on its claimed rows. */
const LEGACY_CLAIMED_AT = '2026-09-28T09:00:00.000Z';

const LEGACY_IN_FLIGHT = 'in-flight';
const LEASE_EXPIRED_EVENT = 'dispatch.lease-expired';
const SWEEP_LOG_MESSAGE = 'dispatch sweep recovered a run';

let running: TestService | null = null;
let scratch: string | null = null;

afterEach(async () => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    if (scratch !== null) {
        await rm(scratch, { recursive: true, force: true });
        scratch = null;
    }
});

/**
 * Seed a store in the shipped pre-run vocabulary with one stranded claim.
 *
 * The row is written before the service starts, so the upgraded build adopts
 * it as a `claimed` run holding the synthetic, already-expired migration lease
 * the sweep then recovers (data-model §1).
 *
 * @returns The data directory to start the service against.
 */
async function seedStrandedClaim(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mecha-turk-boot-sweep-'));
    const dataDir = join(root, 'store');
    const store = await openStore({ dataDir });
    await store.writeJson('events.json', [{
        id: 'evt-acme~widget~404~77331',
        bindingId: 'bnd-legacy',
        kind: 'assignment',
        repository: 'acme/widget',
        accountNumericUserId: '77331',
        accountLogin: 'octocat',
        projectId: 'prj_42',
        worktreeOption: 'none',
        issueNumber: 404,
        issueTitle: 'Stranded before the upgrade',
        issueUrl: 'https://github.com/acme/widget/issues/404',
        issueBodyExcerpt: 'body',
        headSha: null,
        baseRef: null,
        triggerNote: 'assigned',
        detectedAt: LEGACY_CLAIMED_AT,
        state: LEGACY_IN_FLIGHT,
        claimedAt: LEGACY_CLAIMED_AT,
        dispatchedAt: null,
        dispatchResult: null,
    }]);

    return dataDir;
}

/** Claim over the running service, returning the run rows it answered with. */
async function claim(service: TestService): Promise<readonly ClaimedRun[]> {
    const response = await service.call(CLAIM_PATH);
    const body: { events: ClaimedRun[] } = await response.json();

    return body.events;
}

/** The harness service's open store; a boot-sweep test cannot run without one. */
function openHarnessStore(instance: TestService): NonNullable<TestService['handle']['store']> {
    if (instance.handle.store === null) {
        throw new Error('the harness service opened no store');
    }

    return instance.handle.store;
}

/** Every lease-expiry row the store holds, in the order they were written. */
async function leaseExpiryRows(store: NonNullable<TestService['handle']['store']>): Promise<readonly unknown[]> {
    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === LEASE_EXPIRED_EVENT);
}

describe('T-010 boot sweep ordering', () => {
    it('recovers a stranded claim before the first claim answer (FR-032)', async () => {
        const dataDir = await seedStrandedClaim();
        running = await startTestService({ dataDir });

        const swept = await running.handle.swept;
        const claimed = await claim(running);
        const store = openHarnessStore(running);

        // The run was adopted as a claimed run holding an expired synthetic
        // lease, and the boot pass put it back to waiting before the listener
        // ever answered a claim.
        expect(swept.recoveries.map((recovery) => recovery.eventType)).toEqual([LEASE_EXPIRED_EVENT]);
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.issueNumber).toBe(404);
        expect(claimed[0]?.lease.expiresAt).not.toBe(LEGACY_CLAIMED_AT);
        const rows = await leaseExpiryRows(store);
        expect(rows).toHaveLength(1);
        expect((rows[0] as { details: { migrationRecovery: boolean } }).details.migrationRecovery).toBe(true);
    });

    it('leaves a live lease alone across a restart, and recovers the same run once', async () => {
        const dataDir = await seedStrandedClaim();
        const first = await startTestService({ dataDir });
        const firstClaim = await claim(first);
        await first.shutdown();

        const second = await startTestService({ dataDir });
        running = second;
        const secondClaim = await claim(second);
        const store = openHarnessStore(second);

        // The first start recovered the stranded claim and the panel then leased
        // it. A restart must not steal a live lease — the panel holding it may
        // be mid-dispatch — so the second boot sweep finds nothing to do and
        // the same run is not offered twice.
        const swept = await second.handle.swept;
        expect(swept.recoveries).toEqual([]);
        expect(secondClaim).toEqual([]);
        const rows = await leaseExpiryRows(store);
        expect(rows).toHaveLength(1);
        expect(rows.map((row) => (row as { correlationId: string }).correlationId))
            .toEqual(firstClaim.map((run) => run.correlationId));
    });
});

describe('T-010 the periodic sweep', () => {
    it('names its recoveries in the service log without any secret', async () => {
        const dataDir = await seedStrandedClaim();
        running = await startTestService({ dataDir });
        await running.handle.swept;

        const recoveries = running.logLines.filter((line) => line.includes(SWEEP_LOG_MESSAGE));

        expect(recoveries).toHaveLength(1);
        expect(recoveries[0]).toContain(LEASE_EXPIRED_EVENT);
        expect(recoveries[0]).not.toContain('octocat');
        expect(recoveries[0]).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
    });

    it('stops on shutdown, leaving the timer to the process exit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'mecha-turk-sweep-timer-'));
        scratch = root;
        const store = await openStore({ dataDir: join(root, 'store') });
        const lines: string[] = [];
        const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });

        const loop = startSweep({ store, log });
        loop.stop();

        // An unref'd timer does not hold the event loop open, so the process
        // would exit here even with the sweep armed; stopping it explicitly is
        // what keeps a shutdown from re-arming one more pass.
        expect(lines).toEqual([]);
    });
});

describe('T-010 a degraded start', () => {
    it('still answers the claim route when the store was unusable', async () => {
        const blocked = await mkdtemp(join(tmpdir(), 'mecha-turk-boot-blocked-'));
        scratch = blocked;
        const blocker = join(blocked, 'blocker');
        await writeFile(blocker, 'i am a file', 'utf8');

        running = await startTestService({ dataDir: join(blocker, 'store') });

        const swept = await running.handle.swept;
        expect(swept.recoveries).toEqual([]);
        const response = await running.call(CLAIM_PATH);
        const body: { error: { code: string } } = await response.json();

        expect(response.status).toBe(503);
        expect(body.error.code).toBe('storage-unavailable');
    });
});
