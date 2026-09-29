/**
 * Post-dispatch agent verification (M9) — warn, never block.
 *
 * The platform owns which agent runs a session: `startSession` carries no
 * agent field at SDK 1.24.2 and the panel cannot write Settings → Sessions →
 * Session Defaults, so the only documented read-back is
 * `onSession().agent` on the *attached* surface (research §R3, verified
 * against the pinned `dist/*.d.ts`). Reaching it costs one documented UI
 * context switch — `openSession(sessionId)` — which this module performs
 * once per successful dispatch, right after the dispatch result reaches the
 * service. `startSession` navigates with `preserve`, so the switch is a
 * single deliberate jump to the session that was just created; accepted for
 * the MVP and noted in quickstart as expected behaviour.
 *
 * Race rule: the `onSession` subscription is registered **before**
 * `openSession`, because the host replays the current snapshot to a late
 * subscriber and then keeps firing — subscribing first means the answer can
 * never arrive between the two calls and be missed.
 *
 * Outcomes are recorded, not enforced: a match lands as evidence, anything
 * else lands as a warning banner in the runs area plus a ledger entry.
 * Nothing here stops the session or blocks the event. Since 003 (T-027) the
 * read-back is also **posted to the service** — `POST …/verification`, contract
 * §5 — which writes `agent.verified` / `agent.mismatch` on the run and stores
 * `run.verification` for the run-history projection, **changing no state**:
 * the panel-side record and the service-side trail say the same thing, and a
 * report the service refuses surfaces as a visible warning rather than as a
 * silent gap (FR-043, FR-063).
 */

import type { SessionSnapshot } from '@openchamber/sdk';
import { nowIso } from './ids.ts';
import { appendEntryAndPersist } from './panel-actions.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { servicePost, verificationPath } from './service-calls.ts';
import { describeError } from './session.ts';
import type { SpikeHost } from './session.ts';
import type { PanelRuntime, PanelStatus } from './panel-state.ts';

/** How long one verification waits for the session snapshot, in milliseconds. */
export const AGENT_VERIFY_TIMEOUT_MS = 15_000;

/** Milliseconds in one second; used to phrase the timeout for the operator. */
const MS_PER_SECOND = 1_000;

/** Outcome of one post-dispatch agent read-back. */
export type AgentVerification =
    /** The session reported the expected agent. */
    | { readonly status: 'match'; readonly agent: string; readonly expected: string }
    /** The session reported another agent, or none at all. */
    | { readonly status: 'mismatch'; readonly agent: string | null; readonly expected: string }
    /** No snapshot for this session arrived inside the timeout. */
    | { readonly status: 'timeout'; readonly expected: string; readonly timeoutMs: number }
    /** The session could not be opened at all; the problem is redacted. */
    | { readonly status: 'unavailable'; readonly expected: string; readonly problem: string };

