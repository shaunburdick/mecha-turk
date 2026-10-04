/**
 * HTTP-poll request backoff — 006 FR-058 (plan N4, decisions D7 and D8).
 *
 * **What this module is, in the vocabulary the requirement fixes.** This is
 * *poll request* retry: how often one GitHub list **request** may be attempted
 * and how long to wait between attempts. It is **not** 003's run requeue, not
 * the operator's per-run retry, and not the requeue budget — those belong to
 * the run model and to 003 (FR-058's disambiguation clause). One label
 * covering two of them is exactly how a reader comes to believe a dial does
 * something it does not, so nothing here is named `requeue`, `run attempt`, or
 * `retry budget`.
 *
 * **The arithmetic** (normative, restated from FR-058):
 *
 * ```text
 * delay(n) = min(retryMaxMs, retryBaseMs × 2^(n − 2)) × jitter,  jitter ∈ [0.5, 1.0]
 * guidance = the rate limit's own `retry-after`/reset answer
 * wait     = max(delay(n), guidance)      // guidance wins, even above retryMaxMs
 * attempts ≤ retryMaxAttempts, the first attempt included
 * ```
 *
 * The computed delay is clamped to the ceiling so no ladder step can exceed
 * it; rate-limit guidance is not, because waiting longer than the operator's
 * ceiling is what a secondary rate limit punishes. Both injectables — `sleep`
 * and `random` — arrive from the caller, so a test records every delay without
 * sleeping (SC-116, AC-148: no real timers, no flaky jitter).
 */

/** The three knobs one request's ladder runs on, read at the cycle boundary. */
export interface RetryPolicy {
    /** Attempts per request, the **first attempt included**. */
    readonly maxAttempts: number;
    /** Delay the ladder starts from, before jitter. */
    readonly baseMs: number;
    /** Ceiling on a computed delay; rate-limit guidance may exceed it. */
    readonly maxMs: number;
}

/**
 * Why a wait is as long as it is — the "source" FR-058 requires the log line
 * to name beside the length.
 *
 * - `backoff` — the ladder's own computation, clamped to `maxMs`.
 * - `guidance` — the rate limit's `retry-after`/reset answer, which wins
 *   outright (including when it exceeds `maxMs`, and including the
 *   documented fallback wait a refusal without either header carries).
 */
export type WaitSource = 'backoff' | 'guidance';

/** One wait: which attempt it precedes, how long it lasts, and why. */
export interface WaitRecord {
    /** The attempt about to run; the first attempt is never waited for. */
    readonly attempt: number;
    /** Milliseconds the driver will sleep. */
    readonly delayMs: number;
    /** Which bound set the length. */
    readonly source: WaitSource;
}

/** Sleep implementation; injected so tests never wait. */
export type SleepFn = (milliseconds: number) => Promise<void>;

/** Jitter source; injected so recorded delays are deterministic. */
export type RandomFn = () => number;

/**
 * Clamp a jitter source to the `[0, 1]` fraction the ladder assumes.
 *
 * @param value - Whatever the injected source returned.
 * @returns The value, bounded to the unit interval.
 */
function unitFraction(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.min(1, Math.max(0, value));
}

/** Milliseconds one second holds; the guidance header speaks in seconds. */
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * The jittered ladder delay before an attempt.
 *
 * @param input - The policy, the attempt about to run (1 is immediate, so 2
 *   is `base`), and the injected jitter source in `[0, 1)`.
 * @returns Milliseconds, never above `policy.maxMs`.
 */
export function backoffDelayMs(input: {
    /** Ladder parameters read at the cycle boundary. */
    readonly policy: RetryPolicy;
    /** The attempt about to run. */
    readonly attempt: number;
    /** Injected jitter source. */
    readonly random: RandomFn;
}): number {
    const step = Math.max(input.attempt - 2, 0);
    const uncapped = input.policy.baseMs * 2 ** step;
    const capped = Math.min(input.policy.maxMs, uncapped);
    const jitter = 0.5 + 0.5 * unitFraction(input.random());

    return Math.min(input.policy.maxMs, Math.floor(capped * jitter));
}

/**
 * Choose the wait that precedes the next attempt.
 *
 * @param input - Policy, the attempt to wait for, and optional rate-limit
 *   guidance in seconds (or `null` when the failure carried none).
 * @returns The wait the driver should perform.
 */
export function nextWait(input: {
    /** Ladder parameters read at the cycle boundary. */
    readonly policy: RetryPolicy;
    /** The attempt about to run. */
    readonly attempt: number;
    /** Rate-limit guidance in seconds, when the refusal carried one. */
    readonly guidanceSeconds: number | null;
    /** Injected jitter source. */
    readonly random: RandomFn;
}): WaitRecord {
    const backoffMs = backoffDelayMs({
        policy: input.policy,
        attempt: input.attempt,
        random: input.random,
    });
    if (input.guidanceSeconds === null) {
        return { attempt: input.attempt, delayMs: backoffMs, source: 'backoff' };
    }

    const guidedMs = Math.max(0, Math.round(input.guidanceSeconds * MILLISECONDS_PER_SECOND));

    return guidedMs > backoffMs
        ? { attempt: input.attempt, delayMs: guidedMs, source: 'guidance' }
        : { attempt: input.attempt, delayMs: backoffMs, source: 'backoff' };
}

/**
 * Run one wait: choose it, report it, then sleep it.
 *
 * The report happens **before** the sleep so an operator can see the delay
 * start, and it carries the length and the source only — never a header
 * value, never a credential (FR-058's log requirement; 002 FR-007).
 *
 * @param input - Everything `nextWait` takes, plus the injected sleep and the
 *   observer that receives the chosen wait.
 * @returns The wait that was performed.
 */
export async function waitForRetry(input: {
    /** Ladder parameters read at the cycle boundary. */
    readonly policy: RetryPolicy;
    /** The attempt about to run. */
    readonly attempt: number;
    /** Rate-limit guidance in seconds, when the refusal carried one. */
    readonly guidanceSeconds: number | null;
    /** Injected sleep. */
    readonly sleep: SleepFn;
    /** Injected jitter source. */
    readonly random: RandomFn;
    /** Receives the chosen wait before the sleep begins. */
    readonly onWait: (record: WaitRecord) => void;
}): Promise<WaitRecord> {
    const record = nextWait(input);
    input.onWait(record);
    await input.sleep(record.delayMs);

    return record;
}
