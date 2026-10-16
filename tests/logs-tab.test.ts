/**
 * The Logs tab's render, restart, and read states (010 FR-004, FR-006,
 * FR-007; AC-002, AC-007, AC-008, AC-010, AC-011).
 *
 * Where `tests/logs-refresh.test.ts` proves the cadence on a driven clock,
 * this file proves what the operator sees over the fake host and the fake
 * DOM, with the tab mounted through the real `tabSpecs`:
 *
 * - **AC-011** the newest line is the first rendered row, each row shows
 *   timestamp, level-as-text, message, and fields through the text path with
 *   no HTML sink, a non-JSON line renders its own text, and nothing is
 *   filtered or re-sorted on display;
 * - **AC-007** a changed `startedAt` drops the held lines and cursor, re-reads
 *   from the tail, and states the restart in words — while a restart whose
 *   tail read fails renders the failure, never an empty-but-fresh stream;
 * - **AC-008** a refused read names the exact cause, offers `Refresh logs`,
 *   keeps the last lines marked stale (or says plainly there are none),
 *   leaves the stamp unmoved, stacks one error, and the retry restores the
 *   stream with no reload;
 * - **AC-002** the redacted placeholder renders with its level, message, and
 *   fields;
 * - **AC-010** and FR-004 the hold never exceeds 1 000 lines and drops its
 *   own oldest.
 *
 * Offline: the fake host, the fake DOM, and a recorded SDK. No live host, no
 * token, no network (FR-086, NFR-105).
 */

import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { LOGS_REFRESH_LABEL, LOGS_RESTART_LINE } from '../src/logs-rows.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';

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

/** Path the stream is read from. */
const LOGS_PATH = '/v1/logs';

/** Body the unrouted paths answer with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/** The process stamp the pre-restart stream carries. */
const OLD_STARTED_AT = 1_700_000_000_000;

/** The process stamp the post-restart stream carries. */
const NEW_STARTED_AT = 1_700_000_060_000;

/** One scriptable answer for a service path. */
type Answer = (request: GuestRequest) => Promise<GuestRequestResult>;

/** One serialized line, as the service writes them. */
function logLine(input: {
    readonly seq: number;
    readonly ts?: string;
    readonly level?: string;
    readonly message?: string;
    readonly fields?: Record<string, string>;
    readonly raw?: string;
}): { readonly seq: number; readonly line: string } {
    if (input.raw !== undefined) {
        return { seq: input.seq, line: `${input.raw}\n` };
    }

    return {
        seq: input.seq,
        line: `${JSON.stringify({
            ts: input.ts ?? '2026-10-16T00:00:00.000Z',
            level: input.level ?? 'info',
            message: input.message ?? `line ${input.seq}`,
            ...input.fields,
        })}\n`,
    };
}

/** One answer body over already-built entries. */
function logsBody(input: {
    readonly entries: readonly { readonly seq: number; readonly line: string }[];
    readonly startedAt?: number;
    readonly intervalMs?: number;
}): string {
    return JSON.stringify({
        entries: input.entries,
        startedAt: input.startedAt ?? OLD_STARTED_AT,
        ...(input.intervalMs !== undefined && { intervalMs: input.intervalMs }),
    });
}

/** Everything one run recorded. */
interface Run {
    readonly rt: PanelRuntime;
    /** Every `/v1/logs` request path, in order — cursor or none. */
    readonly logsRequests: () => readonly string[];
    /** Replace the stream script, keeping the log. */
    answer(next: Answer): void;
}

/** Mount the real seven-tab shell; the tab mounts on activation, like every other. */
async function mountLogsTab(answer: Answer): Promise<Run> {
    mounts.log.length = 0;
    const requests: string[] = [];
    let scripted = answer;
    const rt = createTestRuntime(fakeHost({
        serviceRequest: async (request) => {
            if (request.path.startsWith(LOGS_PATH)) {
                requests.push(request.path);

                return await scripted(request);
            }

            return { status: 404, body: UNROUTED };
        },
    }));
    const dom = fakeDom();
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt) });
    rt.shell?.activate('logs');
    await tick();

    return {
        rt,
        logsRequests: () => requests,
        answer: (next) => {
            scripted = next;
        },
    };
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

