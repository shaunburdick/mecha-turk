/** The engine adapter's four routes against the fake OpenCode server, table-driven over five seams. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineClient } from '../service/engine/client.ts';
import { MANAGED_REGISTRY_ENV, discoverEngine } from '../service/engine/discovery.ts';
import { ENGINE_VERSION_RANGE, probeInfo } from '../service/engine/info.ts';
import { postFollowUpPrompt } from '../service/engine/prompt.ts';
import { normalizedDirectory, preCheckSession } from '../service/engine/session.ts';
import { acquireToken, systemTokenSource } from '../service/engine/token.ts';
import type { TokenSource } from '../service/engine/token.ts';
import { startFakeOpenCode, tokenDouble, writeManagedRegistry } from './support/opencode-engine.ts';
import type { FakeOpenCode, PromptOutcome, SessionFixture } from './support/opencode-engine.ts';

/** A pid far above any plausible live one: dead by construction. */
const DEAD_PID = 4_194_303;

/** Directory the ownership fixtures compare against. */
const SESSION_DIR = '/workspace/checkouts/acme-loop';

/** One session fixture carrying the two pre-check members, for the happy table. */
function ownedSession(id: string, directory = SESSION_DIR): SessionFixture {
    return { id, location: { directory }, metadata: { openchamber: { provider: 'openchamber' } } };
}

describe('engine discovery (FR-104 span A; research §2.6)', () => {
    let registryDir = '';

    beforeEach(async () => {
        registryDir = await mkdtemp(join(tmpdir(), 'mecha-turk-registry-'));
    });

    afterEach(async () => {
        await rm(registryDir, { recursive: true, force: true });
    });

    it('answers the verified engine from the OPENCHAMBER_MANAGED_PROCESS_REGISTRY override', async () => {
        const fake = await startFakeOpenCode();
        try {
            await writeManagedRegistry(registryDir, fake.registryEntry());
            const env = { [MANAGED_REGISTRY_ENV]: registryDir };

            const found = await discoverEngine({ env });

            expect(found).toEqual({
                ok: true,
                engine: { pid: fake.registryEntry().pid, ownerPid: process.pid, port: fake.port },
            });
        } finally {
            await fake.shutdown();
        }
    });

    it('a live pid with no registry file is a discovery failure, not a guess', async () => {
        const missing = await discoverEngine({ env: { [MANAGED_REGISTRY_ENV]: join(registryDir, 'gone') } });
        const empty = await discoverEngine({ env: { [MANAGED_REGISTRY_ENV]: registryDir } });
        const noHome = await discoverEngine({ env: { HOME: undefined } });

        expect(missing).toEqual({ ok: false, cause: 'registry-absent' });
        expect(empty).toEqual({ ok: false, cause: 'registry-absent' });
        expect(noHome).toEqual({ ok: false, cause: 'registry-absent' });
    });

    it('finds the registry at the default HOME path when no override names a directory', async () => {
        const fake = await startFakeOpenCode();
        try {
            const home = await mkdtemp(join(tmpdir(), 'mecha-turk-home-'));
            try {
                const defaultDir = join(home, '.config/openchamber/managed-opencode');
                await writeManagedRegistry(defaultDir, fake.registryEntry());

                const found = await discoverEngine({ env: { HOME: home } });

                expect(found.ok, 'the HOME default resolved the registry').toBe(true);
            } finally {
                await rm(home, { recursive: true, force: true });
            }
        } finally {
            await fake.shutdown();
        }
    });

    const refusals: readonly (readonly [string, { readonly pid: number; readonly ownerPid: number }])[] = [
        ['a stale registry entry whose pid is dead refuses', { pid: DEAD_PID, ownerPid: process.pid }],
        ['an ownerPid that is not this process refuses', { pid: process.pid, ownerPid: process.pid + 1 }],
    ];

    for (const [name, entry] of refusals) {
        it(name, async () => {
            await writeManagedRegistry(registryDir, { ...entry, port: 1 });

            const found = await discoverEngine({ env: { [MANAGED_REGISTRY_ENV]: registryDir } });

            expect(found.ok).toBe(false);
            expect(found).toEqual({ ok: false, cause: entry.pid === DEAD_PID ? 'pid-dead' : 'owner-mismatch' });
        });
    }

    it('an unreadable registry entry refuses rather than half-reading it', async () => {
        await writeFile(join(registryDir, `${process.pid}.json`), '{"pid": ', 'utf8');

        const found = await discoverEngine({ env: { [MANAGED_REGISTRY_ENV]: registryDir } });

        expect(found).toEqual({ ok: false, cause: 'entry-unreadable' });
    });
});

