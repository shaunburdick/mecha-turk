/**
 * The Audit history view for the selected run (003 T-026; FR-053, FR-064, AC-117).
 *
 * The audit route answers every run-scoped question the trail holds for one
 * correlation id, but it is **not operator-reachable on its own** — the bearer
 * token is service-side and the operator holds no credential. This module is
 * the surface that makes "retrievable by correlation identifier alone,
 * credential-free, without file access" true: select a run row, press
 * **Audit history**, and the rows come back as plain text through the SDK list
 * primitives' `textContent` writes (contract §3, NFR-109 — a hostile reason or
 * details blob is text, never markup).
 *
 * Two rules shape it, matching the runs parser beside it:
 *
 * - **Fail closed.** One unreadable entry refuses the whole body, so the view
 *   shows an honest "could not read" instead of a half-truth (AGENTS invariant 8).
 * - **Bounded.** The fetch asks for {@link AUDIT_ROW_LIMIT} rows, the parser
 *   stops there even if the service sends more, and each row's reason and
 *   details are cut with a visible marker — one loud run cannot fill the pane
 *   (NFR-107), and a cut is never silent.
 */

import type { ListItem } from '@openchamber/sdk/ui';
import { asRecord, parseJsonObject } from './json.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { selectedRun, utcStamp } from './dispatches-rows.ts';
import { auditPath, serviceGet } from './service-calls.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Button label that reads the selected run's trail (contract §3). */
export const AUDIT_BUTTON_LABEL = 'Audit history';

/** Rows one press renders; the route clamps `limit` well below its ceiling. */
export const AUDIT_ROW_LIMIT = 100;

/**
 * Status line before the operator has asked for anything.
 *
 * It names the **precondition** rather than the button: `Audit history` is
 * disabled until a dispatch row is selected (`dispatches-ui.ts` repaints it
 * from `selected === null`), so the old "press Audit history" told the
 * operator to click a control the same screen was refusing to enable
 * (product-owner review 2026-10-01).
 */
export const AUDIT_IDLE_STATUS =
    'No audit history loaded yet — select a dispatch, then press Audit history.';

/** Status line for a run the trail says nothing about (a 200 with no rows). */
export const AUDIT_EMPTY_STATUS = 'The audit trail holds no rows for this run yet.';

/** Where the audit-history read stands. */
export type AuditStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * The selected run's audit trail as the panel holds it.
 *
 * It lives on the runs section because that is where the operator asks for
 * it, and it resets with the selection: the rows answer one correlation id,
 * so carrying them across a click would show one run's history under another
 * run's row.
 */
export interface AuditViewState {
    /** Where the read stands. */
    status: AuditStatus;
    /** Correlation id these rows answer; `null` before the first read. */
    correlationId: string | null;
    /** Rows in `seq` order, bounded by the fetch's limit (NFR-107). */
    rows: readonly AuditRow[];
    /** Operator-facing note for a failed read; redacted, empty otherwise. */
    note: string;
}

/** One audit row exactly as the read returns it (contract §2, verbatim). */
export interface AuditRow {
    /** Monotonic sequence number inside the trail. */
    readonly seq: number;
    /** RFC 3339 write stamp. */
    readonly timestamp: string;
    /** The run's correlation id — what the fetch was keyed by (FR-062). */
    readonly correlationId: string;
    /** Vocabulary name, e.g. `dispatch.retry`. */
    readonly eventType: string;
    /** Who acted: `service`, `panel`, or `operator`. */
    readonly actorSource: string;
    /** Decision recorded, or `null` when the vocabulary defines none. */
    readonly decision: string | null;
    /** Secret-free reason naming the cause, or `null`. */
    readonly reason: string | null;
    /** Structured details; rendered as truncated text, never as markup. */
    readonly details: Readonly<Record<string, unknown>>;
}

/** Characters of one row's reason the line carries before it cuts. */
const REASON_CHARS = 160;

/** Characters of one row's details the line carries before it cuts. */
const DETAILS_CHARS = 160;

/** What a cut line ends with, so a truncation is never silent (FR-014's rule). */
const TRUNCATED_SUFFIX = '…';

/** Note the view shows when the service answers a body it cannot read. */
const UNREADABLE_NOTE =
    'The service answered an audit history the panel could not read — press Audit history to retry.';

/**
 * Build the empty audit-history state.
 *
 * @returns The state before the first read.
 */
export function initialAuditHistory(): AuditViewState {
    return { status: 'idle', correlationId: null, rows: [], note: '' };
}

/**
 * Cut one line to a character budget, marking the cut.
 *
 * @param text - The text to bound.
 * @param limit - Character budget (the marker is counted inside it).
 * @returns The text, whole or cut with {@link TRUNCATED_SUFFIX}.
 */
