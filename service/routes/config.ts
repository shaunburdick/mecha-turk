/**
 * `GET /v1/config` and `PUT /v1/config` — the operator's configuration
 * surface (contract §2.1).
 */

import {
    CONFIG_FILE,
    configFromStore,
    parseStoredConfig,
    readStoredConfig,
    validateConfig,
    validationResponse,
} from '../config.ts';
import { configSchema } from '../config-schema.ts';
import { appendConfigApplied, appendConfigRefused, configChanges } from '../config-audit.ts';
import {
    advanceConfigPromptBaseline,
    recordConfigPromptChanges,
    runConfigPromptChain,
} from '../config-prompt-observe.ts';
import { STATUS, storageUnavailableResponse } from '../http.ts';
import type { ServiceConfig } from '../config.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path of the configuration resource. */
export const CONFIG_PATH = '/v1/config';

/**
 * Answer `GET /v1/config` with the effective configuration **and its
 * declaration** (006 FR-020, contract §1). The envelope widens additively, so
 * a reader that ignores the three new members still gets the document it got
 * before, and `defaultsApplied` renders a pre-upgrade document's missing rows
 * as *default* rather than configured facts (FR-028, data-model §2.1). The
 * read goes through `readStoredConfig` rather than `configFromStore` because
 * a configuration that was set aside has to read as set aside on every read,
 * not only on the one that happened to observe it.
 */
async function handleGetConfig(context: RouteContext): Promise<HttpResponse> {
    if (context.store === null) {
        return storageUnavailableResponse();
    }

    const read = await readStoredConfig({ store: context.store, log: context.log });

    return {
        status: STATUS.ok,
        body: {
            config: read.config,
            fields: configSchema(),
            source: read.source,
            defaultsApplied: read.defaultsApplied,
        },
    };
}

/**
 * Read → observe → write → record → advance, as **one task on the
 * configuration prompt chain** (004 FR-088; plan D8's shape). Holding the
 * chain makes FR-088's *exactly one audit row per change* a property of
 * ordering: the cycle's observation lands entirely before this write or
 * entirely after it. The pre-write observation claims a hand edit the cycle
 * has not seen; the post-write advance teaches the lane what the row
 * recorded, so the next cycle re-reports nothing.
 */
async function runConfigWrite(input: {
    /** Open store; the null check lives at the handler's own entry. */
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The validated document about to be written. */
    readonly candidate: ServiceConfig;
}): Promise<boolean> {
    const { store, log, candidate } = input;

    return await runConfigPromptChain(store, async () => {
        const previous = configFromStore(await store.readJson(CONFIG_FILE, parseStoredConfig), log);
        await recordConfigPromptChanges({ store, log, config: previous.config, actor: 'service' });
        const changes = configChanges(previous.config, candidate);

        await store.writeJson(CONFIG_FILE, candidate);
        // An accepted write applies its level *before* the answer is
        // sent, so the first line after the acknowledgement is judged at the
        // new threshold. A refused write never reaches here, so it moves
        // nothing.
        log.setLevel(candidate.logLevel);
        // A no-op appends nothing; a change appends exactly one
        // row, after the durable write, and reports a failed append as
        // `auditWritten: false` rather than undoing a write already on disk.
        const wasAppended =
            changes.length === 0 || await appendConfigApplied({ store, log, changes });
        await advanceConfigPromptBaseline({ store, log, config: candidate });

        return wasAppended;
    });
}

/**
 * Answer `PUT /v1/config` with the persisted configuration. Validation runs
 * before any storage access, so a client error stays a client error even
 * while the disk is broken (FR-039). Both of 006's additions ride that
 * ordering (contract §4): a refusal records **one** value-free
 * `config.changed` row and still answers `422`, and an accepted write
 * compares field by field first so a no-op answers *already saved* with
 * **no** row — the row lands **after** the durable write, never before it
 * or as a reason to roll it back.
 */
async function handlePutConfig(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const validation = validateConfig(request.body);
    if (!validation.ok) {
        // FR-072: one row per refusal, written before the answer and carrying
        // no submitted value — this module never sees the submission, only the
        // issue list the validator built from the declaration.
        await appendConfigRefused({ store: context.store, log: context.log, issues: validation.issues });

        return validationResponse(validation.issues);
    }

    if (context.store === null) {
        return storageUnavailableResponse();
    }

    const wasAppended = await runConfigWrite({
        store: context.store,
        log: context.log,
        candidate: validation.config,
    });

    return { status: STATUS.ok, body: { config: validation.config, auditWritten: wasAppended } };
}

/** Read the effective configuration. */
export const configRoute: Route = {
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
