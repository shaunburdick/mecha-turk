/**
 * The sweep in the service lifecycle (003 FR-032; T-010, hardened by T-045).
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
 *
 * **T-045 (de-flake).** The restart test failed once with an *unexpected
 * migration recovery*: the second boot recovered a lease the first boot should
 * have left alone. The cause was not the restart — it was a **clock race in
 * the service**. `sweepOnce` resolved its stamp into a local but handed the
 * *unresolved* input to its document read, so the read's first-read adoption
 * sampled its own, later `nowIso()`; the synthetic lease was minted as
 * `thatSample - 1`, which makes "already expired" self-referential. When the
 * millisecond ticked between the two samples, the pass judged a lease expiring
 * in its own future as live, answered zero recoveries cleanly, and left the
 * run in `claimed` — where the claim correctly refuses it. The recovery then
 * landed on the next boot, which reads as a live lease being touched.
 * Reproduced under four parallel workers of this suite. Two changes close it,
 * and this file asserts both:
 *
 * - the service adopts under the pass's own stamp **and** mints the synthetic
 *   lease as the earlier of the legacy claim's window and that stamp minus a
 *   millisecond, so the lease is expired for any clock that could judge it
 *   (`sweep.ts`, `runs-adopt.ts`);
 * - every precondition of boot 1 is asserted **before** the restart, with the
 *   first boot's log lines attached to any failure, so a degraded first boot
 *   names itself instead of masquerading as a second-boot defect;
 * - the fixture {@link FIXTURE_PATH} captures the failing input shape and is
 *   driven through `sweepOnce` with an injected stamp (no real time);
 * - the assertion the flake broke — "the second boot recovers nothing" — is
 *   unchanged and unweakened.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuditEntries } from '../service/audit.ts';
import { createLogger } from '../service/log.ts';
import { startSweep, sweepOnce } from '../service/poll/sweep.ts';
import { openStore } from '../service/store/index.ts';
import { asRecord, parseJsonObject } from '../src/json.ts';
import type { ClaimedRun } from '../service/poll/claim.ts';
import type { SweepOutcome } from '../service/poll/sweep.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Path of the claim route the panel polls. */
const CLAIM_PATH = '/v1/events/pending';

/** The captured failing input shape: a legacy row plus a stale sweep stamp. */
const FIXTURE_PATH = resolve(import.meta.dirname, 'fixtures/t045-stale-sweep-clock.json');

/** Store file the seed writes; boot 1's first read adopts it. */
const EVENTS_FILE = 'events.json';

/** Store file adoption creates; it must not exist before boot 1. */
const RUNS_FILE = 'runs.json';

/** The lease duration a claim on a default config hands out (T-008). */
const DEFAULT_LEASE_MS = 120_000;

const LEASE_EXPIRED_EVENT = 'dispatch.lease-expired';
const MIGRATION_RECOVERY_REASON = 'lease expired on migration recovery after upgrade';
const SWEEP_LOG_MESSAGE = 'dispatch sweep recovered a run';

/** The captured failing input: one legacy row and the pass's own stale stamp. */
interface SweepClockFixture {
    /** Why this input is the shape that failed (T-045). */
    readonly description: string;
    /** The clock sample the failing pass judged the adopted lease with. */
    readonly sweepNow: string;
    /** The shipped-shape legacy row the store is seeded with. */
    readonly legacyRow: { readonly claimedAt: string } & Record<string, unknown>;
}

/**
 * Read and validate the T-045 fixture, refusing anything else.
 *
 * A fixture that cannot be understood must fail the suite here rather than
 * silently seed a different store than the one that reproduced the defect.
 *
 * @returns The captured failing input.
 */
function sweepClockFixture(): SweepClockFixture {
    const root = parseJsonObject(readFileSync(FIXTURE_PATH, 'utf8'));
    const row = asRecord(root?.legacyRow);
    const sweepNow = root?.sweepNow;
    const claimedAt = row?.claimedAt;
    if (root === null || row === null || typeof sweepNow !== 'string' || typeof claimedAt !== 'string') {
        throw new Error(`the T-045 fixture is unusable: ${FIXTURE_PATH}`);
    }

    return { description: String(root.description ?? ''), sweepNow, legacyRow: { ...row, claimedAt } };
}

/** Legacy stamp the pre-run build wrote on its claimed rows (from the fixture). */
const LEGACY_CLAIMED_AT: string = sweepClockFixture().legacyRow.claimedAt;

