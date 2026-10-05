/**
 * Lifecycle audit rows for the dispatch authorization family.
 *
 * One module owns every row the panel- and operator-driven operations write, so
 * the properties those rows owe cannot be satisfied in one place and forgotten in
 * another:
 *
 * - **No row ever carries a `dispatchToken` value.** An unconsumed token is a
 *   live authorization to report a result, `audit.ndjson` is operator-facing,
 *   and it is retained for months — so every row that must *name* the
 *   authorization records {@link buildDispatchTokenFingerprint} instead. The
 *   fingerprint is derived from the token bytes, so two attempts of one run
 *   produce two different values and the row still answers which token was
 *   outstanding; its `tokfp-` prefix is deliberately not `dtk-` so the standing
 *   scan (and an operator grepping the trail) cannot mistake it for a leak.
 * - **Every row names the run**, in `correlationId` and in `entity` — never a
 *   fresh identifier. That is what makes one run's chain reconstructable from
 *   `GET /v1/audit?correlationId=` alone.
 * - **Free text from a panel or an operator is bounded with a visible marker.**
 *   `problem`, `reason`, `detail`, `guidance`, `note`, and `causeReport` are
 *   panel- or operator-authored and land in a file nothing trims; an unbounded
 *   copy is unbounded durable growth on a row that exists to be read. The bound
 *   itself lives in [`row-text.ts`](./row-text.ts) — it is a policy, and one
 *   shared by every builder here, including the gate's `deniedLogins`, whose
 *   values arrive from the *store* rather than from a caller (see
 *   {@link actorDetails}).
 * - **The actor source is per row, not per module.** A reserve is the panel
 *   declaring intent, a duplicate report is the *service* recording a repeat it
 *   recognised, and a retry or resolve is the operator acting. Collapsing them
 *   into one actor would make the trail unable to answer who caused what.
 *
 * {@link appendRunRow} is the one way these rows reach the disk: the durable
 * state change happens first and is never rolled back, and a failed append is
 * reported as `auditWritten: false` for the caller to surface rather than
 * swallowed. The sweep keeps its own appender because its row is replayed from a
 * durable intent and must be byte-identical to that intent.
 */

import { appendAudit } from '../audit.ts';
import type { AuditInput } from '../audit.ts';
import type { ServiceLogger } from '../log.ts';
import type { PromptSource } from '../prompt.ts';
import type { ServiceStore } from '../store/index.ts';
import { boundText, rowText } from './row-text.ts';
import { buildDispatchTokenFingerprint } from './run-key.ts';
import type { ActorGateRefusal, BaselineProvenance, Run, RunState, RunVerification } from './runs-types.ts';


/** Entity kind every run-scoped lifecycle row names. */
const RUN_ENTITY_KIND = 'run';

/** The panel declares the intent; the panel reports the outcome. */
const PANEL_ACTOR = 'panel';

/** The service recognises and records a repeat, and records every refusal. */
const SERVICE_ACTOR = 'service';

/** An operator retries, returns to waiting, or resolves. */
const OPERATOR_ACTOR = 'operator';

/** Every lifecycle row carries the run, so the builder's base is written once. */
function runRow(run: Run): Pick<AuditInput, 'entity' | 'correlationId'> {
    return { entity: { kind: RUN_ENTITY_KIND, id: run.correlationId }, correlationId: run.correlationId };
}

