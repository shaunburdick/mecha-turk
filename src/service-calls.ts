/**
 * Service read/write side the Bindings tab and the relay share (re-cut).
 *
 * One small client for the HTTP calls the panel makes over the documented
 * `host.serviceRequest()` bridge: bindings GET/PUT, the configuration PUT,
 * event relay GET/POST, and the runs history GET/POST. Classification of the
 * answer itself lives in [`service-envelope.ts`](./service-envelope.ts) — one
 * classifier for every wrapper, so the tab and the loop draw problems from one
 * vocabulary (never quoting a payload).
 *
 * MVP-DEBT: a long-poll cursor and lease headers are contract §2.4
 * machinery this simple client replaces for the MVP cut.
 */

import type { PanelHost } from './session.ts';
import type { ServiceConfigPutResult, ServiceErrorResult, ServiceResource, ServiceResult } from './service-envelope.ts';
import {
    configResultOf,
    describeTransport,
    resultOf,
    resultWithErrorOf,
} from './service-envelope.ts';

/** The classifier's vocabulary, re-exported so one import path still serves. */
export type {
    ConfigIssueView,
    ServiceConfigPutResult,
    ServiceErrorResult,
    ServiceResource,
    ServiceResult,
} from './service-envelope.ts';

/**
 * The resource every pre-006 wrapper describes, kept byte-identical.
 *
 * A bindings refusal still says *bindings* (006 T-016's "nothing regresses"),
 * so the four shared wrappers pass this constant rather than each spelling the
 * sentence's subject — one literal, one meaning.
 */
const LEGACY_RESOURCE: ServiceResource = 'bindings list';

/** The one method the wrappers call, typed as the documented host surface. */
export type ServiceRequester = Pick<PanelHost, 'serviceRequest'>['serviceRequest'];

/** Path of the bindings collection. */
export const BINDINGS_PATH = '/v1/bindings';

/** Path of the credential-free account collection (service contract §2.2). */
export const ACCOUNTS_PATH = '/v1/accounts';

/** Path the panel polls for claimed runs. */
export const EVENTS_PENDING_PATH = '/v1/events/pending';

/**
 * Path of the service configuration document (002 FR-029's baseline source).
 *
 * The panel reads it per verification to pick up `expectedAgent`; a build
 * whose document does not carry the field falls back to the documented
 * default with `provenance: 'defaulted'` rather than blocking the run.
 */
export const CONFIG_PATH = '/v1/config';

/**
 * Path of the readiness probe, which is also the About tab's version source.
 *
 *
 * The route the service actually registers — and the path 002's
 * `panel-service.md` §2.1, 005 FR-074, and 005's own
 * `contracts/about-version.md` all name once T-036's truth-repair landed —
 * is `/health`, with no `/v1` prefix and no alias (adding one would invent a
 * second health surface to satisfy a typo). `tests/about-tab.test.ts` pins
 * this constant to `healthRoute.path` and pins those documents to the same
 * string, so the two cannot drift apart in either direction.
 */
export const HEALTH_PATH = '/health';

/** Path of the runs history: every run, every state, newest first (M8). */
export const EVENTS_PATH = '/v1/events';

/** Path of the correlation-filtered audit read (003 contract, run-history §2). */
export const AUDIT_PATH = '/v1/audit';

/**
 * Path pattern every run-scoped operation shares (003 wire delta).
 *
 * The `:correlationId` segment is the **run's** correlation id (`mt-run-…`),
 * never a delivery id: a post-003 delivery carries no lifecycle field of its
 * own, so a delivery-addressed mutation answers `404 unknown-run`. Each helper
 * below exists so no call site can reintroduce that shape by hand.
 */
const RUN_SCOPE_PATTERN = '/v1/events/:correlationId';

/**
 * Path pattern of one account resource — the delete route and the account
 * profile write share the same `:numericUserId` segment (005 FR-066, 004
 * FR-082); only the method and body tell them apart.
 */
const ACCOUNT_PATH_PATTERN = '/v1/accounts/:numericUserId';

/** Path pattern of one account's token-replacement route (002 FR-012). */
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

/** The path segment every account route substitutes the numeric id into. */
const ACCOUNT_ID_SEGMENT = ':numericUserId';

/**
 * Run one GET through `host.serviceRequest`.
 *
 * @param input - The host surface and the path to fetch.
 * @returns The wrapper's result.
 */
