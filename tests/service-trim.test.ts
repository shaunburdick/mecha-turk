/**
 * The audit retention pass over `audit.ndjson` (006 T-012; FR-055, FR-056,
 * FR-053, FR-073; AC-138, AC-146, SC-114; 002 FR-035, 003 FR-052).
 *
 * Every case here drives one pass against a **seeded trail on a temp directory
 * with an injected clock** — no network, no real waiting, no live host — and
 * asserts the two properties a destructive pass is worth most:
 *
 * 1. **What it refuses to do.** No protected row is ever removed, at any age
 *    and at any cap; `seq` is never renumbered; a rewrite that fails leaves the
 *    file byte-identical with no `audit.trimmed` row; a pass with nothing to
 *    remove writes nothing at all.
 * 2. **What it does.** Oldest-first removal of exactly the unprotected rows,
 *    one `audit.trimmed` row in the same rewrite, the trail at or below
 *    `auditMaxEntries` *including* that row, and a trail whose protected set
 *    exceeds the cap left over-cap **and explained**.
 *
 * The seeded fixture carries **all eighteen** 003 event types in one
 * correlation chain, so the opener/outcome/hop rule is exercised against the
 * real vocabulary rather than a paraphrase of it, and a second fixture runs
 * the same chain in the order a dispatched run actually writes it — detection,
 * creation, claim, reserve, result, read-back — because that is the chronology
 * in which the final-state row is *not* the chain's last row (003 FR-065).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAccount } from '../service/accounts/store.ts';
import { appendAudit, AUDIT_FILE, readAuditEntries } from '../service/audit.ts';
import { trimAudit } from '../service/audit-trim.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { openStore } from '../service/store/index.ts';
import type { Account } from '../service/accounts/model.ts';
import type { AuditEntityKind, AuditEntry } from '../service/audit.ts';
import type { ServiceConfig } from '../service/config.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/verify.ts';

/** Injected service clock: every fixture ages against this instant. */
const NOW = Date.parse('2026-09-30T00:00:00.000Z');

/** Well outside the default 180-day window. */
const LONG_AGO = '2025-01-01T00:00:00.000Z';

/** Comfortably inside the default window. */
const RECENT = '2026-09-29T00:00:00.000Z';

/** Numeric id of the account the store still holds. */
const LIVE_ACCOUNT_ID = '77331';

/** Numeric id of an account the store no longer holds. */
const GONE_ACCOUNT_ID = '99999';

/** Binding id the stored bindings document still lists. */
const LIVE_BINDING_ID = 'bnd-trim-live';

/** Binding id the stored bindings document no longer lists. */
const GONE_BINDING_ID = 'bnd-trim-gone';

/** GitHub login of the fixture account (display only, never a credential). */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Fixture credential — never a real one, and never expected anywhere. */
const FIXTURE_TOKEN = 'fixture-token-not-a-real-credential';

/** Fixture creation stamp. */
const CREATED_AT = '2026-09-01T00:00:00.000Z';

/** Vocabulary the trim row itself carries (002's reserved name). */
const TRIM_EVENT = 'audit.trimmed';

/** The correlation id of the chain carrying all eighteen 003 event types. */
const CHAIN_RUN = 'chain-run';

/** The correlation id of the chronologically ordered dispatched-run chain. */
const CHAIN_CHRONOLOGICAL = 'chain-chronological';

/** Decision rows FR-056(d) protects outright. */
const CONFIG_CHANGED = 'config.changed';

/** Subject rows FR-056(c) protects while the subject exists. */
const ACCOUNT_VERIFIED = 'account.verified';
const BINDING_DISABLED = 'binding.disabled';

/** The ordinary, trimmable rows the fixtures seed. */
const SERVICE_STARTED = 'service.started';
const DELIVERY_DETECTED = 'delivery.detected';

/** The limit a day-window trim names on its row. */
const DAY_WINDOW = 'day-window';

/** Vocabulary the chronology fixture spells out more than once. */
const RUN_CREATED = 'run.created';

