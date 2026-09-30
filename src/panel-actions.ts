/**
 * Panel actions for the spike.
 *
 * Each action is a small, independently callable step over the shared
 * {@link PanelRuntime}: poll one repository window, accept one match, dispatch
 * one session, verify host-owned state, or record a lifecycle marker. Actions
 * never reject — failures are recorded in the ledger so the panel keeps
 * working and the evidence stays honest.
 */

import { repositoryLabel } from './config.ts';
import type { SpikeConfig } from './config.ts';
import { buildEvidence, EVIDENCE_STORAGE_KEY, EvidenceError, serializeEvidence } from './evidence.ts';
import type { SpikeEvidence } from './evidence.ts';
import { fetchAuthenticatedLogin, fetchOpenIssues, GitHubApiError } from './github.ts';
import type { GitHubIssue } from './github.ts';
import { summarizeHostVerification, verifyHostState } from './host-verify.ts';
import type { HostVerification } from './host-verify.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { parseJsonValue } from './json.ts';
import { repairLedger } from './ledger-repair.ts';
import { appendEntry, LEDGER_STORAGE_KEY, serializeLedger } from './ledger.ts';
import type { LedgerDetail, LedgerEntryInput, LedgerEntryKind } from './ledger.ts';
import { checkMachineIdentity, sweepIssues } from './matching.ts';
import { refresh } from './panel-ui.ts';
import { setStatus } from './panel-state.ts';
import type { PanelRuntime } from './panel-state.ts';
import { RedactionError, redact } from './redaction.ts';
import { describeError, resolveProject } from './session.ts';

/**
 * Write the serialized ledger to host storage.
 *
 * @param rt - Panel runtime.
 * @throws {RedactionError} When the ledger matches a secret shape.
 * @throws {Error} When the ledger exceeds the host's value limit, or the host
 * refuses the write for its own reasons.
 */
async function writeLedger(rt: PanelRuntime): Promise<void> {
    const json = serializeLedger(rt.state.ledger);
    await rt.host.storage.set(LEDGER_STORAGE_KEY, parseJsonValue(json));
}

/**
 * Persist the ledger, asserting redaction and the host value limit first.
 *
 * Never rejects. When a write fails because an entry carries secret-shaped
 * material or the ledger outgrew the host's value limit, the offending entry is
 * repaired ({@link repairLedger}) and the write is retried exactly once, so one
 * bad entry cannot poison every later write. Whatever is left is reported
 * through the banner so the panel never claims durable progress it does not
 * have.
 *
 * @param rt - Panel runtime.
 */
export async function persistLedger(rt: PanelRuntime): Promise<void> {
    if (rt.disposed) {
        return;
    }

    try {
        await writeLedger(rt);
    } catch (cause) {
        const repair = repairLedger({ ledger: rt.state.ledger, cause });
        if (repair === null) {
            setStatus(rt, { tone: 'error', title: 'Ledger write failed', body: describeError(cause) });
            return;
        }

        rt.state.ledger = repair.ledger;
        setStatus(rt, { tone: 'warning', title: 'Ledger repaired', body: repair.summary });
        try {
            await writeLedger(rt);
        } catch (retryCause) {
            setStatus(rt, { tone: 'error', title: 'Ledger write failed', body: describeError(retryCause) });
        }
    }
}

/**
 * Persist the current evidence record after asserting it is redacted.
 *
 * @param rt - Panel runtime.
 * @param evidence - Evidence record to store.
 * @returns `true` when the record is durable, `false` when the write failed —
 * which is also reported through the banner.
 */
