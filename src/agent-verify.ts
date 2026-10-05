/**
 * Post-dispatch agent verification — warn, never block.
 *
 * The platform owns which agent runs a session: `startSession` carries no
 * agent field at SDK 1.24.2 and the panel cannot write Settings → Sessions →
 * Session Defaults, so the only documented read-back is
 * `onSession().agent` on the *attached* surface (verified
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
 * else lands as a warning banner in the dispatches area plus a ledger entry.
 * Nothing here stops the session or blocks the event. The read-back is also
 * **posted to the service** — `POST …/verification`, contract
 * §5 — which writes `agent.verified` / `agent.mismatch` / `agent.uncompared`
 * on the run and stores `run.verification` for the run-history projection,
 * **changing no state**: the panel-side record and the service-side trail say
 * the same thing, and a report the service refuses surfaces as a visible
 * warning rather than as a silent gap.
 *
 * The comparison baseline is **the service's**, not the manifest's: the
 * integration card no longer carries one, so `readVerificationBaseline` takes
 * it from `GET /v1/config`'s `expectedAgent` per verification, with the
 * provenance split kept intact — an observed agent that differs from a
 * **configured**
 * baseline (or cannot be read) still warns as before, while a baseline that is
 * blank or unreadable means **there is nothing to compare against**: the
 * read-back still records the observed agent, its provenance reads
 * `unset`/`defaulted`, and no mismatch is claimed from an absence.
 *
 * The documented default is the **empty string** (product-owner order,
 * 2026-10-01: *"Default Agent pin should default to blank, not everyone is
 * going to use project-manager"*), so a fresh installation compares nothing
 * until an operator pins a baseline of their own.
 */

import type { SessionSnapshot } from '@openchamber/sdk';
import { readBackNote, verificationNotice } from './agent-verify-copy.ts';
import { DEFAULT_EXPECTED_AGENT } from './config.ts';
import { nowIso } from './ids.ts';
import { parseJsonObject } from './json.ts';
import { appendEntryAndPersist } from './panel-actions.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { CONFIG_PATH, serviceGet, servicePost, verificationPath } from './service-calls.ts';
import type { ServiceRequester } from './service-calls.ts';
import { describeError } from './session.ts';
import type { PanelHost } from './session.ts';
import type { PanelRuntime } from './panel-state.ts';

/** How long one verification waits for the session snapshot, in milliseconds. */
export const AGENT_VERIFY_TIMEOUT_MS = 15_000;

/**
 * Which baseline a verification judged against.
 *
 * The distinction is recorded so a result months later is explainable: one
 * decided against the operator's own configuration says so, one that had
 * nothing to compare against says **why** it had nothing — the document was
 * never read, or it was read and the value is blank. Nothing here names an
 * agent the operator never chose.
 */
export type BaselineProvenance =
    /** `GET /v1/config` carried a parseable, non-blank `expectedAgent`. */
    | 'configured'
    /** The document could not be read; the documented (blank) default is in force. */
    | 'defaulted'
    /** The document was read and its `expectedAgent` is blank: no baseline configured. */
    | 'unset';

/** One verification's comparison baseline and where it came from. */
export interface VerificationBaseline {
    /** Agent the observed session is judged against; `""` when there is none. */
    readonly agent: string;
    /** Whether the service configured this baseline, or why it is absent. */
    readonly provenance: BaselineProvenance;
}

/**
 * The documented default — the empty string — as a *defaulted* baseline.
 *
 * A service that cannot be reached, a document written
 * before the field existed, and a value that fails to parse all land here —
 * the run **proceeds to verification** with `agent: ''`, which the caller
 * reads as *no comparison is possible* rather than as a name to compare with.
 */
const DEFAULTED_BASELINE: VerificationBaseline = {
    agent: DEFAULT_EXPECTED_AGENT,
    provenance: 'defaulted',
};

/**
 * Read one baseline out of a `GET /v1/config` answer, fail closed.
 *
 * Every shape the document could take that is not a string member reads as
 * *defaulted*; a string member that is blank after trimming reads as *unset* —
 * the operator's own statement that no baseline is configured. Nothing is
 * coerced and nothing is guessed, and neither absence is dressed up as a name.
 *
 * @param body - Response body text (unchecked).
 * @returns The configured baseline, or an absent one with the reason it is absent.
 */
function baselineFromConfig(body: string): VerificationBaseline {
    const root = parseJsonObject(body);
    const config: unknown = root === null ? undefined : root.config;
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return DEFAULTED_BASELINE;
    }

    const raw: unknown = (config as Record<string, unknown>).expectedAgent;
    if (typeof raw !== 'string') {
        return DEFAULTED_BASELINE;
    }

    const trimmed = raw.trim();
    if (trimmed === '') {
        return { agent: '', provenance: 'unset' };
    }

    return { agent: trimmed, provenance: 'configured' };
}

