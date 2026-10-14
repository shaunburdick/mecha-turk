/**
 * The per-cycle engine-delivery pass: for each run-linked follow-up row whose
 * engine member is absent and whose run carries a session, persist the intent,
 * then per attempt re-discover, acquire the token, probe identity, pre-check
 * ownership, compose, and admit — settling admitted, unknown, or unavailable
 * under the closed classification (FR-104 span C; FR-105 spans D/E; spec §5).
 */

import { assertRedacted } from '../../src/redaction.ts';
import { appendAudit } from '../audit.ts';
import { engineClient } from '../engine/client.ts';
import { discoverEngine } from '../engine/discovery.ts';
import { probeInfo } from '../engine/info.ts';
import { postFollowUpPrompt } from '../engine/prompt.ts';
import { preCheckSession } from '../engine/session.ts';
import { acquireToken, systemTokenSource } from '../engine/token.ts';
import type { EngineClient } from '../engine/client.ts';
import type { ManagedEngine } from '../engine/discovery.ts';
import type { AdmissionOutcome } from '../engine/prompt.ts';
import type { TokenSource } from '../engine/token.ts';
import type { ServiceLogger } from '../log.ts';
import type { ServiceStore } from '../store/index.ts';
import { describeKind } from './cycle-config.ts';
import { composeEngineFollowUp } from './engine-compose.ts';
import { writeEngineMember } from './engine-state.ts';
import { followUpKindOf } from './events-parse.ts';
import { readEvents } from './events.ts';
import { previewRunsDocument } from './runs-document.ts';
import type { EngineMember, QueuedEvent } from './events-parse.ts';
import type { Run } from './runs-types.ts';

/** Loopback host every engine call targets; the port comes from discovery. */
const ENGINE_LOOPBACK_HOST = 'http://127.0.0.1';

/** Stage words the audit rows and settlements name; one spelling each. */
const STAGE_PROMPT = 'prompt';

/** The audit-row cause word for the engine's `404` on the run's session. */
const CAUSE_NO_SESSION = 'no-session';

/** The knobs the engine's connection-refused ladder runs on — the existing three. */
export interface EngineRetryPolicy {
    /** Attempts per delivery, the first attempt included. */
    readonly maxAttempts: number;
    readonly baseMs: number;
    readonly maxMs: number;
}

/** The knobs the engine's connection-refused ladder runs on — the existing three. */
export interface EngineDeliveryDeps {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly retry: EngineRetryPolicy;
    /**
     * Environment discovery and the env token layer read, passed down from the
     * entry point's own `process.env` — no other module reads the process
     * environment (FR-090; 009 invariant 9).
     */
    readonly env: Readonly<Record<string, string | undefined>>;
    /** The token-chain seam; defaults to {@link systemTokenSource}. */
    readonly tokenSource?: TokenSource | undefined;
    /** Injected sleep so the ladder never waits in a suite. */
    readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
    /** Per-client timeout override so a suite never waits out the live bound. */
    readonly timeoutMs?: number | undefined;
    /** Injected clock for the intent stamp. */
    readonly now?: (() => number) | undefined;
}

/** What one pass settled, counts only — never a row body. */
export interface EngineDeliveryResult {
    readonly considered: number;
    readonly admitted: number;
    readonly unavailable: number;
    readonly unknown: number;
}

/** One final settlement of a delivery, before the member and row are written. */
interface Settlement {
    readonly engine: EngineMember;
    /** Which stage settled it: `discovery`, `token`, `info`, `pre-check`, `compose`, `prompt`, `ladder`. */
    readonly stage: string;
    /** Credential-free cause word; `none` when the delivery was admitted. */
    readonly cause: string;
}

/** One attempt's outcome: settle, or the one failure class that retries. */
type AttemptOutcome =
    | { readonly retry: true; readonly stage: string }
    | { readonly settlement: Settlement };

/** Discovery and token resolved for one attempt: the client it talks with. */
type AttemptClient =
    | { readonly ok: true; readonly client: EngineClient; readonly engine: ManagedEngine }
    | { readonly ok: false; readonly settlement: Settlement };

/** Identity and ownership judged for one attempt. */
type AttemptVerified =
    | { readonly ok: true }
    | { readonly ok: false; readonly retry: true; readonly stage: string }
    | { readonly ok: false; readonly settlement: Settlement };

