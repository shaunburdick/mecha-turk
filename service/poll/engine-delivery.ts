/** The per-cycle engine-delivery pass: an intent-stamped attempt ladder ending in exactly one admission settlement. */

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

const ENGINE_LOOPBACK_HOST = 'http://127.0.0.1';

const STAGE_PROMPT = 'prompt';

const CAUSE_NO_SESSION = 'no-session';

/** The knobs the engine's connection-refused ladder runs on — the existing three. */
export interface EngineRetryPolicy {
    readonly maxAttempts: number;
    readonly baseMs: number;
    readonly maxMs: number;
}

export interface EngineDeliveryDeps {
    readonly store: ServiceStore;
    readonly log: ServiceLogger;
    readonly retry: EngineRetryPolicy;
    /** The entry point's own `process.env`, passed down: no module below it reads the environment itself. */
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly tokenSource?: TokenSource | undefined;
    /** Injected sleep so the ladder never waits in a suite. */
    readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
    readonly timeoutMs?: number | undefined;
    readonly now?: (() => number) | undefined;
}

/** What one pass settled, counts only — never a row body. */
export interface EngineDeliveryResult {
    readonly considered: number;
    readonly admitted: number;
    readonly unavailable: number;
    readonly unknown: number;
}

interface Settlement {
    readonly engine: EngineMember;
    readonly stage: string;
    /** Credential-free cause word; `none` when the delivery was admitted. */
    readonly cause: string;
}

type AttemptOutcome =
    | { readonly retry: true; readonly stage: string }
    | { readonly settlement: Settlement };

type AttemptClient =
    | { readonly ok: true; readonly client: EngineClient; readonly engine: ManagedEngine }
    | { readonly ok: false; readonly settlement: Settlement };

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

function sleepFor(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

// Refuses the write rather than logging secret-shaped content; exported so the
// refusal itself is testable.
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

    // The engine's own 404 is the no-session evidence the audit row records;
    // the member stays cause-less.
    const cause = ownership.cause === 'session-404' ? CAUSE_NO_SESSION : ownership.cause;

    return { ok: false, settlement: unavailable('pre-check', cause) };
}

type SettledAdmission = Exclude<AdmissionOutcome, { readonly kind: 'refused' }>;

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
            // No receipt arrived, so the intent is spent: the member records the
            // re-offer-eligible `outcome` cause; the audit row keeps the class.
            return {
                engine: { state: 'unknown', intentAtMs, cause: 'outcome' },
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

/** Compose and budget-check before any engine GET: an over-budget composition must issue zero engine requests. */
async function attemptOnce(input: {
    readonly deps: EngineDeliveryDeps;
    readonly run: Run;
    readonly row: QueuedEvent;
    readonly runRows: readonly QueuedEvent[];
    readonly sessionId: string;
    readonly intentAtMs: number;
}): Promise<AttemptOutcome> {
    const prepared = await clientForAttempt(input.deps);
    if (!prepared.ok) {
        return { settlement: prepared.settlement };
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

    const admission = await postFollowUpPrompt({
        client: prepared.client,
        sessionId: input.sessionId,
        text: composed.text,
    });

    return admission.kind === 'refused'
        ? { retry: true, stage: STAGE_PROMPT }
        : { settlement: admissionSettlement(admission, input.intentAtMs) };
}

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
    // one class the knobs retry, and never a park.
    const exhausted = unavailable('ladder', 'connection-refused');
    await settle({ deps, run, row, settlement: exhausted });

    return 'unavailable';
}

function emptyResult(): EngineDeliveryResult {
    return { considered: 0, admitted: 0, unavailable: 0, unknown: 0 };
}

function candidatesOf(queue: readonly QueuedEvent[]): ReadonlyMap<string, readonly QueuedEvent[]> {
    const candidates = new Map<string, QueuedEvent[]>();
    for (const row of queue) {
        const { engine } = row;
        if (
            row.runCorrelationId === undefined
            || followUpKindOf(row.id) === null
            || engine?.state !== 'unknown'
            || engine.cause !== 'intent'
        ) {
            continue;
        }

        const rows = candidates.get(row.runCorrelationId) ?? [];
        rows.push(row);
        candidates.set(row.runCorrelationId, rows);
    }

    return candidates;
}

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

/** A row the pass no longer owns is never revisited: zero automatic re-POSTs, ever. */
async function deliverCandidates(input: {
    readonly deps: EngineDeliveryDeps;
    readonly candidates: ReadonlyMap<string, readonly QueuedEvent[]>;
    readonly runs: ReadonlyMap<string, Run>;
}): Promise<EngineDeliveryResult> {
    let counts: EngineDeliveryResult = emptyResult();
    for (const [correlationId, rows] of input.candidates) {
        const run = input.runs.get(correlationId);
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

/** Never throws: an unreadable queue or run document leaves every candidate for a later cycle. */
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
