/**
 * Lifecycle audit rows for the dispatch authorization family (003 FR-060 –
 * FR-063; data-model §4.2).
 *
 * One module owns every row the panel- and operator-driven operations write, so
 * the two things FR-061 and T-040c demand of those rows cannot be satisfied in
 * one place and forgotten in another:
 *
 * - **No row ever carries a `dispatchToken` value.** An unconsumed token is a
 *   live authorization to report a result, `audit.ndjson` is operator-facing,
 *   and it is retained for months — so every row that must *name* the
 *   authorization records {@link buildDispatchTokenFingerprint} instead. The
 *   fingerprint is derived from the token bytes, so two attempts of one run
 *   produce two different values and the row still answers which token was
 *   outstanding; its `tokfp-` prefix is deliberately not `dtk-` so the standing
 *   scan (and an operator grepping the trail) cannot mistake it for a leak.
 * - **Every row names the run**, in `correlationId` and in `entity` (FR-062:
 *   never a fresh identifier). That is what makes one run's chain
 *   reconstructable from `GET /v1/audit?correlationId=` alone (AC-116/117).
 *
 * Two more properties these rows owe, both about honesty under unbounded input:
 *
 * - **Free text from a panel or an operator is bounded with a visible marker.**
 *   `problem`, `reason`, `detail`, `guidance`, `note`, and `causeReport` are
 *   panel- or operator-authored and land in a file nothing trims; an unbounded
 *   copy is unbounded durable growth on a row that exists to be read.
 * - **The actor source is per row, not per module.** A reserve is the panel
 *   declaring intent, a duplicate report is the *service* recording a repeat it
 *   recognised, and a retry or resolve is the operator acting. Collapsing them
 *   into one actor would make the trail unable to answer who caused what.
 *
 * {@link appendRunRow} is the one way these rows reach the disk: the durable
 * state change happens first and is never rolled back, and a failed append is
 * reported as `auditWritten: false` for the caller to surface (FR-063) rather
 * than swallowed. The sweep keeps its own appender because its row is replayed
 * from a durable intent and must be byte-identical to that intent.
 */

import { appendAudit } from '../audit.ts';
import type { AuditInput } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { buildDispatchTokenFingerprint } from './run-key.ts';
import type { Run, RunState, RunVerification } from './runs-types.ts';


/** Entity kind every run-scoped lifecycle row names (FR-061). */
const RUN_ENTITY_KIND = 'run';

/** The panel declares the intent; the panel reports the outcome. */
const PANEL_ACTOR = 'panel';

/** The service recognises and records a repeat, and records every refusal. */
const SERVICE_ACTOR = 'service';

/** An operator retries, returns to waiting, or resolves. */
const OPERATOR_ACTOR = 'operator';

/** Longest panel- or operator-authored text a row carries. */
const MAX_ROW_TEXT_CHARS = 500;

/** The marker appended to text this module had to cut (FR-014's own convention). */
const TEXT_TRUNCATION_MARKER = '… [truncated]';

/**
 * Bound one row's free text, marking it when it was cut.
 *
 * @param value - Panel- or operator-authored text, or `null`.
 * @returns The text within {@link MAX_ROW_TEXT_CHARS}, marked when cut.
 */
function rowText(value: string | null): string | null {
    if (value === null || value.length <= MAX_ROW_TEXT_CHARS) {
        return value;
    }

    return `${value.slice(0, MAX_ROW_TEXT_CHARS)}${TEXT_TRUNCATION_MARKER}`;
}

/** Every lifecycle row carries the run, so the builder's base is written once. */
function runRow(run: Run): Pick<AuditInput, 'entity' | 'correlationId'> {
    return { entity: { kind: RUN_ENTITY_KIND, id: run.correlationId }, correlationId: run.correlationId };
}

/**
 * The four credential-free scalars `dispatch.reserved` and `dispatch.result`
 * gain from 004 (FR-050; data-model §4.2).
 *
 * Written **by the service from the run's snapshot**, never from a request
 * body: the panel can report what it did, but what prompt a run used is a
 * fact the stored run owns. The fingerprint is derived from the text rather
 * than minted per row, so every row of one prompt carries the identical value
 * (003 FR-062 reaffirmed).
 *
 * @param run - The run whose snapshot these name.
 * @returns The binding id plus the prompt's presence, fingerprint, and length.
 */
