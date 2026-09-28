/**
 * Credential persistence and rotation tests (task T-008, contract §2.2/§6).
 *
 * The suite runs the real service against a fake GitHub, then inspects the
 * *files* the custody layer wrote: owner-only modes, the rotation-invariance
 * diff contract §6 pins (credential/login/scopeCheck/verifiedAt and nothing
 * else), the byte-identical store after a mismatched rotation, and the F13
 * startup reconciliation that keeps a crashed handoff from being left in a
 * transient state across restarts.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../src/consent.ts';
import { ACCOUNTS_DIR, BINDINGS_FILE } from '../service/accounts/store.ts';
import { ACCOUNTS_PATH, ACCOUNT_PATH, ACCOUNT_TOKEN_PATH } from '../service/routes/accounts.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import { STATUS_PATH } from '../service/routes/status.ts';
import type { AccountDto } from '../service/accounts/model.ts';
import type { GitHubVerifier } from '../service/github.ts';
import { fakeGitHub, scriptedVerifier, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { EndpointResponse, GitHubScript } from './support/github.ts';
import type { TestService } from './support/service.ts';

/** Credential registered with this suite's scans; deliberately un-prefixed. */
const REGISTERED_TOKEN = `registered-persist-credential-${'p'.repeat(32)}`;

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = 77_331;

/** Login the fixture token belongs to at first verification. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Login the same account reports after a rename (rotation refreshes it). */
const ROTATED_LOGIN = 'octocat-renamed';

/** Numeric id a rotation must refuse because it belongs to another account. */
const OTHER_ACCOUNT_ID = 99_111;

/** Filesystem mask covering the low nine mode bits. */
const PERMISSION_BASE = 0o1000;

/** Path parameter placeholder shared by the account route paths. */
const ACCOUNT_PATH_PARAM = ':numericUserId';

/** Name of the append-only audit trail inside the data directory. */
const AUDIT_FILE = 'audit.ndjson';

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Data directories a test owns outside the harness home, drained too. */
const ownedDirs: string[] = [];

