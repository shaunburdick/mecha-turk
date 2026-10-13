/**
 * Following up on a work item the agent is already in: composition,
 * navigation, delivery, and the bounded retry that parks (002 FR-104,
 * FR-105). Delivered by `host.prompt({ send: true })` into the session the
 * run's dispatch already created — it starts no session and joins no other
 * run (constitution VII) — and judged exactly as `start_work` is under
 * FR-027: autonomously by default, no approval gate of its own.
 */

import type { PromptRequest, PromptResult, SessionSnapshot } from '@openchamber/sdk';
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

/**
 * Read the retry ladder the service declares; never rejects.
 */
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
    /** `true` once the bound is spent and the follow-up is parked. */
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

/** What a settled-but-unsent prompt answer means, in the closed failure union. */
function classifyPromptAnswer(sent: PromptResult['sent']): FollowUpFailure {
    return sent === 'skipped' ? 'session-busy' : 'host-unavailable';
}

/**
 * Classify one rejected or timed-out prompt into the closed failure union — a
 * closed union rather than a free string because the cause is what the
 * operator reads on the run row and in the trail, and `NO_SESSION` and
 * `SESSION_BUSY` are retryable refusals while an unbounded wait is not
 * (FR-105).
 */
export function classifyHostError(cause: unknown): FollowUpFailure {
    const code = hostErrorCode(cause);
    if (code === 'NO_SESSION') {
        return 'no-session';
    }

    return code === 'SESSION_BUSY' ? 'session-busy' : 'host-unavailable';
}

function retryAfter(input: {
    readonly attempt: number;
    readonly policy: FollowUpRetryPolicy;
}): { readonly parked: boolean; readonly nextAttemptAtMs: number | null } {
    return input.attempt >= input.policy.maxAttempts
        ? { parked: true, nextAttemptAtMs: null }
        : { parked: false, nextAttemptAtMs: followUpBackoffMs(input.policy, input.attempt) };
}

/**
 * Read the session the host is showing, from the fact the panel already holds:
 * the {@link trackCurrentSession} subscription replays the latest value, so
 * this costs no host call of its own.
 */
export function currentSessionIdOf(rt: PanelRuntime): string | null {
    return rt.state.relay.currentSessionId;
}

/**
 * Track the host's current session for as long as the relay runs: one slot in
 * the host's subscription budget, registered when the relay arms and released
 * on teardown with every other subscription.
 */
export function trackCurrentSession(rt: PanelRuntime): () => void {
    return rt.host.onSession((snapshot: SessionSnapshot | null) => {
        rt.state.relay.currentSessionId = snapshot?.id ?? null;
    });
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
 * Where the relay's read opens the follow-up window: past everything this panel
 * has settled, and never past a follow-up it still owes. The record is the
 * **only** party that knows a delivery happened (FR-104) — the service holds no
 * record of one — and the list is oldest-first by last write, so keeping the
 * last delivered entry opens at the most recent settlement. The scan stops at
 * the first owed record and opens *at* it: a window opened early costs a denser
 * page, one opened late strands the follow-up for good, and the owed record's
 * id is a position in the run's own list whatever its number (the read cannot
 * page inside one run's follow-ups). A parked record is not owed — excluded
 * until an operator re-offers it (FR-105) — so it does not stop the walk.
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
 * Move the host to the target session, recording the intent before the call:
 * `null` when the navigation succeeded, the refusal that ended the attempt
 * otherwise.
 */
async function navigateToSession(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    readonly sessionId: string;
    readonly attempt: number;
}): Promise<FollowUpFailure | null> {
    const { rt, row, followUp, sessionId, attempt } = input;
    // Durable **before** the call: it moves the operator's view and closes the
    // panel, so a navigation whose cause lives only in memory is one no later
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
    readonly wasSent: boolean;
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
 * Run one follow-up delivery attempt end to end; never throws. Every refusal
 * ends the attempt before `host.prompt()` is reachable, and the composition is
 * measured before any host call — nothing over budget is ever written into a
 * session, and nothing is truncated to make one fit.
 */
export async function deliverFollowUp(input: {
    readonly rt: PanelRuntime;
    readonly row: RunRow;
    readonly followUp: RunFollowUp;
    /** Attempts this delivery has already used, the first included. */
    readonly attempt: number;
    readonly policy: FollowUpRetryPolicy;
}): Promise<FollowUpAttempt> {
    const { rt, row, followUp, attempt, policy } = input;
    const sessionId = row.session?.sessionId ?? null;
    /**
     * Persist one settled outcome and write its trail row. Every arm goes
     * through here — including the ones that return before any host call —
     * because a record that never learns of an attempt reports the delivery as
     * never tried: the relay re-offers it on every tick forever, the ladder
     * never advances, and nothing ever parks (FR-105's unbounded retry).
     */
    const settle = async (outcome: FollowUpAttempt): Promise<FollowUpAttempt> => {
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
    };
    const finish = (result: {
        readonly reason: FollowUpFailure;
        readonly parked: boolean;
        readonly nextAttemptAtMs: number | null;
    }): Promise<FollowUpAttempt> =>
        settle({ deliveryId: followUp.deliveryId, attempt, delivered: false, ...result });

    // No recorded session means nothing to deliver into — a delivery must never
    // start one — and `NO_SESSION` runs the ladder like the others, recording
    // each attempt as they do.
    if (sessionId === null || sessionId === '') {
        return await finish({ reason: 'no-session', ...retryAfter({ attempt, policy }) });
    }

    const message = followUpMessage({ row, followUp });
    const overBudget = budgetFloorProblem({ composed: message, sources: row.promptSources });
    if (overBudget !== null) {
        // Measured before any host call, as FR-104 requires. The shared renderer
        // bounds the whole composition, so this arm is a guard against a
        // composition path that ever stops sharing that budget — and it still
        // runs the ladder and still records, because a guard that cannot park is
        // not a guard.
        return await finish({ reason: 'over-budget', ...retryAfter({ attempt, policy }) });
    }

    // The current session is a fact the panel already holds from `onSession`, so
    // "already current?" costs no host call and navigates zero times.
    const refused = currentSessionIdOf(rt) === sessionId
        ? null
        : await navigateToSession({ rt, row, followUp, sessionId, attempt });
    if (refused !== null) {
        return await finish({ reason: refused, ...retryAfter({ attempt, policy }) });
    }

    const verdict = await sendPrompt(rt, message);

    return await settle({
        deliveryId: followUp.deliveryId,
        attempt,
        delivered: verdict.wasSent,
        reason: verdict.reason,
        ...(verdict.wasSent ? { parked: false, nextAttemptAtMs: null } : retryAfter({ attempt, policy })),
    });
}

export function isFollowUpDue(record: FollowUpDeliveryRecord, atMs: number): boolean {
    return record.nextAttemptAtMs === null || record.nextAttemptAtMs <= atMs;
}
