/**
 * The service's route table.
 */

import { putAccountProfileRoute } from './account-profile.ts';
import { accountRemovalRoute, listAccountsRoute, rotateTokenRoute } from './accounts.ts';
import { auditRoute } from './audit.ts';
import { configRoute, putConfigRoute } from './config.ts';
import { eventHistoryRoute, pendingEventsRoute } from './events.ts';
import { abandonRoute, blockedRoute, dispatchedRoute, reserveRoute } from './dispatch.ts';
import { bindingsRoute, putBindingsRoute } from './bindings.ts';
import { healthRoute } from './health.ts';
import { logsRoute } from './logs.ts';
import { requeueRunRoute, resolveRunRoute, retryRunRoute, verificationRoute } from './run-ops.ts';
import { statusRoute } from './status.ts';
import { verifyRoute } from './verify.ts';
import type { Route } from './types.ts';

/** Every route the service answers, in declaration order. */
export const ROUTES: readonly Route[] = [
    healthRoute,
    configRoute,
    putConfigRoute,
    statusRoute,
    logsRoute,
    listAccountsRoute,
    bindingsRoute,
    putBindingsRoute,
    eventHistoryRoute,
    pendingEventsRoute,
    auditRoute,
    verifyRoute,
    rotateTokenRoute,
    putAccountProfileRoute,
    accountRemovalRoute,
    reserveRoute,
    dispatchedRoute,
    abandonRoute,
    blockedRoute,
    retryRunRoute,
    requeueRunRoute,
    resolveRunRoute,
    verificationRoute,
];
