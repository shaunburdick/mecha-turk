/**
 * The single-writer engine-member write: it joins the queue's existing chain
 * — the same slot an enqueue and the excerpt trim use — so it serializes with
 * every other queue mutation, and it **never prunes a queue row on any path**
 * (002 v1.19.0 §2.4, span B).
 */

import type { ServiceStore } from '../store/index.ts';
import { EVENTS_FILE, parseStoredEvents } from './events-parse.ts';
import { inQueueChain } from './runs-document.ts';
import type { EngineMember } from './events-parse.ts';

/**
 * Set one row's engine member, rewriting the queue exactly as read with only
 * that row changed. One atomic `writeJson` per write; `false` when the row or
 * the queue is currently unreadable, so a caller records the loss instead of
 * assuming the delivery settled.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
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
