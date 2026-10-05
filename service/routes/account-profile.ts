/**
 * The account profile write: `PUT /v1/accounts/:numericUserId` and the closed
 * body it reads (005 FR-066, 004 FR-082; contract `account-display-name.md` §2
 * and `layered-prompt.md` §2).
 *
 * This module owns the surface's **one** operator write for the record, split
 * out of [`accounts.ts`](./accounts.ts) so each file keeps one responsibility
 * (AGENTS.md) and the account routes file stays inside its length gate. The
 * path constant and the two refusal/path helpers it shares with the delete and
 * rotation handlers stay in `accounts.ts`, which does not import this module —
 * the dependency runs one way, `index.ts → account-profile.ts → accounts.ts`,
 * so there is no cycle.
 *
 * The body is a **closed set of exactly two members**: an absent member means
 * unchanged, a body carrying neither is refused as a no-op, and any other key
 * is refused — named when it is an ordinary identifier, reported under `body`
 * when the name itself is not safe to echo — always with zero characters of
 * its value echoed. Issues are
 * collected additively in one pass and **any** issue refuses the whole write —
 * nothing observed, nothing written, no `updatedAt`, no audit row (005 §2
 * invariants 4–6; constitution II).
 */

import { nowIso } from '../../src/ids.ts';
import { findSecretLeak } from '../../src/redaction.ts';
import { recordAccountPromptChanges, runAccountPromptChain } from '../account-prompt-audit.ts';
import { STATUS, storageUnavailableResponse, validationResponse, truncatedFieldName } from '../http.ts';
import { isRecord } from '../json.ts';
import { validateStartingPrompt } from '../prompt.ts';
import { toAccountDto, validateDisplayName } from '../accounts/model.ts';
import { readAccountUnobserved, writeAccount } from '../accounts/store.ts';
import type { Account } from '../accounts/model.ts';
import type { FieldIssue, HttpResponse } from '../http.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { guardCredentialRoute } from './credential.ts';
import { ACCOUNT_PATH, pathAccountId, unknownAccountResponse } from './accounts.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** One operator-editable member of a profile body: carried with a value, or absent. */
type ProfileMember<T> =
    | { readonly present: false }
    | { readonly present: true; readonly value: T };

/**
 * The only shape a member name may have to be echoed back in a refusal.
 *
 * The eleven custody and identity keys are ordinary identifiers, so they are
 * still named exactly as the closed-set contract promises; anything else —
 * whitespace, punctuation, control characters, an emoji run, a pasted token —
 * is submitted input of an unknown shape, and a `422` that echoed it would be
 * a reflection surface as well as an unbounded one — the length bound itself
 * rides {@link truncatedFieldName}, applied only once the name is known to be
 * safe to print.
 */
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The closed profile body once every issue has cleared (005 §2). */
interface ProfileBody {
    /** Validated label (`null` clears), or absent = unchanged. */
    readonly displayName: ProfileMember<string | null>;
    /** Validated prompt tier (`null` clears), or absent = unchanged. */
    readonly startingPrompt: ProfileMember<string | null>;
}

/** Result of reading one body as the closed two-member set. */
type ProfileBodyVerdict =
    | { readonly ok: true; readonly body: ProfileBody }
    | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/** What one additive pass over a body accumulates. */
interface ProfileScratch {
    /** Every problem found so far, in body order. */
    readonly issues: FieldIssue[];
    /** Which of the two operator members the body actually carried. */
    readonly carried: Set<string>;
    /** The label, once a valid one has been read. */
    displayName: ProfileMember<string | null>;
    /** The prompt tier, once a valid one has been read. */
    startingPrompt: ProfileMember<string | null>;
}

/**
 * The refusal for a body that carries neither operator-editable member.
 *
 * Absent means *refused*, never "nothing to do": a PUT that silently no-ops on
 * a missing member teaches a client that omitting a field clears or preserves
 * something, and this route promises neither (005 contract §2, invariant 4).
 *
 * @returns The `422 validation` issue naming both members it owes.
 */
function profileBodyRefusal(): FieldIssue {
    return {
        field: 'body',
        remediation: 'supply displayName, startingPrompt, or both — the body carries neither',
    };
}

