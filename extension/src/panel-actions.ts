/**
 * Panel actions for the spike.
 *
 * Each action is a small, independently callable step over the shared
 * {@link PanelRuntime}: poll one repository window, accept one match, dispatch
 * one session, verify host-owned state, or record a lifecycle marker. Actions
 * never reject — failures are recorded in the ledger so the panel keeps
 * working and the evidence stays honest.
 */

import { repositoryLabel  } from './config.ts';
import type { SpikeConfig } from './config.ts';
import { buildEvidence, EVIDENCE_STORAGE_KEY, serializeEvidence  } from './evidence.ts';
import type { SpikeEvidence } from './evidence.ts';
import { fetchAuthenticatedLogin, fetchOpenIssues, GitHubApiError  } from './github.ts';
import type { GitHubIssue } from './github.ts';
import { summarizeHostVerification, verifyHostState } from './host-verify.ts';
import type { HostVerification } from './host-verify.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { parseJsonValue } from './json.ts';
import { appendEntry, LEDGER_STORAGE_KEY, recordPhase, serializeLedger } from './ledger.ts';
import type { LedgerDetail, LedgerEntryInput, LedgerEntryKind } from './ledger.ts';
import { checkMachineIdentity, sweepIssues } from './matching.ts';
import { refresh } from './panel-ui.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { redact } from './redaction.ts';
import { describeError, resolveProject } from './session.ts';

/**
 * Persist the ledger, asserting redaction and the host value limit first.
 *
 * Never rejects: a failed write is reported through the banner so the panel
 * cannot claim durable progress it does not have.
 *
 * @param rt - Panel runtime.
 */
export async function persistLedger(rt: PanelRuntime): Promise<void> {
    if (rt.disposed) {
        return;
    }

    try {
        const json = serializeLedger(rt.state.ledger);
        await rt.host.storage.set(LEDGER_STORAGE_KEY, parseJsonValue(json));
    } catch (cause) {
        setStatus(rt, { tone: 'error', title: 'Ledger write failed', body: describeError(cause) });
    }
}

/**
 * Persist the current evidence record after asserting it is redacted.
 *
 * @param rt - Panel runtime.
 * @param evidence - Evidence record to store.
 */
async function persistEvidence(rt: PanelRuntime, evidence: SpikeEvidence): Promise<void> {
    try {
        await rt.host.storage.set(EVIDENCE_STORAGE_KEY, parseJsonValue(serializeEvidence(evidence)));
    } catch (cause) {
        setStatus(rt, { tone: 'error', title: 'Evidence write failed', body: describeError(cause) });
    }
}

/**
 * Append a ledger entry, persist it, and let the caller repaint.
 *
 * @param rt - Panel runtime.
 * @param input - Entry to append.
 */
export function appendEntryAndPersist(rt: PanelRuntime, input: LedgerEntryInput): void {
    rt.state.ledger = appendEntry(rt.state.ledger, input);
    void persistLedger(rt);
}

/** Inputs for {@link recordFailure}. */
export interface FailureInput {
    /** Ledger kind for the failure entry. */
    readonly kind: LedgerEntryKind;
    /** Caught value. */
    readonly cause: unknown;
    /** Correlation identifier for the failed attempt. */
    readonly correlationId: string;
}

/**
 * Record a failure without leaking provider payloads.
 *
 * @param rt - Panel runtime.
 * @param input - Kind, cause, and correlation identifier.
 */
export function recordFailure(rt: PanelRuntime, input: FailureInput): void {
    const status = input.cause instanceof GitHubApiError ? input.cause.status : null;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: input.kind,
        correlationId: input.correlationId,
        detail: { error: describeError(input.cause), httpStatus: status, correlationId: input.correlationId },
    });
    setStatus(rt, { tone: 'error', title: 'Request failed', body: redact(describeError(input.cause)) });
}

/** A single matching issue accepted as the configured match. */
interface MatchInput {
    /** The one matching issue. */
    readonly issue: GitHubIssue;
    /** Correlation identifier for this observation. */
    readonly correlationId: string;
    /** Validated configuration. */
    readonly config: SpikeConfig;
    /** Authenticated machine account login. */
    readonly login: string;
}

/** One repository poll window handed to the sweep. */
interface SweepInput {
    /** Issues from the poll. */
    readonly issues: readonly GitHubIssue[];
    /** Authenticated machine account login. */
    readonly login: string;
    /** Validated configuration. */
    readonly config: SpikeConfig;
    /** Correlation identifier for this poll. */
    readonly correlationId: string;
}

