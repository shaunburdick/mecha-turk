/**
 * `GET /v1/status` after 005 (FR-031–FR-034, SC-101, SC-102, AC-102–AC-107).
 *
 * The document used to carry three literals — `paused: true`, `nextPollAt:
 * null`, `pausedReason: 'config-incomplete'`, `repositories: []`, and an
 * `agentPin.lastVerification` typed `null` — describing a process that was
 * running the whole time. This suite drives the same route twice (a running
 * scheduler and a stopped one) and gets two different, correct answers, then
 * checks the rows the `repositories` member now carries: one per stored
 * binding, from the same `readStatusRows` the Bindings tab reads, and never
 * omitted when the scan projection behind them cannot be read.
 *
 * Everything runs offline: a loopback service on a temp directory, a fake
 * GitHub verifier, and files planted where the operator's own store would put
 * them. No network, no live host, no sleeps.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BINDINGS_FILE } from '../service/bindings.ts';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { RUNS_FILE } from '../service/poll/runs.ts';
import { SCAN_STATE_FILE } from '../service/poll/scan.ts';
import {
    PAUSED_REASONS,
    createPollingView,
    isPausedReason,
    nextPollAtOf,
    pausedReasonOf,
} from '../service/poll/view.ts';
import { STATUS_PATH, mostRecentVerification } from '../service/routes/status.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import type { GitHubVerifier } from '../service/github.ts';
import type { PollLoop } from '../service/poll/loop.ts';
import type { RunVerification } from '../service/poll/runs-types.ts';
import type { ServiceStatusBody, StatusRepositoryRow } from '../service/routes/status.ts';
import { fakeGitHub, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Stamps the planted fixtures carry; arbitrary but stable. */
const STAMP = '2026-09-28T10:00:00.000Z';

/** A later stamp, so "most recent" has something to be newer than. */
const LATER_STAMP = '2026-09-28T11:00:00.000Z';

/** Agent the fixture bindings expect, and the one a matching read-back sees. */
const EXPECTED_AGENT = 'project-manager';

/** Agent an older, mismatching read-back observed. */
const OTHER_AGENT = 'docs-writer';

/** Numeric user id the registered fixture account answers with. */
const ACCOUNT_ID = '424242';

/** Login the registered fixture account answers with. */
const ACCOUNT_LOGIN = 'octocat';

/** Credential the register call carries; it never reaches an answer. */
const REGISTERED_TOKEN = `status-credential-${'s'.repeat(32)}`;

/** Scratch directory for the deliberately unusable data directory. */
let scratch: string | null = null;

/**
 * Build a header record from pairs.
 *
 * HTTP header names are kebab-case by contract, and building them from pairs
 * keeps them out of object literals where a naming rule would read them as
 * identifiers rather than as protocol vocabulary.
 *
 * @param pairs - Header name and value pairs.
 * @returns The header record.
 */
function headers(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/**
 * A scheduler stub whose state is scripted and whose `stop()` really stops it.
 *
 * @param state - The state to report before anyone stops it.
 * @returns A loop handle the view can read.
 */
function scriptedLoop(state: { readonly stopped: boolean; readonly nextPollAtMs: number | null }): PollLoop {
    const scripted = { ...state };

    return {
        stop: (): void => {
            scripted.stopped = true;
        },
        state: () => ({ stopped: scripted.stopped, nextPollAtMs: scripted.nextPollAtMs }),
    };
}

/** Services this file started, shut down after every test. */
const running: TestService[] = [];

/** Per-test teardown the merged cases re-run by name. */
const afterEachWork1 = async (): Promise<void> => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }

    if (scratch !== null) {
        await rm(scratch, { recursive: true, force: true });
        scratch = null;
    }
};

afterEach(afterEachWork1);

/**
 * Start a service and keep it for teardown.
 *
 * @param options - Options forwarded to the harness.
 * @returns The running instance.
 */
