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

import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_PROMPT_UPDATED_EVENT } from '../service/account-prompt-audit.ts';
import { ACCOUNTS_DIR, BINDINGS_FILE } from '../service/accounts/store.ts';
import { readAuditEntries } from '../service/audit.ts';
import { credentialRemediation, promptFingerprint } from '../service/prompt.ts';
import {
    ACCOUNTS_PATH,
    ACCOUNT_PATH,
    ACCOUNT_TOKEN_PATH,
} from '../service/routes/accounts.ts';
import { ROUTES } from '../service/routes/index.ts';
import { VERIFY_PATH } from '../service/routes/verify.ts';
import { STATUS_PATH } from '../service/routes/status.ts';
import { findSecretLeak } from '../src/redaction.ts';
import type { AuditEntry } from '../service/audit.ts';
import type { AccountDto } from '../service/accounts/model.ts';
import type { GitHubVerifier } from '../service/github.ts';
import { byText } from './support/sort.ts';
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

/** The type-refusal fragment every non-text stored prompt carries (FR-017). */
const TEXT_REQUIRED_FRAGMENT = 'must be text';

/** The instruction seed wherever a tier must already be set. */
const SEEDED_PROMPT = 'Always reproduce before patching.';

/** The label seeded beside {@link SEEDED_PROMPT} whenever both members are set. */
const SEEDED_LABEL = 'Platform team';

/** The label the refusal tests keep in force across a refused write. */
const KEPT_LABEL = 'Kept label';

/** The label a two-member body writes over the first one. */
const SECOND_LABEL = 'Second label';

/** The prompt head every "never the text" scan looks for. */
const PROMPT_HEAD = 'Reproduce first';

/** The event a forced account removal writes (002 FR-035). */
const ACCOUNT_DELETED_EVENT = 'account.deleted';

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

/** Data directories a test owns outside the harness home, drained too. */
const ownedDirs: string[] = [];

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
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

    return service.call(ACCOUNT_TOKEN_PATH.replace(ACCOUNT_PATH_PARAM, () => userId), {
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
        {
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
        }
    });

    it('keeps the credential out of the serialized responses, logs, and audit', async () => {
        {
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
        }
    });

});

describe('POST /v1/accounts/:id/token — rotation (FR-012, SEC-06)', () => {
    it('refreshes only credential, login, scopeCheck, and verifiedAt', async () => {
        {
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

            expect(Object.keys(after).toSorted(byText)).toEqual(Object.keys(before).toSorted(byText));
            const changed = Object.keys(after)
                .filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]))
                .toSorted(byText);
            expect(changed).toEqual(['credential', 'login', 'scopeCheck', 'verifiedAt']);
            expect(after.numericUserId).toBe(String(ACCOUNT_ID));

            // Audit history is append-only: every earlier row survives untouched.
            const auditAfter = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8');
            expect(auditAfter.startsWith(auditBefore)).toBe(true);
            expect(auditAfter).toContain('account.rotated');
        }
    });

    it('stores the rotated credential owner-only', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);

            await rotateToken({ service, token: `${REGISTERED_TOKEN}-rotated` });

            const file = join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
            const info = await stat(file);
            expect(info.mode % PERMISSION_BASE).toBe(0o600);
        }
    });

    it('refuses a token whose numeric id differs, leaving the store byte-identical', async () => {
        {
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
        }
    });

    it('answers 404 for an account that does not exist', async () => {
        {
            const service = await startService({ user: USER_OK });

            const response = await rotateToken({ service, token: REGISTERED_TOKEN, userId: String(OTHER_ACCOUNT_ID) });
            const error = (await response.json()) as { error?: { code?: string } };

            expect(response.status).toBe(404);
            expect(error.error?.code).toBe(UNKNOWN_ACCOUNT_CODE);
        }
    });

    it('restores an errored account to active after a successful rotation', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            const errored = { ...(await readStoredAccount(
                service.dataDir
            )), state: 'error', errorReason: 'auth-failed' };
            await writeFile(join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`), JSON.stringify(errored), 'utf8');

            const response = await rotateToken({ service, token: `${REGISTERED_TOKEN}-rotated` });

            expect(response.status).toBe(200);
            const after = await readStoredAccount(service.dataDir);
            expect(after.state).toBe('active');
            expect(after.errorReason).toBeNull();
        }
    });

});

describe('DELETE /v1/accounts/:id — operator-driven removal (§2.2, §4 rule 7)', () => {
    it('removes the account when no binding references it', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);

            const response = await service.call(ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, () => String(ACCOUNT_ID)), {
                method: 'DELETE',
            });
            const body = (await response.json()) as { removed?: boolean };
            const audit = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8');

            expect(response.status).toBe(200);
            expect(body.removed).toBe(true);
            await expect(stat(join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`))).rejects.toThrow();
            expect(audit).toContain(ACCOUNT_DELETED_EVENT);
        }
    });

    it('refuses while a binding references the account, unless force=1', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            const binding = { bindingId: 'bind-1', accountNumericUserId: String(ACCOUNT_ID), state: 'active' };
            await writeFile(join(service.dataDir, BINDINGS_FILE), JSON.stringify([binding]), 'utf8');
            const path = ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, () => String(ACCOUNT_ID));

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
            expect(audit).toContain(ACCOUNT_DELETED_EVENT);
        }
    });

    it('answers 404 for an unknown or non-numeric id', async () => {
        {
            const service = await startService({ user: USER_OK });

            for (const id of [String(OTHER_ACCOUNT_ID), 'not-a-number']) {
                const response = await service.call(ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, () => id), { method: 'DELETE' });
                const error = (await response.json()) as { error?: { code?: string } };
                expect(response.status).toBe(404);
                expect(error.error?.code).toBe(UNKNOWN_ACCOUNT_CODE);
            }
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
        {
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
        }
    });

    it('re-verifies a stranded account back to active when GitHub still knows it', async () => {
        {
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
        }
    });

});