/**
 * The credential-free scalars `dispatch.reserved` and `dispatch.result` gain
 * from the layered starting prompt.
 *
 * Written **by the service from the run's snapshot**, never from a request
 * body: the panel can report what it did, but what prompt a run used — and
 * which tiers produced it — is a fact the stored run owns. The fingerprint is
 * derived from the text rather than minted per row, so every row of one prompt
 * carries the identical value, and `promptSources` is the snapshot's own ordered
 * tier list copied verbatim: an element the run's snapshot never held can never
 * appear on a row.
 *
 * @returns The binding id plus the prompt's presence, fingerprint, length, and
 *   the ordered set of tiers that produced it.
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
    /** Contributing tiers order, or `null` when none. */
    readonly promptSources: readonly PromptSource[] | null;
    /**
     * The **shape** of the binding's allow-list in force when the gate
     * authorized this attempt.
     *
     * Read from the run's own snapshot rather than re-reading the binding,
     * which is what makes this row and `dispatch.result` provably describe one
     * policy even though an operator may have edited the list between them. Two
     * words, never a login: a retained trail listing who may trigger a
     * repository is a second copy of the access policy.
     */
    readonly actorPolicy: Run['actorPolicy'];
} {
    return {
        bindingId: run.bindingId,
        promptPresent: run.prompt !== null,
        promptFingerprint: run.prompt === null ? null : run.prompt.fingerprint,
        promptLength: run.prompt === null ? null : run.prompt.length,
        promptSources: run.prompt === null ? null : run.prompt.sources,
        actorPolicy: run.actorPolicy,
    };
}

/** `dispatch.reserved` — the panel declared intent to start a session. */
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
 * Exactly one of `sessionId` and `problem` is non-`null`.
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

/** `dispatch.duplicate-report` — a recorded outcome was repeated unchanged. */
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

/** `dispatch.abandoned` — a reserved attempt created no session. */
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

/** `run.blocked` — a fail-closed guard refused before any host call. */
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
 * Covers both shapes a retry can take: a retry of a `failed` or `blocked:*` run,
 * and the dead-letter return-to-waiting that resets the attempt count. `reset`
 * is what makes the second legible in the trail, because it is the action that
 * starts a fresh token-consumption chain.
 */