/**
 * The refusal for a key outside the closed set: the key, never its value.
 *
 * The eleven custody and identity keys are the documented cases and are named
 * by name (005 §2, invariant 6) — naming them is the whole point of a closed
 * whitelist: they are refused *explicitly* rather than merely unreachable.
 * Two kinds of key are reported under `body` instead, each for its own reason:
 * a key that is itself credential-shaped, because the secret rule outranks
 * naming (a member name is submitted input too — 004 FR-024), and a
 * key that is not an ordinary identifier at all, because a name the service
 * cannot vouch for must not be reflected back into the envelope that restates
 * every `field: remediation` pair. An identifier-shaped name is echoed through
 * {@link truncatedFieldName}, so it reaches the answer cut to the shared
 * `MAX_ECHOED_FIELD_CHARS` bound rather than whole.
 *
 * In no branch is the key's **value** read, quoted, or measured — only the
 * member name itself is ever considered, and only to decide what to refuse.
 *
 * @param key - The offending member name, exactly as it arrived.
 * @returns The issue naming the key, or the value-free `body` refusal.
 */
function unexpectedProfileMemberIssue(key: string): FieldIssue {
    const shape = findSecretLeak(key);
    if (shape !== null) {
        return {
            field: 'body',
            remediation: `the body must not carry credential-shaped member names (matched shape: ${shape})`,
        };
    }

    const remediation = 'the account profile body is a closed set — supply displayName, startingPrompt, or both';

    if (!SAFE_FIELD_NAME.test(key)) {
        return { field: 'body', remediation };
    }

    return { field: truncatedFieldName(key), remediation };
}

/**
 * Read one body key into the scratch: validate a known member, refuse an
 * unknown one.
 *
 * Keeping this to one key is what holds the pass under the complexity gate;
 * the pass itself stays a single ordered walk over `Object.keys`, so a `422`
 * still lists every problem the body has (004 FR-027's additive atomicity).
 *
 * @param input - The member name, the parsed body, and the scratch to fill.
 */
function readProfileKey(input: {
    /** The member name, exactly as it arrived. */
    readonly key: string;
    /** The whole parsed body, for the member's value. */
    readonly record: Record<string, unknown>;
    /** Issues, carried-set, and members to fill. */
    readonly scratch: ProfileScratch;
}): void {
    const { key, record, scratch } = input;
    if (key === 'displayName') {
        scratch.carried.add(key);
        const verdict = validateDisplayName(record.displayName);
        if (verdict.ok) {
            scratch.displayName = { present: true, value: verdict.displayName };
        } else {
            scratch.issues.push(verdict.issue);
        }

        return;
    }

    if (key === 'startingPrompt') {
        scratch.carried.add(key);
        const verdict = validateStartingPrompt(record.startingPrompt);
        if (verdict.ok) {
            scratch.startingPrompt = { present: true, value: verdict.prompt };
        } else {
            scratch.issues.push(verdict.issue);
        }

        return;
    }

    scratch.issues.push(unexpectedProfileMemberIssue(key));
}

/**
 * Read a request body as the account profile's **closed** two-member set.
 *
 * One additive pass over the body (004 FR-027's atomicity on this surface):
 * unknown keys and member validation are collected together so a single `422`
 * answers the whole submission, and **any** issue at all refuses the write —
 * nothing is read, written, stamped, or audited once a problem is found
 * (005 contract §2, invariants 4–6).
 *
 * An absent member means unchanged (004 FR-014's omission-preserves posture
 * applied to this record); `null`, `""`, or whitespace-only clears the member
 * they name. `displayName` runs through the shipped six-step
 * {@link validateDisplayName}, `startingPrompt` through the single
 * {@link validateStartingPrompt} under its own field name — identical shape
 * labels to the bindings and configuration paths.
 *
 * @param raw - The parsed request body, exactly as it arrived.
 * @returns The two members, or every issue the body carries.
 */
function profileBodyOf(raw: unknown): ProfileBodyVerdict {
    if (!isRecord(raw)) {
        return { ok: false, issues: [profileBodyRefusal()] };
    }

    const scratch: ProfileScratch = {
        issues: [],
        carried: new Set<string>(),
        displayName: { present: false },
        startingPrompt: { present: false },
    };

    for (const key of Object.keys(raw)) {
        readProfileKey({ key, record: raw, scratch });
    }

    if (scratch.carried.size === 0) {
        scratch.issues.push(profileBodyRefusal());
    }

    return scratch.issues.length > 0
        ? { ok: false, issues: scratch.issues }
        : { ok: true, body: { displayName: scratch.displayName, startingPrompt: scratch.startingPrompt } };
}

