/**
 * One authorized attempt, from the host call to the acknowledgement (003
 * T-021; [contracts/reconciliation.md](../specs/003-dispatch-integrity/contracts/reconciliation.md)).
 *
 * Everything here runs **after** the gates in
 * [`relay-gates.ts`](./relay-gates.ts) have passed and the service has answered
 * a reserve with a single-use token — so nothing in this module can refuse a
 * call the reservation permits. What it owes instead is the ordering the
 * contract makes non-negotiable:
 *
 * ```text
 * host.startSession() returns ──▶ WRITE attempt record ──▶ POST result ──▶ 2xx ──▶ acknowledged
 * ```
 *
 * The record is durable **before** the report leaves, because a report that
 * never lands has to leave the truth recoverable on this side (FR-024). The
 * acknowledgement flips only on the 2xx for that exact attempt (FR-025), and
 * the agent read-back comes last and warns only — it never blocks, never kills,
 * and never changes a state (FR-043).
 */

import type { GuestProject, StartSessionRequest } from '@openchamber/sdk';
import { verifyAgentAfterDispatch } from './agent-verify.ts';
import { parseWorktreeOption, repositoryLabel } from './config.ts';
import type { WorktreeSelection } from './config.ts';
import { acknowledgeDispatch, recordDispatchOutcome } from './dispatch-record.ts';
import type { RecordedOutcome } from './dispatch-record.ts';
import type { SpikeEvidence } from './evidence.ts';
import type { GitHubIssue } from './github.ts';
import { nowIso } from './ids.ts';
import type { LedgerDetail } from './ledger.ts';
import { appendEntryAndPersist } from './panel-actions.ts';
import { redact } from './redaction.ts';
import { composeFirstMessage, promptBlockChars } from './prompt.ts';
import { loadRuns } from './runs.ts';
import { dispatchedPath, servicePost } from './service-calls.ts';
import {
    buildBoundedContext,
    buildStartSessionRequest,
    describeError,
    summarizeStartSessionResult,
} from './session.ts';
import type { ContextSource } from './session.ts';
import {
    NO_SESSION_PROBLEM,
    RELAY_LEDGER_KIND,
    RELAY_POLL_INTERVAL_MS,
    boundedText,
    splitRepository,
    stillRunning,
} from './relay-gates.ts';
import type { ClaimedRun } from './claim-service.ts';
import type { PanelRuntime } from './panel-state.ts';

/** What one `host.startSession()` call produced, for the record and the report. */
export interface HostCall {
    /** Ledger detail for the entry the relay appends. */
    readonly detail: LedgerDetail;
    /** Outcome the FR-024 record and the result report both carry. */
    readonly outcome: RecordedOutcome;
    /** Created session id, or `null` when none was created. */
    readonly sessionId: string | null;
}

/**
 * Build the matched-issue record one offered run maps into.
 *
 * @param run - The offered run.
 * @returns The issue the context builder and the attachment both read.
 */
function issueOf(run: ClaimedRun): GitHubIssue {
    return {
        issueNumber: run.issueNumber,
        title: run.issueTitle,
        url: run.issueUrl,
        state: 'open',
        body: run.issueBodyExcerpt === '' ? null : run.issueBodyExcerpt,
        assignees: [run.accountLogin],
        isPullRequest: run.subjectType === 'pull_request',
    };
}

/**
 * Project the run's source references into the context's sources (FR-014).
 *
 * @param run - The offered run.
 * @returns One context source per retained reference, in join order.
 */
function contextSourcesOf(run: ClaimedRun): ContextSource[] {
    return run.sourceReferences.map((reference) => ({
        origin: reference.origin,
        kind: reference.kind,
        detectedAt: reference.detectedAt,
        url: reference.sourceUrl,
        excerpt: reference.excerpt,
    }));
}

/**
 * The failure reason a start with no session carries, bounded for the wire.
 *
 * @param summary - What `startSession` reported.
 * @returns A non-empty reason no longer than the routes accept.
 */
function failureReason(summary: LedgerDetail): string {
    const { failure } = summary;

    return typeof failure === 'string' && failure.trim() !== '' ? boundedText(failure) : NO_SESSION_PROBLEM;
}

