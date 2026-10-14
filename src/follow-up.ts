/**
 * Following up on a work item the agent is in: delivered by `host.prompt({ send: true })`, starting no session.
 * Anchors: `start_work` judged with no approval gate (FR-027); no delivery mid-dispatch (R14.5); constitution VII.
 */

import type { PromptRequest, PromptResult, SessionLifecycleEvent, SessionSnapshot } from '@openchamber/sdk';
import { appendEntryAndPersist } from './panel-actions.ts';
import { loadDispatchRecord, recordFollowUpDelivery } from './dispatch-record.ts';
import type { DispatchRecordDocument, FollowUpDeliveryRecord, FollowUpFailure } from './dispatch-record.ts';
import { parseDispatchListBody } from './dispatches-list.ts';
import type { RunFollowUp, RunRow, PlainRunState } from './dispatches-service.ts';
import type { LedgerDetail } from './ledger.ts';
import { nowIso } from './ids.ts';
import { MAX_PAGE_SIZE } from './dispatch-page.ts';
import type { PanelRuntime } from './panel-state.ts';
import { parseJsonObject } from './json.ts';
import { budgetFloorProblem } from './relay-attempt.ts';
import { CONFIG_PATH, EVENTS_PATH, serviceGet } from './service-calls.ts';
import type { ServiceRequester } from './service-calls.ts';
import { renderBoundedContext } from './session.ts';
import type { ContextSource } from './session.ts';
import { defuseDelimiters } from './context-blocks.ts';
import { stillRunning } from './relay-gates.ts';

const FOLLOW_UP_LEDGER_KIND = 'session';

/**
 * The retry ladder a follow-up delivery runs under: the service's **existing**
 * configuration read for each delivery, never a second ladder with a second
 * meaning (002 FR-105) — an unreadable document falls back to the documented
 * defaults, so it can become neither no retries nor an unbounded wait.
 */
export interface FollowUpRetryPolicy {
    /** Total attempts, the first included. */
    readonly maxAttempts: number;
    readonly baseMs: number;
    readonly maxMs: number;
}

const DEFAULT_RETRY_POLICY: FollowUpRetryPolicy = {
    maxAttempts: 5,
    baseMs: 5_000,
    maxMs: 60_000,
};

/**
 * Read one retry knob, refusing anything that is not a positive integer: the
 * bounds are the **service's**, validated where the field is written, and a
 * second spelling of one bound is a second thing to keep in agreement (006
 * AC-106) — this reader decides about *reading*, never *writing*.
 */