const unavailable = (stage: string, cause: string): Settlement =>
    ({ engine: { state: 'unavailable' }, stage, cause });

/** The delay before one ladder attempt, doubling and capped as the panel's own. */
function engineBackoffMs(policy: EngineRetryPolicy, attempt: number): number {
    const grown = policy.baseMs * 2 ** Math.max(attempt - 1, 0);

    return Math.min(grown, policy.maxMs);
}

/** Default sleep: real time, replaced by an injected no-op in suites. */
function sleepFor(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * Append one credential-free engine-delivery audit row, **refusing the write**
 * when the row carries secret-shaped content rather than logging through it
 * (invariant 9). Exported so the refusal itself is testable.
 */
export async function appendEngineAuditRow(input: {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly correlationId: string;
    readonly deliveryId: string;
    readonly eventType: string;
    readonly decision: string;
    readonly reason: string;
    readonly details: Readonly<Record<string, unknown>>;
}): Promise<boolean> {
    try {
        assertRedacted('engine delivery audit row', `${input.reason} ${JSON.stringify(input.details)}`);
    } catch {
        input.log.warn('engine delivery audit row refused: secret-shaped content', {
            deliveryId: input.deliveryId,
        });

        return false;
    }

    try {
        await appendAudit(input.store, {
            eventType: input.eventType,
            actorSource: 'service',
            entity: { kind: 'delivery', id: input.deliveryId },
            correlationId: input.correlationId,
            decision: input.decision,
            reason: input.reason,
            details: input.details,
        });

        return true;
    } catch (cause) {
        input.log.warn('engine delivery audit row could not be appended', {
            deliveryId: input.deliveryId,
            errorKind: describeKind(cause),
        });

        return false;
    }
}

/** Write one settlement's member and its one audit row. */
async function settle(input: {
    readonly deps: EngineDeliveryDeps;
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly settlement: Settlement;
}): Promise<void> {
    const { deps, run, row, settlement } = input;
    const { engine } = settlement;
    const wasWritten = await writeEngineMember({ store: deps.store, deliveryId: row.id, engine });
    if (!wasWritten) {
        deps.log.warn('engine delivery state could not be persisted', {
            deliveryId: row.id,
            state: engine.state,
        });
    }

    const facts = { correlationId: run.correlationId, deliveryId: row.id, sessionId: run.session?.sessionId ?? null };
    const trail = { store: deps.store, log: deps.log, ...facts };
    if (engine.state === 'admitted') {
        await appendEngineAuditRow({
            ...trail,
            eventType: 'follow_up.engine_admitted',
            decision: 'admitted',
            reason: 'the engine admitted the follow-up; the receipt is the at-most-once record',
            details: { ...facts, stage: settlement.stage, messageId: engine.messageId },
        });

        return;
    }

    if (engine.state === 'unknown') {
        await appendEngineAuditRow({
            ...trail,
            eventType: 'follow_up.engine_unknown',
            decision: 'unknown',
            reason: 'the admission outcome is unknowable; it is never auto-retried or re-sent',
            details: { ...facts, stage: settlement.stage, cause: settlement.cause, intentAtMs: engine.intentAtMs },
        });

        return;
    }

    await appendEngineAuditRow({
        ...trail,
        eventType: 'follow_up.engine_unavailable',
        decision: 'unavailable',
        reason: 'the engine path cannot attempt this delivery; the panel fallback takes it',
        details: { ...facts, stage: settlement.stage, cause: settlement.cause },
    });
}

/** Discover the engine and acquire its token for one attempt. */
async function clientForAttempt(deps: EngineDeliveryDeps): Promise<AttemptClient> {
    const { env } = deps;
    const discovery = await discoverEngine({ env });
    if (!discovery.ok) {
        return { ok: false, settlement: unavailable('discovery', discovery.cause) };
    }

    const token = await acquireToken({ source: deps.tokenSource ?? systemTokenSource(env), engine: discovery.engine });
    if (!token.ok) {
        return { ok: false, settlement: unavailable('token', token.cause) };
    }

    return {
        ok: true,
        engine: discovery.engine,
        client: engineClient({
            baseUrl: `${ENGINE_LOOPBACK_HOST}:${discovery.engine.port}`,
            password: token.password,
            ...(deps.timeoutMs !== undefined && { timeoutMs: deps.timeoutMs }),
        }),
    };
}

/** Probe identity and pre-check ownership for one attempt. */
async function verifySession(input: {
    readonly client: EngineClient;
    readonly engine: ManagedEngine;
    readonly sessionId: string;
    readonly directory: string | undefined;
}): Promise<AttemptVerified> {
    const info = await probeInfo({ client: input.client, expectedPid: input.engine.pid });
    if (!info.ok) {
        if (info.cause === 'refused') {
            return { ok: false, retry: true, stage: 'info' };
        }

        return { ok: false, settlement: unavailable('info', info.cause) };
    }

    const ownership = await preCheckSession({
        client: input.client,
        sessionId: input.sessionId,
        directory: input.directory,
    });
    if (ownership.ok) {
        return { ok: true };
    }

    if (ownership.cause === 'refused') {
        return { ok: false, retry: true, stage: 'pre-check' };
    }

    // The engine's own 404 for the run's session is the no-session evidence
    // the audit row records; the member stays cause-less (plan pin 4).
    const cause = ownership.cause === 'session-404' ? CAUSE_NO_SESSION : ownership.cause;

    return { ok: false, settlement: unavailable('pre-check', cause) };
}

/** An admission answer that settled (the retryable refusal never reaches here). */
type SettledAdmission = Exclude<AdmissionOutcome, { readonly kind: 'refused' }>;

/** Map one admission answer onto its settlement. */
function admissionSettlement(admission: SettledAdmission, intentAtMs: number): Settlement {
    switch (admission.kind) {
        case 'admitted': {
            return {
                engine: { state: 'admitted', messageId: admission.messageId },
                stage: STAGE_PROMPT,
                cause: 'none',
            };
        }
        case 'unknown': {
            return {
                engine: { state: 'unknown', intentAtMs, cause: admission.cause },
                stage: STAGE_PROMPT,
                cause: admission.cause,
            };
        }
        case 'unauthorized': {
            return unavailable(STAGE_PROMPT, 'unauthorized');
        }
        case 'no-session': {
            return unavailable(STAGE_PROMPT, CAUSE_NO_SESSION);
        }
        case 'rejected': {
            return unavailable(STAGE_PROMPT, 'rejected');
        }
    }
}

/** Run one attempt: discovery → token → identity → ownership → compose → admit. */
async function attemptOnce(input: {
    readonly deps: EngineDeliveryDeps;
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly runRows: readonly QueuedEvent[];
    readonly sessionId: string;
    /** The intent stamp the unknown state keeps as its evidence. */
    readonly intentAtMs: number;
}): Promise<AttemptOutcome> {
    const prepared = await clientForAttempt(input.deps);
    if (!prepared.ok) {
        return { settlement: prepared.settlement };
    }

    const verified = await verifySession({
        client: prepared.client,
        engine: prepared.engine,
        sessionId: input.sessionId,
        directory: input.run.session?.directory,
    });
    if (!verified.ok) {
        return 'retry' in verified
            ? { retry: true, stage: verified.stage }
            : { settlement: verified.settlement };
    }

    const composed = composeEngineFollowUp({
        run: input.run,
        row: input.row,
        sessionId: input.sessionId,
        runRows: input.runRows,
    });
    if (!composed.ok) {
        return { settlement: unavailable('compose', composed.cause) };
    }

    const admission = await postFollowUpPrompt({
        client: prepared.client,
        sessionId: input.sessionId,
        text: composed.text,
    });

    return admission.kind === 'refused'
        ? { retry: true, stage: STAGE_PROMPT }
        : { settlement: admissionSettlement(admission, input.intentAtMs) };
}

/** Deliver one row: intent first, then the ladder, then exactly one settlement. */
async function deliverOne(input: {
    readonly deps: EngineDeliveryDeps;
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly runRows: readonly QueuedEvent[];
}): Promise<'admitted' | 'unavailable' | 'unknown' | 'skipped'> {
    const { deps, run, row } = input;
    const sessionId = run.session?.sessionId;
    if (sessionId === undefined) {
        return 'skipped';
    }

    const intentAtMs = (deps.now ?? Date.now)();
    const intent: EngineMember = { state: 'unknown', intentAtMs, cause: 'intent' };
    const hasIntent = await writeEngineMember({ store: deps.store, deliveryId: row.id, engine: intent });
    if (!hasIntent) {
        // No intent means no proof the delivery is not already in flight, so
        // this cycle attempts nothing and a later one re-reads the row.
        deps.log.warn('engine delivery intent could not be persisted; the delivery waits', {
            deliveryId: row.id,
        });

        return 'skipped';
    }

    const { maxAttempts } = deps.retry;
    const sleep = deps.sleep ?? sleepFor;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const outcome = await attemptOnce({ ...input, sessionId, intentAtMs });
        if (!('retry' in outcome)) {
            await settle({ deps, run, row, settlement: outcome.settlement });

            return outcome.settlement.engine.state;
        }

        if (attempt < maxAttempts) {
            await sleep(engineBackoffMs(deps.retry, attempt));
        }
    }

    // Connection-refused exhausts the ladder into the unavailable mark — the
    // one class the knobs retry, and never a park (FR-105 span D).
    const exhausted = unavailable('ladder', 'connection-refused');
    await settle({ deps, run, row, settlement: exhausted });

    return 'unavailable';
}

