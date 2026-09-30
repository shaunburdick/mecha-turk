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
import { BEGIN_UNTRUSTED, END_UNTRUSTED, defuseDelimiters, renderBlocks } from './context-blocks.ts';
import type { ContextBlock } from './context-blocks.ts';
import type { PromptReference } from './prompt.ts';import type { SpikeEvidence } from './evidence.ts';
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

/** Maximum characters of bounded context sent as the session's first message (FR-014: ≤12,000 per dispatch). */
export const CONTEXT_MAX_CHARS = 12_000;

/** Line separator used by the bounded context. */
const NEWLINE = '\n';

/** Re-exported: the context builder stays the one import path for these. */
export { SOURCE_EXCERPT_MAX_CHARS } from './context-blocks.ts';

/**
 * One source reference the dispatch context quotes (FR-014).
 *
 * Everything on it is untrusted or service-projected source material: it is
 * copied into the delimited block, never interpreted, and never allowed to
 * alter the frame around it.
 */
export interface ContextSource {
    /** Where it matched: `assignment`, `body`, `comment:<id>`, or `review`. */
    readonly origin: string;
    /** Trigger kind the reference was detected under. */
    readonly kind: 'assignment' | 'mention' | 'review';
    /** RFC 3339 detection stamp. */
    readonly detectedAt: string;
    /** Canonical link back to the source. */
    readonly url: string;
    /** Bounded untrusted excerpt. */
    readonly excerpt: string;
}

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
 * Build the bounded first-message context for a dispatched session.
 *
 * Source text is untrusted (FR-026), so every source is quoted inside one
 * explicit delimited block and bounded before it can dominate the prompt.
 * Three guarantees hold at once, which is the whole point of the shape:
 *
 * - **Both limits, at once (FR-014).** Each excerpt is capped by
 *   {@link SOURCE_EXCERPT_MAX_CHARS} and the whole context by `maxChars`
 *   ({@link CONTEXT_MAX_CHARS} = 12,000 by default), frame and closing
 *   delimiter included — true for any mix, because every character the
 *   renderer emits is subtracted from one running budget.
 * - **Nothing is dropped silently.** A cut source carries `… [truncated]`, a
 *   source that did not fit carries the omission marker, and sources the
 *   budget could not list are named by a roll-up line whose length was
 *   reserved before the first block ran. The frame states how many references
 *   the run has, so the count of what was quoted checks against the total.
 * - **Source text cannot reach past the delimiters.** Markers are elided out
 *   of every untrusted string before quoting and before any truncation, so a
 *   cut can never reassemble one.
 *
 * The budget is spent on the sources, never on the frame: the frame is
 * counted in full first, so a shortened quotation can never cut the closing
 * delimiter. The context never contains a token or Authorization material.
 *
 * @param input - Repository, issue, identity, correlation, and the run's sources.
 * @returns Context truncated to `maxChars` characters, markers intact.
 */
/** Everything one bounded context is built from. */
export interface BoundedContextInput {
    /** `owner/name` of the repository. */
    readonly repository: string;
    /** Matched issue. */
    readonly issue: GitHubIssue;
    /** Login discovered from `GET /user`. */
    readonly authenticatedLogin: string;
    /** Correlation identifier for this dispatch. */
    readonly correlationId: string;
    /**
     * The run's source references (FR-014), in join order.
     *
     * Absent — or empty — quotes the issue body alone, which is the shape the
     * legacy single-source dispatch and every non-run caller use.
     */
    readonly sources?: readonly ContextSource[];
    /** Optional character budget; defaults to {@link CONTEXT_MAX_CHARS}. */
    readonly maxChars?: number;
    /**
     * Characters already spoken for by the operator's prompt block and its
     * blank line, reserved **before** the excerpt budget is sized (004 FR-035)
     * — so the excerpt is what shortens, never the prompt. See
     * {@link promptBlockChars} in `prompt.ts`.
     */
    readonly reservedChars?: number;
}

