/**
 * The one place a service answer is classified (006 FR-043; 005 FR-088).
 *
 * Every wrapper in [`service-calls.ts`](./service-calls.ts) funnels its answer
 * through this module, so the problem string, the machine `code`, the envelope
 * `message`, and a refusal's `issues` are decided exactly once — which is what
 * makes "extended, not forked" checkable: there is one classifier, and a
 * resource the panel writes to passes the name of the thing it wrote
 * (`service refused the configuration`, never the bindings sentence a `422`
 * used to get by default).
 *
 * Three rules the extraction keeps, each from the contract:
 *
 * - **The envelope is read, never quoted into a request.** `code` and `message`
 *   exist so a refusal can name its own cause; nothing here forwards a payload
 *   anywhere (SEC-11: the message is rendered as the service's copy, and a
 *   transport failure is described without touching host payloads at all).
 * - **Issues are the service's, in the service's order.** An entry that does
 *   not carry a string `field` *and* a string `remediation` is dropped rather
 *   than guessed at: a half-read issue would be a message the service never
 *   sent (invariant 8), and the list is the panel's only source for AC-107's
 *   "every issue, in order, unrewritten".
 * - **A `422` is a refusal of the resource the caller named; everything else
 *   is a status.** `service answered <n>` never claims which document was
 *   wrong, so a `503` cannot be read as a validation refusal (FR-061, FR-063).
 */

import type { GuestRequestResult } from '@openchamber/sdk';
import { parseJsonObject } from './json.ts';

/** HTTP status the service answers with a `validation` error body. */
const STATUS_VALIDATION = 422;

/** Lowest HTTP status that carries the documented error envelope (§1). */
const STATUS_ERROR_MIN = 400;

/** Lowest HTTP status code a service answer counts as success. */
const STATUS_OK_MIN = 200;

/** HTTP status just past the last success code (`2xx`). */
const STATUS_OK_MAX_EXCLUSIVE = 300;

/**
 * The resources the refusal classifier can name in its problem string (006
 * FR-043).
 *
 * The classifier used to answer every `422` with one fixed sentence naming the
 * **bindings list**, so a configuration refusal rendered through it would have
 * both misnamed the resource and hidden the issues this feature exists to show.
 * Naming the resource is the whole fix: one classifier, and the sentence each
 * caller gets is the one about the thing that caller sent.
 */
export type ServiceResource =
    /** The whole-file bindings grant (005 FR-088's original wording). */
    | 'bindings list'
    /** The whole-file configuration document (006 FR-043). */
    | 'configuration';

/**
 * The two words the actor gate's refusal speaks for the window it judged
 * (003 T-038; the service's own `ReferenceWindow`).
 *
 * **A second declaration of a service vocabulary**, exactly as
 * `BlockedReason` in `relay-gates.ts` and the `blocked:<reason>` family in
 * `run-state.ts` are: the panel cannot import across the extension/service
 * boundary, so the duplication is structural rather than careless. What makes
 * it safe here is that this panel's only reader **refuses** every other word
 * rather than passing one through, and
 * `tests/relay-integrity.test.ts` drives the service's real verdict through
 * this pair — the drift test, without a new exported constant.
 *
 * Value-free, like the thing it describes: two words about a list, never a
 * login (002 NFR-113).
 */
export type ReferenceWindow =
    /** The gate judged every trigger the run accumulated. */
    | 'complete'
    /** The run's reference list was cut, so the gate judged a partial list. */
    | 'truncated';

/** One `field: remediation` pair as a configuration refusal carries it. */
export interface ConfigIssueView {
    /** Field the service named; `<withheld>` for a secret-shaped key. */
    readonly field: string;
    /** The service's own remediation, verbatim (006 FR-024). */
    readonly remediation: string;
}

/** Result of one service round trip through the host bridge. */
export type ServiceResult =
    | { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly problem: string };

