/**
 * Durable ledger writes, shared by every surface that records one.
 *
 * The product's only loops are the service's poll loop and the root-owned
 * relay; neither is armed, stopped, or fed from here. The panel's own poll
 * loop, its `/user` identity diagnostic, its host-state verification action,
 * and its dispatch path all went with the install-time GitHub credential.
 *
 * Everything that still records a ledger entry — the relay, the mount-time
 * reconciliation, the agent read-back — lands through
 * {@link appendEntryAndPersist}, so there is exactly one redaction guard and
 * one repair-on-refusal for all of them: a write refused because an entry
 * carried secret-shaped material or outgrew the host's value limit is
 * repaired and retried once, and whatever is left is reported on the banner
 * instead of being claimed as durable progress (constitution IV).
 */

import { parseJsonValue } from './json.ts';
import { repairLedger } from './ledger-repair.ts';
import { appendEntry, LEDGER_STORAGE_KEY, serializeLedger } from './ledger.ts';
import type { LedgerEntryInput } from './ledger.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { describeError } from './session.ts';

/**
 * Write the serialized ledger to host storage.
 *
 * @throws {Error} When the ledger exceeds the host's value limit, or the
 *   host refuses the write for its own reasons.
 */
async function writeLedger(rt: PanelRuntime): Promise<void> {
    const json = serializeLedger(rt.state.ledger);
    await rt.host.storage.set(LEDGER_STORAGE_KEY, parseJsonValue(json));
}

/**
 * Persist the ledger, asserting redaction and the host value limit first.
 *
 * Never rejects. When a write fails because an entry carries secret-shaped
 * material or the ledger outgrew the host's value limit, the offending entry
 * is repaired ({@link repairLedger}) and the write is retried exactly once,
 * so one bad entry cannot poison every later write. Whatever is left is
 * reported through the banner so the panel never claims durable progress it
 * does not have.
 */
export async function persistLedger(rt: PanelRuntime): Promise<void> {
    if (rt.disposed) {
        return;
    }

    try {
        await writeLedger(rt);
    } catch (cause) {
        const repair = repairLedger({ ledger: rt.state.ledger, cause });
        if (repair === null) {
            setStatus(rt, { tone: 'error', title: 'Ledger write failed', body: describeError(cause) });
            return;
        }

        rt.state.ledger = repair.ledger;
        setStatus(rt, { tone: 'warning', title: 'Ledger repaired', body: repair.summary });
        try {
            await writeLedger(rt);
        } catch (retryCause) {
            setStatus(rt, { tone: 'error', title: 'Ledger write failed', body: describeError(retryCause) });
        }
    }
}

/**
 * Append a ledger entry, persist it, and let the caller repaint.
 */
export function appendEntryAndPersist(rt: PanelRuntime, input: LedgerEntryInput): void {
    rt.state.ledger = appendEntry(rt.state.ledger, input);
    void persistLedger(rt);
}