describe('layered token acquisition (FR-105 span D; invariant 9)', () => {
    it('the env layer wins outright and the /proc chain is never consulted', async () => {
        let procReads = 0;
        const source: TokenSource = {
            ...tokenDouble('env', 'env-secret-value', process.pid),
            procEnviron: () => {
                procReads += 1;

                return null;
            },
        };

        const token = await acquireToken({
            source,
            engine: { pid: process.pid, ownerPid: process.pid, port: 1 },
        });

        expect(token).toEqual({ ok: true, password: 'env-secret-value' });
        expect(procReads, 'the /proc layer ran although the env layer answered').toBe(0);
    });

    it('the /proc layer answers when the env layer is dead', async () => {
        const source = tokenDouble('proc', 'proc-secret-value', process.pid);

        const token = await acquireToken({
            source,
            engine: { pid: process.pid, ownerPid: process.pid, port: 1 },
        });

        expect(token).toEqual({ ok: true, password: 'proc-secret-value' });
    });

    it('both layers dead is a classified acquisition failure', async () => {
        const token = await acquireToken({
            source: tokenDouble('dead', 'unused', process.pid),
            engine: { pid: process.pid, ownerPid: process.pid, port: 1 },
        });

        expect(token).toEqual({ ok: false, cause: 'acquisition-failed' });
    });

    const chainRefusals: readonly (readonly [string, number, number, string])[] = [
        ['a dead engine pid refuses before any /proc read', DEAD_PID, process.pid, 'pid-dead'],
        ['an ownerPid mismatch refuses the /proc chain', process.pid, process.pid + 1, 'owner-mismatch'],
    ];

    for (const [name, pid, ownerPid, cause] of chainRefusals) {
        it(name, async () => {
            const token = await acquireToken({
                source: tokenDouble('proc', 'secret-value', process.pid),
                engine: { pid, ownerPid, port: 1 },
            });

            expect(token).toEqual({ ok: false, cause });
        });
    }

    it('the live /proc reader answers for this very process', async () => {
        const environ = await systemTokenSource({}).procEnviron(process.pid);

        expect(typeof environ, '/proc self-read returned nothing').toBe('string');
        expect(environ).toContain('PATH=');
    });
});

describe('identity probe and the version pin (plan pin 1)', () => {
    it('the live-probed point and the majors around it classify per the pin', async () => {
        const fake = await startFakeOpenCode();
        try {
            const client = engineClient({ baseUrl: fake.baseUrl, password: fake.password });
            const table: readonly (readonly [string, string, boolean])[] = [
                ['the floor itself is inside', ENGINE_VERSION_RANGE.min, true],
                ['one below the floor bites', '2.0.28', false],
                ['a later minor stays inside', '2.7.1', true],
                ['the exclusive ceiling bites', ENGINE_VERSION_RANGE.maxExclusive, false],
                ['a past-the-ceiling major bites', '3.1.0', false],
                ['an unshaped version fails safe', 'nightly', false],
            ];

            for (const [name, version, inPin] of table) {
                fake.setInfo({ version });
                const probed = await probeInfo({ client, expectedPid: fake.registryEntry().pid });

                expect(probed.ok, `${name}: ${JSON.stringify(probed)}`).toBe(inPin);
                if (!inPin) {
                    expect(probed).toEqual({ ok: false, cause: 'version-outside-pin' });
                }
            }
        } finally {
            await fake.shutdown();
        }
    });

    it('a pid that disagrees with the registry file fails safe, never a hard stop', async () => {
        const fake = await startFakeOpenCode();
        try {
            fake.setInfo({ pid: process.pid + 2 });
            const client = engineClient({ baseUrl: fake.baseUrl, password: fake.password });

            const probed = await probeInfo({ client, expectedPid: process.pid });

            expect(probed).toEqual({ ok: false, cause: 'pid-mismatch' });
        } finally {
            await fake.shutdown();
        }
    });

    it('401 from /api/info is an unauthorized refusal', async () => {
        const fake = await startFakeOpenCode();
        try {
            const client = engineClient({ baseUrl: fake.baseUrl, password: 'not-the-password' });

            const probed = await probeInfo({ client, expectedPid: process.pid });

            expect(probed).toEqual({ ok: false, cause: 'unauthorized' });
        } finally {
            await fake.shutdown();
        }
    });
});