/**
 * Read the agent-verification baseline from the service.
 *
 * One `GET /v1/config` per verification — the baseline is read fresh each
 * time so a value saved after a dispatch is in force for the next one, with
 * no restart and no service-side consumer. A transport failure, a non-2xx
 * answer, and an unparseable document all answer the documented (blank)
 * default with `provenance: 'defaulted'`; this function never rejects.
 *
 * @param serviceRequest - The host's service bridge.
 * @returns The baseline to judge this dispatch against, and its provenance.
 */
export async function readVerificationBaseline(serviceRequest: ServiceRequester): Promise<VerificationBaseline> {
    const answer = await serviceGet({ serviceRequest, path: CONFIG_PATH });

    return answer.ok ? baselineFromConfig(answer.body) : DEFAULTED_BASELINE;
}

/**
 * Whether the runtime has been torn down.
 *
 * A function call rather than a bare `rt.disposed` read, for the same reason
 * `src/app.ts` spells it this way: the analyzer narrows that property across
 * the first `await` and then reports a second direct check as unreachable,
 * while the frame really can go away between two awaits — and carrying on
 * would subscribe to a host a disposed panel no longer owns.
 *
 * @returns `true` once the mount has been torn down.
 */
function tornDown(rt: PanelRuntime): boolean {
    return rt.disposed;
}

/** Outcome of one post-dispatch agent read-back. */
export type AgentVerification =
    /** The session reported the expected agent. */
    | { readonly status: 'match'; readonly agent: string; readonly expected: string }
    /** The session reported another agent, or none at all. */
    | { readonly status: 'mismatch'; readonly agent: string | null; readonly expected: string }
    /** No baseline to judge against: the agent was read back and **not compared**. */
    | { readonly status: 'uncompared'; readonly agent: string | null; readonly expected: '' }
    /** No snapshot for this session arrived inside the timeout. */
    | { readonly status: 'timeout'; readonly expected: string; readonly timeoutMs: number }
    /** The session could not be opened at all; the problem is redacted. */
    | { readonly status: 'unavailable'; readonly expected: string; readonly problem: string };

