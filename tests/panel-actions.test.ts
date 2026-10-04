/**
 * The durable ledger write every recording surface shares.
 *
 * The spike's own actions — the single-repo poll loop, its match-and-accept
 * sweep, the integration card's `/user` identity diagnostic, and the
 * host-state verification action — were deleted with the install-time GitHub
 * credential (product-owner order, 2026-09-30), so what is left in
 * `panel-actions.ts` is the thing the relay, the mount-time reconciliation,
 * and the agent read-back all record through: one append, one guarded
 * persist, one repair-on-refusal.
 *
 * Offline: a fake host, a storage double, no service, no network (FR-086).
 */

import { describe, expect, it } from 'vitest';
import { appendEntry, LEDGER_STORAGE_KEY, readLedger } from '../src/ledger.ts';
import { appendEntryAndPersist, persistLedger } from '../src/panel-actions.ts';
import {
    FIXTURE_TIMESTAMP,
    createStorageDouble,
    createTestRuntime,
    fakeHost,
    tick,
} from './support/panel.ts';

/** Correlation identifier used by the ledger fixtures in this file. */
const LEDGER_CORRELATION = '2f6a4f0e-1e4c-4a6f-8a3a-0b1c2d3e4f50';

describe('persistLedger recovery', () => {
    it('quarantines a secret-shaped entry and keeps the ledger writable', async () => {
        const token = `ghp_${'a'.repeat(40)}`;
        const storage = createStorageDouble();
        const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));
        runtime.state.ledger = appendEntry(runtime.state.ledger, {
            at: FIXTURE_TIMESTAMP,
            kind: 'error',
            correlationId: LEDGER_CORRELATION,
            detail: { note: token },
        });

        await persistLedger(runtime);
        await tick();

        const stored = readLedger(storage.values.get(LEDGER_STORAGE_KEY));
        expect(stored?.entries.at(-1)?.detail.note).toBe('[redacted:github-token-classic]');
        expect(JSON.stringify(stored)).not.toContain(token);

        runtime.state.ledger = appendEntry(runtime.state.ledger, {
            at: FIXTURE_TIMESTAMP,
            kind: 'poll',
            correlationId: LEDGER_CORRELATION,
            detail: { inspected: 1 },
        });
        await persistLedger(runtime);
        await tick();

        const after = readLedger(storage.values.get(LEDGER_STORAGE_KEY));
        expect(after?.entries.at(-1)?.kind).toBe('poll');
        expect(after?.entries).toHaveLength(runtime.state.ledger.entries.length);
    });
});

describe('appendEntryAndPersist', () => {
    it('appends the entry and lands it in storage without the caller awaiting', async () => {
        {
            const storage = createStorageDouble();
            const runtime = createTestRuntime(fakeHost({ storage: storage.storage }));

            appendEntryAndPersist(runtime, {
                at: FIXTURE_TIMESTAMP,
                kind: 'lifecycle',
                correlationId: LEDGER_CORRELATION,
                detail: { phase: 'mounted' },
            });
            await tick();

            expect(runtime.state.ledger.entries.at(-1)?.kind).toBe('lifecycle');
            const stored = readLedger(storage.values.get(LEDGER_STORAGE_KEY));
            expect(stored?.entries.at(-1)?.kind).toBe('lifecycle');
            expect(stored?.entries.at(-1)?.detail.phase).toBe('mounted');
        }
    });

    it('never throws when the host refuses the write; it says so instead', async () => {
        {
            const storage = createStorageDouble();
            const runtime = createTestRuntime(
                fakeHost({
                    storage: {
                        ...storage.storage,
                        set: async () => {
                            throw new Error('storage offline');
                        },
                    },
                }),
            );

            const appendClosedEntry = (): void => {
                appendEntryAndPersist(runtime, {
                    at: FIXTURE_TIMESTAMP,
                    kind: 'lifecycle',
                    detail: { phase: 'closed' },
                });
            };

            expect(appendClosedEntry).not.toThrow();
            await tick();

            expect(['Ledger write failed', 'Ledger repaired']).toContain(runtime.state.status.title);
        }
    });

});
