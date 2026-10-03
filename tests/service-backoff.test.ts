/**
 * Poll-request backoff (006 T-010; FR-035, FR-058; AC-148, SC-116, and the
 * checkpoint half of 002 FR-018/FR-020).
 *
 * **The vocabulary first, because the requirement makes it normative**: this
 * is *requests/attempts/poll* backoff — how often one GitHub list request may
 * be tried and how long to wait between tries. It is **not** 003's requeue, a
 * run's attempts, or a retry budget; nothing in this suite uses those words
 * for this ladder (FR-058's disambiguation clause).
 *
 * Every timing claim is observed with an injected clock: `sleep` records and
 * resolves, `random` is pinned, and the one test that needs the ladder's real
 * timer runs on vitest's fake clock. **No test in this file sleeps.**
 *
 * What is proved here:
 *
 * 1. `delay(n) = min(cap, base × 2^(n−2)) × jitter`, jitter in `[0.5, 1.0]`,
 *    so a computed delay never exceeds the ceiling — and rate-limit guidance
 *    **wins even above it**, with its source named in the log line;
 * 2. `auth-failed` is never attempted a second time (constitution II), and
 *    exhaustion answers with the last failure so the loop's skip stays honest;
 * 3. a skipped scan **retains** `lastScanAt` — it neither advances past data
 *    that was never represented nor clears to a full replay;
 * 4. the wait happens **inside** the cycle, so the next cycle is armed from
 *    the cycle's end and the wait is delayed, never caught up (002 FR-022).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAccount } from '../service/accounts/store.ts';
import { writeBindings } from '../service/bindings.ts';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { runScanCycle } from '../service/poll/loop.ts';
import { backoffDelayMs, nextWait, waitForRetry } from '../service/poll/backoff.ts';
import { createGitHubIssuePoller } from '../service/poll/poller-github.ts';
import { SCAN_STATE_FILE, readScanState } from '../service/poll/scan.ts';
import { startPollLoop } from '../service/poll/timer.ts';
import { openStore } from '../service/store/index.ts';
import type { Account } from '../service/accounts/model.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { RetryPolicy, WaitRecord } from '../service/poll/backoff.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { GitHubIssuePoller, ListPace } from '../service/poll/poller-github.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/verify.ts';

/** Fixture credential — never a real one, and never expected in a log line. */
const FIXTURE_TOKEN = 'fixture-token-not-a-real-credential';

/** First fixture binding. */
const BINDING_A = 'bnd-backoff-a';

/** GitHub numeric user id of the fixture account. */
const ACCOUNT_ID = '77331';

/** Login the fixture account carries. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Fixture creation stamp. */
const CREATED_AT = '2026-09-27T00:00:00.000Z';

/** The recorded checkpoint a skipped scan must retain. */
const RECORDED_SCAN_AT = '2026-09-27T06:00:00.000Z';

/** Ladder whose ceiling is already reached, so every delay lands in [cap/2, cap]. */
const CAPPED_LADDER: RetryPolicy = { maxAttempts: 3, baseMs: 2_000, maxMs: 2_000 };

/**
 * The same capped shape, but as a **valid stored document**: `retryMaxMs`
 * bottoms out at 5 000 (its own documented minimum), so a cycle test that
 * wrote `CAPPED_LADDER` would be quarantined back to the defaults.
 */
const STORED_LADDER: RetryPolicy = { maxAttempts: 3, baseMs: 5_000, maxMs: 5_000 };

/** The bounds AC-148 states for a ladder that has reached its ceiling. */
const CAP = 2_000;

/** Jitter source pinned to the top of the range, so the arithmetic shows. */
const TOP_JITTER = (): number => 1;

/** Jitter source pinned to the bottom of the range. */
const FLOOR_JITTER = (): number => 0;

/** Temporary root created per test. */
let tempRoot = '';

/** Data directory the store opens on. */
let dataDir = '';

/** Open store handle for the tests that drive a cycle. */
let store: ServiceStore;