/** The label member's field name, so a display-name refusal renders in place (005 §2). */
const LABEL_FIELD = 'displayName';

/** The prompt member's field name — identical at all three save paths (004 FR-083). */
const PROMPT_FIELD = 'startingPrompt';

/** A planted sentinel inside a credential-shaped value (AC-130). */
const SENTINEL = 'zzPLANTEDzz';

/** A planted sentinel no shape detector matches, planted as a custody key's value (invariant 6). */
const CUSTODY_SENTINEL = 'zzCUSTODYzz';

/** A reserved composition marker line, refused by the one prompt validator (004 FR-025). */
const RESERVED_MARKER_LINE = '--- BEGIN OPERATOR STARTING PROMPT ---';

/** The instruction this suite stores, changes, and scans every row for. */
const PROMPT = 'Reproduce first, then patch. Do not widen the public API.';

/** The same instruction with one character changed. */
const NEXT_PROMPT = 'Reproduce first, then patch. Do not widen the public API!';

/** The eleven custody and identity keys the profile body refuses by name (005 §2, invariant 6). */
const CUSTODY_KEYS: readonly string[] = [
    'credential',
    'scopeCheck',
    'state',
    'connectionState',
    'verifiedAt',
    'errorReason',
    'numericUserId',
    'login',
    'expectedLogin',
    'createdAt',
    'updatedAt',
];

/**
 * The two path suffixes the 4–5 gate retired: one shipped and was deleted,
 * one was never built (005 v1.10.0; 004 `## Clarifications` row 33).
 */
const RETIRED_SUFFIXES: readonly string[] = ['/display-name', '/starting-prompt'];


/** One field refusal, as the `422 validation` envelope carries it. */
interface Issue {
    /** The offending field, or `'body'` for a structural refusal. */
    readonly field: string;
    /** How to fix it; never quotes what was received. */
    readonly remediation: string;
}

/**
 * Build the credential-shaped prompt every save path must refuse identically.
 *
 * @returns A value the shipped detector labels as a token shape (AC-150).
 */
function credentialPrompt(): string {
    return `ghp_${SENTINEL}${'a'.repeat(36)}`;
}

/**
 * PUT one account profile body against a routed account path.
 *
 * @param options - Harness instance, the path id, and the request body.
 * @returns The response.
 */
function putProfileAt(options: {
    /** Harness instance to call. */
    readonly service: TestService;
    /** Path id the profile write runs against. */
    readonly userId: string;
    /** Request body exactly as the client would send it. */
    readonly body: string;
}): Promise<Response> {
    const { service, userId, body } = options;

    return service.call(ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, () => userId), {
        method: 'PUT',
        headers: jsonHeaders(),
        body,
    });
}

/**
 * PUT one profile body against the fixture account's path.
 *
 * @param service - Harness instance.
 * @param body - The request body exactly as the client would send it.
 * @returns The response.
 */
function putProfile(service: TestService, body: string): Promise<Response> {
    return putProfileAt({ service, userId: String(ACCOUNT_ID), body });
}

/**
 * PUT one profile body and report the response status alone.
 *
 * @param service - Harness instance.
 * @param body - The request body exactly as the client would send it.
 * @returns The HTTP status the service answered.
 */
async function putStatus(service: TestService, body: string): Promise<number> {
    const response = await putProfile(service, body);

    return response.status;
}

/**
 * Read every issue a `422 validation` answer carries (invariant 6's list).
 *
 * @param response - The refusal.
 * @returns Its structured issues; an envelope listing none answers `[]`.
 */
async function issuesOf(response: Response): Promise<readonly Issue[]> {
    const body = (await response.json()) as {
        readonly error: { readonly issues?: readonly Issue[] };
    };

    return body.error.issues ?? [];
}

/**
 * Read the first issue a `422 validation` answer carries.
 *
 * @param response - The refusal.
 * @returns Its `field` and remediation, or an empty pair when none is listed.
 */
