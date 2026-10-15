/** The single-writer queue write: it joins the queue's existing chain and never prunes a row on any path. */

import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { describeKind } from './cycle-config.ts';
import { EVENTS_FILE, parseStoredEvents } from './events-parse.ts';
import { inQueueChain } from './runs-document.ts';
import type { EngineMember } from './events-parse.ts';

/** Atomic rewrite of the queue as read; `false` when unreadable, so the caller records the loss, not the delivery. */
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

/** Never throws: a reconciliation that failed must not stop the boot — a later boot finds the same rows again. */
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
