/**
 * Reading the optional members of a run-scoped request body (003 FR-051;
 * [contracts/dispatch-authorization.md](../../specs/003-dispatch-integrity/contracts/dispatch-authorization.md)).
 *
 * Split out of [`run-scope.ts`](./run-scope.ts) so that file owns *how a
 * request is read and answered* — path guard, shared members, response mapping,
 * the refusal row — while this one owns *what a body member may be*. Both route
 * modules import from here, and neither has to re-derive a bound that four
 * operations already share.
 *
 * Two rules hold for everything below, and neither is negotiable:
 *
 * - **A received value is never echoed.** A rejection is always
 *   `{ field, remediation }`: the member is named and the fix is stated, and
 *   what arrived appears nowhere (SEC-11 / contract §1).
 * - **A bound is a refusal, not a truncation.** Text is cut with a visible
 *   marker only where a row must still be written; a *request* whose optional
 *   text does not fit is answered `422` naming the field, because storing half a
 *   cause as though it were the whole one is the dishonest direction
 *   (`textMember`'s own contract, T-043e).
 */

import { validationResponse } from '../http.ts';
import type { FieldIssue, HttpResponse } from '../http.ts';

/** Longest free-text body member the operations accept. */
export const MAX_BODY_TEXT_CHARS = 1_000;

/**
 * The shape the host mints a session id in, and the bound these routes accept.
 *
 * `ses_` plus a path-safe segment (`A-Za-z0-9`, `.`, `_`, `-`, `~`), capped so a
 * value echoed into a state reason, an attempt record, an audit detail, and a
 * refusal message cannot be an unbounded durable string. The member is echoed in
 * all four places (T-043f), so the shape is checked where it enters rather than
 * where it lands.
 */
const SESSION_ID_PATTERN = /^ses_[A-Za-z0-9._~-]+$/;

/** Longest host session id a run-scoped body may present. */
const MAX_SESSION_ID_CHARS = 128;

/**
 * Read one free-text member, treating an absent, blank, or over-long one as
 * absent.
 *
 * Bounding here rather than accepting whatever arrived is what keeps an
 * unbounded panel string out of a durable audit row; for an **optional** member
 * that is only half the job — the operation then owes a `422` naming the field
 * rather than a silently absent value, which is {@link readOptionalText}'s step.
 *
 * @param value - The member as received.
 * @param bound - Longest value accepted.
 * @returns The trimmed text, or `null`.
 */
export function textMember(value: unknown, bound: number = MAX_BODY_TEXT_CHARS): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();

    return trimmed.length === 0 || trimmed.length > bound ? null : trimmed;
}

/**
 * Read a verification report's comparison baseline (002 FR-029 as amended).
 *
 * Unlike {@link textMember}, an **empty** value is a real answer rather than an
 * absent one: `""` is the documented *no baseline configured*, and the report
 * must still file so the read-back's observed agent reaches the run and the
 * trail with its absence named instead of papered over. Absent, non-string, and
 * over-long members are still the contract §5 refusal — the member is required,
 * only its emptiness is permitted.
 *
 * @param value - The member as received.
 * @param bound - Longest value accepted.
 * @returns The trimmed text, possibly empty, or `null` when the member is
 *   absent, not a string, or over the bound.
 */
export function baselineMember(value: unknown, bound: number = MAX_BODY_TEXT_CHARS): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();

    return trimmed.length > bound ? null : trimmed;
}

/**
 * Read one boolean member, answering the fallback when it is absent.
 *
 * @param value - The member as received.
 * @param fallback - What an absent or non-boolean member means here.
 * @returns The boolean, or the fallback.
 */
export function flagMember(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

/**
 * The issue a `sessionId` outside the host's own shape owes, or `null`.
 *
 * A session id is echoed into the run's state reason, its attempt record, audit
 * details, and refusal messages (T-043f), so it is checked where it enters: only
 * the path-safe form this build's host mints, bounded, is accepted — anything
 * else is a `422` naming the field rather than text the durable trail then
 * carries.
 *
 * @param value - The member as {@link textMember} read it, or `null` when absent.
 * @returns The issue, or `null` when the value is absent or well-formed.
 */
export function sessionIdIssue(value: string | null): FieldIssue | null {
    if (value === null) {
        return null;
    }

    if (value.length > MAX_SESSION_ID_CHARS || !SESSION_ID_PATTERN.test(value)) {
        return {
            field: 'sessionId',
            remediation: 'send the session id the host minted: ses_ followed by at most '
                + `${MAX_SESSION_ID_CHARS} path-safe characters`,
        };
    }

    return null;
}

/**
 * The `422` an over-long optional free-text member owes, or `null` when every
 * named member fit.
 *
 * `textMember` bounds the value rather than accepting whatever arrived — right
 * for keeping an unbounded panel string out of a durable audit row, and
 * incomplete on its own: a caller reading only `null` cannot tell an absent
 * member from one it had to cut, so the reader's own promise that "the operation
 * then answers `422` naming the field" went unkept for `causeReport`, `note`,
 * `guidance`, and `observedAgent` (T-043e). This is that step, returned beside
 * the values rather than instead of them so a caller can still run its
 * *required* checks first and report the more fundamental failure before this
 * one — one body, one round trip, ordered by severity.
 *
 * A blank member stays absent: nothing was said, so there is nothing to refuse.
 *
 * @param fields - The body's members.
 * @param names - The optional free-text names this operation reads.
 * @returns The `422` naming whichever member was too long, else `null`.
 */
export function overLongTextResponse(
    fields: Readonly<Record<string, unknown>>,
    names: readonly string[],
): HttpResponse | null {
    const issues: FieldIssue[] = [];
    for (const name of names) {
        const value = fields[name];
        if (typeof value === 'string' && value.trim().length > MAX_BODY_TEXT_CHARS) {
            issues.push({ field: name, remediation: `send at most ${MAX_BODY_TEXT_CHARS} characters` });
        }
    }

    return issues.length > 0 ? validationResponse(issues) : null;
}
