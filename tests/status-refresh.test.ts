/**
 * The Status tab's refresh cadence (005 v1.16.0, GitHub issue #20).
 *
 * Every clause of `005 SC-114` is a claim about **time**, so this file drives
 * a clock rather than sleeping: `setInterval`, `clearInterval`, and `Date` run
 * on vitest's fake timers, the panel's reads are a scripted host double that
 * records every request with the virtual stamp it was issued at, and the tab is
 * mounted through the real `tabSpecs` so the thing under test is the production
 * wiring rather than a hand-built one.
 *
 * What is proved here, clause by clause:
 *
 * - **(a)** one read at activation and exactly one more per reported period,
 *   asserted at 59 s, 60 s, and 180 s — the boundary is the whole claim;
 * - **(b)** the other five tabs issue **zero** reads while Status ticks;
 * - **(c)** activation is the only read those five get, asserted per tab;
 * - **(d)** after teardown the clock moves three more periods, the read count
 *   does not, and the timer count is back to its pre-mount value — from Status
 *   and from another tab, because NFR-108 counts both;
 * - **(e)** a later document reporting a different interval re-arms the tick;
 * - **(f)** no interval means **no tick and no invented number** — a refused
 *   read, a document whose `polling.intervalMs` the fail-closed parser refuses
 *   the whole document over, a configured interval that disagrees with the
 *   effective one, and a supplementary configuration read that failed;
 * - **(g)** three refused ticks leave **one** stale marker, not three, the stamp
 *   unmoved, the button live, and the fourth period at the same interval;
 * - **(h)** a tick during an in-flight read is a no-op — one request, not two.
 *
 * Offline: the fake host, the fake DOM, and a recorded SDK. No live host, no
 * token, no network (FR-086, NFR-105).
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelRuntime, TabId } from '../src/panel-state.ts';
import { parseStatusView } from '../src/status-document.ts';
import type { StatusView } from '../src/status-document.ts';
import { cadenceLine, pollingLines, readStateLine } from '../src/status-lines.ts';
import { fakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';

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

/** The picker callbacks the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** The five tabs FR-100 gives no cadence, in strip order. */
const OTHER_TABS: readonly TabId[] = ['dispatches', 'bindings', 'accounts', 'settings', 'about'];

/** The period every fixture reports — the service's own default. */
const PERIOD_MS = 60_000;

/** The shorter period the interval-change case reports. */
const SHORT_PERIOD_MS = 30_000;

/**
 * How the copy renders {@link PERIOD_MS}, which groups its digits the way the
 * Polling block already does (005 `FR-030`).
 */
const PERIOD_TEXT = '60,000';

/** Path the projection is read from. */
const STATUS_PATH = '/v1/status';

/** Path the supplementary configuration read uses. */
const CONFIG_PATH = '/v1/config';

/** The label FR-101 requires the interval-less copy to name. */
const REFRESH_LABEL = 'Refresh status';

/** Body the unrouted paths answer with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/** Stamp every fixture's next poll points at, so nothing reads overdue. */
const FUTURE_STAMP = '2099-01-01T00:00:00.000Z';

/** One scriptable answer for a service path. */
type Answer = (request: GuestRequest) => Promise<GuestRequestResult>;

/** One recorded request, with the virtual stamp it was issued at. */
interface Recorded {
    /** The path the panel asked for. */
    readonly path: string;
    /** The virtual clock reading when the panel issued it. */
    readonly atMs: number;
}

/** Everything a driven-clock run needs to assert on. */
interface Harness {
    /** The runtime the shell mounted against. */
    readonly rt: PanelRuntime;
    /** Every request the panel issued, in order. */
    readonly requests: Recorded[];
    /** Replace the answer for one path, keeping the log. */
    answer(path: string, next: Answer): void;
    /** How many requests went to `path`. */
    countOf(path: string): number;
}

