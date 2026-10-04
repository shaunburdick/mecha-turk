/**
 * Account routes: list, rotation, and operator-driven delete (contract §2.2,
 * FR-010/FR-012, token-handoff §6).
 *
 * - `GET /v1/accounts` returns **credential-free DTOs by construction**: the
 *   handler serialises {@link toAccountDto}, which names every field it
 *   returns, so a future credential field on the record cannot leak by spread.
 * - `POST /v1/accounts/:numericUserId/token` verifies the *new* token before
 *   anything is written. Its numeric id must equal the path id — a mismatch is
 *   `422 account-rejected` with a byte-identical store (SEC-06) — and a
 *   successful rotation refreshes `login`/`scopeCheck`/`verifiedAt` (plus the
 *   credential) while `numericUserId`, checkpoints, deliveries, runs, and audit
 *   history stay untouched (FR-012). State is restored only when the account
 *   is *not* already `active`, so a revoked credential can come back into
 *   service without a second data path.
 * - `DELETE /v1/accounts/:numericUserId` refuses while a repository binding
 *   references the account (`409`) unless `?force=1`, which disables those
 *   bindings and audits every one of them. The force path exists only for an
 *   operator-confirmed UI action (§4 rule 7) — never for an automatic retry.
 *
 * The fourth operation on this surface — the profile `PUT` on the same
 * `ACCOUNT_PATH` — lives in
 * [`account-profile.ts`](./account-profile.ts), which owns its closed body and
 * its prompt observation. This module keeps the shared path constant and the
 * two refusal/path helpers that write needs (`unknownAccountResponse`,
 * `pathAccountId`), so the dependency runs one way and the two files cannot
 * form a cycle.
 */

import { newCorrelationId, nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import { errorResponse, STATUS, storageUnavailableResponse } from '../http.ts';
import { isNumericUserId, toAccountDto } from '../accounts/model.ts';
import {
    accountPath,
    bindingsReferencing,
    disableBindings,
    listAccounts,
    readAccount,
    removeAccount,
    writeAccount,
} from '../accounts/store.ts';
import type { Account } from '../accounts/model.ts';
import type { AuditEntityKind } from '../audit.ts';
import type { BindingRecord } from '../accounts/store.ts';
import type { VerifyOutcome } from '../github.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { CredentialRequest } from './credential.ts';
import {
    accountRejectedResponse,
    credentialRejectedResponse,
    githubRateLimitedResponse,
    guardCredentialRoute,
    parseCredentialBody,
    throttleRefusal,
    upstreamUnavailableResponse,
} from './credential.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path of the account collection resource. */
export const ACCOUNTS_PATH = '/v1/accounts';

/** Path pattern of one account's credential resource. */
export const ACCOUNT_TOKEN_PATH = `${ACCOUNTS_PATH}/:numericUserId/token`;

/** Path pattern of one account resource (delete and the profile write). */
export const ACCOUNT_PATH = `${ACCOUNTS_PATH}/:numericUserId`;

/** Query flag that authorises a delete past the binding refusal (operator-only). */
const FORCE_QUERY_FLAG = 'force';

/** Query value that must accompany {@link FORCE_QUERY_FLAG}. */
const FORCE_QUERY_VALUE = '1';

/** Copy for a rotation whose new token belongs to another account (SEC-06). */
const ROTATION_ID_MISMATCH = 'the new token belongs to a different GitHub account than this one';

/** Copy for a rotation whose new token belongs to another login. */
const ROTATION_LOGIN_MISMATCH = 'the new token belongs to a different GitHub login';

/** Audit vocabulary shared by the refusal rows on these routes. */
const REJECTED_EVENT = 'account.rejected';

/** Audit decision recorded for every refusal on these routes. */
const REJECT_DECISION = 'reject';

/** Entity kind used when a refusal has an account to point at. */
const ACCOUNT_KIND: AuditEntityKind = 'account';

/**
 * The refusal body every unknown-id path answers with (contract §4).
 *
 * @returns `404 unknown-account`; the id itself is never echoed.
 */
export function unknownAccountResponse(): HttpResponse {
    return errorResponse(STATUS.notFound, {
        code: 'unknown-account',
        message: 'no account with this GitHub id is registered',
    });
}

/**
 * Build the `409` refusal for a delete that bindings still reference.
 *
 * @param count - How many bindings reference the account.
 * @returns The response with operator remediation (contract §2.2).
 */
function bindingsRefusalResponse(count: number): HttpResponse {
    return errorResponse(STATUS.conflict, {
        code: 'invalid-transition',
        message: `${count} binding(s) still reference this account — remove them, or confirm a force delete`,
    });
}

/**
 * Read the numeric account id out of the matched path.
 *
 * @param request - The routed request.
 * @returns The id, or `null` when the segment cannot name an account — which
 *   is answered as `404 unknown-account`, never as a storage path.
 */
export function pathAccountId(request: RouteRequest): string | null {
    const raw = request.params.numericUserId;

    return isNumericUserId(raw) ? raw : null;
}

/**
 * Answer `GET /v1/accounts` with the credential-free projections.
 *
 * @param context - Route context carrying the open store.
 * @returns `200 { accounts: [...] }`, or the documented 503.
 */
async function handleListAccounts(context: RouteContext): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const accounts = await listAccounts(store, context.log);

    return { status: STATUS.ok, body: { accounts: accounts.map(toAccountDto) } };
}

