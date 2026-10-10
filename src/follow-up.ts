/**
 * Following up on a work item the agent is already in: composition,
 * navigation, delivery, and the bounded retry that parks (002 FR-104, FR-105).
 *
 * A follow-up is delivered by `host.prompt({ text, send: true })` into the
 * session the run's dispatch already created. It starts no session, joins no
 * other run, and is delivered into no other session: the service holds no host
 * bridge, so this module is the panel's half of that boundary (constitution VII).
 * The delivery is judged **exactly as `start_work` is judged under FR-027** —
 * autonomously by default — and no approval gate of its own is built.
 *
 * The order is the one `relay-attempt.ts` owes, with the one difference FR-104
 * makes a requirement:
 *
 * ```text
 * compose + measure ──▶ record the navigation intent ──▶ openSession (only when needed)
 *      ──▶ host.prompt({ text, send: true }) ──▶ record the outcome
 * ```
 *
 * The intent is written durably **before** the call, because the call moves the
 * operator's view and closes the panel. A navigation whose cause lives only in
 * memory is one the operator's next view of any surface cannot explain
 * (constitution IV), so the run's own record carries *why* the view moved.
 *
 * Three clauses the navigation owes, all of them a user-visible side effect this
 * product performs and must own:
 *
 * - **no navigation when the target is already current** — the current session is
 *   a fact the panel already receives from `onSession`, so this costs no host
 *   call and never steals focus for nothing;
 * - **the intent is recorded before it fires**;
 * - **no delivery while a dispatch attempt is in flight** — the caller's gate,
 *   because the relay already serializes one host action at a time and a second
 *   concurrent host-call path would be two schedulers for one host
 *   (research §R14.5).
 *
 * The composition reuses the dispatch's bounded excerpt renderer and frame
 * builder, with the same delimiters and preamble, so no comment text can reach
 * past them and alter policy, credentials, approval requirements, or tool scope
 * (constitution Security Standard 3). It is measured **before** any host call and
 * **refused rather than truncated** when over budget — `relay-attempt.ts`'s
 * floor, applied unchanged.
 *
 * A failed attempt retries under the ladder the service's existing retry
 * configuration already declares and, on exhaustion, **parks** with the exact
 * cause named. It never waits indefinitely for a session to become free: the
 * host owns session scheduling, and an unbounded wait is Mecha Turk
 * reimplementing the harness's own queue (FR-105, constitution VII). No new run
 * state name is minted — the reason rides the panel's own durable record beside
 * the run's session, which is the only home the run document leaves for it
 * (research §R14.2).
 */

import type { PromptRequest, PromptResult, SessionSnapshot } from '@openchamber/sdk';
import { appendEntryAndPersist } from './panel-actions.ts';
import { recordFollowUpDelivery } from './dispatch-record.ts';
import type { FollowUpDeliveryRecord, FollowUpFailure } from './dispatch-record.ts';
import type { RunFollowUp, RunRow } from './dispatches-service.ts';
import type { LedgerDetail } from './ledger.ts';
import { nowIso } from './ids.ts';
import type { PanelRuntime } from './panel-state.ts';
import { parseJsonObject } from './json.ts';
import { budgetFloorProblem } from './relay-attempt.ts';
import { CONFIG_PATH, serviceGet } from './service-calls.ts';
import type { ServiceRequester } from './service-calls.ts';
import {
    buildBoundedContext,
} from './session.ts';
import type { ContextSource } from './session.ts';

/** Ledger kind every step of this path records under — the relay's own. */
const FOLLOW_UP_LEDGER_KIND = 'session';

/**
 * The retry ladder a follow-up delivery runs under.
 *
 * The service's **existing** configuration, read for each delivery sequence
 * rather than copied into a second ladder with a second meaning (002 FR-105).
 * A document this build cannot read falls back to the service's own documented
 * defaults: an unreadable configuration must not turn into either no retries at
 * all or an unbounded wait.
 */
export interface FollowUpRetryPolicy {
    /** Total attempts, the first included. */
    readonly maxAttempts: number;
    /** First backoff, in milliseconds. */
    readonly baseMs: number;
    /** Backoff ceiling, in milliseconds. */
    readonly maxMs: number;
}

/** What an unreadable configuration document falls back to. */
const DEFAULT_RETRY_POLICY: FollowUpRetryPolicy = {
    maxAttempts: 5,
    baseMs: 5_000,
    maxMs: 60_000,
};

/**
 * Read one retry knob, refusing anything that is not a positive integer.
 *
 * The bounds themselves are the **service's** and are validated where the field
 * is written: this panel restates none of them, because a second spelling of one
 * bound is a second thing to keep in agreement (006 AC-106's rule, and the reason
 * the panel carries no configuration literal of its own). What this reader can
 * honestly do is refuse a value that is not the shape the field holds, and fall
 * back to the documented default — which is a decision about *reading*, never a
 * declaration about *writing*.
 */