function retryKnob(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Read the retry ladder out of a `GET /v1/config` answer. */
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

/** Read the retry ladder the service declares; never rejects. */
export async function readFollowUpRetryPolicy(serviceRequest: ServiceRequester): Promise<FollowUpRetryPolicy> {
    const answer = await serviceGet({ serviceRequest, path: CONFIG_PATH });

    return answer.ok ? retryPolicyFromConfig(answer.body) : DEFAULT_RETRY_POLICY;
}

/** The backoff before one attempt, doubling and capped by the ladder's ceiling. */
export function followUpBackoffMs(policy: FollowUpRetryPolicy, attempt: number): number {
    const grown = policy.baseMs * 2 ** Math.max(attempt - 1, 0);

    return Math.min(grown, policy.maxMs);
}

export interface FollowUpAttempt {
    readonly deliveryId: string;
    /** Attempts this delivery has used, the first included. */
    readonly attempt: number;
    readonly delivered: boolean;
    readonly reason: FollowUpFailure | null;
    /** `true` once the follow-up is parked out of automatic handling. */
    readonly parked: boolean;
    /** Epoch milliseconds the next attempt may be made at; `null` when it may go now. */
    readonly nextAttemptAtMs: number | null;
}

function hostErrorCode(cause: unknown): string | null {
    if (typeof cause !== 'object' || cause === null) {
        return null;
    }

    const { code } = cause as { code?: unknown };

    return typeof code === 'string' ? code : null;
}

/** How one refusal ends: the ladder's one retryable class, a terminal park, or the waiting state. */
export type RefusalEnding = 'retry' | 'park' | 'wait';

/** What a settled-but-unsent prompt answer means: the cause word and how the attempt ends. */
export interface FollowUpRefusal {
    readonly reason: FollowUpFailure;
    readonly ending: RefusalEnding;
}

const WAITING_REASON: FollowUpFailure = 'session-busy';
const HOST_REFUSAL_REASON: FollowUpFailure = 'host-unavailable';

function classifyPromptAnswer(sent: PromptResult['sent']): FollowUpRefusal {
    // `skipped` is the raced-busy settlement: observed, waiting, never parked.
    return sent === 'skipped'
        ? { reason: WAITING_REASON, ending: 'wait' }
        : { reason: HOST_REFUSAL_REASON, ending: 'retry' };
}

/** Host codes the bounded ladder retries: the transient host-error class, and nothing else. */
const TRANSIENT_HOST_CODES: ReadonlySet<string> = new Set(['HOST_UNAVAILABLE', 'HOST_TIMEOUT', 'HOST_REJECTED']);

/**
 * Classify one rejected or timed-out prompt: the ending is separate from the
 * word — only a transient host error retries, `SESSION_BUSY` is the waiting
 * state, every other stop is terminal at once (FR-105).
 */
export function classifyHostError(cause: unknown): FollowUpRefusal {
    const code = hostErrorCode(cause);
    if (code === null) {
        // No code at all is a transport failure: the transient class.
        return { reason: HOST_REFUSAL_REASON, ending: 'retry' };
    }

    if (code === 'NO_SESSION') {
        return { reason: 'no-session', ending: 'park' };
    }

    if (code === 'SESSION_BUSY') {
        return { reason: WAITING_REASON, ending: 'wait' };
    }

    return { reason: HOST_REFUSAL_REASON, ending: TRANSIENT_HOST_CODES.has(code) ? 'retry' : 'park' };
}

function retryAfter(input: {
    readonly attempt: number;
    readonly policy: FollowUpRetryPolicy;
}): { readonly parked: boolean; readonly nextAttemptAtMs: number | null } {
    return input.attempt >= input.policy.maxAttempts
        ? { parked: true, nextAttemptAtMs: null }
        : { parked: false, nextAttemptAtMs: followUpBackoffMs(input.policy, input.attempt) };
}

/** The session the host is showing, replayed by {@link trackCurrentSession}; costs no host call. */
export function currentSessionIdOf(rt: PanelRuntime): string | null {
    return rt.state.relay.currentSessionId;
}

/**
 * Track the host's current session — and whether it is busy — for as long as
 * the relay runs; its `busy` member is an idle fact exactly when `false`
 * (`ready.session` reaches this listener through the bridge's replay) (FR-104).
 */
export function trackCurrentSession(rt: PanelRuntime): () => void {
    return rt.host.onSession((snapshot: SessionSnapshot | null) => {
        rt.state.relay.currentSessionId = snapshot?.id ?? null;
        rt.state.relay.currentSessionBusy = snapshot === null ? null : snapshot.busy;
    });
}

/**
 * Track the current session's lifecycle, and poke one immediate poll on an
 * idle transition: `completed` marks idle, `started` busy, `failure` neither
 * (delivery fails closed on the unknown). The poke runs through the relay
 * tick's own in-flight/busy guards, so no second timer exists (plan.md 1/3);
 * an event for any other session is ignored.
 */
export function trackSessionLifecycle(rt: PanelRuntime, onIdle: () => void): () => void {
    return rt.host.onSessionLifecycle((event: SessionLifecycleEvent) => {
        if (event.sessionId !== rt.state.relay.currentSessionId || rt.disposed) {
            return;
        }

        if (event.phase === 'failure') {
            rt.state.relay.currentSessionBusy = null;

            return;
        }

        rt.state.relay.currentSessionBusy = event.phase === 'completed' ? false : true;
        if (event.phase === 'completed' && (rt.state.relay.waitingFollowUps ?? 0) > 0) {
            onIdle();
        }
    });
}

/**
 * The delivery gate's one question (FR-104): is the target the session the
 * host is showing, **observed idle**? Idle is observed, never assumed.
 */
export function targetIsCurrentAndIdle(rt: PanelRuntime, sessionId: string): boolean {
    return currentSessionIdOf(rt) === sessionId && rt.state.relay.currentSessionBusy === false;
}

/** Page size the relay's follow-up read asks for: the route's largest (005 contract §1). */
const FOLLOW_UP_PAGE_LIMIT = MAX_PAGE_SIZE;

/**
 * How many pages one walk reads before it keeps what it has and stops: ten
 * pages of the largest page size covers the store twice over, and the guard
 * exists for the answer that is *not* conforming — a `hasMore` that never
 * clears — so a pathological read cannot spin the relay's tick.
 */
const FOLLOW_UP_PAGE_GUARD = 10;

/**
 * The state a run must carry for a follow-up to have a session to ride into: a
 * run with a recorded session is `dispatched` and nothing else (FR-100 opens
 * the next ordinal for a `dead-lettered` run), so filtering keeps each page
 * dense rather than spending pages on runs that can never carry one.
 */
const DELIVERABLE_RUN_STATE: PlainRunState = 'dispatched';

/**
 * Where the relay's read opens the follow-up window: past everything this panel has settled, never
 * past a follow-up it still owes. The record is the **only** party that knows a delivery happened
 * (FR-104) and the list is oldest-first by last write, so keeping the last delivered entry opens
 * at the most recent settlement. The scan stops at the first owed record and opens *at* it — early
 * costs a denser page, late strands the follow-up for good — and a parked record is not owed
 * (FR-105), so it does not stop the walk.
 */
export function followUpWindowOpening(document: DispatchRecordDocument): string | null {
    const records = document.followUps ?? [];
    let newest: string | null = null;
    for (const record of records) {
        if (record.delivered) {
            newest = record.deliveryId;
        } else if (!record.parked) {
            // Owed: open at it, so the read's bound cannot put it out of range.
            newest = record.deliveryId;
            break;
        }
    }

    return newest;
}

/**
 * Where the relay's read should open the window, or `null` for the start: an
 * unreadable record answers no parameter rather than a guessed position —
 * walking past an unsent follow-up risks a duplicate prompt, the failure
 * NFR-002 exists to prevent — and reading from the start always projects
 * **more** of the run's movements, never fewer.
 */
async function followUpWindowAdvance(rt: PanelRuntime): Promise<string | null> {
    const read = await loadDispatchRecord(rt);

    return read.ok ? followUpWindowOpening(read.document) : null;
}

/**
 * The path of one page of the relay's own runs view: the route's documented
 * `state` and `limit` filters, plus its own cursor mid-set and the window's
 * opening when the panel has already delivered something — no parameter the
 * contract does not already define.
 */
function followUpRowsPath(cursor: string | null, followUpsFrom: string | null): string {
    const params = [`state=${DELIVERABLE_RUN_STATE}`, `limit=${FOLLOW_UP_PAGE_LIMIT}`];
    if (cursor !== null) {
        params.push(`cursor=${encodeURIComponent(cursor)}`);
    }

    if (followUpsFrom !== null) {
        params.push(`followUpsFrom=${encodeURIComponent(followUpsFrom)}`);
    }

    return `${EVENTS_PATH}?${params.join('&')}`;
}

/**
 * Read the relay's own view of the runs a follow-up can ride, on its own clock —
 * never the operator's paged, filtered list, which would let a page position or
 * a navigation decide what gets delivered. A refused or unreadable page keeps
 * the last good view (a stale row makes a delivery *late*; only the durable
 * record makes one *duplicate*), the walk is bounded
 * ({@link FOLLOW_UP_PAGE_GUARD}), and the window advances with the record.
 */
export async function readFollowUpRows(rt: PanelRuntime): Promise<void> {
    const rows: RunRow[] = [];
    const advance = await followUpWindowAdvance(rt);
    let cursor: string | null = null;
    for (let page = 0; page < FOLLOW_UP_PAGE_GUARD; page += 1) {
        const fetched = await serviceGet({
            serviceRequest: rt.host.serviceRequest,
            path: followUpRowsPath(cursor, advance),
        });
        if (!fetched.ok || !stillRunning(rt)) {
            rt.state.relay.lastError = 'the relay could not read the runs a follow-up could ride; the last good view'
                + ' was kept';

            return;
        }

        const answer = parseDispatchListBody(fetched.body);
        if (answer === null) {
            // Fail closed on the *read*: an unparsable page is not acted on; the
            // previous view stands rather than a half-read one.
            rt.state.relay.lastError = 'the service answered a runs page the panel could not read; the last good view'
                + ' was kept';

            return;
        }

        rows.push(...answer.rows);
        if (!answer.page.hasMore || answer.page.nextCursor === null) {
            break;
        }

        cursor = answer.page.nextCursor;
    }

    rt.state.relay.followUpRows = rows;
    rt.state.relay.lastError = '';
}

/**
 * Compose the bounded, delimited message one follow-up delivers: the dispatch's
 * own frame builder — same untrusted-source markers, same running budget, single
 * implementation of both — under the **follow-up's own header**, never the
 * dispatch's, which would tell the agent it had been dispatched anew from an
 * assignment and put a false policy statement in text it reads.
 */
export function followUpMessage(input: {
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
}): string {
    const { row, followUp } = input;
    const { fromHeadSha, headSha, kind, excerpt, sourceUrl, actorLogin, detectedAt } = followUp;
    // The frame rides **above** the untrusted block, so every scalar interpolated
    // into it is defused — the title and URL, the actor login, the head pair, the
    // stamps, the correlation id, the repository, the session id — because a
    // forged marker in any one of them is the same hole with a different field
    // name. The frame is the boundary being defended here, not the store's own
    // constraints.
    const from = defuseDelimiters(fromHeadSha ?? 'an unrecorded head');
    const to = defuseDelimiters(headSha ?? 'an unrecorded head');
    const movement = kind === 'head' ? `Head moved from ${from} to ${to}` : 'New comment';
    const observedAt = defuseDelimiters(detectedAt);
    const correlationId = defuseDelimiters(row.correlationId);
    const repository = defuseDelimiters(row.repository);
    const sessionId = defuseDelimiters(row.session?.sessionId ?? 'unknown');
    const header = [
        'Mecha Turk follow-up (automated — continuing a work item Mecha Turk already started).',
        `Correlation: ${correlationId}`,
        `Repository: ${repository}`,
        `Issue #${row.issueNumber}: ${defuseDelimiters(row.issueTitle)}`,
        `URL: ${defuseDelimiters(sourceUrl)}`,
        `Session: ${sessionId}`,
        `Movement: ${movement}`,
        `Observed by: ${defuseDelimiters(actorLogin)} at ${observedAt}`,
        'Rule: this is the same work item the session was started for; reply inside this session.',
    ];
    const sources: readonly ContextSource[] = [{
        origin: kind === 'head' ? 'review' : 'comment',
        kind: row.kind,
        detectedAt,
        url: sourceUrl,
        excerpt,
    }];

    // The follow-up frame is the context's own header, so the excerpt is what
    // shortens when the two together would exceed the bound — and the whole
    // composition is still measured against the budget floor before any host
    // call.
    return renderBoundedContext({
        header,
        issue: {
            issueNumber: row.issueNumber,
            title: row.issueTitle,
            url: sourceUrl,
            state: 'open',
            body: null,
            assignees: [],
            isPullRequest: row.kind === 'review',
        },
        sources,
    });
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

/** What the host answered one `prompt({ send: true })` with. */
type PromptVerdict =
    | { readonly wasSent: true }
    | { readonly wasSent: false; readonly refusal: FollowUpRefusal };

/** Send the composed message; never throws. */
async function sendPrompt(rt: PanelRuntime, message: string): Promise<PromptVerdict> {
    try {
        const answer = await rt.host.prompt({ text: message, send: true } satisfies PromptRequest);

        return answer.sent === 'sent'
            ? { wasSent: true }
            : { wasSent: false, refusal: classifyPromptAnswer(answer.sent) };
    } catch (cause) {
        return { wasSent: false, refusal: classifyHostError(cause) };
    }
}

interface DeliveryArms {
    readonly settle: (outcome: Omit<FollowUpAttempt, 'deliveryId'>) => Promise<FollowUpAttempt>;
    readonly park: (reason: FollowUpFailure) => Promise<FollowUpAttempt>;
    readonly wait: () => Promise<FollowUpAttempt>;
}

/**
 * Build the arms one attempt settles with. Every terminal arm writes, even
 * before any host call: a record that never learns of an attempt is
 * re-offered forever and never parks (FR-105); the waiting state is the
 * exception — one write on the transition, none after (FR-104).
 */
function deliveryArms(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly sessionId: string | null;
    /** The ladder attempt number this try would consume, the first included. */
    readonly attempt: number;
    readonly existing: FollowUpDeliveryRecord | null;
}): DeliveryArms {
    const { rt, row, followUp, sessionId, attempt, existing } = input;
    // A rungless outcome keeps the attempt the record already holds (AC-051).
    const heldAttempt = Math.max(attempt - 1, 1);
    const settle: DeliveryArms['settle'] = async (outcome) => {
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
        const settled: FollowUpAttempt = { deliveryId: followUp.deliveryId, ...outcome };
        recordAttempt({ rt, row, followUp, attempt: settled });

        return settled;
    };

    return {
        settle,
        park: (reason) =>
            settle({ attempt: heldAttempt, delivered: false, reason, parked: true, nextAttemptAtMs: null }),
        wait: async () => {
            const outcome: Omit<FollowUpAttempt, 'deliveryId'> = {
                attempt: heldAttempt,
                delivered: false,
                reason: WAITING_REASON,
                parked: false,
                nextAttemptAtMs: null,
            };
            // Re-offered every tick: the transition is the only movement, written once.
            if (existing !== null && existing.reason === WAITING_REASON && !existing.parked && !existing.delivered) {
                return { deliveryId: followUp.deliveryId, ...outcome };
            }

            return await settle(outcome);
        },
    };
}

async function settleVerdict(input: {
    readonly verdict: PromptVerdict;
    readonly arms: DeliveryArms;
    readonly attempt: number;
    readonly policy: FollowUpRetryPolicy;
}): Promise<FollowUpAttempt> {
    const { verdict, arms, attempt, policy } = input;
    if (verdict.wasSent) {
        return await arms.settle({ attempt, delivered: true, reason: null, parked: false, nextAttemptAtMs: null });
    }

    if (verdict.refusal.ending === 'wait') {
        return await arms.wait();
    }

    if (verdict.refusal.ending === 'park') {
        return await arms.park(verdict.refusal.reason);
    }

    return await arms.settle({
        attempt,
        delivered: false,
        reason: verdict.refusal.reason,
        ...retryAfter({ attempt, policy }),
    });
}

/**
 * The B+ gate's verdict for an attempt whose target cannot be prompted now: a
 * retry that finds the target no longer current stops `navigation-refused`
 * (under B+ there is no navigation left to refuse); else the waiting state.
 */
function waitingOrRefused(input: {
    readonly rt: PanelRuntime;
    readonly sessionId: string;
    readonly record: FollowUpDeliveryRecord | null;
}): 'wait' | 'navigation-refused' {
    const isRetry = input.record?.reason === HOST_REFUSAL_REASON;
    const isAnotherSession = currentSessionIdOf(input.rt) !== input.sessionId;

    return isRetry && isAnotherSession ? 'navigation-refused' : 'wait';
}

/**
 * Run one follow-up delivery attempt end to end; never throws. The gate runs
 * immediately before the prompt and the composition is measured before any
 * host call (FR-104). Under B+ no path calls `host.openSession` — a target
 * that is not current waits, it never navigates.
 */
export async function deliverFollowUp(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    /** The ladder attempt number this try would consume, the first included. */
    readonly attempt: number;
    readonly policy: FollowUpRetryPolicy;
    /** The record the relay last read for this delivery, or `null` when it has none. */
    readonly record?: FollowUpDeliveryRecord | null;
}): Promise<FollowUpAttempt> {
    const { rt, row, followUp, attempt, policy } = input;
    const sessionId = row.session?.sessionId ?? null;
    const arms = deliveryArms({ rt, row, followUp, sessionId, attempt, existing: input.record ?? null });

    // No recorded session means nothing to deliver into; it parks at once (FR-105).
    if (sessionId === null || sessionId === '') {
        return await arms.park('no-session');
    }

    if (!targetIsCurrentAndIdle(rt, sessionId)) {
        const ending = waitingOrRefused({ rt, sessionId, record: input.record ?? null });

        return ending === 'wait' ? await arms.wait() : await arms.park(ending);
    }

    const message = followUpMessage({ row, followUp });
    if (budgetFloorProblem({ composed: message, sources: row.promptSources }) !== null) {
        // Measured before any host call (FR-104); a guard that cannot park is
        // not a guard, so this composition path parks at once (FR-105).
        return await arms.park('over-budget');
    }

    return await settleVerdict({ verdict: await sendPrompt(rt, message), arms, attempt, policy });
}

export function isFollowUpDue(record: FollowUpDeliveryRecord, atMs: number): boolean {
    return record.nextAttemptAtMs === null || record.nextAttemptAtMs <= atMs;
}