/** The row that records a run's final state, session, and failure reason. */
const DISPATCH_RESULT = 'dispatch.result';

/** The warn-only read-back that lands *after* the final state. */
const AGENT_VERIFIED = 'agent.verified';

/**
 * The eighteen 003 event types, seeded into one correlation chain so the
 * opener/outcome rule runs against the real vocabulary (plan X4).
 *
 * `agent.uncompared` sits where the spec's table puts it — between the two
 * other read-back rows and the refusal row — so the chain's latest run-scoped
 * row is still `dispatch.refused`, and the hop axis still lands on
 * `run.dead_lettered`: a warn-only verification records no state whether or not
 * a comparison happened (003 v1.7.0), so it must stay out of
 * `STATE_TRANSITION_EVENTS`.
 */
const EIGHTEEN_RUN_TYPES: readonly string[] = [
    RUN_CREATED,
    'run.coalesced',
    'run.migrated',
    'dispatch.reserved',
    'dispatch.claimed',
    DISPATCH_RESULT,
    'dispatch.duplicate-report',
    'dispatch.abandoned',
    'dispatch.lease-expired',
    'dispatch.unconfirmed',
    'dispatch.retry',
    'dispatch.resolved',
    'run.blocked',
    'run.dead_lettered',
    AGENT_VERIFIED,
    'agent.mismatch',
    'agent.uncompared',
    'dispatch.refused',
];

/** Temporary root created per test. */
let tempRoot = '';

/** Absolute data directory the store opens on. */
let dataDir = '';

/** Open store handle the cases plant and trim through. */
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-trim-'));
    dataDir = join(tempRoot, 'store');
    await mkdir(dataDir, { recursive: true });
    store = await openStore({ dataDir });
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

/**
 * Build a capturing logger, so a pass's own line can be asserted.
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

/** Inputs one seeded trail row is built from. */
interface RowSeed {
    /** Sequence number, which a trim must never renumber. */
    readonly seq: number;
    /** Event vocabulary name. */
    readonly eventType: string;
    /** Correlation id; chains are grouped on it. */
    readonly correlationId: string;
    /** RFC 3339 timestamp the day window judges. */
    readonly timestamp: string;
    /** Entity kind; defaults to `service`. */
    readonly entityKind?: AuditEntityKind;
    /** Entity id; defaults to the event name. */
    readonly entityId?: string;
}

/**
 * Build one complete, parseable trail row.
 *
 * @param seed - What distinguishes this row.
 * @returns The stored shape `parseAuditEntry` accepts.
 */
function trailRow(seed: RowSeed): Record<string, unknown> {
    return {
        seq: seed.seq,
        timestamp: seed.timestamp,
        correlationId: seed.correlationId,
        eventType: seed.eventType,
        actorSource: 'service',
        entity: { kind: seed.entityKind ?? 'service', id: seed.entityId ?? seed.eventType },
        decision: null,
        reason: null,
        redaction: { redacted: false, fields: [] },
        details: {},
    };
}

/**
 * Plant a trail written by some earlier process.
 *
 * @param rows - The rows, in the order the file should hold them.
 */
async function plantTrail(rows: readonly Record<string, unknown>[]): Promise<void> {
    await store.writeLines(AUDIT_FILE, rows);
}

/**
 * The configuration one pass runs on, with any knob overridden.
 *
 * @param overrides - Knobs to move off their documented defaults.
 * @returns A complete configuration document.
 */