async function start(options: Parameters<typeof startTestService>[0] = {}): Promise<TestService> {
    const service = await startTestService(options);
    running.push(service);

    return service;
}

/**
 * Read the status document through the loopback route.
 *
 * @param service - The running instance.
 * @returns The parsed health model.
 */
async function readStatus(service: TestService): Promise<ServiceStatusBody> {
    const response = await service.call(STATUS_PATH);
    expect(response.status).toBe(200);

    return (await response.json()) as ServiceStatusBody;
}

/**
 * The offline verifier the registered fixture account answers to.
 *
 * @returns A verifier whose `fetch` never leaves the test process.
 */
function accountVerifier(): GitHubVerifier {
    return fakeGitHub({
        user: {
            body: userBody({ id: Number(ACCOUNT_ID), login: ACCOUNT_LOGIN }),
            headers: headers([['x-oauth-sopes', 'repo, user']]),
        },
    }).verifier;
}

/**
 * Register the fixture account through the real credential route.
 *
 * @param service - The running instance, started with {@link accountVerifier}.
 */
async function registerAccount(service: TestService): Promise<void> {
    const response = await service.call(VERIFY_PATH, {
        method: 'POST',
        headers: headers([['content-type', 'application/json']]),
        body: JSON.stringify({ token: REGISTERED_TOKEN }),
    });

    expect(response.status).toBe(201);
}

/**
 * Build one stored binding row, keyed by a distinct repository.
 *
 * @param suffix - Distinguishes the binding id and the repository.
 * @param state - The binding's lifecycle state.
 * @returns The row as `bindings.json` stores it.
 */
