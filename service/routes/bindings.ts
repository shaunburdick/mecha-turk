/**
 * Binding management routes (MVP task M3).
 */

import { observeAccountPromptChanges } from '../account-prompt-audit.ts';
import { listAccountsUnobserved } from '../accounts/store.ts';
import { effectiveHistoryScope, lookBackMs } from '../bindings-history-scope.ts';
import { readBindings, readBindingsUnobserved } from '../bindings-read.ts';
import { validateBindings, writeBindings } from '../bindings.ts';
import { errorResponse, STATUS, storageUnavailableResponse, validationResponse } from '../http.ts';
import { recordHistoryScopeChanges, runHistoryScopeChain } from '../history-scope-audit.ts';
import { nowIso } from '../../src/ids.ts';
import { isRecord } from '../json.ts';
import { readCycleConfig } from '../poll/cycle-config.ts';
import { inQueueChain } from '../poll/runs-document.ts';
import {
    bindingScanOf,
    readScanState,
    serializeScan,
    withBindingScanState,
    writeScanState,
} from '../poll/scan.ts';
import { recordPromptChanges, runPromptChain } from '../prompt-audit.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceLogger } from '../log.ts';
import type { BindingRecord, BindingValidation } from '../bindings.ts';
import type { Account } from '../accounts/model.ts';
import type { ServiceStore } from '../store/index.ts';
import { readStatusRows } from './events.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

export const BINDINGS_PATH = '/v1/bindings';

/**
 * Project the documented default onto every binding that stores no member
 * (002 FR-055, FR-058; plan H13).
 *
 * **A projection, not a rewrite.** The stored record keeps omitting the key — that
 * is what makes a binding written before this field byte-identical to one whose
 * field was cleared — while the answer states what the binding will do, so the
 * operator's surface renders from one source of truth and never invents its own
 * reading of an absent member.
 */
function withEffectiveScopes(bindings: readonly BindingRecord[]): readonly BindingRecord[] {
    return bindings.map((binding) => ({ ...binding, historyScope: effectiveHistoryScope(binding.historyScope) }));
}

/**
 * Answer `GET /v1/bindings` with the stored bindings and their scan status.
 *
 * A missing file is the fresh-install state and answers an empty list; a
 * file the parser could not fully read is skipped by the store's own
 * quarantine report in the log, so the panel always gets a usable list. The
 * status rows are what makes the service-side failures (an unusable
 * credential, a scan that never ran) visible on the binding rows instead of
 * only in the service log.
 */
async function handleGetBindings(context: RouteContext): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const stored = await readBindings({ store, log: context.log });
    // The overlap the poll loop widens windows by, so the row's `windowStart` is
    // the window the next scan will open (002 FR-092).
    const { overlapMs } = await readCycleConfig({ store, log: context.log });
    const status = await readStatusRows({ store, log: context.log, bindings: stored, overlapMs });

    return { status: STATUS.ok, body: { bindings: withEffectiveScopes(stored), status } };
}

/**
 * Which submitted rows **omitted** a member entirely, keyed by binding id.
 * Omission means *leave this one alone* for both `startingPrompt` (004
 * FR-014, gate default #4) and `historyScope` (002 FR-057), while an
 * explicit `null` clears the latter (FR-062) — so both are read from the
 * **raw** submission, before validation collapses omitted and explicitly
 * cleared into the same absent key and the replacement would erase a
 * deliberate choice on an unrelated save.
 */
function omittedMemberIds(submitted: readonly unknown[]): {
    readonly prompt: ReadonlySet<string>;
    readonly historyScope: ReadonlySet<string>;
} {
    const prompt = new Set<string>();
    const historyScope = new Set<string>();
    for (const entry of submitted) {
        if (!isRecord(entry)) {
            continue;
        }

        const { bindingId } = entry;
        if (typeof bindingId !== 'string') {
            continue;
        }

        if (!Object.hasOwn(entry, 'startingPrompt')) {
            prompt.add(bindingId);
        }

        if (!Object.hasOwn(entry, 'historyScope')) {
            historyScope.add(bindingId);
        }
    }

    return { prompt, historyScope };
}

