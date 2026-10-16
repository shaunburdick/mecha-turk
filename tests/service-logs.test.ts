/**
 * The retained service log stream (FR-001, FR-002; AC-001, AC-002,
 * AC-003, AC-009, AC-010), read end to end over the real loopback service.
 *
 * Each block names the regression it catches:
 *
 * - **The ring is the sink's tail**: 1 005 writes answer the newest 1 000,
 *   sequence numbers stay contiguous across the drop with none reused, a
 *   cursor taken before the drop resumes strictly after itself, and every
 *   answered line is byte-identical to the line the capturing sink received.
 * - **The query fails closed**: an unusable cursor is a `422` naming `cursor`
 *   and echoing nothing, a numeric limit clamps, a non-numeric one defaults,
 *   a bare or blank cursor opens the tail, and no answer carries a member the
 *   wire did not declare.
 * - **Redaction and the level threshold act before retention**: a token-shaped
 *   value reaches neither ring nor answer, and lines emitted after a raised
 *   `logLevel` reach neither sink nor ring nor read while lines emitted before
 *   it are still answered — a read-time filter fails here.
 * - **One number, one reader**: the answer's `intervalMs` is the value
 *   `GET /v1/status` reports, and an unusable data directory does not refuse
 *   the read.
 *
 * Offline: temp directories, an offline verifier and poller — no host, no PAT,
 * no network.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { LOG_RING_CAPACITY } from '../service/log-ring.ts';
import { CONFIG_PATH } from '../service/routes/config.ts';
import { LOGS_PATH } from '../service/routes/logs.ts';
import { STATUS_PATH } from '../service/routes/status.ts';
import type { ServiceConfig } from '../service/config.ts';
import type { FieldIssue } from '../service/http.ts';
import type { ServiceStatusBody } from '../service/routes/status.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';
import { byText } from './support/sort.ts';
import { makeTempTree, removeTempTree } from './support/temp-tree.ts';

/** Token-shaped fixtures this suite seeds; never a real credential (invariant 9). */
const TOKEN_VALUE = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** A fine-grained PAT the redaction pass must also withhold. */
const PAT_VALUE = 'github_pat_abcdefghij0123456789_abcdefghijklmnopqrstuv';

/** What the placeholders the redaction pass writes look like. */
const TOKEN_REDACTED = '[redacted:github-token-classic]';

/** Placeholder for the fine-grained PAT above. */
const PAT_REDACTED = '[redacted:github-token-fine-grained]';

/** The line the credential fixture rides on. */
const CREDENTIAL_MESSAGE = 'credential in a field';

/** One `GET /v1/logs` answer, exactly as the wire carries it. */
interface LogsAnswer {
    readonly entries: readonly { readonly seq: number; readonly line: string }[];
    readonly startedAt: number;
    readonly intervalMs: number;
}

/** The error envelope a refused cursor arrives in. */
interface ErrorAnswer {
    readonly error: {
        readonly code: string;
        readonly issues?: readonly FieldIssue[];
    };
}

/** Services this file started, shut down after every test. */
const running: TestService[] = [];

/** Scratch root for the deliberately unusable data directory. */
let scratch: string | null = null;

/** Per-test teardown: drain the services and drop the scratch root. */
afterEach(async (): Promise<void> => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }

    if (scratch === null) {
        return;
    }

    await removeTempTree(scratch);
    scratch = null;
});

/**
 * Start a service and keep it for teardown.
 */
async function start(options: Parameters<typeof startTestService>[0] = {}): Promise<TestService> {
    const service = await startTestService(options);
    running.push(service);

    return service;
}

/**
 * Write `count` short lines through the instance's own logger.
 */
function emitBeats(service: TestService, count: number, from = 0): void {
    for (let index = from; index < from + count; index += 1) {
        service.log.info('beat', { index });
    }
}

/**
 * The bytes one emitted line carries for its `index`. The field is last, so
 * its closing brace terminates the number and `1` can never match `10`.
 */
function beatMarker(index: number): string {
    return `"index":${index}}`;
}

/**
 * Read the logs route raw, so a refusal can be inspected as sent.
 */
async function getLogs(service: TestService, query = ''): Promise<{ readonly status: number; readonly text: string }> {
    const response = await service.call(`${LOGS_PATH}${query}`);

    return { status: response.status, text: await response.text() };
}

/**
 * Read the logs route as an answer.
 *
 * @returns The parsed body of a `200`.
 * @throws {Error} When the route answers anything but `200`.
 */
async function logsBody(service: TestService, query = ''): Promise<LogsAnswer> {
    const { status, text } = await getLogs(service, query);
    if (status !== 200) {
        throw new Error(`the logs read answered ${status}, expected 200: ${text}`);
    }

    return JSON.parse(text) as LogsAnswer;
}

/**
 * Replace the configuration through the real write route.
 */
