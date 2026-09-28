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
 * Nothing here stops the session, blocks the event, or touches the service
 * (MVP-DEBT: the service learns nothing about verification in this slice —
 * mirroring `agentVerified` service-side is next slice's work).
 */

import type { SessionSnapshot } from '@openchamber/sdk';
import { nowIso } from './ids.ts';
import { appendEntryAndPersist } from './panel-actions.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { describeError } from './session.ts';
import type { SpikeHost } from './session.ts';
import type { PanelRuntime, PanelStatus } from './panel-state.ts';
import type { RelayEvent } from './repos-service.ts';

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
 * Verify the agent of one dispatched session and record what was seen (M9).
 *
 * Runs after the dispatch result has reached the service, so a slow or
 * failing verification can never delay (or lose) the run's own record. The
 * outcome lands twice: as a `session` ledger entry correlated to the event
 * (`agentVerified`, the observed agent, and the machine status), and as the
 * runs-area banner. Waits up to {@link AGENT_VERIFY_TIMEOUT_MS} while the
 * relay holds its dispatch slot — MVP-DEBT: verification shares that slot
 * today; running it alongside the next event is post-MVP work.
 *
 * @param inputs - Runtime, the claimed event, and the created session id.
 */
export async function verifyAgentAfterDispatch(inputs: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The event whose dispatch produced the session. */
    readonly event: RelayEvent;
    /** Session id the host created. */
    readonly sessionId: string;
}): Promise<void> {
    const { rt, event, sessionId } = inputs;
    const expected = rt.state.expectedAgent;
    const result = await verifySessionAgent({ host: rt.host, sessionId, expected });
    if (rt.disposed) {
        return;
    }

    const observedAgent = result.status === 'match' || result.status === 'mismatch' ? result.agent : null;
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: 'session',
        correlationId: event.eventId,
        detail: {
            eventId: event.eventId,
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