function configWith(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
    return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Build the stored account the live subject rows point at.
 *
 * @returns A complete account record carrying a fixture credential.
 */
function fixtureAccount(): Account {
    return {
        numericUserId: LIVE_ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        displayName: null,
        startingPrompt: null,
        credential: { token: FIXTURE_TOKEN, kind: 'classic', verifiedAt: CREATED_AT },
        scopeCheck: { checkedAt: CREATED_AT, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
        verifiedAt: CREATED_AT,
        errorReason: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

/**
 * Store the two subjects FR-056(c) protects while they exist.
 */
async function plantSubjects(): Promise<void> {
    await writeAccount(store, fixtureAccount());
    await store.writeJson('bindings.json', [{ bindingId: LIVE_BINDING_ID }]);
}

/**
 * Read the trail back, parsed.
 *
 * @returns Every usable row, in file order.
 */
async function storedTrail(): Promise<readonly AuditEntry[]> {
    return await readAuditEntries(store);
}

/**
 * The `audit.trimmed` rows the trail currently holds.
 *
 * @returns The trim rows, oldest first.
 */
async function trimRows(): Promise<readonly AuditEntry[]> {
    const trail = await storedTrail();

    return trail.filter((entry) => entry.eventType === TRIM_EVENT);
}

describe('audit trim: the protected set survives (006 T-012, AC-146, SC-114)', () => {
    it('removes only unprotected rows, oldest first, across all eighteen 003 event types', async () => {
        {
            await plantSubjects();
            // Chain A: an opener that is not itself run-scoped, the eighteen
            // lifecycle types in the middle, and the outcome last.
            const chain = EIGHTEEN_RUN_TYPES.map((eventType, index) =>
                trailRow({ seq: index + 2, eventType, correlationId: CHAIN_RUN, timestamp: LONG_AGO }),);
            const rows = [
                trailRow({ seq: 1, eventType: DELIVERY_DETECTED, correlationId: CHAIN_RUN, timestamp: LONG_AGO }),
                ...chain,
                trailRow({ seq: 20, eventType: CONFIG_CHANGED, correlationId: 'chain-config', timestamp: LONG_AGO }),
                trailRow({ seq: 21, eventType: 'policy.decision', correlationId: 'chain-policy', timestamp: LONG_AGO }),
                trailRow({
                    seq: 22,
                    eventType: ACCOUNT_VERIFIED,
                    correlationId: 'chain-account',
                    timestamp: LONG_AGO,
                    entityKind: 'account',
                    entityId: LIVE_ACCOUNT_ID,
                }),
                trailRow({
                    seq: 23,
                    eventType: BINDING_DISABLED,
                    correlationId: 'chain-binding',
                    timestamp: LONG_AGO,
                    entityKind: 'binding',
                    entityId: LIVE_BINDING_ID,
                }),
                trailRow({ seq: 24, eventType: SERVICE_STARTED, correlationId: 'chain-service', timestamp: LONG_AGO }),
                trailRow({ seq: 25, eventType: 'consent', correlationId: 'chain-consent', timestamp: LONG_AGO }),
                trailRow({ seq: 26, eventType: DELIVERY_DETECTED, correlationId: 'chain-plain', timestamp: LONG_AGO }),
                trailRow({ seq: 27, eventType: 'poll.observation', correlationId: 'chain-fresh', timestamp: RECENT }),
                trailRow({
                    seq: 28,
                    eventType: 'account.deleted',
                    correlationId: 'chain-gone',
                    timestamp: LONG_AGO,
                    entityKind: 'account',
                    entityId: GONE_ACCOUNT_ID,
                }),
                // A chain whose opener is run-scoped and only row: it is both.
                trailRow({ seq: 29, eventType: RUN_CREATED, correlationId: 'chain-solo', timestamp: LONG_AGO }),
            ];
            await plantTrail(rows);
            expect(new Set(rows.map((row) => String(row.eventType))).size).toBeGreaterThanOrEqual(19);

            const outcome = await trimAudit({ store, log: capturingLogger().log, config: configWith(), now: NOW });

            // Nineteen rows went: the fifteen middle lifecycle rows that are
            // neither the opener, the outcome, the final hop, nor the creation
            // row, plus the four unprotected aged rows. Nothing protected, nothing
            // fresh.
            expect(outcome.removed).toBe(19);
            expect(outcome.limitReached).toBe(DAY_WINDOW);
            expect(outcome.minimalReferencesPreserved).toBe(9);
            const trail = await storedTrail();
            expect(trail.map((entry) => entry.seq)).toEqual([1, 2, 15, 19, 20, 21, 22, 23, 27, 29, 30]);
            // Survivors keep their original numbers — a trim never renumbers — and
            // the row it appended is the only one carrying the trim vocabulary.
            expect(trail.filter((entry) => entry.eventType === TRIM_EVENT).map((entry) => entry.seq)).toEqual([30]);
            // Every run chain keeps its opener **and** its outcome, sharing one id,
            // plus the hop that recorded the final state and the creation row.
            const chainRows = trail.filter((entry) => entry.correlationId === CHAIN_RUN);
            expect(chainRows.map((entry) => entry.seq)).toEqual([1, 2, 15, 19]);
            expect(chainRows[0]?.eventType).toBe(DELIVERY_DETECTED);
            expect(chainRows[1]?.eventType).toBe(RUN_CREATED);
            expect(chainRows[2]?.eventType).toBe('run.dead_lettered');
            expect(chainRows[3]?.eventType).toBe('dispatch.refused');
            // The row records exactly what it took, by seq, and why.
            const [trimmed] = await trimRows();
            expect(trimmed).toBeDefined();
            expect(trimmed?.details).toEqual({
                entriesRemoved: 19,
                oldestSeq: 3,
                newestSeq: 28,
                limitReached: DAY_WINDOW,
                minimalReferencesPreserved: 9,
                malformedLinesDropped: 0,
            });
            expect(trimmed?.decision).toBe('trimmed');
            expect(trimmed?.actorSource).toBe('service');
            expect(trimmed?.entity).toEqual({ kind: 'service', id: 'configuration' });
            expect(trimmed?.reason).toContain(DAY_WINDOW);
        }
    });

    it('keeps a chronologically ordered run\'s final-state row and creation row', async () => {
        {
            // The order a dispatched run really writes in: detection opens the
            // chain, the run is created, the panel claims and reserves, the result
            // records the final state (and its reason), and only afterwards does
            // the warn-only read-back land. The chain's latest run-scoped row is
            // therefore *not* the row that carries the outcome, which is the case
            // a fixture ordered by vocabulary name never reached (003 FR-065).
            const chronology = [
                DELIVERY_DETECTED,
                RUN_CREATED,
                'dispatch.claimed',
                'dispatch.reserved',
                DISPATCH_RESULT,
                AGENT_VERIFIED,
            ];
            await plantTrail(
                chronology.map((eventType, index) =>
                    trailRow({ seq: index + 1, eventType, correlationId: CHAIN_CHRONOLOGICAL, timestamp: LONG_AGO }),),
            );

            const outcome = await trimAudit({ store, log: capturingLogger().log, config: configWith(), now: NOW });

            // Four survive — opener, creation, final state, warn-only tail — and
            // exactly the two middle observations go: a chain whose outcome *is*
            // its latest row still loses its middle, so the wider protection is
            // the final-state row and the subject, not the whole chain.
            expect(outcome.removed).toBe(2);
            expect(outcome.limitReached).toBe(DAY_WINDOW);
            expect(outcome.minimalReferencesPreserved).toBe(4);
            const chronological = await storedTrail();
            const chain = chronological.filter((entry) => entry.correlationId === CHAIN_CHRONOLOGICAL);
            expect(chain.map((entry) => entry.seq)).toEqual([1, 2, 5, 6]);
            expect(chain.map((entry) => entry.eventType)).toEqual([
                DELIVERY_DETECTED,
                RUN_CREATED,
                DISPATCH_RESULT,
                AGENT_VERIFIED,
            ]);
            const [trimmed] = await trimRows();
            expect(trimmed).toBeDefined();
            expect(trimmed?.details).toEqual({
                entriesRemoved: 2,
                oldestSeq: 3,
                newestSeq: 4,
                limitReached: DAY_WINDOW,
                minimalReferencesPreserved: 4,
                malformedLinesDropped: 0,
            });
        }
    });

    it('protects account and binding rows only while their subject still exists', async () => {
        {
            await plantSubjects();
            await plantTrail([
                trailRow({
                    seq: 1,
                    eventType: ACCOUNT_VERIFIED,
                    correlationId: 'chain-live-account',
                    timestamp: LONG_AGO,
                    entityKind: 'account',
                    entityId: LIVE_ACCOUNT_ID,
                }),
                trailRow({
                    seq: 2,
                    eventType: BINDING_DISABLED,
                    correlationId: 'chain-live-binding',
                    timestamp: LONG_AGO,
                    entityKind: 'binding',
                    entityId: LIVE_BINDING_ID,
                }),
                trailRow({
                    seq: 3,
                    eventType: 'account.deleted',
                    correlationId: 'chain-gone-account',
                    timestamp: LONG_AGO,
                    entityKind: 'account',
                    entityId: GONE_ACCOUNT_ID,
                }),
                trailRow({
                    seq: 4,
                    eventType: BINDING_DISABLED,
                    correlationId: 'chain-gone-binding',
                    timestamp: LONG_AGO,
                    entityKind: 'binding',
                    entityId: GONE_BINDING_ID,
                }),
            ]);
            const { log } = capturingLogger();

            const first = await trimAudit({ store, log, config: configWith(), now: NOW });

            expect(first.removed).toBe(2);
            expect(first.minimalReferencesPreserved).toBe(2);
            const afterFirstPass = await storedTrail();
            expect(afterFirstPass.map((entry) => entry.seq)).toEqual([1, 2, 5]);

            // The subject goes away: its row is no longer a minimal reference and
            // the next pass removes it, exactly as 002's data model describes.
            await rm(join(dataDir, 'accounts', `${LIVE_ACCOUNT_ID}.json`));
            await store.writeJson('bindings.json', []);

            const second = await trimAudit({ store, log, config: configWith(), now: NOW });

            expect(second.removed).toBe(2);
            expect(second.minimalReferencesPreserved).toBe(0);
            const trail = await storedTrail();
            // Only the two trim rows remain: neither subject's references do.
            expect(trail.map((entry) => entry.seq)).toEqual([5, 6]);
            expect(
                trail.filter((entry) => entry.entity.kind === 'account' || entry.entity.kind === 'binding'),
            ).toEqual([]);
        }
    });

    it('writes nothing when both limits are satisfied', async () => {
        {
            const rows = [
                trailRow({ seq: 1, eventType: SERVICE_STARTED, correlationId: 'chain-fresh', timestamp: RECENT }),
                trailRow({ seq: 2, eventType: DELIVERY_DETECTED, correlationId: 'chain-fresh-2', timestamp: RECENT }),
            ];
            await plantTrail(rows);
            const before = await readFile(join(dataDir, AUDIT_FILE), 'utf8');

            const outcome = await trimAudit({
                store,
                log: capturingLogger().log,
                config: configWith(),
                now: NOW,
            });

            expect(outcome).toEqual({ removed: 0, limitReached: null, minimalReferencesPreserved: 0 });
            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).toBe(before);
            expect(await trimRows()).toEqual([]);
        }
    });

});

describe('audit trim: the entry cap (006 T-012, FR-055)', () => {
    it('lands the trail at or below auditMaxEntries, counting its own trim row', async () => {
        {
            await plantTrail(
                Array.from({ length: 10 }, (_, index) =>
                    trailRow({
                        seq: index + 1,
                        eventType: SERVICE_STARTED,
                        correlationId: `chain-${index}`,
                        timestamp: RECENT,
                    }),),
            );

            const outcome = await trimAudit({
                store,
                log: capturingLogger().log,
                config: configWith({ auditMaxEntries: 5 }),
                now: NOW,
            });

            expect(outcome.removed).toBe(6);
            expect(outcome.limitReached).toBe('entry-cap');
            const trail = await storedTrail();
            expect(trail).toHaveLength(5);
            expect(trail.map((entry) => entry.seq)).toEqual([7, 8, 9, 10, 11]);
            const afterCapPass = await trimRows();
            expect(afterCapPass.map((entry) => entry.seq)).toEqual([11]);
        }
    });

    it('stays at the cap on a second pass instead of oscillating one row per cycle', async () => {
        {
            await plantTrail(
                Array.from({ length: 10 }, (_, index) =>
                    trailRow({
                        seq: index + 1,
                        eventType: SERVICE_STARTED,
                        correlationId: `chain-${index}`,
                        timestamp: RECENT,
                    }),),
            );
            const { log } = capturingLogger();
            const config = configWith({ auditMaxEntries: 5 });
            await trimAudit({ store, log, config, now: NOW });
            const afterFirst = await readFile(join(dataDir, AUDIT_FILE), 'utf8');

            const second = await trimAudit({ store, log, config, now: NOW });

            // Exactly at the cap: nothing to remove, so nothing is written.
            expect(second.removed).toBe(0);
            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).toBe(afterFirst);
            expect(await trimRows()).toHaveLength(1);
        }
    });

    it('never removes a protected row to satisfy a cap, and records the excess', async () => {
        {
            const protectedRows = Array.from({ length: 8 }, (_, index) =>
                trailRow({
                    seq: index + 1,
                    eventType: index % 2 === 0 ? CONFIG_CHANGED : 'policy.decision',
                    correlationId: `chain-decisions-${index}`,
                    timestamp: LONG_AGO,
                }),);
            const trimmable = Array.from({ length: 4 }, (_, index) =>
                trailRow({
                    seq: index + 9,
                    eventType: SERVICE_STARTED,
                    correlationId: `chain-ordinary-${index}`,
                    // Fresh rows: only the cap can take them, so the row records
                    // `entry-cap` rather than the day window that did not trip.
                    timestamp: RECENT,
                }),);
            await plantTrail([...protectedRows, ...trimmable]);

            const outcome = await trimAudit({
                store,
                log: capturingLogger().log,
                config: configWith({ auditMaxEntries: 5 }),
                now: NOW,
            });

            expect(outcome.removed).toBe(4);
            expect(outcome.minimalReferencesPreserved).toBe(8);
            const trail = await storedTrail();
            // Nine rows for a cap of five: the protected set is the difference,
            // and every decision row is still there with its original `seq`.
            expect(trail.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 13]);
            const [trimmed] = await trimRows();
            expect(trimmed?.details.minimalReferencesPreserved).toBe(8);
            expect(trimmed?.details.limitReached).toBe('entry-cap');
        }
    });

    it('does not oscillate when the protected set sits exactly at the cap', async () => {
        {
            // Six protected rows for a cap of six: after the first pass the trail
            // is those six plus the record of the removal, so the previous
            // `audit.trimmed` row is the *only* row a cap-driven walk can still
            // reach. Taking it to make room for the row that would record the
            // taking is a rewrite every cycle forever, and it destroys the one
            // thing that explains the trail's own seq gaps.
            const protectedRows = Array.from({ length: 6 }, (_, index) =>
                trailRow({
                    seq: index + 1,
                    eventType: CONFIG_CHANGED,
                    correlationId: `chain-at-cap-${index}`,
                    timestamp: LONG_AGO,
                }),);
            const trimmable = Array.from({ length: 5 }, (_, index) =>
                trailRow({
                    seq: index + 7,
                    eventType: SERVICE_STARTED,
                    correlationId: `chain-at-cap-ordinary-${index}`,
                    timestamp: RECENT,
                }),);
            await plantTrail([...protectedRows, ...trimmable]);
            const { log } = capturingLogger();
            const config = configWith({ auditMaxEntries: 6 });

            const first = await trimAudit({ store, log, config, now: NOW });

            expect(first.removed).toBe(5);
            expect(first.limitReached).toBe('entry-cap');
            expect(first.minimalReferencesPreserved).toBe(6);
            const afterFirst = await readFile(join(dataDir, AUDIT_FILE), 'utf8');

            const second = await trimAudit({ store, log, config, now: NOW });

            // Protected-at-cap settles: no removal, no row, byte-identical file.
            expect(second.removed).toBe(0);
            expect(second.limitReached).toBeNull();
            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).toBe(afterFirst);
            expect(await trimRows()).toHaveLength(1);
        }
    });

    it('ages a previous trim row out under the day window while the cap leaves it alone', async () => {
        {
            const protectedRows = Array.from({ length: 4 }, (_, index) =>
                trailRow({
                    seq: index + 1,
                    eventType: CONFIG_CHANGED,
                    correlationId: `chain-window-${index}`,
                    timestamp: LONG_AGO,
                }),);
            const staleTrim = trailRow({
                seq: 5,
                eventType: TRIM_EVENT,
                correlationId: 'chain-window-trim',
                timestamp: LONG_AGO,
            });
            await plantTrail([...protectedRows, staleTrim]);

            // The cap never trips, so the only limit that can take the old record
            // is the day window — and it does. Cap-exempt is not age-exempt.
            const outcome = await trimAudit({ store, log: capturingLogger().log, config: configWith(), now: NOW });

            expect(outcome.removed).toBe(1);
            expect(outcome.limitReached).toBe(DAY_WINDOW);
            expect(outcome.minimalReferencesPreserved).toBe(4);
            const trail = await storedTrail();
            expect(trail.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 6]);
            const rows = await trimRows();
            expect(rows.map((entry) => entry.seq)).toEqual([6]);
            expect(rows[0]?.details).toMatchObject({ entriesRemoved: 1, limitReached: DAY_WINDOW });
        }
    });

    it('writes nothing at all when every row is protected, however far over the cap', async () => {
        {
            const rows = Array.from({ length: 6 }, (_, index) =>
                trailRow({
                    seq: index + 1,
                    eventType: CONFIG_CHANGED,
                    correlationId: `chain-${index}`,
                    timestamp: LONG_AGO,
                }),);
            await plantTrail(rows);
            const before = await readFile(join(dataDir, AUDIT_FILE), 'utf8');

            const outcome = await trimAudit({
                store,
                log: capturingLogger().log,
                config: configWith({ auditMaxEntries: 2 }),
                now: NOW,
            });

            // Nothing was removed, so nothing is recorded: a row describing a
            // removal that did not happen would be worse than no row (FR-053).
            expect(outcome.removed).toBe(0);
            expect(outcome.minimalReferencesPreserved).toBe(6);
            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).toBe(before);
            expect(await trimRows()).toEqual([]);
        }
    });

});

