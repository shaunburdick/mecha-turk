/**
 * The service read/write side the Bindings tab and relay share — one small client over `host.serviceRequest()`.
 */

import type { PanelHost } from './session.ts';
import type { ServiceConfigPutResult, ServiceErrorResult, ServiceResource, ServiceResult } from './service-envelope.ts';
import {
    configResultOf,
    describeTransport,
    resultOf,
    resultWithErrorOf,
} from './service-envelope.ts';

export type {
    ConfigIssueView,
    ServiceConfigPutResult,
    ServiceErrorResult,
    ServiceResource,
    ServiceResult,
} from './service-envelope.ts';

/**
 * The resource every pre-configuration wrapper describes, kept byte-identical.
 *
 * A bindings refusal still says *bindings*, so the four shared wrappers pass
 * this constant rather than each spelling the sentence's subject — one literal,
 * one meaning.
 */
const LEGACY_RESOURCE: ServiceResource = 'bindings list';

export type ServiceRequester = Pick<PanelHost, 'serviceRequest'>['serviceRequest'];

export const BINDINGS_PATH = '/v1/bindings';

/** Path of the credential-free account collection (service contract §2.2). */
export const ACCOUNTS_PATH = '/v1/accounts';

export const EVENTS_PENDING_PATH = '/v1/events/pending';

/** The panel's claim: one run per relay interval (FR-081). The bare route stays the harness's own read. */
export const PENDING_CLAIM_PATH = `${EVENTS_PENDING_PATH}?limit=1`;

/**
 * Path of the service configuration document.
 *
 * The panel reads it per verification to pick up `expectedAgent`; a build
 * whose document does not carry the field falls back to the documented
 * default with `provenance: 'defaulted'` rather than blocking the run.
 */
export const CONFIG_PATH = '/v1/config';

/**
 * Path of the readiness probe, which is also the About tab's version source.
 *
 * The route the service actually registers is `/health`, with no `/v1` prefix
 * and no alias (adding one would invent a
 * second health surface to satisfy a typo). `tests/about-tab.test.ts` pins
 * this constant to `healthRoute.path` and pins the specification documents to
 * the same string, so the two cannot drift apart in either direction.
 */
export const HEALTH_PATH = '/health';

export const EVENTS_PATH = '/v1/events';

export const AUDIT_PATH = '/v1/audit';

/** Path of the service's retained log stream (010 FR-002). */
export const LOGS_PATH = '/v1/logs';

/**
 * Path pattern every run-scoped operation shares.
 *
 * The `:correlationId` segment is the **run's** correlation id (`mt-run-…`),
 * never a delivery id: a delivery carries no lifecycle field of its
 * own, so a delivery-addressed mutation answers `404 unknown-run`. Each helper
 * below exists so no call site can reintroduce that shape by hand.
 */
const RUN_SCOPE_PATTERN = '/v1/events/:correlationId';

/**
 * Path pattern of one account resource — the delete route and the account
 * profile write share the same `:numericUserId` segment; only the method and
 * body tell them apart.
 */
const ACCOUNT_PATH_PATTERN = '/v1/accounts/:numericUserId';

const ACCOUNT_TOKEN_PATTERN = '/v1/accounts/:numericUserId/token';

/**
 * Query flag the hardened delete needs before it disables an account's
 * bindings instead of refusing.
 *
 * The panel only ever sends it **after** the arm step has named the cascade,
 * which is what makes the flag the confirmation rather than a bypass: the
 * service's own guard writes `state: 'disabled'` on those bindings and audits
 * each one, and the panel renders exactly that outcome.
 */
const FORCE_DISABLE_QUERY = '?force=1';

const ACCOUNT_ID_SEGMENT = ':numericUserId';

/**
 * Run one GET through `host.serviceRequest`.
 */
export async function serviceGet(input: {
    readonly serviceRequest: ServiceRequester;
    readonly path: string;
}): Promise<ServiceResult> {
    try {
        const answer = await input.serviceRequest({ method: 'GET', path: input.path });

        return resultOf(answer, LEGACY_RESOURCE);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause) };
    }
}

/**
 * Run one PUT through `host.serviceRequest`, reading the error code.
 *
 * The error-aware shape (same as {@link servicePost}) costs nothing for a
 * caller that only checks `ok`, and it lets the bindings grant put the
 * service's own field-level remediation next to the field it belongs to
 * instead of behind a generic "the service refused".
 *
 * @returns The wrapper's result, carrying the envelope when it sent one.
 */
export async function servicePut(input: {
    readonly serviceRequest: ServiceRequester;
    readonly path: string;
    readonly body: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({ method: 'PUT', path: input.path, body: input.body });

        return resultWithErrorOf(answer, LEGACY_RESOURCE);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, message: null, referenceWindow: null };
    }
}