async function putConfig(service: TestService, config: ServiceConfig): Promise<void> {
    const response = await service.call(CONFIG_PATH, { method: 'PUT', body: JSON.stringify(config) });
    expect(response.status).toBe(200);
}

/**
 * Read the health model the status route reports.
 */
async function readStatus(service: TestService): Promise<ServiceStatusBody> {
    const response = await service.call(STATUS_PATH);
    expect(response.status).toBe(200);

    return await response.json() as ServiceStatusBody;
}

/**
 * A data directory the store cannot open: its parent is a regular file.
 *
 * @returns The unusable path, with its scratch parent removed after the test.
 */
async function blockedDataDir(): Promise<string> {
    scratch = await makeTempTree('logs-blocked');
    const blocker = join(scratch, 'blocker');
    await writeFile(blocker, 'i am a file', 'utf8');

    return join(blocker, 'store');
}

describe('FR-001 the ring holds exactly the lines the logger wrote (AC-001, AC-009)', () => {
    it('answers the newest 1 000 of 1 005 lines, contiguous across the drop', async () => {
        const service = await start();

        emitBeats(service, LOG_RING_CAPACITY + 5);

        // Byte identity, read off the process itself: the ring is the tail of
        // what the sink received, same lines, same order, bounded at the cap.
        // The newest seq is snapshotted now: `retained()` is the live ring, and
        // this request's own access line lands in it before the assertions
        // below read it.
        const held = service.log.retained();
        expect(held).toHaveLength(LOG_RING_CAPACITY);
        expect(held.map((entry) => entry.line)).toEqual(service.logLines.slice(-LOG_RING_CAPACITY));
        const newestHeld = held.at(-1);

        const answer = await logsBody(service, '?limit=1000');

        expect(answer.entries).toHaveLength(LOG_RING_CAPACITY);
        const seqs = answer.entries.map((entry) => entry.seq);
        const gaps = seqs.slice(1).map((seq, index) => seq - (seqs[index] ?? NaN));
        expect(gaps.every((gap) => gap === 1), 'surviving seqs must be contiguous across the drop').toBe(true);

        const newestAnswered = answer.entries.at(-1);
        if (newestAnswered === undefined || newestHeld === undefined) {
            throw new Error('the ring or the first answer was empty');
        }
        expect(newestAnswered.seq, 'the answer must open on the newest entries').toBeGreaterThanOrEqual(newestHeld.seq);

        // The five oldest of the thousand-and-five are absent, the newest
        // survived; the marker's closing brace keeps index 1 from matching 10.
        const answered = answer.entries.map((entry) => entry.line).join('');
        for (let index = 0; index < 5; index += 1) {
            expect(answered, `beat ${index} should have been dropped`).not.toContain(beatMarker(index));
        }
        expect(answered).toContain(beatMarker(LOG_RING_CAPACITY + 4));

        // Every answered line is a line the sink received, in the sink's order.
        const sink = new Set(service.logLines);
        expect(answer.entries.filter((entry) => !sink.has(entry.line)), 'lines the sink never received').toEqual([]);
        const order = answer.entries.map((entry) => service.logLines.indexOf(entry.line));
        expect(order.toSorted((left, right) => left - right)).toEqual(order);

        // A cursor taken across the drop resumes strictly after itself.
        emitBeats(service, 3, LOG_RING_CAPACITY + 5);
        const resumed = await logsBody(service, `?cursor=${newestAnswered.seq}`);
        expect(resumed.entries.length).toBeGreaterThan(0);
        expect(resumed.entries.every((entry) => entry.seq > newestAnswered.seq)).toBe(true);
    });

    it('governs entry: a raised threshold stops lines before sink, ring, and read alike', async () => {
        const service = await start();
        await putConfig(service, { ...DEFAULT_CONFIG, logLevel: 'debug' });

        service.log.debug('pre-change debug');
        service.log.info('pre-change info');

        await putConfig(service, { ...DEFAULT_CONFIG, logLevel: 'error' });

        service.log.debug('post-change debug');
        service.log.info('post-change info');

        for (const marker of ['post-change debug', 'post-change info']) {
            expect(service.logLines.some((line) => line.includes(marker)), marker).toBe(false);
            expect(service.log.retained().some((entry) => entry.line.includes(marker)), marker).toBe(false);
        }

        const answer = await logsBody(service, '?limit=1000');
        const answered = answer.entries.map((entry) => entry.line).join('');
        expect(answered).not.toContain('post-change debug');
        expect(answered).not.toContain('post-change info');
        expect(answered).toContain('pre-change debug');
        expect(answered).toContain('pre-change info');
    });
});

