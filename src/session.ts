/**
 * Host-side dispatch and verification for the spike.
 *
 * Everything here goes through the documented `@openchamber/sdk` surface:
 * `host.listProjects`, `host.listWorktrees`, `host.listSessions`, their
 * subscriptions, `host.onSessionLifecycle`, and `host.startSession`. The spike
 * never creates a worktree, a project, or a session on disk itself — it asks
 * OpenChamber and records what OpenChamber answers, including partial
 * bootstrap failures.
 */

import { GUEST_ATTACH_TITLE_MAX, GUEST_ATTACH_URL_MAX } from '@openchamber/sdk';
import type {
    GuestProject,
    GuestProjectsSnapshot,
    GuestSessionWorktree,
    HostClient,
    StartSessionRequest,
    StartSessionResult,
} from '@openchamber/sdk';
import type { SpikeConfig, WorktreeSelection } from './config.ts';
import type { SpikeEvidence } from './evidence.ts';
import type { GitHubIssue } from './github.ts';
import type { LedgerDetail, SpikeLedger } from './ledger.ts';

/**
 * The host surface the spike uses.
 *
 * Building this from `Pick<HostClient, …>` keeps the spike on the documented
 * API surface: adding a method here is a deliberate, reviewable act.
 */
export type SpikeHost = Pick<
    HostClient,
    | 'request'
    | 'serviceRequest'
    | 'storage'
    | 'openUrl'
    | 'writeClipboard'
    | 'startSession'
    | 'openSession'
    | 'listProjects'
    | 'listWorktrees'
    | 'listSessions'
    | 'onProjects'
    | 'onWorktrees'
    | 'onSessions'
    | 'onSession'
    | 'onSessionLifecycle'
    | 'onReady'
    | 'onSettings'
    | 'onConnection'
    | 'dispose'
>;

/** Maximum characters of bounded context sent as the session's first message. */
export const CONTEXT_MAX_CHARS = 4_000;

/** Maximum characters of the issue body excerpt embedded in the context. */
export const BODY_EXCERPT_MAX_CHARS = 1_200;

/** Line separator used by the bounded context. */
const NEWLINE = '\n';

/** Marker appended when the untrusted excerpt itself had to be cut. */
const EXCERPT_ELLIPSIS = '…';

/** Opening delimiter of the untrusted issue text (FR-026). */
const BEGIN_UNTRUSTED = '--- BEGIN UNTRUSTED ISSUE TEXT (truncated) ---';

/** Closing delimiter of the untrusted issue text (FR-026). */
const END_UNTRUSTED = '--- END UNTRUSTED ISSUE TEXT ---';

/**
 * Render a human-readable error without echoing provider payloads.
 *
 * @param cause - Caught value.
 * @returns A short description safe for the ledger.
 */
export function describeError(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}

/** Result of resolving the configured project reference. */
export type ProjectResolution =
    | { readonly ok: true; readonly project: GuestProject }
    | { readonly ok: false; readonly problem: string; readonly available: readonly string[] };

/**
 * Resolve the configured project reference against `host.listProjects()`.
 *
 * The spike never creates a project implicitly: an absent or invalid reference
 * blocks the dispatch (FR-020).
 *
 * @param host - Host client.
 * @param configuredProjectId - Project id from the operator settings.
 * @returns The project, or the blocking problem plus the available ids.
 */
export async function resolveProject(
    host: Pick<SpikeHost, 'listProjects'>,
    configuredProjectId: string,
): Promise<ProjectResolution> {
    let snapshot: GuestProjectsSnapshot;
    try {
        snapshot = await host.listProjects();
    } catch (cause) {
        return { ok: false, problem: `listProjects failed: ${describeError(cause)}`, available: [] };
    }

    const available = snapshot.projects.map((project) => project.id);
    if (snapshot.state === 'error') {
        return { ok: false, problem: 'projects snapshot reported state "error"', available };
    }

    const project = snapshot.projects.find((candidate) => candidate.id === configuredProjectId);
    if (project === undefined) {
        return { ok: false, problem: `project "${configuredProjectId}" is not registered in OpenChamber`, available };
    }

    return { ok: true, project };
}