/** Per-test setup the merged cases re-run by name. */
const beforeEachWork1 = async (): Promise<void> => {
    tempRoot = await mkdtemp(join(tmpdir(), 'mecha-turk-backoff-'));
    dataDir = join(tempRoot, 'store');
    store = await openStore({ dataDir });
};

beforeEach(beforeEachWork1);

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork2 = async (): Promise<void> => {
    vi.useRealTimers();
    await rm(tempRoot, { recursive: true, force: true });
};

afterEach(afterEachWork2);

/**
 * Build a logger that records every line it is asked to write.
 *
 * @returns The logger plus the lines it captured.
 */
function capturingLogger(): { readonly log: ServiceLogger; readonly lines: string[] } {
    const lines: string[] = [];
    const log = createLogger({
        level: 'debug',
        sink: (line: string) => {
            lines.push(line);
        },
    });

    return { log, lines };
}

/**
 * Build one active binding with only the assignment trigger on.
 *
 * @returns A complete stored binding record.
 */
function fixtureBinding(): BindingRecord {
    return {
        bindingId: BINDING_A,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

/**
 * Build the active account the fixture binding polls under.
 *
 * @returns A complete stored account record.
 */
function fixtureAccount(): Account {
    return {
        numericUserId: ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        displayName: null,
        startingPrompt: null,
        credential: { token: FIXTURE_TOKEN, kind: 'classic', verifiedAt: CREATED_AT },
        scopeCheck: { checkedAt: CREATED_AT, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
        verifiedAt: CREATED_AT,
        errorReason: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
    };
}

/**
 * Write one scan-state document carrying the recorded checkpoint.
 *
 * @param lastScanAt - Stamp the next cycle must retain or widen.
 */
async function plantScanState(lastScanAt: string | null): Promise<void> {
    const document = { bindings: { [BINDING_A]: { lastScanAt, lastError: null } } };
    await writeFile(join(dataDir, SCAN_STATE_FILE), JSON.stringify(document), 'utf8');
}

/** One attempt's recorded sleep. */
interface RecordedSleep {
    /** Milliseconds the driver was asked to wait. */
    readonly delayMs: number;
}

/**
 * Build an injected sleep that records instead of waiting.
 *
 * @returns The sleep plus the waits it recorded.
 */
function recordingSleep(): {
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly sleeps: RecordedSleep[];
} {
    const sleeps: RecordedSleep[] = [];

    return {
        sleep: async (milliseconds) => {
            sleeps.push({ delayMs: milliseconds });
        },
        sleeps,
    };
}

describe('the ladder arithmetic (006 FR-058)', () => {
    it('computes delay(n) = min(cap, base × 2^(n−2)) × jitte… (+4 cases)', async () => {
        // case: computes delay(n) = min(cap, base × 2^(n−2)) × jitter
        {
            const policy: RetryPolicy = { maxAttempts: 5, baseMs: 5_000, maxMs: 60_000 };

            // A jitter source of 1 is the top of the range, so the arithmetic is
            // visible without the random part: 5000, 10000, 20000, then capped.
            expect(backoffDelayMs({ policy, attempt: 2, random: TOP_JITTER })).toBe(5_000);
            expect(backoffDelayMs({ policy, attempt: 3, random: TOP_JITTER })).toBe(10_000);
            expect(backoffDelayMs({ policy, attempt: 4, random: TOP_JITTER })).toBe(20_000);
            expect(backoffDelayMs({ policy, attempt: 8, random: TOP_JITTER })).toBe(60_000);
            // The bottom of the jitter range halves it, and never goes below.
            expect(backoffDelayMs({ policy, attempt: 2, random: FLOOR_JITTER })).toBe(2_500);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: keeps every delay of a capped ladder inside [retryMaxMs / 2, retryMaxMs] (AC-148)
        {
            for (const random of [() => 0, () => 0.5, () => 1]) {
                for (let attempt = 2; attempt <= 4; attempt += 1) {
                    const delayMs = backoffDelayMs({ policy: CAPPED_LADDER, attempt, random });

                    expect(delayMs).toBeGreaterThanOrEqual(CAP / 2);
                    expect(delayMs).toBeLessThanOrEqual(CAP);
                }
            }
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: never lets a computed delay exceed the ceiling, whatever the jitter source answers
        {
            const policy: RetryPolicy = { maxAttempts: 10, baseMs: 1_000, maxMs: 8_000 };

            // A source outside [0, 1] is clamped rather than trusted (plan D7's
            // injectable is still a contract).
            for (const random of [() => -5, () => 0.25, () => 40]) {
                for (let attempt = 2; attempt <= 9; attempt += 1) {
                    expect(backoffDelayMs({ policy, attempt, random })).toBeLessThanOrEqual(policy.maxMs);
                }
            }
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: lets rate-limit guidance win even above the ceiling, and says so in the source
        {
            const record = nextWait({
                policy: CAPPED_LADDER,
                attempt: 2,
                guidanceSeconds: 120,
                random: () => 1,
            });

            expect(record).toEqual({ attempt: 2, delayMs: 120_000, source: 'guidance' });
            expect(record.delayMs).toBeGreaterThan(CAP);

            // Guidance shorter than the ladder is not a reason to wait less.
            const shorter = nextWait({ policy: CAPPED_LADDER, attempt: 2, guidanceSeconds: 1, random: () => 1 });
            expect(shorter.source).toBe('backoff');
            expect(shorter.delayMs).toBe(CAP);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: reports the wait before sleeping it, and sleeps exactly what it reported
        {
            const { sleep, sleeps } = recordingSleep();
            const seen: WaitRecord[] = [];

            const record = await waitForRetry({
                policy: CAPPED_LADDER,
                attempt: 3,
                guidanceSeconds: null,
                sleep,
                random: () => 1,
                onWait: (wait) => seen.push(wait),
            });

            expect(seen).toEqual([record]);
            expect(sleeps).toEqual([{ delayMs: record.delayMs }]);
            expect(record.delayMs).toBe(CAP);
        }
    });
});

/**
 * Build the real poller over a transport that answers from a script.
 *
 * @param answers - One response factory per request, in order; the last one
 *   repeats once the script runs out.
 * @returns The poller, its recorded waits, and the logger's captured lines.
 */
function scriptedPoller(answers: readonly (() => Response)[]): {
    readonly poller: GitHubIssuePoller;
    readonly sleeps: RecordedSleep[];
    readonly lines: string[];
} {
    const { log, lines } = capturingLogger();
    const { sleep, sleeps } = recordingSleep();
    let requests = 0;
    const poller = createGitHubIssuePoller(
        { log, sleep, random: () => 1 },
        async () => {
            const script = answers[Math.min(requests, answers.length - 1)];
            requests += 1;

            return script === undefined ? new Response('', { status: 500 }) : script();
        },
    );

    return { poller, sleeps, lines };
}

describe('the ladder over the real poller (006 T-010, AC-148, SC-116)', () => {
    /** The pace a cycle with {@link CAPPED_LADDER} would carry. */
    const pace: ListPace = {
        perPage: DEFAULT_CONFIG.perPage,
        retry: CAPPED_LADDER,
    };

    it('attempts a failing request up to retryMaxAttempts ti… (+3 cases)', async () => {
        // case: attempts a failing request up to retryMaxAttempts times, sleeping inside the bounds
        {
            const { poller, sleeps } = scriptedPoller([() => new Response('', { status: 500 })]);

            const result = await poller.listOpenIssues({
                token: FIXTURE_TOKEN,
                owner: 'acme',
                name: 'widget',
                since: null,
                pace,
            });

            expect(result.kind).toBe('unavailable');
            // Two waits for three attempts: the first attempt is immediate.
            expect(sleeps).toHaveLength(CAPPED_LADDER.maxAttempts - 1);
            for (const waited of sleeps) {
                expect(waited.delayMs).toBeGreaterThanOrEqual(CAP / 2);
                expect(waited.delayMs).toBeLessThanOrEqual(CAP);
            }
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: stops after one attempt when the credential is refused (auth-failed is never retried)
        {
            const { poller, sleeps } = scriptedPoller([() => new Response('', { status: 401 })]);

            const result = await poller.listOpenIssues({
                token: FIXTURE_TOKEN,
                owner: 'acme',
                name: 'widget',
                since: null,
                pace,
            });

            expect(result).toEqual({ kind: 'auth-failed' });
            expect(sleeps).toHaveLength(0);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: honours a retry-after longer than the ceiling on the real request path
        {
            const { poller, sleeps } = scriptedPoller([
                () => new Response('', { status: 429, headers: new Headers([['retry-after', '120']]) }),
                () => new Response('[]', { status: 200 }),
            ]);

            const result = await poller.listOpenIssues({
                token: FIXTURE_TOKEN,
                owner: 'acme',
                name: 'widget',
                since: null,
                pace,
            });

            expect(result.kind).toBe('ok');
            expect(sleeps).toEqual([{ delayMs: 120_000 }]);
            expect(sleeps[0]?.delayMs).toBeGreaterThan(CAP);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: logs every wait with its length and source, and no credential
        {
            const { poller, lines } = scriptedPoller([() => new Response('', { status: 500 })]);

            await poller.listOpenIssues({
                token: FIXTURE_TOKEN,
                owner: 'acme',
                name: 'widget',
                since: null,
                pace,
            });

            const waits = lines
                .filter((line) => line.includes('poll request waiting before its next attempt'))
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(waits).toHaveLength(CAPPED_LADDER.maxAttempts - 1);
            for (const wait of waits) {
                expect(wait.source).toBe('backoff');
                expect(typeof wait.delayMs).toBe('number');
                expect(wait.attempt).toBeGreaterThanOrEqual(2);
            }
            expect(lines.join('\n')).not.toContain(FIXTURE_TOKEN);
        }
    });
});

/**
 * Plant the bindings, the account, and a stored ladder, then run one cycle
 * over a transport that never succeeds.
 *
 * @param answers - One response factory per request.
 * @returns The cycle outcome, the recorded waits, and the checkpoint after.
 */
async function cycleOver(answers: readonly (() => Response)[]): Promise<{
    readonly skipped: string | null;
    readonly sleeps: readonly RecordedSleep[];
    readonly lastScanAt: string | null;
}> {
    await writeBindings({ store, bindings: [fixtureBinding()] });
    await writeAccount(store, fixtureAccount());
    await store.writeJson(CONFIG_FILE, {
        ...DEFAULT_CONFIG,
        retryMaxAttempts: STORED_LADDER.maxAttempts,
        retryBaseMs: STORED_LADDER.baseMs,
        retryMaxMs: STORED_LADDER.maxMs,
    });
    await plantScanState(RECORDED_SCAN_AT);
    const { log } = capturingLogger();
    const { poller, sleeps } = scriptedPoller(answers);

    const cycle = await runScanCycle({ store, log, poller });
    const state = await readScanState({ store, log });

    return {
        skipped: cycle.bindings[0]?.skipped ?? null,
        sleeps,
        lastScanAt: state.bindings[BINDING_A]?.lastScanAt ?? null,
    };
}

describe('a skipped scan keeps its checkpoint (006 FR-058, 002 FR-018)', () => {
    it('retains the recorded lastScanAt after the ladder is … (+1 cases)', async () => {
        // case: retains the recorded lastScanAt after the ladder is exhausted
        {
            const outcome = await cycleOver([() => new Response('', { status: 500 })]);

            expect(outcome.skipped).toBe('upstream');
            expect(outcome.sleeps).toHaveLength(STORED_LADDER.maxAttempts - 1);
            for (const waited of outcome.sleeps) {
                expect(waited.delayMs).toBeGreaterThanOrEqual(STORED_LADDER.maxMs / 2);
                expect(waited.delayMs).toBeLessThanOrEqual(STORED_LADDER.maxMs);
            }
            // Not advanced past data that was never durably represented, and not
            // cleared to a full replay: the stamp the cycle started with survives.
            expect(outcome.lastScanAt).toBe(RECORDED_SCAN_AT);
        }
        await afterEachWork2();
        await beforeEachWork1();
        await afterEachWork2();
        await beforeEachWork1();
        // case: retains it after an auth refusal too, with no wait at all
        {
            const outcome = await cycleOver([() => new Response('', { status: 401 })]);

            expect(outcome.skipped).toBe('auth-failed');
            expect(outcome.sleeps).toHaveLength(0);
            expect(outcome.lastScanAt).toBe(RECORDED_SCAN_AT);
        }
    });
});

describe('the wait delays the schedule instead of being caught up (002 FR-022)', () => {
    /** Interval the fixture config arms with — the field's documented minimum. */
    const INTERVAL_MS = 15_000;

    /** Ladder the fixture config carries: 5 000 then 10 000, no jitter. */
    const LADDER: RetryPolicy = { maxAttempts: 3, baseMs: 5_000, maxMs: 60_000 };

    it('arms the next cycle from the cycle end, never from its start', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

        try {
            await writeBindings({ store, bindings: [fixtureBinding()] });
            await writeAccount(store, fixtureAccount());
            await store.writeJson(CONFIG_FILE, {
                ...DEFAULT_CONFIG,
                intervalMs: INTERVAL_MS,
                retryMaxAttempts: LADDER.maxAttempts,
                retryBaseMs: LADDER.baseMs,
                retryMaxMs: LADDER.maxMs,
            });
            const { log } = capturingLogger();
            const fetchStamps: number[] = [];
            // The production sleep (a real timer) runs on the fake clock, so
            // the waits are observed without a single real millisecond passing.
            const poller = createGitHubIssuePoller({ log, random: () => 1 }, async () => {
                fetchStamps.push(Date.now());
                if (fetchStamps.length < LADDER.maxAttempts) {
                    return new Response('', { status: 500 });
                }

                return new Response('[]', { status: 200 });
            });

            const loop = startPollLoop({ store, log, poller });

            /**
             * Let the event loop turn — real file I/O needs a real turn —
             * without moving the virtual clock, so the fixture's reads can
             * finish while time stays exactly where the test put it. The cap
             * is wall-clock, not a turn count, because a loaded worker pool
             * needs more turns to finish the same handful of reads.
             *
             * @param until - Condition worth waiting for.
             */
            const flush = async (until: () => boolean): Promise<void> => {
                const deadline = performance.now() + 5_000;
                while (!until() && performance.now() < deadline) {
                    await vi.advanceTimersByTimeAsync(0);
                    await new Promise<void>((resolve) => {
                        setImmediate(resolve);
                    });
                }
            };

            try {
                await flush(() => fetchStamps.length >= 1);
                expect(loop.state().nextPollAtMs).toBeNull();

                await vi.advanceTimersByTimeAsync(LADDER.baseMs + LADDER.baseMs * 2);
                await flush(() => loop.state().nextPollAtMs !== null);

                const nextAtMs = loop.state().nextPollAtMs;
                const cycleStart = fetchStamps[0] ?? 0;
                const waitsFinished = fetchStamps[fetchStamps.length - 1] ?? 0;

                expect(fetchStamps).toHaveLength(LADDER.maxAttempts);
                expect(waitsFinished - cycleStart).toBe(15_000);
                // Armed one interval after the cycle *ended* — so the waits
                // pushed the schedule out rather than being made up.
                expect(nextAtMs).toBe(waitsFinished + INTERVAL_MS);
                expect(nextAtMs).toBeGreaterThan(cycleStart + INTERVAL_MS);
            } finally {
                loop.stop();
            }
        } finally {
            vi.useRealTimers();
        }
    });
});
