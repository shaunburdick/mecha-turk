/**
 * The prompt-change observer (004 T-004; FR-051, SC-125, AC-139).
 *
 * The property under test is **exactly one row per change**, and it is
 * asserted from the four directions that could break it:
 *
 * - a difference found on read appends one row carrying every required
 *   `details` key and **no prompt text**;
 * - re-observing an unchanged file appends nothing;
 * - a restarted service — a *new store handle* over the same directory —
 *   re-seeds its baseline from the rows just written, so `previousFingerprint`
 *   chains across the restart instead of resetting;
 * - an append that fails logs a `warn` naming the binding and the fingerprint
 *   (never the text) and still advances the baseline, so the change is not
 *   re-reported on every later read (003 FR-063's posture).
 *
 * Offline: a temp directory per test, a capturing logger, no network and no
 * clock — the chain is deterministic, so nothing here waits on a timer.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSecretLeak } from '../src/redaction.ts';
import { AUDIT_FILE, appendAudit, readAuditEntries } from '../service/audit.ts';
import { recordConfigPromptChanges } from '../service/config-prompt-observe.ts';
import {
    ACCOUNT_PROMPT_UPDATED_EVENT,
    observeAccountPromptChanges,
    runAccountPromptChain,
} from '../service/account-prompt-audit.ts';
import {
    PROMPT_UPDATED_EVENT,
    observePromptChanges,
    runPromptChain,
    recordPromptChanges,
} from '../service/prompt-audit.ts';
import { promptFingerprint } from '../service/prompt.ts';
import { openStore } from '../service/store/index.ts';
import type { AuditEntry } from '../service/audit.ts';
import type {
    AccountPromptActor,
    AccountPromptObservation,
    ObservedAccount,
} from '../service/account-prompt-audit.ts';
import type { ObservedBinding } from '../service/prompt-audit.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';

/** The instruction this suite stores, changes, and scans every row for. */
const PROMPT = 'Reproduce first, then patch. Do not widen the public API.';

/** The same instruction with one character changed. */
const NEXT_PROMPT = 'Reproduce first, then patch. Do not widen the public API!';

/** The prompt head every "never the text" scan looks for. */
const PROMPT_HEAD = 'Reproduce first';

/** Temporary directories this suite opened, drained between tests. */
const temporaryDirs: string[] = [];

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork1 = async (): Promise<void> => {
    while (temporaryDirs.length > 0) {
        const dir = temporaryDirs.pop();
        await rm(dir ?? '', { recursive: true, force: true });
    }
};

afterEach(afterEachWork1);

/** A logger that keeps every warning this suite can provoke. */
interface CapturedLogger extends ServiceLogger {
    /** Every `warn` line's fields, in order. */
    readonly warnings: readonly Record<string, unknown>[];
}

/** A logger method nothing records, for the levels this suite never asserts. */
const noop = (): void => undefined;

/**
 * Build a capturing logger.
 *
 * @returns The logger plus its warning sink.
 */
function capturingLogger(): CapturedLogger {
    const warnings: Record<string, unknown>[] = [];

    return {
        warnings,
        setLevel: noop,
        debug: noop,
        info: noop,
        error: noop,
        warn: (_message: string, fields?: Record<string, unknown>) => {
            warnings.push(fields ?? {});
        },
    };
}

/**
 * Open a fresh temp store (and remember to remove it).
 *
 * @returns The store handle bound to a new temp directory.
 */
async function tempStore(): Promise<ServiceStore> {
    const dir = await mkdtemp(join(tmpdir(), 'prompt-audit-'));
    temporaryDirs.push(dir);

    return await openStore({ dataDir: dir });
}

/**
 * Every `binding.prompt-updated` row in the store's trail, oldest first.
 *
 * @param store - Open store.
 * @returns The rows this feature writes.
 */
async function promptRows(store: ServiceStore): Promise<readonly AuditEntry[]> {
    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === PROMPT_UPDATED_EVENT);
}

