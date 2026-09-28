/**
 * Binding management routes (MVP task M3 — re-cut 2026-09-27).
 *
 * The panel keeps the bindings list and grants it whole: `GET /v1/bindings`
 * returns the stored list plus the per-binding scan status (credential-free
 * by construction — bindings carry account identities, never tokens, and the
 * status rows carry scan stamps, skip reasons, and pending counts),
 * `PUT /v1/bindings` replaces it after field validation and an
 * account-existence check. The account-delete guard in `accounts/store.ts`
 * reads the same file, so a binding disabled there stays disabled here.
 *
 * The status rows are the same shape the relay's pending answer carries, so
 * one panel parser reads both (the field set is the contract's status row,
 * unchanged).
 *
 * MVP-DEBT: the contract's per-binding `PATCH /v1/bindings/:bindingId` state
 * machine is not implemented — this whole-file grant is the simplest honest
 * surface for a single operator with one panel.
 */

import { listAccounts } from '../accounts/store.ts';
import { readBindings, validateBindings, writeBindings } from '../bindings.ts';
import { errorResponse, STATUS, storageUnavailableResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import { readStatusRows } from './events.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path of the bindings collection. */
export const BINDINGS_PATH = '/v1/bindings';

/**
 * Answer `GET /v1/bindings` with the stored bindings and their scan status.
 *
 * A missing file is the fresh-install state and answers an empty list; a
 * file the parser could not fully read is skipped by the store's own
 * quarantine report in the log, so the panel always gets a usable list. The
 * status rows are what makes the service-side failures (an unusable
 * credential, a scan that never ran) visible on the binding rows instead of
 * only in the service log.
 *
 * @param context - Route context carrying the open store.
 * @returns `200 { bindings, status }`, or the documented 503.
 */
async function handleGetBindings(context: RouteContext): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const bindings = await readBindings({ store, log: context.log });
    const status = await readStatusRows({ store, log: context.log, bindings });

    return { status: STATUS.ok, body: { bindings, status } };
}

/**
 * Answer `PUT /v1/bindings` by replacing the stored bindings, validated.
 *
 * Every field the poll loop needs is validated before one byte is written:
 * the repository is a GitHub `owner/name`, the project id is parseable, the
 * worktree option is one of the documented shapes, and every referenced
 * account actually exists in the custody directory (its credential is what
 * polls). Binding ids must be unique; the list is capped. A refusal names
 * the field and the remediation, never the received value.
 *
 * @param context - Route context carrying the open store.
 * @param request - The routed request carrying the full replacement body.
 * @returns `200 { bindings, status }` after the write, or the field-level 422.
 */
async function handlePutBindings(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
        return errorResponse(STATUS.validation, {
            code: 'validation',
            message: 'body: send `{ bindings: [...] }` holding every binding the panel keeps',
        });
    }

    // The account-existence check runs against one directory read, so the
    // loop can never be pointed at an account the custody never verified.
    const accounts = await listAccounts(store, context.log);
    const known = new Set<string>(accounts.map((account) => account.numericUserId));

    const validation = validateBindings({
        raw: request.body,
        accountExists: (numericUserId) => known.has(numericUserId),
    });
    if (!validation.ok) {
        return errorResponse(STATUS.validation, {
            code: 'validation',
            message: validation.issues.join('; '),
        });
    }

    await writeBindings({ store, bindings: validation.bindings });
    // The answer carries status rows too: the panel repaints its binding rows
    // from whatever a grant answered, and a bare list would blank the scan
    // lines the operator was just reading.
    const status = await readStatusRows({ store, log: context.log, bindings: validation.bindings });

    return { status: STATUS.ok, body: { bindings: validation.bindings, status } };
}

/** Read the stored bindings, credential-free. */
export const getBindingsRoute: Route = {
    method: 'GET',
    path: BINDINGS_PATH,
    handler: (context) => handleGetBindings(context),
};

/** Replace the stored bindings after full validation. */
export const putBindingsRoute: Route = {
    method: 'PUT',
    path: BINDINGS_PATH,
    handler: (context, request) => handlePutBindings(context, request),
};
