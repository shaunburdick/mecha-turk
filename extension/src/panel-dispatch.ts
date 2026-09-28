/**
 * Dispatch action for the spike: exactly one `host.startSession()` call.
 *
 * The dispatch re-resolves the configured project and re-fetches the matched
 * issue before it sends anything (FR-008, FR-020), refuses to run twice for
 * the same issue, records the host's complete result — including partial
 * bootstrap failures — and never touches a worktree locally.
 */

import type { StartSessionResult } from '@openchamber/sdk';
import type { LedgerDetail } from './ledger.ts';
import type { SpikeConfig } from './config.ts';
import type { SpikeEvidence } from './evidence.ts';
import { fetchIssueDetail } from './github.ts';
import type { GitHubIssue } from './github.ts';
import { nowIso } from './ids.ts';
import { evaluateIssue } from './matching.ts';
import { appendEntryAndPersist, recordFailure } from './panel-actions.ts';
import { refresh } from './panel-ui.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import {
    buildBoundedContext,
    buildStartSessionRequest,
    findDispatchForIssue,
    resolveProject,
    summarizeStartSessionResult,
} from './session.ts';


/** Everything a dispatch needs once the state guards pass. */
interface DispatchInputs {
    /** Validated configuration. */
    readonly config: SpikeConfig;
    /** Evidence record for the matched issue. */
    readonly evidence: SpikeEvidence;
    /** Authenticated machine account login. */
    readonly login: string;
}

/** The re-validated issue paired with its dispatch inputs. */
interface SendInput {
    /** Configuration, evidence, and identity. */
    readonly inputs: DispatchInputs;
    /** Current, re-validated issue. */
    readonly issue: GitHubIssue;
}

/**
 * Read the dispatch prerequisites, or `null` when dispatching is blocked.
 *
 * @param rt - Panel runtime.
 * @returns The inputs when a dispatch may proceed, otherwise `null`.
 */
function readDispatchInputs(rt: PanelRuntime): DispatchInputs | null {
    const { config, evidence, login } = rt.state;
    if (config === null || evidence === null || login === null || rt.state.busy) {
        return null;
    }

    return { config, evidence, login };
}

/**
 * Resolve the project, re-read the issue, and re-apply the matching rule.
 *
 * @param rt - Panel runtime.
 * @param inputs - Configuration, evidence, and identity.
 * @returns The current issue when it still matches, otherwise `null`.
 */
async function refreshMatchedIssue(rt: PanelRuntime, inputs: DispatchInputs): Promise<GitHubIssue | null> {
    const { config, evidence, login } = inputs;
    const { correlationId } = evidence;
    const project = await resolveProject(rt.host, config.projectId);
    if (!project.ok) {
        const available = project.available.join(',');
        const detail: LedgerDetail = {
            issueId: evidence.issueId,
            problem: project.problem,
            availableProjects: available,
        };
        appendEntryAndPersist(rt, { at: nowIso(), kind: 'session', correlationId, detail });
        setStatus(rt, { tone: 'error', title: 'Project unresolved', body: project.problem });
        return null;
    }

    try {
        const issueNumber = Number(evidence.issueId);
        const current = await fetchIssueDetail({ host: rt.host, repository: config.repository, issueNumber });
        if (rt.disposed) {
            return null;
        }

        const decision = evaluateIssue(current, login);
        if (decision.matched) {
            return current;
        }

        appendEntryAndPersist(rt, {
            at: nowIso(),
            kind: 'session',
            correlationId,
            detail: { issueId: evidence.issueId, problem: `source changed: ${decision.reason}` },
        });
        setStatus(rt, {
            tone: 'warning',
            title: 'Source changed',
            body: `Issue #${evidence.issueId} no longer matches (${decision.reason}); nothing dispatched.`,
        });
        return null;
    } catch (cause) {
        recordFailure(rt, { kind: 'session', cause, correlationId });
        return null;
    }
}

/**
 * Report the `startSession()` outcome in the banner.
 *
 * @param rt - Panel runtime.
 * @param result - Result returned by the host.
 */
function reportSessionResult(rt: PanelRuntime, result: StartSessionResult): void {
    if ('failure' in result) {
        const summary = `${result.failure} in ${result.directory} (worktree ${result.worktree.branch})`;
        setStatus(rt, { tone: 'error', title: 'Session not created', body: `${summary}. Inspect before any retry.` });
        return;
    }

    const directory = result.directory ?? '(project default)';
    const body = `session=${result.sessionId}; sent=${result.sent}; directory=${directory}`;
    setStatus(rt, { tone: 'success', title: 'Session started', body });
}

/**
 * Build and send the documented `host.startSession()` call.
 *
 * @param rt - Panel runtime.
 * @param input - Dispatch inputs paired with the re-validated issue.
 */
async function sendDispatch(rt: PanelRuntime, input: SendInput): Promise<void> {
    const { config, evidence, login } = input.inputs;
    const { issue } = input;
    try {
        const context = buildBoundedContext({
            repository: evidence.repository,
            issue,
            authenticatedLogin: login,
            correlationId: evidence.correlationId,
        });
        const request = buildStartSessionRequest({ config, evidence, issue, context });
        const result = await rt.host.startSession(request);
        if (rt.disposed) {
            return;
        }

        const summary = summarizeStartSessionResult(result);
        const detail: LedgerDetail = { issueId: evidence.issueId, correlationId: evidence.correlationId, ...summary };
        appendEntryAndPersist(rt, { at: nowIso(), kind: 'session', correlationId: evidence.correlationId, detail });
        reportSessionResult(rt, result);
    } catch (cause) {
        recordFailure(rt, { kind: 'session', cause, correlationId: evidence.correlationId });
    }
}

/**
 * Re-fetch the matched issue and dispatch exactly one session.
 *
 * The source object is re-read before execution (FR-008), the project
 * reference is resolved first (FR-020), and an issue already dispatched by
 * this ledger is skipped so a re-poll cannot create a second session.
 *
 * @param rt - Panel runtime.
 * @param inputs - Configuration, evidence, and identity.
 */
async function runDispatch(rt: PanelRuntime, inputs: DispatchInputs): Promise<void> {
    const { evidence } = inputs;
    if (findDispatchForIssue(rt.state.ledger, evidence.issueId)) {
        setStatus(rt, {
            tone: 'warning',
            title: 'Already dispatched',
            body: `Issue #${evidence.issueId} already has a session entry in this ledger.`,
        });
        return;
    }

    const issue = await refreshMatchedIssue(rt, inputs);
    if (issue === null) {
        return;
    }

    await sendDispatch(rt, { inputs, issue });
}

/**
 * Dispatch the matched issue as exactly one session, if the state allows it.
 *
 * @param rt - Panel runtime.
 */
export async function startDispatch(rt: PanelRuntime): Promise<void> {
    const inputs = readDispatchInputs(rt);
    if (inputs === null) {
        return;
    }

    rt.state.busy = true;
    refresh(rt);
    try {
        await runDispatch(rt, inputs);
    } catch (cause) {
        recordFailure(rt, { kind: 'session', cause, correlationId: inputs.evidence.correlationId });
    } finally {
        rt.state.busy = false;
        refresh(rt);
    }
}
