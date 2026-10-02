/**
 * The service's route table.
 *
 * Routes are matched by method and path — either an exact path or a `:name`
 * pattern — with exact routes preferred over parameterised ones, so nothing
 * undocumented answers: anything not listed here answers `404 not-found`, and
 * a known target reached with the wrong method answers `405 method-not-allowed`
 * with an `Allow` header covering every method declared for it (contract §1
 * method set, §4 catalog).
 *
 * Literal routes are declared before parameterised ones as a readability
 * convention; precedence itself is decided by the pipeline, not by order.
 *
 * **The 003 run-scoped operations all share the `/v1/events/:correlationId/`
 * prefix**, and they are the only routes that use a path parameter beside the
 * account routes. All eight are registered together so that the surface a panel
 * may call is readable in one place — a missing registration would answer `404`
 * for an operation that exists, which is exactly the kind of gap that only shows
 * up once a panel needs it.
 */

import { putAccountProfileRoute } from './account-profile.ts';
import { deleteAccountRoute, listAccountsRoute, rotateTokenRoute } from './accounts.ts';
import { auditRoute } from './audit.ts';
import { getConfigRoute, putConfigRoute } from './config.ts';
import { eventHistoryRoute, pendingEventsRoute } from './events.ts';
import { abandonRoute, blockedRoute, dispatchedRoute, reserveRoute } from './dispatch.ts';
import { getBindingsRoute, putBindingsRoute } from './bindings.ts';
import { healthRoute } from './health.ts';
import { requeueRunRoute, resolveRunRoute, retryRunRoute, verificationRoute } from './run-ops.ts';
import { statusRoute } from './status.ts';
import { verifyRoute } from './verify.ts';
import type { Route } from './types.ts';

/** Every route the service answers, in declaration order. */
export const ROUTES: readonly Route[] = [
    healthRoute,
    getConfigRoute,
    putConfigRoute,
    statusRoute,
    listAccountsRoute,
    getBindingsRoute,
    putBindingsRoute,
    eventHistoryRoute,
    pendingEventsRoute,
    auditRoute,
    verifyRoute,
    rotateTokenRoute,
    putAccountProfileRoute,
    deleteAccountRoute,
    reserveRoute,
    dispatchedRoute,
    abandonRoute,
    blockedRoute,
    retryRunRoute,
    requeueRunRoute,
    resolveRunRoute,
    verificationRoute,
];