/** Start one fake serving one session fixture, and a client talking to it. */
async function clientFor(session: SessionFixture | undefined, clientPassword?: string): Promise<{
    readonly client: ReturnType<typeof engineClient>;
    readonly fake: FakeOpenCode;
}> {
    const fake = await startFakeOpenCode();
    if (session !== undefined) {
        fake.setSession(session);
    }

    return {
        client: engineClient({ baseUrl: fake.baseUrl, password: clientPassword ?? fake.password }),
        fake,
    };
}

describe('the ownership pre-check against the dispatch-reported directory (plan pin 2)', () => {
    const sessionId = 'ses_owner_check';

    const matches: readonly (readonly [string, string, string])[] = [
        ['an exact match passes', SESSION_DIR, SESSION_DIR],
        ['a trailing separator on the session normalizes', `${SESSION_DIR}/`, SESSION_DIR],
        ['a trailing separator on the report normalizes', SESSION_DIR, `${SESSION_DIR}/`],
    ];

    for (const [name, fixtureDirectory, reported] of matches) {
        it(name, async () => {
            const { client, fake } = await clientFor(ownedSession(sessionId, fixtureDirectory));
            try {
                const verdict = await preCheckSession({ client, sessionId, directory: reported });

                expect(verdict).toEqual({ ok: true });
            } finally {
                await fake.shutdown();
            }
        });
    }

    const mismatches: readonly (readonly [string, string])[] = [
        ['a foreign directory fails safe', '/workspace/checkouts/someone-else'],
        ['a nested directory fails safe — no prefix rule', `${SESSION_DIR}/sub/dir`],
        ['a sibling sharing the prefix fails safe', `${SESSION_DIR}-two`],
    ];

    for (const [name, reported] of mismatches) {
        it(name, async () => {
            const { client, fake } = await clientFor(ownedSession(sessionId));
            try {
                const verdict = await preCheckSession({ client, sessionId, directory: reported });

                expect(verdict).toEqual({ ok: false, cause: 'directory-mismatch' });
                expect(fake.messages, 'a refused pre-check must issue no admission').toHaveLength(0);
            } finally {
                await fake.shutdown();
            }
        });
    }

    it('an absent dispatch-reported directory refuses before any request', async () => {
        const { client, fake } = await clientFor(ownedSession(sessionId));
        try {
            const verdict = await preCheckSession({ client, sessionId, directory: undefined });

            expect(verdict).toEqual({ ok: false, cause: 'directory-absent' });
            expect(fake.requests, 'the pre-check asked the engine although it had nothing to compare').toHaveLength(0);
        } finally {
            await fake.shutdown();
        }
    });

    it('a session record without location.directory fails safe', async () => {
        const { client, fake } = await clientFor({ id: sessionId, metadata: { openchamber: {} } });
        try {
            const verdict = await preCheckSession({ client, sessionId, directory: SESSION_DIR });

            expect(verdict).toEqual({ ok: false, cause: 'location-absent' });
        } finally {
            await fake.shutdown();
        }
    });

    it('metadata.openchamber presence is required even on an exact directory match', async () => {
        const { client, fake } = await clientFor({ id: sessionId, location: { directory: SESSION_DIR } });
        try {
            const verdict = await preCheckSession({ client, sessionId, directory: SESSION_DIR });

            expect(verdict).toEqual({ ok: false, cause: 'metadata-absent' });
        } finally {
            await fake.shutdown();
        }
    });

    it('the engine 404 for the run session is refused by name', async () => {
        const { client, fake } = await clientFor(ownedSession(sessionId));
        try {
            const verdict = await preCheckSession({
                client,
                sessionId: 'ses_never_registered',
                directory: SESSION_DIR,
            });

            expect(verdict).toEqual({ ok: false, cause: 'session-404' });
        } finally {
            await fake.shutdown();
        }
    });

    it('401 from the pre-check is an unauthorized refusal', async () => {
        const { client, fake } = await clientFor(ownedSession(sessionId), 'not-the-password');
        try {
            const verdict = await preCheckSession({ client, sessionId, directory: SESSION_DIR });

            expect(verdict).toEqual({ ok: false, cause: 'unauthorized' });
        } finally {
            await fake.shutdown();
        }
    });

    it('normalization trims trailing separators and nothing else', () => {
        expect(normalizedDirectory('/a/b/')).toBe('/a/b');
        expect(normalizedDirectory('/a/b///')).toBe('/a/b');
        expect(normalizedDirectory('C:/a/b/')).toBe('C:/a/b');
        expect(normalizedDirectory('/a/b')).toBe('/a/b');
        expect(normalizedDirectory('/a/bc')).toBe('/a/bc');
    });

    it('both dispatch shapes flow into the comparison exactly as reported (Gate 2 Medium C)', async () => {
        // A `worktreeOption: 'none'` dispatch reports `result.directory`; a worktree
        // dispatch reports `worktree.directory` — each value only matches its own session.
        const shapes: readonly (readonly [string, string])[] = [
            ['result.directory (worktreeOption none)', '/workspace/checkouts/acme-loop'],
            ['worktree.directory (worktree dispatch)', '/workspace/checkouts/acme-loop-worktrees/wt-1'],
        ];

        for (const [shape, reported] of shapes) {
            const { client, fake } = await clientFor(ownedSession(sessionId, reported));
            try {
                const verdict = await preCheckSession({ client, sessionId, directory: reported });
                const other = shapes.find(([name]) => name !== shape)?.[1] ?? '';

                expect(verdict, `${shape} did not flow into the comparison`).toEqual({ ok: true });
                expect(
                    await preCheckSession({ client, sessionId, directory: other }),
                    `${shape} accepted the other shape's directory`,
                ).toEqual({ ok: false, cause: 'directory-mismatch' });
            } finally {
                await fake.shutdown();
            }
        }
    });
});

