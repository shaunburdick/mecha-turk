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
import { readBindings, readBindingsUnobserved } from '../bindings-read.ts';
import { validateBindings, writeBindings } from '../bindings.ts';
import { errorResponse, STATUS, storageUnavailableResponse, validationResponse } from '../http.ts';
import { isRecord } from '../json.ts';
import { recordPromptChanges, runPromptChain } from '../prompt-audit.ts';
import type { HttpResponse } from '../http.ts';
import type { BindingRecord } from '../bindings.ts';
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
 * The binding ids whose submitted row **omitted** the starting-prompt key.
 *
 * Omission is the only signal a whole-file surface has for "I did not change
 * this" (004 FR-014, gate default #4): the shipped panel builds its rows
 * field-by-field and cannot know the member exists, so a save from it must
 * never erase an operator's typed instruction. The distinction has to be read
 * from the **raw** submission — by the time validation has normalised a row,
 * "omitted" and "explicitly cleared" have collapsed to the same absent key.
 *
 * @param submitted - The raw `bindings` array as it arrived.
 * @returns The ids that left the field out entirely.
 */
function omittedPromptIds(submitted: readonly unknown[]): ReadonlySet<string> {
    const omitted = new Set<string>();
    for (const entry of submitted) {
        if (!isRecord(entry)) {
            continue;
        }

        const { bindingId } = entry;
        if (typeof bindingId === 'string' && !Object.hasOwn(entry, 'startingPrompt')) {
            omitted.add(bindingId);
        }
    }

    return omitted;
}

/**
 * Attach the stored prompt to every submitted row that left the field out.
 *
 * @param input - The validated rows, the ids that omitted the field, and the
 *   stored document read fresh inside the same chain as the write.
 * @returns The document to write: submitted values where the field was sent,
 *   stored values where it was not.
 */
function mergePrompts(input: {
    /** The validated submission, in submission order. */
    readonly submitted: readonly BindingRecord[];
    /** Ids whose submitted row carried no prompt key. */
    readonly omitted: ReadonlySet<string>;
    /** The stored document, read inside the write chain. */
    readonly stored: readonly BindingRecord[];
}): readonly BindingRecord[] {
    const storedById = new Map(input.stored.map((binding) => [binding.bindingId, binding]));

    return input.submitted.map((binding) => {
        if (!input.omitted.has(binding.bindingId)) {
            return binding;
        }

        const previous = storedById.get(binding.bindingId)?.startingPrompt;

        return previous === undefined ? binding : { ...binding, startingPrompt: previous };
    });
}

/**
 * Answer `PUT /v1/bindings` by replacing the stored bindings, validated.
 *
 * Every field the poll loop needs is validated before one byte is written:
 * the repository is a GitHub `owner/name`, the project id is parseable, the
 * worktree option is one of the documented shapes, every referenced account
 * actually exists in the custody directory, and any submitted starting prompt
 * passes the one prompt validator. Binding ids must be unique; the list is
 * capped. A refusal names the field and the remediation, never the received
 * value — and a refusal writes **nothing**: no file, no prompt change row
 * (004 FR-027, AC-132/AC-133).
 *
 * The write itself runs as one task on the prompt-observation chain (plan C2):
 * read the stored document fresh, record any hand edit it carries with actor
 * `service`, merge the preserved prompts, write, then record this submission's
 * own changes with actor `operator`. Reading, writing, and diffing inside one
 * chain is what makes SC-125's "exactly one row per change" hold under a race
 * rather than by luck.
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
        // The contract's `422 validation` body: every `field: remediation`
        // pair in the message and the structured list alike. An object list
        // stringified into the message would have read `[object Object]`.
        return validationResponse(validation.issues);
    }

    const body = request.body as { readonly bindings: readonly unknown[] };
    const omitted = omittedPromptIds(body.bindings);
    const bindings = await runPromptChain(store, async () => {
        const stored = await readBindingsUnobserved({ store, log: context.log });
        await recordPromptChanges({ store, log: context.log, bindings: stored, actor: 'service' });
        const merged = mergePrompts({ submitted: validation.bindings, omitted, stored });
        await writeBindings({ store, bindings: merged });
        await recordPromptChanges({ store, log: context.log, bindings: merged, actor: 'operator' });

        return merged;
    });

    // The answer carries status rows too: the panel repaints its binding rows
    // from whatever a grant answered, and a bare list would blank the scan
    // lines the operator was just reading.
    const status = await readStatusRows({ store, log: context.log, bindings });

    return { status: STATUS.ok, body: { bindings, status } };
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