/**
 * Apply a successful verification to an existing account (rotation, §6).
 *
 * `updatedAt` is deliberately untouched: contract §6 defines rotation's
 * freshness marker as `verifiedAt`, and its contract test asserts the stored
 * document differs in **exactly** the credential, `login`, `scopeCheck`, and
 * `verifiedAt` fields for an account that was already `active`.
 *
 * @param input - Stored account, verified outcome, and the new token.
 * @returns The document to persist.
 */
function rotatedAccount(input: {
    /** The stored account. */
    readonly account: Account;
    /** The verified replacement credential's outcome. */
    readonly outcome: Extract<VerifyOutcome, { kind: 'ok' }>;
    /** The new credential token. */
    readonly token: string;
}): Account {
    const { account, outcome, token } = input;
    const isRecovering = account.state !== 'active';
    const verifiedAt = nowIso();

    return {
        ...account,
        login: outcome.identity.login,
        credential: { token, kind: outcome.credentialKind, verifiedAt },
        scopeCheck: outcome.scopeCheck,
        verifiedAt,
        ...(isRecovering && { state: 'active' as const, connectionState: 'connected' as const, errorReason: null }),
    };
}

/** Identity of one rotation attempt, shared by its audit rows. */
interface RotationSubject {
    /** Open store. */
    readonly store: ServiceStore;
    /** Account being rotated. */
    readonly account: Account;
    /** Correlation id for the chain. */
    readonly correlationId: string;
}

/**
 * Audit a rotation refusal with a reason class only (contract §3).
 *
 * @param subject - Store, account, and correlation id.
 * @param reason - Machine-readable reason class.
 */
async function recordRotationRejection(subject: RotationSubject, reason: string): Promise<void> {
    await appendAudit(subject.store, {
        eventType: REJECTED_EVENT,
        actorSource: 'service',
        entity: { kind: ACCOUNT_KIND, id: subject.account.numericUserId },
        decision: REJECT_DECISION,
        reason,
        correlationId: subject.correlationId,
        details: { reasonClass: reason, operation: 'rotation' },
    });
}

/**
 * Classify a rotation's GitHub outcome into a response.
 *
 * @param subject - Store, account, and correlation id.
 * @param outcome - The GitHub outcome to translate.
 * @returns The response; a matching `ok` outcome returns `null` for the
 *   caller to persist, anything else is a documented refusal.
 */