let running: TestService | null = null;
let scratch: string | null = null;

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork1 = async (): Promise<void> => {
    if (running !== null) {
        await running.shutdown();
        running = null;
    }

    if (scratch !== null) {
        await rm(scratch, { recursive: true, force: true });
        scratch = null;
    }
};

afterEach(afterEachWork1);

/**
 * Seed the store from the fixture, then assert the shape a first boot needs.
 *
 * The assertions are the *seeding order* T-045 asks for: exactly one shipped
 * row, and no run document yet. Anything else — a half-written seed, or a
 * `runs.json` from an earlier boot — fails here, before a service is started,
 * instead of surfacing as a recovery on the wrong boot.
 *
 * @returns The data directory to start the service against.
 */
async function seedStrandedClaim(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mecha-turk-boot-sweep-'));
    scratch = root;
    const dataDir = join(root, 'store');
    const store = await openStore({ dataDir });
    await store.writeJson(EVENTS_FILE, [sweepClockFixture().legacyRow]);

    const seeded = await store.readJson(EVENTS_FILE, (raw) => (Array.isArray(raw) ? raw : null));
    expect(seeded.status, 'the legacy queue must be seeded before any service opens the store').toBe('ok');
    const runs = await store.readJson(RUNS_FILE, (raw) => raw);
    expect(runs.status, 'runs.json must not exist before the first boot adopts').toBe('absent');

    return dataDir;
}

/**
 * Claim over the running service, refusing an answer that is not a run list.
 *
 * The original helper read `body.events` unchecked, so a degraded service
 * answered `undefined` that later assertions reported far from its cause —
 * the misdirection T-045's precondition assertions exist to end.
 *
 * @param service - The running service to claim against.
 * @returns The run rows it answered with.
 */
async function claim(service: TestService): Promise<readonly ClaimedRun[]> {
    const response = await service.call(CLAIM_PATH);
    const body: { events?: ClaimedRun[] } = await response.json();
    if (!Array.isArray(body.events)) {
        throw new Error(`claim answered no run list (status ${response.status}): ${JSON.stringify(body)}`);
    }

    return body.events;
}

/**
 * The harness service's open store; a boot-sweep test cannot run without one.
 *
 * @param instance - The running service.
 * @returns Its store handle.
 */
function openHarnessStore(instance: TestService): NonNullable<TestService['handle']['store']> {
    if (instance.handle.store === null) {
        throw new Error('the harness service opened no store');
    }

    return instance.handle.store;
}

/**
 * Every lease-expiry row the store holds, in the order they were written.
 *
 * @param store - Store to read the trail from.
 * @returns The `dispatch.lease-expired` rows.
 */
async function leaseExpiryRows(store: NonNullable<TestService['handle']['store']>): Promise<readonly unknown[]> {
    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === LEASE_EXPIRED_EVENT);
}

/**
 * Everything a failed precondition should print: the boot's own sweep outcome,
 * what it answered the claim, and every line it logged.
 *
 * @param input - The first boot under assertion.
 * @returns A diagnostic string for the assertion message.
 */
function bootDiagnostics(input: {
    /** The boot being asserted. */
    readonly service: TestService;
    /** What its boot sweep reports. */
    readonly swept: SweepOutcome;
    /** What its claim route answered. */
    readonly claim: readonly ClaimedRun[];
}): string {
    return JSON.stringify({
        swept: { recoveries: input.swept.recoveries.length, auditWritten: input.swept.auditWritten },
        claim: input.claim.map((run) => ({ correlationId: run.correlationId, lease: run.lease })),
        log: input.service.logLines,
    }, null, 1);
}

