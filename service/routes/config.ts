/**
 * `GET /v1/config` and `PUT /v1/config` — the operator's configuration
 * surface (contract §2.1).
 *
 * `PUT` validates the whole document before a single byte is written: a
 * rejected body answers `422 validation` with one issue per bad field, while a
 * valid one replaces `config.json` atomically. Both routes degrade to
 * `503 storage-unavailable` when the store could not be opened, which is how
 * an unwritable data directory surfaces as the documented setup prerequisite
 * failure instead of a silent default (FR-039).
 */

import { CONFIG_FILE, configFromStore, parseStoredConfig, validateConfig, validationResponse } from '../config.ts';
import { STATUS, storageUnavailableResponse } from '../http.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceConfig } from '../config.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path of the configuration resource. */
export const CONFIG_PATH = '/v1/config';

/**
 * Answer `GET /v1/config` with the effective configuration.
 *
 * A fresh store has no `config.json`, so the defaults answer — the same
 * document `PUT` would persist if the operator chose to edit it.
 *
 * @param context - Route context carrying the open store.
 * @returns The stored configuration, its defaults, or the 503.
 */
async function handleGetConfig(context: RouteContext): Promise<HttpResponse> {
    if (context.store === null) {
        return storageUnavailableResponse();
    }

    const result = await context.store.readJson(CONFIG_FILE, parseStoredConfig);
    const config: ServiceConfig = configFromStore(result, context.log);

    return { status: STATUS.ok, body: { config } };
}

/**
 * Answer `PUT /v1/config` with the persisted configuration.
 *
 * Validation runs before any storage access: a client error stays a client
 * error even while the disk is broken, and no partial document is ever
 * written (FR-039 reports every failure explicitly, not the first one).
 *
 * @param context - Route context carrying the open store.
 * @param request - The full replacement document.
 * @returns The stored configuration, or the field-level 422.
 */
async function handlePutConfig(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const validation = validateConfig(request.body);
    if (!validation.ok) {
        return validationResponse(validation.issues);
    }

    if (context.store === null) {
        return storageUnavailableResponse();
    }

    await context.store.writeJson(CONFIG_FILE, validation.config);

    return { status: STATUS.ok, body: { config: validation.config } };
}

/** Read the effective configuration. */
export const getConfigRoute: Route = {
    method: 'GET',
    path: CONFIG_PATH,
    handler: (context) => handleGetConfig(context),
};

/** Replace the configuration after full validation. */
export const putConfigRoute: Route = {
    method: 'PUT',
    path: CONFIG_PATH,
    handler: (context, request) => handlePutConfig(context, request),
};