/**
 * Build the spike-shaped evidence record one offered run maps into.
 *
 * MVP-DEBT: the relay borrows the spike's evidence schema, so the trigger
 * literal stays the spike's; the relay's own framing lives in the PM context
 * line and the ledger entry. The correlation id is the run's, which is what
 * makes the attachment id the run's too (FR-029).
 *
 * @param input - Runtime and the offered run.
 * @returns The evidence record the attachment reads its identity from.
 */
function evidenceFor(input: { readonly rt: PanelRuntime; readonly run: ClaimedRun }): SpikeEvidence {
    const { rt, run } = input;

    return {
        schemaVersion: 'extension-spike-1',
        repository: run.repository,
        issueId: String(run.issueNumber),
        issueUrl: run.issueUrl,
        trigger: 'configured-match',
        authenticatedLogin: run.accountLogin,
        correlationId: run.correlationId,
        detectedAt: run.detectedAt,
        panelGeneration: rt.state.ledger.panelGeneration,
    };
}

/**
 * Build the start-session request one offered run maps into.
 *
 * The message is composed here from the run's own snapshot: the operator's
 * prompt block first, the automatic frame beneath it — and with no prompt the
 * frame is exactly what this build produced before the feature existed (004
 * FR-032, SC-121).
 *
 * @param input - Runtime, the run, and the project the host confirmed.
 * @returns The request exactly as the host will receive it.
 */
export function runRequestOf(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The offered run. */
    readonly run: ClaimedRun;
    /** Project the host confirmed. */
    readonly project: GuestProject;
}): StartSessionRequest {
    const { run } = input;
    const worktree: WorktreeSelection = parseWorktreeOption(run.worktreeOption) ?? { kind: 'none' };
    const issue = issueOf(run);
    // The snapshot arrives on the claim answer and nowhere else; an unset run
    // composes exactly what it composed before this feature existed — no
    // fence, no blank line, no placeholder (004 FR-032, SC-121).
    const prompt = run.promptPresent ? run.promptText : null;
    const frame = buildBoundedContext({
        repository: run.repository,
        issue,
        authenticatedLogin: run.accountLogin,
        correlationId: run.correlationId,
        sources: contextSourcesOf(run),
        // Reserved before the excerpt is sized, so the excerpt is what
        // shortens when the two together would exceed the bound (FR-035).
        reservedChars: promptBlockChars(prompt),
    });
    const context = composeFirstMessage({ prompt, frame });

    return buildStartSessionRequest({
        config: {
            repository: splitRepository(run.repository),
            expectedLogin: run.accountLogin,
            projectId: run.projectId,
            worktree,
            pollIntervalMs: RELAY_POLL_INTERVAL_MS,
        },
        evidence: evidenceFor(input),
        issue,
        context,
        // The reference only: the text is already inside `context`, and 004
        // FR-037 forbids a second copy of it anywhere in the envelope.
        prompt: {
            promptPresent: run.promptPresent,
            promptFingerprint: run.promptFingerprint,
            promptLength: run.promptLength,
        },
    });
}

/**
 * Make the one authorized host call; never throws.
 *
 * A rejected `host.startSession()` is recorded as a failure with the transport
 * problem as its reason: the guest bridge documents a created session as a
 * resolved result carrying its id, so a rejection means the request never came
 * back with one — and an outcome, either way, is exactly what FR-024 requires
 * the panel to hold before it reports anything.
 *
 * @param input - Runtime, the run, and the confirmed project.
 * @returns What the host produced, for the ledger, the record, and the report.
 */
export async function startRunSession(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The offered run. */
    readonly run: ClaimedRun;
    /** Project the host confirmed. */
    readonly project: GuestProject;
}): Promise<HostCall> {
    const { rt, run } = input;
    let summary: LedgerDetail;
    try {
        summary = summarizeStartSessionResult(await rt.host.startSession(runRequestOf(input)));
    } catch (cause) {
        summary = { sessionId: null, sent: 'skipped', failure: describeError(cause) };
    }

    const rawSession = summary.sessionId;
    const sessionId = typeof rawSession === 'string' && rawSession !== '' ? rawSession : null;
    const outcome: RecordedOutcome = sessionId === null
        ? { kind: 'failed', reason: failureReason(summary) }
        : { kind: 'dispatched', sessionId };
    const firstReference = run.sourceReferences[0];

    return {
        sessionId,
        outcome,
        detail: {
            correlationId: run.correlationId,
            repository: repositoryLabel(splitRepository(run.repository)),
            projectId: input.project.id,
            worktreeOption: run.worktreeOption,
            trigger: firstReference === undefined ? NO_SESSION_PROBLEM : firstReference.origin,
            ...summary,
        },
    };
}