async function issueOf(response: Response): Promise<Issue> {
    const issues = await issuesOf(response);

    return issues[0] ?? { field: '', remediation: '' };
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

/**
 * The keys whose value differs between two stored documents.
 *
 * @param before - The document as it stood.
 * @param after - The document after the write under test.
 * @returns Every key whose serialized value changed.
 */
function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): readonly string[] {
    return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

/**
 * Every `account.prompt-updated` row in the service's own trail (FR-088).
 *
 * @param service - Harness instance whose store holds the trail.
 * @returns The rows, oldest first.
 * @throws {Error} When the harness started without a store.
 */
async function accountPromptRows(service: TestService): Promise<readonly AuditEntry[]> {
    const { store } = service.handle;
    if (store === null) {
        throw new Error('the harness started without a store');
    }

    const entries = await readAuditEntries(store);

    return entries.filter((entry) => entry.eventType === ACCOUNT_PROMPT_UPDATED_EVENT);
}

/**
 * The `.ts` modules under `service/`, read as written (invariant 8).
 *
 * The route table and the accounts handlers are the surface the invariant is
 * about; the whole directory is read because a retired path could hide in any
 * other module's constant, builder, or comment.
 *
 * @returns Every service module's text.
 */
function serviceModuleTexts(): readonly string[] {
    const root = resolve(import.meta.dirname, '..', 'service');

    return readdirSync(root, { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith('.ts'))
        .map((entry) => readFileSync(resolve(root, entry), 'utf8'));
}

/**
 * The `.ts` modules under `tests/`, read as written (invariant 8).
 *
 * @returns Every test module's text.
 */
function testModuleTexts(): readonly string[] {
    const root = import.meta.dirname;

    return readdirSync(root, { recursive: true })
        .map(String)
        .filter((entry) => entry.endsWith('.ts'))
        .map((entry) => readFileSync(resolve(root, entry), 'utf8'));
}

describe('PUT /v1/accounts/:numericUserId — the account profile write (005 FR-066, 004 FR-082)', () => {
    it('stores a label, trims it, and changes nothing but the label and its stamp', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            const before = await storedAccount(service);

            const response = await putProfile(service, JSON.stringify({ displayName: '  Octo platform  ' }));
            const body = (await response.json()) as { readonly account: AccountDto };

            expect(response.status).toBe(200);
            expect('credential' in body.account).toBe(false);
            // A label-only body leaves the prompt tier exactly where it was.
            expect(body.account.startingPrompt).toBeNull();

            const after = await storedAccount(service);
            expect(Object.keys(after).toSorted(byText)).toEqual(Object.keys(before).toSorted(byText));
            const changed = changedKeys(before, after);
            expect(changed).toContain(LABEL_FIELD);
            expect(changed.filter((key) => key !== LABEL_FIELD && key !== 'updatedAt')).toEqual([]);
        }
    });

    it('refuses a body carrying neither member rather than no-oping (invariant 4)', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            const file = accountFileOf(service);
            const before = await readFile(file, 'utf8');
            const profilePath = ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, () => String(ACCOUNT_ID));

            // `{}`, an array, an explicit `null`, and no body at all carry
            // neither member; every one is a refusal, never a silent `200`.
            for (const empty of [JSON.stringify({}), JSON.stringify([]), '']) {
                const response = empty === ''
                    ? await service.call(profilePath, { method: 'PUT', headers: jsonHeaders() })
                    : await putProfile(service, empty);
                const issues = await issuesOf(response);

                expect(response.status, empty).toBe(422);
                expect(issues, empty).toHaveLength(1);
                expect(issues[0]?.field, empty).toBe('body');
                expect(issues[0]?.remediation, empty).toContain(LABEL_FIELD);
                expect(issues[0]?.remediation, empty).toContain(PROMPT_FIELD);
                // Nothing written: not a byte of the record, no `updatedAt`,
                // and no audit row for a refusal (004 FR-082).
                expect(await readFile(file, 'utf8'), empty).toBe(before);
            }

            expect(await accountPromptRows(service)).toHaveLength(0);
        }
    });

    it('refuses a credential-shaped value by field, never echoing what was sent', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            await putProfile(service, JSON.stringify({ displayName: 'the label in force' }));
            const file = accountFileOf(service);
            const before = await readFile(file, 'utf8');
            const submitted = `ghp_${SENTINEL}${'a'.repeat(24)}`;

            const response = await putProfile(service, JSON.stringify({ displayName: submitted }));
            const text = await response.text();
            const parsed = JSON.parse(text) as { readonly error: { readonly issues?: readonly Issue[] } };
            const issue = parsed.error.issues?.[0] ?? { field: '', remediation: '' };

            expect(response.status).toBe(422);
            expect(issue.field).toBe(LABEL_FIELD);
            expect(text).not.toContain(SENTINEL);
            // The previous label stays in force, byte for byte.
            expect(await readFile(file, 'utf8')).toBe(before);
        }
    });

    it('clears on null and on empty-after-trim, and refuses anything that is not text', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);

            expect(await putStatus(service, JSON.stringify({ displayName: 'kept' }))).toBe(200);
            expect(await putStatus(service, JSON.stringify({ displayName: ' '.repeat(3) }))).toBe(200);
            const afterBlank = await storedAccount(service);
            expect(afterBlank[LABEL_FIELD]).toBeNull();

            expect(await putStatus(service, JSON.stringify({ displayName: 'back again' }))).toBe(200);
            expect(await putStatus(service, JSON.stringify({ displayName: null }))).toBe(200);
            const afterNull = await storedAccount(service);
            expect(afterNull[LABEL_FIELD]).toBeNull();

            const refused = await putProfile(service, JSON.stringify({ displayName: 42 }));
            expect(refused.status).toBe(422);
            const issue = await issueOf(refused);
            expect(issue.field).toBe(LABEL_FIELD);
        }
    });

    it('caps the label at 80 code points and refuses control characters', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);

            expect(await putStatus(service, JSON.stringify({ displayName: 'x'.repeat(80) }))).toBe(200);

            const overCap = await putProfile(service, JSON.stringify({ displayName: 'x'.repeat(81) }));
            const capIssue = await issueOf(overCap);
            expect(overCap.status).toBe(422);
            expect(capIssue.field).toBe(LABEL_FIELD);
            expect(capIssue.remediation).toContain('80');

            // eslint-disable-next-line unicorn/prefer-unicode-code-point-escapes -- the BEL is the planted value under test.
            const controlled = await putProfile(service, JSON.stringify({ displayName: 'badname\u0007x' }));

            const controlIssue = await issueOf(controlled);
            expect(controlled.status).toBe(422);
            expect(controlIssue.field).toBe(LABEL_FIELD);
            expect(controlIssue.remediation).not.toContain('bad');
        }
    });

    it('reads as null for a store that predates the field, rewriting nothing', async () => {
        {
            const dataDir = await sharedDataDir();
            const service = await startService({ user: USER_OK }, dataDir);
            await verifyOk(service);
            const file = join(dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
            const legacy = await readStoredAccount(dataDir);
            const withoutLabel = Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== LABEL_FIELD));
            await writeFile(file, JSON.stringify(withoutLabel, null, 2), 'utf8');
            const bytes = await readFile(file, 'utf8');

            const response = await service.call(ACCOUNTS_PATH);
            const body = (await response.json()) as { readonly accounts: readonly AccountDto[] };

            expect(body.accounts[0]?.displayName).toBeNull();
            expect(await readFile(file, 'utf8')).toBe(bytes);
        }
    });


    it('AC-128 plus FR-082 — rotation and login rename touch neither member', async () => {
        {
            const github = fakeGitHub({ user: USER_OK });
            const service = await startWithVerifier(github.verifier);
            await verifyOk(service);
            const seeded = await putProfile(service, JSON.stringify({
                displayName: SEEDED_LABEL,
                startingPrompt: SEEDED_PROMPT,
            }));
            expect(seeded.status).toBe(200);
            const file = accountFileOf(service);
            const before = await readFile(file, 'utf8');
            github.setScript({ user: USER_RENAMED });

            const rotated = await rotateToken({ service, token: `${REGISTERED_TOKEN}-rotated` });
            expect(rotated.status).toBe(200);

            const after = await readFile(file, 'utf8');
            const beforeDoc = JSON.parse(before) as Record<string, unknown>;
            const afterDoc = JSON.parse(after) as Record<string, unknown>;
            expect(afterDoc[LABEL_FIELD]).toBe(beforeDoc[LABEL_FIELD]);
            expect(afterDoc[PROMPT_FIELD]).toBe(beforeDoc[PROMPT_FIELD]);

            const listed = await service.call(ACCOUNTS_PATH);
            const body = (await listed.json()) as { readonly accounts: readonly AccountDto[] };

            expect(body.accounts[0]?.login).toBe(ROTATED_LOGIN);
            expect(body.accounts[0]?.displayName).toBe(SEEDED_LABEL);
            expect(body.accounts[0]?.startingPrompt).toBe(SEEDED_PROMPT);
        }
    });

    it('answers a populated label with no credential-shaped text', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            const benign = 'Platform owned by the release rotation, contact ops';
            expect(await putStatus(service, JSON.stringify({ displayName: benign }))).toBe(200);

            const listed = await service.call(ACCOUNTS_PATH);
            const text = await listed.text();

            expect(text).toContain(benign);
            expect(text).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
            expect(text).not.toMatch(/\bgithub_pat_[A-Za-z0-9_]{20,}/);
        }
    });

    it('answers 404 for an id no account holds', async () => {
        {
            const service = await startService({ user: USER_OK });

            const body = JSON.stringify({ displayName: 'nobody' });
            const response = await putProfileAt({ service, userId: '123456789', body });
            const envelope = (await response.json()) as { error?: { code?: string } };

            expect(response.status).toBe(404);
            expect(envelope.error?.code).toBe(UNKNOWN_ACCOUNT_CODE);
        }
    });

});

