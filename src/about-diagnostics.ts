/**
 * The About tab's read-only Diagnostics record: the two schema versions, the
 * observed-phase record, and the ledger tail (005 T-028; FR-075, FR-076) —
 * rendered as `#seq · kind · time` lines only, so nothing else can reach it.
 */

import type { TextHandle } from '@openchamber/sdk/ui';
import { EVIDENCE_SCHEMA_VERSION } from './evidence.ts';
import { LEDGER_SCHEMA_VERSION, ledgerTail } from './ledger.ts';
import { mountStyledText } from './style.ts';
import type { PanelRuntime } from './panel-state.ts';

const VISIBLE_ENTRIES = 25;

const TIME_START = 11;

const TIME_END = 19;

const LEDGER_EMPTY = 'No ledger entries yet.';

/**
 * Format an RFC 3339 timestamp as `HH:MM:SS`.
 *
 * @returns The time slice, or the raw value when it is too short.
 */
function formatTime(iso: string): string {
    return iso.length > TIME_END ? iso.slice(TIME_START, TIME_END) : iso;
}

/**
 * The phase record, read-only.
 */
export function phaseRecordLine(rt: PanelRuntime): string {
    const phase = rt.state.ledger.entries.findLast((entry) => entry.kind === 'phase');
    if (phase === undefined) {
        return 'Phase record: none recorded yet.';
    }

    return `Phase record: ${phase.phase ?? 'unknown'} at ${phase.at} — read-only; this tab writes nothing.`;
}

/**
 * The ledger as text: sequence, kind, and time, newest first.
 *
 * @returns The lines, or the empty-state sentence.
 */
export function ledgerLines(rt: PanelRuntime): string {
    const entries = ledgerTail(rt.state.ledger, VISIBLE_ENTRIES);
    if (entries.length === 0) {
        return LEDGER_EMPTY;
    }

    return entries
        .map((entry) => {
            const what = entry.kind === 'phase' ? `phase: ${entry.phase ?? 'unknown'}` : entry.kind;

            return `#${entry.seq} · ${what} · ${formatTime(entry.at)}`;
        })
        .join('\n');
}

/**
 * Mount the read-only Diagnostics block's three lines.
 */
export function mountDiagnostics(input: {
    readonly rt: PanelRuntime;
    readonly pane: HTMLElement;
}): {
    readonly schemas: TextHandle;
    readonly phaseRecord: TextHandle;
    readonly ledger: TextHandle;
} {
    const schemas = mountStyledText(input.pane, {
        className: 'mt-prose',
        text: `Evidence schema: ${EVIDENCE_SCHEMA_VERSION} · Ledger schema: ${LEDGER_SCHEMA_VERSION}`,
    });

    return {
        schemas,
        phaseRecord: mountStyledText(input.pane, { className: 'mt-prose', text: phaseRecordLine(input.rt) }),
        ledger: mountStyledText(input.pane, { className: 'mt-prose', text: ledgerLines(input.rt) }),
    };
}
