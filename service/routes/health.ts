/**
 * `GET /health` — the host's readiness probe.
 *
 * The host polls this route until it answers 200 (15 s timeout, then the
 * service is marked `ready`), so it must stay stateless and store-independent:
 * it reports the service's *own* schema version and never touches the data
 * directory. A broken store surfaces through `GET /v1/status` and a 503 from
 * the store-backed routes instead of failing readiness, because the operator
 * needs the panel up to see why setup is incomplete (FR-039).
 */

import { STATUS } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { Route, RouteContext } from './types.ts';

/** Extension version this build reports; tests pin it to `package.json`. */
export const SERVICE_VERSION = '0.1.2';

/**
 * Build the ready-probe body.
 *
 * @returns The `{ status, version, schemaVersion }` response (contract §2.1).
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