describe('the account tier on the record — member, DTO, quarantine (004 FR-082, FR-083)', () => {
    it('reads absence and null as unset, rewriting nothing and observing nothing', async () => {
        const dataDir = await sharedDataDir();
        const service = await startService({ user: USER_OK }, dataDir);
        await verifyOk(service);
        const file = join(dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
        const stored = await readStoredAccount(dataDir);

        // Absence is the pre-004 shape; `null` is what this build writes for
        // "unset". Both are the complete unset state: read as `null`, never
        // quarantined, never repaired on read (FR-018, FR-071).
        const withoutMember = Object.fromEntries(
            Object.entries(stored).filter(([key]) => key !== PROMPT_FIELD),
        );
        await writeFile(file, JSON.stringify(withoutMember, null, 2), 'utf8');
        const absentBytes = await readFile(file, 'utf8');

        const absent = await service.call(ACCOUNTS_PATH);
        const absentBody = (await absent.json()) as { readonly accounts: readonly AccountDto[] };
        expect(absentBody.accounts[0]?.startingPrompt).toBeNull();
        expect(await readFile(file, 'utf8')).toBe(absentBytes);

        await writeFile(file, JSON.stringify({ ...withoutMember, [PROMPT_FIELD]: null }, null, 2), 'utf8');
        const nullBytes = await readFile(file, 'utf8');

        const nulled = await service.call(ACCOUNTS_PATH);
        const nulledBody = (await nulled.json()) as { readonly accounts: readonly AccountDto[] };
        expect(nulledBody.accounts[0]?.startingPrompt).toBeNull();
        expect(await readFile(file, 'utf8')).toBe(nullBytes);

        // The observed read appends nothing by itself: unset is a state, not
        // a change (FR-071, FR-088).
        expect(await accountPromptRows(service)).toHaveLength(0);
    });

    it('quarantines a violating stored prompt with a value-free reason', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const file = accountFileOf(service);
        const seeded = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;

        const violations: readonly {
            readonly label: string;
            readonly value: unknown;
            readonly reasonFragment: string;
            readonly leak: string | null;
        }[] = [
            { label: 'a number', value: 7, reasonFragment: TEXT_REQUIRED_FRAGMENT, leak: null },
            { label: 'a boolean', value: true, reasonFragment: TEXT_REQUIRED_FRAGMENT, leak: null },
            { label: 'an object', value: { nested: true }, reasonFragment: TEXT_REQUIRED_FRAGMENT, leak: 'nested' },
            {
                label: 'a 2,001-code-point value',
                value: 'q'.repeat(2_001),
                reasonFragment: 'at most 2000',
                leak: 'q'.repeat(64),
            },
            {
                label: 'a credential shape',
                value: credentialPrompt(),
                reasonFragment: 'credential-shaped material',
                leak: SENTINEL,
            },
            {
                label: 'a reserved marker line',
                value: RESERVED_MARKER_LINE,
                reasonFragment: 'reserved composition markers',
                leak: 'OPERATOR STARTING PROMPT',
            },
        ];

        for (const violation of violations) {
            await writeFile(file, JSON.stringify({ ...seeded, [PROMPT_FIELD]: violation.value }), 'utf8');

            const response = await service.call(ACCOUNTS_PATH);
            const body = (await response.json()) as { readonly accounts: readonly AccountDto[] };

            // The record refuses as a whole, so there is no account to scan
            // until the operator repairs the file (FR-082's edge case).
            expect(body.accounts, violation.label).toEqual([]);

            const lines = service.logLines.filter((entry) => entry.includes('stored record was unusable'));
            const line = lines.at(-1);
            expect(line, violation.label).toBeDefined();
            const logged = JSON.parse(line ?? '{}') as { readonly reason?: unknown };
            const reason = typeof logged.reason === 'string' ? logged.reason : '';
            expect(reason, violation.label).toContain(`${PROMPT_FIELD}:`);
            expect(reason, violation.label).toContain(violation.reasonFragment);
            if (violation.leak !== null) {
                expect(reason, violation.label).not.toContain(violation.leak);
                expect(service.logLines.join('\n'), violation.label).not.toContain(violation.leak);
            }

            // Quarantined, not silently repaired: the file is set aside whole.
            await expect(stat(file), violation.label).rejects.toThrow();
        }

        expect(await accountPromptRows(service)).toHaveLength(0);
    });

    it('rides through the F13 mark/restore, which spread the record (FR-082)', async () => {
        const dataDir = await sharedDataDir();
        const service = await startService({ user: USER_OK }, dataDir);
        await verifyOk(service);
        expect(await putStatus(service, JSON.stringify({
            displayName: SEEDED_LABEL,
            startingPrompt: SEEDED_PROMPT,
        }))).toBe(200);
        const file = join(dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
        const seeded = await readStoredAccount(dataDir);
        // Strand the record mid-handoff exactly as a crash would leave it.
        await writeFile(file, JSON.stringify({ ...seeded, state: 'verifying' }), 'utf8');
        await service.shutdown();

        const restarted = await startService({ user: USER_RENAMED }, dataDir);
        const summary = await restarted.handle.reconciled;
        const after = await readStoredAccount(dataDir);

        expect(summary).toMatchObject({ examined: 1, marked: 1, restored: 1 });
        // Both operator members ride through mark *and* restore untouched:
        // the spread constructions preserve the record by construction rather
        // than rebuilding it field by field (FR-082, part (a) of T-023).
        expect(after[LABEL_FIELD]).toBe(seeded[LABEL_FIELD]);
        expect(after[PROMPT_FIELD]).toBe(seeded[PROMPT_FIELD]);
        // The startup observation saw no difference, so it wrote no row.
        expect(await accountPromptRows(restarted)).toHaveLength(1);
    });
});

describe('PUT /v1/accounts/:numericUserId — invariant 5: exactly the supplied members', () => {
    it('a one-member body changes that member only; the other is byte-identical', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            expect(await putStatus(service, JSON.stringify({
                displayName: 'Octo — platform',
                startingPrompt: SEEDED_PROMPT,
            }))).toBe(200);

            const beforePrompt = await storedAccount(service);
            expect(await putStatus(service, JSON.stringify({
                startingPrompt: 'A different instruction entirely.',
            }))).toBe(200);
            const afterPrompt = await storedAccount(service);
            expect(Object.keys(afterPrompt).toSorted(byText)).toEqual(Object.keys(beforePrompt).toSorted(byText));
            expect(afterPrompt[LABEL_FIELD]).toBe(beforePrompt[LABEL_FIELD]);
            const promptChanged = changedKeys(beforePrompt, afterPrompt);
            expect(promptChanged).toContain(PROMPT_FIELD);
            expect(promptChanged.filter((key) => key !== PROMPT_FIELD && key !== 'updatedAt')).toEqual([]);

            const beforeLabel = afterPrompt;
            expect(await putStatus(service, JSON.stringify({ displayName: 'Release rotation' }))).toBe(200);
            const afterLabel = await storedAccount(service);
            expect(afterLabel[PROMPT_FIELD]).toBe(beforeLabel[PROMPT_FIELD]);
            const labelChanged = changedKeys(beforeLabel, afterLabel);
            expect(labelChanged).toContain(LABEL_FIELD);
            expect(labelChanged.filter((key) => key !== LABEL_FIELD && key !== 'updatedAt')).toEqual([]);
        }
    });

    it('a two-member body changes both, and null/"" clear only what they name', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);

            const seeded = await putProfile(service, JSON.stringify({
                displayName: 'First label',
                startingPrompt: 'First instruction.',
            }));
            expect(seeded.status).toBe(200);
            const before = await storedAccount(service);

            expect(await putStatus(service, JSON.stringify({
                displayName: SECOND_LABEL,
                startingPrompt: 'Second instruction.',
            }))).toBe(200);
            const afterBoth = await storedAccount(service);
            expect(Object.keys(afterBoth).toSorted(byText)).toEqual(Object.keys(before).toSorted(byText));
            const both = changedKeys(before, afterBoth);
            expect(both).toContain(LABEL_FIELD);
            expect(both).toContain(PROMPT_FIELD);
            expect(both.filter((key) => key !== LABEL_FIELD && key !== PROMPT_FIELD && key !== 'updatedAt'))
                .toEqual([]);

            // `null` clears the prompt and leaves the label byte-identical …
            expect(await putStatus(service, JSON.stringify({ startingPrompt: null }))).toBe(200);
            const promptCleared = await storedAccount(service);
            expect(promptCleared[PROMPT_FIELD]).toBeNull();
            expect(promptCleared[LABEL_FIELD]).toBe(SECOND_LABEL);

            // … whitespace-only clears it too, and `""` clears only the label.
            expect(await putStatus(service, JSON.stringify({ startingPrompt: 'Second instruction.' }))).toBe(200);
            expect(await putStatus(service, JSON.stringify({ startingPrompt: ' '.repeat(3) }))).toBe(200);
            const promptBlank = await storedAccount(service);
            expect(promptBlank[PROMPT_FIELD]).toBeNull();
            expect(promptBlank[LABEL_FIELD]).toBe(SECOND_LABEL);

            expect(await putStatus(service, JSON.stringify({ displayName: '' }))).toBe(200);
            const labelCleared = await storedAccount(service);
            expect(labelCleared[LABEL_FIELD]).toBeNull();
            expect(labelCleared[PROMPT_FIELD]).toBeNull();
        }
    });

});