describe('FR-002 GET /v1/logs pages the stream fail-closed (AC-002, AC-003, AC-010)', () => {
    it('refuses an unusable cursor with a 422 naming the field and echoing nothing', async () => {
        const service = await start();
        emitBeats(service, 3);

        const refused = await getLogs(service, '?cursor=abc');

        expect(refused.status).toBe(422);
        const body = JSON.parse(refused.text) as ErrorAnswer;
        expect(body.error.code).toBe('validation');
        const issue = body.error.issues?.[0];
        expect(issue?.field).toBe('cursor');
        expect(issue?.remediation ?? '').not.toBe('');
        expect(refused.text).not.toContain('abc');
    });

    it('clamps a numeric limit, defaults a non-numeric one, and tails a bare request', async () => {
        const service = await start();
        emitBeats(service, LOG_RING_CAPACITY + 5);

        const clamped = await logsBody(service, '?limit=99999');
        expect(clamped.entries).toHaveLength(LOG_RING_CAPACITY);

        const capped = await logsBody(service, '?limit=7');
        expect(capped.entries).toHaveLength(7);

        const defaulted = await logsBody(service, '?limit=banana');
        expect(defaulted.entries).toHaveLength(200);

        // Emitted after the reads above, so the tail must carry it — and the
        // tail must open at the ring's newest entry when the request runs
        // (another request's access line may land first; it only moves that
        // newest entry forward).
        service.log.info('tail marker');
        const newestHeld = service.log.retained().at(-1);
        if (newestHeld === undefined) {
            throw new Error('the ring was empty before the tail read');
        }
        const tail = await logsBody(service);
        expect(tail.entries).toHaveLength(200);
        expect(tail.entries.some((entry) => entry.line.includes('tail marker'))).toBe(true);
        expect(tail.entries.at(-1)?.seq, 'the tail must open on the newest entries')
            .toBeGreaterThanOrEqual(newestHeld.seq);

        const blank = await logsBody(service, '?cursor=');
        expect(blank.entries).toHaveLength(200);

        for (const answer of [clamped, capped, defaulted, tail, blank]) {
            expect(Object.keys(answer).toSorted(byText)).toEqual(['entries', 'intervalMs', 'startedAt']);
            expect(typeof answer.startedAt).toBe('number');
            expect(typeof answer.intervalMs).toBe('number');
            expect(answer.entries.every((entry) => Object.keys(entry).toSorted(byText).join(',') === 'line,seq'),
                'entry members').toBe(true);
        }
    });

    it('keeps token-shaped bytes out of ring and answer while the line keeps its fields', async () => {
        const service = await start();

        service.log.info(CREDENTIAL_MESSAGE, { detail: TOKEN_VALUE, auth: PAT_VALUE });

        const seeded = service.log.retained().find((entry) => entry.line.includes(CREDENTIAL_MESSAGE));
        if (seeded === undefined) {
            throw new Error('the seeded line never reached the ring');
        }
        expect(seeded.line).not.toContain(TOKEN_VALUE);
        expect(seeded.line).not.toContain(PAT_VALUE);
        expect(seeded.line).toContain(TOKEN_REDACTED);
        expect(seeded.line).toContain(PAT_REDACTED);
        expect(service.logLines.join('')).not.toContain(TOKEN_VALUE);

        const answer = await logsBody(service, '?limit=50');
        const answered = answer.entries.find((entry) => entry.line.includes(CREDENTIAL_MESSAGE));
        if (answered === undefined) {
            throw new Error('the seeded line was not answered');
        }
        expect(answered.line).not.toContain(TOKEN_VALUE);
        expect(answered.line).not.toContain(PAT_VALUE);
        const parsed = JSON.parse(answered.line) as {
            readonly level?: unknown;
            readonly message?: unknown;
            readonly detail?: unknown;
            readonly auth?: unknown;
        };
        expect(parsed.level).toBe('info');
        expect(parsed.message).toBe(CREDENTIAL_MESSAGE);
        expect(String(parsed.detail)).toContain(TOKEN_REDACTED);
        expect(String(parsed.auth)).toContain(PAT_REDACTED);
    });

    it('reports the interval status reports, from the same config reader', async () => {
        const service = await start();
        await putConfig(service, { ...DEFAULT_CONFIG, intervalMs: 45_000 });

        const answer = await logsBody(service);
        const status = await readStatus(service);

        expect(answer.intervalMs).toBe(45_000);
        expect(answer.intervalMs).toBe(status.polling.intervalMs);
    });

    it('answers an unusable data directory anyway, with the same interval status reports', async () => {
        const service = await start({ dataDir: await blockedDataDir() });

        const answer = await logsBody(service);
        const status = await readStatus(service);

        expect(answer.startedAt).toBeGreaterThan(0);
        expect(answer.intervalMs).toBe(DEFAULT_CONFIG.intervalMs);
        expect(answer.intervalMs).toBe(status.polling.intervalMs);
        expect(status.service.status).toBe('degraded');
    });
});