/** One pass's zero counts. */
function emptyResult(): EngineDeliveryResult {
    return { considered: 0, admitted: 0, unavailable: 0, unknown: 0 };
}

/** The run-linked follow-up rows whose engine member is still absent. */
function candidatesOf(queue: readonly QueuedEvent[]): ReadonlyMap<string, readonly QueuedEvent[]> {
    const candidates = new Map<string, QueuedEvent[]>();
    for (const row of queue) {
        if (row.runCorrelationId === undefined || row.engine !== undefined || followUpKindOf(row.id) === null) {
            continue;
        }

        const rows = candidates.get(row.runCorrelationId) ?? [];
        rows.push(row);
        candidates.set(row.runCorrelationId, rows);
    }

    return candidates;
}

/** Tally one row's settlement into the pass's counts. */
function counted(counts: EngineDeliveryResult, settled: Awaited<ReturnType<typeof deliverOne>>): EngineDeliveryResult {
    if (settled === 'admitted') {
        return { ...counts, admitted: counts.admitted + 1 };
    }

    if (settled === 'unavailable') {
        return { ...counts, unavailable: counts.unavailable + 1 };
    }

    if (settled === 'unknown') {
        return { ...counts, unknown: counts.unknown + 1 };
    }

    return counts;
}

/**
 * Deliver every candidate whose run carries a session. Rows whose engine
 * member is already present — including an intent-without-receipt `unknown` a
 * restart left behind — are never revisited: zero automatic re-POSTs, ever
 * (FR-105 span E).
 */
