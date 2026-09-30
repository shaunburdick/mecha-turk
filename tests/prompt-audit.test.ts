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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findSecretLeak } from '../src/redaction.ts';
import { readAuditEntries } from '../service/audit.ts';
import {
    PROMPT_UPDATED_EVENT,
    observePromptChanges,
    runPromptChain,
    recordPromptChanges,
} from '../service/prompt-audit.ts';
import { promptFingerprint } from '../service/prompt.ts';
import { openStore } from '../service/store/index.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { ObservedBinding } from '../service/prompt-audit.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';

/** The instruction this suite stores, changes, and scans every row for. */
const PROMPT = 'Reproduce first, then patch. Do not widen the public API.';

/** The same instruction with one character changed. */
const NEXT_PROMPT = 'Reproduce first, then patch. Do not widen the public API!';

/** Temporary directories this suite opened, drained between tests. */
const temporaryDirs: string[] = [];

afterEach(async () => {
    while (temporaryDirs.length > 0) {
        const dir = temporaryDirs.pop();
        await rm(dir ?? '', { recursive: true, force: true });
    }
});

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
    });

    it('never carries the prompt text in any row (FR-053)', async () => {
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
        expect(serialized).not.toContain('Reproduce first');
        // And the values that *are* recorded are the reference scalars.
        expect(serialized).toContain(promptFingerprint(PROMPT));
        expect(serialized).toContain(promptFingerprint(NEXT_PROMPT));
    });

    it('records set, changed, and cleared with chained previous fingerprints (SC-125)', async () => {
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
        expect([...seqs].sort((left, right) => left - right)).toEqual(seqs);
    });

    it('writes nothing when a second observation sees the same file (SC-125)', async () => {
        const store = await tempStore();
        const log = capturingLogger();

        await observePromptChanges({ store, log, bindings: bindingDocument(PROMPT), actor: 'service' });
        const second = await observePromptChanges({ store, log, bindings: bindingDocument(PROMPT), actor: 'service' });

        expect(second).toBe(0);
        expect(await promptRows(store)).toHaveLength(1);
    });

    it('drops a binding removed from the document without recording a change', async () => {
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
    });
    it('carries no credential-shaped string in the rows it writes (NFR-121)', async () => {
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
    });
});

describe('T-004 the baseline survives a restart (FR-051, AC-139)', () => {
    it('re-seeds from the rows just written and chains previousFingerprint', async () => {
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
    });

    it('starts from an empty baseline on a store with no prompt rows', async () => {
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
        expect(JSON.stringify(warning)).not.toContain('Reproduce first');

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