/** Result of one call where the service's error code matters to the caller. */
export type ServiceErrorResult =
    | { readonly ok: true; readonly body: string }
    | {
        readonly ok: false;
        readonly problem: string;
        readonly code: string | null;
        /** The envelope's own refusal copy, verbatim; `null` when it sent none. */
        readonly message: string | null;
        /**
         * The window a deciding gate judged, on the one code that judges one
         * (003 T-038); `null` on every other refusal **and** on any answer from a
         * build that states no window.
         *
         * Read as a member rather than derived from `message`, because the
         * service is the only thing that knows which list its decision saw: a
         * panel that inferred it would either re-read a document at another
         * moment or match English, and the first is a stale second opinion while
         * the second is a parse of a sentence it is only obliged to display.
         */
        readonly referenceWindow: ReferenceWindow | null;
    };

/** Result of a configuration write, which keeps the refusal's issue list. */
export type ServiceConfigPutResult =
    | { readonly ok: true; readonly body: string }
    | {
        readonly ok: false;
        /** Names the configuration, never the bindings list (006 AC-112). */
        readonly problem: string;
        /** The envelope's machine code; `null` when none was sent. */
        readonly code: string | null;
        /** The issues in the order the service returned them (006 AC-107). */
        readonly issues: readonly ConfigIssueView[];
        /**
         * The envelope's own correlation identifier, when it sent one — the
         * only identifier an unexpected failure can be traced by, and the one
         * FR-064 requires to be rendered as copyable text.
         */
        readonly correlationId: string | null;
    };

/**
 * Decide whether one HTTP status lands in the 2xx band.
 *
 * @param status - Status to check.
 * @returns `true` inside the band.
 */
export function isOkStatus(status: number): boolean {
    return status >= STATUS_OK_MIN && status < STATUS_OK_MAX_EXCLUSIVE;
}

/**
 * Decide whether one HTTP status carries the documented error envelope.
 *
 * Every status from 400 up answers with `{ error: { code, ... } }`
 * (contract §1), so the extraction only needs the band boundary.
 *
 * @param status - Status to check.
 * @returns `true` inside the error band.
 */
export function isErrorStatus(status: number): boolean {
    return status >= STATUS_ERROR_MIN;
}

/**
 * Describe one non-2xx service answer from the status and the resource.
 *
 * @param status - HTTP status the service answered with.
 * @param resource - What the request was about, named in the refusal copy.
 * @returns A short, secret-free problem string.
 */
export function httpProblem(status: number, resource: ServiceResource): string {
    if (status === STATUS_VALIDATION) {
        return `service refused the ${resource}`;
    }

    return `service answered ${status}`;
}

/**
 * Read the `error` member of a response body as a record.
 *
 * @param body - Response body text (unchecked).
 * @returns The member when it is an object, `null` otherwise.
 */
function errorMemberOf(body: string): Record<string, unknown> | null {
    const root = parseJsonObject(body);
    const error = root === null ? null : root.error;
    if (error === null || typeof error !== 'object' || Array.isArray(error)) {
        return null;
    }

    return error as Record<string, unknown>;
}

/**
 * Read one string member out of an error envelope, without trusting it.
 *
 * @param body - Response body text (unchecked).
 * @param field - Envelope member to read.
 * @returns The member, or `null` when absent or not a string.
 */
export function envelopeFieldOf(body: string, field: string): string | null {
    const error = errorMemberOf(body);
    if (error === null) {
        return null;
    }

    const value = error[field];

    return typeof value === 'string' ? value : null;
}

/**
 * Read the window a refusal's gate judged, refusing every word but the two
 * this build knows (003 T-038).
 *
 * **Closed, so a word from a future build is a refusal rather than a guess**:
 * an unrecognised word reads as `null`, which is the same as *the service said
 * nothing*, and the caller then behaves exactly as it always did. That is the
 * fail-closed direction on purpose — the ordinary answer is the one that is
 * merely unhelpful if wrong, while inventing a third state would have the panel
 * advise an operator to dead-letter a run a single allow-list edit would have
 * dispatched.
 *
 * @param body - Response body text (unchecked).
 * @returns The window, or `null` when the envelope named none this build knows.
 */