function retryKnob(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Read the retry ladder out of a `GET /v1/config` answer.
 *
 * @param body - Response body text (unchecked).
 * @returns The ladder.
 */
function retryPolicyFromConfig(body: string): FollowUpRetryPolicy {
    const root = parseJsonObject(body);
    const config = root === null ? undefined : root.config;
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return DEFAULT_RETRY_POLICY;
    }

    const record = config as Record<string, unknown>;

    return {
        maxAttempts: retryKnob(record.retryMaxAttempts) ?? DEFAULT_RETRY_POLICY.maxAttempts,
        baseMs: retryKnob(record.retryBaseMs) ?? DEFAULT_RETRY_POLICY.baseMs,
        maxMs: retryKnob(record.retryMaxMs) ?? DEFAULT_RETRY_POLICY.maxMs,
    };
}

/**
 * Read the retry ladder the service declares; never rejects.
 *
 * @returns The ladder this delivery sequence runs under.
 */
export async function readFollowUpRetryPolicy(serviceRequest: ServiceRequester): Promise<FollowUpRetryPolicy> {
    const answer = await serviceGet({ serviceRequest, path: CONFIG_PATH });

    return answer.ok ? retryPolicyFromConfig(answer.body) : DEFAULT_RETRY_POLICY;
}

/**
 * The backoff before one attempt, doubling and capped by the ladder's ceiling.
 *
 * @param policy - The ladder in force.
 * @param attempt - The attempt that just failed; `1` is the first.
 * @returns The wait in milliseconds.
 */
export function followUpBackoffMs(policy: FollowUpRetryPolicy, attempt: number): number {
    const grown = policy.baseMs * 2 ** Math.max(attempt - 1, 0);

    return Math.min(grown, policy.maxMs);
}

/** What one delivery attempt produced. */
export interface FollowUpAttempt {
    /** The deterministic delivery id the attempt was for. */
    readonly deliveryId: string;
    /** Attempts this delivery has used, the first included. */
    readonly attempt: number;
    /** `true` once the host accepted the prompt. */
    readonly delivered: boolean;
    /** The exact cause, when the attempt did not deliver. */
    readonly reason: FollowUpFailure | null;
    /** `true` once the bound is spent and the follow-up is parked. */
    readonly parked: boolean;
    /** Epoch milliseconds the next attempt may be made at; `null` when it may go now. */
    readonly nextAttemptAtMs: number | null;
}

/** The host error code a rejected prompt carries, or `null` when it names none. */
function hostErrorCode(cause: unknown): string | null {
    if (typeof cause !== 'object' || cause === null) {
        return null;
    }

    const { code } = cause as { code?: unknown };

    return typeof code === 'string' ? code : null;
}

/** What a settled-but-unsent prompt answer means, in the closed failure union. */
function classifyPromptAnswer(sent: PromptResult['sent']): FollowUpFailure {
    return sent === 'skipped' ? 'session-busy' : 'host-unavailable';
}

/**
 * Classify one rejected or timed-out prompt into the closed failure union.
 *
 * A closed union rather than a free string, because the cause is what the
 * operator reads on the run row and in the trail — and because `NO_SESSION` and
 * `SESSION_BUSY` are retryable refusals while an unbounded wait is not (FR-105).
 *
 * @param cause - Whatever the host bridge rejected with.
 * @returns The cause.
 */
export function classifyHostError(cause: unknown): FollowUpFailure {
    const code = hostErrorCode(cause);
    if (code === 'NO_SESSION') {
        return 'no-session';
    }

    return code === 'SESSION_BUSY' ? 'session-busy' : 'host-unavailable';
}

/** The retry verdict for an attempt that did not deliver. */
function retryAfter(input: {
    readonly attempt: number;
    readonly policy: FollowUpRetryPolicy;
}): { readonly parked: boolean; readonly nextAttemptAtMs: number | null } {
    return input.attempt >= input.policy.maxAttempts
        ? { parked: true, nextAttemptAtMs: null }
        : { parked: false, nextAttemptAtMs: followUpBackoffMs(input.policy, input.attempt) };
}

/**
 * Read the session the host is showing, from the fact the panel already holds.
 *
 * The subscription {@link trackCurrentSession} registers replays the latest
 * value, so this is a read of something the panel already received rather than a
 * host call of its own.
 *
 * @returns The current session id, or `null` when none is open.
 */
export function currentSessionIdOf(rt: PanelRuntime): string | null {
    return rt.state.relay.currentSessionId;
}