function promptDetails(run: Run): {
    /** Binding the run dispatched through. */
    readonly bindingId: string;
    /** Whether a starting prompt was set when the run was queued. */
    readonly promptPresent: boolean;
    /** Its fingerprint, or `null` when none. */
    readonly promptFingerprint: string | null;
    /** Its length, or `null` when none. */
    readonly promptLength: number | null;
} {
    return {
        bindingId: run.bindingId,
        promptPresent: run.prompt !== null,
        promptFingerprint: run.prompt === null ? null : run.prompt.fingerprint,
        promptLength: run.prompt === null ? null : run.prompt.length,
    };
}

/**
 * `dispatch.reserved` — the panel declared intent to start a session.
 *
 * @param input - The authorized run, the lease it was made under, and its token.
 * @returns The row to append.
 */
export function reservedRow(input: {
    /** The run as it stands in `starting`. */
    readonly run: Run;
    /** Lease the reservation was made under. */
    readonly leaseId: string;
    /** Token just minted; recorded as its fingerprint only. */
    readonly dispatchToken: string;
}): AuditInput {
    return {
        eventType: 'dispatch.reserved',
        actorSource: PANEL_ACTOR,
        ...runRow(input.run),
        details: {
            leaseId: input.leaseId,
            attempt: input.run.attempt,
            dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
            attachmentId: input.run.attachmentId,
            ...promptDetails(input.run),
        },
    };
}

/**
 * `dispatch.result` — the panel reported what the host call produced.
 *
 * @param input - The reported run, its token, and the session it created or the
 *   problem it hit. Exactly one of the last two is non-`null` (FR-040).
 * @returns The row to append.
 */
export function resultRow(input: {
    /** The run as it now stands. */
    readonly run: Run;
    /** Token the report carried; recorded as its fingerprint only. */
    readonly dispatchToken: string;
    /** Session the dispatch created, else `null`. */
    readonly sessionId: string | null;
    /** Failure the dispatch reported, else `null`. */
    readonly problem: string | null;
}): AuditInput {
    return {
        eventType: 'dispatch.result',
        actorSource: PANEL_ACTOR,
        ...runRow(input.run),
        decision: input.sessionId === null ? 'failed' : 'dispatched',
        details: {
            attempt: input.run.attempt,
            dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
            ...(input.sessionId === null ? { failureReason: rowText(input.problem) } : { sessionId: input.sessionId }),
            ...promptDetails(input.run),
        },
    };
}

/**
 * `dispatch.duplicate-report` — a recorded outcome was repeated unchanged.
 *
 * @param input - The run, the repeated token, and the state it repeated.
 * @returns The row to append.
 */
export function duplicateReportRow(input: {
    /** The run, byte-unchanged by the repeat. */
    readonly run: Run;
    /** Token the repeat carried; recorded as its fingerprint only. */
    readonly dispatchToken: string;
    /** The state the repeated report left behind. */
    readonly state: RunState;
}): AuditInput {
    return {
        eventType: 'dispatch.duplicate-report',
        actorSource: SERVICE_ACTOR,
        ...runRow(input.run),
        decision: 'no-change',
        details: {
            attempt: input.run.attempt,
            dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
            state: input.state,
        },
    };
}

/**
 * `dispatch.abandoned` — a reserved attempt created no session.
 *
 * @param input - The failed run, its token, and the reason it was abandoned.
 * @returns The row to append.
 */
export function abandonedRow(input: {
    /** The run as it now stands in `failed`. */
    readonly run: Run;
    /** Token the report carried; recorded as its fingerprint only. */
    readonly dispatchToken: string;
    /** Why no host call produced a session. */
    readonly reason: string;
}): AuditInput {
    return {
        eventType: 'dispatch.abandoned',
        actorSource: PANEL_ACTOR,
        ...runRow(input.run),
        decision: 'no-session',
        details: {
            attempt: input.run.attempt,
            dispatchTokenFingerprint: buildDispatchTokenFingerprint(input.dispatchToken),
            reason: rowText(input.reason),
        },
    };
}

