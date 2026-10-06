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
 * one panel parser reads both (the field set is the contract's status row, plus
 * the window-in-force members 002 v1.13.0 added).
 *
 * **`historyScope` rides this grant and adds no route, method, or error code**
 * (002 FR-056, FR-064). Three things this file does for it, each decided rather
 * than defaulted:
 *
 * - **Omission preserves** (FR-057), read from the **raw** submission — the same
 *   rule and the same reason 004's prompt follows, so a client that does not know
 *   the member cannot erase a deliberate choice on an unrelated save, while an
 *   explicit `null` still clears it back to the documented default (FR-062);
 * - **the read path projects the documented default** for a binding that stores
 *   no member, so the operator's surface renders from one source of truth and
 *   never invents a reading of an absent key (FR-055, FR-058; plan H13);
 * - **a mode edit into the look-back arms a bounded catch-up** through FR-023's
 *   one rescan mechanism, and nothing else does (FR-084, FR-085; plan H5, H6).
 *
 * MVP-DEBT: the contract's per-binding `PATCH /v1/bindings/:bindingId` state
 * machine is not implemented — this whole-file grant is the simplest honest
 * surface for a single operator with one panel, and 002 v1.13.0 explicitly does
 * not reopen it.
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

/** Path of the bindings collection. */
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
 *
 * @param bindings - The stored records, as the read answered.
 * @returns The same records, each carrying its effective mode.
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
 *
 * @returns `200 { bindings, status }`, or the documented 503.
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
 *
 * Omission is the only signal a whole-file surface has for "I did not change
 * this", and it means **two different things** here — one per member — so one
 * reader answers both rather than two readers answering the same question:
 *
 * - **`startingPrompt`** — omission means *leave this one alone* (004 FR-014,
 *   gate default #4): the shipped panel builds its rows field-by-field and
 *   cannot know the member exists, so a save from it must never erase an
 *   operator's typed instruction.
 * - **`historyScope`** — omission also means *leave this one alone* (002
 *   FR-057), for the same reason and by the same reasoning. An explicit `null`
 *   is the way to **clear** it back to the documented default (FR-062), so the
 *   two must be told apart.
 *
 * Both have to be read from the **raw** submission: by the time validation has
 * normalised a row, "omitted" and "explicitly cleared" have collapsed to the same
 * absent key, and the whole-file replacement would then erase a deliberate choice
 * on an unrelated save.
 *
 * @param submitted - The raw `bindings` array as it arrived.
 * @returns The ids that left each member out entirely.
 */
function omittedMemberIds(submitted: readonly unknown[]): {
    /** Ids whose row carried no `startingPrompt` key. */
    readonly prompt: ReadonlySet<string>;
    /** Ids whose row carried no `historyScope` key. */
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
 *
 * @returns The document to write: submitted values where a member was sent,
 *   stored values where it was not.
 */
function mergeOmittedMembers(input: {
    /** The validated submission, in submission order. */
    readonly submitted: readonly BindingRecord[];
    /** Ids whose submitted row carried no prompt key. */
    readonly omittedPrompt: ReadonlySet<string>;
    /** Ids whose submitted row carried no history-scope key. */
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
 * the look-back mode (002 FR-084, FR-023).
 *
 * **The one caller of this route's half of the rescan mechanism.** The mechanism
 * is `rescanFrom` — a durable chosen lower bound for one binding's next scan, in
 * the scan-state slot beside `lastScanAt` (plan H5). What this function does is
 * write it, and every decision about *whether* is load-bearing:
 *
 * - **Only for a binding that has completed a scan** (plan H6). A binding with no
 *   completed scan follows its own baseline, which the mode edit changes and
 *   which is the **wider** of the two bounds — `createdAt − 7 days` against
 *   `now − 7 days` — so arming it would narrow a window FR-079 forbids narrowing.
 *   Arming it for the never-scanned case would also be a second rule for one edit.
 * - **Only when the mode actually moved** into `recent-history`. A submission
 *   that resends the mode in force writes **nothing** here — no flag, no window,
 *   no checkpoint (002 FR-085, FR-086).
 * - **Editing to `new-only` writes nothing at all**: no checkpoint cleared, no
 *   window opened, no queued or dispatched run touched. Editing to stop looking
 *   back must not itself cause a look-back (002 FR-085).
 * - **Bounded by construction**: the arm is `now − 604,800,000 ms`, a stamp, and
 *   a member that must hold a parseable stamp cannot ask for everything
 *   (002 FR-060). It deduplicates through the unchanged delivery key and is
 *   page-bounded exactly as a creation-time sweep is (002 FR-019, FR-083).
 *
 * A failed arming is a logged `warn` naming the binding and **never** a rollback
 * of the operator's saved mode: the mode is the durable fact, the catch-up is a
 * consequence of it, and a window rule that reads the mode on the next scan covers
 * the one case the arming exists for (plan H14).
 *
 * @returns How many bindings were armed.
 */
async function armCatchUps(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
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
 * the preserved members, write, then record this submission's own changes with
 * actor `operator`. Reading, writing, and diffing inside one chain is what makes
 * SC-125's "exactly one row per change" hold under a race rather than by luck.
 *
 * **The document is written before the catch-up is armed**, and that order is the
 * one H14 fixes. The operator's saved mode is the durable fact and must stand on
 * its own; the catch-up is a *consequence* of it, computed by the next scan's
 * window rule and merely requested here. Rolling the document back because a
 * derived write failed would discard a choice the operator can see and keep, so
 * a failed arming is recorded rather than raised — and the binding's first scan
 * after the edit still opens at the look-back the mode implies (002 FR-084;
 * plan H6).
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
    readonly omittedPrompt: ReadonlySet<string>;
    /** Ids whose submitted row carried no `historyScope` key. */
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
