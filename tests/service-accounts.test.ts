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
import { ACCOUNTS_DIR, BINDINGS_FILE } from '../service/accounts/store.ts';
import {
    ACCOUNTS_PATH,
    ACCOUNT_DISPLAY_NAME_PATH,
    ACCOUNT_PATH,
    ACCOUNT_TOKEN_PATH,
} from '../service/routes/accounts.ts';
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

/** Code the refusal envelope carries when no account holds the path id. */
const UNKNOWN_ACCOUNT_CODE = 'unknown-account';

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
    return JSON.stringify({ token });
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

    it('answers 404 for an account that does not exist', async () => {
        const service = await startService({ user: USER_OK });

        const response = await rotateToken({ service, token: REGISTERED_TOKEN, userId: String(OTHER_ACCOUNT_ID) });
        const error = (await response.json()) as { error?: { code?: string } };

        expect(response.status).toBe(404);
        expect(error.error?.code).toBe(UNKNOWN_ACCOUNT_CODE);
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
            expect(error.error?.code).toBe(UNKNOWN_ACCOUNT_CODE);
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

/** The field name every display-name refusal on that route names. */
const FIELD = 'displayName';

/** A planted sentinel inside a credential-shaped value (AC-130). */
const SENTINEL = 'zzPLANTEDzz';

/**
 * PUT one display-name body against a routed account path.
 *
 * @param options - Harness instance, the path id, and the request body.
 * @returns The response.
 */
function putDisplayNameAt(options: {
    /** Harness instance to call. */
    readonly service: TestService;
    /** Path id the label is written against. */
    readonly userId: string;
    /** Request body exactly as the client would send it. */
    readonly body: string;
}): Promise<Response> {
    const { service, userId, body } = options;

    return service.call(ACCOUNT_DISPLAY_NAME_PATH.replace(ACCOUNT_PATH_PARAM, userId), {
        method: 'PUT',
        headers: jsonHeaders(),
        body,
    });
}

/**
 * PUT one display-name body against the fixture account's path.
 *
 * @param service - Harness instance.
 * @param body - The request body exactly as the client would send it.
 * @returns The response.
 */
function putDisplayName(service: TestService, body: string): Promise<Response> {
    return putDisplayNameAt({ service, userId: String(ACCOUNT_ID), body });
}

/**
 * PUT one display-name body and report the response status alone.
 *
 * @param service - Harness instance.
 * @param body - The request body exactly as the client would send it.
 * @returns The HTTP status the service answered.
 */
async function putStatus(service: TestService, body: string): Promise<number> {
    const response = await putDisplayName(service, body);

    return response.status;
}

/**
 * Read the refusal envelope's first issue.
 *
 * @param response - The `422` answer.
 * @returns Its `field` and remediation.
 */
async function issueOf(response: Response): Promise<{ readonly field: string; readonly remediation: string }> {
    const body = (await response.json()) as {
        readonly error: { readonly issues: { readonly field: string; readonly remediation: string }[] };
    };

    return body.error.issues[0] ?? { field: '', remediation: '' };
}

/**
 * Read the stored account document straight from the service's directory.
 *
 * @param service - Harness instance owning the directory.
 * @returns The parsed record.
 */
async function storedAccount(service: TestService): Promise<Record<string, unknown>> {
    return await readStoredAccount(service.dataDir);
}

/**
 * The absolute path of the fixture account's stored record.
 *
 * @param service - Harness instance owning the directory.
 * @returns The path.
 */
function accountFileOf(service: TestService): string {
    return join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
}

describe('PUT /v1/accounts/:id/display-name — the one display-only field (005 FR-066)', () => {
    it('stores a label, trims it, and changes nothing but the label and its stamp', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const before = await storedAccount(service);

        const response = await putDisplayName(service, JSON.stringify({ displayName: '  Octo platform  ' }));
        const body = (await response.json()) as { readonly account: AccountDto };

        expect(response.status).toBe(200);
        expect(body.account.displayName).toBe('Octo platform');
        expect('credential' in body.account).toBe(false);

        const after = await storedAccount(service);
        const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
        expect(changed).toContain(FIELD);
        expect(changed.filter((key) => key !== FIELD && key !== 'updatedAt')).toEqual([]);
    });

    it('refuses a body that does not carry the member, rather than no-oping', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const file = accountFileOf(service);
        const before = await readFile(file, 'utf8');

        const response = await putDisplayName(service, JSON.stringify({}));
        const issue = await issueOf(response);

        expect(response.status).toBe(422);
        expect(issue.field).toBe(FIELD);
        expect(issue.remediation).not.toBe('');
        expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('refuses a credential-shaped value by field, never echoing what was sent (AC-130)', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        await putDisplayName(service, JSON.stringify({ displayName: 'the label in force' }));
        const file = accountFileOf(service);
        const before = await readFile(file, 'utf8');
        const submitted = `ghp_${SENTINEL}${'a'.repeat(24)}`;

        const response = await putDisplayName(service, JSON.stringify({ displayName: submitted }));
        const text = await response.text();
        const parsed = JSON.parse(text) as {
            readonly error: { readonly issues: { readonly field: string; readonly remediation: string }[] };
        };
        const issue = parsed.error.issues[0] ?? { field: '', remediation: '' };

        expect(response.status).toBe(422);
        expect(issue.field).toBe(FIELD);
        expect(issue.remediation).toContain('credential-shaped material');
        expect(text).not.toContain(SENTINEL);
        // The previous label stays in force, byte for byte.
        expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('clears on null and on empty-after-trim, and refuses anything that is not text', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        expect(await putStatus(service, JSON.stringify({ displayName: 'kept' }))).toBe(200);
        expect(await putStatus(service, JSON.stringify({ displayName: '   ' }))).toBe(200);
        const afterBlank = await storedAccount(service);
        expect(afterBlank[FIELD]).toBeNull();

        expect(await putStatus(service, JSON.stringify({ displayName: 'back again' }))).toBe(200);
        expect(await putStatus(service, JSON.stringify({ displayName: null }))).toBe(200);
        const afterNull = await storedAccount(service);
        expect(afterNull[FIELD]).toBeNull();

        const refused = await putDisplayName(service, JSON.stringify({ displayName: 42 }));
        expect(refused.status).toBe(422);
        const issue = await issueOf(refused);
        expect(issue.field).toBe(FIELD);
    });

    it('caps the label at 80 code points and refuses control characters', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        expect(await putStatus(service, JSON.stringify({ displayName: 'x'.repeat(80) }))).toBe(200);

        const overCap = await putDisplayName(service, JSON.stringify({ displayName: 'x'.repeat(81) }));
        const capIssue = await issueOf(overCap);
        expect(overCap.status).toBe(422);
        expect(capIssue.field).toBe(FIELD);
        expect(capIssue.remediation).toContain('80');

        const controlled = await putDisplayName(service, JSON.stringify({ displayName: 'badname\u0007x' }));

        const controlIssue = await issueOf(controlled);
        expect(controlled.status).toBe(422);
        expect(controlIssue.field).toBe(FIELD);
        expect(controlIssue.remediation).toContain('control characters');
        expect(controlIssue.remediation).not.toContain('bad');
    });

    it('reads as null for a store that predates the field, rewriting nothing (FR-005)', async () => {
        const dataDir = await sharedDataDir();
        const service = await startService({ user: USER_OK }, dataDir);
        await verifyOk(service);
        const file = join(dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
        const legacy = await readStoredAccount(dataDir);
        const withoutLabel = Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== FIELD));
        await writeFile(file, JSON.stringify(withoutLabel, null, 2), 'utf8');
        const bytes = await readFile(file, 'utf8');

        const response = await service.call(ACCOUNTS_PATH);
        const body = (await response.json()) as { readonly accounts: readonly AccountDto[] };

        expect(body.accounts[0]?.displayName).toBeNull();
        expect(await readFile(file, 'utf8')).toBe(bytes);
    });

    it('keeps the label when an upstream login rename refreshes the login (AC-128)', async () => {
        const github = fakeGitHub({ user: USER_OK });
        const service = await startWithVerifier(github.verifier);
        await verifyOk(service);
        expect(await putStatus(service, JSON.stringify({ displayName: 'Platform team' }))).toBe(200);
        github.setScript({ user: USER_RENAMED });

        const rotated = await rotateToken({ service, token: `${REGISTERED_TOKEN}-rotated` });
        expect(rotated.status).toBe(200);

        const listed = await service.call(ACCOUNTS_PATH);
        const body = (await listed.json()) as { readonly accounts: readonly AccountDto[] };

        expect(body.accounts[0]?.login).toBe(ROTATED_LOGIN);
        expect(body.accounts[0]?.displayName).toBe('Platform team');
    });

    it('answers a populated label with no credential-shaped text (AC-129)', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const benign = 'Platform owned by the release rotation, contact ops';
        expect(await putStatus(service, JSON.stringify({ displayName: benign }))).toBe(200);

        const listed = await service.call(ACCOUNTS_PATH);
        const text = await listed.text();

        expect(text).toContain(benign);
        expect(text).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
        expect(text).not.toMatch(/\bgithub_pat_[A-Za-z0-9_]{20,}/);
    });

    it('answers 404 for an id no account holds', async () => {
        const service = await startService({ user: USER_OK });

        const body = JSON.stringify({ displayName: 'nobody' });
        const response = await putDisplayNameAt({ service, userId: '123456789', body });
        const envelope = (await response.json()) as { error?: { code?: string } };

        expect(response.status).toBe(404);
        expect(envelope.error?.code).toBe(UNKNOWN_ACCOUNT_CODE);
    });
});