describe('PUT /v1/accounts/:numericUserId — invariant 6: the eleven custody keys refused', () => {
    it('every custody and identity key answers 422 by name with no echo', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            expect(await putStatus(service, JSON.stringify({
                displayName: KEPT_LABEL,
                startingPrompt: 'Kept instruction.',
            }))).toBe(200);
            const file = accountFileOf(service);
            const before = await readFile(file, 'utf8');
            // The seed itself wrote its one `set` row; a refusal may not add
            // a second.
            const rowsBefore = await accountPromptRows(service);
            expect(rowsBefore).toHaveLength(1);

            for (const key of CUSTODY_KEYS) {
                const response = await putProfile(service, JSON.stringify({ [key]: CUSTODY_SENTINEL }));
                const text = await response.text();
                const parsed = JSON.parse(text) as { readonly error: { readonly issues?: readonly Issue[] } };

                expect(response.status, key).toBe(422);
                expect(parsed.error.issues?.some((issue) => issue.field === key), key).toBe(true);
                // The submitted value appears nowhere: not in the answer, and
                // the record is byte-identical, so there is no `updatedAt`
                // bump either (invariant 6).
                expect(text, key).not.toContain(CUSTODY_SENTINEL);
                expect(await readFile(file, 'utf8'), key).toBe(before);
            }

            expect(service.logLines.join('\n')).not.toContain(CUSTODY_SENTINEL);
            expect(await accountPromptRows(service)).toHaveLength(rowsBefore.length);
        }
    });

    it('one complete list of issues, and nothing at all is written', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            const file = accountFileOf(service);
            const before = await readFile(file, 'utf8');

            const response = await putProfile(service, JSON.stringify({
                displayName: 'x'.repeat(81),
                credential: CUSTODY_SENTINEL,
            }));
            const issues = await issuesOf(response);

            expect(response.status).toBe(422);
            expect(issues).toHaveLength(2);
            expect(new Set(issues.map((issue) => issue.field))).toEqual(new Set([LABEL_FIELD, 'credential']));
            expect(await readFile(file, 'utf8')).toBe(before);
            expect(await accountPromptRows(service)).toHaveLength(0);
        }
    });


    it('withholds a member name that is not an identifier, and bounds one that is', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const file = accountFileOf(service);
        const before = await readFile(file, 'utf8');

        // A member name is submitted input too: a name that is not an ordinary
        // identifier is refused under `body`, with no part of itself reflected
        // back into the envelope that restates every `field: remediation`
        // pair — and the value it carried never appears either.
        const oddKey = 'strange key name here';
        const oddResponse = await putProfile(
            service,
            JSON.stringify({ displayName: KEPT_LABEL, [oddKey]: CUSTODY_SENTINEL }),
        );
        const oddText = await oddResponse.text();
        const oddBody = JSON.parse(oddText) as { readonly error: { readonly issues?: readonly Issue[] } };

        expect(oddResponse.status).toBe(422);
        expect(oddBody.error.issues?.map((issue) => issue.field)).toEqual(['body']);
        expect(oddText).not.toContain(oddKey);
        expect(oddText).not.toContain(CUSTODY_SENTINEL);

        // An identifier-shaped name is still named — reached through the same
        // bound the configuration document uses, so a 200-character key lands
        // in the answer as 64 characters plus an ellipsis, never whole.
        const longKey = 'x'.repeat(200);
        const longResponse = await putProfile(
            service,
            JSON.stringify({ displayName: KEPT_LABEL, [longKey]: CUSTODY_SENTINEL }),
        );
        const longText = await longResponse.text();
        const longBody = JSON.parse(longText) as { readonly error: { readonly issues?: readonly Issue[] } };

        expect(longResponse.status).toBe(422);
        expect(longBody.error.issues?.[0]?.field).toBe(`${'x'.repeat(64)}…`);
        expect(longText).not.toContain(longKey);
        expect(longText).not.toContain(CUSTODY_SENTINEL);
        // Neither refusal wrote anything: the record is byte-identical.
        expect(await readFile(file, 'utf8')).toBe(before);
    });

    it('refuses one tier with the shared shape label and touches neither member (AC-150)', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        expect(await putStatus(service, JSON.stringify({
            displayName: KEPT_LABEL,
            startingPrompt: 'Kept instruction.',
        }))).toBe(200);
        const file = accountFileOf(service);
        const before = await readFile(file, 'utf8');
        const rowsBefore = await accountPromptRows(service);
        expect(rowsBefore).toHaveLength(1);
        const submitted = credentialPrompt();
        const shape = findSecretLeak(submitted);
        if (shape === null) {
            throw new Error('the AC-150 sentinel must be credential-shaped');
        }

        const response = await putProfile(service, JSON.stringify({ [PROMPT_FIELD]: submitted }));
        const text = await response.text();
        const parsed = JSON.parse(text) as { readonly error: { readonly issues?: readonly Issue[] } };
        const issue = parsed.error.issues?.[0] ?? { field: '', remediation: '' };

        expect(response.status).toBe(422);
        expect(issue.field).toBe(PROMPT_FIELD);
        // Identical shape label to the bindings and configuration paths: the
        // shared remediation builder is the one rule set (FR-083, AC-150).
        expect(issue.remediation).toBe(credentialRemediation(shape));
        expect(text).not.toContain(SENTINEL);
        expect(service.logLines.join('\n')).not.toContain(SENTINEL);
        // Both stored members and the stamp stay byte-identical: no partial
        // application, no `updatedAt` bump, no second audit row
        // (layered-prompt §5 invariant 3).
        expect(await readFile(file, 'utf8')).toBe(before);
        expect(await accountPromptRows(service)).toHaveLength(rowsBefore.length);
    });
});

