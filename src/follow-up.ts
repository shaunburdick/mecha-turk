/**
 * Following up on a work item the agent is in: delivered by `host.prompt({ send: true })`, starting no session.
 * Anchors: `start_work` judged with no approval gate (FR-027); no delivery mid-dispatch (R14.5); constitution VII.
 */

import type { PromptRequest, PromptResult, SessionLifecycleEvent, SessionSnapshot } from '@openchamber/sdk';
import { appendEntryAndPersist } from './panel-actions.ts';
import { followUpRecordOf, loadDispatchRecord, recordFollowUpDelivery } from './dispatch-record.ts';
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

export type RefusalEnding = 'retry' | 'park' | 'wait';

export interface FollowUpRefusal {
    readonly reason: FollowUpFailure;
    readonly ending: RefusalEnding;
}

/** The fallback's waiting word: `session-busy` marks a target not current or not idle. */
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

/** Track the host's current session and its busy flag — an idle fact exactly when `busy` is `false`. */
export function trackCurrentSession(rt: PanelRuntime): () => void {
    return rt.host.onSession((snapshot: SessionSnapshot | null) => {
        rt.state.relay.currentSessionId = snapshot?.id ?? null;
        rt.state.relay.currentSessionBusy = snapshot === null ? null : snapshot.busy;
    });
}

// Pokes one immediate poll on an idle transition through the relay's own
// guards, so a waiting follow-up re-arms with no second timer.
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

/** The delivery gate: the target must be the session on screen **and observed idle** — never assumed. */
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

interface ProjectedFollowUp {
    readonly followUp: RunFollowUp;
    readonly record: FollowUpDeliveryRecord | undefined;
}

function recordWindowWalk(records: readonly FollowUpDeliveryRecord[]): {
    readonly opening: string | null;
    readonly stoppedAtOwed: boolean;
} {
    let opening: string | null = null;
    for (const record of records) {
        if (record.delivered) {
            opening = record.deliveryId;
        } else if (!record.parked) {
            // Owed: open at it, so the read's bound cannot put it out of range.
            return { opening: record.deliveryId, stoppedAtOwed: true };
        }
    }

    return { opening, stoppedAtOwed: false };
}

function projectedFollowUpsOf(
    document: DispatchRecordDocument,
    rows: readonly RunRow[],
): readonly ProjectedFollowUp[] {
    return rows.flatMap((row) => (row.followUps ?? []).map((followUp) => ({
        followUp,
        record: followUpRecordOf(document, followUp.deliveryId),
    })));
}

/** The engine already holds a `queued` row — reached elsewhere — so the window may pass it. */
function advancePastAdmitted(input: {
    readonly opening: string | null;
    readonly projected: readonly ProjectedFollowUp[];
    readonly positions: ReadonlyMap<string, number>;
}): string | null {
    const { opening, projected, positions } = input;
    if (opening === null || !positions.has(opening)) {
        return opening;
    }

    let advanced: string | null = opening;
    const successors = projected.slice((positions.get(opening) ?? 0) + 1);
    for (const entry of successors) {
        if (entry.followUp.engine?.state !== 'queued' || entry.record !== undefined) {
            break;
        }

        advanced = entry.followUp.deliveryId;
    }

    return advanced;
}

/** Neither `unavailable` nor `unknown` means the movement was handled, so the read must keep reaching it. */
function clampToBlocked(input: {
    readonly opening: string | null;
    readonly projected: readonly ProjectedFollowUp[];
    readonly positions: ReadonlyMap<string, number>;
}): string | null {
    const { opening, projected, positions } = input;
    const blocked = projected.find((entry) =>
        entry.record === undefined
        && (entry.followUp.engine?.state === 'unavailable' || entry.followUp.engine?.state === 'unknown'));
    if (blocked === undefined) {
        return opening;
    }

    const position = opening === null ? -1 : (positions.get(opening) ?? -1);

    return position >= (positions.get(blocked.followUp.deliveryId) ?? 0)
        ? blocked.followUp.deliveryId
        : opening;
}