function bindingRow(suffix: string, state = 'active'): Record<string, unknown> {
    return {
        bindingId: `bnd_${suffix}`,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: `acme/${suffix}`,
        projectId: 'prj_42',
        worktreeOption: 'none',
        // Every trigger off, so the poll loop walks the row and never scans it:
        // a scanned binding would rewrite its own scan-state slot and race this
        // suite's planted stamps. No scan also means no GitHub call, so the
        // whole file stays offline by construction.
        triggers: { assignment: false, mention: false, reviewRequest: false },
        state,
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/**
 * Plant bindings straight into the operator's store.
 *
 * @param service - The running instance.
 * @param rows - The rows to write.
 */
async function plantBindings(service: TestService, rows: readonly Record<string, unknown>[]): Promise<void> {
    await writeFile(join(service.dataDir, BINDINGS_FILE), JSON.stringify(rows, null, 2), 'utf8');
}

/**
 * Plant the operator's scan-state bytes for the bindings named.
 *
 * The whole document is written at once: a second single-slot write would drop
 * the slot the first one planted, which is exactly the mistake this signature
 * makes impossible to repeat.
 *
 * @param service - The running instance.
 * @param slots - Slots keyed by binding id.
 */
async function plantScanState(
    service: TestService,
    slots: Readonly<Record<string, { readonly lastScanAt: string | null; readonly lastError: string | null }>>,
): Promise<void> {
    await writeFile(join(service.dataDir, SCAN_STATE_FILE), JSON.stringify({ bindings: slots }), 'utf8');
}

/**
 * A data directory the store cannot open: its parent is a regular file.
 *
 * @returns The unusable path, with its scratch parent removed after the test.
 */
async function blockedDataDir(): Promise<string> {
    scratch = await mkdtemp(join(tmpdir(), 'mecha-turk-status-blocked-'));
    const blocker = join(scratch, 'blocker');
    await writeFile(blocker, 'i am a file', 'utf8');

    return join(blocker, 'store');
}

describe('GET /v1/status polling is computed, never literal (005 FR-031, SC-101)', () => {
    it('reports a running loop as running, with a future sta… (+5 cases)', async () => {
        // case: reports a running loop as running, with a future stamp and no reason (AC-102)
        {
            const service = await start();

            const body = await readStatus(service);

            expect(body.polling.paused).toBe(false);
            expect(body.polling.pausedReason).toBe('');
            expect(body.polling.intervalMs).toBe(DEFAULT_CONFIG.intervalMs);
            expect(body.polling.nextPollAt).not.toBeNull();
            expect(Date.parse(body.polling.nextPollAt ?? '')).toBeGreaterThan(Date.now());
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reports a stopped loop with no active binding as no-active-bindings (AC-103)
        {
            const service = await start();
            service.handle.poll?.stop();

            const body = await readStatus(service);

            expect(body.polling.paused).toBe(true);
            expect(body.polling.nextPollAt).toBeNull();
            expect(body.polling.pausedReason).toBe('no-active-bindings');
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: answers an unusable data directory with store-unavailable
        {
            const service = await start({ dataDir: await blockedDataDir() });

            const body = await readStatus(service);

            expect(body.service.status).toBe('degraded');
            expect(body.polling.paused).toBe(true);
            expect(body.polling.nextPollAt).toBeNull();
            expect(body.polling.pausedReason).toBe('store-unavailable');
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: names shutdown as stopping rather than guessing another reason
        {
            const slot = createPollingView();
            slot.beginShutdown();

            expect(slot.view.isRunning()).toBe(false);
            expect(pausedReasonOf({
                storeUsable: true,
                running: slot.view.isRunning(),
                stopping: slot.view.isStopping(),
                activeBindings: 3,
            })).toBe('stopping');
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: keeps the vocabulary closed and emits only its members
        {
            expect([...PAUSED_REASONS]).toEqual([
                'config-incomplete',
                'no-active-bindings',
                'store-unavailable',
                'stopping',
            ]);
            // The reader's half of the rule: an unknown code is not one of ours,
            // so nothing in the panel may map it to a friendly guess (FR-003).
            expect(isPausedReason('gpu-starved')).toBe(false);
            for (const reason of PAUSED_REASONS) {
                expect(isPausedReason(reason)).toBe(true);
            }
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reports config-incomplete only when the loop is stopped behind an active binding
        {
            expect(pausedReasonOf({
                storeUsable: true,
                running: false,
                stopping: false,
                activeBindings: 1,
            })).toBe('config-incomplete');
            expect(pausedReasonOf({
                storeUsable: true,
                running: true,
                stopping: false,
                activeBindings: 4,
            })).toBe('');
        }
    });
});

describe('the scheduler view reads the loop rather than copying it (005 FR-031)', () => {
    it('answers null while no loop has been observed (+3 cases)', async () => {
        // case: answers null while no loop has been observed
        {
            const slot = createPollingView();

            expect(slot.view.isRunning()).toBe(false);
            expect(nextPollAtOf(slot.view, DEFAULT_CONFIG.intervalMs)).toBeNull();
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reports the armed stamp exactly while the loop runs
        {
            const slot = createPollingView();
            const at = Date.now() + 5_000;
            slot.observe(scriptedLoop({ stopped: false, nextPollAtMs: at }));

            expect(slot.view.isRunning()).toBe(true);
            expect(nextPollAtOf(slot.view, DEFAULT_CONFIG.intervalMs)).toBe(new Date(at).toISOString());
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: falls back to the earliest possible stamp while the first cycle runs
        {
            const slot = createPollingView();
            slot.observe(scriptedLoop({ stopped: false, nextPollAtMs: null }));

            const parsed = Date.parse(nextPollAtOf(slot.view, DEFAULT_CONFIG.intervalMs) ?? '');
            expect(parsed).toBeGreaterThan(Date.now());
            expect(parsed).toBeLessThanOrEqual(Date.now() + DEFAULT_CONFIG.intervalMs);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: forgets the schedule the moment the loop is stopped
        {
            const slot = createPollingView();
            const at = Date.now() + 1_000;
            slot.observe(scriptedLoop({ stopped: true, nextPollAtMs: at }));

            expect(slot.view.isRunning()).toBe(false);
            expect(nextPollAtOf(slot.view, DEFAULT_CONFIG.intervalMs)).toBeNull();
        }
    });
});

describe('GET /v1/status repositories — one row per stored binding (005 FR-032, SC-102)', () => {
    it('keeps the member named repositories (FR-026) (+5 cases)', async () => {
        // case: keeps the member named repositories (FR-026)
        {
            const service = await start();

            const body = await readStatus(service);

            expect(Object.keys(body)).toContain('repositories');
            expect(Array.isArray(body.repositories)).toBe(true);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: answers a store with no bindings as an honest empty (AC-104, zero bindings)
        {
            const service = await start();

            const body = await readStatus(service);

            expect(body.repositories).toEqual([]);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rows one binding with every member AC-104 names
        {
            const service = await start();
            await plantBindings(service, [bindingRow('one')]);

            const body = await readStatus(service);
            const row = body.repositories[0];

            expect(body.repositories).toHaveLength(1);
            expect(row?.bindingId).toBe('bnd_one');
            expect(row?.repository).toBe('acme/one');
            expect(row?.projectId).toBe('prj_42');
            expect(row?.accountLogin).toBe(ACCOUNT_LOGIN);
            expect(row?.active).toBe(true);
            expect(row).toHaveProperty('lastScanAt');
            expect(row).toHaveProperty('lastError');
            expect(row).toHaveProperty('pendingCount');
            expect(row?.pendingCount).toBe(0);
            expect(row?.readable).toBe(true);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rows the allow-list's shape, never a login (005 FR-093, NFR-113)
        {
            const service = await start();
            await plantBindings(service, [
                { ...bindingRow('open'), allowedUsers: ['alice', 'bob'] },
                bindingRow('bare'),
            ]);

            const body = await readStatus(service);
            const listed = body.repositories.find((row) => row.bindingId === 'bnd_open');
            const bare = body.repositories.find((row) => row.bindingId === 'bnd_bare');

            // `allowedUsers` present and non-empty is `restricted`; the member's
            // absence is `open` (002 FR-047), and `'restricted'` therefore always
            // means *at least one* login.
            expect(listed?.actorPolicy).toBe('restricted');
            expect(bare?.actorPolicy).toBe('open');
            // The permitted set never leaves `bindings.json`.
            expect(JSON.stringify(body)).not.toContain('alice');
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rows five bindings, each with its own stamp, reason, and count (AC-104)
        {
            const service = await start();
            const rows = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((suffix) => bindingRow(suffix));
            await plantBindings(service, rows);
            await plantScanState(service, Object.fromEntries([
                ['bnd_alpha', { lastScanAt: STAMP, lastError: 'rate-limited' }],
                ['bnd_beta', { lastScanAt: LATER_STAMP, lastError: null }],
            ]));

            const body = await readStatus(service);

            expect(body.repositories).toHaveLength(5);
            for (const row of body.repositories) {
                expect(row).toHaveProperty('lastScanAt');
                expect(row).toHaveProperty('lastError');
                expect(typeof row.pendingCount).toBe('number');
                expect(row.readable).toBe(true);
            }

            const alpha = body.repositories.find((row) => row.bindingId === 'bnd_alpha');
            const beta = body.repositories.find((row) => row.bindingId === 'bnd_beta');
            expect(alpha?.lastScanAt).toBe(STAMP);
            expect(alpha?.lastError).toBe('rate-limited');
            expect(beta?.lastScanAt).toBe(LATER_STAMP);
            expect(beta?.lastError).toBeNull();
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: marks a binding disabled by its operator as not active
        {
            const service = await start();
            await plantBindings(service, [bindingRow('off', 'disabled')]);

            const body = await readStatus(service);

            expect(body.repositories[0]?.active).toBe(false);
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: rows an unreadable projection with readable false instead of omitting it (AC-105)
        {
            const service = await start();
            await plantBindings(service, [bindingRow('unreadable')]);
            // The run document the rows are counted from cannot be read at all.
            await writeFile(join(service.dataDir, RUNS_FILE), '{ this is not json', 'utf8');

            const body = await readStatus(service);
            const row: StatusRepositoryRow | undefined = body.repositories[0];

            expect(body.repositories).toHaveLength(1);
            expect(row?.bindingId).toBe('bnd_unreadable');
            expect(row?.readable).toBe(false);
            expect(row?.lastScanAt).toBeNull();
            expect(row?.pendingCount).toBe(0);
            // The same unreadable document must not produce a reassuring agent pin.
            expect(body.agentPin.lastVerification).toEqual({ available: false, reason: 'no-service-mirror' });
        }
    });

    it('refuses rather than inventing rows when the bindings themselves cannot be read', async () => {
        const service = await start();
        await writeFile(join(service.dataDir, BINDINGS_FILE), '[ not a binding list', 'utf8');

        const body = await readStatus(service);

        expect(body.repositories).toEqual([]);
    });
});

describe('GET /v1/status agentPin.lastVerification is widened (005 FR-033, AC-106)', () => {
    it('answers null while nothing has ever been verified, n… (+2 cases)', async () => {
        // case: answers null while nothing has ever been verified, never an ok-shaped object
        {
            const service = await start();

            const body = await readStatus(service);

            expect(body.agentPin.lastVerification).toBeNull();
            expect(body.agentPin.expectedAgent).toBeNull();
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: reports the explicit not-available marker when the runs cannot be read
        {
            const service = await start();
            await writeFile(join(service.dataDir, RUNS_FILE), 'not json at all', 'utf8');

            const body = await readStatus(service);

            expect(body.agentPin.lastVerification).toEqual({ available: false, reason: 'no-service-mirror' });
        }
        await afterEachWork1();
        await afterEachWork1();
        // case: projects the freshest read-back the service holds
        {
            const older: RunVerification = {
                observedAgent: OTHER_AGENT,
                expectedAgent: EXPECTED_AGENT,
                ok: false,
                note: 'mismatch',
                at: STAMP,
            };
            const newer: RunVerification = {
                observedAgent: EXPECTED_AGENT,
                expectedAgent: EXPECTED_AGENT,
                ok: true,
                note: null,
                at: LATER_STAMP,
            };

            expect(mostRecentVerification([{ verification: older }, { verification: newer }])).toEqual({
                observedAgent: EXPECTED_AGENT,
                expectedAgent: EXPECTED_AGENT,
                ok: true,
                at: LATER_STAMP,
            });
            expect(mostRecentVerification([{ verification: null }, { verification: older }])).toEqual({
                observedAgent: OTHER_AGENT,
                expectedAgent: EXPECTED_AGENT,
                ok: false,
                at: STAMP,
            });
            expect(mostRecentVerification([{ verification: null }])).toBeNull();
        }
    });
});

describe('GET /v1/status rate honesty (005 FR-034, AC-107)', () => {
    it('reports an unmeasured budget as null fields, never as zeros', async () => {
        const service = await start({ github: accountVerifier() });
        await registerAccount(service);

        const body = await readStatus(service);
        const account = body.accounts[0];

        expect(body.accounts).toHaveLength(1);
        expect(account?.rate.remaining).toBeNull();
        expect(account?.rate.limit).toBeNull();
        expect(account?.rate.resetAt).toBeNull();
        expect(account?.rate.usedLastHour).toBe(0);
        expect(account?.rate.conditionalSupport).toBe('unknown');
    });
});

describe('GET /v1/status carries no credential material (005 NFR-102)', () => {
    it('answers a populated document with no token-shaped text in it', async () => {
        const service = await start({ github: accountVerifier() });
        await registerAccount(service);
        await plantBindings(service, [bindingRow('scan')]);

        const response = await service.call(STATUS_PATH);
        const text = await response.text();

        expect(text).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
        expect(text).not.toMatch(/\bgithub_pat_[A-Za-z0-9_]{20,}/);
        expect(text).not.toContain('status-credential-');
    });
});
