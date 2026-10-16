/**
 * The Logs tab's refresh cadence (010 FR-005; AC-005, AC-006, AC-008,
 * AC-010).
 *
 * Every clause is a claim about **time**, so this file drives a clock rather
 * than sleeping: `setInterval`, `clearInterval`, and `Date` run on vitest's
 * fake timers, the panel's reads are a scripted host double that records every
 * request with the virtual stamp it was issued at, and the tab is mounted
 * through the real `tabSpecs` so the thing under test is the production
 * wiring — `tests/status-refresh.test.ts`'s shape, over the second cadence
 * tab.
 *
 * What is proved here, clause by clause:
 *
 * - **AC-005** one read at activation and exactly one more per reported
 *   period, asserted at the boundary; zero reads across three periods with
 *   Dispatches active; a tick during an in-flight read issues one request and
 *   queues nothing, and the missed tick is missed; a late tick reads once with
 *   no catch-up burst; teardown returns the timer count to its pre-mount
 *   value from Logs and from another tab; three refused ticks leave one stale
 *   marker, the cause named, the stamp unmoved, and the period unchanged;
 * - **AC-006** no readable `intervalMs` means no tick and no invented number,
 *   then a later answer that carries one arms without a remount; a re-arm
 *   follows a changed interval, and an interval-less answer disarms;
 * - **AC-008** a failed tick triggers no request between the failure and the
 *   next scheduled tick or the operator's retry, and recovery arms from the
 *   answer with no reload and no `host.startSession()`;
 * - **AC-010** a burst moves the stream, not the panel: one request per
 *   period, each answer a bounded page, the hold capped.
 *
 * Offline: the fake host, the fake DOM, and a recorded SDK. No live host, no
 * token, no network (FR-086, NFR-105).
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { LOGS_REFRESH_LABEL, logsReadStateLine } from '../src/logs-rows.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import { NO_SESSION, createTestRuntime, fakeHost } from './support/panel.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });

                return {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => undefined,
                };
            };
        }
    }

    return stubbed;
});

/** The period every fixture reports — the service's own default. */
const PERIOD_MS = 60_000;

/** The shorter period the interval-change case reports. */
const SHORT_PERIOD_MS = 30_000;

/** How the cadence statement names {@link PERIOD_MS} — in words (FR-101). */
const PERIOD_TEXT = '60 seconds';

/** Path the stream is read from. */
const LOGS_PATH = '/v1/logs';

/** The process stamp every non-restart fixture carries. */
const STARTED_AT = 1_700_000_000_000;

/** Body the unrouted paths answer with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/** One scriptable answer for a service path. */
type Answer = (request: GuestRequest) => Promise<GuestRequestResult>;

/** One recorded request, with the virtual stamp it was issued at. */
interface Recorded {
    readonly path: string;
    readonly atMs: number;
}

/** Everything a driven-clock run needs to assert on. */
interface Harness {
    readonly rt: PanelRuntime;
    /** Every request the panel issued, in order. */
    readonly requests: Recorded[];
    /** How many `host.startSession()` calls the panel made. */
    readonly sessions: () => number;
    /** Replace the answer for one path, keeping the log. */
    answer(path: string, next: Answer): void;
    /** How many requests went to `path`. */
    countOf(path: string): number;
}

/** One serialized line, as the service writes them. */
function logLine(seq: number): string {
    return `${JSON.stringify({ ts: '2026-10-16T00:00:00.000Z', level: 'info', message: `line ${seq}` })}\n`;
}

/** One answer body: entries, the process stamp, and optionally the cadence. */
function logsBody(input: {
    readonly seqs: readonly number[];
    readonly startedAt?: number;
    readonly intervalMs?: number;
}): string {
    return JSON.stringify({
        entries: input.seqs.map((seq) => ({ seq, line: logLine(seq) })),
        startedAt: input.startedAt ?? STARTED_AT,
        ...(input.intervalMs !== undefined && { intervalMs: input.intervalMs }),
    });
}

/** An answer that serves one line at `intervalMs` (or interval-less when `null`). */
function answering(intervalMs: number | null, seqs: readonly number[] = [1]): Answer {
    return async () => ({
        status: 200,
        body: logsBody({ seqs, ...(intervalMs !== null && { intervalMs }) }),
    });
}