/**
 * Accept a single matching issue and persist its evidence record.
 *
 * @param rt - Panel runtime.
 * @param input - Matched issue plus its observation context.
 */
async function acceptMatch(rt: PanelRuntime, input: MatchInput): Promise<void> {
    try {
        const evidence = buildEvidence({
            repository: repositoryLabel(input.config.repository),
            issueNumber: input.issue.issueNumber,
            issueUrl: input.issue.url,
            authenticatedLogin: input.login,
            correlationId: input.correlationId,
            detectedAt: nowIso(),
            panelGeneration: rt.state.ledger.panelGeneration,
        });

        rt.state.match = input.issue;
        rt.state.evidence = evidence;
        await persistEvidence(rt, evidence);

        const detail: LedgerDetail = {
            correlationId: evidence.correlationId,
            issueId: evidence.issueId,
            authenticatedLogin: evidence.authenticatedLogin,
            detectedAt: evidence.detectedAt,
            panelGeneration: evidence.panelGeneration,
        };
        appendEntryAndPersist(rt, { at: nowIso(), kind: 'evidence', correlationId: input.correlationId, detail });
        setStatus(rt, {
            tone: 'success',
            title: 'Matched issue',
            body: `Issue #${input.issue.issueNumber} is assigned to ${input.login}; evidence recorded.`,
        });
    } catch (cause) {
        recordFailure(rt, { kind: 'match', cause, correlationId: input.correlationId });
    }
}

/**
 * Apply the matching rule to a poll window and record the outcome.
 *
 * @param rt - Panel runtime.
 * @param input - Issues, identity, configuration, and correlation.
 */
async function applySweep(rt: PanelRuntime, input: SweepInput): Promise<void> {
    if (rt.disposed) {
        return;
    }

    const sweep = sweepIssues(input.issues, input.login);
    const detail: LedgerDetail = {
        correlationId: input.correlationId,
        repository: repositoryLabel(input.config.repository),
        inspected: sweep.inspected,
        matched: sweep.matches.length,
        rejectedNotAssigned: sweep.rejected.notAssigned,
        rejectedPullRequests: sweep.rejected.isPullRequest,
        rejectedNotOpen: sweep.rejected.notOpen,
    };
    appendEntryAndPersist(rt, { at: nowIso(), kind: 'poll', correlationId: input.correlationId, detail });

    const match = sweep.matches[0];
    if (sweep.matches.length === 1 && match !== undefined) {
        const matchInput: MatchInput = {
            issue: match,
            correlationId: input.correlationId,
            config: input.config,
            login: input.login,
        };
        await acceptMatch(rt, matchInput);
        return;
    }

    if (sweep.matches.length === 0) {
        rt.state.match = null;
        setStatus(rt, { tone: 'info', title: 'Polling', body: 'No open issue is assigned to the machine account.' });
        return;
    }

    rt.state.match = null;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: 'match',
        correlationId: input.correlationId,
        detail: { problem: 'ambiguous-match', matched: sweep.matches.length, note: 'exactly one match is required' },
    });
    setStatus(rt, {
        tone: 'warning',
        title: 'Ambiguous match',
        body: `${sweep.matches.length} issues matched; the spike dispatches only on exactly one.`,
    });
}

/**
 * Run one repository poll: fetch, match, and record.
 *
 * @param rt - Panel runtime.
 */
export async function runPoll(rt: PanelRuntime): Promise<void> {
    const { config, login } = rt.state;
    if (rt.disposed || rt.pollInFlight || config === null || login === null) {
        return;
    }

    rt.pollInFlight = true;
    const correlationId = newCorrelationId();
    try {
        const issues = await fetchOpenIssues(rt.host, config.repository);
        await applySweep(rt, { issues, login, config, correlationId });
    } catch (cause) {
        recordFailure(rt, { kind: 'poll', cause, correlationId });
    } finally {
        rt.pollInFlight = false;
        refresh(rt);
    }
}

/**
 * Start the poll loop if it is not already running.
 *
 * @param rt - Panel runtime.
 */
export function startPolling(rt: PanelRuntime): void {
    const { config } = rt.state;
    if (rt.disposed || config === null || rt.pollTimer !== null || rt.state.login === null) {
        return;
    }

    void runPoll(rt);
    rt.pollTimer = setInterval(() => {
        void runPoll(rt);
    }, config.pollIntervalMs);
}