async function rotationRefusal(subject: RotationSubject, outcome: VerifyOutcome): Promise<HttpResponse | null> {
    if (outcome.kind === 'rate-limited') {
        return githubRateLimitedResponse(outcome.retryAfterSeconds);
    }

    if (outcome.kind === 'unavailable') {
        return upstreamUnavailableResponse(outcome.detail, subject.correlationId);
    }

    if (outcome.kind === 'rejected') {
        await recordRotationRejection(subject, outcome.reason);

        return credentialRejectedResponse(outcome.reason, subject.correlationId);
    }

    if (outcome.identity.numericUserId !== subject.account.numericUserId) {
        await recordRotationRejection(subject, 'rotation-id-mismatch');

        return accountRejectedResponse(ROTATION_ID_MISMATCH, subject.correlationId);
    }

    const expected = subject.account.expectedLogin;
    if (expected !== null && expected.toLowerCase() !== outcome.identity.login.toLowerCase()) {
        await recordRotationRejection(subject, 'expected-login-mismatch');

        return accountRejectedResponse(ROTATION_LOGIN_MISMATCH, subject.correlationId);
    }

    return null;
}

/**
 * Audit the completed rotation; the credential never reaches the writer.
 *
 * @param input - Store, logger, account, and correlation id.
 */
async function recordRotation(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger for the best-effort failure line. */
    readonly log: ServiceLogger;
    /** The rotated account. */
    readonly account: Account;
    /** Correlation id for the chain. */
    readonly correlationId: string;
}): Promise<void> {
    try {
        await appendAudit(input.store, {
            eventType: 'account.rotated',
            actorSource: 'operator',
            entity: { kind: ACCOUNT_KIND, id: input.account.numericUserId },
            decision: 'accept',
            reason: 'replacement token verified against GitHub /user',
            correlationId: input.correlationId,
            details: { login: input.account.login, scopeCheck: input.account.scopeCheck.results },
        });
    } catch (error) {
        input.log.warn('account rotated but the audit row could not be appended', {
            numericUserId: input.account.numericUserId,
            errorKind: error instanceof Error ? error.name : typeof error,
        });
    }
}

/**
 * Persist the rotated account, audit it, and answer `200`.
 *
 * @param input - Store, logger, account, new token, outcome, correlation id.
 * @returns The documented success body (contract §2.2).
 */
async function persistRotation(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger for the audit failure line. */
    readonly log: ServiceLogger;
    /** Account whose credential is replaced. */
    readonly account: Account;
    /** The new credential token. */
    readonly token: string;
    /** Verified outcome for the replacement credential. */
    readonly outcome: Extract<VerifyOutcome, { kind: 'ok' }>;
    /** Correlation id for the chain. */
    readonly correlationId: string;
}): Promise<HttpResponse> {
    const rotated = rotatedAccount({ account: input.account, outcome: input.outcome, token: input.token });
    await writeAccount(input.store, rotated);
    await recordRotation({ store: input.store, log: input.log, account: rotated, correlationId: input.correlationId });

    return {
        status: STATUS.ok,
        body: { numericUserId: rotated.numericUserId, login: rotated.login, verifiedAt: rotated.verifiedAt },
    };
}

/**
 * Resolve the routed path and body into a ready-to-rotate request.
 *
 * @param input - Open store, matched path segment, and the parsed body.
 * @returns The rotation inputs, or the refusal that beat them.
 */
async function prepareRotation(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger for the read's observation and quarantine line. */
    readonly log: ServiceLogger;
    /** Raw path segment from the route match. */
    readonly pathId: string | null;
    /** Parsed request body. */
    readonly body: unknown;
}): Promise<
    { readonly ok: true; readonly account: Account; readonly credential: CredentialRequest } | {
        readonly ok: false;
        readonly response: HttpResponse;
    }
> {
    const parsed = parseCredentialBody(input.body, false);
    if (!parsed.ok) {
        return { ok: false, response: parsed.response };
    }

    const account =
        input.pathId === null
            ? null
            : await readAccount({ store: input.store, numericUserId: input.pathId, log: input.log });
    if (input.pathId === null || account === null) {
        return { ok: false, response: unknownAccountResponse() };
    }

    return { ok: true, account, credential: parsed.credential };
}

/**
 * Run `POST /v1/accounts/:numericUserId/token` from body to response.
 *
 * @param context - Route context carrying store, throttle, and GitHub client.
 * @param request - The routed rotation request.
 * @returns The documented response for this outcome.
 */