/** One binding document holding a single prompt value. */
function bindingDocument(prompt: string | null): readonly ObservedBinding[] {
    return prompt === null
        ? [{ bindingId: 'bnd-one' }]
        : [{ bindingId: 'bnd-one', startingPrompt: prompt }];
}

describe('T-004 recordPromptChanges: one row per change, never the text (FR-051, AC-139)', () => {
    it('appends exactly one row per difference, carrying every required detail key', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            const rows = await observePromptChanges({
                store,
                log,
                bindings: bindingDocument(PROMPT),
                actor: 'operator',
            });

            expect(rows).toBe(1);
            const [row] = await promptRows(store);
            expect(row).toBeDefined();
            expect(row?.actorSource).toBe('operator');
            expect(row?.decision).toBe('set');
            expect(row?.entity).toEqual({ kind: 'binding', id: 'bnd-one' });
            expect(row?.correlationId).not.toMatch(/^mt-run-/);
            expect(row?.details).toEqual({
                bindingId: 'bnd-one',
                promptPresent: true,
                promptFingerprint: promptFingerprint(PROMPT),
                promptLength: [...PROMPT].length,
                previousFingerprint: null,
            });
            expect(log.warnings).toEqual([]);
        }
    });

    it('never carries the prompt text in any row', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observePromptChanges({ store, log, bindings: bindingDocument(PROMPT), actor: 'operator' });
            await observePromptChanges({ store, log, bindings: bindingDocument(NEXT_PROMPT), actor: 'operator' });
            await observePromptChanges({ store, log, bindings: bindingDocument(null), actor: 'operator' });

            const trail = await promptRows(store);
            expect(trail).toHaveLength(3);
            const serialized = JSON.stringify(trail);
            expect(serialized).not.toContain(PROMPT);
            expect(serialized).not.toContain(NEXT_PROMPT);
            expect(serialized).not.toContain(PROMPT_HEAD);
            // And the values that *are* recorded are the reference scalars.
            expect(serialized).toContain(promptFingerprint(PROMPT));
            expect(serialized).toContain(promptFingerprint(NEXT_PROMPT));
        }
    });

    it('records set, changed, and cleared with chained previous fingerprints', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observePromptChanges({ store, log, bindings: bindingDocument(PROMPT), actor: 'operator' });
            await observePromptChanges({ store, log, bindings: bindingDocument(NEXT_PROMPT), actor: 'operator' });
            await observePromptChanges({ store, log, bindings: bindingDocument(null), actor: 'operator' });

            const trail = await promptRows(store);
            expect(trail.map((row) => row.decision)).toEqual(['set', 'changed', 'cleared']);
            expect(trail.map((row) => row.details.previousFingerprint)).toEqual([
                null,
                promptFingerprint(PROMPT),
                promptFingerprint(NEXT_PROMPT),
            ]);
            expect(trail.map((row) => row.details.promptPresent)).toEqual([true, true, false]);
            expect(trail.map((row) => row.details.promptLength)).toEqual([
                [...PROMPT].length,
                [...NEXT_PROMPT].length,
                0,
            ]);
            expect(trail.map((row) => row.details.promptFingerprint)).toEqual([
                promptFingerprint(PROMPT),
                promptFingerprint(NEXT_PROMPT),
                null,
            ]);
            // `seq` is monotonic: three rows, three increasing numbers.
            const seqs = trail.map((row) => row.seq);
            expect([...seqs].toSorted((left, right) => left - right)).toEqual(seqs);
        }
    });

    it('writes nothing when a second observation sees the same file', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observePromptChanges({ store, log, bindings: bindingDocument(PROMPT), actor: 'service' });
            const second = await observePromptChanges({ store, log, bindings: bindingDocument(
                PROMPT
            ), actor: 'service' });

            expect(second).toBe(0);
            expect(await promptRows(store)).toHaveLength(1);
        }
    });

    it('drops a binding removed from the document without recording a change', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observePromptChanges({ store, log, bindings: bindingDocument(PROMPT), actor: 'operator' });
            const dropped = await observePromptChanges({ store, log, bindings: [], actor: 'operator' });
            // Re-adding the same binding reads as a fresh `set`, not as a diff
            // against a fingerprint nobody holds any more.
            const readded = await observePromptChanges({
                store,
                log,
                bindings: bindingDocument(PROMPT),
                actor: 'operator',
            });

            expect(dropped).toBe(0);
            expect(readded).toBe(1);
            const trail = await promptRows(store);
            expect(trail.map((row) => row.details.previousFingerprint)).toEqual([null, null]);
        }
    });

    it('carries no credential-shaped string in the rows it writes', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observePromptChanges({ store, log, bindings: bindingDocument(PROMPT), actor: 'operator' });
            await observePromptChanges({ store, log, bindings: bindingDocument(NEXT_PROMPT), actor: 'operator' });
            await observePromptChanges({ store, log, bindings: bindingDocument(null), actor: 'operator' });

            const trail = await promptRows(store);
            expect(trail).toHaveLength(3);
            for (const row of trail) {
                expect(findSecretLeak(JSON.stringify(row)), `${row.decision} row`).toBeNull();
                expect(row.reason).toBeNull();
            }
        }
    });

});