describe('T-010 boot sweep ordering', () => {
    it('recovers a stranded claim before the first claim answer', async () => {
        {
            const dataDir = await seedStrandedClaim();
            running = await startTestService({ dataDir });

            const swept = await running.handle.swept;
            const claimed = await claim(running);
            const store = openHarnessStore(running);
            const before = bootDiagnostics({ service: running, swept, claim: claimed });

            // The run was adopted as a claimed run holding an expired synthetic
            // lease, and the boot pass put it back to waiting before the listener
            // ever answered a claim.
            expect(swept.recoveries.map((recovery) => recovery.eventType), before).toEqual([LEASE_EXPIRED_EVENT]);
            expect(swept.auditWritten, before).toBe(true);
            expect(claimed, before).toHaveLength(1);
            expect(claimed[0]?.issueNumber).toBe(404);
            expect(claimed[0]?.lease.expiresAt).not.toBe(LEGACY_CLAIMED_AT);
            const rows = await leaseExpiryRows(store);
            expect(rows).toHaveLength(1);
            expect((rows[0] as { details: { migrationRecovery: boolean } }).details.migrationRecovery).toBe(true);
        }
    });

    it('leaves a live lease alone across a restart, and recovers the same run once', async () => {
        {
            const dataDir = await seedStrandedClaim();
            const first = await startTestService({ dataDir });

            // Boot 1's outcome is a precondition, asserted **before** the restart:
            // a first boot that silently degraded (store refused, boot pass threw)
            // would leave the legacy row un-recovered, and the run it then adopted
            // would look, on the next boot, like a live lease being recovered as
            // migration recovery — which is exactly the failure T-045 root-caused.
            const firstSwept = await first.handle.swept;
            const firstClaim = await claim(first);
            const before = bootDiagnostics({ service: first, swept: firstSwept, claim: firstClaim });
            expect(firstSwept.recoveries.map((recovery) => recovery.eventType), before).toEqual([LEASE_EXPIRED_EVENT]);
            expect(firstSwept.auditWritten, before).toBe(true);
            expect(firstClaim, before).toHaveLength(1);
            expect(firstClaim[0]?.correlationId, before).toMatch(/^mt-run-[0-9a-f]{24}$/);
            // The lease the restart must not touch is live for the whole configured
            // duration, asserted as stamp arithmetic rather than as "the test ran
            // fast enough" — the service clock is the only clock in the comparison.
            const lease = firstClaim[0]?.lease;
            expect(
                Date.parse(String(lease?.expiresAt)) - Date.parse(String(lease?.issuedAt)),
                before,
            ).toBe(DEFAULT_LEASE_MS);
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
        }
    });

});

describe('T-045 the pass adopts under the stamp it judges with', () => {
    it('recovers the migration lease it mints, whatever clock the pass sampled', async () => {
        const fixture = sweepClockFixture();
        const root = await mkdtemp(join(tmpdir(), 'mecha-turk-sweep-stamp-'));
        scratch = root;
        const dataDir = join(root, 'store');
        const store = await openStore({ dataDir });
        await store.writeJson(EVENTS_FILE, [fixture.legacyRow]);
        const lines: string[] = [];
        const log = createLogger({ level: 'debug', sink: (line) => lines.push(line) });

        // The captured failing input: a pass whose stamp is injected, on a
        // store no one has read yet, so the read adopts. Adoption must mint the
        // synthetic lease under *this* stamp — with a stamp sampled by the
        // adoption itself, a pass from any earlier moment judges that lease as
        // live, answers zero recoveries, and defers the one-shot recovery to a
        // later pass (the reported defect).
        const outcome = await sweepOnce({ store, log, now: fixture.sweepNow });

        expect(outcome.recoveries, JSON.stringify({ log: lines })).toHaveLength(1);
        const [recovery] = outcome.recoveries;
        expect(recovery?.eventType).toBe(LEASE_EXPIRED_EVENT);
        expect(recovery?.reason).toBe(MIGRATION_RECOVERY_REASON);
        expect(recovery?.details.migrationRecovery).toBe(true);
        expect(recovery?.priorState).toBe('claimed');
        // The lease expires with the legacy claim's own window — the earlier of
        // that stamp and one millisecond before the pass's stamp — so it reads
        // as expired to a pass from *any* moment, including one whose clock
        // sample predates this mint (the shape that failed).
        expect(recovery?.details.leaseExpiry).toBe(String(fixture.legacyRow.claimedAt));
        expect(outcome.auditWritten, JSON.stringify({ log: lines })).toBe(true);
        const rows = await leaseExpiryRows(store);
        expect(rows).toHaveLength(1);
        expect((rows[0] as { details: { migrationRecovery: boolean } }).details.migrationRecovery).toBe(true);
    });
});

describe('T-010 the periodic sweep', () => {
    it('names its recoveries in the service log without any secret', async () => {
        {
            const dataDir = await seedStrandedClaim();
            running = await startTestService({ dataDir });
            await running.handle.swept;

            const recoveries = running.logLines.filter((line) => line.includes(SWEEP_LOG_MESSAGE));

            expect(recoveries).toHaveLength(1);
            expect(recoveries[0]).toContain(LEASE_EXPIRED_EVENT);
            expect(recoveries[0]).not.toContain('octocat');
            expect(recoveries[0]).not.toMatch(/gh[pousr]_[A-Za-z0-9]{16,}/);
        }
    });

    it('stops on shutdown, leaving the timer to the process exit', async () => {
        {
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
        }
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