export function buildBoundedContext(input: BoundedContextInput): string {
    const maxChars = input.maxChars ?? CONTEXT_MAX_CHARS;
    const reservedChars = Math.max(input.reservedChars ?? 0, 0);
    const sources = input.sources ?? [];
    const blocks: ContextBlock[] = sources.length > 0
        ? sources.map((source) => ({
            head: `${source.origin} · ${source.kind} · ${source.detectedAt} · ${source.url}`,
            excerpt: source.excerpt,
        }))
        : [{ head: null, excerpt: input.issue.body ?? '' }];
    const frame = [
        'Mecha Turk dispatch (automated — started by the Mecha Turk extension from a detected GitHub event).',
        `Correlation: ${input.correlationId}`,
        `Repository: ${input.repository}`,
        `Issue #${input.issue.issueNumber}: ${defuseDelimiters(input.issue.title)}`,
        `URL: ${defuseDelimiters(input.issue.url)}`,
        `Machine account: ${input.authenticatedLogin}`,
        'Rule: configured-match — open issue assigned to the authenticated machine account.',
        `Source references: ${blocks.length}`,
        BEGIN_UNTRUSTED,
    ].join(NEWLINE);

    // The frame, the newline that follows it, the newline before the closing
    // delimiter, and the delimiter itself are counted before any source is
    // rendered, so the rendered block can never overrun `maxChars` by exactly
    // the separator that was forgotten. The prompt's reservation is subtracted
    // here too: it is part of the same budget, and it is spent first (004 FR-035).
    const available = Math.max(
        maxChars - reservedChars - frame.length - NEWLINE.length * 2 - END_UNTRUSTED.length,
        0,
    );
    const rendered = renderBlocks({ blocks, available });
    const body = rendered.length > 0 ? `${NEWLINE}${rendered.join(NEWLINE + NEWLINE)}${NEWLINE}` : '';

    return `${frame}${body}${END_UNTRUSTED}`;
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

/** The reference a request carries when no prompt was set (004 FR-032). */
const NO_PROMPT: PromptReference = { promptPresent: false, promptFingerprint: null, promptLength: null };

/**
 * Build the documented `host.startSession()` request for a matched issue.
 *
 * **Attachment identity (FR-029).** The request's `id` is the attachment
 * identifier OpenChamber's own session list shows, and it is the run's
 * correlation identifier — derived deterministically from it, so one copyable
 * string finds both the session and the audit chain. It is read from the
 * evidence record rather than passed in beside it precisely so `id` and
 * `data.correlationId` cannot drift apart: the relay puts the run's
 * `mt-run-…` correlation id in the evidence record, and every other caller
 * keeps whatever correlation id its own record already carries.
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
    /**
     * The prompt reference for the machine-readable `data` (004 FR-037).
     *
     * Omitted by the spike path, which has no run and therefore no prompt;
     * the unset triple is written either way, so the member set is constant
     * across every request this panel builds.
     */
    readonly prompt?: PromptReference;
}): StartSessionRequest {
    const worktree = worktreeValue(input.config.worktree);
    const attachmentId = input.evidence.correlationId;
    const prompt = input.prompt ?? NO_PROMPT;

    return {
        providerId: 'mecha-turk',
        id: attachmentId,
        title: input.issue.title.slice(0, GUEST_ATTACH_TITLE_MAX),
        url: input.issue.url.slice(0, GUEST_ATTACH_URL_MAX),
        kind: 'issue',
        text: input.context,
        projectId: input.config.projectId,
        data: {
            schemaVersion: input.evidence.schemaVersion,
            correlationId: attachmentId,
            repository: input.evidence.repository,
            issueId: input.evidence.issueId,
            detectedAt: input.evidence.detectedAt,
            panelGeneration: input.evidence.panelGeneration,
            // The reference, never a second copy of the instruction (004 FR-037).
            promptPresent: prompt.promptPresent,
            promptFingerprint: prompt.promptFingerprint,
            promptLength: prompt.promptLength,
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