/** The strings of the currently rendered state: everything since the last loaded repaint. */
function currentRender(): readonly string[] {
    let from = 0;
    for (const [index, entry] of mounts.log.entries()) {
        const props = entry.props as { readonly text?: unknown };
        if (
            entry.key === 'mountText:update'
            && typeof props.text === 'string'
            && props.text.startsWith('Logs: read at')
        ) {
            from = index;
        }
    }

    return renderedSince(from);
}

/** The read-state line on screen now — the last one any repaint handed the SDK. */
function currentReadLine(): string {
    let line = '';
    for (const entry of mounts.log) {
        const props = entry.props as { readonly text?: unknown };
        if (
            entry.key === 'mountText:update'
            && typeof props.text === 'string'
            && props.text.startsWith('Logs')
        ) {
            line = props.text;
        }
    }

    return line;
}

/** The index of the first rendered string carrying `needle`, or `-1`. */
function renderedIndex(strings: readonly string[], needle: string): number {
    return strings.findIndex((entry) => entry.includes(needle));
}

describe('AC-011 the stream renders newest first, as text', () => {
    it('renders timestamp, level word, message, and fields — newest row first, nothing filtered', async () => {
        const run = await mountLogsTab(async () => ({
            status: 200,
            body: logsBody({
                entries: [
                    logLine({ seq: 1, ts: '2026-10-16T00:00:01.000Z', level: 'debug', message: 'quiet chatter' }),
                    logLine({ seq: 2, ts: '2026-10-16T00:00:02.000Z', level: 'warn', message: 'mind this' }),
                    logLine({
                        seq: 3,
                        ts: '2026-10-16T00:00:03.000Z',
                        level: 'error',
                        message: 'newest failure',
                        fields: { binding: 'bnd_1' },
                    }),
                    logLine({ seq: 4, raw: 'plainly not a JSON line' }),
                ],
                intervalMs: 60_000,
            }),
        }));
        const { rt } = run;
        const strings = renderedSince();

        // Newest first: the non-JSON tail line, then the error, the warning,
        // the debug — the arrival order, not a severity sort (FR-004).
        const newest = renderedIndex(strings, 'plainly not a JSON line');
        const error = renderedIndex(strings, 'newest failure');
        const warn = renderedIndex(strings, 'mind this');
        const debug = renderedIndex(strings, 'quiet chatter');
        expect(newest).toBeGreaterThanOrEqual(0);
        expect(newest).toBeLessThan(error);
        expect(error).toBeLessThan(warn);
        expect(warn).toBeLessThan(debug);

        // The level is a word in the row's own text, and the row carries the
        // timestamp, the message, and the remaining fields.
        const errorRow = strings.find((entry) => entry.includes('newest failure')) ?? '';
        expect(errorRow).toContain('2026-10-16T00:00:03.000Z');
        expect(errorRow).toContain('error');
        expect(errorRow).toContain('binding: bnd_1');

        // A line that is not a JSON object renders its own text rather than
        // disappearing, one trailing newline trimmed for display only.
        expect(strings).toContain('plainly not a JSON line');

        // Nothing was dropped by level and nothing reached an HTML sink.
        expect(strings.some((entry) => entry.includes('quiet chatter'))).toBe(true);
        for (const entry of mounts.log) {
            expect(entry.key).not.toMatch(/html/i);
        }

        rt.shell?.dispose();
        rt.disposed = true;
    });
});