/** What one profile write produced; the handler maps it to a response. */
type ProfileOutcome =
    /** No account holds the path id: `404 unknown-account`. */
    | { readonly kind: 'missing' }
    /** The body was refused: nothing was observed, written, or audited. */
    | { readonly kind: 'refused'; readonly issues: readonly FieldIssue[] }
    /** The record after the write. */
    | { readonly kind: 'ok'; readonly account: Account };

/**
 * Read → validate → write → observe, as **one task on the account chain**.
 *
 * The chain-holding read is the **unobserved** one: the observation this write
 * needs runs inside this very task, so the chain can never deadlock against
 * itself (plan C20, mirroring `PUT /v1/bindings`). The pre-write observation
 * claims any hand edit the stored record carries; the post-write observation
 * claims only this submission's own change, so exactly one row exists per
 * change and a `displayName`-only write appends none at all.
 *
 * @param input - Open store, logger, path id, and the raw body.
 * @returns The outcome the handler answers with.
 */
async function runProfileWrite(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger for the observations' failure lines. */
    readonly log: ServiceLogger;
    /** Numeric account id the path named. */
    readonly numericUserId: string;
    /** Parsed request body, exactly as it arrived. */
    readonly body: unknown;
}): Promise<ProfileOutcome> {
    const { store, log, numericUserId } = input;
    return await runAccountPromptChain(store, async () => {
        const stored = await readAccountUnobserved({ store, numericUserId, log });
        if (stored === null) {
            return { kind: 'missing' } as const;
        }

        const parsed = profileBodyOf(input.body);
        if (!parsed.ok) {
            // Nothing is observed, nothing is written, no `updatedAt` bumps,
            // and no audit row exists for a refusal (invariant 6).
            return { kind: 'refused', issues: parsed.issues } as const;
        }

        await recordAccountPromptChanges({ store, log, accounts: [stored], actor: 'service' });

        // Whitelist by construction: the record *this service* read, spread
        // with the validated operator keys the body actually carried, plus a
        // fresh `updatedAt`. The body is never spread, so a custody field
        // cannot be overwritten from it — it is never read out of it.
        const updated: Account = {
            ...stored,
            ...(parsed.body.displayName.present && { displayName: parsed.body.displayName.value }),
            ...(parsed.body.startingPrompt.present && { startingPrompt: parsed.body.startingPrompt.value }),
            updatedAt: nowIso(),
        };
        await writeAccount(store, updated);
        await recordAccountPromptChanges({ store, log, accounts: [updated], actor: 'operator' });

        return { kind: 'ok', account: updated } as const;
    });
}

/**
 * Run `PUT /v1/accounts/:numericUserId` from request to response.
 *
 * One handler, one contract, two operator-editable members: `displayName`
 * and the account's `startingPrompt` tier (004 FR-082) ride the
 * same route instead of a dedicated endpoint per field. `401` and `503` are
 * the route guard's and the store check's, unchanged.
 *
 * @param context - Route context carrying the open store.
 * @param request - The routed profile request.
 * @returns `200 { account }`, or the documented 404/422/503.
 */
async function handleAccountProfile(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const pathId = pathAccountId(request);
    if (pathId === null) {
        return unknownAccountResponse();
    }

    const outcome = await runProfileWrite({
        store,
        log: context.log,
        numericUserId: pathId,
        body: request.body,
    });

    if (outcome.kind === 'missing') {
        return unknownAccountResponse();
    }

    if (outcome.kind === 'refused') {
        return validationResponse(outcome.issues);
    }

    return { status: STATUS.ok, body: { account: toAccountDto(outcome.account) } };
}

/**
 * Write one account's operator-editable profile members (005 FR-066, 004 FR-082).
 *
 * `PUT` on the same `ACCOUNT_PATH` the delete route pattern-matches: the
 * method, not a path suffix, is what distinguishes the two operations, which
 * is exactly why the retired narrow label route leaves no alias behind — there
 * is one path and two documented methods (005 v1.10.0, invariant 8).
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export const putAccountProfileRoute: Route = {
    method: 'PUT',
    path: ACCOUNT_PATH,
    handler: guardCredentialRoute(handleAccountProfile),
};
