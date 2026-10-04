/**
 * Shared plumbing for the two credential routes: body parsing, throttled
 * execution, and the classified error responses they share (token-handoff
 * §2, panel-service §2.2/§4).
 *
 * Everything here obeys two rules without exception. **Shape before
 * network**: a malformed body is refused before a single GitHub call is made
 * (the in-panel consent gate this module used to run alongside that rule was
 * removed by product-owner order on 2026-10-01 — token-handoff §1.2). **Field
 * + remediation only**: no received value — least of all the token — ever
 * appears in a response body, a log line, or an audit row (SEC-11, contract
 * §4 rule 6).
 */

import { newCorrelationId } from '../../src/ids.ts';
import {
    errorResponse,
    STATUS,
    storageUnavailableResponse,
    throttleResponse,
    validationResponse,
} from '../http.ts';
import { StorageUnavailableError } from '../store/index.ts';
import type { RejectReason, ScopeCapability } from '../github.ts';
import type { FieldIssue, HttpResponse } from '../http.ts';
import type { RouteContext, RouteHandler, RouteRequest } from './types.ts';

/** Longest token a handoff may carry (contract §2 step ⑤). */
export const TOKEN_MAX_CHARS = 4_096;

/** Longest expected login a handoff may carry (data-model Account). */
export const EXPECTED_LOGIN_MAX_CHARS = 200;

/** Prefix of every `scope-missing:<capability>` reason class (contract §4). */
const SCOPE_MISSING_PREFIX = 'scope-missing:';

/** The credential material a credential route extracted from its body. */
export interface CredentialRequest {
    /** The presented token; never logged, echoed, or persisted outside custody. */
    readonly token: string;
    /** Operator-supplied expected login, or `null` when unconstrained. */
    readonly expectedLogin: string | null;
}

/** Result of parsing a credential-route body. */
export type CredentialBodyResult =
    | { readonly ok: true; readonly credential: CredentialRequest }
    | { readonly ok: false; readonly response: HttpResponse };

/**
 * Read the `token` field: its type first, then the §2 step ⑤ shape rules
 * (non-empty, no whitespace, ≤4096 characters), collecting every issue rather
 * than stopping at the first.
 *
 * @param raw - The `token` field as it arrived.
 * @returns The token when it is usable, plus every issue found otherwise.
 */
function readToken(raw: unknown): { readonly token?: string; readonly issues: readonly FieldIssue[] } {
    if (typeof raw !== 'string') {
        return { issues: [{ field: 'token', remediation: 'send the GitHub token as a JSON string' }] };
    }

    const issues: FieldIssue[] = [];
    if (raw === '') {
        issues.push({ field: 'token', remediation: 'the token must not be empty' });
    }
    if (/\s/.test(raw)) {
        issues.push({ field: 'token', remediation: 'the token must not contain whitespace' });
    }
    if (raw.length > TOKEN_MAX_CHARS) {
        issues.push({ field: 'token', remediation: `the token must be at most ${TOKEN_MAX_CHARS} characters` });
    }

    return issues.length > 0 ? { issues } : { token: raw, issues };
}

/**
 * Collect the optional `expectedLogin` issue.
 *
 * @param raw - The field as it arrived, or `undefined` when absent.
 * @returns One issue when the value is present but unusable, otherwise none.
 */
function expectedLoginIssues(raw: unknown): readonly FieldIssue[] {
    if (raw === undefined) {
        return [];
    }

    if (typeof raw === 'string' && raw !== '' && raw.length <= EXPECTED_LOGIN_MAX_CHARS) {
        return [];
    }

    return [
        {
            field: 'expectedLogin',
            remediation: `send a non-empty string of at most ${EXPECTED_LOGIN_MAX_CHARS} characters, or omit the field`,
        },
    ];
}

/**
 * Parse a credential-route body: record shape → field shape.
 *
 * The refusal is decided before any network call for its own sake —
 * invariant 8's consent half was removed with the gate on 2026-10-01, but
 * "shape before network" still means a body that cannot be a handoff never
 * reaches GitHub or the store.
 *
 * @param raw - Parsed request body (possibly `undefined`).
 * @param allowExpectedLogin - `true` for verify, `false` for rotation.
 * @returns The credential request, or the refusal to answer with.
 */
export function parseCredentialBody(raw: unknown, allowExpectedLogin: boolean): CredentialBodyResult {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {
            ok: false,
            response: validationResponse([{ field: 'body', remediation: 'send a JSON object' }]),
        };
    }

    const body = raw as Record<string, unknown>;
    const read = readToken(body.token);
    const issues = [...read.issues, ...(allowExpectedLogin ? expectedLoginIssues(body.expectedLogin) : [])];
    if (issues.length > 0 || read.token === undefined) {
        return { ok: false, response: validationResponse(issues) };
    }

    return {
        ok: true,
        credential: {
            token: read.token,
            expectedLogin: allowExpectedLogin && typeof body.expectedLogin === 'string' ? body.expectedLogin : null,
        },
    };
}

/**
 * Human name of a scope-missing capability, as the contract's copy spells it.
 *
 * @param reason - A `scope-missing:<capability>` reason class.
 * @returns The capability name shown to the operator.
 */
function capabilityLabel(reason: `scope-missing:${ScopeCapability}`): string {
    const capability = reason.slice(SCOPE_MISSING_PREFIX.length);
    switch (capability) {
        case 'metadata':
            return 'Metadata';
        case 'issues':
            return 'Issues';
        case 'pull-requests':
            return 'Pull requests';
        default:
            return 'Contents';
    }
}