/**
 * Attach the stored **prompt** and **history scope** to every row that left them
 * out.
 *
 * Both members are *omission-preserves*, and neither is a patch: a row that
 * omitted a member gets the **stored** value for it, so a client that does not
 * know the member cannot erase a deliberate choice on its next unrelated save
 * (004 FR-014, 002 FR-057). A row that sent the member — including one that sent
 * `null` to clear it — passes through untouched.
 */
function mergeOmittedMembers(input: {
    /** The validated submission, in submission order. */
    readonly submitted: readonly BindingRecord[];
    readonly omittedPrompt: ReadonlySet<string>;
    readonly omittedScope: ReadonlySet<string>;
    /** The stored document, read inside the write chain. */
    readonly stored: readonly BindingRecord[];
}): readonly BindingRecord[] {
    const storedById = new Map(input.stored.map((binding) => [binding.bindingId, binding]));

    return input.submitted.map((binding) => {
        const isPromptKept = input.omittedPrompt.has(binding.bindingId);
        const isScopeKept = input.omittedScope.has(binding.bindingId);
        if (!isPromptKept && !isScopeKept) {
            return binding;
        }

        const previous = storedById.get(binding.bindingId);

        return {
            ...binding,
            // An absent stored member is the documented default, which is also what
            // an absent key means — so preserving it preserves *nothing*, and
            // spelling it out here would write a member the operator never chose.
            ...(isPromptKept && previous?.startingPrompt !== undefined && { startingPrompt: previous.startingPrompt }),
            ...(isScopeKept && previous?.historyScope !== undefined && { historyScope: previous.historyScope }),
        };
    });
}

/**
 * Arm the bounded look-back catch-up for every binding this grant moved into
 * the look-back mode (002 FR-084, FR-023). Only for a binding that has
 * completed a scan and only when the mode actually moved (plan H6; FR-085,
 * FR-086) — editing to `new-only` writes nothing, because editing to stop
 * looking back must not itself cause a look-back (FR-085). A failed arming
 * warns and never rolls back the operator's saved mode: the mode is the
 * durable fact (plan H14).
 */
async function armCatchUps(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The document as written, which is what the arming is derived from. */
    readonly written: readonly BindingRecord[];
    /** The document as it stood before this grant. */
    readonly stored: readonly BindingRecord[];
    /** RFC 3339 stamp the catch-up's lower bound is measured from. */
    readonly at: string;
}): Promise<number> {
    const before = new Map(input.stored.map((binding) => [binding.bindingId, binding]));
    const moved = input.written.filter((binding) =>
        effectiveHistoryScope(binding.historyScope) === 'recent-history'
        && effectiveHistoryScope(before.get(binding.bindingId)?.historyScope) !== 'recent-history');
    if (moved.length === 0) {
        return 0;
    }

    const lookBack = lookBackMs();
    if (lookBack === null) {
        input.log.warn('history-mode catch-up was not armed: the declared look-back is outside its own bound');

        return 0;
    }

    const armedFrom = new Date(Date.parse(input.at) - lookBack).toISOString();

    return await serializeScan(async () => {
        const state = await readScanState(input);
        let next = state;
        let armed = 0;
        for (const binding of moved) {
            const slot = bindingScanOf(state, binding.bindingId);
            // Plan H6: a binding that has never completed a scan is left on its
            // own baseline, which is the wider bound. `lastScanAt` is the whole
            // test — `forceReplay` clears it too, and a recovered binding's next
            // scan is a replay whose baseline already covers the catch-up.
            if (slot.lastScanAt === null) {
                continue;
            }

            next = withBindingScanState({
                state: next,
                bindingId: binding.bindingId,
                slot: { ...slot, rescanFrom: armedFrom },
            });
            armed += 1;
        }

        if (armed > 0) {
            await writeScanState({ store: input.store, state: next });
        }

        return armed;
    });
}