export function retryRow(input: {
    /** The run as it now stands in `pending`. */
    readonly run: Run;
    /** The state the operator acted on. */
    readonly priorState: RunState;
    /** Attempt before the operator's action. */
    readonly attemptBefore: number;
    readonly attemptAfter: number;
    /** Whether the operator reported the cause cleared, else `null`. */
    readonly causeReportedCleared: boolean | null;
    /** Whether the service corroborated it, the panel reported it, or neither applies. */
    readonly causeClearedSource: 'corroborated' | 'reported' | null;
    /** Whether this action reset the attempt chain. */
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

/** `dispatch.resolved` — the operator settled an `unconfirmed` run. */
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
 * The vocabulary name and decision one agent read-back owes.
 *
 * Split out of {@link verificationRow} for the one rule it encodes: the axis
 * only exists where a comparison did. A blank baseline has no verdict to
 * record, so it answers `observed` before `ok` is ever consulted — which is
 * what keeps the usual read-back from landing under `agent.mismatch`.
 */
function readBackVerdict(input: {
    /** Whether a configured baseline was there to compare against. */
    readonly wasCompared: boolean;
    /** Whether the comparison matched; meaningless when nothing was compared. */
    readonly wasMatched: boolean;
}): { readonly eventType: string; readonly decision: string } {
    if (!input.wasCompared) {
        return { eventType: 'agent.uncompared', decision: 'observed' };
    }

    return input.wasMatched
        ? { eventType: 'agent.verified', decision: 'verified' }
        : { eventType: 'agent.mismatch', decision: 'warn' };
}

/**
 * `agent.verified` / `agent.mismatch` / `agent.uncompared` — the post-dispatch
 * agent read-back.
 *
 * One builder for all three because the details are identical and only the
 * vocabulary name, the decision, and one extra member differ: the read-back is
 * warn-only, so a mismatch is recorded and shown and then never acted
 * on again.
 *
 * **Which row is chosen by whether a comparison was possible, never by whether
 * an agent was seen.** A report carrying `expectedAgent: ""` is a read-back
 * against **no configured baseline**: nothing was compared, so no verdict exists
 * to record — `ok` cannot make one true, and `agent.mismatch` is unreachable
 * while the baseline is empty. That row is `agent.uncompared`, decision
 * `observed`, and it carries the baseline's provenance (`defaulted` / `unset`)
 * beside the empty `expectedAgent` so the absence is legible in the trail months
 * later. The panel renders that case as *observed, not compared* — never as a
 * mismatch — and no run state changes either way.
 */
export function verificationRow(input: {
    /** The run, whose state this row never changes. */
    readonly run: Run;
    /** The recorded read-back outcome. */
    readonly verification: RunVerification;
    /** Where the comparison baseline came from. */
    readonly baselineProvenance: BaselineProvenance;
}): AuditInput {
    const { verification } = input;
    // A blank baseline means nothing was compared, whatever `ok` claims: the
    // verdict axis only exists where a configured baseline does.
    const wasCompared = verification.expectedAgent !== '';
    const verdict = readBackVerdict({
        wasCompared,
        wasMatched: wasCompared && verification.ok,
    });

    return {
        eventType: verdict.eventType,
        actorSource: PANEL_ACTOR,
        ...runRow(input.run),
        decision: verdict.decision,
        details: {
            sessionId: input.run.session?.sessionId ?? '',
            observedAgent: verification.observedAgent,
            expectedAgent: verification.expectedAgent,
            // Only the uncompared row records a provenance: a comparison
            // against a configured baseline already says which baseline it was.
            ...(!wasCompared && { baselineProvenance: input.baselineProvenance }),
            note: rowText(verification.note),
        },
    };
}

/**
 * The gate's extra detail keys, as the row spells them.
 *
 * The two arrays are **index-parallel** rather than one combined list: a reader
 * asking "what basis did this login carry?" answers with one index, and a
 * misaligned pair cannot be constructed.
 *
 * **Bounded like every other free-text member here.** `deniedLogins` is the one
 * detail member whose values the *store* does not bound — a `SourceReference`'s
 * `actorLogin` is validated as non-empty text and nothing more — so each entry
 * goes through {@link boundText} exactly as `problem`, `reason`, and `note` do.
 * The three window members ride on **every** gate refusal, including one made
 * without a policy: they are facts about the run, and a reader needs them to
 * know whether the decision saw the whole trigger history.
 */
function actorDetails(actor: ActorGateRefusal): Record<string, unknown> {
    return {
        bindingId: actor.bindingId,
        actorPolicy: actor.actorPolicy,
        // Omitted rather than `[]` on the policy-read failure: nothing was
        // compared, and an empty array reads as *every actor was refused*.
        ...(actor.deniedLogins !== undefined && { deniedLogins: actor.deniedLogins.map((login) => boundText(login)) }),
        ...(actor.deniedAttributions !== undefined && { deniedAttributions: [...actor.deniedAttributions] }),
        unreadableReferences: actor.unreadableReferences,
        retainedReferences: actor.retainedReferences,
        referencesNotRetained: actor.referencesNotRetained,
        referencesTruncated: actor.referencesTruncated,
    };
}

/**
 * `dispatch.refused` — one run-scoped operation answered `4xx`.
 *
 * The only row in the family whose `reason` is written twice — once in the
 * response and once here — so it is passed in rather than composed, which is
 * what makes the two provably the same string.
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
    /**
     * The actor gate's detail set, on the one refusal that carries one.
     * Omitted for every other code, so no row gains a
     * meaningless `actorPolicy: null`.
     */
    readonly actor?: ActorGateRefusal | undefined;
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
            ...(input.leaseId !== undefined && { leaseId: input.leaseId }),
            ...(input.dispatchTokenFingerprint !== undefined
                && { dispatchTokenFingerprint: input.dispatchTokenFingerprint }),
            ...(input.actor !== undefined && actorDetails(input.actor)),
        },
    };
}

/**
 * Append one run-scoped lifecycle row, reporting whether it landed.
 *
 * The row is always appended *after* the durable change it describes, and a
 * failure is never allowed to undo that change: it is logged with the
 * run named and answered as `false`, which is what the operator's panel turns
 * into a visible warning rather than implying traceability it does not have.
 *
 * The run's id is passed beside the row rather than read off it, because the
 * audit writer treats `correlationId` as optional for the rows that have no run
 * behind them — and a failure log that omitted the run would be the one place
 * "naming the run" could not be satisfied.
 *
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