export function envelopeReferenceWindowOf(body: string): ReferenceWindow | null {
    const value = envelopeFieldOf(body, 'referenceWindow');

    return value === 'complete' || value === 'truncated' ? value : null;
}

/**
 * Read one issue entry, refusing anything that is not the pair the contract
 * names.
 *
 * @param entry - One element of the envelope's `issues` array.
 * @returns The pair, or `null` when the entry cannot be trusted as one.
 */
function issueViewOf(entry: unknown): ConfigIssueView | null {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return null;
    }

    const { field, remediation } = entry as Record<string, unknown>;
    if (typeof field !== 'string' || typeof remediation !== 'string') {
        return null;
    }

    return { field, remediation };
}

/**
 * Read a refusal's issue list out of an error envelope, in its own order.
 *
 * @param body - Response body text (unchecked).
 * @returns The issues, or `[]` when the envelope sent none.
 */
export function envelopeIssuesOf(body: string): readonly ConfigIssueView[] {
    const error = errorMemberOf(body);
    if (error === null || !Array.isArray(error.issues)) {
        return [];
    }

    const parsed: ConfigIssueView[] = [];
    for (const entry of error.issues) {
        const issue = issueViewOf(entry);
        if (issue !== null) {
            parsed.push(issue);
        }
    }

    return parsed;
}

/**
 * Describe one transport failure without quoting host payloads.
 *
 * @param cause - Caught value.
 * @returns A short, secret-free problem string.
 */
export function describeTransport(cause: unknown): string {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;

    return typeof code === 'string' ? `service unreachable: ${code}` : 'service unreachable';
}

/**
 * Turn one service answer into the plain wrapper's result.
 *
 * @param answer - The result the host bridged back.
 * @param resource - What the request was about, for the refusal copy.
 * @returns The body, or a status-named problem.
 */
export function resultOf(answer: GuestRequestResult, resource: ServiceResource): ServiceResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    return { ok: false, problem: httpProblem(answer.status, resource) };
}

/**
 * Turn one service answer into the error-aware wrapper's result.
 *
 * Same as {@link resultOf}, except a refusal in the error bands also carries
 * the envelope's machine code **and its own message** — both extracted from
 * the body, never quoted into anything but a note — so a caller can
 * distinguish a documented refusal from anything else without parsing the body
 * twice, and can still tell the operator what the service said. A gate's
 * `referenceWindow` rides with them, read by the same closed reader, so a
 * caller that must branch on the window the decision was made on never parses
 * the message to find it.
 *
 * @param answer - The result the host bridged back.
 * @param resource - What the request was about, for the refusal copy.
 * @returns The body, or a problem plus the error code, copy, and window.
 */
export function resultWithErrorOf(answer: GuestRequestResult, resource: ServiceResource): ServiceErrorResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    const inEnvelope = isErrorStatus(answer.status);

    return {
        ok: false,
        problem: httpProblem(answer.status, resource),
        code: inEnvelope ? envelopeFieldOf(answer.body, 'code') : null,
        message: inEnvelope ? envelopeFieldOf(answer.body, 'message') : null,
        referenceWindow: inEnvelope ? envelopeReferenceWindowOf(answer.body) : null,
    };
}

/**
 * Turn a configuration answer into its wrapper's result, issues and all.
 *
 * @param answer - The result the host bridged back.
 * @returns The body, or the problem, code, and issue list of a refusal.
 */
export function configResultOf(answer: GuestRequestResult): ServiceConfigPutResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    const inEnvelope = isErrorStatus(answer.status);

    return {
        ok: false,
        problem: httpProblem(answer.status, 'configuration'),
        code: inEnvelope ? envelopeFieldOf(answer.body, 'code') : null,
        issues: inEnvelope ? envelopeIssuesOf(answer.body) : [],
        correlationId: inEnvelope ? envelopeFieldOf(answer.body, 'correlationId') : null,
    };
}