/** Inputs for {@link verifySessionAgent}. */
export interface VerifyAgentInputs {
    /** Host surface the read-back goes through. */
    readonly host: Pick<PanelHost, 'onSession' | 'openSession'>;
    /** Session the dispatch just created. */
    readonly sessionId: string;
    /** Agent the run is expected to report. */
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
 * An empty `expected` is the other special case, and it is the *opposite* of
 * a pass: there is no baseline, so there is nothing to be right or wrong
 * about. The agent is still reported — an observation is evidence whether or
 * not anyone configured a comparison — but the outcome is `uncompared`.
 *
 * @param input - The snapshot (or `null` on timeout), the expected agent,
 *   and the budget the caller waited with, for the timeout copy.
 * @returns The verification outcome.
 */
function judgeSnapshot(input: {
    /** Snapshot for the requested session, or `null` when the budget ran out. */
    readonly snapshot: SessionSnapshot | null;
    /** Agent the run should report; `""` when no baseline is configured. */
    readonly expected: string;
    /** Budget the caller waited with. */
    readonly timeoutMs: number;
}): AgentVerification {
    const { snapshot, expected, timeoutMs } = input;
    if (snapshot === null) {
        return { status: 'timeout', expected, timeoutMs };
    }

    const agent = snapshot.agent ?? null;

    if (expected === '') {
        return { status: 'uncompared', agent, expected };
    }

    if (agent === null || agent !== expected) {
        return { status: 'mismatch', agent, expected };
    }

    return { status: 'match', agent, expected };
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
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- ES2024; the guest runtime is promised ES2022.
    const observed = new Promise<SessionSnapshot | null>((resolve) => {
        settle = resolve;
    });
    const unsubscribe = host.onSession((snapshot) => {
        if (settle !== null && snapshot?.id === sessionId) {
            settle(snapshot);
        }
    });

    // The deadline starts before the context switch, so one timer bounds the
    // entire verification rather than only the snapshot wait.
    const timer = setTimeout(() => settle?.(null), timeoutMs);
    const opened = host.openSession(sessionId)
        .then(() => ({ kind: 'opened' } as const))
        .catch((cause: unknown) => ({ kind: 'failed' as const, problem: describeError(cause) }));
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
 * The agent one outcome actually observed, or `null` when there was none.
 *
 * `uncompared` counts as an observation: with no baseline the read-back still
 * reports what the session said, because an observation is evidence whether or
 * not anyone configured a comparison. The two failure
 * outcomes carry no `agent` member at all and answer `null` — nothing was
 * observed, only a reason it was not.
 *
 * @returns The observed agent, or `null`.
 */
function observedAgentOf(result: AgentVerification): string | null {
    return 'agent' in result ? result.agent : null;
}

/** Record the read-back where the operator looks: ledger entry and banner. */
function recordReadBack(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The run the read-back belongs to. */
    readonly correlationId: string;
    /** Session the read-back observed. */
    readonly sessionId: string;
    /** Outcome the verification reached. */
    readonly result: AgentVerification;
    /** Baseline the judgment used; `""` when there is none. */
    readonly expected: string;
    /** Where that baseline came from: `configured`, `defaulted`, or `unset`. */
    readonly provenance: BaselineProvenance;
}): void {
    const { rt, correlationId, sessionId, result, expected, provenance } = input;
    const observedAgent = observedAgentOf(result);
    appendEntryAndPersist(rt, {
        at: nowIso(),
        kind: 'session',
        correlationId,
        detail: {
            correlationId,
            sessionId,
            expectedAgent: expected,
            baselineProvenance: provenance,
            observedAgent,
            verification: result.status,
            agentVerified: result.status === 'match',
        },
    });
    rt.state.dispatches.agentNotice = verificationNotice(result);
    refresh(rt);
}

/**
 * Post the read-back to the service's trail, and say so when it refuses.
 *
 * The report is warn-only on both sides: the route changes no run state, and
 * a refusal here lands as the section's note rather than as a silent gap —
 * the rule for a lifecycle row that did not reach the trail.
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
    /** The baseline the judgment used, and where it came from. */
    readonly baseline: VerificationBaseline;
}): Promise<void> {
    const { rt, correlationId, attempt, sessionId, result, baseline } = input;
    const observedAgent = observedAgentOf(result);
    const posted = await servicePost({
        serviceRequest: rt.host.serviceRequest,
        path: verificationPath(correlationId),
        body: JSON.stringify({
            correlationId,
            attempt,
            sessionId,
            observedAgent,
            expectedAgent: baseline.agent,
            // The service cannot know which of the three
            // absences this is, and the `agent.uncompared` row records it — so
            // the word travels with the report instead of being guessed there.
            baselineProvenance: baseline.provenance,
            ok: result.status === 'match',
            note: readBackNote(result),
        }),
    });
    if (posted.ok || rt.disposed) {
        return;
    }

    rt.state.dispatches.note = redact(
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
 * run, as the runs-area banner, and — as the service's own
 * read-back row (`agent.verified`, `agent.mismatch`, or `agent.uncompared`)
 * behind `POST …/verification`, which is warn-only by construction (the route
 * never changes run state).
 *
 * The relay starts this **detached from its tick** and tracks it on
 * {@link PanelRuntime.pendingVerifications}: the read-back keeps its own
 * {@link AGENT_VERIFY_TIMEOUT_MS} budget, and a host that answers slowly must
 * never hold the claim slot while it waits. This function therefore
 * never rejects — a failure lands as the visible warning, never as an
 * unhandled rejection the relay would never see.
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
        // The comparison baseline comes from `GET /v1/config`'s
        // `expectedAgent`, read fresh for this verification. A missing,
        // unreadable, or explicitly blank field means **no baseline** — the
        // read-back still runs and still records what the session reported,
        // with its provenance, but nothing is compared against it. Only an
        // observed agent that differs from a configured baseline, or that
        // cannot be read, is the fail-closed condition.
        const baseline = await readVerificationBaseline(rt.host.serviceRequest);
        if (tornDown(rt)) {
            return;
        }

        const expected = baseline.agent;
        const result = await verifySessionAgent({ host: rt.host, sessionId, expected });
        if (tornDown(rt)) {
            return;
        }

        recordReadBack({
            rt,
            correlationId,
            sessionId,
            result,
            expected,
            provenance: baseline.provenance,
        });
        await postReadBack({ rt, correlationId, attempt, sessionId, result, baseline });
    } catch (cause) {
        if (rt.disposed) {
            return;
        }

        rt.state.dispatches.agentNotice = {
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
 * The relay never awaits these, so a test that asserts what a
 * verification wrote drains them instead of racing the host.
 */
export async function drainVerifications(rt: PanelRuntime): Promise<void> {
    while (rt.pendingVerifications.length > 0) {
        await Promise.all(rt.pendingVerifications.splice(0));
    }
}