interface CustodyVerdict {
    /** The accounts as the directory held them, for the post-validation observation. */
    readonly accounts: readonly Account[];
    readonly validation: BindingValidation;
}

/**
 * Read the account custody and validate the submitted body against it. The
 * directory read runs **before** validation — an account the custody never
 * verified is one of the rules being checked — but it is deliberately the
 * *unobserved* reader: the prompt-change observation `listAccounts` would
 * fold in is an audit append, and a refusal writes nothing (004 AC-133).
 * The observation belongs to the caller and runs only once the write is
 * certain to happen.
 */
async function readCustodyAndValidate(input: {
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
 * Persist one whole-file grant, on the queue chain the gate shares — two
 * chains, outermost first, and the order is load-bearing (003 FR-076,
 * constitution II). Joining the gate's chain is what makes an operator's
 * policy change and the gate's read-and-mint one serialized pair, so a
 * tightening can no longer land between the read of `allowedUsers` and the
 * reservation it authorizes. The document is written before the catch-up is
 * armed, so a failed arming is recorded rather than discarding a choice the
 * operator can see and keep (002 FR-084; plan H14).
 */
async function writeGrant(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    /** The validated submission, in submission order. */
    readonly submitted: readonly BindingRecord[];
    readonly omittedPrompt: ReadonlySet<string>;
    readonly omittedScope: ReadonlySet<string>;
    /** RFC 3339 stamp pinned before the write, so the catch-up is measured from it. */
    readonly at: string;
}): Promise<readonly BindingRecord[]> {
    const { store, log, submitted, omittedPrompt, omittedScope, at } = input;

    return await inQueueChain(async () => await runPromptChain(store, async () => await runHistoryScopeChain(
        store,
        async () => {
            const stored = await readBindingsUnobserved({ store, log });
            // The stored document is observed with actor `service` **before** the
            // write, so a hand edit the operator made outside the panel is
            // recorded once here and not again by the operator-side diff below
            // (002 FR-086's second path; plan H12's "exactly one row per change").
            await recordPromptChanges({ store, log, bindings: stored, actor: 'service' });
            await recordHistoryScopeChanges({ store, log, bindings: stored, actor: 'service' });
            const merged = mergeOmittedMembers({ submitted, omittedPrompt, omittedScope, stored });
            await writeBindings({ store, bindings: merged });
            await recordPromptChanges({ store, log, bindings: merged, actor: 'operator' });
            await recordHistoryScopeChanges({ store, log, bindings: merged, actor: 'operator' });
            // Document first, then the arming — the arming is derived from what
            // was just written, so it can only be computed once the write is
            // durable (plan H14).
            await armCatchUps({ store, log, written: merged, stored, at });

            return merged;
        },
    )));
}

/**
 * Answer `PUT /v1/bindings` by replacing the stored bindings, validated.
 * A refusal names the field and the remediation, never the received value,
 * and writes **nothing** — the custody read that validates account existence
 * observes only once the write is certain to happen (004 FR-027,
 * AC-132/AC-133). The write is one task on the queue chain, and the outer
 * chain is what keeps an allow-list edit and the authorization gate's
 * read-and-mint from interleaving (plan C2, {@link writeGrant}).
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

    const omitted = omittedMemberIds((request.body as { readonly bindings: readonly unknown[] }).bindings);
    const bindings = await writeGrant({
        store,
        log: context.log,
        submitted: custody.validation.bindings,
        omittedPrompt: omitted.prompt,
        omittedScope: omitted.historyScope,
        // Pinned **before** the write so the catch-up's lower bound is measured
        // from the moment the operator's decision was taken, not from whenever the
        // serialized write finished (plan H14).
        at: nowIso(),
    });

    // The answer carries status rows too: the panel repaints its binding rows
    // from whatever a grant answered, and a bare list would blank the scan
    // lines the operator was just reading — including the window-in-force line
    // that explains a catch-up the operator just asked for (002 FR-092).
    const { overlapMs } = await readCycleConfig({ store, log: context.log });
    const status = await readStatusRows({ store, log: context.log, bindings, overlapMs });

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
