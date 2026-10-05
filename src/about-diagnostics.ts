/**
 * The About tab's read-only Diagnostics record (005 T-028; FR-075, FR-076).
 *
 * Three facts the panel kept about its own operation — the two schema
 * versions this build ships, the observed-phase record, and the ledger tail —
 * mounted as text inside the block the disclosure in
 * [`about-tab.ts`](./about-tab.ts) reveals. It is its own module for the
 * reason `bindings-body.ts` is: the About view had outgrown the file-length
 * cap once the disclosure arrived, and this half is a self-contained record
 * with its own renderers.
 *
 * **Entry detail is deliberately not rendered**: ledger lines are
 * `#seq · kind · time` and nothing else, so an account identifier, a prompt,
 * a fingerprint, or a path has no way into this section (FR-076). Nothing
 * here writes — the phase writer left with the tab it lived on.
 */

import type { TextHandle } from '@openchamber/sdk/ui';
import { EVIDENCE_SCHEMA_VERSION } from './evidence.ts';
import { LEDGER_SCHEMA_VERSION, ledgerTail } from './ledger.ts';
import { mountStyledText } from './style.ts';
import type { PanelRuntime } from './panel-state.ts';

/** How many ledger lines the diagnostics section shows, newest first. */
const VISIBLE_ENTRIES = 25;

/** Start offset of the time part inside an RFC 3339 timestamp. */
const TIME_START = 11;

/** End offset of the time part inside an RFC 3339 timestamp. */
const TIME_END = 19;

/** What the ledger section says when this mount has recorded nothing. */
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
 *
 * @returns The last recorded phase, or that there is none yet.
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
 *
 * @returns The three handles the pane carries.
 */
export function mountDiagnostics(input: {
    /** Runtime whose ledger the block renders. */
    readonly rt: PanelRuntime;
    /** Block body the lines mount into. */
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