describe('audit trim: durability (006 T-012, FR-053, FR-055)', () => {
    it('leaves the file byte-identical and appends no row when the rewrite fails', async () => {
        {
            await plantTrail([
                trailRow({ seq: 1, eventType: SERVICE_STARTED, correlationId: 'chain-a', timestamp: LONG_AGO }),
                trailRow({ seq: 2, eventType: 'consent', correlationId: 'chain-b', timestamp: LONG_AGO }),
            ]);
            const before = await readFile(join(dataDir, AUDIT_FILE), 'utf8');
            const failing: ServiceStore = {
                ...store,
                writeLines: () => Promise.reject(new Error('disk full')),
            };

            await expect(
                trimAudit({ store: failing, log: capturingLogger().log, config: configWith(), now: NOW }),
            ).rejects.toThrow('disk full');

            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).toBe(before);
            expect(await trimRows()).toEqual([]);
        }
    });

    it('never renumbers seq across two consecutive passes', async () => {
        {
            await plantTrail(
                Array.from({ length: 12 }, (_, index) =>
                    trailRow({
                        seq: index + 1,
                        eventType: SERVICE_STARTED,
                        correlationId: `chain-${index}`,
                        timestamp: RECENT,
                    }),),
            );
            const { log } = capturingLogger();
            const config = configWith({ auditMaxEntries: 8 });

            const first = await trimAudit({ store, log, config, now: NOW });
            expect(first.removed).toBe(5);
            const trailAfterFirst = await storedTrail();
            const afterFirst = trailAfterFirst.map((entry) => entry.seq);
            expect(afterFirst).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);

            const second = await trimAudit({ store, log, config, now: NOW });
            expect(second.removed).toBe(0);
            const trailAfterSecond = await storedTrail();
            const afterSecond = trailAfterSecond.map((entry) => entry.seq);
            expect(afterSecond).toEqual(afterFirst);

            // A later append still continues the trail's own sequence.
            expect(Math.max(...afterSecond)).toBe(13);
        }
    });

    it('serializes with an append so a row written meanwhile survives the rewrite', async () => {
        {
            await plantTrail(
                Array.from({ length: 6 }, (_, index) =>
                    trailRow({
                        seq: index + 1,
                        eventType: SERVICE_STARTED,
                        correlationId: `chain-${index}`,
                        timestamp: RECENT,
                    }),),
            );
            const { log } = capturingLogger();
            const config = configWith({ auditMaxEntries: 4 });

            // The append starts while the pass is working its way through the
            // chain; whichever side of the rewrite it lands on, neither the row nor
            // the removals can consume the other (FR-055's serialization clause).
            const appending = appendAudit(store, {
                eventType: ACCOUNT_VERIFIED,
                actorSource: 'service',
                entity: { kind: 'account', id: LIVE_ACCOUNT_ID },
            });
            const outcome = await trimAudit({ store, log, config, now: NOW });
            await appending;

            expect(outcome.removed).toBeGreaterThanOrEqual(3);
            const trail = await storedTrail();
            expect(trail.some((entry) => entry.eventType === ACCOUNT_VERIFIED)).toBe(true);
            expect(trail.some((entry) => entry.eventType === TRIM_EVENT)).toBe(true);
            const seqs = trail.map((entry) => entry.seq);
            expect(new Set(seqs).size).toBe(seqs.length);
        }
    });

    it('records unreadable lines it erases, and leaves them alone when it does not trim', async () => {
        {
            const rows = [
                trailRow({ seq: 1, eventType: SERVICE_STARTED, correlationId: 'chain-torn-a', timestamp: LONG_AGO }),
                trailRow({ seq: 2, eventType: SERVICE_STARTED, correlationId: 'chain-torn-b', timestamp: LONG_AGO }),
            ];
            // A torn write: valid JSON up to the cut, nothing after it. The reader
            // counts the line and skips it; a rewrite would take it for good.
            const torn = '{"seq":9,"timestamp":"2026-0';
            await writeFile(
                join(dataDir, AUDIT_FILE),
                `${rows.map((row) => JSON.stringify(row)).join('\n')}\n${torn}\n`,
                'utf8',
            );
            const { log, lines } = capturingLogger();

            // A pass that removes nothing rewrites nothing, so the torn line is
            // still on disk — and the read that skipped it already warned.
            const idle = await trimAudit({ store, log, config: configWith({ auditRetentionDays: 3_650 }), now: NOW });
            expect(idle.removed).toBe(0);
            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).toContain(torn);
            expect(lines.some((line) => line.includes('unreadable lines'))).toBe(true);

            // The pass that *does* rewrite carries the count onto the row that
            // describes it, so the drop is auditable instead of silent.
            const outcome = await trimAudit({ store, log, config: configWith(), now: NOW });
            expect(outcome.removed).toBe(2);
            const [trimmed] = await trimRows();
            expect(trimmed?.details).toEqual({
                entriesRemoved: 2,
                oldestSeq: 1,
                newestSeq: 2,
                limitReached: DAY_WINDOW,
                minimalReferencesPreserved: 0,
                malformedLinesDropped: 1,
            });
            expect(await readFile(join(dataDir, AUDIT_FILE), 'utf8')).not.toContain(torn);
        }
    });

});
