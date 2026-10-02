/**
 * Credential handoff tests (task T-007, contract §2.2 and §3 invariants 8–10):
 * happy path and GitHub classification.
 *
 * The shared harness in `tests/support/verify.ts` starts the real service
 * with the real GitHub *client* over a fake `fetch` (T-007's "fake fetch");
 * the throttles, identity rules, and secret scans live in
 * `tests/service-verify-limits.test.ts`. The consent gate this file used to
 * pin was removed by product-owner order on 2026-10-01 (002 v1.9.0): the
 * route now refuses on body shape alone, before any network call.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNTS_DIR } from '../service/accounts/store.ts';
import {
    ACCOUNT_ID,
    ACCOUNT_LOGIN,
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
    it('verifies, persists, and answers with the identity co… (+5 cases)', async () => {
        // case: verifies, persists, and answers with the identity contract §2.2 pins
        {
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
        }
        // case: stores the credential file owner-only and key it by numeric id
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            await postVerify(service, verifyBody(REGISTERED_TOKEN));

            const file = join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`);
            const fileStat = await stat(file);
            expect(fileStat.mode % PERMISSION_BASE).toBe(0o600);
            const dirStat = await stat(join(service.dataDir, ACCOUNTS_DIR));
            expect(dirStat.mode % PERMISSION_BASE).toBe(0o700);
        }
        // case: records exactly one account.verified row per accepted handoff
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            await postVerify(service, verifyBody(REGISTERED_TOKEN));

            const rows = await auditRows(service);
            expect(rows.map((row) => row.eventType)).toEqual(['account.verified']);
            expect(rows[0]?.details.login).toBe(ACCOUNT_LOGIN);
        }
        // case: keeps sequence numbers unique when two verifies race (W2-2)
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            const [first, second] = await Promise.all([
                postVerify(service, verifyBody(REGISTERED_TOKEN)),
                postVerify(service, verifyBody(`${REGISTERED_TOKEN}-racing`)),
            ]);

            const rows = await auditRows(service);
            const seqs = rows.map((row) => row.seq);
            expect(new Set(seqs).size).toBe(seqs.length);

            // One request wins the single verify slot, the other is refused —
            // whichever order they arrive in, only one account is ever created.
            expect([first.status, second.status].filter((status) => status === 201)).toHaveLength(1);
        }
        // case: applies expectedLogin case-insensitively when it matches
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN, { expectedLogin: 'OCTOCAT-MT' }));

            expect(response.status).toBe(201);
        }
        // case: stores expectedLogin as null when the add form carried no constraint (005 AC-141)
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const stored = JSON.parse(
                await readFile(join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`), 'utf8'),
            ) as Record<string, unknown>;

            expect(response.status).toBe(201);
            // The panel omits the member entirely when the field is left empty,
            // so "no constraint" and "the member was never sent" are one state.
            expect(stored.expectedLogin).toBeNull();
        }
    });
});

describe('POST /v1/accounts/verify — no consent gate (002 v1.9.0, owner order 2026-10-01)', () => {
    it('verifies a body carrying no consentVersion at all (+1 cases)', async () => {
        // case: verifies a body carrying no consentVersion at all
        {
            const { service, github } = await startWithGitHub({ user: USER_OK });

            const response = await postVerify(service, JSON.stringify({ token: REGISTERED_TOKEN }));

            expect(response.status).toBe(201);
            expect(github.calls.map((call) => call.path)).toEqual(['/user', '/rate_limit']);
        }
        // case: ignores the stale consentVersion an older panel build still sends
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            const response = await postVerify(
                service,
                JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: 1 }),
            );

            expect(response.status).toBe(201);
            // Nothing about the removed gate is recorded: the trail carries the
            // connection and nothing else.
            const rows = await auditRows(service);
            expect(rows.map((row) => row.eventType)).toEqual(['account.verified']);
        }
    });
});

describe('POST /v1/accounts/verify — GitHub classification (T-007 matrix)', () => {
    it('maps a GitHub 401 to 422 credential-rejected / auth-… (+5 cases)', async () => {
        // case: maps a GitHub 401 to 422 credential-rejected / auth-failed
        {
            const { service } = await startWithGitHub({ user: { status: 401 } });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const error = await errorOf(response);

            expect(response.status).toBe(422);
            expect(error.code).toBe('credential-rejected');
            expect(error.reasonClass).toBe('auth-failed');
            expect(await accountFileExists(service)).toBe(false);
        }
        // case: maps a GitHub 403 SSO refusal to sso-required
        {
            const { service } = await startWithGitHub({
                user: { status: 403, headers: headerMap([['x-github-sso', 'required; url=https://example.test/sso']]) },
            });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const error = await errorOf(response);

            expect(response.status).toBe(422);
            expect(error.reasonClass).toBe('sso-required');
        }
        // case: maps a GitHub 403 without scopes to the first missing capability
        {
            const { service } = await startWithGitHub({
                user: { status: 403, headers: headerMap([[OAUTH_SCOPES_HEADER, READ_ONLY_SCOPES]]) },
            });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const error = await errorOf(response);

            expect(response.status).toBe(422);
            expect(error.reasonClass).toBe('scope-missing:metadata');
        }
        // case: records missing scopes when GitHub 200s with a read-only classic token
        {
            const { service } = await startWithGitHub({
                user: { ...USER_NO_SCOPES, headers: headerMap([[OAUTH_SCOPES_HEADER, READ_ONLY_SCOPES]]) },
            });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const body = (await response.json()) as { scopeCheck: { results: Record<string, string> } };

            expect(response.status).toBe(201);
            expect(body.scopeCheck.results).toEqual(scopeResults('missing'));
        }
        // case: reports unknown scopes for a fine-grained token with no scope header
        {
            const { service } = await startWithGitHub({ user: USER_NO_SCOPES });

            const response = await postVerify(service, verifyBody(`github_pat_${'a'.repeat(40)}`));
            const body = (await response.json()) as { scopeCheck: { results: Record<string, string> } };

            expect(response.status).toBe(201);
            expect(body.scopeCheck.results).toEqual(scopeResults('unknown'));
        }
        // case: maps a GitHub 429 to 429 rate-limited with retry-after and persists nothing
        {
            const { service } = await startWithGitHub({
                user: { status: 429, headers: headerMap([[RETRY_AFTER, '120']]) },
            });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const error = await errorOf(response);

            expect(response.status).toBe(429);
            expect(response.headers.get(RETRY_AFTER)).toBe('120');
            expect(error.code).toBe('rate-limited');
            expect(await accountFileExists(service)).toBe(false);
        }
    });

    it('maps a transport failure to 502 upstream-unavailable… (+1 cases)', async () => {
        // case: maps a transport failure to 502 upstream-unavailable (F9 network)
        {
            const { service } = await startWithGitHub({ user: { failWith: 'ECONNREFUSED' } });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const error = await errorOf(response);

            expect(response.status).toBe(502);
            expect(error.code).toBe('upstream-unavailable');
            expect(error.message).not.toContain('ECONNREFUSED');
            expect(await accountFileExists(service)).toBe(false);
        }
        // case: classifies the 15-second abort as a timeout, not a network failure (W2-7)
        {
            const { service } = await startWithGitHub({ user: { failWithName: TIMEOUT_ERROR_NAME } });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            const error = await errorOf(response);

            expect(response.status).toBe(502);
            expect(error.code).toBe('upstream-unavailable');
            expect(error.message).not.toContain('check the network');
            expect(error.message).not.toContain(TIMEOUT_ERROR_NAME);
            expect(await accountFileExists(service)).toBe(false);
        }
    });
});

