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

/** Maximum characters of bounded context sent as the session's first message (FR-014: ≤12,000 per dispatch). */
export const CONTEXT_MAX_CHARS = 12_000;

/**
 * Maximum characters one source's excerpt may occupy in the context.
 *
 * Two limits have to hold at once (FR-014): a per-source ceiling of 4,000
 * characters and the 12,000-character dispatch total. The per-item bound this
 * module applies is {@link SOURCE_EXCERPT_MAX_CHARS} — the 600-character bound
 * the trigger layer already writes and the claim transport already carries —
 * which is inside the 4,000 ceiling by construction, so the *budget* rather
 * than the ceiling is what decides how much of a source is shown. Each source
 * actually receives `min(600, its fair share of what is left)`, so 200
 * retained references (200 × 600 = 120,000 characters) can never crowd past
 * the dispatch total, and every source that is cut says so (FR-014's explicit
 * truncation marker — never a silent drop).
 */
export const SOURCE_EXCERPT_MAX_CHARS = 600;

/** Line separator used by the bounded context. */
const NEWLINE = '\n';

/** Appended to excerpt text this module cut (FR-014's explicit truncation marker). */
const EXCERPT_TRUNCATION_MARKER = '… [truncated]';

/** Stands in for excerpt text this context had no room for; never silent (FR-014). */
const EXCERPT_OMITTED_MARKER = '[excerpt omitted: no room in this dispatch context]';

/** Opening delimiter of the untrusted source text (FR-026). */
const BEGIN_UNTRUSTED = '--- BEGIN UNTRUSTED ISSUE TEXT (truncated) ---';

/** Closing delimiter of the untrusted source text (FR-026). */
const END_UNTRUSTED = '--- END UNTRUSTED ISSUE TEXT ---';

/** Hyphen used to elide a delimiter that hostile source text tried to forge. */
const DEFUSED_HYPHEN = '‐';

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
 * Elide one block delimiter out of untrusted text.
 *
 * @param marker - The literal marker to neutralize.
 * @returns The marker with its hyphens substituted, so it can no longer match.
 */
function elideMarker(marker: string): string {
    return marker.replaceAll('-', DEFUSED_HYPHEN);
}

/**
 * Elide any attempt by untrusted text to forge one of the block's delimiters.
 *
 * A source that quoted `--- END UNTRUSTED ISSUE TEXT ---` verbatim would close
 * the block early and let everything after it read as trusted framing — which
 * is exactly what FR-014's "delimiters that prevent source text from altering
 * policy" forbids. The substitution is byte-for-byte length preserving, happens
 * **before** any truncation (so a cut can never reassemble a marker), and only
 * ever touches the two literal markers.
 *
 * @param text - Untrusted source text.
 * @returns The text with every forged delimiter neutralized.
 */
function defuseDelimiters(text: string): string {
    return text
        .replaceAll(BEGIN_UNTRUSTED, elideMarker(BEGIN_UNTRUSTED))
        .replaceAll(END_UNTRUSTED, elideMarker(END_UNTRUSTED));
}

/**
 * Fit one source's excerpt into its share of the budget, marking the cut.
 *
 * @param excerpt - Untrusted excerpt, delimiters already neutralized.
 * @param bound - Characters this source may spend on its excerpt.
 * @returns The excerpt, a truncation-marked prefix of it, or the omission
 *   marker when not even the marker's own length fits.
 */
function fitExcerpt(excerpt: string, bound: number): string {
    if (excerpt.length <= bound) {
        return excerpt;
    }

    if (bound <= EXCERPT_TRUNCATION_MARKER.length) {
        return EXCERPT_OMITTED_MARKER;
    }

    return `${excerpt.slice(0, bound - EXCERPT_TRUNCATION_MARKER.length)}${EXCERPT_TRUNCATION_MARKER}`;
}

/** One line of untrusted context: its heading, and the excerpt under it. */
interface ContextBlock {
    /** `null` for the legacy single-source shape, which carries no heading. */
    readonly head: string | null;
    /** The source's excerpt. */
    readonly excerpt: string;
}

/**
 * Compose the explicit roll-up line that names the sources the budget excluded.
 *
 * @param skipped - How many sources were not listed.
 * @returns The line; plain text, never a delimiter.
 */
function rollUpLine(skipped: number): string {
    const noun = skipped === 1 ? 'source' : 'sources';

    return `[+${skipped} ${noun} not listed: dispatch context budget exhausted]`;
}

/**
 * Render every block the budget still affords, in order.
 *
 * Each source takes `min(SOURCE_EXCERPT_MAX_CHARS, its fair share of what is
 * left)`, so the answer is deterministic, every listed source is fully
 * accounted for, and a source the budget cannot list is counted rather than
 * silently dropped. The roll-up line's length is reserved before the first
 * block is rendered, which is what makes "never silent" a guarantee instead of
 * a hope: the reserved space cannot be spent by the blocks in front of it.
 *
 * @param input - The blocks and the character budget their lines may occupy.
 * @returns The lines to place between the delimiters, in order.
 */