/**
 * Stop the poll loop if one is running.
 *
 * @param rt - Panel runtime.
 */
export function stopPolling(rt: PanelRuntime): void {
    if (rt.pollTimer === null) {
        return;
    }

    clearInterval(rt.pollTimer);
    rt.pollTimer = null;
}

/**
 * Authenticate the connected token once and start polling.
 *
 * @param rt - Panel runtime.
 */
export async function ensureIdentity(rt: PanelRuntime): Promise<void> {
    const { config } = rt.state;
    if (config === null || rt.state.login !== null) {
        return;
    }

    const correlationId = newCorrelationId();
    try {
        const login = await fetchAuthenticatedLogin(rt.host);
        if (rt.disposed) {
            return;
        }

        const identity = checkMachineIdentity(login, config.expectedLogin);
        if (!identity.ok) {
            appendEntryAndPersist(rt, {
                at: nowIso(),
                kind: 'identity',
                correlationId,
                detail: { problem: identity.problem, expectedLogin: config.expectedLogin, correlationId },
            });
            setStatus(rt, { tone: 'error', title: 'Identity check failed', body: identity.problem });
            refresh(rt);
            return;
        }

        rt.state.login = login;
        appendEntryAndPersist(rt, {
            at: nowIso(),
            kind: 'identity',
            correlationId,
            detail: { authenticatedLogin: login, expectedLogin: config.expectedLogin, correlationId },
        });
        setStatus(rt, { tone: 'info', title: 'Authenticated', body: `Machine account: ${login}` });
        startPolling(rt);
    } catch (cause) {
        recordFailure(rt, { kind: 'identity', cause, correlationId });
    }

    refresh(rt);
}

/** Ledger kind used for host verification entries. */
const HOST_VERIFY_KIND: LedgerEntryKind = 'host-verify';

/**
 * Render a one-line summary of the verification result.
 *
 * @param verification - Verification result.
 * @returns Banner text with project, worktree, session, and probe counts.
 */
function summarizeVerification(verification: HostVerification): string {
    const replayed = verification.probes.filter((probe) => probe.snapshotReplayed).length;
    const totals = `worktrees=${verification.worktreeCount}; sessions=${verification.sessionCount}`;
    const found = String(verification.projectFound);
    return `project=${found}; ${totals}; probes replayed ${replayed}/${verification.probes.length}`;
}

/**
 * Verify host-owned project, worktree, and session state and record it.
 *
 * @param rt - Panel runtime.
 */
export async function verifyHost(rt: PanelRuntime): Promise<void> {
    const { config } = rt.state;
    if (config === null || rt.state.busy) {
        return;
    }

    rt.state.busy = true;
    refresh(rt);
    try {
        const project = await resolveProject(rt.host, config.projectId);
        if (!project.ok) {
            const detail: LedgerDetail = { projectId: config.projectId, problem: project.problem };
            appendEntryAndPersist(rt, { at: nowIso(), kind: HOST_VERIFY_KIND, detail });
            setStatus(rt, { tone: 'error', title: 'Project unresolved', body: project.problem });
            return;
        }

        const verification = await verifyHostState({ host: rt.host, projectId: config.projectId });
        if (rt.disposed) {
            return;
        }

        const detail = summarizeHostVerification(verification);
        appendEntryAndPersist(rt, { at: nowIso(), kind: HOST_VERIFY_KIND, detail });
        setStatus(rt, {
            tone: verification.problems.length === 0 ? 'success' : 'warning',
            title: 'Host state verified',
            body: summarizeVerification(verification),
        });
    } catch (cause) {
        recordFailure(rt, { kind: HOST_VERIFY_KIND, cause, correlationId: rt.state.ledger.correlationId });
    } finally {
        rt.state.busy = false;
        refresh(rt);
    }
}

/**
 * Record the operator-selected lifecycle phase marker.
 *
 * @param rt - Panel runtime.
 */
export async function markPhase(rt: PanelRuntime): Promise<void> {
    const note = 'operator-marked while the panel was re-opened';
    rt.state.ledger = recordPhase(rt.state.ledger, { phase: rt.pendingPhase, at: nowIso(), note });
    setStatus(rt, {
        tone: 'info',
        title: 'Phase recorded',
        body: `Marked "${rt.pendingPhase}" on generation ${rt.state.ledger.panelGeneration}.`,
    });
    await persistLedger(rt);
    refresh(rt);
}