/**
 * Trim the untrusted issue body into the character budget.
 *
 * @param body - Untrusted issue body.
 * @param budget - Characters left for the excerpt once the frame is counted.
 * @returns The body when it fits, an ellipsised truncation, or `''` when even
 * the marker does not fit.
 */
function fitExcerpt(body: string, budget: number): string {
    if (body.length <= budget) {
        return body;
    }

    if (budget <= EXCERPT_ELLIPSIS.length) {
        return '';
    }

    return `${body.slice(0, budget - EXCERPT_ELLIPSIS.length)}${EXCERPT_ELLIPSIS}`;
}

/**
 * Build the bounded first-message context for a dispatched session.
 *
 * Issue text is untrusted source material (FR-026), so it is wrapped in
 * explicit markers and truncated before it can dominate the prompt. The budget
 * is spent on the excerpt, never on the frame: truncating a long body can shorten
 * the quotation but can never cut the closing delimiter, because both markers
 * are counted before the excerpt is trimmed. The context never contains the
 * token or any Authorization material.
 *
 * @param input - Repository, issue, identity, and correlation inputs.
 * @returns Context truncated to `maxChars` characters, markers intact.
 */
export function buildBoundedContext(input: {
    /** `owner/name` of the repository. */
    readonly repository: string;
    /** Matched issue. */
    readonly issue: GitHubIssue;
    /** Login discovered from `GET /user`. */
    readonly authenticatedLogin: string;
    /** Correlation identifier for this dispatch. */
    readonly correlationId: string;
    /** Optional character budget; defaults to {@link CONTEXT_MAX_CHARS}. */
    readonly maxChars?: number;
}): string {
    const maxChars = input.maxChars ?? CONTEXT_MAX_CHARS;
    const frame = [
        'Mecha Turk spike dispatch (extension spike, not a production orchestrator).',
        `Correlation: ${input.correlationId}`,
        `Repository: ${input.repository}`,
        `Issue #${input.issue.issueNumber}: ${input.issue.title}`,
        `URL: ${input.issue.url}`,
        `Machine account: ${input.authenticatedLogin}`,
        'Rule: configured-match — open issue assigned to the authenticated machine account.',
        BEGIN_UNTRUSTED,
    ].join(NEWLINE);

    // Two separators frame the excerpt: one after the frame, one before the
    // closing delimiter. Both count against the budget or the result overruns
    // `maxChars` by exactly the separator that was forgotten.
    const separators = NEWLINE + NEWLINE;
    const overhead = frame.length + separators.length + END_UNTRUSTED.length;
    const budget = Math.min(Math.max(maxChars - overhead, 0), BODY_EXCERPT_MAX_CHARS);
    const excerpt = fitExcerpt(input.issue.body ?? '', budget);

    return `${frame}${NEWLINE}${excerpt}${NEWLINE}${END_UNTRUSTED}`;
}

/**
 * Map the configured worktree option onto the documented `startSession` value.
 *
 * @param selection - Worktree selection from the spike configuration.
 * @returns The documented worktree value, or `undefined` for `none`.
 */
function worktreeValue(selection: WorktreeSelection): GuestSessionWorktree | undefined {
    if (selection.kind === 'none') {
        return undefined;
    }

    if (selection.kind === 'generated') {
        return true;
    }

    return { kind: 'new', name: selection.name };
}

/**
 * Build the documented `host.startSession()` request for a matched issue.
 *
 * @param input - Configuration, evidence, issue, and bounded context.
 * @returns The request exactly as it will be sent to the host.
 */