describe('the retired routes resolve nowhere (005 v1.10.0, account-display-name §4 invariant 8)', () => {
    it('answers the unknown-route refusal for both and keeps no reference', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        const profilePath = ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, () => String(ACCOUNT_ID));

        // No alias, no redirect, no legacy handler: each retired suffix reaches
        // a path no route entry matches, so the pipeline answers its own
        // `404 not-found` — not a `405`, which would mean a route existed.
        for (const suffix of RETIRED_SUFFIXES) {
            const response = await service.call(`${profilePath}${suffix}`, {
                method: 'PUT',
                headers: jsonHeaders(),
                body: JSON.stringify({ displayName: 'nobody' }),
            });
            const envelope = (await response.json()) as { error?: { code?: string } };

            expect(response.status, suffix).toBe(404);
            expect(envelope.error?.code, suffix).toBe('not-found');
        }

        // The route table declares neither suffix under any method.
        const paths = ROUTES.map((route) => route.path);
        expect(paths.some((path) => path.endsWith('/display-name'))).toBe(false);
        expect(paths.some((path) => path.endsWith('/starting-prompt'))).toBe(false);

        // No service module — route table, handlers, or any other — names
        // either retired path. This file names each suffix exactly once, in
        // the probes above: a probe must name what it probes.
        for (const text of serviceModuleTexts()) {
            for (const suffix of RETIRED_SUFFIXES) {
                expect(text.includes(suffix), suffix).toBe(false);
            }
        }

        // The retired constant is no longer exported at all, so the type
        // checker fails on any module that references it — and no test module
        // does. (The panel's own path builder still names the label suffix
        // until T-031 re-points it in Wave 3; that is a `src/` concern, not a
        // route, handler, or service test of this build.)
        const retiredReference = /import[^;]*ACCOUNT_DISPLAY_NAME_PATH/;
        const retiredReferences = testModuleTexts().filter((text) => retiredReference.test(text));
        expect(retiredReferences).toEqual([]);
    });
});

