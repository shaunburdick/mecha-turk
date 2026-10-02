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

import {
    CONFIG_FILE,
    configFromStore,
    parseStoredConfig,
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
 * declaration** (006 FR-020, contract §1).
 *
 * The envelope widens additively: `config` is unchanged in name, type, and
 * semantics, so a reader that ignores the three new members still gets the
 * document it got before. `fields` is projected from the same declaration the
 * validator reads, `source` says where `config` came from, and
 * `defaultsApplied` names the documented keys the stored file lacked — a
 * pre-upgrade document therefore renders its missing rows as *default* rather
 * than as configured facts (006 FR-028, data-model §2.1).
 *
 * A fresh store has no `config.json`, so the defaults answer — the same
 * document `PUT` would persist if the operator chose to edit it.
 *
 * @param context - Route context carrying the open store.
 * @returns The envelope above, or the 503 when the store is unusable.
 */
async function handleGetConfig(context: RouteContext): Promise<HttpResponse> {
    if (context.store === null) {
        return storageUnavailableResponse();
    }

    const result = await context.store.readJson(CONFIG_FILE, parseStoredConfig);
    const read = configFromStore(result, context.log);

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
 * configuration prompt chain** (004 FR-088; plan D8's shape, applied to this
 * document).
 *
 * Holding the chain across the whole sequence is what makes FR-088's *exactly
 * one audit row per change* a property of ordering: the cycle's own
 * observation (`readCycleConfig`) runs on the same chain, so it can only run
 * entirely before this write (and sees the document this write is about to
 * replace) or entirely after it (and finds the baseline this function already
 * advanced). The pre-write observation claims a hand edit the cycle has not
 * seen yet — exactly as `PUT /v1/bindings` and the account profile write do —
 * and the post-write advance teaches the lane what the row above already
 * recorded, so the next cycle re-reports nothing.
 *
 * @param input - The open store, its logger, and the validated replacement.
 * @returns `true` when the row (if one was owed) reached disk; `false` when
 *   the append failed, which never rolls the write back (006 FR-070).
 */
async function runConfigWrite(input: {
    /** Open store; the null check lives at the handler's own entry. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
        // FR-033: an accepted write applies its level *before* the answer is
        // sent, so the first line after the acknowledgement is judged at the
        // new threshold. A refused write never reaches here, so it moves
        // nothing.
        log.setLevel(candidate.logLevel);
        // FR-048/FR-071: a no-op appends nothing; a change appends exactly one
        // row, after the durable write, and reports a failed append as
        // `auditWritten: false` rather than undoing a write already on disk.
        const auditWritten =
            changes.length === 0 ? true : await appendConfigApplied({ store, log, changes });
        await advanceConfigPromptBaseline({ store, log, config: candidate });

        return auditWritten;
    });
}

/**
 * Answer `PUT /v1/config` with the persisted configuration.
 *
 * Validation runs before any storage access: a client error stays a client
 * error even while the disk is broken, and no partial document is ever
 * written (FR-039 reports every failure explicitly, not the first one). The
 * two additions 006 makes to this answer (contract §4) are both bounded by
 * that ordering: a refusal records **one** value-free `config.changed` row and
 * still answers `422`; an accepted write compares the candidate with the
 * stored document field by field first, so a no-op answers *already saved*
 * with **no** row at all (FR-048), and a change writes its row **after** the
 * durable write — never before it, never as a reason to roll it back.
 *
 * @param context - Route context carrying the open store.
 * @param request - The full replacement document.
 * @returns The stored configuration and its audit outcome, or the field-level
 *   422.
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

    const auditWritten = await runConfigWrite({
        store: context.store,
        log: context.log,
        candidate: validation.config,
    });

    return { status: STATUS.ok, body: { config: validation.config, auditWritten } };
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