/**
 * Track the host's current session for as long as the relay runs.
 *
 * Registered once, when the relay arms, and released on teardown with every
 * other subscription. It costs one slot in the host's subscription budget and
 * buys the one fact the delivery needs: whether the run's session is already the
 * one being shown.
 *
 * @returns The disposer the host handed back.
 */
export function trackCurrentSession(rt: PanelRuntime): () => void {
    return rt.host.onSession((snapshot: SessionSnapshot | null) => {
        rt.state.relay.currentSessionId = snapshot?.id ?? null;
    });
}

/**
 * Compose the bounded, delimited message one follow-up delivers.
 *
 * The frame is the dispatch's own machinery with a follow-up's facts: the same
 * untrusted-source preamble, the same `BEGIN_UNTRUSTED` / `END_UNTRUSTED` block,
 * the same running budget. What differs is the *frame's* prose, which says the
 * session is continuing work it already started rather than starting it.
 *
 * @returns The message, exactly as the host would receive it.
 */
export function followUpMessage(input: {
    /** The runs-history row the follow-up rides on. */
    readonly row: RunRow;
    /** The follow-up being delivered. */
    readonly followUp: RunFollowUp;
}): string {
    const { row, followUp } = input;
    const { fromHeadSha, headSha, kind, excerpt, sourceUrl, actorLogin, detectedAt } = followUp;
    const from = fromHeadSha ?? 'an unrecorded head';
    const to = headSha ?? 'an unrecorded head';
    const movement = kind === 'head' ? `Head moved from ${from} to ${to}` : 'New comment';
    const sources: readonly ContextSource[] = [{
        origin: kind === 'head' ? 'review' : 'comment',
        kind: row.kind,
        detectedAt,
        url: sourceUrl,
        excerpt,
    }];
    const frame = [
        'Mecha Turk follow-up (automated — continuing a work item Mecha Turk already started).',
        `Correlation: ${row.correlationId}`,
        `Repository: ${row.repository}`,
        `Issue #${row.issueNumber}: ${row.issueTitle}`,
        `URL: ${sourceUrl}`,
        `Session: ${row.session?.sessionId ?? 'unknown'}`,
        `Movement: ${movement}`,
        `Observed by: ${actorLogin} at ${detectedAt}`,
        'Rule: this is the same work item the session was started for; reply inside this session.',
    ].join('\n');
    const body = buildBoundedContext({
        repository: row.repository,
        issue: {
            issueNumber: row.issueNumber,
            title: row.issueTitle,
            url: sourceUrl,
            state: 'open',
            body: null,
            assignees: [],
            isPullRequest: row.kind === 'review',
        },
        // The run's own identity, never a credential: the frame already carries
        // the correlation id, and nothing here needs a GitHub login.
        authenticatedLogin: row.attachmentId,
        correlationId: row.correlationId,
        sources,
        // The follow-up frame is reserved first, exactly as the operator's prompt
        // block is, so the excerpt is what shortens when the two together would
        // exceed the bound — and the whole composition is still measured against
        // the budget floor before any host call.
        reservedChars: frame.length + 1,
    });

    return `${frame}\n${body}`;
}

/**
 * Record one delivery attempt in the ledger; credential-free by construction.
 */
function recordAttempt(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly attempt: FollowUpAttempt;
}): void {
    const detail: LedgerDetail = {
        correlationId: input.row.correlationId,
        deliveryId: input.followUp.deliveryId,
        sessionId: input.row.session?.sessionId ?? null,
        kind: input.followUp.kind,
        attempt: input.attempt.attempt,
        delivered: input.attempt.delivered,
        parked: input.attempt.parked,
        problem: input.attempt.reason,
    };

    appendEntryAndPersist(input.rt, {
        at: nowIso(),
        kind: FOLLOW_UP_LEDGER_KIND,
        correlationId: input.row.correlationId,
        detail,
    });
}

/** The durable record one navigation intent writes before `openSession` runs. */
function navigationRecord(input: {
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly sessionId: string;
    readonly attempt: number;
}): FollowUpDeliveryRecord {
    return {
        deliveryId: input.followUp.deliveryId,
        correlationId: input.row.correlationId,
        sessionId: input.sessionId,
        attempt: input.attempt,
        nextAttemptAtMs: null,
        delivered: false,
        reason: null,
        parked: false,
        updatedAt: nowIso(),
    };
}

/**
 * Move the host to the target session, recording the intent before the call.
 *
 * @returns `null` when the navigation succeeded, or the refusal that ended the
 *   attempt.
 */
