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

import { observeAccountPromptChanges } from '../account-prompt-audit.ts';
import { listAccountsUnobserved } from '../accounts/store.ts';
import { readBindings, readBindingsUnobserved } from '../bindings-read.ts';
import { validateBindings, writeBindings } from '../bindings.ts';
import { errorResponse, STATUS, storageUnavailableResponse, validationResponse } from '../http.ts';
import { isRecord } from '../json.ts';
import { inQueueChain } from '../poll/runs-document.ts';
import { recordPromptChanges, runPromptChain } from '../prompt-audit.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceLogger } from '../log.ts';
import type { BindingRecord, BindingValidation } from '../bindings.ts';
import type { Account } from '../accounts/model.ts';
import type { ServiceStore } from '../store/index.ts';
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

/** What one custody read produced beside the verdict it fed. */
interface CustodyVerdict {
    /** The accounts as the directory held them, for the post-validation observation. */
    readonly accounts: readonly Account[];
    /** The verdict over the submitted body. */
    readonly validation: BindingValidation;
}

/**
 * Read the account custody and validate the submitted body against it.
 *
 * The directory read runs **before** validation — an account the custody
 * never verified is one of the rules being checked — but it is deliberately
 * the *unobserved* reader: the prompt-change observation a plain
 * `listAccounts` would fold in is an audit append, and a refusal writes
 * nothing (004 AC-133; the same order the account profile route keeps, which
 * validates before it observes). The observation the read implies belongs to
 * the caller, and runs only once the write is certain to happen.
 *
 * @returns The custody as it stood plus the verdict over the body.
 */
async function readCustodyAndValidate(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger for the custody read's quarantine lines. */
    readonly log: ServiceLogger;
    /** The PUT body exactly as it arrived. */
    readonly body: unknown;
}): Promise<CustodyVerdict> {
    const accounts = await listAccountsUnobserved(input.store, input.log);
    const known = new Set<string>(accounts.map((account) => account.numericUserId));

    return {
        accounts,
        validation: validateBindings({
            raw: input.body,
            hasAccount: (numericUserId: string) => known.has(numericUserId),
        }),
    };
}

/**
 * Persist one whole-file grant, on the queue chain the gate shares.
 *
 * **Two chains, outermost first, and the order is load-bearing** (003 FR-076,
 * constitution II). `inQueueChain` is the chain every queue-or-run mutation
 * serializes onto — including the authorization gate, whose read-policy →
 * mint-token → persist sequence runs as one task inside it. Joining that chain
 * here is what makes an operator's policy change and the gate's read-and-mint
 * **one serialized pair**: a tightening can no longer land between the gate's
 * read of `allowedUsers` and the reservation that read authorizes, which was the
 * window in which `host.startSession()` could fire under a list the operator had
 * just revoked. The prompt-observation chain nests inside it, never the other
 * way round, so there is no lock order to invert.
 *
 * Inside, one task on the prompt-observation chain: read the stored
 * document fresh, record any hand edit it carries with actor `service`, merge
 * the preserved prompts, write, then record this submission's own changes with
 * actor `operator`. Reading, writing, and diffing inside one chain is what makes
 * SC-125's "exactly one row per change" hold under a race rather than by luck.
 *
 * @returns The rows as stored, which is what the answer echoes.
 */
async function writeGrant(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The validated submission, in submission order. */
    readonly submitted: readonly BindingRecord[];
    /** Ids whose submitted row carried no `startingPrompt` key. */
    readonly omitted: ReadonlySet<string>;
}): Promise<readonly BindingRecord[]> {
    const { store, log, submitted, omitted } = input;

    return await inQueueChain(async () => await runPromptChain(store, async () => {
        const stored = await readBindingsUnobserved({ store, log });
        await recordPromptChanges({ store, log, bindings: stored, actor: 'service' });
        const merged = mergePrompts({ submitted, omitted, stored });
        await writeBindings({ store, bindings: merged });
        await recordPromptChanges({ store, log, bindings: merged, actor: 'operator' });

        return merged;
    }));
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
 * value — and a refusal writes **nothing**: no file, no prompt change row, no
 * account observation row either — the custody read that validates account
 * existence observes only once the write is certain to happen (004 FR-027,
 * AC-132/AC-133).
 *
 * The write itself is one task on the queue chain, which nests one task on the
 * prompt-observation chain (plan C2, {@link writeGrant}) — and the **outer**
 * chain is what keeps an operator's allow-list edit and the authorization gate's
 * read-and-mint from interleaving.
 *
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

    const custody = await readCustodyAndValidate({ store, log: context.log, body: request.body });
    if (!custody.validation.ok) {
        // The contract's `422 validation` body: every `field: remediation`
        // pair in the message and the structured list alike. An object list
        // stringified into the message would have read `[object Object]`.
        return validationResponse(custody.validation.issues);
    }

    // Only a submission that will actually be written earns the observation
    // its read implied: the whole custody directory, exactly as `listAccounts`
    // would have observed it, so a hand edit outside the panel is still
    // recorded exactly once with actor `service`.
    await observeAccountPromptChanges({
        store,
        log: context.log,
        accounts: custody.accounts,
        complete: true,
        actor: 'service',
    });

    const bindings = await writeGrant({
        store,
        log: context.log,
        submitted: custody.validation.bindings,
        omitted: omittedPromptIds((request.body as { readonly bindings: readonly unknown[] }).bindings),
    });

    // The answer carries status rows too: the panel repaints its binding rows
    // from whatever a grant answered, and a bare list would blank the scan
    // lines the operator was just reading.
    const status = await readStatusRows({ store, log: context.log, bindings });

    return { status: STATUS.ok, body: { bindings, status } };
}

/** Read the stored bindings, credential-free. */
export const bindingsRoute: Route = {
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
