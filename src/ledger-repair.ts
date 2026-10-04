/**
 * Recovery for ledger writes that fail one of the host's storage gates.
 *
 * The ledger is evidence, not a queue: an entry that trips the redaction
 * assertion or the host's value limit used to fail every later write too,
 * because the offending entry stayed in memory and was re-serialized on each
 * attempt. This module repairs the ledger instead — secret-shaped values are
 * neutralized in place and an over-budget ledger drops its oldest entries — so
 * a single bad entry cannot make durability fail-stuck.
 *
 * Nothing here weakens the gates: {@link serializeLedger} still refuses to
 * write secret-shaped or oversized content. The repair only changes what the
 * ledger contains when a write would otherwise be refused forever.
 */

import { GUEST_STORAGE_VALUE_BYTES } from '@openchamber/sdk';
import { utf8ByteLength } from './json.ts';
import type { LedgerDetail, LedgerEntry, PanelLedger } from './ledger.ts';
import { findSecretLeak, redact, RedactionError } from './redaction.ts';

/** Detail recorded in place of an entry whose payload still trips the redaction gate. */
const QUARANTINED_DETAIL = 'secret-shaped detail removed before the ledger could be written';

/** Working byte budget the ledger is evicted down to, below the host's hard limit. */
export const LEDGER_BYTE_BUDGET = 60 * 1024;

/** Result of a repair: the writable ledger plus what the repair changed. */
export interface LedgerRepair {
    /** Ledger that can be serialized again. */
    readonly ledger: PanelLedger;
    /** Number of entries whose detail was neutralized. */
    readonly quarantined: number;
    /** Number of entries dropped to fit the byte budget. */
    readonly evicted: number;
    /** Operator-facing explanation, recorded in the banner. Never secret material. */
    readonly summary: string;
}

/**
 * Neutralize secret-shaped values inside one entry detail.
 *
 * @param detail - Detail payload that failed the redaction gate.
 * @returns The redacted detail plus whether any value changed.
 */
function redactDetailValues(detail: LedgerDetail): { readonly detail: LedgerDetail; readonly changed: boolean } {
    let changed = false;
    const result: LedgerDetail = {};
    for (const [key, value] of Object.entries(detail)) {
        const safe = typeof value === 'string' ? redact(value) : value;
        changed ||= safe !== value;
        result[key] = safe;
    }

    return { detail: result, changed };
}

/**
 * Repair one entry: redact its values, or quarantine it wholesale.
 *
 * A shape that only appears once key and value are serialized together (a
 * credential-named key beside its value) hides from a per-value scan, so the
 * repaired entry is re-checked before it is accepted.
 *
 * @param entry - Entry whose detail failed the redaction gate.
 * @returns The repaired entry plus whether it changed.
 */
function repairEntry(entry: LedgerEntry): { readonly entry: LedgerEntry; readonly changed: boolean } {
    const redacted = redactDetailValues(entry.detail);
    const candidate: LedgerEntry = { ...entry, detail: redacted.detail };
    if (findSecretLeak(JSON.stringify(candidate)) === null) {
        return { entry: candidate, changed: redacted.changed };
    }

    return { entry: { ...entry, detail: { quarantined: QUARANTINED_DETAIL } }, changed: true };
}

/**
 * Neutralize every entry whose detail trips the redaction gate.
 *
 * @param ledger - Ledger whose serialization failed with a `RedactionError`.
 * @returns The repaired ledger, or `null` when the leak is not inside an entry.
 */
function quarantineSecretMaterial(ledger: PanelLedger): LedgerRepair | null {
    let quarantined = 0;
    const entries = ledger.entries.map((entry) => {
        const repaired = repairEntry(entry);
        if (repaired.changed) {
            quarantined += 1;
        }

        return repaired.entry;
    });

    const repaired: PanelLedger = { ...ledger, entries };
    if (findSecretLeak(JSON.stringify(repaired)) !== null) {
        return null;
    }

    return {
        ledger: repaired,
        quarantined,
        evicted: 0,
        summary: 'secret-shaped ledger detail was quarantined so the write could proceed',
    };
}

/**
 * Drop the oldest entries until the ledger fits the byte budget.
 *
 * The budget sits deliberately below the host's hard limit, so a ledger that
 * has just been evicted has headroom for the entries the next writes append.
 * The header is always kept: dropping entries is itself evidence, while losing
 * the ledger's identity would not be recoverable.
 *
 * @param ledger - Ledger that exceeded the host's value limit.
 * @returns The shrunken ledger plus how many entries were dropped.
 */
export function fitLedgerToByteBudget(ledger: PanelLedger): LedgerRepair {
    const entries = [...ledger.entries];
    let evicted = 0;
    while (entries.length > 0 && utf8ByteLength(JSON.stringify({ ...ledger, entries })) > LEDGER_BYTE_BUDGET) {
        entries.shift();
        evicted += 1;
    }

    return {
        ledger: { ...ledger, entries },
        quarantined: 0,
        evicted,
        summary: 'the oldest ledger entries were dropped so the write could fit the host value limit',
    };
}

/**
 * Repair a ledger after a failed persist, chosen by the failure cause.
 *
 * @param input - Ledger about to be written plus the error the write failed with.
 * @returns The repair to apply before the single retry, or `null` when the
 * failure is not one this module can repair and the caller must report it.
 */
export function repairLedger(input: { readonly ledger: PanelLedger; readonly cause: unknown }): LedgerRepair | null {
    const { ledger, cause } = input;
    if (cause instanceof RedactionError) {
        return quarantineSecretMaterial(ledger);
    }

    if (utf8ByteLength(JSON.stringify(ledger)) > GUEST_STORAGE_VALUE_BYTES) {
        return fitLedgerToByteBudget(ledger);
    }

    return null;
}
