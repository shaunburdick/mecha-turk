/**
 * The audit read route: `GET /v1/audit` (003 T-017, FR-053, FR-064;
 * [contracts/run-history-audit.md](../../specs/003-dispatch-integrity/contracts/run-history-audit.md) §2).
 */

import { readAuditEntries } from '../audit.ts';
import { STATUS, storageUnavailableResponse, validationResponse } from '../http.ts';
import type { FieldIssue, HttpResponse } from '../http.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path of the audit read. */
export const AUDIT_PATH = '/v1/audit';

/** Entries one answer carries when the caller names no `limit` (contract §2). */
export const DEFAULT_AUDIT_LIMIT = 100;

/** Most entries one answer may carry (002 §2.5's bound). */
export const MAX_AUDIT_LIMIT = 200;

/**
 * The page size for one read. Absent or blank takes the documented default;
 * a numeric value outside `1…{@link MAX_AUDIT_LIMIT}` is **clamped into**
 * that range rather than refused (contract: out-of-range values are clamped,
 * never echoed as an error); anything else — a word, a negative fraction — is
 * not a page size at all, and reading it as the default keeps the promise
 * that this parameter never produces an error while still answering with
 * entries.
 */
function auditLimitOf(raw: string | null): number {
    if (raw === null || raw.trim() === '') {
        return DEFAULT_AUDIT_LIMIT;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_AUDIT_LIMIT;
    }

    return Math.min(Math.max(Math.trunc(parsed), 1), MAX_AUDIT_LIMIT);
}

/**
 * The sequence number the answer must start *after*. Absent or blank starts
 * at the oldest retained row (contract §2); a whole number ≥ 0 resumes
 * behind it; anything else is a `422` naming `cursor` — a cursor the caller
 * did not get from this route is a client bug, and answering *start from the
 * beginning* would silently hand back a page the caller already has instead
 * of saying so.
 */
function auditCursorOf(raw: string | null): number | null {
    if (raw === null || raw.trim() === '') {
        return 0;
    }

    if (!/^[0-9]{1,15}$/.test(raw.trim())) {
        return null;
    }

    return Number(raw.trim());
}

/**
 * The `422` an unusable `cursor` owes.
 *
 * The field is named and the fix is stated; the received value appears nowhere
 * (SEC-11), because a cursor is caller-supplied text that has no business being
 * echoed into an error the panel renders.
 */
function cursorIssue(): HttpResponse {
    const issues: FieldIssue[] = [{
        field: 'cursor',
        remediation: 'send the nextCursor this route returned, or omit it to start at the oldest row',
    }];

    return validationResponse(issues);
}

/**
 * Answer `GET /v1/audit?correlationId=&limit=&cursor=` with entries exactly
 * as stored, in ascending `seq`. `correlationId` is compared byte-identically
 * and never trimmed: a present-but-wrong value narrows the read to nothing
 * rather than quietly answering more than the caller asked for (contract §2).
 * The transport's size guard still measures the whole body — a page over
 * `RESPONSE_BODY_MAX_CHARS` is answered `500 response-too-large` rather than
 * truncated, because shipping half a row would falsify the record.
 */
async function handleAuditRead(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const cursor = auditCursorOf(request.url.searchParams.get('cursor'));
    if (cursor === null) {
        return cursorIssue();
    }

    const limit = auditLimitOf(request.url.searchParams.get('limit'));
    const correlationId = request.url.searchParams.get('correlationId');

    const entries = await readAuditEntries(store);
    const filtered = correlationId === null
        ? entries
        : entries.filter((entry) => entry.correlationId === correlationId);
    const ahead = filtered.filter((entry) => entry.seq > cursor);
    const page = ahead.slice(0, limit);
    const last = page.at(-1);

    return {
        status: STATUS.ok,
        body: {
            entries: page,
            nextCursor: last !== undefined && ahead.length > page.length ? last.seq : null,
            count: page.length,
        },
    };
}

/** Read audit rows, optionally filtered by one correlation id, never writing. */
export const auditRoute: Route = {
    method: 'GET',
    path: AUDIT_PATH,
    handler: (context, request) => handleAuditRead(context, request),
};