describe('T-004 the baseline survives a restart (FR-051, AC-139)', () => {
    it('re-seeds from the rows just written and chains previousFingerprint', async () => {
        {
            const dir = await mkdtemp(join(tmpdir(), 'prompt-restart-'));
            temporaryDirs.push(dir);
            const log = capturingLogger();

            const first = await openStore({ dataDir: dir });
            await observePromptChanges({ store: first, log, bindings: bindingDocument(PROMPT), actor: 'operator' });

            // A restarted service opens a *new* handle over the same directory, so
            // its state is fresh and must find the baseline in the trail itself.
            const second = await openStore({ dataDir: dir });
            expect(second).not.toBe(first);
            const rows = await observePromptChanges({
                store: second,
                log,
                bindings: bindingDocument(NEXT_PROMPT),
                actor: 'service',
            });

            expect(rows).toBe(1);
            const trail = await promptRows(second);
            expect(trail).toHaveLength(2);
            const row = trail[1];
            expect(row?.actorSource).toBe('service');
            expect(row?.decision).toBe('changed');
            expect(row?.details.previousFingerprint).toBe(promptFingerprint(PROMPT));
        }
    });

    it('starts from an empty baseline on a store with no prompt rows', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            const rows = await observePromptChanges({
                store,
                log,
                bindings: bindingDocument(PROMPT),
                actor: 'service',
            });

            expect(rows).toBe(1);
            const [row] = await promptRows(store);
            expect(row?.details.previousFingerprint).toBeNull();
            expect(row?.decision).toBe('set');
        }
    });

});

describe('T-004 an append failure warns and still advances the baseline (FR-063 posture)', () => {
    it('logs the binding id and fingerprint, never the text, and never re-reports', async () => {
        const backing = await tempStore();
        const log = capturingLogger();
        // A store whose audit appends fail, but whose reads still work — the
        // exact shape of a full disk during one append.
        const failing: ServiceStore = {
            ...backing,
            appendLine: () => Promise.reject(new Error('disk full')),
        };

        let rows = 0;
        let thrown: unknown = null;
        try {
            rows = await runPromptChain(failing, async () =>
                await recordPromptChanges({
                    store: failing,
                    log,
                    bindings: bindingDocument(PROMPT),
                    actor: 'operator',
                }));
        } catch (cause) {
            thrown = cause;
        }

        // The observation itself does not throw: it reports and moves on.
        expect(thrown).toBeNull();
        expect(rows).toBe(0);
        expect(await promptRows(failing)).toHaveLength(0);
        expect(log.warnings).toHaveLength(1);
        const warning = log.warnings[0] ?? {};
        expect(warning.bindingId).toBe('bnd-one');
        expect(warning.promptFingerprint).toBe(promptFingerprint(PROMPT));
        expect(JSON.stringify(warning)).not.toContain(PROMPT_HEAD);

        // The baseline advanced anyway, so the *next* observation of the same
        // document reports nothing — the change is not re-attempted forever.
        const retry = await observePromptChanges({
            store: failing,
            log,
            bindings: bindingDocument(PROMPT),
            actor: 'operator',
        });
        expect(retry).toBe(0);
    });
});

