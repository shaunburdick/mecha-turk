/**
 * The query, order, and page machinery behind `GET /v1/events` (005 FR-042,
 * FR-043;
 * [contracts/dispatch-list.md](../../specs/005-panel-ia/contracts/dispatch-list.md)).
 *
 * It lives beside the route rather than inside it for one reason: the route is
 * a sequence of refusals, and every one of them is a pure function of the query
 * string. Keeping them here makes the 422 vocabulary testable without a socket
 * and keeps the handler itself short enough to read in one pass.
 *
 * Nothing here reaches the store, and nothing here parses a cursor it did not
 * issue — the token stays opaque to every caller but this module.
 */

import { validationResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { RunHistoryRow } from '../poll/run-history-project.ts';
import type { RouteRequest } from './types.ts';

/** Smallest page `GET /v1/events` accepts (contract §1). */
export const MIN_PAGE_SIZE = 10;

/** Page size the route answers with when the query carries none (contract §1). */
export const DEFAULT_PAGE_SIZE = 25;

/** Middle page size `GET /v1/events` accepts (contract §1). */
const MID_PAGE_SIZE = 50;

/** Largest page `GET /v1/events` accepts; the shipped cap became it. */
export const MAX_PAGE_SIZE = 100;

/** Page sizes the route accepts, smallest first (contract §1). */
export const LIST_PAGE_SIZES = [MIN_PAGE_SIZE, DEFAULT_PAGE_SIZE, MID_PAGE_SIZE, MAX_PAGE_SIZE] as const;

/**
 * Exact state tokens the `state` filter accepts, beside the `blocked` family.
 *
 * The `blocked:<reason>` family is not enumerated here: the run parser accepts
 * any non-empty kebab reason (including one this build has not produced yet),
 * so the filter accepts the same shape rather than inventing a closed list the
 * domain deliberately left open.
 */
export const LISTABLE_STATES = [
    'pending',
    'claimed',
    'starting',
    'dispatched',
    'failed',
    'unconfirmed',
    'dead-lettered',
] as const;

/** Shape of the `page` member `GET /v1/events` answers with (contract §2). */
export interface EventPage {
    /** Effective page size, after defaulting. */
    readonly limit: number;
    /** Opaque boundary for the next page, or `null` at the end of the set. */
    readonly nextCursor: string | null;
    /** Whether a further page exists in the same filtered set. */
    readonly hasMore: boolean;
    /** Size of the filtered set, or `null` when it cannot be counted honestly. */
    readonly total: number | null;
    /** The label this read carries, so a refresh can be seen as one. */
    readonly snapshotAt: string;
    /** Echo of the applied filters, so the tab shows the service's answer. */
    readonly filter: { readonly bindingId: string | null; readonly state: string | null };
}

/** A page boundary: the `detectedAt`/`id` of the last row the caller saw. */
export interface PageBoundary {
    /** RFC 3339 stamp of the last row shown. */
    readonly detectedAt: string;
    /** Row key (the run's correlation id) of the last row shown. */
    readonly id: string;
}

/** One validated read of the `GET /v1/events` query string. */
export interface ListQuery {
    /** Effective page size. */
    readonly limit: number;
    /** Page boundary the caller resumes from, or `null` for the first page. */
    readonly boundary: PageBoundary | null;
    /** Applied state filter, or `null` when none was asked for. */
    readonly state: string | null;
    /** Raw binding filter; `''` means none, anything else is matched exactly. */
    readonly bindingId: string;
}

/**
 * Read the requested page size.
 *
 * Absent takes the documented default; anything outside the accepted set is a
 * refusal rather than a guess, because a silently clamped page size would tell
 * the tab it is showing a different number of rows than it is (contract §1).
 *
 * @param raw - The query parameter as it arrived, or `null` when absent.
 * @returns The page size, or `null` when the value is not one this route takes.
 */
export function pageSizeOf(raw: string | null): number | null {
    if (raw === null || raw === '') {
        return DEFAULT_PAGE_SIZE;
    }

    if (!/^\d{1,3}$/.test(raw)) {
        return null;
    }

    const parsed = Number(raw);

    return (LIST_PAGE_SIZES as readonly number[]).includes(parsed) ? parsed : null;
}

/**
 * Decode an opaque page boundary.
 *
 * The token is base64url JSON so an operator can see *that* it is a boundary
 * without the panel ever parsing it; anything that is not a boundary this
 * service issued is a refusal, never a silent restart at page one — a silent
 * reset would strand the operator's position behind a "successful" answer
 * (contract §1).
 *
 * @param raw - The query parameter as it arrived, or `null` when absent.
 * @returns `ok: false` when the token is not decodable as a boundary.
 */
export function boundaryOf(
    raw: string | null,
): { readonly ok: true; readonly boundary: PageBoundary | null } | { readonly ok: false } {
    if (raw === null || raw === '') {
        return { ok: true, boundary: null };
    }

    let decoded: unknown;
    try {
        decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return { ok: false };
    }

    if (typeof decoded !== 'object' || decoded === null) {
        return { ok: false };
    }

    const record = decoded as Record<string, unknown>;
    const stamp = record.detectedAt;
    const key = record.id;
    if (typeof stamp !== 'string' || typeof key !== 'string' || key === '' || Number.isNaN(Date.parse(stamp))) {
        return { ok: false };
    }

    return { ok: true, boundary: { detectedAt: stamp, id: key } };
}

/**
 * Encode a page boundary for the next answer.
 *
 * @param row - The last row of the page just served.
 * @returns The opaque token the next request carries back.
 */
export function encodeBoundary(row: RunHistoryRow): string {
    const payload: Record<string, string> = { detectedAt: row.detectedAt, id: row.id };

    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Whether a value is a non-empty kebab-case reason.
 *
 * Written as a split rather than one expression with a nested quantifier: the
 * pieces are checked one at a time, so a long hostile reason cannot make the
 * matcher backtrack.
 *
 * @param value - The text after the `blocked:` prefix.
 * @returns `true` for `project-missing`, and for one a later build declares.
 */
function isKebabReason(value: string): boolean {
    if (value === '') {
        return false;
    }

    return value.split('-').every((part) => /^[a-z0-9]+$/.test(part));
}

/**
 * Validate the `state` filter against the dispatch vocabulary.
 *
 * @param raw - The query parameter as it arrived, or `null` when absent.
 * @returns `ok: false` for a value outside the vocabulary, so the route can
 *   answer `422` instead of silently widening or narrowing the set.
 */
export function stateFilterOf(
    raw: string | null,
): { readonly ok: true; readonly state: string | null } | { readonly ok: false } {
    if (raw === null || raw === '') {
        return { ok: true, state: null };
    }

    if (raw === 'blocked' || (LISTABLE_STATES as readonly string[]).includes(raw)) {
        return { ok: true, state: raw };
    }

    // The same shape the run parser accepts: `blocked:` + a non-empty kebab
    // reason, so a declared-but-not-yet-produced reason still filters.
    const prefix = 'blocked:';
    if (raw.startsWith(prefix) && isKebabReason(raw.slice(prefix.length))) {
        return { ok: true, state: raw };
    }

    return { ok: false };
}

/**
 * Validate the query string, or hand back the refusal it earned.
 *
 * Every parameter is checked before a document is read, so a bad query never
 * reaches the store — and a refusal changes nothing (contract §3).
 *
 * @param request - Routed request whose query may carry the four parameters.
 * @returns The validated query, or the `422` that beat it.
 */
export function listQueryOf(
    request: RouteRequest,
): { readonly ok: true; readonly query: ListQuery } | { readonly ok: false; readonly response: HttpResponse } {
    const params = request.url.searchParams;
    const limit = pageSizeOf(params.get('limit'));
    if (limit === null) {
        return {
            ok: false,
            response: validationResponse([{
                field: 'limit',
                remediation: `ask for one of ${LIST_PAGE_SIZES.join(', ')} rows per page`,
            }]),
        };
    }

    const cursor = boundaryOf(params.get('cursor'));
    if (!cursor.ok) {
        return {
            ok: false,
            response: validationResponse([{
                field: 'cursor',
                remediation: 'the cursor is not one this service issued; drop it to start at the first page',
            }]),
        };
    }

    const state = stateFilterOf(params.get('state'));
    if (!state.ok) {
        return {
            ok: false,
            response: validationResponse([{
                field: 'state',
                remediation: `ask for one of ${LISTABLE_STATES.join(', ')}, blocked, or blocked:<reason>`,
            }]),
        };
    }

    const bindingId = params.get('bindingId') ?? '';

    return {
        ok: true,
        query: { limit, boundary: cursor.boundary, state: state.state, bindingId },
    };
}

/**
 * Whether a row belongs to the filtered set the query describes.
 *
 * @param row - Row being tested.
 * @param query - The validated filters.
 * @returns `true` when the row survives both filters.
 */
export function matchesFilters(row: RunHistoryRow, query: ListQuery): boolean {
    if (query.bindingId !== '' && row.bindingId !== query.bindingId) {
        return false;
    }

    if (query.state === null) {
        return true;
    }

    return query.state === 'blocked' ? row.state.startsWith('blocked:') : row.state === query.state;
}

/**
 * The retained order: newest detected first, `id` descending as the tiebreak.
 *
 * The tiebreak is what makes the cursor deterministic when several rows share a
 * detection stamp — without it a page boundary could drop or duplicate a row,
 * which SC-106/AC-121 forbid.
 *
 * @param left - First row.
 * @param right - Second row.
 * @returns Negative when `left` sorts first.
 */
export function newestFirst(left: RunHistoryRow, right: RunHistoryRow): number {
    const byStamp = Date.parse(right.detectedAt) - Date.parse(left.detectedAt);
    if (byStamp !== 0) {
        return byStamp;
    }

    if (left.id === right.id) {
        return 0;
    }

    return left.id < right.id ? 1 : -1;
}

/**
 * Whether a row sits after the page boundary in the retained order.
 *
 * @param row - Row being tested.
 * @param boundary - The last row the previous page served.
 * @returns `true` when the row belongs to a later page.
 */
export function afterBoundary(row: RunHistoryRow, boundary: PageBoundary): boolean {
    const byStamp = Date.parse(row.detectedAt) - Date.parse(boundary.detectedAt);
    if (byStamp !== 0) {
        return byStamp < 0;
    }

    return row.id < boundary.id;
}

/**
 * Assemble the `page` member (contract §2).
 *
 * `total` is passed through exactly as the caller computed it: a withheld total
 * stays `null` rather than being replaced by the page size, which is the one
 * substitution that would turn "25 rows shown" into "25 rows exist".
 *
 * @param input - The page's members.
 * @returns The member as it goes on the wire.
 */
export function buildEventPage(input: {
    /** Effective page size. */
    readonly limit: number;
    /** Boundary token for the next page, or `null` at the end. */
    readonly nextCursor: string | null;
    /** Whether a further page exists. */
    readonly hasMore: boolean;
    /** Size of the filtered set, or `null` when withheld. */
    readonly total: number | null;
    /** Stamp this read carries. */
    readonly snapshotAt: string;
    /** Echo of the applied filters. */
    readonly filter: { readonly bindingId: string | null; readonly state: string | null };
}): EventPage {
    return { ...input };
}
