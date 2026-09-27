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
 */

import { deleteAccountRoute, listAccountsRoute, rotateTokenRoute } from './accounts.ts';
import { getConfigRoute, putConfigRoute } from './config.ts';
import { dispatchedEventRoute, pendingEventsRoute } from './events.ts';
import { getBindingsRoute, putBindingsRoute } from './bindings.ts';
import { healthRoute } from './health.ts';
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
    pendingEventsRoute,
    verifyRoute,
    rotateTokenRoute,
    deleteAccountRoute,
    dispatchedEventRoute,
];