async function persistEvidence(rt: PanelRuntime, evidence: SpikeEvidence): Promise<boolean> {
    try {
        await rt.host.storage.set(EVIDENCE_STORAGE_KEY, parseJsonValue(serializeEvidence(evidence)));
        return true;
    } catch (cause) {
        setStatus(rt, { tone: 'error', title: 'Evidence write failed', body: describeError(cause) });
        return false;
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
 * Choose a banner title that names what actually failed.
 *
 * A rejected evidence record or a redaction refusal is not a failed request, so
 * the title says what went wrong instead of blaming the network for every
 * exception.
 *
 * @param cause - Caught value.
 * @returns The banner title for this failure.
 */
function failureTitle(cause: unknown): string {
    if (cause instanceof EvidenceError) {
        return 'Evidence rejected';
    }

    if (cause instanceof RedactionError) {
        return 'Redaction refused the write';
    }

    return 'Request failed';
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
    setStatus(rt, { tone: 'error', title: failureTitle(input.cause), body: redact(describeError(input.cause)) });
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
 * Panel state takes the record only after it is durable, so a failed write can
 * never leave the dispatch button offering an issue storage refused to keep.
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

        const stored = await persistEvidence(rt, evidence);
        if (!stored) {
            return;
        }

        rt.state.match = input.issue;
        rt.state.evidence = evidence;

        const detail: LedgerDetail = {
            correlationId: evidence.correlationId,
            issueId: evidence.issueId,
            issueUrl: evidence.issueUrl,
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
        body: `${sweep.matches.length} issues matched; Mecha Turk dispatches only on exactly one.`,
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
 * Arm the poll loop with the given cadence.
 *
 * @param rt - Panel runtime.
 * @param intervalMs - Cadence for the interval timer.
 */
function armPollTimer(rt: PanelRuntime, intervalMs: number): void {
    rt.pollTimer = setInterval(() => {
        void runPoll(rt);
    }, intervalMs);
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
    armPollTimer(rt, config.pollIntervalMs);
}

/**
 * Re-arm a running poll loop with the interval the configuration holds now.
 *
 * Settings can change `pollIntervalMs` while a timer is already running; the
 * timer keeps its old cadence otherwise. Only an existing loop is re-armed —
 * this never starts polling by itself and never fires an immediate poll.
 *
 * @param rt - Panel runtime.
 * @returns `true` when a running timer was re-armed, `false` when none was.
 */
export function restartPolling(rt: PanelRuntime): boolean {
    const { config } = rt.state;
    if (rt.pollTimer === null || config === null) {
        return false;
    }

    clearInterval(rt.pollTimer);
    armPollTimer(rt, config.pollIntervalMs);

    return true;
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
 * Read `/user` through the connected card and report what it answered (002 FR-011(b)).
 *
 * This is the integration card's second product: **one read-only
 * connectivity/identity diagnostic**. It runs on connect, records an `identity`
 * ledger entry either way, and reports its outcome on the banner — the login
 * it authenticated as, or the exact reason the check failed.
 *
 * Two things it deliberately does **not** do:
 *
 * - **It arms no poll.** Since 005 T-011 the legacy single-repo loop has no
 *   arming site, and the service's poll loop plus the root-owned relay are the
 *   only loops in the product; a diagnostic that started one would silently
 *   reinstate the retired path.
 * - **It needs no dispatch context.** The legacy guard this replaced required
 *   a parsed single-repo config; the card's diagnostic is about the *token*,
 *   so it runs whenever the panel is connected and has not read an identity
 *   yet, checking the login against a bound account's expectation only when
 *   one happens to be in context.
 *
 * @param rt - Panel runtime.
 */
export async function ensureIdentity(rt: PanelRuntime): Promise<void> {
    if (rt.state.login !== null) {
        return;
    }

    const correlationId = newCorrelationId();
    try {
        const login = await fetchAuthenticatedLogin(rt.host);
        if (rt.disposed) {
            return;
        }

        const expectedLogin = rt.state.config?.expectedLogin ?? null;
        const identity = checkMachineIdentity(login, expectedLogin);
        if (!identity.ok) {
            appendEntryAndPersist(rt, {
                at: nowIso(),
                kind: 'identity',
                correlationId,
                detail: { problem: identity.problem, expectedLogin, correlationId },
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
            detail: { authenticatedLogin: login, expectedLogin, correlationId },
        });
        setStatus(rt, { tone: 'info', title: 'Authenticated', body: `Machine account: ${login}` });
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
 * The replay ratio counts only the snapshot surfaces: `onSessionLifecycle` is
 * an event stream with no replay guarantee, so a host that never saw a session
 * lifecycle event is not a failure (see `replayExpected`).
 *
 * @param verification - Verification result.
 * @returns Banner text with project, worktree, session, and probe counts.
 */
function summarizeVerification(verification: HostVerification): string {
    const expected = verification.probes.filter((probe) => probe.replayExpected);
    const replayed = expected.filter((probe) => probe.snapshotReplayed).length;
    const totals = `worktrees=${verification.worktreeCount}; sessions=${verification.sessionCount}`;
    const found = String(verification.projectFound);
    return `project=${found}; ${totals}; snapshots replayed ${replayed}/${expected.length}`;
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
