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
 * builder, with the same delimiters and the same running budget, so no comment
 * text can reach past them and alter policy, credentials, approval
 * requirements, or tool scope (constitution Security Standard 3). The one thing
 * it does **not** reuse is the dispatch's own header: a follow-up is not a new
 * dispatch from an open-issue assignment, so claiming that it is would put a
 * false statement about policy and scope in text the agent reads. The frame is
 * therefore the follow-up's own — the same markers, a follow-up preamble, and
 * the rule line that says the session is continuing work it already started.
 * The composition is measured **before** any host call and **refused rather
 * than truncated** when over budget — `relay-attempt.ts`'s floor, applied
 * unchanged.
 *
 * This module also owns the **read** the delivery selects from: the relay has
 * its own current view of `GET /v1/events` on its own clock
 * ({@link readFollowUpRows}), because the operator's runs list is a *paged,
 * filterable* view an operator controls — reusing it for the relay would let a
 * page position or a filter silently decide what gets delivered, and would hand
 * the relay a view that goes stale the moment the operator navigates away from
 * the page the work is on.
 *
 * That read **walks the follow-up window** rather than reading its first bound
 * and stopping. The service holds no record of a delivery — this module is the
 * only party that calls the host — so the queue's follow-up rows are never
 * pruned and a run whose subject keeps moving fills the projected window with
 * follow-ups already sent. The read therefore carries the read's one absentable
 * parameter, `followUpsFrom`, advanced past the newest id this panel's durable
 * record says reached a session ({@link followUpWindowOpening}), and omits it
 * entirely when the panel has delivered nothing or cannot read its own record —
 * which is the read's pre-parameter answer and the safe direction, since a
 * window opened early can only ever project a movement sooner than asked.
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

/** Page size the relay's follow-up read asks for: the route's largest (005 contract §1). */
const FOLLOW_UP_PAGE_LIMIT = MAX_PAGE_SIZE;

/**
 * How many pages one walk reads before it keeps what it has and stops.
 *
 * The service retains at most 500 terminal runs, so ten pages of the largest
 * page size covers any conforming store twice over. The guard is here for the
 * answer that is *not* conforming — a `hasMore` that never clears — so a
 * pathological read cannot spin the relay's tick into an unbounded walk.
 */
const FOLLOW_UP_PAGE_GUARD = 10;

/**
 * The state a run must carry for a follow-up to have a session to ride into.
 *
 * A run with a recorded session is `dispatched` and nothing else: the run
 * document quarantines a session-carrying run in any other state, and a
 * `dead-lettered` run holds no session (FR-100 opens the next ordinal for it).
 * The filter is therefore exactly "the runs a follow-up can belong to", and
 * asking the route for it keeps each page dense rather than spending pages on
 * runs that can never carry one.
 */
const DELIVERABLE_RUN_STATE: PlainRunState = 'dispatched';

/**
 * Where the relay's read opens the follow-up window: past everything this panel
 * has settled, and never past a follow-up it still owes.
 *
 * The record is the **only** party that knows a delivery happened: the service
 * holds no record of one, so it cannot prune a follow-up row from the queue and
 * cannot project "the undelivered ones" (FR-104). This is the value the relay
 * walks the projected window past.
 *
 * The list is oldest-first by last write — `putFollowUpRecord` replaces an entry
 * with the same delivery id and appends it — so a scan that keeps the last
 * delivered entry opens at the most recently settled delivery, and a failed
 * attempt on a later follow-up does not disqualify an earlier delivery: the
 * newest *delivered* id is simply further back, which opens the window earlier
 * and therefore never skips a movement.
 *
 * **The scan also stops at an owed follow-up.** A record that is neither
 * delivered nor parked is one the relay still owes a session — mid-ladder in its
 * backoff, or returned to due by an operator's re-offer — and opening the window
 * past it would hide the very follow-up the next tick is meant to deliver. So
 * the scan forgets every delivered id once it meets an owed one, which moves the
 * read's opening *earlier*: reading from the start costs a denser page and can
 * only project a movement sooner than asked (the read's own pre-parameter
 * answer), where opening late strands one. A parked record is not owed — it is
 * excluded from automatic handling until an operator re-offers it (FR-105) — so
 * it does not stop the walk; and the re-offer appends the record at the end of
 * the list (`reofferFollowUpRecords`), which is what puts it after the delivered
 * sibling the walk was about to open past.
 *
 * @param document - The panel's durable dispatch record.
 * @returns The delivery id to walk past, or `null` when this panel has delivered
 *   nothing — in which case the read carries no parameter at all.
 */
export function followUpWindowOpening(document: DispatchRecordDocument): string | null {
    const records = document.followUps ?? [];
    let newest: string | null = null;
    for (const record of records) {
        if (record.delivered) {
            newest = record.deliveryId;
        } else if (!record.parked) {
            newest = null;
        }
    }

    return newest;
}

/**
 * Where the relay's read should open the window, or `null` for the start.
 *
 * An unreadable record answers `null` — no parameter — rather than a guessed
 * position: the panel would then be walking past a follow-up it had already sent
 * or, worse, past one it had not, and a duplicate prompt is the failure NFR-002
 * exists to prevent. Reading from the start is the pre-parameter answer, which
 * is always the direction that projects **more** of the run's movements, never
 * fewer.
 *
 * @returns The delivery id to send as `followUpsFrom`, or `null`.
 */
