/**
 * Credential handoff tests (task T-007, contract §2.2 and §3 invariants 8–10):
 * happy path, the consent gate, and GitHub classification.
 *
 * The shared harness in `tests/support/verify.ts` starts the real service
 * with the real GitHub *client* over a fake `fetch` (T-007's "fake fetch");
 * the throttles, identity rules, and secret scans live in
 * `tests/service-verify-limits.test.ts`.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../extension/src/consent.ts';
import { ACCOUNTS_DIR } from '../extension/service/accounts/store.ts';
import {
    ACCOUNT_ID,
    ACCOUNT_LOGIN,
    CONSENT_REQUIRED,
    OAUTH_SCOPES_HEADER,
    PERMISSION_BASE,
    RETRY_AFTER,
    READ_ONLY_SCOPES,
    REGISTERED_TOKEN,
    TIMEOUT_ERROR_NAME,
    accountFileExists,
    USER_NO_SCOPES,
    USER_OK,
    auditRows,
    errorOf,
    headerMap,
    postVerify,
    scopeResults,
    startWithGitHub,
    stopAllServices,
    verifyBody,
} from './support/verify.ts';

afterEach(stopAllServices);

describe('POST /v1/accounts/verify — happy path', () => {
    it('verifies, persists, and answers with the identity contract §2.2 pins', async () => {
        const { service, github } = await startWithGitHub({ user: USER_OK });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const body = (await response.json()) as Record<string, unknown>;

        expect(response.status).toBe(201);
        expect(body).toMatchObject({
            numericUserId: String(ACCOUNT_ID),
            login: ACCOUNT_LOGIN,
            state: 'active',
        });
        expect(typeof body.verifiedAt).toBe('string');
        expect(body.scopeCheck).toMatchObject({ results: scopeResults('ok') });
        expect(github.calls.map((call) => call.path)).toEqual(['/user', '/rate_limit']);
        const first = github.calls[0];
        expect(first?.authorization).toBe(`Bearer ${REGISTERED_TOKEN}`);
    });

    it('stores the credential file owner-only and key it by numeric id', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });

        await postVerify(service, verifyBody(REGISTERED_TOKEN));

        const file = join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
        const fileStat = await stat(file);
        expect(fileStat.mode % PERMISSION_BASE).toBe(0o600);
        const dirStat = await stat(join(service.dataDir, ACCOUNTS_DIR));
        expect(dirStat.mode % PERMISSION_BASE).toBe(0o700);
    });

    it('records exactly one consent occurrence and one account.verified row', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });

        await postVerify(service, verifyBody(REGISTERED_TOKEN));

        const rows = await auditRows(service);
        expect(rows.map((row) => row.eventType)).toEqual(['consent', 'account.verified']);
        const consent = rows[0];
        expect(consent?.details.version).toBe(CONSENT_VERSION);
        expect(typeof consent?.details.givenAt).toBe('string');
    });

    it('records the consent occurrence exactly once across replays', async () => {
        const { service } = await startWithGitHub({ user: { status: 401 } });

        await postVerify(service, verifyBody(REGISTERED_TOKEN));
        await postVerify(service, verifyBody('different-but-invalid'));
        await postVerify(service, verifyBody(REGISTERED_TOKEN));

        const rows = await auditRows(service);
        expect(rows.filter((row) => row.eventType === 'consent')).toHaveLength(1);
    });

    it('records exactly one consent row and unique sequence numbers when two verifies race (W2-2)', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });

        const [first, second] = await Promise.all([
            postVerify(service, verifyBody(REGISTERED_TOKEN)),
            postVerify(service, verifyBody(`${REGISTERED_TOKEN}-racing`)),
        ]);

        const rows = await auditRows(service);
        const consent = rows.filter((row) => row.eventType === 'consent');
        expect(consent).toHaveLength(1);
        expect(consent[0]?.details.version).toBe(CONSENT_VERSION);

        const seqs = rows.map((row) => row.seq);
        expect(new Set(seqs).size).toBe(seqs.length);

        // One request wins the single verify slot, the other is refused —
        // whichever order they arrive in, only one account is ever created.
        expect([first.status, second.status].filter((status) => status === 201)).toHaveLength(1);
    });

    it('applies expectedLogin case-insensitively when it matches', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN, { expectedLogin: 'OCTOCAT-MT' }));

        expect(response.status).toBe(201);
    });
});

describe('POST /v1/accounts/verify — consent gate (§1.2, invariant 8)', () => {
    it('refuses a request without consentVersion before any GitHub call', async () => {
        const { service, github } = await startWithGitHub({ user: USER_OK });

        const response = await postVerify(service, JSON.stringify({ token: REGISTERED_TOKEN }));
        const error = await errorOf(response);

        expect(response.status).toBe(422);
        expect(error.code).toBe(CONSENT_REQUIRED);
        expect(github.calls).toHaveLength(0);
        expect(await auditRows(service)).toHaveLength(0);
    });

    it('refuses a consent version below the current copy', async () => {
        const { service, github } = await startWithGitHub({ user: USER_OK });

        const response = await postVerify(
            service,
            JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: CONSENT_VERSION - 1 }),
        );
        const error = await errorOf(response);

        expect(response.status).toBe(422);
        expect(error.code).toBe(CONSENT_REQUIRED);
        expect(github.calls).toHaveLength(0);
    });

    it('never answers 2xx without a current consentVersion', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });
        const bodies = [
            JSON.stringify({ token: REGISTERED_TOKEN }),
            JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: 'one' }),
            JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: 0.5 }),
            JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: -1 }),
        ];

        for (const body of bodies) {
            const response = await postVerify(service, body);
            const error = await errorOf(response);
            expect(response.status).toBe(422);
            expect(error.code).toBe(CONSENT_REQUIRED);
        }
    });
});

describe('POST /v1/accounts/verify — GitHub classification (T-007 matrix)', () => {
    it('maps a GitHub 401 to 422 credential-rejected / auth-failed', async () => {
        const { service } = await startWithGitHub({ user: { status: 401 } });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const error = await errorOf(response);

        expect(response.status).toBe(422);
        expect(error.code).toBe('credential-rejected');
        expect(error.reasonClass).toBe('auth-failed');
        expect(await accountFileExists(service)).toBe(false);
    });

    it('maps a GitHub 403 SSO refusal to sso-required', async () => {
        const { service } = await startWithGitHub({
            user: { status: 403, headers: headerMap([['x-github-sso', 'required; url=https://example.test/sso']]) },
        });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const error = await errorOf(response);

        expect(response.status).toBe(422);
        expect(error.reasonClass).toBe('sso-required');
    });

    it('maps a GitHub 403 without scopes to the first missing capability', async () => {
        const { service } = await startWithGitHub({
            user: { status: 403, headers: headerMap([[OAUTH_SCOPES_HEADER, READ_ONLY_SCOPES]]) },
        });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const error = await errorOf(response);

        expect(response.status).toBe(422);
        expect(error.reasonClass).toBe('scope-missing:metadata');
    });

    it('records missing scopes when GitHub 200s with a read-only classic token', async () => {
        const { service } = await startWithGitHub({
            user: { ...USER_NO_SCOPES, headers: headerMap([[OAUTH_SCOPES_HEADER, READ_ONLY_SCOPES]]) },
        });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const body = (await response.json()) as { scopeCheck: { results: Record<string, string> } };

        expect(response.status).toBe(201);
        expect(body.scopeCheck.results).toEqual(scopeResults('missing'));
    });

    it('reports unknown scopes for a fine-grained token with no scope header', async () => {
        const { service } = await startWithGitHub({ user: USER_NO_SCOPES });

        const response = await postVerify(service, verifyBody(`github_pat_${'a'.repeat(40)}`));
        const body = (await response.json()) as { scopeCheck: { results: Record<string, string> } };

        expect(response.status).toBe(201);
        expect(body.scopeCheck.results).toEqual(scopeResults('unknown'));
    });

    it('maps a GitHub 429 to 429 rate-limited with retry-after and persists nothing', async () => {
        const { service } = await startWithGitHub({
            user: { status: 429, headers: headerMap([[RETRY_AFTER, '120']]) },
        });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const error = await errorOf(response);

        expect(response.status).toBe(429);
        expect(response.headers.get(RETRY_AFTER)).toBe('120');
        expect(error.code).toBe('rate-limited');
        expect(await accountFileExists(service)).toBe(false);
    });

    it('maps a transport failure to 502 upstream-unavailable (F9 network)', async () => {
        const { service } = await startWithGitHub({ user: { failWith: 'ECONNREFUSED' } });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const error = await errorOf(response);

        expect(response.status).toBe(502);
        expect(error.code).toBe('upstream-unavailable');
        expect(error.message).toContain('could not be reached');
        expect(error.message).not.toContain('ECONNREFUSED');
        expect(await accountFileExists(service)).toBe(false);
    });

    it('classifies the 15-second abort as a timeout, not a network failure (W2-7)', async () => {
        const { service } = await startWithGitHub({ user: { failWithName: TIMEOUT_ERROR_NAME } });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const error = await errorOf(response);

        expect(response.status).toBe(502);
        expect(error.code).toBe('upstream-unavailable');
        expect(error.message).toContain('did not answer in time');
        expect(error.message).not.toContain('check the network');
        expect(error.message).not.toContain(TIMEOUT_ERROR_NAME);
        expect(await accountFileExists(service)).toBe(false);
    });
});