describe('the admission POST and its closed classification (FR-105 span E)', () => {
    const sessionId = 'ses_admission';

    it('an admitted prompt is flat-bodied and answers with the msg receipt', async () => {
        const fake = await startFakeOpenCode({ sessions: [ownedSession(sessionId)] });
        try {
            const client = engineClient({ baseUrl: fake.baseUrl, password: fake.password });

            const admission = await postFollowUpPrompt({ client, sessionId, text: 'follow-up text' });

            expect(admission).toEqual({ kind: 'admitted', messageId: fake.messages[0]?.id });
            const prompt = fake.requests.find((request) => request.method === 'POST');
            const body = JSON.parse(prompt?.body ?? '{}') as Record<string, unknown>;
            expect(body).toEqual({ text: 'follow-up text', delivery: 'queue' });
        } finally {
            await fake.shutdown();
        }
    });

    const answers: readonly (readonly [PromptOutcome, unknown])[] = [
        ['5xx', { kind: 'unknown', cause: 'server-failure' }],
        ['malformed-200', { kind: 'unknown', cause: 'malformed-receipt' }],
        ['401', { kind: 'unauthorized' }],
        ['404', { kind: 'no-session' }],
    ];

    for (const [outcome, expected] of answers) {
        it(`a ${outcome} answer settles as ${JSON.stringify(expected)}`, async () => {
            const fake = await startFakeOpenCode({ promptOutcome: outcome, sessions: [ownedSession(sessionId)] });
            try {
                const client = engineClient({ baseUrl: fake.baseUrl, password: fake.password });

                const admission = await postFollowUpPrompt({ client, sessionId, text: 'follow-up text' });

                expect(admission).toEqual(expected);
            } finally {
                await fake.shutdown();
            }
        });
    }

    it('a stalled engine answers the bounded timeout, classified as unknown', async () => {
        const fake = await startFakeOpenCode({ promptOutcome: 'stall', sessions: [ownedSession(sessionId)] });
        try {
            const client = engineClient({ baseUrl: fake.baseUrl, password: fake.password, timeoutMs: 50 });

            const admission = await postFollowUpPrompt({ client, sessionId, text: 'follow-up text' });

            expect(admission).toEqual({ kind: 'unknown', cause: 'timeout' });
            await fake.whenStalled(1);
        } finally {
            await fake.shutdown();
        }
    });

    it('a closed loopback port is a connection refusal, never an unknown', async () => {
        const fake = await startFakeOpenCode();
        const deadPort = fake.port;
        await fake.shutdown();
        const client = engineClient({ baseUrl: `http://127.0.0.1:${deadPort}`, password: 'irrelevant' });

        const admission = await postFollowUpPrompt({ client, sessionId, text: 'follow-up text' });

        expect(admission).toEqual({ kind: 'refused' });
    });
});