/** An answer that refuses every request with one status code and cause. */
function refusing(status: number, body: string): Answer {
    return async () => ({ status, body });
}

/**
 * Mount the real tab shell over a driven clock and a scripted service.
 *
 * The tabs are the production `tabSpecs`, so the Logs body's own mount and
 * disposer are the ones under test — a suite that hand-built a Logs body
 * would prove nothing about the tick's teardown.
 */
async function mountDriven(answer: Answer): Promise<Harness> {
    const requests: Recorded[] = [];
    let sessions = 0;
    const answers = new Map<string, Answer>([[LOGS_PATH, answer]]);
    const rt = createTestRuntime(fakeHost({
        serviceRequest: async (request) => {
            requests.push({ path: request.path, atMs: Date.now() });
            // Prefix match, so a cursor read (`/v1/logs?cursor=7`) still finds
            // the path's script — the same answer the route would give with
            // or without its query.
            const scripted = [...answers].find(([path]) => request.path.startsWith(path))?.[1];

            return scripted === undefined ? { status: 404, body: UNROUTED } : await scripted(request);
        },
        startSession: async () => {
            sessions += 1;

            return NO_SESSION;
        },
    }));
    const dom = fakeDom();
    mounts.log.length = 0;
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt) });

    return {
        rt,
        requests,
        sessions: () => sessions,
        answer: (path, next) => {
            answers.set(path, next);
        },
        countOf: (path) => requests.filter((entry) => entry.path.startsWith(path)).length,
    };
}

/**
 * Let the fired reads finish without moving the virtual clock.
 *
 * The tick fires synchronously, `loadLogs` then awaits the host double, and
 * the arming happens after that await — so a case that advanced the clock and
 * asserted immediately would read the state from *before* the tick's own read
 * landed.
 */
async function settle(): Promise<void> {
    for (let turn = 0; turn < 4; turn += 1) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

/** Advance the driven clock, letting every fired read land. */
async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
}

/** Teardown that leaves nothing armed, whatever the panel was showing. */
function tearDown(rt: PanelRuntime): void {
    rt.shell?.dispose();
    rt.disposed = true;
}

/**
 * Every logs request's virtual stamp, relative to the first one — every
 * timing claim is a *gap between* requests, never an absolute reading.
 */
function logsGaps(run: Harness): readonly number[] {
    const stamps = run.requests
        .filter((entry) => entry.path.startsWith(LOGS_PATH))
        .map((entry) => entry.atMs);
    const first = stamps[0] ?? 0;

    return stamps.map((stamp) => stamp - first);
}

/** Read every string the SDK was handed, from a point in the mount log onward. */
function renderedSince(from = 0): readonly string[] {
    const found: string[] = [];
    const walk = (value: unknown): void => {
        if (typeof value === 'string') {
            found.push(value);

            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                walk(item);
            }

            return;
        }

        if (typeof value === 'object' && value !== null) {
            for (const item of Object.values(value)) {
                walk(item);
            }
        }
    };

    for (const entry of mounts.log.slice(from)) {
        walk(entry.props);
    }

    return found;
}

/** The Logs tab's on-demand refresh control, as the SDK was handed it. */
function refreshControl(): { readonly onClick: () => void } | undefined {
    const entry = mounts.log.find(
        (candidate) => candidate.key === 'mountButton'
            && (candidate.props as { readonly label?: string }).label === LOGS_REFRESH_LABEL,
    );

    return entry === undefined ? undefined : (entry.props as { readonly onClick: () => void });
}