export function buildStartSessionRequest(input: {
    /** Validated spike configuration. */
    readonly config: SpikeConfig;
    /** Evidence record for the matched issue. */
    readonly evidence: SpikeEvidence;
    /** Matched issue. */
    readonly issue: GitHubIssue;
    /** Bounded first-message context. */
    readonly context: string;
}): StartSessionRequest {
    const worktree = worktreeValue(input.config.worktree);

    return {
        providerId: 'mecha-turk-spike',
        id: `issue-${input.issue.issueNumber}`,
        title: input.issue.title.slice(0, GUEST_ATTACH_TITLE_MAX),
        url: input.issue.url.slice(0, GUEST_ATTACH_URL_MAX),
        kind: 'issue',
        text: input.context,
        projectId: input.config.projectId,
        data: {
            schemaVersion: input.evidence.schemaVersion,
            correlationId: input.evidence.correlationId,
            repository: input.evidence.repository,
            issueId: input.evidence.issueId,
            detectedAt: input.evidence.detectedAt,
            panelGeneration: input.evidence.panelGeneration,
        },
        ...(worktree === undefined ? {} : { worktree }),
    };
}

/** `startSession` result variant that reports a partial bootstrap failure. */
type StartSessionFailure = Extract<StartSessionResult, { failure: 'bootstrap-failed' | 'session-create-failed' }>;

/** `startSession` result variant that created a session. */
type StartSessionSuccess = Exclude<StartSessionResult, StartSessionFailure>;

/**
 * Summarize a successful `host.startSession()` result for the ledger.
 *
 * @param result - Result with a created session id.
 * @returns Scalar, secret-free fields for the ledger.
 */
function summarizeSuccess(result: StartSessionSuccess): LedgerDetail {
    return {
        sessionId: result.sessionId,
        sent: result.sent,
        linked: result.linked ?? null,
        directory: result.directory ?? null,
        failure: null,
        worktreeDirectory: result.worktree?.directory ?? null,
        worktreeBranch: result.worktree?.branch ?? null,
        worktreeStatus: result.worktree?.status ?? null,
    };
}

/**
 * Summarize a partial bootstrap failure for the ledger.
 *
 * The worktree OpenChamber left behind is part of the record: the spike
 * inspects this before any retry.
 *
 * @param result - Result with a null session id and a failure reason.
 * @returns Scalar, secret-free fields for the ledger.
 */
function summarizeFailure(result: StartSessionFailure): LedgerDetail {
    return {
        sessionId: null,
        sent: result.sent,
        linked: null,
        directory: result.directory,
        failure: result.failure,
        worktreeDirectory: result.worktree.directory,
        worktreeBranch: result.worktree.branch,
        worktreeStatus: result.worktree.status,
    };
}

/**
 * Summarize a `host.startSession()` result for the ledger.
 *
 * The full result is recorded, including partial bootstrap failures: a null
 * session id, the failure reason, the directory, and any worktree OpenChamber
 * left behind.
 *
 * @param result - Result returned by the host.
 * @returns A scalar, secret-free summary for the ledger.
 */
export function summarizeStartSessionResult(result: StartSessionResult): LedgerDetail {
    return 'failure' in result ? summarizeFailure(result) : summarizeSuccess(result);
}

/**
 * Check that a session detail records a session the host actually created.
 *
 * Blocked and failed attempts are recorded as `session` entries too — an
 * unresolved project, a source that stopped matching, a `startSession()` that
 * returned a failure — but they carry `problem`/`failure` instead of a session
 * id, so they must never count as a dispatch.
 *
 * @param detail - Detail payload of a `session` ledger entry.
 * @returns `true` when the detail carries a non-empty created session id.
 */
function hasCreatedSession(detail: LedgerDetail): boolean {
    const { sessionId } = detail;
    return typeof sessionId === 'string' && sessionId !== '';
}

/**
 * Find whether the ledger already dispatched a given issue.
 *
 * Used to keep the spike idempotent: one issue produces at most one created
 * session, so a re-poll cannot create a second one. Only *successful*
 * dispatches count — a transient failure is evidence to retry from, not a
 * permanent block, otherwise one unresolved project would disable the panel
 * until its ledger was deleted.
 *
 * @param ledger - Current ledger.
 * @param issueId - Issue number as a string.
 * @returns `true` when a `session` entry for that issue holds a created session id.
 */
export function findDispatchForIssue(ledger: SpikeLedger, issueId: string): boolean {
    return ledger.entries.some(
        (entry) => entry.kind === 'session' && entry.detail.issueId === issueId && hasCreatedSession(entry.detail),
    );
}
