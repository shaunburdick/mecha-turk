/**
 * One authorized attempt, host call to ack: durable record, 2xx-keyed ack, read-back warns only (FR-024/025/043).
 */

import type { GuestProject, StartSessionRequest, StartSessionResult } from '@openchamber/sdk';
import { verifyAgentAfterDispatch } from './agent-verify.ts';
import {
    BRANCH_PLACEHOLDER,
    formatWorktreeOption,
    parseWorktreeOption,
    repositoryLabel,
    substituteBranchNumber,
} from './config.ts';
import type { WorktreeSelection } from './config.ts';
import { acknowledgeDispatch, recordDispatchOutcome } from './dispatch-record.ts';
import type { RecordedOutcome } from './dispatch-record.ts';
import type { PanelEvidence } from './evidence.ts';
import type { GitHubIssue } from './github.ts';
import { nowIso } from './ids.ts';
import type { LedgerDetail } from './ledger.ts';
import { appendEntryAndPersist } from './panel-actions.ts';
import { redact } from './redaction.ts';
import { composeFirstMessage, promptBlockChars } from './prompt.ts';
import type { PromptSource } from './prompt.ts';
import { loadDispatches } from './dispatches.ts';
import { dispatchedPath, servicePost } from './service-calls.ts';
import {
    CONTEXT_MAX_CHARS,
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

export interface HostCall {
    readonly detail: LedgerDetail;
    /** Outcome the FR-024 record and the result report both carry. */
    readonly outcome: RecordedOutcome;
    readonly sessionId: string | null;
    readonly directory: string | null;
}

// `worktree.directory` wins, else the result's own `directory` (the checkout
// for `worktreeOption: 'none'`). Absent means absent: never guessed, defaulted.
function reportedDirectoryOf(result: StartSessionResult): string | null {
    return result.worktree?.directory ?? result.directory ?? null;
}

/**
 * Build the matched-issue record one offered run maps into.
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
 * Project the run's source references into the context's sources.
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
 * @returns A non-empty reason no longer than the routes accept.
 */
function failureReason(summary: LedgerDetail): string {
    const { failure } = summary;

    return typeof failure === 'string' && failure.trim() !== '' ? boundedText(failure) : NO_SESSION_PROBLEM;
}

/**
 * The fail-closed budget floor: the composed first message against {@link CONTEXT_MAX_CHARS} (004
 * FR-085, plan D22, research R-2). A legal composition never reaches it — three maximal tiers
 * plus the full frame come to ≈7,700 of the 12,000 characters — so what it exists for is FR-085's
 * one case, a store hand-edited past its own validators, where the floor **refuses rather than
 * shortens**: no session starts and no tier, frame or marker structure is truncated (FR-003;
 * constitution II). Reported as a failed attempt through `problem`: no new `blocked:` reason, no
 * new state, no new vocabulary.
 */
export function budgetFloorProblem(input: {
    readonly composed: string;
    readonly sources: readonly PromptSource[] | null;
}): string | null {
    const { composed, sources } = input;
    if (composed.length <= CONTEXT_MAX_CHARS) {
        return null;
    }

    // Named from the run's own source list, so the operator is told *which*
    // starting prompts to shorten — the list is what identifies them, never a
    // fragment of their text.
    const tiers = sources === null || sources.length === 0 ? 'none named' : sources.join(', ');

    return boundedText(
        `Dispatch refused before start: the composed first message is ${composed.length} characters, over the `
        + `${CONTEXT_MAX_CHARS}-character dispatch budget. Contributing starting-prompt tiers: ${tiers}. `
        + 'Shorten or clear those starting prompts, then retry — nothing was truncated and no session was started.',
    );
}

/**
 * The fail-closed worktree-name floor (002 FR-028): a `new:` branch name may carry the single
 * literal `{number}` placeholder, which the relay substitutes with the source issue number at
 * dispatch time. Substitution is not silent — the substituted name is re-validated through the same
 * branch-name rule the parser and the service use, and a name that does not survive it is refused
 * **before** `host.startSession()`, the same way {@link budgetFloorProblem} refuses an over-budget
 * message. A stored name without the placeholder (e.g. `new:feature-spike`) is unchanged and never
 * reaches this floor. Reported as a failed attempt through `problem`, no new state or vocabulary.
 *
 * @returns The problem, or `null` when the parsed selection needs no substitution.
 */
export function worktreeNameProblem(
    selection: WorktreeSelection,
    issueNumber: number,
): string | null {
    if (selection.kind !== 'new' || !selection.name.includes(BRANCH_PLACEHOLDER)
        || substituteBranchNumber(selection.name, issueNumber) !== null) {
        return null;
    }

    return boundedText(
        `Dispatch refused before start: the worktree option ${formatWorktreeOption(selection)} is not a branch name `
        + `the panel can use after substituting ${BRANCH_PLACEHOLDER} with the issue number ${issueNumber}. `
        + 'Fix the binding\'s worktree option, then retry — nothing was sent and no session was started.',
    );
}

/**
 * Build the spike-shaped evidence record one offered run maps into. MVP-DEBT:
 * the relay borrows the spike's evidence schema, so the trigger literal stays
 * the spike's and the relay's own framing lives in the PM context line and the
 * ledger entry. The correlation id is the run's, which is what makes the
 * attachment id the run's too.
 */
function evidenceFor(input: { readonly rt: PanelRuntime; readonly run: ClaimedRun }): PanelEvidence {
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
 * Build the start-session request one offered run maps into: the operator's
 * prompt block first, the automatic frame beneath it, and with no prompt the
 * frame is exactly what this build produced before the feature existed (004
 * FR-032, SC-121). Composition does not decide whether the message may be sent
 * — {@link budgetFloorProblem} measures what comes back against
 * {@link CONTEXT_MAX_CHARS} immediately before the host call.
 *
 * @returns The request, and the worktree-name problem when one exists — a `new:` name that fails
 *   `{number}` substitution (002 FR-028). Callers must check `problem` before the host call and
 *   refuse the dispatch rather than send `request`.
 */
export function runRequestOf(input: {
    readonly rt: PanelRuntime;
    readonly run: ClaimedRun;
    readonly project: GuestProject;
}): { readonly request: StartSessionRequest; readonly problem: string | null } {
    const { run } = input;
    // 002 FR-028: a `new:` name carrying `{number}` is substituted with this run's issue number and
    // re-validated fail-closed. A name that fails re-validation is refused before the host call.
    const parsed = parseWorktreeOption(run.worktreeOption) ?? { kind: 'none' };
    const problem = worktreeNameProblem(parsed, run.issueNumber);
    const worktree: WorktreeSelection = parsed.kind === 'new'
        ? { kind: 'new', name: substituteBranchNumber(parsed.name, run.issueNumber) ?? parsed.name }
        : parsed;
    const issue = issueOf(run);
    // The snapshot arrives on the claim answer and nowhere else; an unset run
    // composes exactly what it composed before this feature existed — no
    // fence, no blank line, no placeholder.
    const prompt = run.promptPresent ? run.promptText : null;
    const frame = buildBoundedContext({
        repository: run.repository,
        issue,
        authenticatedLogin: run.accountLogin,
        correlationId: run.correlationId,
        sources: contextSourcesOf(run),
        // Reserved before the excerpt is sized, so the excerpt is what
        // shortens when the two together would exceed the bound.
        reservedChars: promptBlockChars(prompt),
    });
    const context = composeFirstMessage({ prompt, frame });

    return {
        request: buildStartSessionRequest({
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
                promptSources: run.promptSources,
            },
        }),
        problem,
    };
}

/**
 * Make the one authorized host call; never throws. **The floor sits here**: the message is
 * composed, then measured — an over-budget composition is refused **before** `host.startSession()`,
 * and a `new:` worktree name that fails `{number}` substitution is refused the same way (002
 * FR-028) — so no session starts and nothing is truncated or guessed, and the refusal takes the
 * shape a rejected start does (`sessionId: null`, `sent: 'skipped'`, the remediation as its
 * `failure`) so it reaches the run row through the existing failed-attempt `problem` path. A
 * rejected `host.startSession()` is recorded as a failure with the transport problem as its reason
 * — an outcome either way, which is what FR-024 requires the panel to hold before it reports
 * anything.
 */
export async function startRunSession(input: {
    readonly rt: PanelRuntime;
    readonly run: ClaimedRun;
    readonly project: GuestProject;
}): Promise<HostCall> {
    const { rt, run } = input;
    let summary: LedgerDetail;
    let directory: string | null = null;
    try {
        const { request, problem } = runRequestOf(input);
        const overBudget = budgetFloorProblem({
            composed: request.text ?? '',
            sources: run.promptSources,
        });
        // The worktree floor sits beside the budget floor: both refuse before the host call, in
        // the same refusal shape.
        const refusal = problem ?? overBudget;
        if (refusal === null) {
            const result = await rt.host.startSession(request);
            summary = summarizeStartSessionResult(result);
            directory = reportedDirectoryOf(result);
        } else {
            summary = { sessionId: null, sent: 'skipped', failure: refusal };
        }
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
        directory: sessionId === null ? null : directory,
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

/** Report one attempt's outcome, then acknowledge it on its own 2xx. */
export async function reportAndAcknowledge(input: {
    readonly rt: PanelRuntime;
    readonly run: ClaimedRun;
    readonly token: string;
    readonly outcome: RecordedOutcome;
    readonly directory: string | null;
}): Promise<void> {
    const { rt, run, token, outcome } = input;
    const body = JSON.stringify(
        outcome.kind === 'dispatched'
            ? {
                correlationId: run.correlationId,
                attempt: run.attempt,
                dispatchToken: token,
                sessionId: outcome.sessionId,
                ...(input.directory !== null && { directory: input.directory }),
            }
            : { correlationId: run.correlationId, attempt: run.attempt, dispatchToken: token, problem: outcome.reason },
    );
    const answer = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: dispatchedPath(run.correlationId),
        body,
    });
    if (answer.ok) {
        await acknowledgeDispatch({
            rt,
            correlationId: run.correlationId,
            attempt: run.attempt,
            resolved: { runKey: run.runKey, dispatchToken: token, outcome },
        });
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
    void loadDispatches(rt);
}

/**
 * Close one attempt: durable record, ledger evidence, report, acknowledgement,
 * and the warn-only agent read-back.
 *
 * Nothing here re-decides whether the attempt was authorized — it already was —
 * so nothing below can refuse a call the reservation permits. The order is the
 * contract's: the record is durable **before** the report leaves, because a
 * report that never lands has to leave the truth recoverable on this side.
 */
export async function closeAttempt(input: {
    readonly rt: PanelRuntime;
    readonly run: ClaimedRun;
    readonly token: string;
    readonly started: HostCall;
}): Promise<void> {
    const { rt, run, token, started } = input;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: RELAY_LEDGER_KIND,
        correlationId: run.correlationId,
        detail: started.detail,
    });

    const isRecorded = await recordDispatchOutcome(rt, {
        correlationId: run.correlationId,
        runKey: run.runKey,
        attempt: run.attempt,
        dispatchToken: token,
        outcome: started.outcome,
    });
    if (!isRecorded && stillRunning(rt)) {
        rt.state.bindings.note = redact(`Run ${run.correlationId}: the dispatch record could not be written, so a lost`
            + ' report would not be recoverable from this panel.');
    }

    await reportAndAcknowledge({ rt, run, token, outcome: started.outcome, directory: started.directory });

    // M9: the run's record reaches the service first, then the agent that
    // actually answered is read back. A dispatch that created no session has
    // nothing to verify, so verification skips gracefully there — and a
    // dispatch that did create one starts the read-back **detached**:
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