/** The account fixture id every row this suite writes points at. */
const ACCOUNT_ROW_ID = '77331';

/** One account document holding a single prompt value. */
function accountDocument(prompt: string | null): readonly ObservedAccount[] {
    return prompt === null
        ? [{ numericUserId: ACCOUNT_ROW_ID }]
        : [{ numericUserId: ACCOUNT_ROW_ID, startingPrompt: prompt }];
}

/**
 * Observe one account document for one prompt value.
 *
 * @param input - Store, logger, the value the document carries, and the actor.
 * @returns How many rows the observation appended.
 */
function observeAccounts(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Capturing logger. */
    readonly log: ServiceLogger;
    /** The document's prompt value, or `null` when the tier is unset. */
    readonly prompt: string | null;
    /** Who made the change this document carries. */
    readonly actor: AccountPromptActor;
}): Promise<number> {
    const { store, log, prompt, actor } = input;

    return observeAccountPromptChanges({ store, log, accounts: accountDocument(prompt), actor });
}

/**
 * Every `account.prompt-updated` row in the store's trail, oldest first.
 *
 * @param store - Open store.
 * @returns The rows the account lane writes.
 */
async function accountRows(store: ServiceStore): Promise<readonly AuditEntry[]> {
    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === ACCOUNT_PROMPT_UPDATED_EVENT);
}

