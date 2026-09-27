/**
 * The service's route table.
 *
 * Routes are matched by exact method and path — there is no prefix logic, no
 * trailing-slash tolerance, and no undocumented route: anything not listed
 * here answers `404 not-found`, and a known path reached with the wrong
 * method answers `405 method-not-allowed` with an `Allow` header (contract §1
 * method set). Wave 2+ append their routes to this array.
 */

import { healthRoute } from './health.ts';
import type { Route } from './types.ts';

/** Every route the service answers, in declaration order. */
export const ROUTES: readonly Route[] = [healthRoute];