function renderBlocks(input: { readonly blocks: readonly ContextBlock[]; readonly available: number }): string[] {
    const { blocks, available } = input;
    // Two extra characters cover the blank line that would precede the roll-up.
    // Reserving only for a multi-source run keeps a single-source context whole:
    // there the block's own truncation/omission marker is the visible cut, and
    // spending sixty characters on a roll-up that cannot happen would only
    // shrink the quotation.
    const reserve = blocks.length > 1 ? rollUpLine(blocks.length).length + NEWLINE.length * 2 : 0;
    const budget = Math.max(available - reserve, 0);
    const rendered: string[] = [];
    let used = 0;
    let skipped = 0;

    for (const [index, block] of blocks.entries()) {
        const separator = rendered.length > 0 ? NEWLINE.length * 2 : 0;
        const remaining = budget - used - separator;
        const sourcesLeft = blocks.length - index;
        if (remaining <= 0) {
            skipped = sourcesLeft;
            break;
        }

        const head = block.head === null ? '' : `${defuseDelimiters(block.head)}${NEWLINE}`;
        // FR-014's per-item bound: the smallest of the excerpt ceiling, this
        // source's fair share of what is left, and what is left after its own
        // heading is paid for. All three hold at once, and the hard length
        // check below keeps the total honest whatever the three disagree about.
        const share = Math.floor(remaining / sourcesLeft);
        const bound = Math.max(Math.min(SOURCE_EXCERPT_MAX_CHARS, share, remaining - head.length), 0);
        const text = `${head}${fitExcerpt(defuseDelimiters(block.excerpt), bound)}`;
        if (text.length > remaining) {
            skipped = sourcesLeft;
            break;
        }

        rendered.push(text);
        used += separator + text.length;
    }

    if (skipped > 0) {
        const rollUp = rollUpLine(skipped);
        const separator = rendered.length > 0 ? NEWLINE.length * 2 : 0;
        if (used + separator + rollUp.length <= available) {
            rendered.push(rollUp);
        }
    }

    return rendered;
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
 * Source text is untrusted material (FR-026), so every source is quoted inside
 * one explicit delimited block and bounded before it can dominate the prompt.
 * Three guarantees hold simultaneously, which is the whole point of the shape:
 *
 * - **Both limits, at once (FR-014).** Every source's excerpt is at most
 *   {@link SOURCE_EXCERPT_MAX_CHARS} characters — inside FR-014's 4,000
 *   per-source ceiling — and the whole context is at most `maxChars`
 *   ({@link CONTEXT_MAX_CHARS} = 12,000 by default) including the frame, the
 *   separators, and the closing delimiter. Both are true for any mix of
 *   sources, because every character the renderer emits is subtracted from the
 *   same running budget.
 * - **Nothing is dropped silently.** A source that is cut carries
 *   `… [truncated]`; a source whose text did not fit carries the explicit
 *   omission marker; and sources the budget could not list at all are named in
 *   a roll-up line whose length is reserved before the first source is
 *   rendered, so the reserved space cannot be spent in front of it. The frame
 *   additionally states how many references the run has, so the count of what
 *   was quoted is always checkable against the total.
 * - **Source text cannot reach past the delimiters.** The opening and closing
 *   markers are elided out of every untrusted string before it is quoted, and
 *   before any truncation, so a source quoting the closing marker verbatim
 *   cannot end the block early — and a cut can never reassemble one.
 *
 * The budget is spent on the sources, never on the frame: the frame is counted
 * in full first, so truncating a source can shorten a quotation but can never
 * cut the closing delimiter. The context never contains a token or any
 * Authorization material.
 *
 * @param input - Repository, issue, identity, correlation, and the run's sources.
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
    /**
     * The run's source references (FR-014), in join order.
     *
     * Absent — or empty — quotes the issue body alone, which is the shape the
     * legacy single-source dispatch and every non-run caller use.
     */
    readonly sources?: readonly ContextSource[];
    /** Optional character budget; defaults to {@link CONTEXT_MAX_CHARS}. */
    readonly maxChars?: number;
}): string {
    const maxChars = input.maxChars ?? CONTEXT_MAX_CHARS;
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
    // the separator that was forgotten.
    const available = Math.max(maxChars - frame.length - NEWLINE.length * 2 - END_UNTRUSTED.length, 0);
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
}): StartSessionRequest {
    const worktree = worktreeValue(input.config.worktree);
    const attachmentId = input.evidence.correlationId;

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