async function deliverCandidates(input: {
    readonly deps: EngineDeliveryDeps;
    readonly candidates: ReadonlyMap<string, readonly QueuedEvent[]>;
    readonly runs: ReadonlyMap<string, Run>;
}): Promise<EngineDeliveryResult> {
    let counts: EngineDeliveryResult = emptyResult();
    for (const [correlationId, rows] of input.candidates) {
        const run = input.runs.get(correlationId);
        // A missing run and a run with no session are both nothing to deliver
        // into, and neither is this pass's delivery to settle.
        const session = run === undefined ? null : run.session;
        if (run !== undefined && session !== null) {
            for (const row of rows) {
                const settled = await deliverOne({ deps: input.deps, run, row, runRows: rows });
                counts = { ...counted(counts, settled), considered: counts.considered + 1 };
            }
        }
    }

    return counts;
}

/**
 * Run one engine-delivery pass. Never throws: an unreadable queue or run
 * document leaves every candidate for a later cycle, because a delivery whose
 * intent could not be persisted is a delivery this pass must not attempt.
 */
export async function runEngineDeliveryPass(deps: EngineDeliveryDeps): Promise<EngineDeliveryResult> {
    try {
        const candidates = candidatesOf(await readEvents(deps));
        if (candidates.size === 0) {
            return emptyResult();
        }

        const document = await previewRunsDocument({ store: deps.store, log: deps.log });
        const runs = new Map(document.runs.map((run) => [run.correlationId, run]));

        return await deliverCandidates({ deps, candidates, runs });
    } catch (cause) {
        deps.log.warn('engine delivery pass failed', { errorKind: describeKind(cause) });

        return emptyResult();
    }
}