describe('T-023 recordAccountPromptChanges: one row per account change, never the text (FR-088)', () => {
    it('appends exactly one row per difference, carrying every detail key', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            const rows = await observeAccountPromptChanges({
                store,
                log,
                accounts: accountDocument(PROMPT),
                actor: 'operator',
            });

            expect(rows).toBe(1);
            const [row] = await accountRows(store);
            expect(row).toBeDefined();
            expect(row?.actorSource).toBe('operator');
            expect(row?.decision).toBe('set');
            expect(row?.eventType).toBe(ACCOUNT_PROMPT_UPDATED_EVENT);
            expect(row?.entity).toEqual({ kind: 'account', id: ACCOUNT_ROW_ID });
            expect(row?.correlationId).not.toMatch(/^mt-run-/);
            // The account row's details are the four scalars only — there is
            // no id key beside the entity, and no text anywhere (FR-088).
            expect(row?.details).toEqual({
                promptPresent: true,
                promptFingerprint: promptFingerprint(PROMPT),
                promptLength: [...PROMPT].length,
                previousFingerprint: null,
            });
            expect(log.warnings).toEqual([]);
        }
    });

    it('records set, changed, and cleared with chained previous fingerprints', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observeAccounts({ store, log, prompt: PROMPT, actor: 'operator' });
            await observeAccounts({ store, log, prompt: NEXT_PROMPT, actor: 'operator' });
            await observeAccounts({ store, log, prompt: null, actor: 'operator' });

            const trail = await accountRows(store);
            expect(trail).toHaveLength(3);
            expect(trail.map((row) => row.decision)).toEqual(['set', 'changed', 'cleared']);
            expect(trail.map((row) => row.details.previousFingerprint)).toEqual([
                null,
                promptFingerprint(PROMPT),
                promptFingerprint(NEXT_PROMPT),
            ]);
            expect(trail.map((row) => row.details.promptFingerprint)).toEqual([
                promptFingerprint(PROMPT),
                promptFingerprint(NEXT_PROMPT),
                null,
            ]);
            expect(trail.map((row) => row.details.promptPresent)).toEqual([true, true, false]);
            expect(trail.map((row) => row.details.promptLength)).toEqual([
                [...PROMPT].length,
                [...NEXT_PROMPT].length,
                0,
            ]);
        }
    });

    it('never carries the prompt text in any row', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observeAccounts({ store, log, prompt: PROMPT, actor: 'service' });
            await observeAccounts({ store, log, prompt: NEXT_PROMPT, actor: 'service' });
            await observeAccounts({ store, log, prompt: null, actor: 'service' });

            const serialized = JSON.stringify(await accountRows(store));
            expect(serialized).not.toContain(PROMPT);
            expect(serialized).not.toContain(NEXT_PROMPT);
            expect(serialized).not.toContain(PROMPT_HEAD);
            expect(serialized).toContain(promptFingerprint(PROMPT));
            expect(serialized).toContain(promptFingerprint(NEXT_PROMPT));
            expect(findSecretLeak(serialized)).toBeNull();
        }
    });

    it('writes nothing when a second observation sees the same document', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await observeAccounts({ store, log, prompt: PROMPT, actor: 'service' });
            const second = await observeAccountPromptChanges({
                store,
                log,
                accounts: accountDocument(PROMPT),
                actor: 'service',
            });

            expect(second).toBe(0);
            expect(await accountRows(store)).toHaveLength(1);
        }
    });

    it('forgets a dropped or explicitly absent account, so a re-add reads as a fresh set', async () => {
        {
            const droppedStore = await tempStore();
            const absentStore = await tempStore();
            const log = capturingLogger();

            await observeAccountPromptChanges({
                store: droppedStore,
                log,
                accounts: accountDocument(PROMPT),
                actor: 'operator',
            });
            const dropped = await observeAccountPromptChanges({
                store: droppedStore,
                log,
                accounts: [],
                complete: true,
                actor: 'operator',
            });
            const readdedAfterDrop = await observeAccountPromptChanges({
                store: droppedStore,
                log,
                accounts: accountDocument(NEXT_PROMPT),
                actor: 'service',
            });
            // The `absent` half is what a single read of a deleted record
            // passes: the tier died with the record, so its baseline goes too
            // (AC-149's "record and tier together").
            await observeAccountPromptChanges({
                store: absentStore,
                log,
                accounts: accountDocument(PROMPT),
                actor: 'operator',
            });
            const forgotten = await observeAccountPromptChanges({
                store: absentStore,
                log,
                accounts: [],
                absent: [ACCOUNT_ROW_ID],
                actor: 'service',
            });
            const readdedAfterForget = await observeAccountPromptChanges({
                store: absentStore,
                log,
                accounts: accountDocument(NEXT_PROMPT),
                actor: 'service',
            });

            expect(dropped).toBe(0);
            expect(readdedAfterDrop).toBe(1);
            expect(forgotten).toBe(0);
            expect(readdedAfterForget).toBe(1);
            for (const store of [droppedStore, absentStore]) {
                const trail = await accountRows(store);
                expect(trail).toHaveLength(2);
                expect(trail.map((row) => row.details.previousFingerprint)).toEqual([null, null]);
            }
        }
    });

});

describe('T-023 the account baseline survives a restart (FR-088)', () => {
    it('re-seeds from the rows just written and chains previousFingerprint', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'account-prompt-restart-'));
        temporaryDirs.push(dir);
        const log = capturingLogger();

        const first = await openStore({ dataDir: dir });
        await observeAccountPromptChanges({ store: first, log, accounts: accountDocument(PROMPT), actor: 'operator' });

        // A restarted service opens a *new* handle over the same directory, so
        // its state is fresh and must find the baseline in the trail itself.
        const second = await openStore({ dataDir: dir });
        expect(second).not.toBe(first);
        const rows = await observeAccounts({ store: second, log, prompt: NEXT_PROMPT, actor: 'service' });

        expect(rows).toBe(1);
        const trail = await accountRows(second);
        expect(trail).toHaveLength(2);
        const row = trail[1];
        expect(row?.actorSource).toBe('service');
        expect(row?.decision).toBe('changed');
        expect(row?.details.previousFingerprint).toBe(promptFingerprint(PROMPT));
    });
});