describe('AC-007 a restart is stated, never silently absorbed', () => {
    it('drops the held lines and cursor, re-reads from the tail, and says the restart in words', async () => {
        const run = await mountLogsTab(async () => ({
            status: 200,
            body: logsBody({
                entries: [
                    logLine({ seq: 1, message: 'pre-restart first' }),
                    logLine({ seq: 2, message: 'pre-restart last' }),
                ],
            }),
        }));
        const { rt } = run;
        expect(rt.state.logsTab.lines).toHaveLength(2);
        expect(renderedSince().some((entry) => entry.includes('pre-restart last'))).toBe(true);

        run.answer(async () => ({
            status: 200,
            body: logsBody({
                entries: [
                    logLine({ seq: 1, message: 'post-restart first' }),
                    logLine({ seq: 2, message: 'post-restart last' }),
                ],
                startedAt: NEW_STARTED_AT,
            }),
        }));
        rt.shell?.activate('logs');
        await tick();

        // The detecting read carried the old cursor; the re-read did not —
        // the tail, by construction (the restart dropped the held set the
        // cursor is derived from).
        expect(run.logsRequests()).toEqual([LOGS_PATH, `${LOGS_PATH}?cursor=2`, LOGS_PATH]);

        // Only the new stream is held, and the current render carries no line
        // from the previous stream (FR-006: no pre-restart line stays
        // rendered as current).
        const current = currentRender();
        expect(rt.state.logsTab.lines).toHaveLength(2);
        expect(rt.state.logsTab.phase).toBe('loaded');
        expect(current.some((entry) => entry.includes('post-restart first'))).toBe(true);
        expect(
            current.some((entry) => entry.includes('pre-restart')),
            'no old line renders as current',
        ).toBe(false);
        expect(rt.state.logsTab.restarted).toBe(true);

        // …and the restart is stated in words, both facts (FR-006): the note
        // was mounted with the sentence and its wrapper is on screen now.
        expect(renderedSince().includes(LOGS_RESTART_LINE), 'the note carries the sentence').toBe(true);
        expect(rt.logsUi?.restartBox.hidden, 'the note is shown').toBe(false);

        rt.shell?.dispose();
        rt.disposed = true;
    });

    it('renders a failed tail read as a failure, never an empty-but-fresh stream', async () => {
        const run = await mountLogsTab(async () => ({
            status: 200,
            body: logsBody({ entries: [logLine({ seq: 1, message: 'the old stream' })] }),
        }));
        const { rt } = run;
        expect(rt.state.logsTab.phase).toBe('loaded');

        // The restart-detecting read lands and the *tail* re-read is refused:
        // the tab must name the refusal with the restart note still up, and
        // claim no loaded-and-empty view.
        let reads = 0;
        run.answer(async () => {
            reads += 1;

            return reads === 1
                ? {
                    status: 200,
                    body: logsBody({
                        entries: [logLine({ seq: 1, message: 'the new stream' })],
                        startedAt: NEW_STARTED_AT,
                    }),
                }
                : { status: 503, body: 'the service stopped' };
        });
        rt.shell?.activate('logs');
        await tick();

        const strings = renderedSince();
        expect(rt.state.logsTab.phase).toBe('failed');
        expect(rt.state.logsTab.lines).toHaveLength(0);
        expect(rt.state.logsTab.restarted).toBe(true);
        expect(strings.some((entry) => entry.includes('service answered 503'))).toBe(true);
        expect(strings.includes(LOGS_RESTART_LINE), 'the note is still mounted').toBe(true);
        expect(rt.logsUi?.restartBox.hidden, 'and still shown').toBe(false);

        rt.shell?.dispose();
        rt.disposed = true;
    });
});

