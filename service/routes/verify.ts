/**
 * `POST /v1/accounts/verify` — the credential handoff (token-handoff §2
 * steps ④–⑦, contract §2.2).
 *
 * Order is the contract's, and each step refuses before the next one runs:
 * storage availability → body shape → throttle slot → GitHub
 * `/user` (15 s abort, service-owned `fetch`) → identity rules (case-insensitive
 * `expectedLogin` fail-closed, duplicate id `409`) → persist → respond. The
 * credential file is written **only after `/user` succeeds** and the success
 * body is produced **only after the persist completes**, so a crash in between
 * leaves a complete account rather than a half-registered one (SEC-05/F13).
 *
 * Nothing here logs or echoes a token: the audit writer is handed identities
 * and reason classes only, and the whole route runs behind
 * {@link guardCredentialRoute}, which converts any unexpected throw into a
 * `500` whose log line carries an error *kind* rather than a message (SEC-11).
 */

import { newCorrelationId, nowIso } from '../../src/ids.ts';
import { appendAudit } from '../audit.ts';
import { STATUS, storageUnavailableResponse } from '../http.ts';
import { readAccount, writeAccount } from '../accounts/store.ts';
import type { Account } from '../accounts/model.ts';
import type { GitHubIdentity, RateBaseline, VerifyOutcome } from '../github.ts';
import type { HttpResponse } from '../http.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import type { CredentialRequest } from './credential.ts';
import {
    accountRejectedResponse,
    credentialRejectedResponse,
    duplicateAccountResponse,
    githubRateLimitedResponse,
    guardCredentialRoute,
    parseCredentialBody,
    throttleRefusal,
    upstreamUnavailableResponse,
} from './credential.ts';
import type { Route, RouteContext, RouteRequest } from './types.ts';

/** Path of the credential handoff route. */
export const VERIFY_PATH = '/v1/accounts/verify';

/** Copy for an `expectedLogin` disagreement (F7; no token echo). */
const LOGIN_MISMATCH_MESSAGE = 'the token belongs to a different GitHub login than the expected one';