describe('T-023 an account append failure warns and still advances the baseline (FR-063 posture)', () => {
    it('logs the account id and fingerprint, never the text, and never re-reports', async () => {
        const backing = await tempStore();
        const log = capturingLogger();
        // A store whose audit appends fail, but whose reads still work — the
        // exact shape of a full disk during one append.
        const failing: ServiceStore = {
            ...backing,
            appendLine: () => Promise.reject(new Error('disk full')),
        };
        const observation: AccountPromptObservation = {
            store: failing,
            log,
            accounts: accountDocument(PROMPT),
            actor: 'operator',
        };

        const rows = await observeAccountPromptChanges(observation);

        // The observation itself does not throw: it reports and moves on.
        expect(rows).toBe(0);
        expect(await accountRows(failing)).toHaveLength(0);
        expect(log.warnings).toHaveLength(1);
        const warning = log.warnings[0] ?? {};
        expect(warning.numericUserId).toBe(ACCOUNT_ROW_ID);
        expect(warning.promptFingerprint).toBe(promptFingerprint(PROMPT));
        expect(JSON.stringify(warning)).not.toContain(PROMPT_HEAD);

        // The baseline advanced anyway, so the *next* observation of the same
        // document reports nothing — the change is not re-attempted forever.
        const retry = await observeAccountPromptChanges(observation);
        expect(retry).toBe(0);
    });

    it('lets a chain-held task fail for its own caller without wedging the next one', async () => {
        const store = await tempStore();
        const log = capturingLogger();

        let thrown: unknown = null;
        try {
            await runAccountPromptChain(store, async () => {
                throw new Error('task failure');
            });
        } catch (cause) {
            thrown = cause;
        }

        expect(thrown).toBeInstanceOf(Error);
        const rows = await observeAccountPromptChanges({
            store,
            log,
            accounts: accountDocument(PROMPT),
            actor: 'operator',
        });
        expect(rows).toBe(1);
    });
});

/** A recorded `promptFingerprint` that cannot be one — what a seed must refuse. */
const NOT_A_FINGERPRINT = 'previous value that was never a fingerprint';

describe('both lanes seed their baseline only from an `mtp-` fingerprint (004 FR-053)', () => {
    it('the binding lane refuses a recorded value that is not a fingerprint', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();
            // A trail row carrying a value the contract never permits — the
            // shape a hand-edited or older trail could plausibly hold. It
            // becomes the lane's baseline at the next seed, so a seed that
            // adopts it would write it into a later row as
            // `previousFingerprint`.
            await appendAudit(store, {
                eventType: PROMPT_UPDATED_EVENT,
                actorSource: 'operator',
                entity: { kind: 'binding', id: 'bnd-one' },
                decision: 'set',
                details: {
                    bindingId: 'bnd-one',
                    promptPresent: true,
                    promptFingerprint: NOT_A_FINGERPRINT,
                    promptLength: NOT_A_FINGERPRINT.length,
                    previousFingerprint: null,
                },
            });

            const observed = await observePromptChanges({
                store,
                log,
                bindings: bindingDocument(PROMPT),
                actor: 'operator',
            });

            expect(observed).toBe(1);
            const trail = await promptRows(store);
            const fresh = trail.at(-1);
            // The seed read the junk as *unknown*, so this change is a fresh
            // `set` against an empty baseline — and the junk appears nowhere
            // in the row it would otherwise have been carried into.
            expect(fresh?.decision).toBe('set');
            expect(fresh?.details.previousFingerprint).toBeNull();
            expect(JSON.stringify(fresh)).not.toContain(NOT_A_FINGERPRINT);
        }
    });

    it('the account lane refuses a recorded value that is not a fingerprint', async () => {
        {
            const store = await tempStore();
            const log = capturingLogger();

            await appendAudit(store, {
                eventType: ACCOUNT_PROMPT_UPDATED_EVENT,
                actorSource: 'service',
                entity: { kind: 'account', id: ACCOUNT_ROW_ID },
                decision: 'set',
                details: {
                    promptPresent: true,
                    promptFingerprint: NOT_A_FINGERPRINT,
                    promptLength: NOT_A_FINGERPRINT.length,
                    previousFingerprint: null,
                },
            });

            const observed = await observeAccounts({ store, log, prompt: PROMPT, actor: 'operator' });

            expect(observed).toBe(1);
            const trail = await accountRows(store);
            const fresh = trail.at(-1);
            expect(fresh?.decision).toBe('set');
            expect(fresh?.details.previousFingerprint).toBeNull();
            expect(JSON.stringify(fresh)).not.toContain(NOT_A_FINGERPRINT);
        }
    });

});

