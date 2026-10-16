/**
 * `GET /v1/logs` — the service's retained log stream.
 */

import { STATUS, validationResponse } from '../http.ts';
import type { FieldIssue, HttpResponse } from '../http.ts';
import { LOG_RING_CAPACITY } from '../log-ring.ts';
import { readConfig } from './status.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path of the retained-log read. */
export const LOGS_PATH = '/v1/logs';

/** Entries one answer carries when the caller names no `limit`. */
const DEFAULT_LOG_LIMIT = 200;

/**
 * The page size. Absent, blank, or non-numeric takes the documented default;
 * a number is **clamped into** `1…{@link LOG_RING_CAPACITY}` rather than
 * refused, so any retained line is within reach of one bounded request instead
 * of being hidden behind a second one.
 */
function logsLimitOf(raw: string | null): number {
    if (raw === null || raw.trim() === '') {
        return DEFAULT_LOG_LIMIT;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_LOG_LIMIT;
    }

    return Math.min(Math.max(Math.trunc(parsed), 1), LOG_RING_CAPACITY);
}

/**
 * The sequence the answer must start *after*. Absent or blank opens on the
 * **newest** entries — a watch view starts on the tail, the one departure
 * `GET /v1/audit`'s cursor semantics take; a whole number ≥ 0 resumes behind
 * it; anything else is a `422` naming `cursor`, because a cursor no answer of
 * this route carried is the caller's bug rather than a licence to answer a
 * page the caller already has.
 */
function logsCursorOf(raw: string | null): number | 'tail' | null {
    if (raw === null || raw.trim() === '') {
        return 'tail';
    }

    if (!/^[0-9]{1,15}$/.test(raw.trim())) {
        return null;
    }

    return Number(raw.trim());
}

/**
 * The `422` an unusable `cursor` owes: the field is named and the fix is
 * stated; the received value appears nowhere, since a cursor is caller-supplied
 * text with no business being echoed into an answer the panel renders.
 */
function cursorIssue(): HttpResponse {
    const issues: FieldIssue[] = [{
        field: 'cursor',
        remediation: 'send a seq an earlier answer carried, or omit it to read the newest entries',
    }];

    return validationResponse(issues);
}

/**
 * Answer `GET /v1/logs` with the retained stream: memory and the configuration
 * document only, so **no store check refuses it**, and no truncation path — an
 * over-large page is the transport's inherited `500 response-too-large`.
 */
async function handleLogsRead(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    // Validate before any read, so a client error stays one on a broken disk.
    const cursor = logsCursorOf(request.url.searchParams.get('cursor'));
    if (cursor === null) {
        return cursorIssue();
    }

    const limit = logsLimitOf(request.url.searchParams.get('limit'));
    const config = await readConfig(context);
    const retained = context.log.retained();
    const page = cursor === 'tail'
        ? retained.slice(-limit)
        : retained.filter((entry) => entry.seq > cursor).slice(0, limit);

    return {
        status: STATUS.ok,
        body: {
            entries: page,
            startedAt: context.startedAt,
            intervalMs: config.intervalMs,
        },
    };
}

/** Read the retained log lines, never writing. */
export const logsRoute: Route = {
    method: 'GET',
    path: LOGS_PATH,
    handler: (context, request) => handleLogsRead(context, request),
};
