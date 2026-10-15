/**
 * The single-writer engine-member write: it joins the queue's existing chain
 * — the same slot an enqueue and the excerpt trim use — so it serializes with
 * every other queue mutation, and it **never prunes a queue row on any path**
 * (002 v1.19.0 §2.4, span B). The restart reconciliation's cause flip writes
 * here too, for the same single-writer reason.
 */

import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { describeKind } from './cycle-config.ts';
import { EVENTS_FILE, parseStoredEvents } from './events-parse.ts';
import { inQueueChain } from './runs-document.ts';
import type { EngineMember } from './events-parse.ts';

/**
 * Set one row's engine member, rewriting the queue exactly as read with only
 * that row changed. One atomic `writeJson` per write; `false` when the row or
 * the queue is currently unreadable, so a caller records the loss instead of
 * assuming the delivery settled.
 */
export async function writeEngineMember(input: {
    readonly store: ServiceStore;
    readonly deliveryId: string;
    readonly engine: EngineMember;
}): Promise<boolean> {
    return await inQueueChain(async () => {
        const stored = await input.store.readJson(EVENTS_FILE, parseStoredEvents);
        if (stored.status !== 'ok') {
            return false;
        }

        const index = stored.value.findIndex((row) => row.id === input.deliveryId);
        const row = stored.value[index];
        if (index === -1 || row === undefined) {
            return false;
        }

        const rows = [...stored.value];
        rows[index] = { ...row, engine: input.engine };
        await input.store.writeJson(EVENTS_FILE, rows);

        return true;
    });
}

/**
 * Restart reconciliation (009 F6; FR-105 span E): a restart over a
 * send-intent that never gained its receipt spends the intent — the row's
 * cause moves `'intent'` → `'outcome'`, it stays `unknown` (never re-POSTed,
 * ever), and it becomes an ordinary outcome-unknown row: displayed, and
 * re-offerable by the operator. One atomic queue-chain write, and only when a
 * row actually flips; returns how many did. Never throws, because a
 * reconciliation that failed must not stop the boot that ran it — a later
 * boot simply finds the same rows again.
 */
export async function reconcileEngineIntents(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
}): Promise<number> {
    try {
        return await inQueueChain(async () => {
            const stored = await input.store.readJson(EVENTS_FILE, parseStoredEvents);
            if (stored.status !== 'ok') {
                return 0;
            }

            const rows = [...stored.value];
            let flipped = 0;
            for (const [index, row] of rows.entries()) {
                const { engine } = row;
                if (engine?.state !== 'unknown' || engine.cause !== 'intent') {
                    continue;
                }

                rows[index] = { ...row, engine: { ...engine, cause: 'outcome' } };
                flipped += 1;
            }

            if (flipped === 0) {
                return 0;
            }

            await input.store.writeJson(EVENTS_FILE, rows);

            return flipped;
        });
    } catch (cause) {
        input.log.warn('engine intent reconciliation failed', { errorKind: describeKind(cause) });

        return 0;
    }
}
