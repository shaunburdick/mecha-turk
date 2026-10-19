/**
 * Host-side dispatch and verification for the panel: everything goes through
 * the documented `@openchamber/sdk` surface — the panel never creates a
 * worktree, a project, or a session on disk itself, it asks OpenChamber and
 * records what OpenChamber answers, including partial bootstrap failures.
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
import type { BindingContext, WorktreeSelection } from './config.ts';
import { BEGIN_UNTRUSTED, END_UNTRUSTED, defuseDelimiters, renderBlocks } from './context-blocks.ts';
import type { ContextBlock } from './context-blocks.ts';
import type { PromptReference } from './prompt.ts';import type { PanelEvidence } from './evidence.ts';
import type { GitHubIssue } from './github.ts';
import type { LedgerDetail, PanelLedger } from './ledger.ts';

/**
 * The host surface the panel uses: `Pick<HostClient, …>` keeps the panel on the
 * documented API surface, so adding a method here is a deliberate, reviewable
 * act. `'prompt'` was gained for the tracking lifecycle (002 FR-104) — a
 * follow-up writes into the session the dispatch created, using the
 * **already-declared** `prompt` capability, so no manifest or approval change
 * (invariant 3) — and `'openSession'`, which the read-back already calls, makes
 * that session the current one before the write lands.
 */
export type PanelHost = Pick<
    HostClient,
    | 'request'
    | 'serviceRequest'
    | 'storage'
    | 'openUrl'
    | 'writeClipboard'
    | 'startSession'
    | 'openSession'
    | 'prompt'
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

const NEWLINE = '\n';

export { SOURCE_EXCERPT_MAX_CHARS } from './context-blocks.ts';

/**
 * One source reference the dispatch context quotes.
 *
 * Everything on it is untrusted or service-projected source material: it is
 * copied into the delimited block, never interpreted, and never allowed to
 * alter the frame around it.
 */
export interface ContextSource {
    readonly origin: string;
    readonly kind: 'assignment' | 'mention' | 'review';
    readonly detectedAt: string;
    readonly url: string;
    /** Bounded untrusted excerpt. */
    readonly excerpt: string;
}

/**
 * Render a human-readable error without echoing provider payloads.
 */
export function describeError(cause: unknown): string {
    if (cause instanceof Error) {
        return `${cause.name}: ${cause.message}`;
    }

    return String(cause);
}

export type ProjectResolution =
    | { readonly ok: true; readonly project: GuestProject }
    | { readonly ok: false; readonly problem: string; readonly available: readonly string[] };

/**
 * Resolve the configured project reference against `host.listProjects()`: the
 * panel never creates a project implicitly — an absent or invalid reference
 * blocks the dispatch (constitution II). Answers the project, or the blocking
 * problem plus the available ids.
 */