/**
 * `run.blocked` — a fail-closed guard refused before any host call (FR-042).
 *
 * @param input - The blocked run, the cause, the state it left, and the
 *   guidance the panel offered in-panel.
 * @returns The row to append.
 */
export function blockedRow(input: {
    /** The run as it now stands in `blocked:<reason>`. */
    readonly run: Run;
    /** Which of the four documented causes fired. */
    readonly blockedReason: string;
    /** The state the run was held in before the report. */
    readonly priorState: RunState;
    /** In-panel guidance the operator was shown. */
    readonly guidance: string | null;
}): AuditInput {
    return {
        eventType: 'run.blocked',
        actorSource: PANEL_ACTOR,
        ...runRow(input.run),
        decision: 'blocked',
        details: {
            blockedReason: input.blockedReason,
            priorState: input.priorState,
            guidance: rowText(input.guidance),
        },
    };
}

/**
 * `dispatch.retry` — the operator returned a run to waiting.
 *
 * Covers both shapes FR-041 and FR-033 require: a retry of a `failed` or
 * `blocked:*` run, and the dead-letter return-to-waiting that resets the attempt
 * count. `reset` is what makes the second legible in the trail, because it is
 * the action that starts a fresh token-consumption chain (plan D6).
 *
 * @param input - The waiting run plus what the operator reported and what the
 *   service could corroborate itself.
 * @returns The row to append.
 */
export function retryRow(input: {
    /** The run as it now stands in `pending`. */
    readonly run: Run;
    /** The state the operator acted on. */
    readonly priorState: RunState;
    /** Attempt before the operator's action. */
    readonly attemptBefore: number;
    /** Attempt after it. */
    readonly attemptAfter: number;
    /** Whether the operator reported the cause cleared, else `null`. */
    readonly causeReportedCleared: boolean | null;
    /** Whether the service corroborated it, the panel reported it, or neither applies. */
    readonly causeClearedSource: 'corroborated' | 'reported' | null;
    /** Whether this action reset the attempt chain (FR-033). */
    readonly reset: boolean;
    /** The operator's or panel's own words about the cause. */
    readonly causeReport: string | null;
}): AuditInput {
    return {
        eventType: 'dispatch.retry',
        actorSource: OPERATOR_ACTOR,
        ...runRow(input.run),
        decision: 'retry',
        details: {
            priorState: input.priorState,
            attemptBefore: input.attemptBefore,
            attemptAfter: input.attemptAfter,
            causeReportedCleared: input.causeReportedCleared,
            causeClearedSource: input.causeClearedSource,
            attemptReset: input.reset,
            causeReport: rowText(input.causeReport),
        },
    };
}

/**
 * `dispatch.resolved` — the operator settled an `unconfirmed` run (FR-027).
 *
 * @param input - The resolved run, the prior state, the decision, and what the
 *   operator was shown and wrote.
 * @returns The row to append.
 */
export function resolvedRow(input: {
    /** The run as it now stands. */
    readonly run: Run;
    /** The `unconfirmed` state the run was resolved from. */
    readonly priorState: RunState;
    /** Which of the two explicit resolutions the operator chose. */
    readonly decision: 'dispatched' | 'no-session';
    /** The operator's note about what they verified. */
    readonly note: string | null;
    /** The guidance the operator was shown before deciding. */
    readonly guidance: string | null;
}): AuditInput {
    return {
        eventType: 'dispatch.resolved',
        actorSource: OPERATOR_ACTOR,
        ...runRow(input.run),
        decision: input.decision,
        details: {
            priorState: input.priorState,
            note: rowText(input.note),
            guidance: rowText(input.guidance),
        },
    };
}