export function followUpWindowOpening(
    document: DispatchRecordDocument,
    rows: readonly RunRow[] = [],
): string | null {
    const walk = recordWindowWalk(document.followUps ?? []);
    const projected = projectedFollowUpsOf(document, rows);
    if (projected.length === 0) {
        return walk.opening;
    }

    const positions = new Map(projected.map((entry, index) => [entry.followUp.deliveryId, index]));
    const opening = walk.stoppedAtOwed
        ? walk.opening
        : advancePastAdmitted({ opening: walk.opening, projected, positions });

    return clampToBlocked({ opening, projected, positions });
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

    return read.ok ? followUpWindowOpening(read.document, rt.state.relay.followUpRows) : null;
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

/** The movement line one follow-up kind contributes to the composed message. */
function followUpMovement(kind: RunFollowUp['kind'], from: string, to: string): string {
    switch (kind) {
        case 'head': {
            return `Head moved from ${from} to ${to}`;
        }
        case 'review': {
            return 'Review requested on this pull request';
        }
        case 'review-comment': {
            return 'New review comment';
        }
        case 'comment': {
            return 'New comment';
        }
    }
}

/** The kinds whose movement is a comment on a pull request rather than an issue. */
const PULL_SHAPED_KINDS: ReadonlySet<RunFollowUp['kind']> = new Set(['head', 'review', 'review-comment']);

/** Whether a follow-up kind names a movement on a pull request. */
function isPullShapedFollowUp(kind: RunFollowUp['kind']): boolean {
    return PULL_SHAPED_KINDS.has(kind);
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
    const movement = followUpMovement(kind, from, to);
    const isPullShaped = isPullShapedFollowUp(kind);
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
        origin: isPullShaped ? 'review' : 'comment',
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
            isPullRequest: isPullShaped,
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

// A wait-classified refusal *is* the session reporting busy, so the next
// tick's gate reads that instead of asking again; an idle signal clears it.
function refusalVerdict(rt: PanelRuntime, refusal: FollowUpRefusal): PromptVerdict {
    if (refusal.ending === 'wait') {
        rt.state.relay.currentSessionBusy = true;
    }

    return { wasSent: false, refusal };
}

/** Send the composed message; never throws. */
async function sendPrompt(rt: PanelRuntime, message: string): Promise<PromptVerdict> {
    try {
        const answer = await rt.host.prompt({ text: message, send: true } satisfies PromptRequest);

        return answer.sent === 'sent'
            ? { wasSent: true }
            : refusalVerdict(rt, classifyPromptAnswer(answer.sent));
    } catch (cause) {
        return refusalVerdict(rt, classifyHostError(cause));
    }
}

interface DeliveryArms {
    readonly settle: (outcome: Omit<FollowUpAttempt, 'deliveryId'>) => Promise<FollowUpAttempt>;
    readonly park: (reason: FollowUpFailure) => Promise<FollowUpAttempt>;
    readonly wait: () => Promise<FollowUpAttempt>;
}

// Every terminal arm writes, even before any host call: a record that never
// learns of an attempt is re-offered forever and never parks. The wait writes once.
function deliveryArms(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly sessionId: string | null;
    readonly attempt: number;
    readonly existing: FollowUpDeliveryRecord | null;
}): DeliveryArms {
    const { rt, row, followUp, sessionId, attempt, existing } = input;
    // A rungless outcome keeps the attempt the record already holds.
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

/** There is no navigation left to refuse, so a moved-away retry keeps the old word. */
function waitingOrRefused(input: {
    readonly rt: PanelRuntime;
    readonly sessionId: string;
    readonly record: FollowUpDeliveryRecord | null;
}): 'wait' | 'navigation-refused' {
    const isRetry = input.record?.reason === HOST_REFUSAL_REASON;
    const isAnotherSession = currentSessionIdOf(input.rt) !== input.sessionId;

    return isRetry && isAnotherSession ? 'navigation-refused' : 'wait';
}

/** No path calls `host.openSession`: a target that is not current waits, it never navigates. */
export async function deliverFollowUp(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly attempt: number;
    readonly policy: FollowUpRetryPolicy;
    readonly record?: FollowUpDeliveryRecord | null;
}): Promise<FollowUpAttempt> {
    const { rt, row, followUp, attempt, policy } = input;
    const sessionId = row.session?.sessionId ?? null;
    const arms = deliveryArms({ rt, row, followUp, sessionId, attempt, existing: input.record ?? null });

    // Nothing to deliver into, and a delivery never starts a session: it parks at once.
    if (sessionId === null || sessionId === '') {
        return await arms.park('no-session');
    }

    if (!targetIsCurrentAndIdle(rt, sessionId)) {
        const ending = waitingOrRefused({ rt, sessionId, record: input.record ?? null });

        return ending === 'wait' ? await arms.wait() : await arms.park(ending);
    }

    const message = followUpMessage({ row, followUp });
    if (budgetFloorProblem({ composed: message, sources: row.promptSources }) !== null) {
        // Measured before any host call; a guard that cannot park is not a
        // guard, so this composition path parks at once.
        return await arms.park('over-budget');
    }

    return await settleVerdict({ verdict: await sendPrompt(rt, message), arms, attempt, policy });
}

export function isFollowUpDue(record: FollowUpDeliveryRecord, atMs: number): boolean {
    return record.nextAttemptAtMs === null || record.nextAttemptAtMs <= atMs;
}