afterEach(async () => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }
    while (ownedDirs.length > 0) {
        const dir = ownedDirs.pop();
        if (dir !== undefined) {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

/**
 * Build a header map without writing HTTP header names as object keys.
 *
 * @param pairs - Header name/value pairs.
 * @returns The headers as `fetch` accepts them.
 */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/**
 * Build a JSON `content-type` header map.
 *
 * @returns The headers for one JSON POST.
 */
function jsonHeaders(): Record<string, string> {
    return headerMap([['content-type', 'application/json']]);
}

/** Identity answer used by the first verification (a classic `repo` token). */
const USER_OK: EndpointResponse = {
    body: userBody({ id: ACCOUNT_ID, login: ACCOUNT_LOGIN }),
    headers: headerMap([['x-oauth-scopes', 'repo, user']]),
};

/** The same identity after a login rename, for the rotation diff. */
const USER_RENAMED: EndpointResponse = { ...USER_OK, body: userBody({ id: ACCOUNT_ID, login: ROTATED_LOGIN }) };

/** A token belonging to a *different* numeric id, which rotation must refuse. */
const USER_OTHER_ID: EndpointResponse = { ...USER_OK, body: userBody({ id: OTHER_ACCOUNT_ID, login: ACCOUNT_LOGIN }) };

/**
 * Narrow an optional data directory into an options fragment.
 *
 * @param dataDir - Shared directory, when the test supplies one.
 * @returns The fragment to spread over harness options.
 */
function pickDataDir(dataDir: string | undefined): { dataDir: string } | Record<string, never> {
    return dataDir === undefined ? {} : { dataDir };
}

/**
 * Start the service with an explicit verifier.
 *
 * @param verifier - Verifier under test (a fake or a scripted double).
 * @param dataDir - Optional shared data directory (restart tests).
 * @returns The running harness instance.
 */
async function startWithVerifier(verifier: GitHubVerifier, dataDir?: string): Promise<TestService> {
    const service = await startTestService({ github: verifier, ...pickDataDir(dataDir) });
    running.push(service);
    await service.handle.reconciled;

    return service;
}

/**
 * Start the service with a scripted GitHub.
 *
 * @param script - Answers for `/user` and `/rate_limit`.
 * @param dataDir - Optional shared data directory (restart tests).
 * @returns The running harness instance.
 */
async function startService(script: GitHubScript, dataDir?: string): Promise<TestService> {
    return await startWithVerifier(fakeGitHub(script).verifier, dataDir);
}

/**
 * Build the current credential-route body.
 *
 * @param token - Credential to present.
 * @returns The serialized request body.
 */
function credentialBody(token: string): string {
    return JSON.stringify({ token, consentVersion: CONSENT_VERSION });
}

/**
 * Verify the fixture credential once, registering the account.
 *
 * @param service - Harness instance.
 * @returns The `201` response.
 */
function registerAccount(service: TestService): Promise<Response> {
    return service.call(VERIFY_PATH, {
        method: 'POST',
        headers: jsonHeaders(),
        body: credentialBody(REGISTERED_TOKEN),
    });
}

/**
 * Verify the fixture credential, exercising the full handoff.
 *
 * @param service - Harness instance.
 * @returns The decoded `201` body.
 */
async function verifyOk(service: TestService): Promise<Record<string, unknown>> {
    const response = await registerAccount(service);
    expect(response.status).toBe(201);

    return (await response.json()) as Record<string, unknown>;
}

/**
 * Rotate the fixture account's credential.
 *
 * @param service - Harness instance.
 * @param token - Replacement credential.
 * @param userId - Path id; defaults to the fixture account.
 * @returns The response.
 */
function rotateToken(options: {
    /** Harness instance to call. */
    readonly service: TestService;
    /** Replacement credential. */
    readonly token: string;
    /** Path id; defaults to the fixture account. */
    readonly userId?: string;
}): Promise<Response> {
    const { service, token, userId = String(ACCOUNT_ID) } = options;

    return service.call(ACCOUNT_TOKEN_PATH.replace(ACCOUNT_PATH_PARAM, userId), {
        method: 'POST',
        headers: jsonHeaders(),
        body: credentialBody(token),
    });
}

/**
 * Read the stored account document as raw JSON.
 *
 * @param dataDir - Data directory owning the store.
 * @returns The parsed document.
 */
async function readStoredAccount(dataDir: string): Promise<Record<string, unknown>> {
    const text = await readFile(join(dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`), 'utf8');

    return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Create a data directory outside the harness home so it can outlive a restart.
 *
 * @returns The absolute directory path.
 */
async function sharedDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mecha-turk-accounts-'));
    ownedDirs.push(dir);
    await mkdir(dir, { recursive: true });

    return dir;
}

/**
 * Verify an account, then rewrite its state as a crashed handoff would.
 *
 * @param state - Transient state to plant (`verifying` or `pending_handoff`).
 * @returns The shared data directory holding the planted account.
 */
async function plantTransientAccount(state: string): Promise<string> {
    const dataDir = await sharedDataDir();
    const service = await startService({ user: USER_OK }, dataDir);
    await verifyOk(service);
    const account = { ...(await readStoredAccount(dataDir)), state };
    await writeFile(join(dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`), JSON.stringify(account), 'utf8');
    await service.shutdown();

    return dataDir;
}

describe('GET /v1/accounts — credential-free DTOs (contract §2.2)', () => {
    it('returns the account without any credential member', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        const response = await service.call(ACCOUNTS_PATH);
        const body = (await response.json()) as { accounts: AccountDto[] };
        const account = body.accounts[0];

        expect(response.status).toBe(200);
        expect(body.accounts).toHaveLength(1);
        expect(account).toMatchObject({
            numericUserId: String(ACCOUNT_ID),
            login: ACCOUNT_LOGIN,
            state: 'active',
            connectionState: 'connected',
        });
        expect(Object.keys(account ?? {})).not.toContain('credential');

        // Compile-time proof: if `credential` ever joins the DTO, this line
        // stops type-checking and `npm run verify` fails (contract §2.2).
        type NeverWhenCredentialed = 'credential' extends keyof AccountDto ? never : true;
        const credentialFree: NeverWhenCredentialed = true;
        expect(credentialFree).toBe(true);
    });

    it('keeps the credential out of the serialized responses, logs, and audit', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        const list = await service.call(ACCOUNTS_PATH);
        const listText = await list.text();
        const status = await service.call(STATUS_PATH);
        const statusText = await status.text();
        const audit = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8').catch(() => '');
        const surfaces = [listText, statusText, audit, ...service.logLines].join('\n');

        expect(surfaces).not.toContain(REGISTERED_TOKEN);
        expect(listText).not.toContain('credential');
    });
});