export async function serviceGet(input: {
    /** Host `serviceRequest` surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path to GET. */
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
 * @param input - The host surface, path, and the JSON body text.
 * @returns The wrapper's result, carrying the envelope when it sent one.
 */
export async function servicePut(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path to PUT. */
    readonly path: string;
    /** Serialized body. */
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
 * Write the whole configuration document, keeping the refusal's issue list.
 *
 * The one configuration path in the panel (006 FR-040: `PUT /v1/config` and
 * nothing else), and the wrapper the misnamed-refusal problem was about:
 * the answer keeps the service's own `error.issues` **in the service's order**,
 * so a `422` can be rendered field by field with the service's wording instead
 * of behind one generic sentence — and its problem string names the
 * *configuration*, never the bindings list. A `503`, a `401`, and a
 * transport failure reach the caller as themselves with no issues: they are not
 * refusals of these values, and the panel must not present them as one (FR-061,
 * FR-063).
 *
 * @param input - The host surface and the complete document to write.
 * @returns The body on success; the problem, code, issues, and correlation id
 *   on a refusal.
 */
export async function servicePutConfig(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** The complete configuration document, serialized. */
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
 *
 * @param input - Host surface, path, and body.
 * @returns The wrapper's error-aware result.
 */
export async function servicePost(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path. */
    readonly path: string;
    /** Body — sent only when defined. */
    readonly body?: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({
            method: 'POST',
            path: input.path,
            ...(input.body === undefined ? {} : { body: input.body }),
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
 *
 * @param input - Host surface and the path to delete.
 * @returns The wrapper's error-aware result.
 */
export async function serviceDelete(input: {
    /** Host surface. */
    readonly serviceRequest: ServiceRequester;
    /** Path to delete. */
    readonly path: string;
}): Promise<ServiceErrorResult> {
    try {
        const answer = await input.serviceRequest({ method: 'DELETE', path: input.path });

        return resultWithErrorOf(answer, LEGACY_RESOURCE);
    } catch (cause) {
        return { ok: false, problem: describeTransport(cause), code: null, message: null, referenceWindow: null };
    }
}

/**
 * Build the delete path for one account.
 *
 * @param numericUserId - GitHub numeric user id of the account to delete.
 * @returns The path segment to DELETE.
 */
export function accountDeletePath(numericUserId: string): string {
    return ACCOUNT_PATH_PATTERN.replace(ACCOUNT_ID_SEGMENT, numericUserId);
}

/**
 * Build the account profile path for one account.
 *
 * The **one** operator write for this record: it carries `{ displayName }`,
 * `{ startingPrompt }`, or both, and an absent member means unchanged — so
 * neither member can clobber the other. The dedicated label route has no
 * builder left to be reached from (005 v1.10.0: no alias, no redirect, no
 * legacy route).
 *
 * @param numericUserId - GitHub numeric user id of the account being edited.
 * @returns The path segment that writes the account's profile.
 */
export function accountProfilePath(numericUserId: string): string {
    return ACCOUNT_PATH_PATTERN.replace(ACCOUNT_ID_SEGMENT, numericUserId);
}

/**
 * Build the delete path for one account **with** the cascade the arm step
 * already stated.
 *
 * @param numericUserId - GitHub numeric user id of the account to delete.
 * @returns The path segment that disables the account's bindings, then it.
 */
export function accountRemovePath(numericUserId: string): string {
    return `${accountDeletePath(numericUserId)}${FORCE_DISABLE_QUERY}`;
}

/**
 * Build the token-replacement path for one account.
 *
 * @param numericUserId - GitHub numeric user id of the account being rotated.
 * @returns The path segment that replaces the stored credential.
 */
export function accountTokenPath(numericUserId: string): string {
    return ACCOUNT_TOKEN_PATTERN.replace(ACCOUNT_ID_SEGMENT, numericUserId);
}

/**
 * Build the path of one run-scoped operation.
 *
 * @param correlationId - The run's correlation id (`mt-run-…`, one segment).
 * @param verb - The operation's suffix under `/v1/events/:correlationId/`.
 * @returns The path segment to POST to.
 */
function runOperationPath(correlationId: string, verb: string): string {
    return `${RUN_SCOPE_PATTERN.replace(':correlationId', correlationId)}/${verb}`;
}

/**
 * Build the reserve path: declare intent and receive the single-use token.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function reservePath(correlationId: string): string {
    return runOperationPath(correlationId, 'reserve');
}

/**
 * Build the result path: report what `host.startSession()` produced.
 *
 * @param correlationId - The run's correlation id (never a delivery id).
 * @returns The path segment to POST to.
 */
export function dispatchedPath(correlationId: string): string {
    return runOperationPath(correlationId, 'dispatched');
}

/**
 * Build the abandon path: a reserved attempt that made no host call at all.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function abandonPath(correlationId: string): string {
    return runOperationPath(correlationId, 'abandon');
}

/**
 * Build the block-report path: a fail-closed guard refused before any host call.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function blockedPath(correlationId: string): string {
    return runOperationPath(correlationId, 'blocked');
}

/**
 * Build the retry path (M8).
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function retryPath(correlationId: string): string {
    return runOperationPath(correlationId, 'retry');
}

/**
 * Build the requeue path: return a dead-lettered run to waiting.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function requeuePath(correlationId: string): string {
    return runOperationPath(correlationId, 'requeue');
}

/**
 * Build the resolve path: one of FR-027's two explicit `unconfirmed` decisions.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function resolvePath(correlationId: string): string {
    return runOperationPath(correlationId, 'resolve');
}

/**
 * Build the verification path: the post-dispatch agent read-back.
 *
 * @param correlationId - The run's correlation id.
 * @returns The path segment to POST to.
 */
export function verificationPath(correlationId: string): string {
    return runOperationPath(correlationId, 'verification');
}

/**
 * Build the correlation-filtered audit-read path.
 *
 * @param correlationId - The run whose rows to read.
 * @returns `GET` path carrying the filter as a query parameter.
 */
export function auditPath(correlationId: string): string {
    return `${AUDIT_PATH}?correlationId=${encodeURIComponent(correlationId)}`;
}
