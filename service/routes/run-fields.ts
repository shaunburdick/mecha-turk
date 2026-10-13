/**
 * Reading the optional members of a run-scoped request body (003 FR-051;
 * dispatch-authorization contract).
 */

import { validationResponse } from '../http.ts';
import type { FieldIssue, HttpResponse } from '../http.ts';
import type { BaselineProvenance } from '../poll/runs-types.ts';

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
 * Unlike {@link textMember}, an **empty** value is a real answer rather than
 * an absent one: `""` is the documented *no baseline configured*, and the
 * report must still file so the observed agent reaches the run and the trail
 * with its absence named instead of papered over. Absent, non-string and
 * over-long members are still the contract §5 refusal — the member is
 * required, only its emptiness is permitted.
 */
export function baselineMember(value: unknown, bound: number = MAX_BODY_TEXT_CHARS): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();

    return trimmed.length > bound ? null : trimmed;
}

/**
 * The remediation a missing or unknown provenance is answered with, so the
 * `422` names the member and states the vocabulary rather than echoing what
 * arrived (SEC-11 / contract §1).
 */
const PROVENANCE_SHAPE_FIX = 'send one of configured, defaulted, unset — where the comparison baseline came from';

/** The closed provenance vocabulary, in the order the type declares it. */
const BASELINE_PROVENANCES = ['configured', 'defaulted', 'unset'] as const;

/**
 * Read a verification report's baseline provenance.
 *
 * Required and closed: `configured` (a real value was read), `defaulted` (the
 * document could not be read), or `unset` (read and found blank). Anything
 * else — absent, not a string, or outside the three — answers `null`, which
 * {@link readProvenance} turns into the `422` this member owes: without the
 * word, an `agent.uncompared` row could not say *why* no baseline was in force.
 */
function provenanceMember(value: unknown): BaselineProvenance | null {
    return BASELINE_PROVENANCES.find((candidate) => candidate === value) ?? null;
}

/**
 * The `422` a provenance that contradicts its own baseline owes, or `null`
 * when the two agree. The pair is one fact stated twice — a baseline exists
 * iff the provenance that admits to reading one (`configured`) was sent — so
 * a report claiming `configured` against an empty baseline (or
 * `defaulted`/`unset` against a real one) would record a reason its own body
 * disproves. Fail closed: name the field and state the rule, never pick the
 * half that seems likelier (invariant 8).
 */
function provenanceIssue(provenance: BaselineProvenance, expectedAgent: string): FieldIssue | null {
    const isConfigured = provenance === 'configured';
    const hasBaseline = expectedAgent !== '';
    if (isConfigured !== hasBaseline) {
        return {
            field: 'baselineProvenance',
            remediation: "send 'configured' with a non-blank expectedAgent, "
                + "or 'defaulted' or 'unset' with an empty one",
        };
    }

    return null;
}

/**
 * Read a verification report's provenance and check it against that report's
 * own baseline (contract §5 as 003 v1.7.0 widens it).
 *
 * One entry point so the route reads as a single step: the member is required,
 * it is closed to three words, and it must agree with the emptiness of
 * `expectedAgent` it arrived beside.
 *
 */
export function readProvenance(
    fields: Readonly<Record<string, unknown>>,
    expectedAgent: string,
): BaselineProvenance | FieldIssue {
    const provenance = provenanceMember(fields.baselineProvenance);
    if (provenance === null) {
        return { field: 'baselineProvenance', remediation: PROVENANCE_SHAPE_FIX };
    }

    return provenanceIssue(provenance, expectedAgent) ?? provenance;
}

/**
 * Read one boolean member, answering the fallback when it is absent.
 */
export function flagMember(value: unknown, isAbsent: boolean): boolean {
    return typeof value === 'boolean' ? value : isAbsent;
}

/**
 * The issue a `sessionId` outside the host's own shape owes, or `null`.
 *
 * A session id is echoed into the run's state reason, its attempt record, audit
 * details, and refusal messages (T-043f), so it is checked where it enters: only
 * the path-safe form this build's host mints, bounded, is accepted — anything
 * else is a `422` naming the field rather than text the durable trail then
 * carries.
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
 * The `422` an over-long optional free-text member owes, or `null` when
 * every named member fit. Returned **beside** the values rather than instead
 * of them, so a caller can still run its *required* checks first and report
 * the more fundamental failure — one body, one round trip, ordered by
 * severity. A blank member stays absent: nothing was said, so there is
 * nothing to refuse (T-043e).
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