/** The document every fixture starts from. */
function statusBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        service: {
            status: 'ok',
            uptimeMs: 61_000,
            dataDir: '/home/agent/.config/openchamber/mecha-turk',
            schemaVersion: 1,
            storage: { writable: true },
        },
        accounts: [
            {
                numericUserId: '77331',
                login: 'octocat-mt',
                connectionState: 'connected',
                rate: { remaining: null, limit: null, resetAt: null, usedLastHour: 0 },
            },
        ],
        repositories: [
            {
                bindingId: 'bnd_refresh_1',
                repository: 'acme/widget',
                projectId: 'prj_42',
                accountLogin: 'octocat-mt',
                active: true,
                lastScanAt: '2026-09-28T12:00:00.000Z',
                lastError: null,
                pendingCount: 2,
                readable: true,
                actorPolicy: 'open',
            },
        ],
        agentPin: { expectedAgent: null, lastVerification: null },
        polling: { intervalMs: PERIOD_MS, nextPollAt: FUTURE_STAMP, paused: false, pausedReason: '' },
        surface: { supported: true },
        ...overrides,
    });
}

/** A configuration document carrying one interval. */
function configBody(intervalMs: number): string {
    return JSON.stringify({ config: { intervalMs } });
}

/** A projection document whose effective interval is `intervalMs`. */
function pollingAt(intervalMs: number): Record<string, unknown> {
    return { intervalMs, nextPollAt: FUTURE_STAMP, paused: false, pausedReason: '' };
}

/** An answer that serves the projection at `intervalMs` and a matching config. */
function answering(intervalMs: number): Answer {
    return async (request) => ({
        status: 200,
        body: request.path === CONFIG_PATH ? configBody(intervalMs) : statusBody({ polling: pollingAt(intervalMs) }),
    });
}

/** An answer that refuses every request with one status code and cause. */
function refusing(status: number, body: string): Answer {
    return async () => ({ status, body });
}

/**
 * The document the tab currently holds, failing loudly when it holds none.
 *
 * Narrowing at the call site would need a non-null assertion, and a test that
 * asserts `doc !== null` separately still has to hand something typed to the
 * line builders.
 *
 * @param rt - The runtime to read the tab's document from.
 * @returns The parsed document.
 */
function landedView(rt: PanelRuntime): StatusView {
    const view = rt.state.statusTab.doc;
    if (view === null) {
        throw new Error('the Status tab holds no document');
    }

    return view;
}

/**
 * Mount the real six-tab shell over a driven clock and a scripted service.
 *
 * The tabs are the production `tabSpecs`, so the Status body's own mount and
 * disposer are the ones under test — a suite that hand-built a Status body
 * would prove nothing about the tick's teardown.
 *
 * @returns The runtime, the request log, and the two recorders a test uses.
 */
async function mountDriven(answer: Answer): Promise<Harness> {
    const requests: Recorded[] = [];
    const answers = new Map<string, Answer>([[STATUS_PATH, answer], [CONFIG_PATH, answer]]);
    const rt = createTestRuntime(fakeHost({
        serviceRequest: async (request) => {
            requests.push({ path: request.path, atMs: Date.now() });
            const scripted = answers.get(request.path);

            return scripted === undefined ? { status: 404, body: UNROUTED } : await scripted(request);
        },
    }));
    const dom = fakeDom();
    mounts.log.length = 0;
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });

    return {
        rt,
        requests,
        answer: (path, next) => {
            answers.set(path, next);
        },
        countOf: (path) => requests.filter((entry) => entry.path === path).length,
    };
}

/**
 * Let the fired reads finish without moving the virtual clock.
 *
 * The tick fires synchronously, `loadStatus` then awaits the host double, and
 * the arming happens after that await — so a case that advanced the clock and
 * asserted immediately would read the state from *before* the tick's own read
 * landed. Four turns is more than the panel needs and costs nothing — the clock
 * does not move, so a loaded worker pool cannot make an assertion a race.
 *
 * @returns A promise resolved once the fired reads have settled.
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
 * Every projection request's virtual stamp, relative to the first one.
 *
 * The fake clock starts at the wall clock rather than at zero, so every timing
 * claim is a *gap between* requests rather than an absolute reading — which is
 * also the only form AC-152 states ("no request earlier than one full interval
 * after the previous one").
 *
 * @param run - The harness whose log is read.
 * @returns The gaps in milliseconds, first request first.
 */