describe('AC-005 the tab re-reads on the reported period, and only on it', () => {
    it('reads once at activation and once more per 60 s, asserted at the boundary', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;

            rt.shell?.activate('logs');
            await settle();
            expect(run.countOf(LOGS_PATH)).toBe(1);
            expect(rt.logsRefreshMs).toBe(PERIOD_MS);

            await advance(PERIOD_MS - 1_000);
            expect(run.countOf(LOGS_PATH), 'nothing fires before the period').toBe(1);

            await advance(1_000);
            expect(run.countOf(LOGS_PATH), 'the boundary is inclusive').toBe(2);

            await advance(PERIOD_MS * 2);
            expect(run.countOf(LOGS_PATH), 'three periods, three more reads').toBe(4);

            // One period per read and no faster loop: every read came a full
            // interval after the one before it.
            expect(logsGaps(run)).toEqual([0, PERIOD_MS, PERIOD_MS * 2, PERIOD_MS * 3]);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('issues zero reads across three periods while Dispatches is active', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();
            expect(run.countOf(LOGS_PATH), 'the activation read').toBe(1);

            rt.shell?.activate('dispatches');
            await settle();
            const requestsAtRest = run.requests.length;
            const logsReads = run.countOf(LOGS_PATH);

            await advance(PERIOD_MS * 3);

            expect(run.requests.length, 'three periods, and the panel reads nothing').toBe(requestsAtRest);
            expect(run.countOf(LOGS_PATH), 'a backgrounded Logs issues no reads').toBe(logsReads);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses a tick during an in-flight read, and the missed tick is missed', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const gate = { release: (): void => undefined };
            let isHeld = true;
            const run = await mountDriven(async () => {
                if (isHeld) {
                    // A read that hangs: the tick has to be refused, not queued.
                    await new Promise<void>((resolve) => {
                        gate.release = resolve;
                    });
                }

                return { status: 200, body: logsBody({ seqs: [1], intervalMs: PERIOD_MS }) };
            });
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();
            expect(run.countOf(LOGS_PATH), 'the activation read is in flight').toBe(1);
            expect(rt.state.logsTab.phase).toBe('loading');

            await advance(PERIOD_MS);
            expect(run.countOf(LOGS_PATH), 'the tick did not stack a second request').toBe(1);
            expect(rt.state.logsTab.phase).toBe('loading');

            isHeld = false;
            gate.release();
            await settle();
            expect(rt.state.logsTab.phase).toBe('loaded');

            // The tick at 60 s produced **no request**, so the next request
            // lands two periods after the one already in flight — the
            // difference between a missed tick and a backlog made up.
            await advance(PERIOD_MS);
            expect(run.countOf(LOGS_PATH)).toBe(2);
            await advance(PERIOD_MS);
            expect(run.countOf(LOGS_PATH)).toBe(3);
            expect(logsGaps(run)).toEqual([0, PERIOD_MS * 2, PERIOD_MS * 3]);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reads once for a coarse advance — no catch-up burst', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();

            // Two and a half periods in one jump, the fake-clock shape of a
            // throttled tab: each elapsed period produces exactly one read,
            // each a full interval after the last — nothing bunched at the end.
            await advance(PERIOD_MS * 2 + PERIOD_MS / 2);
            expect(run.countOf(LOGS_PATH)).toBe(3);
            expect(logsGaps(run)).toEqual([0, PERIOD_MS, PERIOD_MS * 2]);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns the timer count to its pre-mount value from Logs and from another tab', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            for (const finalTab of ['logs', 'bindings'] as const) {
                const before = vi.getTimerCount();
                const run = await mountDriven(answering(PERIOD_MS));
                const { rt } = run;
                rt.shell?.activate('logs');
                await settle();

                expect(vi.getTimerCount(), `${finalTab}: the tick is armed`).toBe(before + 1);

                rt.shell?.activate(finalTab);
                await settle();
                const reads = run.countOf(LOGS_PATH);

                rt.shell?.dispose();

                expect(rt.logsRefreshTimer, `${finalTab}: no handle survives`).toBeNull();
                expect(rt.logsRefreshMs, `${finalTab}: no period survives`).toBeNull();
                expect(vi.getTimerCount(), `${finalTab}: timer count returns to pre-mount`).toBe(before);

                await advance(PERIOD_MS * 3);
                expect(run.countOf(LOGS_PATH), `${finalTab}: no read after teardown`).toBe(reads);

                rt.disposed = true;
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves one stale marker, an unmoved stamp, and the same period over three refused ticks', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();
            const landedAt = rt.state.logsTab.at;
            expect(landedAt).not.toBeNull();
            expect(rt.state.logsTab.lines).toHaveLength(1);

            // Three consecutive refused ticks, each with its own cause so a
            // marker that accumulated would show it.
            const refusals = [502, 504, 503];
            for (const status of refusals) {
                run.answer(LOGS_PATH, refusing(status, `refused with ${status}`));
                await advance(PERIOD_MS);
            }

            const slice = rt.state.logsTab;
            expect(slice.phase).toBe('failed');
            expect(slice.stale, 'the last lines are kept').toBe(true);
            expect(slice.lines, 'and they are still the ones on screen').toHaveLength(1);
            expect(slice.at, 'the stamp describes the data on screen, so it does not move').toBe(landedAt);

            // One marker, naming one cause — not one per tick.
            const line = logsReadStateLine(slice);
            expect(line).toContain('may be stale');
            expect(line.match(/may be stale/gu)).toHaveLength(1);
            expect(line).toContain(String(refusals.at(-1)));
            const earlierRefusals = refusals.slice(0, -1);
            for (const earlier of earlierRefusals) {
                expect(line, `the ${earlier} refusal must not be stacked`).not.toContain(String(earlier));
            }

            expect(run.countOf(LOGS_PATH)).toBe(4);

            // The period does not chase the failure: every read a full period
            // after the last — no backoff, no shortened period, no fast retry.
            expect(logsGaps(run)).toEqual([0, PERIOD_MS, PERIOD_MS * 2, PERIOD_MS * 3]);
            expect(rt.logsRefreshMs, 'still the reported interval').toBe(PERIOD_MS);

            // The button is live and reads on demand.
            const press = refreshControl()?.onClick;
            expect(press).toBeTypeOf('function');
            run.answer(LOGS_PATH, answering(PERIOD_MS));
            press?.();
            await settle();

            expect(run.countOf(LOGS_PATH)).toBe(5);
            expect(rt.state.logsTab.stale, 'the stale mark clears on the read that lands').toBe(false);
            expect(rt.state.logsTab.at, 'and the stamp moves only now').not.toBe(landedAt);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('AC-006 no interval means no tick and no invented number', () => {
    it('arms nothing over three periods, states it in words, then arms without a remount', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const before = vi.getTimerCount();
            const run = await mountDriven(answering(null));
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();

            expect(run.countOf(LOGS_PATH), 'the interval-less activation read').toBe(1);
            expect(rt.state.logsTab.phase, 'the answer still loads').toBe('loaded');
            expect(rt.logsRefreshMs, 'nothing armed').toBeNull();
            expect(rt.logsRefreshTimer).toBeNull();
            expect(vi.getTimerCount()).toBe(before);

            await advance(PERIOD_MS * 3);
            expect(run.countOf(LOGS_PATH), 'no tick was ever armed').toBe(1);

            // No period anywhere on the tab — the word-form period appears
            // only when a tick is armed.
            const rendered = renderedSince().join('\n');
            for (const invented of ['60,000', '60000', 'every 60', PERIOD_TEXT, '1 minute', '30,000', '15,000']) {
                expect(rendered, invented).not.toContain(invented);
            }

            expect(rendered).toContain('not refreshing itself');
            expect(rendered).toContain(LOGS_REFRESH_LABEL);

            // A later answer that carries one arms without a remount, and the
            // statement names the period.
            const ui = rt.logsUi;
            run.answer(LOGS_PATH, answering(PERIOD_MS));
            rt.shell?.activate('logs');
            await settle();

            expect(rt.logsUi, 'no remount').toBe(ui);
            expect(rt.tabMounted.has('logs'), 'still the one mount').toBe(true);
            expect(rt.logsRefreshMs).toBe(PERIOD_MS);
            const armed = renderedSince().join('\n');
            expect(armed).toContain('re-reads itself every');
            expect(armed).toContain(PERIOD_TEXT);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-arms to a changed interval, and an interval-less answer disarms', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const before = vi.getTimerCount();
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();
            expect(rt.logsRefreshMs).toBe(PERIOD_MS);

            run.answer(LOGS_PATH, answering(SHORT_PERIOD_MS));
            rt.shell?.activate('logs');
            await settle();
            expect(rt.logsRefreshMs, 'the period follows the answer').toBe(SHORT_PERIOD_MS);

            await advance(SHORT_PERIOD_MS);
            expect(run.countOf(LOGS_PATH), 'the new boundary fires').toBe(3);

            // Plan pin 8: an interval-less answer disarms anything armed, so
            // the statement and the timer cannot disagree.
            run.answer(LOGS_PATH, answering(null));
            await advance(SHORT_PERIOD_MS);
            expect(rt.state.logsTab.phase).toBe('loaded');
            expect(rt.logsRefreshMs, 'disarmed by the interval-less answer').toBeNull();
            expect(rt.logsRefreshTimer).toBeNull();
            expect(vi.getTimerCount()).toBe(before);
            expect(renderedSince().join('\n')).toContain('not refreshing itself');

            await advance(SHORT_PERIOD_MS * 3);
            expect(run.countOf(LOGS_PATH), 'no tick survives the disarm').toBe(4);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('AC-008 a failed tick is a failing read, and recovery needs no reload', () => {
    it('triggers no request between the failure and the next tick or the retry', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();

            run.answer(LOGS_PATH, refusing(503, 'the service refused'));
            await advance(PERIOD_MS);
            expect(run.countOf(LOGS_PATH), 'the refused tick').toBe(2);
            expect(rt.state.logsTab.phase).toBe('failed');

            // Half a period of quiet: a cadence is not a retry loop, so the
            // failure buys no request of its own.
            await advance(PERIOD_MS / 2);
            expect(run.countOf(LOGS_PATH), 'no request between failure and schedule').toBe(2);

            // Recovery: the operator's retry lands the stream, arms from the
            // answer, and changes nothing else — no reload, no session.
            const ui = rt.logsUi;
            run.answer(LOGS_PATH, answering(PERIOD_MS));
            const press = refreshControl()?.onClick;
            expect(press).toBeTypeOf('function');
            press?.();
            await settle();

            expect(run.countOf(LOGS_PATH), 'the retry is the one request').toBe(3);
            expect(rt.state.logsTab.phase).toBe('loaded');
            expect(rt.state.logsTab.stale).toBe(false);
            expect(rt.logsRefreshMs).toBe(PERIOD_MS);
            expect(rt.logsUi, 'no remount').toBe(ui);
            expect(run.sessions(), 'no session was ever started').toBe(0);

            // …and the next read is the scheduled one, not an eager repeat of
            // the retry.
            await advance(PERIOD_MS / 4);
            expect(run.countOf(LOGS_PATH), 'no read between the retry and the schedule').toBe(3);
            await advance(PERIOD_MS / 4);
            expect(run.countOf(LOGS_PATH), 'the scheduled tick fires at its own boundary').toBe(4);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('AC-010 a burst moves the stream, not the panel', () => {
    it('issues one request per period, each answer a bounded page, and never holds past the cap', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const BURST = 500;
            const PAGE = 200;
            let produced = 0;
            const pages: number[] = [];
            // The service keeps producing between reads and answers the route's
            // own bounded page: the newest `PAGE` for a tail read, the next
            // `PAGE` behind a cursor.
            const scripted: Answer = async (request) => {
                produced += BURST;
                const cursorText = new URL(request.path, 'http://loopback').searchParams.get('cursor');
                const cursor = cursorText === null ? 0 : Number(cursorText);
                const from = cursor + 1;
                const to = Math.min(from + PAGE - 1, produced);
                const seqs: number[] = [];
                for (let seq = from; seq <= to; seq += 1) {
                    seqs.push(seq);
                }
                pages.push(seqs.length);

                return { status: 200, body: logsBody({ seqs, intervalMs: PERIOD_MS }) };
            };
            const run = await mountDriven(scripted);
            const { rt } = run;
            rt.shell?.activate('logs');
            await settle();

            await advance(PERIOD_MS * 5);
            expect(run.countOf(LOGS_PATH), 'one activation read plus one per period').toBe(6);
            expect(logsGaps(run)).toEqual([
                0, PERIOD_MS, PERIOD_MS * 2, PERIOD_MS * 3, PERIOD_MS * 4, PERIOD_MS * 5,
            ]);
            expect(pages.every((size) => size <= PAGE), 'every answer is a bounded page').toBe(true);

            // Pages of 200 against 3 000 produced lines: the hold mirrors
            // the ring at its own 1 000-line cap, drop-oldest, while the rest
            // of the burst is simply not fetched yet — the tab trails and
            // claims nothing about completeness.
            const held = rt.state.logsTab.lines;
            expect(held).toHaveLength(1_000);
            expect(held.at(0)?.seq, 'the own-oldest lines are dropped').toBe(201);
            expect(held.at(-1)?.seq, 'and the newest fetched line is held').toBe(1_200);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});
