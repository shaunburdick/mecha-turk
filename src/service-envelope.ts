/**
 * The one place a service answer is classified: envelope read, never quoted, issues in the service's order (inv. 8).
 */

import type { GuestRequestResult } from '@openchamber/sdk';
import { parseJsonObject } from './json.ts';

const STATUS_VALIDATION = 422;

/** Lowest HTTP status that carries the documented error envelope (§1). */
const STATUS_ERROR_MIN = 400;

const STATUS_OK_MIN = 200;

const STATUS_OK_MAX_EXCLUSIVE = 300;

/**
 * The resources the refusal classifier can name in its problem string (006
 * FR-043): the classifier used to answer every `422` with one fixed sentence
 * naming the **bindings list**, so a configuration refusal both misnamed the
 * resource and hid the issues this feature exists to show. One classifier, and
 * each caller gets the sentence about the thing that caller sent.
 */
export type ServiceResource =
    /** The whole-file bindings grant (005 FR-088's original wording). */
    | 'bindings list'
    | 'configuration';

/**
 * The two words the actor gate's refusal speaks for the window it judged (003
 * T-038; the service's own `ReferenceWindow`) — **a second declaration of a
 * service vocabulary**, like `BlockedReason` and the `blocked:<reason>` family:
 * the panel cannot import across the extension/service boundary, so the
 * duplication is structural rather than careless. What makes it safe is that
 * this panel's only reader **refuses** every other word, and
 * `tests/relay-integrity.test.ts` drives the service's real verdict through
 * this pair — the drift test, without a new exported constant. Value-free:
 * two words about a list, never a login.
 */
export type ReferenceWindow =
    | 'complete'
    | 'truncated';

export interface ConfigIssueView {
    /** Field the service named; `<withheld>` for a secret-shaped key. */
    readonly field: string;
    /** The service's own remediation, verbatim (006 FR-024). */
    readonly remediation: string;
}

export type ServiceResult =
    | { readonly ok: true; readonly body: string }
    | { readonly ok: false; readonly problem: string };

export type ServiceErrorResult =
    | { readonly ok: true; readonly body: string }
    | {
        readonly ok: false;
        readonly problem: string;
        readonly code: string | null;
        readonly message: string | null;
        /**
         * The window a deciding gate judged, on the one code that judges one;
         * `null` on every other refusal and on any answer from a build that
         * states no window. Read as a member rather than derived from
         * `message`: the service alone knows which list its decision saw, and a
         * panel that inferred it would either re-read at another moment (stale)
         * or match English (a parse of a sentence it must only display).
         */
        readonly referenceWindow: ReferenceWindow | null;
    };

export type ServiceConfigPutResult =
    | { readonly ok: true; readonly body: string }
    | {
        readonly ok: false;
        /** Names the configuration, never the bindings list. */
        readonly problem: string;
        readonly code: string | null;
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
 */
export function isOkStatus(status: number): boolean {
    return status >= STATUS_OK_MIN && status < STATUS_OK_MAX_EXCLUSIVE;
}

/**
 * Decide whether one HTTP status carries the documented error envelope: every
 * status from 400 up answers `{ error: { code, ... } }` (contract §1), so the
 * extraction only needs the band boundary. `true` inside the error band.
 */
export function isErrorStatus(status: number): boolean {
    return status >= STATUS_ERROR_MIN;
}

/**
 * Describe one non-2xx service answer from the status and the resource.
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
 * Read the window a refusal's gate judged, refusing every word but the two this
 * build knows: **closed, so a word from a future build is a refusal rather
 * than a guess** — an unrecognised word reads as `null`, the same as *the
 * service said nothing*, and the caller behaves as it always did. That is the
 * fail-closed direction on purpose: the ordinary answer is merely unhelpful if
 * wrong, while a guessed third state could advise dead-lettering a run a single
 * allow-list edit would have dispatched. `null` when the envelope named no
 * window this build knows.
 */
export function envelopeReferenceWindowOf(body: string): ReferenceWindow | null {
    const value = envelopeFieldOf(body, 'referenceWindow');

    return value === 'complete' || value === 'truncated' ? value : null;
}

/**
 * Read one issue entry, refusing anything that is not the pair the contract
 * names.
 *
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
 */
export function describeTransport(cause: unknown): string {
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;

    return typeof code === 'string' ? `service unreachable: ${code}` : 'service unreachable';
}

/**
 * Turn one service answer into the plain wrapper's result.
 */
export function resultOf(answer: GuestRequestResult, resource: ServiceResource): ServiceResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    return { ok: false, problem: httpProblem(answer.status, resource) };
}

/**
 * Turn one service answer into the error-aware wrapper's result: same as
 * {@link resultOf}, except a refusal in the error bands also carries the
 * envelope's machine code **and its own message** — extracted from the body,
 * never quoted into anything but a note — so a caller can tell a documented
 * refusal from anything else without parsing the body twice. A gate's
 * `referenceWindow` rides with them, read by the same closed reader, so a
 * caller branching on the judged window never parses the message to find it.
 * Answers the body, or a problem plus the error code, copy, and window.
 */
export function resultWithErrorOf(answer: GuestRequestResult, resource: ServiceResource): ServiceErrorResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    const isInEnvelope = isErrorStatus(answer.status);

    return {
        ok: false,
        problem: httpProblem(answer.status, resource),
        code: isInEnvelope ? envelopeFieldOf(answer.body, 'code') : null,
        message: isInEnvelope ? envelopeFieldOf(answer.body, 'message') : null,
        referenceWindow: isInEnvelope ? envelopeReferenceWindowOf(answer.body) : null,
    };
}

/**
 * Turn a configuration answer into its wrapper's result, issues and all.
 */
export function configResultOf(answer: GuestRequestResult): ServiceConfigPutResult {
    if (isOkStatus(answer.status)) {
        return { ok: true, body: answer.body };
    }

    const isInEnvelope = isErrorStatus(answer.status);

    return {
        ok: false,
        problem: httpProblem(answer.status, 'configuration'),
        code: isInEnvelope ? envelopeFieldOf(answer.body, 'code') : null,
        issues: isInEnvelope ? envelopeIssuesOf(answer.body) : [],
        correlationId: isInEnvelope ? envelopeFieldOf(answer.body, 'correlationId') : null,
    };
}