/** Inputs for {@link verifySessionAgent}. */
export interface VerifyAgentInputs {
    /** Host surface the read-back goes through. */
    readonly host: Pick<SpikeHost, 'onSession' | 'openSession'>;
    /** Session the dispatch just created. */
    readonly sessionId: string;
    /** Agent the run is expected to report (the `expected-agent` setting). */
    readonly expected: string;
    /** Optional wait budget; defaults to {@link AGENT_VERIFY_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
}

/** What the read-back's first settled leg reported. */
type VerifyGate =
    /** A snapshot for the session arrived (or the deadline passed: `null`). */
    | { readonly kind: 'snapshot'; readonly snapshot: SessionSnapshot | null }
    /** `openSession` resolved; the snapshot is still pending. */
    | { readonly kind: 'opened' }
    /** `openSession` rejected; the problem text is already redacted. */
    | { readonly kind: 'failed'; readonly problem: string };

/**
 * Judge one observed snapshot against the expected agent.
 *
 * An `agent` the snapshot does not carry reads as `null` rather than as a
 * pass: the SDK documents the field as present "when the session has it",
 * so its absence is an unreadable answer, not a matching one.
 *
 * @param input - The snapshot (or `null` on timeout), the expected agent,
 *   and the budget the caller waited with, for the timeout copy.
 * @returns The verification outcome.
 */
function judgeSnapshot(input: {
    /** Snapshot for the requested session, or `null` when the budget ran out. */
    readonly snapshot: SessionSnapshot | null;
    /** Agent the run should report. */
    readonly expected: string;
    /** Budget the caller waited with. */
    readonly timeoutMs: number;
}): AgentVerification {
    const { snapshot, expected, timeoutMs } = input;
    if (snapshot === null) {
        return { status: 'timeout', expected, timeoutMs };
    }

    const agent = snapshot.agent ?? null;

    return agent === null || agent !== expected
        ? { status: 'mismatch', agent, expected }
        : { status: 'match', agent, expected };
}

/**
 * Read the agent of one just-created session through the documented surface.
 *
 * Subscribes first, opens the session second, then resolves on the first
 * snapshot whose `id` matches — a snapshot for any other session (the host
 * replays whatever it is attached to) is ignored. The whole read-back —
 * including the `openSession` leg — is bounded by the same budget, so a host
 * that never answers cannot hold the relay's dispatch slot indefinitely.
 *
 * @param inputs - Host surface, session id, expected agent, and timeout.
 * @returns The verification outcome; never throws.
 */
export async function verifySessionAgent(inputs: VerifyAgentInputs): Promise<AgentVerification> {
    const { host, sessionId, expected } = inputs;
    const timeoutMs = inputs.timeoutMs ?? AGENT_VERIFY_TIMEOUT_MS;

    let settle: ((snapshot: SessionSnapshot | null) => void) | null = null;
    const observed = new Promise<SessionSnapshot | null>((resolve) => {
        settle = resolve;
    });
    const unsubscribe = host.onSession((snapshot) => {
        if (snapshot !== null && snapshot.id === sessionId && settle !== null) {
            settle(snapshot);
        }
    });

    // The deadline starts before the context switch, so one timer bounds the
    // entire verification rather than only the snapshot wait.
    const timer = setTimeout(() => settle?.(null), timeoutMs);
    const opened = host.openSession(sessionId).then(
        () => ({ kind: 'opened' } as const),
        (cause: unknown) => ({ kind: 'failed' as const, problem: describeError(cause) }),
    );
    const gate: VerifyGate = await Promise.race([
        observed.then((snapshot) => ({ kind: 'snapshot' as const, snapshot })),
        opened,
    ]);

    if (gate.kind === 'snapshot') {
        clearTimeout(timer);
        unsubscribe();

        return judgeSnapshot({ snapshot: gate.snapshot, expected, timeoutMs });
    }

    if (gate.kind === 'failed') {
        clearTimeout(timer);
        unsubscribe();

        return { status: 'unavailable', expected, problem: gate.problem };
    }

    // The context switch completed; the snapshot (or the deadline, which is
    // still armed) settles the read-back from here.
    const snapshot = await observed;
    clearTimeout(timer);
    unsubscribe();

    return judgeSnapshot({ snapshot, expected, timeoutMs });
}

/**
 * Build the runs-area banner for one verification outcome.
 *
 * Every non-match outcome is a warning, never a block: the session keeps
 * running and the relay keeps dispatching — M9 tells the operator which
 * agent answered, it does not play bouncer. The match outcome gets its own
 * banner so the evidence an operator looks for on a live dispatch is on
 * screen the moment it exists.
 *
 * @param result - Outcome the verification reached.
 * @returns The banner content, already redacted.
 */
export function verificationNotice(result: AgentVerification): PanelStatus {
    const expected = `expected '${result.expected}'`;
    const keepRunning = 'Warning only — the session keeps running, nothing was blocked.';
    switch (result.status) {
        case 'match':
            return {
                tone: 'success',
                title: 'Session agent verified',
                body: `The dispatched session runs on '${result.agent}' (${expected}).`,
            };
        case 'mismatch':
            return {
                tone: 'warning',
                title: 'Session agent mismatch',
                body: result.agent === null
                    ? `Dispatched, but the session reported no agent (${expected}). ${keepRunning}`
                    : `Dispatched, but the session agent was '${result.agent}' (${expected}). ${keepRunning}`,
            };
        case 'timeout': {
            const seconds = Math.floor(result.timeoutMs / MS_PER_SECOND);
            return {
                tone: 'warning',
                title: 'Session agent unreadable',
                body: [
                    `Dispatched, but the session agent was not readable within ${seconds}s`,
                    `(${expected}). ${keepRunning}`,
                ].join(' '),
            };
        }
        case 'unavailable':
            return {
                tone: 'warning',
                title: 'Session agent not verified',
                body: [
                    'Dispatched, but the session could not be opened to read its agent:',
                    `${redact(result.problem)} (${expected}). ${keepRunning}`,
                ].join(' '),
            };
    }
}

/**
 * Phrase the read-back for the service's `note` member (contract §5).
 *
 * @param result - Outcome the verification reached.
 * @returns The note, or `null` when there is nothing to add to the evidence.
 */
function readBackNote(result: AgentVerification): string | null {
    switch (result.status) {
        case 'match':
            return null;
        case 'mismatch':
            return result.agent === null
                ? 'the session reported no agent'
                : `observed ${result.agent} differs from the baseline`;
        case 'timeout': {
            const seconds = Math.floor(result.timeoutMs / MS_PER_SECOND);

            return `the agent was not readable within ${seconds}s`;
        }
        case 'unavailable':
            return `the session could not be opened: ${redact(result.problem)}`;
    }
}

/**
 * Record the read-back where the operator looks: ledger entry and banner.
 *
 * @param input - Runtime, the run, the session, the outcome, and its baseline.
 */
function recordReadBack(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The run the read-back belongs to. */
    readonly correlationId: string;
    /** Session the read-back observed. */
    readonly sessionId: string;
    /** Outcome the verification reached. */
    readonly result: AgentVerification;
    /** Baseline the judgment used (FR-029's comparison agent). */
    readonly expected: string;
}): void {
    const { rt, correlationId, sessionId, result, expected } = input;
    const observedAgent = result.status === 'match' || result.status === 'mismatch' ? result.agent : null;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: 'session',
        correlationId,
        detail: {
            correlationId,
            sessionId,
            expectedAgent: expected,
            observedAgent,
            verification: result.status,
            agentVerified: result.status === 'match',
        },
    });
    rt.state.repos.runs.agentNotice = verificationNotice(result);
    refresh(rt);
}