export async function resolveProject(
    host: Pick<PanelHost, 'listProjects'>,
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
 * The blocks one bounded context quotes: the source list when the caller has
 * one, the issue body alone otherwise — the shape the legacy single-source
 * dispatch uses, kept here so the renderer cannot grow a third rule about what
 * a body is. In join order.
 */
function contextBlocks(input: {
    readonly sources?: readonly ContextSource[];
    readonly issue: GitHubIssue;
}): ContextBlock[] {
    const sources = input.sources ?? [];

    return sources.length > 0
        ? sources.map((source) => ({
            head: `${source.origin} · ${source.kind} · ${source.detectedAt} · ${source.url}`,
            excerpt: source.excerpt,
        }))
        : [{ head: null, excerpt: input.issue.body ?? '' }];
}

export interface BoundedContextRender {
    /**
     * The frame's own lines, above `BEGIN_UNTRUSTED`: the panel's two stories —
     * a dispatch and a follow-up — differ in exactly this header. Markers,
     * budget, and running subtraction are the shared safety half, so a second
     * header cannot come with a second, weaker implementation of them.
     */
    readonly header: readonly string[];
    readonly sources?: readonly ContextSource[];
    readonly issue: GitHubIssue;
    readonly maxChars?: number;
    readonly reservedChars?: number;
}

/**
 * Render one bounded context: a caller's frame, the delimited blocks, the bound.
 * The budget is spent on the sources, never the frame — the frame is counted in
 * full first, so a shortened quotation can never cut the closing delimiter —
 * and source text is elided of its markers inside {@link renderBlocks}, so a
 * cut can never reassemble one: the whole reason this is one function with a
 * parameter rather than two functions with two implementations.
 */
export function renderBoundedContext(input: BoundedContextRender): string {
    const maxChars = input.maxChars ?? CONTEXT_MAX_CHARS;
    const reservedChars = Math.max(input.reservedChars ?? 0, 0);
    const blocks = contextBlocks(input);
    const frame = [...input.header, BEGIN_UNTRUSTED].join(NEWLINE);

    // The frame, the newline that follows it, the newline before the closing
    // delimiter, and the delimiter itself are counted before any source is
    // rendered, so the rendered block can never overrun `maxChars` by exactly
    // the separator that was forgotten. The prompt's reservation is subtracted
    // here too: it is part of the same budget, and it is spent first.
    const available = Math.max(
        maxChars - reservedChars - frame.length - NEWLINE.length * 2 - END_UNTRUSTED.length,
        0,
    );
    const rendered = renderBlocks({ blocks, available });
    const body = rendered.length > 0 ? `${NEWLINE}${rendered.join(NEWLINE + NEWLINE)}${NEWLINE}` : '';

    return `${frame}${body}${END_UNTRUSTED}`;
}

export interface BoundedContextInput {
    readonly repository: string;
    readonly issue: GitHubIssue;
    readonly authenticatedLogin: string;
    readonly correlationId: string;
    /**
     * The run's source references, in join order.
     *
     * Absent — or empty — quotes the issue body alone, which is the shape the
     * legacy single-source dispatch and every non-run caller use.
     */
    readonly sources?: readonly ContextSource[];
    readonly maxChars?: number;
    /**
     * Characters already spoken for by the operator's prompt block and its
     * blank line, reserved **before** the excerpt budget is sized
     * — so the excerpt is what shortens, never the prompt. See
     * {@link promptBlockChars} in `prompt.ts`.
     */
    readonly reservedChars?: number;
}

/**
 * Build the bounded first-message context for a dispatched session. Three guarantees hold at
 * once: **both limits** — per-excerpt {@link SOURCE_EXCERPT_MAX_CHARS} and whole-context
 * {@link CONTEXT_MAX_CHARS} — apply to any mix, every emitted character subtracted from one
 * running budget; **nothing is dropped silently** — truncation and omission markers, plus a
 * roll-up line whose length was reserved before the first block ran; and **source text cannot
 * reach past the delimiters** — markers are elided out of every untrusted string before quoting
 * and before any truncation, so a cut never eats the closing delimiter. No token material.
 */
export function buildBoundedContext(input: BoundedContextInput): string {
    // OpenChamber titles guest sessions `<attach id> <attach title>`, which is
    // unfindable in the sidebar; the agent inside the session is the only one
    // who can rename it, so the frame asks once, idempotently.
    const title = defuseDelimiters(input.issue.title);
    const sessionName = `${input.issue.isPullRequest ? 'PR' : 'Issue'} #${input.issue.issueNumber}: ${title}`;
    const header = [
        'Mecha Turk dispatch (automated — started by the Mecha Turk extension from a detected GitHub event).',
        `Correlation: ${input.correlationId}`,
        `Repository: ${input.repository}`,
        `Issue #${input.issue.issueNumber}: ${title}`,
        `Before starting work, rename this session to "${sessionName}"; if its name already equals it, do nothing.`,
        `URL: ${defuseDelimiters(input.issue.url)}`,
        `Machine account: ${input.authenticatedLogin}`,
        'Rule: configured-match — open issue assigned to the authenticated machine account.',
        `Source references: ${contextBlocks(input).length}`,
    ];

    return renderBoundedContext({
        header,
        issue: input.issue,
        ...(input.sources !== undefined && { sources: input.sources }),
        ...(input.maxChars !== undefined && { maxChars: input.maxChars }),
        ...(input.reservedChars !== undefined && { reservedChars: input.reservedChars }),
    });
}
/**
 * Map the configured worktree option onto the documented `startSession` value.
 *
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

const NO_PROMPT: PromptReference = {
    promptPresent: false,
    promptFingerprint: null,
    promptLength: null,
    promptSources: null,
};

/**
 * Build the documented `host.startSession()` request for a matched issue.
 * **Attachment identity:** the request's `id` is the attachment identifier
 * OpenChamber's own session list shows, derived from the run's correlation id
 * so one copyable string finds both the session and the audit chain — read from
 * the evidence record rather than passed beside it precisely so `id` and
 * `data.correlationId` cannot drift apart.
 */
export function buildStartSessionRequest(input: {
    readonly config: BindingContext;
    readonly evidence: PanelEvidence;
    readonly issue: GitHubIssue;
    readonly context: string;
    /**
     * The prompt reference for the machine-readable `data`.
     *
     * Omitted by the non-run path, which has no run and therefore no prompt;
     * the unset quartet is written either way, so the member set is constant
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
            // The reference, never a second copy of the instruction;
            // the source list rides beside it, additive within `extension-spike-1`.
            // Spread onto a fresh mutable array because the
            // host envelope is `JsonValue`, which cannot hold a `readonly` list.
            promptPresent: prompt.promptPresent,
            promptFingerprint: prompt.promptFingerprint,
            promptLength: prompt.promptLength,
            promptSources: prompt.promptSources === null ? null : [...prompt.promptSources],
        },
        ...(worktree !== undefined && { worktree }),
    };
}

type StartSessionFailure = Extract<StartSessionResult, { failure: 'bootstrap-failed' | 'session-create-failed' }>;

type StartSessionSuccess = Exclude<StartSessionResult, StartSessionFailure>;

/**
 * Summarize a successful `host.startSession()` result for the ledger.
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
 * Summarize a partial bootstrap failure for the ledger: the worktree OpenChamber
 * left behind is part of the record, because the relay inspects this before any
 * retry. Scalar, secret-free fields.
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
 * Summarize a `host.startSession()` result for the ledger, recording the full
 * result including partial bootstrap failures — null session id, failure
 * reason, directory, and any worktree left behind. Scalar and secret-free.
 */
export function summarizeStartSessionResult(result: StartSessionResult): LedgerDetail {
    return 'failure' in result ? summarizeFailure(result) : summarizeSuccess(result);
}

/**
 * Check that a session detail records a session the host actually created:
 * blocked and failed attempts are recorded as `session` entries too, carrying
 * `problem`/`failure` instead of a session id, so they must never count as a
 * dispatch. `true` only for a non-empty created session id.
 */
function hasCreatedSession(detail: LedgerDetail): boolean {
    const { sessionId } = detail;
    return typeof sessionId === 'string' && sessionId !== '';
}

/**
 * Find whether the ledger already dispatched a given issue, keeping the relay
 * idempotent: one issue produces at most one created session, and only
 * *successful* dispatches count — a transient failure is evidence to retry
 * from, so one unresolved project cannot disable the panel until its ledger is
 * deleted.
 */
export function findDispatchForIssue(ledger: PanelLedger, issueId: string): boolean {
    return ledger.entries.some(
        (entry) => entry.kind === 'session' && entry.detail.issueId === issueId && hasCreatedSession(entry.detail),
    );
}