describe('account.prompt-updated — one row per tier change, never the text (004 FR-088)', () => {
    it('records set → change → clear as three chained rows with no text', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);

        expect(await putStatus(service, JSON.stringify({ startingPrompt: PROMPT }))).toBe(200);
        expect(await putStatus(service, JSON.stringify({ startingPrompt: NEXT_PROMPT }))).toBe(200);
        expect(await putStatus(service, JSON.stringify({ startingPrompt: null }))).toBe(200);

        const rows = await accountPromptRows(service);
        expect(rows).toHaveLength(3);
        expect(rows.map((row) => row.decision)).toEqual(['set', 'changed', 'cleared']);
        expect(rows.map((row) => row.actorSource)).toEqual(['operator', 'operator', 'operator']);
        expect(rows.map((row) => row.entity)).toEqual([
            { kind: 'account', id: String(ACCOUNT_ID) },
            { kind: 'account', id: String(ACCOUNT_ID) },
            { kind: 'account', id: String(ACCOUNT_ID) },
        ]);
        expect(rows.map((row) => row.details.previousFingerprint)).toEqual([
            null,
            promptFingerprint(PROMPT),
            promptFingerprint(NEXT_PROMPT),
        ]);
        expect(rows.map((row) => row.details.promptFingerprint)).toEqual([
            promptFingerprint(PROMPT),
            promptFingerprint(NEXT_PROMPT),
            null,
        ]);
        expect(rows.map((row) => row.details.promptPresent)).toEqual([true, true, false]);
        expect(rows.map((row) => row.details.promptLength)).toEqual([
            [...PROMPT].length,
            [...NEXT_PROMPT].length,
            0,
        ]);

        for (const row of rows) {
            // Exactly the four scalars the contract fixes, nothing else.
            expect(Object.keys(row.details).toSorted(byText)).toEqual([
                'previousFingerprint',
                'promptFingerprint',
                'promptLength',
                'promptPresent',
            ]);
            expect(row.reason).toBeNull();
            expect(row.correlationId).not.toMatch(/^mt-run-/);
        }

        const serialized = JSON.stringify(rows);
        expect(serialized).not.toContain(PROMPT);
        expect(serialized).not.toContain(NEXT_PROMPT);
        expect(serialized).not.toContain(PROMPT_HEAD);
    });

    it('a displayName-only write appends no row — a label is not a tier', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            expect(await putStatus(service, JSON.stringify({ startingPrompt: PROMPT }))).toBe(200);
            expect(await accountPromptRows(service)).toHaveLength(1);

            expect(await putStatus(service, JSON.stringify({ displayName: 'Release rotation' }))).toBe(200);
            expect(await accountPromptRows(service)).toHaveLength(1);

            expect(await putStatus(service, JSON.stringify({ displayName: null }))).toBe(200);
            expect(await accountPromptRows(service)).toHaveLength(1);
        }
    });

    it('a refused write leaves both stored members byte-identical and writes no row', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            expect(await putStatus(service, JSON.stringify({
                displayName: KEPT_LABEL,
                startingPrompt: PROMPT,
            }))).toBe(200);
            const file = accountFileOf(service);
            const before = await readFile(file, 'utf8');
            const rowsBefore = await accountPromptRows(service);

            const refused = await putProfile(service, JSON.stringify({ startingPrompt: 'q'.repeat(2_001) }));
            expect(refused.status).toBe(422);
            const issue = await issueOf(refused);
            expect(issue.field).toBe(PROMPT_FIELD);

            expect(await readFile(file, 'utf8')).toBe(before);
            expect(await accountPromptRows(service)).toHaveLength(rowsBefore.length);
        }
    });


    it('a hand-edited account file is observed once with actor `service`', async () => {
        {
            const service = await startService({ user: USER_OK });
            await verifyOk(service);
            const file = accountFileOf(service);
            const stored = await readStoredAccount(service.dataDir);
            await writeFile(file, JSON.stringify({ ...stored, [PROMPT_FIELD]: PROMPT }), 'utf8');

            const first = await service.call(ACCOUNTS_PATH);
            expect(first.status).toBe(200);

            let rows = await accountPromptRows(service);
            expect(rows).toHaveLength(1);
            expect(rows[0]?.actorSource).toBe('service');
            expect(rows[0]?.decision).toBe('set');
            expect(rows[0]?.details.promptFingerprint).toBe(promptFingerprint(PROMPT));
            expect(JSON.stringify(rows)).not.toContain(PROMPT_HEAD);

            // Re-observing the same file appends nothing: the baseline moved.
            const second = await service.call(ACCOUNTS_PATH);
            expect(second.status).toBe(200);
            rows = await accountPromptRows(service);
            expect(rows).toHaveLength(1);
            expect(service.logLines.join('\n')).not.toContain(PROMPT_HEAD);
        }
    });

    it('a restart over unchanged files writes zero rows', async () => {
        {
            const dataDir = await sharedDataDir();
            const first = await startService({ user: USER_OK }, dataDir);
            await verifyOk(first);
            expect(await putStatus(first, JSON.stringify({ startingPrompt: PROMPT }))).toBe(200);
            expect(await accountPromptRows(first)).toHaveLength(1);
            await first.shutdown();

            const second = await startService({ user: USER_OK }, dataDir);
            await second.handle.reconciled;
            // Startup reconciliation already listed the custody, and this read
            // lists it again: the trail seeds the baseline, so neither sees a
            // difference the store does not carry.
            const listed = await second.call(ACCOUNTS_PATH);
            expect(listed.status).toBe(200);
            expect(await accountPromptRows(second)).toHaveLength(1);
            expect(await readFile(join(dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`), 'utf8')).toContain(PROMPT);
        }
    });


    it('removes record and tier together and re-adds the account unset (AC-149)', async () => {
        const service = await startService({ user: USER_OK });
        await verifyOk(service);
        expect(await putStatus(service, JSON.stringify({ startingPrompt: PROMPT }))).toBe(200);
        expect(await accountPromptRows(service)).toHaveLength(1);

        const binding = { bindingId: 'bind-1', accountNumericUserId: String(ACCOUNT_ID), state: 'active' };
        await writeFile(join(service.dataDir, BINDINGS_FILE), JSON.stringify([binding]), 'utf8');
        const path = ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, () => String(ACCOUNT_ID));

        const forced = await service.call(`${path}?force=1`, { method: 'DELETE' });
        expect(forced.status).toBe(200);
        // The record is the tier's only home: it is gone with the record.
        await expect(stat(accountFileOf(service))).rejects.toThrow();

        const storedBindings = JSON.parse(
            await readFile(join(service.dataDir, BINDINGS_FILE), 'utf8')
        ) as { state: string }[];
        expect(storedBindings).toEqual([{ ...binding, state: 'disabled' }]);
        const audit = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8');
        expect(audit).toContain(ACCOUNT_DELETED_EVENT);
        expect(await accountPromptRows(service)).toHaveLength(1);

        // A re-added account — the same numeric id — reads unset: no seeding,
        // and the deletion wrote no `cleared` row of its own (FR-071, FR-082).
        const readded = await registerAccount(service);
        expect(readded.status).toBe(201);
        const listed = await service.call(ACCOUNTS_PATH);
        const body = (await listed.json()) as { readonly accounts: readonly AccountDto[] };

        expect(body.accounts).toHaveLength(1);
        expect(body.accounts[0]?.numericUserId).toBe(String(ACCOUNT_ID));
        expect(body.accounts[0]?.startingPrompt).toBeNull();
        expect(await accountPromptRows(service)).toHaveLength(1);
    });
});