/**
 * Post the read-back to the service's trail, and say so when it refuses.
 *
 * The report is warn-only on both sides: the route changes no run state, and
 * a refusal here lands as the section's note rather than as a silent gap —
 * FR-063's rule for a lifecycle row that did not reach the trail (FR-043,
 * contract §5).
 *
 * @param input - Runtime, the run, the attempt, the session, and its outcome.
 */
async function postReadBack(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The run the read-back belongs to. */
    readonly correlationId: string;
    /** Attempt the dispatch belongs to; the report echoes it. */
    readonly attempt: number;
    /** Session the read-back observed. */
    readonly sessionId: string;
    /** Outcome the verification reached. */
    readonly result: AgentVerification;
    /** Baseline the judgment used. */
    readonly expected: string;
}): Promise<void> {
    const { rt, correlationId, attempt, sessionId, result, expected } = input;
    const observedAgent = result.status === 'match' || result.status === 'mismatch' ? result.agent : null;
    const posted = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: verificationPath(correlationId),
        body: JSON.stringify({
            correlationId,
            attempt,
            sessionId,
            observedAgent,
            expectedAgent: expected,
            ok: result.status === 'match',
            note: readBackNote(result),
        }),
    });
    if (posted.ok || rt.disposed) {
        return;
    }

    rt.state.repos.runs.note = redact(
        `The service could not record the agent read-back for ${correlationId}: `
        + `${posted.message ?? posted.problem}.`,
    );
    refresh(rt);
}

/**
 * Verify the agent of one dispatched session and record what was seen (M9).
 *
 * Runs after the dispatch result has reached the service, so a slow or
 * failing verification can never delay (or lose) the run's own record. The
 * outcome lands three places: as a `session` ledger entry correlated to the
 * run, as the runs-area banner, and — since 003 T-027 — as the service's own
 * `agent.verified` / `agent.mismatch` row behind `POST …/verification`, which
 * is warn-only by construction (the route never changes run state).
 *
 * The relay starts this **detached from its tick** and tracks it on
 * {@link PanelRuntime.pendingVerifications}: the read-back keeps its own
 * {@link AGENT_VERIFY_TIMEOUT_MS} budget, and a host that answers slowly must
 * never hold the claim slot while it waits (AC-125). This function therefore
 * never rejects — a failure lands as the visible warning, never as an
 * unhandled rejection the relay would never see.
 *
 * @param inputs - Runtime, the run's correlation id, its attempt, and the
 *   created session id.
 */
export async function verifyAgentAfterDispatch(inputs: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The run whose dispatch produced the session (003: the correlation id). */
    readonly correlationId: string;
    /** Attempt the dispatch belongs to; the report echoes it (contract §5). */
    readonly attempt: number;
    /** Session id the host created. */
    readonly sessionId: string;
}): Promise<void> {
    const { rt, correlationId, attempt, sessionId } = inputs;
    try {
        const expected = rt.state.expectedAgent;
        const result = await verifySessionAgent({ host: rt.host, sessionId, expected });
        if (rt.disposed) {
            return;
        }

        recordReadBack({ rt, correlationId, sessionId, result, expected });
        await postReadBack({ rt, correlationId, attempt, sessionId, result, expected });
    } catch (cause) {
        if (rt.disposed) {
            return;
        }

        rt.state.repos.runs.agentNotice = {
            tone: 'warning',
            title: 'Session agent not verified',
            body: `The read-back could not be recorded: ${redact(describeError(cause))}. `
                + 'Warning only — the session keeps running, nothing was blocked.',
        };
        refresh(rt);
    }
}

/**
 * Wait for every read-back this mount started but has not seen settle.
 *
 * The relay never awaits these (AC-125), so a test that asserts what a
 * verification wrote drains them instead of racing the host.
 *
 * @param rt - Panel runtime.
 */
export async function drainVerifications(rt: PanelRuntime): Promise<void> {
    while (rt.pendingVerifications.length > 0) {
        await Promise.all(rt.pendingVerifications.splice(0));
    }
}