/**
 * Operator-facing copy for one reason class (panel-service §4).
 *
 * Each branch names the capability or the remediation and never any part of
 * the credential.
 *
 * @param reason - Classified rejection reason.
 * @returns The reason-specific remediation copy.
 */
function reasonCopy(reason: RejectReason): string {
    if (reason === 'auth-failed') {
        return 'GitHub rejected this token — create a fresh PAT and paste it again';
    }

    if (reason === 'sso-required') {
        return 'Your organization requires SSO — authorize the token for this org, then paste it again';
    }

    return `This token is missing the ${capabilityLabel(reason)} scope — update the token, then paste it again`;
}

/**
 * Build the `422 credential-rejected` response for a classified rejection.
 *
 * `error.reasonClass` carries the machine-readable class so the panel can
 * render the reason-specific copy of §4 without parsing prose; HTTP `401` is
 * reserved for bearer failure against *our* service and is never used here
 * (SEC-03).
 *
 * @param reason - Classified rejection reason.
 * @param correlationId - Correlation id for the chain.
 * @returns The response.
 */
export function credentialRejectedResponse(reason: RejectReason, correlationId: string): HttpResponse {
    return errorResponse(STATUS.validation, {
        code: 'credential-rejected',
        message: reasonCopy(reason),
        correlationId,
        reasonClass: reason,
    });
}

/**
 * Build the `502 upstream-unavailable` response (panel-service F9's
 * `network` reason): GitHub could not answer, so nothing was verified and
 * nothing was persisted.
 *
 * @param detail - Which stage of the upstream call failed.
 * @param correlationId - Correlation id for the chain.
 * @returns The response.
 */
export function upstreamUnavailableResponse(
    detail: 'offline' | 'timeout' | 'upstream',
    correlationId: string,
): HttpResponse {
    const messages = {
        offline: 'GitHub could not be reached — check the network, then paste the token again',
        timeout: 'GitHub did not answer in time — wait a moment, then paste the token again',
        upstream: 'GitHub returned an unexpected response — wait a moment, then paste the token again',
    } as const;

    return errorResponse(STATUS.badGateway, {
        code: 'upstream-unavailable',
        message: messages[detail],
        correlationId,
    });
}

/**
 * Build the `429 rate-limited` response for GitHub's own refusal (F15).
 *
 * @param retryAfterSeconds - Seconds GitHub asked us to wait.
 * @returns The response; the panel clears the token and never auto-retries.
 */
export function githubRateLimitedResponse(retryAfterSeconds: number): HttpResponse {
    return throttleResponse({
        status: STATUS.tooManyRequests,
        code: 'rate-limited',
        message: 'GitHub rate-limited this verification — wait the stated time, then paste the token again',
        retryAfterSeconds,
    });
}

/** Message shown when another verification already holds the slot (SEC-04). */
const VERIFY_BUSY_MESSAGE = 'a verification is already running — wait a moment, then retry';

/**
 * Build the `429` refusal a throttled attempt answers with (SEC-04).
 *
 * @param code - `verify-busy` when a slot is held, `rate-limited` when the
 *   rolling window is full.
 * @param retryAfterSeconds - Seconds the caller should wait.
 * @returns The response carrying `retry-after`.
 */
export function throttleRefusal(code: 'verify-busy' | 'rate-limited', retryAfterSeconds: number): HttpResponse {
    const message =
        code === 'verify-busy'
            ? VERIFY_BUSY_MESSAGE
            : `verification attempts are limited — retry after ${retryAfterSeconds} seconds`;

    return throttleResponse({ status: STATUS.tooManyRequests, code, message, retryAfterSeconds });
}

/**
 * Build the `422 account-rejected` response (F7 / SEC-06).
 *
 * @param message - Fixed, secret-free explanation of the identity disagreement.
 * @param correlationId - Correlation id for the chain.
 * @returns The response.
 */
export function accountRejectedResponse(message: string, correlationId: string): HttpResponse {
    return errorResponse(STATUS.validation, {
        code: 'account-rejected',
        message,
        correlationId,
    });
}

/**
 * Build the `409 duplicate-account` response (F8 → the panel offers rotation).
 *
 * @param correlationId - Correlation id for the chain.
 * @returns The response.
 */
export function duplicateAccountResponse(correlationId: string): HttpResponse {
    return errorResponse(STATUS.conflict, {
        code: 'duplicate-account',
        message: 'an account with this GitHub id already exists — rotate its token instead',
        correlationId,
    });
}

/**
 * Run a credential route behind the SEC-11 error boundary.
 *
 * Any unexpected throw is logged as a *kind* (the error's constructor name)
 * rather than its message: upstream and parser errors can quote request
 * material, and the no-credential-logging invariant is enforced here instead
 * of trusting every future call site. Storage failures keep their documented
 * `503 storage-unavailable` shape.
 *
 * @param handler - The route body to guard.
 * @returns A handler with the sanitized error boundary around it.
 */
export function guardCredentialRoute(handler: RouteHandler): RouteHandler {
    return async (context: RouteContext, request: RouteRequest): Promise<HttpResponse> => {
        try {
            return await handler(context, request);
        } catch (error) {
            if (error instanceof StorageUnavailableError) {
                return storageUnavailableResponse();
            }

            const correlationId = newCorrelationId();
            context.log.error('credential route failed', {
                correlationId,
                errorKind: error instanceof Error ? error.name : typeof error,
            });

            return errorResponse(STATUS.internal, {
                code: 'internal',
                message: 'unexpected service failure',
                correlationId,
            });
        }
    };
}