function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, Math.max(limit - 1, 1))}${TRUNCATED_SUFFIX}`;
}

/**
 * Serialize one row's details for the line, bounded.
 *
 * @param details - The row's structured details.
 * @returns JSON text, cut to the details budget.
 */
function detailsText(details: Readonly<Record<string, unknown>>): string {
    return truncate(JSON.stringify(details), DETAILS_CHARS);
}

/**
 * Read one audit row, refusing anything half-usable.
 *
 * @param value - One element of the response's `entries`.
 * @returns The row, or `null` when its shape is unusable.
 */
function parseAuditRow(value: unknown): AuditRow | null {
    const record = asRecord(value);
    if (record === null) {
        return null;
    }

    const { seq, timestamp, correlationId, eventType, actorSource, decision, reason, details } = record;
    if (typeof seq !== 'number' || !Number.isInteger(seq)) {
        return null;
    }

    if ([timestamp, correlationId, eventType, actorSource].some((field) => typeof field !== 'string' || field === '')) {
        return null;
    }

    if (decision !== null && typeof decision !== 'string') {
        return null;
    }

    if (reason !== null && typeof reason !== 'string') {
        return null;
    }

    const structured = asRecord(details);
    if (structured === null) {
        return null;
    }

    return {
        seq,
        timestamp: timestamp as string,
        correlationId: correlationId as string,
        eventType: eventType as string,
        actorSource: actorSource as string,
        decision,
        reason,
        details: structured,
    };
}

/**
 * Parse the audit-read body (`{ entries: AuditEntry[] }`, contract §2).
 *
 * @param text - Response body text.
 * @returns The rows in the order the service sent them, capped at
 *   {@link AUDIT_ROW_LIMIT}, or `null` when any part of the shape is unusable.
 */
export function parseAuditBody(text: string): AuditRow[] | null {
    const root = parseJsonObject(text);
    if (root === null || !Array.isArray(root.entries)) {
        return null;
    }

    const rows: AuditRow[] = [];
    for (const entry of root.entries) {
        const row = parseAuditRow(entry);
        if (row === null) {
            return null;
        }

        rows.push(row);
        if (rows.length === AUDIT_ROW_LIMIT) {
            break;
        }
    }

    return rows;
}

/**
 * Compose one audit row as a list row: seq, event, actor, decision, reason.
 *
 * @param row - One row from the trail.
 * @returns The list row, every string written as text by the primitive.
 */
export function auditItem(row: AuditRow): ListItem {
    const reason = row.reason === null ? '' : truncate(row.reason, REASON_CHARS);
    const details = detailsText(row.details);
    const subtitle = redact([reason, details].filter((part) => part !== '').join(' · '));
    const decision = row.decision === null ? '' : ` · ${row.decision}`;

    return {
        id: String(row.seq),
        leading: String(row.seq),
        title: `${row.eventType} · ${row.actorSource}${decision}`,
        meta: utcStamp(row.timestamp),
        ...(subtitle === '' ? {} : { subtitle }),
    };
}

/**
 * Build the audit list from the view's state.
 *
 * @param state - The audit-history state.
 * @returns At most {@link AUDIT_ROW_LIMIT} rows, oldest first.
 */
export function auditItems(state: AuditViewState): ListItem[] {
    return state.rows.slice(0, AUDIT_ROW_LIMIT).map(auditItem);
}

/**
 * Compose the audit view's status line.
 *
 * @param state - The audit-history state.
 * @returns The status text for where the read stands.
 */
export function auditStatusText(state: AuditViewState): string {
    if (state.status === 'idle') {
        return AUDIT_IDLE_STATUS;
    }

    if (state.status === 'loading') {
        return 'Reading the audit history…';
    }

    if (state.status === 'error') {
        return 'Audit history not loaded — see the note below.';
    }

    if (state.rows.length === 0) {
        return AUDIT_EMPTY_STATUS;
    }

    const rows = state.rows.length === 1 ? '1 row' : `${state.rows.length} rows`;

    return `${rows} for ${state.correlationId ?? ''} · oldest first`;
}

/**
 * Read the selected run's audit history.
 *
 * The fetch is keyed by the **selected row's** correlation id and by nothing
 * else — that is the whole point of FR-051's one identifier — and the answer
 * replaces the view wholesale, so a failure can never leave one run's rows on
 * screen under another's status line.
 *
 * @param rt - Panel runtime.
 */
export async function loadAuditHistory(rt: PanelRuntime): Promise<void> {
    const { dispatches: runs } = rt.state;
    const row = selectedRun(runs);
    if (row === null || runs.audit.status === 'loading') {
        return;
    }

    const { correlationId } = row;
    runs.audit = { status: 'loading', correlationId, rows: [], note: '' };
    refresh(rt);

    const result = await serviceGet({
        serviceRequest: rt.host.serviceRequest,
        path: auditPath(correlationId),
    });
    if (rt.disposed) {
        return;
    }

    if (!result.ok) {
        runs.audit = {
            status: 'error',
            correlationId,
            rows: [],
            note: redact(`Audit history not loaded: ${result.problem}.`),
        };
        refresh(rt);

        return;
    }

    const rows = parseAuditBody(result.body);
    if (rows === null) {
        runs.audit = { status: 'error', correlationId, rows: [], note: UNREADABLE_NOTE };
        refresh(rt);

        return;
    }

    runs.audit = { status: 'ready', correlationId, rows, note: '' };
    refresh(rt);
}
