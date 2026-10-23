/**
 * `GET /health` — the host's readiness probe.
 */

import { STATUS } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { Route, RouteContext } from './types.ts';

/** Extension version this build reports; tests pin it to `package.json`. */
export const SERVICE_VERSION = '0.5.1';

/**
 * Build the ready-probe body.
 */
function healthResponse(context: RouteContext): HttpResponse {
    return {
        status: STATUS.ok,
        body: { status: 'ok', version: SERVICE_VERSION, schemaVersion: context.schemaVersion },
    };
}

/** The readiness route itself. */
export const healthRoute: Route = {
    method: 'GET',
    path: '/health',
    handler: (context) => healthResponse(context),
};