function statusGaps(run: Harness): readonly number[] {
    const stamps = run.requests.filter((entry) => entry.path === STATUS_PATH).map((entry) => entry.atMs);
    const first = stamps[0] ?? 0;

    return stamps.map((stamp) => stamp - first);
}

/**
 * Read every string the SDK was handed, from a point in the mount log onward.
 *
 * @param from - Index into the mount log; the whole log when `0`.
 * @returns The strings, in the order they rendered.
 */
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

/** Read every string the Status body handed the SDK, in the order it rendered. */
function renderedStrings(): readonly string[] {
    return renderedSince();
}

/**
 * The Status tab's on-demand refresh control, as the SDK was handed it.
 *
 * Located by label rather than by position because three of the six tabs mount
 * buttons and only this one is the read the cadence falls back to (FR-101).
 *
 * @returns The props carrying the press handler, or `undefined` when absent.
 */
function refreshControl(): { readonly onClick: () => void } | undefined {
    const entry = mounts.log.find(
        (candidate) => candidate.key === 'mountButton'
            && (candidate.props as { readonly label?: string }).label === REFRESH_LABEL,
    );

    return entry === undefined ? undefined : (entry.props as { readonly onClick: () => void });
}

describe('SC-114 (a) the tab re-reads on the reported period, and only on it', () => {
    it('reads once at activation and once more per 60 s, asserted at the boundary', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;

            // Activation: one read, one status request plus its supplementary
            // configuration read. The tab cannot be armed before this lands,
            // which is the interval-less window FR-100 §3 describes.
            rt.shell?.activate('status');
            await settle();
            expect(run.countOf(STATUS_PATH)).toBe(1);
            expect(rt.statusRefreshMs).toBe(PERIOD_MS);

            await advance(PERIOD_MS - 1_000);
            expect(run.countOf(STATUS_PATH), 'nothing fires before the period').toBe(1);

            await advance(1_000);
            expect(run.countOf(STATUS_PATH), 'the boundary is inclusive').toBe(2);

            await advance(PERIOD_MS * 2);
            expect(run.countOf(STATUS_PATH), 'three periods, three more reads').toBe(4);

            // The panel holds exactly one period per read and no faster loop:
            // every read came a full interval after the one before it.
            expect(statusGaps(run)).toEqual([0, PERIOD_MS, PERIOD_MS * 2, PERIOD_MS * 3]);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('arms the tick from the document rather than from a default', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            // 15 000 is the field's documented minimum and 300 000 its maximum;
            // the panel takes whichever the service reports and neither.
            for (const reported of [15_000, 300_000]) {
                const run = await mountDriven(answering(reported));
                run.rt.shell?.activate('status');
                await settle();

                expect(run.rt.statusRefreshMs, String(reported)).toBe(reported);

                await advance(reported);
                expect(run.countOf(STATUS_PATH), String(reported)).toBe(2);

                tearDown(run.rt);
            }
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SC-114 (b, c) the other five tabs read on activation and never again', () => {
    it('issues no reads at all while Status ticks', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();

            // Bindings is the tab the criterion names. Its activation is the
            // one read it is entitled to, and the whole panel's request count
            // is snapshotted there so "no reads while Status ticks" is asserted
            // over every path rather than over the one that was easy to check.
            rt.shell?.activate('bindings');
            await settle();
            const requestsAtRest = run.requests.length;
            const statusReads = run.countOf(STATUS_PATH);

            expect(requestsAtRest, 'the activation that mounted it read').toBeGreaterThan(statusReads);

            await advance(PERIOD_MS * 3);

            expect(run.requests.length, 'three periods, and the panel reads nothing').toBe(requestsAtRest);
            expect(run.countOf(STATUS_PATH), 'a backgrounded Status issues no reads').toBe(statusReads);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-activating the already-active tab reads on Status and on the other four', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            // Non-vacuity: the loop below claims each of the five reads nothing
            // on re-activation, which is only a claim if activation reads at
            // least once for some tab. Settings reads its configuration
            // document at mount (the one body that does), so start there.
            rt.shell?.activate('settings');
            await settle();
            expect(run.countOf(CONFIG_PATH), 'the activation read this rests on').toBeGreaterThan(0);

            for (const id of OTHER_TABS) {
                rt.shell?.activate(id);
                await settle();
                const before = run.requests.length;

                // Re-activating the tab that already shows: the FR-014 rule,
                // asserted per tab rather than once for the set.
                rt.shell?.activate(id);
                await settle();

                expect(run.requests.length, `${id} re-activation reads nothing`).toBe(before);

                await advance(PERIOD_MS * 2);
                expect(run.requests.length, `${id} has no cadence`).toBe(before);

                // …and back to Status, which does read on re-activation.
                const statusBefore = run.countOf(STATUS_PATH);
                rt.shell?.activate('status');
                await settle();
                expect(run.countOf(STATUS_PATH), 'Status reads on every activation').toBe(statusBefore + 1);
            }

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SC-114 (d, NFR-108) teardown releases the tick from either tab', () => {
    it('returns the timer count to its pre-mount value and stops reading', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            for (const finalTab of ['status', 'bindings'] as const) {
                const before = vi.getTimerCount();
                const run = await mountDriven(answering(PERIOD_MS));
                const { rt } = run;
                rt.shell?.activate('status');
                await settle();

                expect(vi.getTimerCount(), `${finalTab}: the tick is armed`).toBe(before + 1);

                rt.shell?.activate(finalTab);
                await settle();
                const reads = run.countOf(STATUS_PATH);

                rt.shell?.dispose();

                expect(rt.statusRefreshTimer, `${finalTab}: no handle survives`).toBeNull();
                expect(rt.statusRefreshMs, `${finalTab}: no period survives`).toBeNull();
                expect(vi.getTimerCount(), `${finalTab}: timer count returns to pre-mount`).toBe(before);

                await advance(PERIOD_MS * 3);
                expect(run.countOf(STATUS_PATH), `${finalTab}: no read after teardown`).toBe(reads);

                // A second teardown disposes nothing new (FR-017, idempotent).
                rt.shell?.dispose();
                expect(vi.getTimerCount()).toBe(before);
                rt.disposed = true;
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves one tick, not two, however often the operator re-enters Status', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const before = vi.getTimerCount();
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();
            const armed = rt.statusRefreshTimer;
            expect(armed).not.toBeNull();

            // Re-activating Status without leaving it re-reads, and the re-arm
            // for an unchanged period is a no-op — so the *same* handle is still
            // behind the tick, which is what "at most one" has to mean.
            rt.shell?.activate('status');
            await settle();
            expect(rt.statusRefreshTimer, 'one period, one handle').toBe(armed);
            expect(vi.getTimerCount()).toBe(before + 1);

            for (let round = 0; round < 3; round += 1) {
                rt.shell?.activate('about');
                await settle();
                expect(rt.statusRefreshTimer, `round ${round}: leaving disarms`).toBeNull();
                expect(vi.getTimerCount(), `round ${round}: nothing armed elsewhere`).toBe(before);

                rt.shell?.activate('status');
                await settle();
                expect(vi.getTimerCount(), `round ${round}: one tick on re-entry`).toBe(before + 1);
            }

            expect(vi.getTimerCount(), 'one tick, whatever the tab history').toBe(before + 1);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SC-114 (e) a later interval is followed', () => {
    it('re-arms the tick to 30 s when a document says 30 000', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();
            expect(rt.statusRefreshMs).toBe(PERIOD_MS);

            run.answer(STATUS_PATH, answering(SHORT_PERIOD_MS));
            rt.shell?.activate('status');
            await settle();
            expect(rt.statusRefreshMs, 'the period follows the document').toBe(SHORT_PERIOD_MS);

            await advance(SHORT_PERIOD_MS - 1_000);
            expect(run.countOf(STATUS_PATH), 'still one read short of the new period').toBe(2);
            await advance(1_000);
            expect(run.countOf(STATUS_PATH), 'the new boundary fires').toBe(3);

            // …and the old period no longer does, which is what "not pinned to
            // the interval it was armed with" means at the clock.
            await advance(SHORT_PERIOD_MS * 2);
            expect(run.countOf(STATUS_PATH)).toBe(5);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SC-114 (f, AC-151) no interval means no tick and no invented number', () => {
    it('renders not refreshing, arms nothing, and keeps Refresh status live', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const before = vi.getTimerCount();
            const run = await mountDriven(refusing(503, 'the service refused'));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();

            expect(run.countOf(STATUS_PATH), 'the refused activation read').toBe(1);
            expect(rt.statusRefreshMs, 'nothing armed').toBeNull();
            expect(rt.statusRefreshTimer).toBeNull();
            expect(vi.getTimerCount()).toBe(before);

            await advance(PERIOD_MS * 3);
            expect(run.countOf(STATUS_PATH), 'no tick was ever armed').toBe(1);

            // No period anywhere on the tab: not the service's default, not a
            // hard-coded one, not a configured one. The last two are the
            // documented bounds, so a panel that substituted either of them
            // would be caught here rather than only in the interval case.
            const rendered = renderedStrings().join('\n');
            for (const invented of [PERIOD_TEXT, '60000', 'every 60', '1 minute', '30,000', '15,000']) {
                expect(rendered, invented).not.toContain(invented);
            }

            // The copy states the fact in words and names the on-demand read.
            expect(rendered).toContain('not refreshing itself');
            expect(rendered).toContain(REFRESH_LABEL);

            // The button still reads on demand, which is the whole remedy. The
            // script is switched *before* the press so the assertion is about
            // the press rather than about a tick that never came.
            const press = refreshControl()?.onClick;
            expect(press, 'the refresh control is wired').toBeTypeOf('function');
            run.answer(STATUS_PATH, answering(PERIOD_MS));
            run.answer(CONFIG_PATH, answering(PERIOD_MS));
            press?.();
            await settle();

            expect(run.countOf(STATUS_PATH), 'the button reads on demand').toBe(2);
            expect(rt.statusRefreshMs, 'and the period arms once one is read').toBe(PERIOD_MS);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('renders not refreshing for an unparseable interval, without claiming a failure', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const before = vi.getTimerCount();
            // A projection whose `polling` block carries no `intervalMs` at all.
            const withoutInterval = { nextPollAt: FUTURE_STAMP, paused: false, pausedReason: '' };
            const run = await mountDriven(async (request) => ({
                status: 200,
                body: request.path === CONFIG_PATH ? configBody(PERIOD_MS) : statusBody({ polling: withoutInterval }),
            }));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();

            // The fail-closed parser refuses the whole document over an
            // unreadable required member (AGENTS invariant 8), so there is no
            // "loaded document with no interval" to reach here — and the panel
            // must still not invent one, nor claim a transport failure that
            // did not happen.
            expect(parseStatusView(statusBody({ polling: withoutInterval })), 'the parser refuses it').toBeNull();
            expect(rt.state.statusTab.doc).toBeNull();
            expect(rt.statusRefreshMs, 'nothing armed').toBeNull();
            expect(vi.getTimerCount()).toBe(before);

            await advance(PERIOD_MS * 3);
            expect(run.countOf(STATUS_PATH), 'no tick was ever armed').toBe(1);

            const rendered = renderedStrings().join('\n');
            expect(rendered).toContain('not refreshing itself');
            expect(rendered).toContain(REFRESH_LABEL);
            // The document arrived; what it lacked is named, not a transport
            // failure the service never reported.
            expect(rendered).toContain('could not be read: the service answered a status document');

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not substitute the configured interval for the effective one', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            // The two disagree, which is the case a substitution would get
            // wrong in the direction an operator could not detect.
            const run = await mountDriven(async (request) => ({
                status: 200,
                body: request.path === CONFIG_PATH
                    ? configBody(SHORT_PERIOD_MS)
                    : statusBody({ polling: pollingAt(PERIOD_MS) }),
            }));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();

            expect(rt.statusRefreshMs, 'the effective interval, never the configured one').toBe(PERIOD_MS);

            await advance(SHORT_PERIOD_MS);
            expect(run.countOf(STATUS_PATH), 'the configured 30 s does not become the period').toBe(1);
            await advance(PERIOD_MS - SHORT_PERIOD_MS);
            expect(run.countOf(STATUS_PATH)).toBe(2);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not substitute the configured interval when that read failed either', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(async (request) => (request.path === CONFIG_PATH
                ? { status: 503, body: 'no configuration' }
                : { status: 200, body: statusBody({ polling: pollingAt(PERIOD_MS) }) }));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();

            // The status document carried an interval, so the cadence is known
            // even though the supplementary read failed; the failure renders as
            // *not read* on its own line and changes nothing else (FR-039).
            expect(rt.statusRefreshMs).toBe(PERIOD_MS);
            expect(rt.state.statusTab.configuredIntervalMs).toBeNull();
            expect(pollingLines({ view: landedView(rt), configured: null, nowMs: Date.now() }))
                .toContain('Configured interval: not read');

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SC-114 (g, AC-152) a failing tick is a failing read', () => {
    it('leaves one stale marker, an unmoved stamp, and the same period', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();

            const landedAt = rt.state.statusTab.at;
            expect(landedAt).not.toBeNull();

            // Three consecutive refused ticks, each with its own cause so a
            // marker that accumulated would show it. The service client draws
            // its problem from the status code, so distinct codes are distinct
            // causes — which is exactly the reason AC-152 requires it to name.
            const refusals = [502, 504, 503];
            for (const status of refusals) {
                run.answer(STATUS_PATH, refusing(status, `refused with ${status}`));
                await advance(PERIOD_MS);
            }

            const slice = rt.state.statusTab;
            expect(slice.phase).toBe('failed');
            expect(slice.stale, 'the last good document is kept').toBe(true);
            expect(slice.doc, 'and it is still the one on screen').not.toBeNull();
            expect(slice.at, 'the stamp describes the data on screen, so it does not move').toBe(landedAt);

            // One marker, naming one cause — not one per tick.
            const line = readStateLine(slice);
            expect(line).toContain('may be stale');
            expect(line.match(/may be stale/gu)).toHaveLength(1);
            expect(line).toContain(String(refusals.at(-1)));
            const earlierRefusals = refusals.slice(0, -1);
            for (const earlier of earlierRefusals) {
                expect(line, `the ${earlier} refusal must not be stacked`).not.toContain(String(earlier));
            }

            // The tab reports one read per period and not a read it did not
            // perform: the refused tick is a request that answered, and the
            // stamp does not advance for any of them.
            expect(run.countOf(STATUS_PATH)).toBe(4);

            // The period does not chase the failure: the fourth period is armed
            // at the first period's interval, proved from the request log. The
            // log holds four requests and every one of them a full period after
            // the last — no backoff, no doubling, no shortened period, and no
            // fast retry after a failure.
            expect(statusGaps(run)).toEqual([0, PERIOD_MS, PERIOD_MS * 2, PERIOD_MS * 3]);
            expect(rt.statusRefreshMs, 'still the reported interval').toBe(PERIOD_MS);

            // The button is live and reads on demand.
            const press = refreshControl()?.onClick;
            expect(press).toBeTypeOf('function');
            run.answer(STATUS_PATH, answering(PERIOD_MS));
            run.answer(CONFIG_PATH, answering(PERIOD_MS));
            press?.();
            await settle();

            expect(run.countOf(STATUS_PATH)).toBe(5);
            expect(rt.state.statusTab.stale, 'the stale mark clears on the read that lands').toBe(false);
            expect(rt.state.statusTab.at, 'and the stamp moves only now').not.toBe(landedAt);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('states the same cadence after a tick and after a button press', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const run = await mountDriven(answering(PERIOD_MS));
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();
            const afterActivation = cadenceLine({ refreshMs: rt.statusRefreshMs });

            // FR-101: while armed the statement carries **the period**, not
            // merely the fact — a copy that dropped the number would be
            // "identical after a tick and a press" and say nothing useful.
            expect(afterActivation).toContain('re-reads itself every');
            expect(afterActivation).toContain(PERIOD_TEXT);
            expect(renderedSince().join('\n')).toContain(afterActivation);

            await advance(PERIOD_MS);
            const afterTick = cadenceLine({ refreshMs: rt.statusRefreshMs });

            const mark = mounts.log.length;
            const press = refreshControl()?.onClick;
            expect(press).toBeTypeOf('function');
            press?.();
            await settle();

            // FR-101: the operator's own refresh and the automatic one are the
            // same read at the same cadence, and the copy says so identically —
            // after a tick, after a button press, and after activation.
            expect(afterTick).toBe(afterActivation);
            expect(afterTick).toContain('re-reads itself');
            expect(renderedSince(mark).join('\n'), 'the press renders the same sentence').toContain(afterTick);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SC-114 (h) a tick during an in-flight read is a no-op', () => {
    it('issues one request, reports one read, and misses the tick', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const gate = { release: (): void => undefined };
            let isHeld = true;
            const run = await mountDriven(async (request) => {
                if (isHeld && request.path === STATUS_PATH) {
                    // A read that hangs: the tick has to be refused, not queued.
                    await new Promise<void>((resolve) => {
                        gate.release = resolve;
                    });
                }

                return {
                    status: 200,
                    body: request.path === CONFIG_PATH
                        ? configBody(PERIOD_MS)
                        : statusBody({ polling: pollingAt(PERIOD_MS) }),
                };
            });
            const { rt } = run;
            rt.shell?.activate('status');
            await settle();
            expect(run.countOf(STATUS_PATH), 'the activation read is in flight').toBe(1);
            expect(rt.state.statusTab.phase).toBe('loading');

            await advance(PERIOD_MS);
            expect(run.countOf(STATUS_PATH), 'the tick did not stack a second request').toBe(1);
            expect(rt.state.statusTab.phase).toBe('loading');

            isHeld = false;
            gate.release();
            await settle();

            expect(rt.state.statusTab.phase).toBe('loaded');
            expect(rt.state.statusTab.doc, 'one read, one document').not.toBeNull();

            // The missed tick is missed. The tick at 60 s produced **no
            // request**, so the next request lands two periods after the one
            // that was already in flight — and the period after that resumes at
            // exactly one interval, which is the difference between a missed
            // tick and a backlog made up.
            await advance(PERIOD_MS);
            expect(run.countOf(STATUS_PATH)).toBe(2);
            await advance(PERIOD_MS);
            expect(run.countOf(STATUS_PATH)).toBe(3);

            expect(statusGaps(run)).toEqual([0, PERIOD_MS * 2, PERIOD_MS * 3]);

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });

    it('refuses the button press too, so the two callers cannot race', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });

        try {
            const gate = { release: (): void => undefined };
            const run = await mountDriven(async (request) => {
                if (request.path === STATUS_PATH) {
                    await new Promise<void>((resolve) => {
                        gate.release = resolve;
                    });
                }

                return {
                    status: 200,
                    body: request.path === CONFIG_PATH
                        ? configBody(PERIOD_MS)
                        : statusBody({ polling: pollingAt(PERIOD_MS) }),
                };
            });
            const { rt } = run;
            const press = refreshControl()?.onClick;
            expect(press).toBeTypeOf('function');
            rt.shell?.activate('status');
            await settle();

            press?.();
            await settle();

            expect(run.countOf(STATUS_PATH), 'the same guard for both callers').toBe(1);

            gate.release();
            await settle();
            expect(rt.state.statusTab.phase).toBe('loaded');

            tearDown(rt);
        } finally {
            vi.useRealTimers();
        }
    });
});