async function followUpWindowAdvance(rt: PanelRuntime): Promise<string | null> {
    const read = await loadDispatchRecord(rt);

    return read.ok ? followUpWindowOpening(read.document) : null;
}

/**
 * The path of one page of the relay's own runs view.
 *
 * The two filters are the documented query surface of the existing route
 * (`state`, `limit`) plus its own cursor when the walk is mid-set and the
 * window's opening when the panel has already delivered something — no
 * parameter the contract does not already define.
 *
 * @param cursor - Page boundary to resume from, or `null` for the first page.
 * @param followUpsFrom - Delivery id the window opens at or after, or `null` to
 *   read from the start as the read did before the parameter existed.
 * @returns The request path.
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
 * Read the relay's own view of the runs a follow-up can ride, on its own clock.
 *
 * The relay cannot select from the operator's runs list: that list is a paged,
 * filtered view the operator controls, so a page position would decide what
 * gets delivered and any navigation would strand the work on a page nobody is
 * looking at. This read is the relay's own — `state=dispatched` filtered,
 * newest first, walked to the end of the set through the route's own cursor.
 *
 * Three properties it holds deliberately:
 *
 * - **A refused or unreadable page keeps the last good view.** A stale row can
 *   only make a delivery *late* — the durable record is what makes one
 *   *duplicate* — while a partial walk published as complete would hide the
 *   follow-ups on the pages it never reached.
 * - **The walk is bounded** ({@link FOLLOW_UP_PAGE_GUARD}) so a non-conforming
 *   `hasMore` cannot spin the tick.
 * - **The window advances with the record** ({@link followUpWindowAdvance}), so
 *   a subject that keeps moving past the projected bound is still followed. The
 *   advance costs one read of the panel's own host storage — never a service
 *   request — and is omitted entirely when there is nothing delivered to walk
 *   past.
 *
 * @param rt - Panel runtime whose relay state the view is read into.
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
            // Fail closed on the *read*: a page this build cannot parse is not
            // acted on, and the previous view stands rather than a half-read one.
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
 * Compose the bounded, delimited message one follow-up delivers.
 *
 * The frame builder is the dispatch's — the same untrusted-source markers, the
 * same running budget, the same single implementation of both — with a
 * **follow-up's own header**: a follow-up preamble, the run's correlation id,
 * the movement that arrived, and the rule line that says this is the same work
 * item the session was started for. The dispatch's header is deliberately not
 * reused: it names a machine account and the *configured-match* rule for "open
 * issue assigned to the authenticated machine account", which is what started
 * the session, not what a later comment or push is. A follow-up that claimed
 * otherwise would tell the agent it had been dispatched anew from an
 * assignment, and would put a false policy statement in text it reads.
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
    // The frame rides **above** the untrusted block, so a forged delimiter in any
    // scalar interpolated into it rebinds the region the block's own delimiters
    // claim to bound. Every service-projected scalar this frame quotes is
    // therefore defused — the issue title and URL beside them, the actor login,
    // the from/to head pair, the movement's stamp, the run's correlation id and
    // repository, and the session id — because a forged marker in any one of them
    // is the same hole with a different field name. The reach of the store's own
    // constraints is not the boundary being defended here; the frame is.
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
    // call. Nothing above the header is reserved: there is no second frame.
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
    const sessionId = row.session?.sessionId ?? null;
    /**
     * Persist one settled outcome and write its trail row.
     *
     * Every arm goes through here — including the two that return before any
     * host call — because a durable record that never learns of an attempt
     * reports the delivery as never tried: the relay then re-offers it on
     * every tick forever, the ladder never advances, and nothing ever parks
     * (FR-105's unbounded retry, which is exactly what the bound exists to
     * forbid).
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

    // No recorded session means nothing to deliver into: the row is not a
    // follow-up's target, and a delivery must never start one. `NO_SESSION` is
    // one of FR-105's retryable refusals, so it runs the ladder like the
    // others — and now records each attempt like the others do.
    if (sessionId === null || sessionId === '') {
        return await finish({ reason: 'no-session', ...retryAfter({ attempt, policy }) });
    }

    const message = followUpMessage({ row, followUp });
    const overBudget = budgetFloorProblem({ composed: message, sources: row.promptSources });
    if (overBudget !== null) {
        // Measured before any host call, as FR-104 requires. The shared
        // renderer bounds the whole composition — the follow-up's frame is the
        // context's own header now, not a second frame stacked on top of one —
        // so this arm is a guard against a composition path that ever stops
        // sharing that budget rather than an expected outcome. It still runs
        // the ladder and still records, because a guard that cannot park is
        // not a guard.
        return await finish({ reason: 'over-budget', ...retryAfter({ attempt, policy }) });
    }

    // The current session is a fact the panel already holds from the host's own
    // `onSession` subscription, so "is the target already current?" costs no
    // host call and a target that is already shown is navigated to zero times.
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