/**
 * `agent.verified` / `agent.mismatch` — the post-dispatch agent read-back.
 *
 * One builder for both because the details are identical and only the vocabulary
 * name and the decision differ: the read-back is warn-only (FR-043), so a
 * mismatch is recorded and shown and then never acted on again.
 *
 * A report carrying `expectedAgent: ""` is a read-back against **no configured
 * baseline**: nothing was compared, and the row records the observed agent
 * beside the empty baseline so the absence is legible in the trail months
 * later. The panel renders that case as *observed, not compared* — never as a
 * mismatch — and no run state changes either way (002 FR-029 as amended).
 *
 * @param input - The run, the session read back, and the recorded outcome.
 * @returns The row to append.
 */
export function verificationRow(input: {
    /** The run, whose state this row never changes. */
    readonly run: Run;
    /** The recorded read-back outcome. */
    readonly verification: RunVerification;
}): AuditInput {
    const { verification } = input;
    const matched = verification.ok;

    return {
        eventType: matched ? 'agent.verified' : 'agent.mismatch',
        actorSource: PANEL_ACTOR,
        ...runRow(input.run),
        decision: matched ? 'verified' : 'warn',
        details: {
            sessionId: input.run.session?.sessionId ?? '',
            observedAgent: verification.observedAgent,
            expectedAgent: verification.expectedAgent,
            note: rowText(verification.note),
        },
    };
}

/**
 * `dispatch.refused` — one run-scoped operation answered `4xx` (FR-003).
 *
 * The only row in the family whose `reason` is written twice — once in the
 * response and once here — so it is passed in rather than composed, which is
 * what makes the two provably the same string.
 *
 * @param input - The operation refused, its code, the secret-free cause, and
 *   whatever the run's prior state, attempt, lease, and token were.
 * @returns The row to append.
 */
export function refusedRow(input: {
    /** Run whose operation was refused; the row's entity and correlation. */
    readonly run: Run;
    /** The operation the caller attempted (`reserve`, `result`, `retry`, …). */
    readonly operation: string;
    /** The wire code the response carries. */
    readonly code: string;
    /** The secret-free cause, identical to the response's message. */
    readonly reason: string;
    /** Attempt the run stood on, when known. */
    readonly attempt: number | null;
    /** Lease the caller presented, when the refusal was a staleness verdict. */
    readonly leaseId?: string | undefined;
    /** Token the caller presented as its fingerprint, for a token verdict. */
    readonly dispatchTokenFingerprint?: string | undefined;
}): AuditInput {
    return {
        eventType: 'dispatch.refused',
        actorSource: SERVICE_ACTOR,
        ...runRow(input.run),
        decision: 'refused',
        reason: input.reason,
        details: {
            operation: input.operation,
            code: input.code,
            priorState: input.run.state,
            attempt: input.attempt,
            ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
            ...(input.dispatchTokenFingerprint === undefined
                ? {}
                : { dispatchTokenFingerprint: input.dispatchTokenFingerprint }),
        },
    };
}

/**
 * Append one run-scoped lifecycle row, reporting whether it landed.
 *
 * The row is always appended *after* the durable change it describes, and a
 * failure is never allowed to undo that change (FR-063): it is logged with the
 * run named and answered as `false`, which is what the operator's panel turns
 * into a visible warning rather than implying traceability it does not have.
 *
 * The run's id is passed beside the row rather than read off it, because the
 * audit writer treats `correlationId` as optional for the rows that have no run
 * behind them — and a failure log that omitted the run would be the one place
 * FR-063's "naming the run" could not be satisfied.
 *
 * @param input - Store, logger, the run the row concerns, and the row itself.
 * @returns `true` when the row reached the trail, `false` when the append failed.
 */
export async function appendRunRow(input: {
    /** Open store. */
    readonly store: ServiceStore;
    /** Structured logger. */
    readonly log: ServiceLogger;
    /** The run the row concerns; named in the failure log. */
    readonly correlationId: string;
    /** The row to append; built by one of the builders in this module. */
    readonly row: AuditInput;
}): Promise<boolean> {
    try {
        await appendAudit(input.store, input.row);

        return true;
    } catch (cause) {
        input.log.warn('dispatch lifecycle audit row could not be appended', {
            correlationId: input.correlationId,
            eventType: input.row.eventType,
            errorKind: cause instanceof Error ? cause.name : typeof cause,
        });

        return false;
    }
}