async function navigateToSession(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly sessionId: string;
    readonly attempt: number;
}): Promise<FollowUpFailure | null> {
    const { rt, row, followUp, sessionId, attempt } = input;
    // Durable **before** the call: the call moves the operator's view and closes
    // the panel, and a navigation whose cause is only in memory is one no later
    // surface can explain (constitution IV).
    await recordFollowUpDelivery(rt, navigationRecord({ row, followUp, sessionId, attempt }));

    try {
        await rt.host.openSession(sessionId);
    } catch {
        return 'navigation-refused';
    }

    return null;
}

/** What the host answered one `prompt({ send: true })` with. */
interface PromptVerdict {
    /** Whether the host accepted the message. */
    readonly wasSent: boolean;
    /** The exact cause, when it did not. */
    readonly reason: FollowUpFailure | null;
}

/** Send the composed message; never throws. */
async function sendPrompt(rt: PanelRuntime, message: string): Promise<PromptVerdict> {
    try {
        const answer = await rt.host.prompt({ text: message, send: true } satisfies PromptRequest);

        return answer.sent === 'sent'
            ? { wasSent: true, reason: null }
            : { wasSent: false, reason: classifyPromptAnswer(answer.sent) };
    } catch (cause) {
        return { wasSent: false, reason: classifyHostError(cause) };
    }
}

/**
 * Run one follow-up delivery attempt end to end; never throws.
 *
 * Every refusal ends the attempt before `host.prompt()` is reachable, and the
 * composition is measured before any host call — so a session is never written
 * into with a message over the dispatch budget, and nothing is truncated to make
 * one fit.
 *
 * @returns What the attempt produced, for the record and the caller's gate.
 */
export async function deliverFollowUp(input: {
    /** Panel runtime the attempt runs on. */
    readonly rt: PanelRuntime;
    /** The runs-history row carrying the session and the follow-up. */
    readonly row: RunRow;
    /** The follow-up being delivered. */
    readonly followUp: RunFollowUp;
    /** Attempts this delivery has already used, the first included. */
    readonly attempt: number;
    /** The ladder this delivery sequence runs under. */
    readonly policy: FollowUpRetryPolicy;
}): Promise<FollowUpAttempt> {
    const { rt, row, followUp, attempt, policy } = input;
    const finish = (result: {
        readonly reason: FollowUpFailure | null;
        readonly parked: boolean;
        readonly nextAttemptAtMs: number | null;
    }): FollowUpAttempt => ({ deliveryId: followUp.deliveryId, attempt, delivered: false, ...result });
    const sessionId = row.session?.sessionId ?? null;

    // No recorded session means nothing to deliver into: the row is not a
    // follow-up's target, and a delivery must never start one.
    if (sessionId === null || sessionId === '') {
        return finish({ reason: 'no-session', parked: false, nextAttemptAtMs: null });
    }

    const message = followUpMessage({ row, followUp });
    const overBudget = budgetFloorProblem({ composed: message, sources: row.promptSources });
    if (overBudget !== null) {
        return finish({ reason: 'over-budget', ...retryAfter({ attempt, policy }) });
    }

    // The current session is a fact the panel already holds from the host's own
    // `onSession` subscription, so "is the target already current?" costs no
    // host call and a target that is already shown is navigated to zero times.
    const refused = currentSessionIdOf(rt) === sessionId
        ? null
        : await navigateToSession({ rt, row, followUp, sessionId, attempt });
    if (refused !== null) {
        return finish({ reason: refused, ...retryAfter({ attempt, policy }) });
    }

    const verdict = await sendPrompt(rt, message);
    const outcome: FollowUpAttempt = {
        deliveryId: followUp.deliveryId,
        attempt,
        delivered: verdict.wasSent,
        reason: verdict.reason,
        ...(verdict.wasSent ? { parked: false, nextAttemptAtMs: null } : retryAfter({ attempt, policy })),
    };

    await recordFollowUpDelivery(rt, {
        deliveryId: followUp.deliveryId,
        correlationId: row.correlationId,
        sessionId,
        attempt: outcome.attempt,
        nextAttemptAtMs: outcome.nextAttemptAtMs,
        delivered: outcome.delivered,
        reason: outcome.reason,
        parked: outcome.parked,
        updatedAt: nowIso(),
    });
    recordAttempt({ rt, row, followUp, attempt: outcome });

    return outcome;
}

/**
 * Whether one follow-up is due for its next attempt at a moment in time.
 *
 * @param record - The delivery's durable state.
 * @param atMs - Epoch milliseconds the tick is acting at.
 * @returns `true` when the record may go now.
 */
export function isFollowUpDue(record: FollowUpDeliveryRecord, atMs: number): boolean {
    return record.nextAttemptAtMs === null || record.nextAttemptAtMs <= atMs;
}