/** Store plus logger, after the route proved the store is usable. */
interface VerifyDeps {
    /** Open credential store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
}

/** One handoff once GitHub has answered: everything the follow-up needs. */
interface VerifyAttempt {
    /** Store and logger. */
    readonly deps: VerifyDeps;
    /** The parsed handoff request (carries the token; never logged). */
    readonly credential: CredentialRequest;
    /** The classified GitHub outcome. */
    readonly outcome: VerifyOutcome;
    /** Correlation id for the chain. */
    readonly correlationId: string;
}

/** A handoff attempt whose GitHub answer recovered an identity. */
type AcceptedAttempt = Omit<VerifyAttempt, 'outcome'> & {
    readonly outcome: Extract<VerifyOutcome, { kind: 'ok' }>;
};

/**
 * Append an `account.rejected` audit row carrying only a reason class.
 */
async function recordRejection(input: {
    /** Store and logger. */
    readonly deps: VerifyDeps;
    /** Machine-readable reason class. */
    readonly reason: string;
    /** Identity from `/user`, when the refusal has one. */
    readonly identity: GitHubIdentity | null;
    /** Correlation id for the chain. */
    readonly correlationId: string;
}): Promise<void> {
    const { deps, reason, identity, correlationId } = input;
    const entity =
        identity === null
            ? { kind: 'service' as const, id: 'credential-handoff' }
            : { kind: 'account' as const, id: identity.numericUserId };
    const details = identity === null ? { reasonClass: reason } : { reasonClass: reason, login: identity.login };

    await appendAudit(deps.store, {
        eventType: 'account.rejected',
        actorSource: 'service',
        entity,
        decision: 'reject',
        reason,
        correlationId,
        details,
    });
}

/**
 * Classify a non-`ok` outcome into its documented response.
 *
 * @param attempt - The handoff attempt, GitHub's answer already classified.
 * @returns The response; nothing has been persisted at this point.
 */
async function refusalFor(attempt: VerifyAttempt): Promise<HttpResponse> {
    const { outcome, deps, correlationId } = attempt;
    if (outcome.kind === 'rate-limited') {
        return githubRateLimitedResponse(outcome.retryAfterSeconds);
    }

    if (outcome.kind === 'unavailable') {
        return upstreamUnavailableResponse(outcome.detail, correlationId);
    }

    if (outcome.kind === 'rejected') {
        await recordRejection({ deps, reason: outcome.reason, identity: null, correlationId });

        return credentialRejectedResponse(outcome.reason, correlationId);
    }

    throw new Error('verify route received a successful outcome without a handler');
}

/**
 * Log the free rate-limit baseline; numbers only, never credential material.
 */
function reportRateBaseline(input: {
    /** Store and logger. */
    readonly deps: VerifyDeps;
    /** Identity the baseline belongs to. */
    readonly identity: GitHubIdentity;
    /** Baseline, or `null` when the probe did not parse. */
    readonly baseline: RateBaseline | null;
}): void {
    const { deps, identity, baseline } = input;
    if (baseline === null) {
        deps.log.debug('rate baseline unavailable', { numericUserId: identity.numericUserId });

        return;
    }

    deps.log.info('rate baseline', {
        numericUserId: identity.numericUserId,
        limit: baseline.limit,
        remaining: baseline.remaining,
        resetAt: baseline.resetAt,
    });
}

/**
 * Append the `account.verified` audit row after the credential is durable.
 *
 * The writer receives identity, scope results, and a redaction marker — the
 * credential never reaches it (§2 step ⑩). A failed append is logged rather
 * than turned into a response failure: the account is already persisted, and
 * answering "failed" now would only send the panel into a `409` on retry.
 */
async function recordVerified(input: {
    /** Store and logger. */
    readonly deps: VerifyDeps;
    /** The account that was persisted. */
    readonly account: Account;
    /** Correlation id for the chain. */
    readonly correlationId: string;
}): Promise<void> {
    const { deps, account, correlationId } = input;
    try {
        await appendAudit(deps.store, {
            eventType: 'account.verified',
            actorSource: 'service',
            entity: { kind: 'account', id: account.numericUserId },
            decision: 'accept',
            reason: 'token verified against GitHub /user',
            correlationId,
            details: {
                login: account.login,
                scopeCheck: account.scopeCheck.results,
                redaction: { redacted: false, fields: [] },
            },
        });
    } catch (error) {
        deps.log.warn('account verified but the audit row could not be appended', {
            numericUserId: account.numericUserId,
            errorKind: error instanceof Error ? error.name : typeof error,
        });
    }
}

/**
 * Persist a freshly verified account and answer `201` (SEC-05 ordering).
 *
 * @returns The `201` identity body (contract §2.2).
 */
async function persistVerified(attempt: AcceptedAttempt): Promise<HttpResponse> {
    const { deps, credential, correlationId, outcome } = attempt;
    const at = nowIso();
    const account: Account = {
        numericUserId: outcome.identity.numericUserId,
        login: outcome.identity.login,
        expectedLogin: credential.expectedLogin,
        // A new account has no operator label and no prompt tier yet; both are
        // written later by the account profile write (005 FR-066, 004 FR-071:
        // no tier is ever seeded, so a fresh account starts unset).
        displayName: null,
        startingPrompt: null,
        credential: { token: credential.token, kind: outcome.credentialKind, verifiedAt: at },
        scopeCheck: outcome.scopeCheck,
        state: 'active',
        connectionState: 'connected',
        verifiedAt: at,
        errorReason: null,
        createdAt: at,
        updatedAt: at,
    };

    await writeAccount(deps.store, account);
    reportRateBaseline({ deps, identity: outcome.identity, baseline: outcome.rateBaseline });
    await recordVerified({ deps, account, correlationId });

    return {
        status: STATUS.created,
        body: {
            numericUserId: account.numericUserId,
            login: account.login,
            state: account.state,
            verifiedAt: account.verifiedAt,
            scopeCheck: account.scopeCheck,
        },
    };
}

/**
 * Accept a successful verification: identity rules, then persist.
 *
 * @returns The `201` body, or the fail-closed refusal that beat it.
 */
async function acceptVerified(attempt: AcceptedAttempt): Promise<HttpResponse> {
    const { deps, credential, correlationId, outcome } = attempt;
    const { identity } = outcome;
    const expected = credential.expectedLogin;
    if (expected !== null && expected.toLowerCase() !== identity.login.toLowerCase()) {
        await recordRejection({ deps, reason: 'expected-login-mismatch', identity, correlationId });

        return accountRejectedResponse(LOGIN_MISMATCH_MESSAGE, correlationId);
    }

    const existing = await readAccount({
        store: deps.store,
        numericUserId: identity.numericUserId,
        log: deps.log,
    });
    if (existing !== null) {
        await recordRejection({ deps, reason: 'duplicate-account', identity, correlationId });

        return duplicateAccountResponse(correlationId);
    }

    return await persistVerified(attempt);
}

/**
 * Run one handoff from body to response.
 *
 * @param request - The panel's `POST /v1/accounts/verify`.
 * @returns The documented response for this outcome.
 */
async function handleVerify(context: RouteContext, request: RouteRequest): Promise<HttpResponse> {
    const { store } = context;
    if (store === null) {
        return storageUnavailableResponse();
    }

    const parsed = parseCredentialBody(request.body, true);
    if (!parsed.ok) {
        return parsed.response;
    }

    const decision = context.throttle.attempt();
    if (!decision.allowed) {
        return throttleRefusal(decision.code, decision.retryAfterSeconds);
    }

    try {
        const outcome = await context.github.verify(parsed.credential.token);
        const attempt: VerifyAttempt = {
            deps: { store, log: context.log },
            credential: parsed.credential,
            outcome,
            correlationId: newCorrelationId(),
        };

        if (outcome.kind === 'ok') {
            return await acceptVerified({ ...attempt, outcome });
        }

        return await refusalFor(attempt);
    } finally {
        decision.lease.release();
    }
}

/** Verify a presented token and register the account it belongs to. */
export const verifyRoute: Route = {
    method: 'POST',
    path: VERIFY_PATH,
    handler: guardCredentialRoute(handleVerify),
};
