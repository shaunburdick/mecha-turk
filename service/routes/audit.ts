/**
 * The audit read route: `GET /v1/audit` (003 T-017, FR-053, FR-064;
 * [contracts/run-history-audit.md](../../specs/003-dispatch-integrity/contracts/run-history-audit.md) §2).
 *
 * 002's contract already promised this row (`panel-service.md` §2.5: paginated
 * `AuditEntry` rows, default 100, max 200, read-only); 003 adds the correlation
 * filter FR-053 and FR-064 require, because "retrievable by correlation
 * identifier alone, without file access" is only true if the identifier is the
 * *whole* query. The on-disk trail stays append-only: this route reads it and
 * projects **nothing** — rows were redaction-passed at write (FR-061), so a
 * credential-free answer is a property of the store, not of this module.
 *
 * Three rules the handler keeps, each straight from the contract:
 *
 * - **The filter is a string equality, never a derivation.** A run's
 *   correlation id matches byte for byte (FR-051), so a non-run row — poll,
 *   checkpoint, legacy `consent`, `account.*` — can never match a run id by construction
 *   (FR-052), and a near-miss (different case, a prefix, a stray space, an
 *   empty value) matches nothing rather than something close. The value is
 *   compared exactly as it arrived: an **absent** parameter widens the read to
 *   the whole trail, a **present** one narrows it, and nothing in between.
 * - **`limit` is clamped, never an error.** The contract says out-of-range
 *   values are clamped and never echoed back as a refusal; only `cursor`, which
 *   the caller must have *read* from a previous answer, is refused when it is
 *   not a sequence number (naming the field, never the received value — SEC-11).
 * - **An unknown correlation id is `200` with zero entries.** "No rows yet" and
 *   "no such run" are indistinguishable at this layer, and an empty set is the
 *   honest, non-oracle answer (contract §2).
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
 * The page size for one read.
 *
 * Absent or blank takes the documented default; a numeric value outside
 * `1…`{@link MAX_AUDIT_LIMIT} is **clamped into** that range rather than
 * refused (contract: "out-of-range values are clamped, never echoed as an
 * error"); anything else — a word, a negative fraction — is not a page size at
 * all, and reading it as the default keeps the promise that this parameter
 * never produces an error while still answering with entries.
 *
 * @param raw - The `limit` parameter as it arrived, or `null` when absent.
 * @returns The number of entries to return.
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
 * The sequence number the answer must start *after*.
 *
 * Absent or blank starts at the oldest retained row (contract §2); a whole
 * number ≥ 0 resumes behind it; anything else is a `422` naming `cursor` and
 * nothing else — a cursor the caller did not get from this route is a client
 * bug, and answering it as "start from the beginning" would silently hand back
 * a page the caller already has instead of saying so.
 *
 * @param raw - The `cursor` parameter as it arrived, or `null` when absent.
 * @returns The exclusive lower bound on `seq`, or `null` when it is unusable.
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
 *
 * @returns The refusal response naming `cursor`.
 */
function cursorIssue(): HttpResponse {
    const issues: FieldIssue[] = [{
        field: 'cursor',
        remediation: 'send the nextCursor this route returned, or omit it to start at the oldest row',
    }];

    return validationResponse(issues);
}

/**
 * Answer `GET /v1/audit?correlationId=&limit=&cursor=`.
 *
 * Entries come back exactly as stored — sequence, timestamp, correlation id,
 * event type, actor, entity, decision, reason, redaction marker, structured
 * details — in ascending `seq` order, with `nextCursor` naming the last row
 * returned when more of the filtered set is still ahead and `null` when the
 * answer is the end of it. `count` is how many entries this answer carries.
 *
 * `correlationId` is compared exactly as it arrived and is never trimmed: the
 * parameter being *absent* widens the read to the whole trail, while a value
 * that is present — blank, padded, or wrong — narrows it to nothing rather than
 * quietly answering more than the caller asked for (contract §2's "byte-identical").
 *
 * The transport's own size guard still measures the serialized body: a page
 * over `RESPONSE_BODY_MAX_CHARS` is answered `500 response-too-large` rather
 * than truncated, because shipping half a row would falsify the record the
 * operator is reading (contract §2; 002 contract §1).
 *
 * @param context - Route context carrying the open store.
 * @param request - Routed request; the query may carry the three parameters.
 * @returns `200 { entries, nextCursor, count }`, or the documented
 *   `422`/`401`/`503`.
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
            nextCursor: ahead.length > page.length && last !== undefined ? last.seq : null,
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