describe('POST /v1/accounts/:id/token — rotation (FR-012, SEC-06)', () => {
    it('refreshes only credential, login, scopeCheck, and verifiedAt', async () => {
        const github = fakeGitHub({ user: USER_OK });
        const service = await startWithVerifier(github.verifier);
        await verifyOk(service);
        const before = await readStoredAccount(service.dataDir);
        const auditBefore = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8');
        github.setScript({ user: USER_RENAMED });

        const response = await rotateToken({ service, token: `${REGISTERED_TOKEN}-rotated` });
        const body = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ numericUserId: String(ACCOUNT_ID), login: ROTATED_LOGIN });
        const after = await readStoredAccount(service.dataDir);

        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
        const changed = Object.keys(after)
            .filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]))
            .sort();
        expect(changed).toEqual(['credential', 'login', 'scopeCheck', 'verifiedAt']);
        expect(after.numericUserId).toBe(String(ACCOUNT_ID));

        // Audit history is append-only: every earlier row survives untouched.
        const auditAfter = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8');
        expect(auditAfter.startsWith(auditBefore)).toBe(true);
        expect(auditAfter).toContain('account.rotated');
    });

    it('stores the rotated credential owner-only', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        await rotateToken({ service, token: `${REGISTERED_TOKEN}-rotated` });

        const file = join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
        const info = await stat(file);
        expect(info.mode % PERMISSION_BASE).toBe(0o600);
    });

    it('refuses a token whose numeric id differs, leaving the store byte-identical', async () => {
        const github = fakeGitHub({ user: USER_OK });
        const service = await startWithVerifier(github.verifier);
        await verifyOk(service);
        const accountFile = join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
        const before = await readFile(accountFile, 'utf8');
        github.setScript({ user: USER_OTHER_ID });

        const response = await rotateToken({ service, token: `${REGISTERED_TOKEN}-impostor` });
        const error = (await response.json()) as { error?: { code?: string } };

        expect(response.status).toBe(422);
        expect(error.error?.code).toBe('account-rejected');
        expect(await readFile(accountFile, 'utf8')).toBe(before);
    });

    it('requires a current consentVersion before anything is written', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const accountFile = join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
        const before = await readFile(accountFile, 'utf8');

        const response = await service.call(ACCOUNT_TOKEN_PATH.replace(ACCOUNT_PATH_PARAM, String(ACCOUNT_ID)), {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ token: `${REGISTERED_TOKEN}-rotated` }),
        });
        const error = (await response.json()) as { error?: { code?: string } };

        expect(response.status).toBe(422);
        expect(error.error?.code).toBe('consent-required');
        expect(await readFile(accountFile, 'utf8')).toBe(before);
    });

    it('answers 404 for an account that does not exist', async () => {
        const service = await startService({ user: USER_OK });

        const response = await rotateToken({ service, token: REGISTERED_TOKEN, userId: String(OTHER_ACCOUNT_ID) });
        const error = (await response.json()) as { error?: { code?: string } };

        expect(response.status).toBe(404);
        expect(error.error?.code).toBe('unknown-account');
    });

    it('restores an errored account to active after a successful rotation', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const errored = { ...(await readStoredAccount(service.dataDir)), state: 'error', errorReason: 'auth-failed' };
        await writeFile(join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`), JSON.stringify(errored), 'utf8');

        const response = await rotateToken({ service, token: `${REGISTERED_TOKEN}-rotated` });

        expect(response.status).toBe(200);
        const after = await readStoredAccount(service.dataDir);
        expect(after.state).toBe('active');
        expect(after.errorReason).toBeNull();
    });
});

describe('DELETE /v1/accounts/:id — operator-driven removal (§2.2, §4 rule 7)', () => {
    it('removes the account when no binding references it', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        const response = await service.call(ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, String(ACCOUNT_ID)), {
            method: 'DELETE',
        });
        const body = (await response.json()) as { removed?: boolean };
        const audit = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8');

        expect(response.status).toBe(200);
        expect(body.removed).toBe(true);
        await expect(stat(join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`))).rejects.toThrow();
        expect(audit).toContain('account.deleted');
    });

    it('refuses while a binding references the account, unless force=1', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const binding = { bindingId: 'bind-1', accountNumericUserId: String(ACCOUNT_ID), state: 'active' };
        await writeFile(join(service.dataDir, BINDINGS_FILE), JSON.stringify([binding]), 'utf8');
        const path = ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, String(ACCOUNT_ID));

        const refused = await service.call(path, { method: 'DELETE' });
        const error = (await refused.json()) as { error?: { code?: string } };

        expect(refused.status).toBe(409);
        expect(error.error?.code).toBe('invalid-transition');
        await expect(stat(join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`))).resolves.toBeDefined();

        const forced = await service.call(`${path}?force=1`, { method: 'DELETE' });
        const stored = (await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8'));
        const audit = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8');
        const bindings = JSON.parse(stored) as { state: string }[];

        expect(forced.status).toBe(200);
        expect(bindings).toEqual([{ ...binding, state: 'disabled' }]);
        expect(audit).toContain('binding.disabled');
        expect(audit).toContain('account.deleted');
    });

    it('answers 404 for an unknown or non-numeric id', async () => {
        const service = await startService({ user: USER_OK });

        for (const id of [String(OTHER_ACCOUNT_ID), 'not-a-number']) {
            const response = await service.call(ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, id), { method: 'DELETE' });
            const error = (await response.json()) as { error?: { code?: string } };
            expect(response.status).toBe(404);
            expect(error.error?.code).toBe('unknown-account');
        }
    });
});

describe('GET /v1/status — handoff pre-flight (contract §2.1, SEC-08)', () => {
    it('reports storage.writable and the registered accounts', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        const response = await service.call(STATUS_PATH);
        const body = (await response.json()) as {
            service: { storage?: { writable?: boolean }; status: string };
            accounts: { numericUserId: string; connectionState: string; rate: { usedLastHour: number } }[];
        };

        expect(response.status).toBe(200);
        expect(body.service.storage).toEqual({ writable: true });
        expect(body.service.status).toBe('ok');
        expect(body.accounts).toHaveLength(1);
        expect(body.accounts[0]).toMatchObject({ numericUserId: String(ACCOUNT_ID), connectionState: 'connected' });
        expect(body.accounts[0]?.rate.usedLastHour).toBe(0);
    });
});

describe('F13 — startup reconciliation of interrupted handoffs', () => {
    it('marks a stranded account error:interrupted-handoff when re-verification fails', async () => {
        const dataDir = await plantTransientAccount('verifying');
        const rejecter = scriptedVerifier(() => ({ kind: 'rejected' as const, reason: 'auth-failed' as const }));
        const service = await startWithVerifier(rejecter.verifier, dataDir);

        // Await the reconciliation pass before reading anything it writes —
        // the helper already waited once, this states the dependency for the
        // assertions that follow (T-009o flake-guard).
        const summary = await service.handle.reconciled;
        const account = await readStoredAccount(dataDir);
        const audit = await readFile(join(dataDir, AUDIT_FILE), 'utf8');

        expect(summary).toMatchObject({ examined: 1, marked: 1, restored: 0 });
        expect(account.state).toBe('error');
        expect(account.errorReason).toBe('interrupted-handoff');
        expect(audit).toContain('"eventType":"account.error"');
        expect(account.state).not.toBe('verifying');
    });

    it('re-verifies a stranded account back to active when GitHub still knows it', async () => {
        const dataDir = await plantTransientAccount('pending_handoff');
        const service = await startService({ user: USER_RENAMED }, dataDir);

        // Await the reconciliation pass before reading anything it writes
        // (T-009o flake-guard; see the sibling case above).
        const summary = await service.handle.reconciled;
        const account = await readStoredAccount(dataDir);
        const audit = await readFile(join(dataDir, AUDIT_FILE), 'utf8');

        expect(summary).toMatchObject({ examined: 1, marked: 1, restored: 1 });
        expect(account.state).toBe('active');
        expect(account.login).toBe(ROTATED_LOGIN);
        expect(account.errorReason).toBeNull();
        expect(audit).toContain('"eventType":"account.error"');
        expect(audit).toContain('interrupted handoff re-verified at startup');
    });
});