/**
 * Write the whole configuration document, keeping the refusal's issue list — the one configuration
 * path in the panel (`PUT /v1/config` and nothing else). The answer keeps the service's own
 * `error.issues` **in the service's order**, so a `422` renders field by field with the service's
 * wording instead of one generic sentence, and its problem names the *configuration*, never the
 * bindings list. A `503`, `401` or transport failure reaches the caller as itself with no issues:
 * it is not a refusal of these values. Body on success; problem, code and issues on a refusal.
 */
export async function servicePutConfig(input: {
    readonly serviceRequest: ServiceRequester;
    readonly body: string;
}): Promise<ServiceConfigPutResult> {
    try {
        const answer = await input.serviceRequest({ method: 'PUT', path: CONFIG_PATH, body: input.body });

        return configResultOf(answer);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, issues: [], correlationId: null };
    }
}

/**
 * Run one POST through `host.serviceRequest`, reading the error code.
 *
 * The error-aware shape (same as {@link serviceDelete}) costs nothing for
 * callers that only check `ok`, and it lets the runs list explain a refused
 * retry from the service's own envelope code — `invalid-transition` means the
 * run was already dispatched, which is a fact about the run, not about the
 * panel's connection.
 */
export async function servicePost(input: {
    readonly serviceRequest: ServiceRequester;
    readonly path: string;
    readonly body?: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({
            method: 'POST',
            path: input.path,
            ...(input.body !== undefined && { body: input.body }),
        });

        return resultWithErrorOf(answer, LEGACY_RESOURCE);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, message: null, referenceWindow: null };
    }
}

/**
 * Run one DELETE through `host.serviceRequest`, reading the error code.
 *
 * The account delete route refuses with a *documented* envelope (409
 * invalid-transition while bindings still reference the account), and the
 * removal affordance needs that code to tell the operator to remove the
 * binding first — so this wrapper surfaces the code next to the problem.
 */
export async function serviceDelete(input: {
    readonly serviceRequest: ServiceRequester;
    readonly path: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({ method: 'DELETE', path: input.path });

        return resultWithErrorOf(answer, LEGACY_RESOURCE);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, message: null, referenceWindow: null };
    }
}

export function accountDeletePath(numericUserId: string): string {
    return ACCOUNT_PATH_PATTERN.replace(ACCOUNT_ID_SEGMENT, () => numericUserId);
}

/**
 * Build the account profile path for one account.
 *
 * The **one** operator write for this record: it carries `{ displayName }`,
 * `{ startingPrompt }`, or both, and an absent member means unchanged — so
 * neither member can clobber the other. The dedicated label route has no
 * builder left to be reached from: no alias, no redirect, no legacy route.
 */
export function accountProfilePath(numericUserId: string): string {
    return ACCOUNT_PATH_PATTERN.replace(ACCOUNT_ID_SEGMENT, () => numericUserId);
}

/**
 * Build the delete path for one account **with** the cascade the arm step
 * already stated.
 */
export function accountRemovePath(numericUserId: string): string {
    return `${accountDeletePath(numericUserId)}${FORCE_DISABLE_QUERY}`;
}

export function accountTokenPath(numericUserId: string): string {
    return ACCOUNT_TOKEN_PATTERN.replace(ACCOUNT_ID_SEGMENT, () => numericUserId);
}

function runOperationPath(correlationId: string, verb: string): string {
    return `${RUN_SCOPE_PATTERN.replace(':correlationId', () => correlationId)}/${verb}`;
}

export function reservePath(correlationId: string): string {
    return runOperationPath(correlationId, 'reserve');
}

export function dispatchedPath(correlationId: string): string {
    return runOperationPath(correlationId, 'dispatched');
}

export function abandonPath(correlationId: string): string {
    return runOperationPath(correlationId, 'abandon');
}

export function blockedPath(correlationId: string): string {
    return runOperationPath(correlationId, 'blocked');
}

export function retryPath(correlationId: string): string {
    return runOperationPath(correlationId, 'retry');
}

export function requeuePath(correlationId: string): string {
    return runOperationPath(correlationId, 'requeue');
}

export function resolvePath(correlationId: string): string {
    return runOperationPath(correlationId, 'resolve');
}

/**
 * Build the verification path: the post-dispatch agent read-back.
 */
export function verificationPath(correlationId: string): string {
    return runOperationPath(correlationId, 'verification');
}

/** The correlation-filtered audit-read path; `limit`/`cursor` are the settle read's paging (FR-045). */
export function auditPath(
    correlationId: string,
    options: { readonly limit?: number; readonly cursor?: number | null } = {},
): string {
    const page = options.limit === undefined ? '' : `&limit=${options.limit}`;
    const cursor = options.cursor === null || options.cursor === undefined ? '' : `&cursor=${options.cursor}`;

    return `${AUDIT_PATH}?correlationId=${encodeURIComponent(correlationId)}${page}${cursor}`;
}