describe('AC-008 a refused read degrades honestly and the retry restores', () => {
    it('names the cause, offers Refresh logs, and says plainly there are none', async () => {
        const run = await mountLogsTab(async () => ({ status: 503, body: 'the service stopped' }));
        const { rt } = run;

        expect(rt.state.logsTab.phase).toBe('failed');
        expect(rt.state.logsTab.stale).toBe(false);
        const strings = renderedSince();
        expect(strings.some((entry) => entry.includes('service answered 503'))).toBe(true);
        expect(strings.some((entry) => entry.includes('Nothing has been read yet'))).toBe(true);
        expect(mounts.log.some(
            (entry) => entry.key === 'mountButton'
                && (entry.props as { readonly label?: string }).label === LOGS_REFRESH_LABEL,
        )).toBe(true);

        rt.shell?.dispose();
        rt.disposed = true;
    });

    it('keeps the last lines with one stale marker, and the retry restores without a reload', async () => {
        const run = await mountLogsTab(async () => ({
            status: 200,
            body: logsBody({ entries: [logLine({ seq: 1, message: 'still here' })] }),
        }));
        const { rt } = run;
        const landedAt = rt.state.logsTab.at;
        expect(landedAt).not.toBeNull();

        // Three refused re-reads, each with its own status, and a manual
        // press among them: still one marker, one cause, one stamp.
        run.answer(async () => ({ status: 502, body: 'bad gateway' }));
        rt.shell?.activate('logs');
        await tick();
        run.answer(async () => ({ status: 504, body: 'gateway timeout' }));
        rt.shell?.activate('logs');
        await tick();
        run.answer(async () => ({ status: 503, body: 'the service stopped' }));

        const press = mounts.log.find(
            (entry) => entry.key === 'mountButton'
                && (entry.props as { readonly label?: string }).label === LOGS_REFRESH_LABEL,
        )?.props as { readonly onClick?: () => void } | undefined;
        expect(press?.onClick).toBeTypeOf('function');
        press?.onClick?.();
        await tick();

        const slice = rt.state.logsTab;
        expect(slice.phase).toBe('failed');
        expect(slice.lines, 'the last lines are kept').toHaveLength(1);
        // One marker, naming one cause — not one per failure.
        const failing = currentReadLine();
        expect(failing).toContain('may be stale');
        expect(failing.match(/may be stale/gu)).toHaveLength(1);
        expect(failing).toContain('service answered 503');
        expect(failing).not.toContain('502');
        expect(failing).not.toContain('504');
        expect(slice.at, 'the stamp describes the data on screen').toBe(landedAt);

        // The retry lands the stream again: stale clears, the lines render,
        // the stamp moves — no reload, no remount, no session.
        const ui = rt.logsUi;
        run.answer(async () => ({
            status: 200,
            body: logsBody({ entries: [logLine({ seq: 2, message: 'back again' })] }),
        }));
        press?.onClick?.();
        await tick();

        expect(rt.state.logsTab.phase).toBe('loaded');
        expect(rt.state.logsTab.stale).toBe(false);
        expect(rt.state.logsTab.at).not.toBe(landedAt);
        expect(rt.logsUi, 'no remount').toBe(ui);
        expect(renderedSince().some((entry) => entry.includes('back again'))).toBe(true);
        expect(currentReadLine()).toContain('Logs: read at');
        expect(currentReadLine()).not.toContain('may be stale');

        rt.shell?.dispose();
        rt.disposed = true;
    });
});

describe('AC-002 the redacted placeholder renders with its line', () => {
    it('keeps the level, message, and fields around the placeholder', async () => {
        const run = await mountLogsTab(async () => ({
            status: 200,
            body: logsBody({
                entries: [
                    logLine({
                        seq: 1,
                        level: 'warn',
                        message: 'auth failed',
                        fields: { token: '[redacted:github-token]', account: 'octocat' },
                    }),
                ],
            }),
        }));
        const { rt } = run;

        const row = renderedSince().find((entry) => entry.includes('auth failed')) ?? '';
        expect(row).toContain('[redacted:github-token]');
        expect(row).toContain('warn');
        expect(row).toContain('account: octocat');

        rt.shell?.dispose();
        rt.disposed = true;
    });
});

describe('AC-010 / FR-004 the hold never exceeds its cap', () => {
    it('holds the newest 1 000 lines and drops its own oldest', async () => {
        const first = Array.from({ length: 1_000 }, (_unused, index) => logLine({ seq: index + 1 }));
        const run = await mountLogsTab(async () => ({
            status: 200,
            body: logsBody({ entries: first }),
        }));
        const { rt } = run;
        expect(rt.state.logsTab.lines).toHaveLength(1_000);

        const more = Array.from({ length: 500 }, (_unused, index) => logLine({ seq: 1_001 + index }));
        run.answer(async () => ({ status: 200, body: logsBody({ entries: more }) }));
        rt.shell?.activate('logs');
        await tick();

        const held = rt.state.logsTab.lines;
        expect(held).toHaveLength(1_000);
        expect(held.at(0)?.seq, 'the own-oldest lines are dropped').toBe(501);
        expect(held.at(-1)?.seq).toBe(1_500);

        rt.shell?.dispose();
        rt.disposed = true;
    });
});