async function handleRotateToken(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const prepared = await prepareRotation({
        store,
        log: context.log,
        pathId: pathAccountId(request),
        body: request.body,
    });
    if (!prepared.ok) {
        return prepared.response;
    }

    const decision = context.throttle.attempt();
    if (!decision.allowed) {
        return throttleRefusal(decision.code, decision.retryAfterSeconds);
    }

    try {
        const outcome = await context.github.verify(prepared.credential.token);
        const subject: RotationSubject = { store, account: prepared.account, correlationId: newCorrelationId() };
        const refusal = await rotationRefusal(subject, outcome);
        if (refusal !== null) {
            return refusal;
        }

        // Unreachable for every documented outcome: `rotationRefusal` answers
        // all three non-`ok` kinds above; this keeps the narrowing explicit.
        if (outcome.kind !== 'ok') {
            return upstreamUnavailableResponse('upstream', subject.correlationId);
        }

        return await persistRotation({
            store,
            log: context.log,
            account: prepared.account,
            token: prepared.credential.token,
            outcome,
            correlationId: subject.correlationId,
        });
    } finally {
        decision.lease.release();
    }
}

/**
 * Audit every binding a isForced delete disabled (contract §2.2, §4 rule 7).
 *
 * @param store - Open store.
 * @param bindings - The bindings that were disabled, as they were read.
 */
async function recordDisabledBindings(store: ServiceStore, bindings: readonly BindingRecord[]): Promise<void> {
    for (const binding of bindings) {
        await appendAudit(store, {
            eventType: 'binding.disabled',
            actorSource: 'operator',
            entity: { kind: 'binding', id: binding.bindingId },
            decision: 'disable',
            reason: 'account deleted with force=1',
            details: {},
        });
    }
}

/**
 * Audit the removal of an account (FR-035 terminal outcome).
 *
 * @param store - Open store.
 * @param numericUserId - Id of the account that was removed.
 */
async function recordAccountDeleted(store: ServiceStore, numericUserId: string): Promise<void> {
    await appendAudit(store, {
        eventType: 'account.deleted',
        actorSource: 'operator',
        entity: { kind: ACCOUNT_KIND, id: numericUserId },
        decision: 'remove',
        reason: 'operator deleted the account',
        details: { credentialFile: accountPath(numericUserId) },
    });
}

/**
 * Run `DELETE /v1/accounts/:numericUserId` from path to response.
 *
 * @param context - Route context carrying the open store.
 * @param request - The routed delete request.
 * @returns `200 { removed: true }`, or the documented refusal.
 */
async function handleDeleteAccount(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const pathId = pathAccountId(request);
    const account = pathId === null ? null : await readAccount({ store, numericUserId: pathId, log: context.log });
    if (pathId === null || account === null) {
        return unknownAccountResponse();
    }

    const bindings = await bindingsReferencing(store, pathId);
    const isForced = request.url.searchParams.get(FORCE_QUERY_FLAG) === FORCE_QUERY_VALUE;
    if (bindings.length > 0 && !isForced) {
        return bindingsRefusalResponse(bindings.length);
    }

    if (bindings.length > 0) {
        await recordDisabledBindings(store, await disableBindings(store, bindings));
    }

    await removeAccount(store, pathId);
    await recordAccountDeleted(store, pathId);

    return { status: STATUS.ok, body: { removed: true } };
}

/** List every registered account without its credential. */
export const listAccountsRoute: Route = {
    method: 'GET',
    path: ACCOUNTS_PATH,
    handler: guardCredentialRoute(handleListAccounts),
};

/** Replace one account's credential after re-verification. */
export const rotateTokenRoute: Route = {
    method: 'POST',
    path: ACCOUNT_TOKEN_PATH,
    handler: guardCredentialRoute(handleRotateToken),
};

/** Remove one account once its bindings allow it (or are force-disabled). */
export const deleteAccountRoute: Route = {
    method: 'DELETE',
    path: ACCOUNT_PATH,
    handler: guardCredentialRoute(handleDeleteAccount),
};