/**
 * Report one attempt's outcome, then acknowledge it on its own 2xx (FR-025).
 *
 * @param input - Runtime, the run, its token, and what the host produced.
 */
export async function reportAndAcknowledge(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The offered run. */
    readonly run: ClaimedRun;
    /** The single-use token the reservation holds. */
    readonly token: string;
    /** What the host produced. */
    readonly outcome: RecordedOutcome;
}): Promise<void> {
    const { rt, run, token, outcome } = input;
    const body = JSON.stringify(
        outcome.kind === 'dispatched'
            ? {
                correlationId: run.correlationId,
                attempt: run.attempt,
                dispatchToken: token,
                sessionId: outcome.sessionId,
            }
            : { correlationId: run.correlationId, attempt: run.attempt, dispatchToken: token, problem: outcome.reason },
    );
    const answer = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: dispatchedPath(run.correlationId),
        body,
    });
    if (answer.ok) {
        await acknowledgeDispatch({ rt, correlationId: run.correlationId, attempt: run.attempt });
    }

    if (!stillRunning(rt)) {
        return;
    }

    if (!answer.ok) {
        rt.state.bindings.note = redact(`Run ${run.correlationId} was dispatched but its report was refused: `
            + `${answer.problem}${answer.code === null ? '' : ` (${answer.code})`}. `
            + 'It is reconciled on the next mount.');

        return;
    }

    // The runs history follows every dispatch report (M8): whatever the
    // service stored for this attempt is what the operator sees next.
    void loadRuns(rt);
}

/**
 * Close one attempt: durable record, ledger evidence, report, acknowledgement,
 * and the warn-only agent read-back (FR-024, FR-025, FR-043).
 *
 * Nothing here re-decides whether the attempt was authorized — it already was —
 * so nothing below can refuse a call the reservation permits. The order is the
 * contract's: the record is durable **before** the report leaves, because a
 * report that never lands has to leave the truth recoverable on this side.
 *
 * @param input - Runtime, the run, its token, and what the host produced.
 */
export async function closeAttempt(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The offered run. */
    readonly run: ClaimedRun;
    /** The single-use token the reservation holds. */
    readonly token: string;
    /** What the host call produced. */
    readonly started: HostCall;
}): Promise<void> {
    const { rt, run, token, started } = input;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: RELAY_LEDGER_KIND,
        correlationId: run.correlationId,
        detail: started.detail,
    });

    const recorded = await recordDispatchOutcome(rt, {
        correlationId: run.correlationId,
        runKey: run.runKey,
        attempt: run.attempt,
        dispatchToken: token,
        outcome: started.outcome,
    });
    if (!recorded && stillRunning(rt)) {
        rt.state.bindings.note = redact(`Run ${run.correlationId}: the dispatch record could not be written, so a lost`
            + ' report would not be recoverable from this panel.');
    }

    await reportAndAcknowledge({ rt, run, token, outcome: started.outcome });

    // M9: the run's record reaches the service first, then the agent that
    // actually answered is read back. A dispatch that created no session has
    // nothing to verify, so verification skips gracefully there — and a
    // dispatch that did create one starts the read-back **detached** (AC-125):
    // its own 15 s budget must never hold the claim slot, because the next
    // tick's claim is what keeps unattended work moving (FR-043 warn-only).
    if (started.outcome.kind === 'dispatched' && stillRunning(rt)) {
        rt.pendingVerifications.push(verifyAgentAfterDispatch({
            rt,
            correlationId: run.correlationId,
            attempt: run.attempt,
            sessionId: started.outcome.sessionId,
        }));
    }
}