/* ------------------------------------------------------------------------- *
 * T-035 the raw trail, scanned as bytes (004 FR-053, FR-088, AC-148)
 *
 * Everything above reads the trail **through** `readAuditEntries`, which is
 * the right way to judge a row's shape. This one does not: it reads
 * `audit.ndjson` off disk and greps the bytes for each lane's seeded text,
 * so a leak that a reader skipped, a row type the filter never selects, or a
 * stray write beside the parsed rows would still be caught (AC-148's "a scan
 * of every audit row finds 0 occurrences of any tier's text").
 * ------------------------------------------------------------------------- */

/** The global tier's text this scan seeds into the trail. */
const GLOBAL_TIER_TEXT = 'Name the failing test before proposing any fix.';

/** The account tier's text this scan seeds into the trail. */
const ACCOUNT_TIER_TEXT = 'Prefer the smallest diff that closes the failing test.';

describe('T-035 the raw audit file carries no seeded tier text, in any lane (FR-053, AC-148)', () => {
    it('reads audit.ndjson as bytes and finds each seeded tier 0 times', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'prompt-tier-trail-'));
        temporaryDirs.push(dir);
        const store = await openStore({ dataDir: dir });
        const log = capturingLogger();

        // Three lanes, three rows, three distinct seeded texts: one binding
        // change, one account change, one global change (FR-088).
        expect(await observePromptChanges({
            store,
            log,
            bindings: bindingDocument(PROMPT),
            actor: 'operator',
        })).toBe(1);
        expect(await observeAccountPromptChanges({
            store,
            log,
            accounts: accountDocument(ACCOUNT_TIER_TEXT),
            actor: 'operator',
        })).toBe(1);
        expect(await recordConfigPromptChanges({
            store,
            log,
            config: { startingPrompt: GLOBAL_TIER_TEXT },
            actor: 'operator',
        })).toBe(1);

        // The file's own bytes, not a parsed projection of them — and three
        // rows, so the scan below is grepping rows rather than an empty file.
        const raw = await readFile(join(dir, AUDIT_FILE), 'utf8');
        expect(raw.trim().split('\n')).toHaveLength(3);

        for (const seeded of [GLOBAL_TIER_TEXT, ACCOUNT_TIER_TEXT, PROMPT]) {
            expect(raw.split(seeded).length - 1, `audit.ndjson carried a seeded tier: ${seeded}`).toBe(0);
        }

        // What the rows recorded instead of the text: one fingerprint each,
        // which is how the scan proves it read real rows.
        expect(raw).toContain(promptFingerprint(GLOBAL_TIER_TEXT));
        expect(raw).toContain(promptFingerprint(ACCOUNT_TIER_TEXT));
        expect(raw).toContain(promptFingerprint(PROMPT));
        expect(findSecretLeak(raw)).toBeNull();
    });
});
