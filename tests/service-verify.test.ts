/**
 * Credential handoff tests (task T-007, contract §2.2 and §3 invariants 8–10).
 *
 * Every case runs the real loopback service with the real GitHub *client*
 * over a fake `fetch` (T-007's "fake fetch"), so status classification, the
 * FR-010 scope matrix, the consent gate, and the throttles are all exercised
 * as production runs them. Secret assertions are **registered-token scans**:
 * the credential a test handed the service is a string with no recognisable
 * prefix, so a passing scan proves structural absence rather than a lucky
 * redaction pattern.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../extension/src/consent.ts';
import { ACCOUNTS_DIR } from '../extension/service/accounts/store.ts';
import { VERIFY_PATH } from '../extension/service/routes/verify.ts';
import type { ScopeCapability, ScopeResult, VerifyOutcome } from '../extension/service/github.ts';
import { fakeGitHub, scriptedVerifier, userBody } from './support/github.ts';
import { startTestService } from './support/service.ts';
import type { EndpointResponse, FakeGitHub, GitHubScript } from './support/github.ts';
import type { TestService } from './support/service.ts';

/**
 * Build a header map without writing HTTP header names as object keys.
 *
 * @param pairs - Header name/value pairs.
 * @returns The headers as `fetch` accepts them.
 */
function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}

/** The `content-type` header every JSON POST carries. */
const JSON_HEADERS: Record<string, string> = headerMap([['content-type', 'application/json']]);

/** The four FR-010 capabilities, in matrix order. */
const CAPABILITIES: readonly ScopeCapability[] = ['metadata', 'issues', 'pull-requests', 'contents'];

/** Consent refusal code asserted by the gate tests (contract §4). */
const CONSENT_REQUIRED = 'consent-required';

/** Throttle wait header asserted by the GitHub-429 tests (contract §4). */
const RETRY_AFTER = 'retry-after';

/** Response header GitHub lists a classic token's granted scopes in (FR-010). */
const OAUTH_SCOPES_HEADER = 'x-oauth-scopes';

/** Scope header value granting every FR-010 capability on a classic token. */
const REPO_SCOPES = 'repo, user';

/** Scope header value granting none of the FR-010 capabilities. */
const READ_ONLY_SCOPES = 'user, read:user';

/** Credential registered with this suite's scans; deliberately un-prefixed. */
const REGISTERED_TOKEN = `registered-credential-${'x'.repeat(32)}`;

/** Every credential this suite hands a service, for registered-token scans. */
const REGISTERED_TOKENS: readonly string[] = [REGISTERED_TOKEN];

/** Numeric id the fixture token belongs to. */
const ACCOUNT_ID = 77_331;

/** Login the fixture token belongs to. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Body cap the service enforces, so oversized tokens are refused pre-network. */
const OVERSIZED_TOKEN = 'y'.repeat(4_097);

/** Identity answer used by every happy path in this file (a classic `repo` token). */
const USER_OK: EndpointResponse = {
    body: userBody({ id: ACCOUNT_ID, login: ACCOUNT_LOGIN }),
    headers: headerMap([[OAUTH_SCOPES_HEADER, REPO_SCOPES]]),
};

/** The same identity with **no** scope header, as fine-grained tokens report. */
const USER_NO_SCOPES: EndpointResponse = { body: userBody({ id: ACCOUNT_ID, login: ACCOUNT_LOGIN }) };

/** Name of the append-only audit trail inside the data directory. */
const AUDIT_FILE = 'audit.ndjson';

/** Filesystem mask covering the low nine mode bits. */
const PERMISSION_BASE = 0o1000;

/** Running harness instances, drained between tests. */
const running: TestService[] = [];

afterEach(async () => {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }
});

/**
 * Build an FR-010 scope matrix where every capability carries one result.
 *
 * @param result - `ok`, `missing`, or `unknown`.
 * @returns The matrix, keyed as the data model declares.
 */
function scopeResults(result: ScopeResult): Record<ScopeCapability, ScopeResult> {
    return Object.fromEntries(CAPABILITIES.map((capability) => [capability, result])) as Record<
        ScopeCapability,
        ScopeResult
    >;
}

/**
 * Start the service with a scripted GitHub.
 *
 * @param script - Answers for `/user` and `/rate_limit`.
 * @returns The harness instance plus the fake client it was given.
 */
async function startWithGitHub(script: GitHubScript): Promise<{ service: TestService; github: FakeGitHub }> {
    const github = fakeGitHub(script);
    const service = await startTestService({ github: github.verifier });
    running.push(service);
    await service.handle.reconciled;

    return { service, github };
}

/**
 * Build a `POST /v1/accounts/verify` body.
 *
 * @param token - Credential to present.
 * @param extra - Additional fields, e.g. `expectedLogin`.
 * @returns The serialized request body.
 */
function verifyBody(token: string, extra: Readonly<Record<string, unknown>> = {}): string {
    return JSON.stringify({ token, consentVersion: CONSENT_VERSION, ...extra });
}

/**
 * POST a verify body to the running service.
 *
 * @param service - Harness instance.
 * @param body - Serialized request body.
 * @returns The response.
 */
function postVerify(service: TestService, body: string): Promise<Response> {
    return service.call(VERIFY_PATH, { method: 'POST', headers: JSON_HEADERS, body });
}

/**
 * Read the `error` envelope of a failure response.
 *
 * @param response - Response whose body should be decoded.
 * @returns The error code, message, and any reason class.
 */
async function errorOf(response: Response): Promise<{
    readonly code: string;
    readonly message: string;
    readonly reasonClass: string | null;
}> {
    const decoded = (await response.json()) as {
        error?: { code?: string; message?: string; reasonClass?: string };
    };

    return {
        code: decoded.error?.code ?? '',
        message: decoded.error?.message ?? '',
        reasonClass: decoded.error?.reasonClass ?? null,
    };
}

/**
 * Assert that a text carries none of the registered credentials.
 *
 * @param subject - What is being scanned, for the failure message.
 * @param text - Haystack.
 */
function expectNoSecret(subject: string, text: string): void {
    for (const secret of REGISTERED_TOKENS) {
        expect(text, `${subject} must not contain the registered token`).not.toContain(secret);
    }
}

/**
 * Collect every secret-bearing surface of one harness instance.
 *
 * @param service - Harness instance to scan.
 * @returns Log lines and the audit trail, joined for one assertion.
 */
async function secretSurfaces(service: TestService): Promise<string> {
    const audit = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8').catch(() => '');

    return [...service.logLines, audit].join('\n');
}

/** One decoded audit row, narrowed to the fields these tests assert on. */
interface AuditRow { readonly eventType: string; readonly details: Record<string, unknown> }

/**
 * Read the audit trail of a harness instance.
 *
 * @param service - Harness instance owning the data directory.
 * @returns The parsed rows, in append order.
 */
async function auditRows(service: TestService): Promise<readonly AuditRow[]> {
    const text = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8').catch(() => '');

    return text
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as AuditRow);
}

/**
 * Whether the fixture account already exists on disk.
 *
 * @param service - Harness instance owning the data directory.
 * @returns `true` once a credential file has been written.
 */
async function accountFileExists(service: TestService): Promise<boolean> {
    try {
        await stat(join(service.dataDir, ACCOUNTS_DIR, `${ACCOUNT_ID}.json`));

        return true;
    } catch {
        return false;
    }
}

/**
 * Wait until a predicate holds, or give up after the deadline.
 *
 * @param predicate - Condition to poll for.
 * @returns Whether the predicate held before the deadline.
 */
async function waitFor(predicate: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return predicate();
}

/** A `VerifyOutcome` that recovers the fixture identity. */
const OK_OUTCOME: VerifyOutcome = {
    kind: 'ok',
    identity: { numericUserId: String(ACCOUNT_ID), login: ACCOUNT_LOGIN },
    scopeCheck: { checkedAt: '2026-09-27T00:00:00.000Z', results: scopeResults('ok') },
    credentialKind: 'classic',
    rateBaseline: null,
};

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
});

describe('POST /v1/accounts/verify — identity rules (FR-009)', () => {
    it('fails closed on an expectedLogin mismatch with nothing persisted', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN, { expectedLogin: 'someone-else' }));
        const error = await errorOf(response);

        expect(response.status).toBe(422);
        expect(error.code).toBe('account-rejected');
        expect(await accountFileExists(service)).toBe(false);
    });

    it('answers 409 duplicate-account when the numeric id is already registered', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });
        await postVerify(service, verifyBody(REGISTERED_TOKEN));

        const response = await postVerify(service, verifyBody(`${REGISTERED_TOKEN}-2`));
        const error = await errorOf(response);

        expect(response.status).toBe(409);
        expect(error.code).toBe('duplicate-account');
    });

    it('refuses a malformed token before any network call', async () => {
        const { service, github } = await startWithGitHub({ user: USER_OK });
        const malformed = [{ token: '' }, { token: 'has whitespace' }, { token: OVERSIZED_TOKEN }, { token: 42 }];

        for (const extra of malformed) {
            const response = await postVerify(
                service,
                JSON.stringify({ ...extra, consentVersion: CONSENT_VERSION }),
            );
            const error = await errorOf(response);
            expect(response.status).toBe(422);
            expect(error.code).toBe('validation');
        }

        expect(github.calls).toHaveLength(0);
    });

    it('never echoes a received value in a validation message', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });

        const response = await postVerify(
            service,
            JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: CONSENT_VERSION, expectedLogin: 12 }),
        );
        const error = await errorOf(response);

        expect(response.status).toBe(422);
        expect(error.code).toBe('validation');
        expect(error.message).toContain('expectedLogin');
        expect(error.message).not.toContain('12');
        expect(JSON.stringify(error)).not.toContain(REGISTERED_TOKEN);
    });
});

describe('POST /v1/accounts/verify — throttles (SEC-04, invariant 9)', () => {
    it('answers 429 verify-busy while another verification holds the slot', async () => {
        let release: (() => void) | undefined;
        const scripted = scriptedVerifier(
            () =>
                new Promise<VerifyOutcome>((resolve) => {
                    release = () => {
                        resolve(OK_OUTCOME);
                    };
                }),
        );
        const service = await startTestService({ github: scripted.verifier });
        running.push(service);
        await service.handle.reconciled;

        const first = postVerify(service, verifyBody(REGISTERED_TOKEN));
        expect(await waitFor(() => scripted.tokens.length === 1)).toBe(true);

        const second = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const busy = await errorOf(second);

        expect(second.status).toBe(429);
        expect(busy.code).toBe('verify-busy');

        release?.();
        const completed = await first;
        expect(completed.status).toBe(201);
        expect(scripted.tokens).toHaveLength(1);
    });

    it('answers 429 rate-limited with retry-after after 10 attempts in the window', async () => {
        const { service, github } = await startWithGitHub({ user: { status: 401 } });

        for (let attempt = 0; attempt < 10; attempt += 1) {
            const response = await postVerify(service, verifyBody(`${REGISTERED_TOKEN}-${attempt}`));
            expect(response.status).toBe(422);
        }

        const throttled = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const error = await errorOf(throttled);

        expect(throttled.status).toBe(429);
        expect(error.code).toBe('rate-limited');
        const waitSeconds = Number(throttled.headers.get(RETRY_AFTER));
        expect(waitSeconds).toBeGreaterThan(0);
        expect(github.calls).toHaveLength(10);
    });
});

describe('secret containment (NFR-004, contract §3 assertion)', () => {
    it('keeps the registered token out of every response, log line, and audit row', async () => {
        const { service } = await startWithGitHub({ user: USER_OK });
        const responses: string[] = [];

        const ok = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        responses.push(await ok.text());
        const duplicate = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        responses.push(await duplicate.text());
        const rejected = await postVerify(service, verifyBody(REGISTERED_TOKEN, { expectedLogin: 'nope' }));
        responses.push(await rejected.text());
        const malformed = await postVerify(
            service,
            JSON.stringify({ token: REGISTERED_TOKEN, consentVersion: CONSENT_VERSION, expectedLogin: 1 }),
        );
        responses.push(await malformed.text());
        const status = await service.call('/v1/status');
        responses.push(await status.text());

        expectNoSecret('responses/logs/audit', [...responses, await secretSurfaces(service)].join('\n'));
    });

    it('keeps the token out of the log when a verify is forced to fail with 500', async () => {
        const thrower = scriptedVerifier((token) => {
            throw new Error(`upstream exploded while holding ${token}`);
        });
        const service = await startTestService({ github: thrower.verifier });
        running.push(service);
        await service.handle.reconciled;

        const response = await postVerify(service, verifyBody(REGISTERED_TOKEN));
        const text = await response.text();

        expect(response.status).toBe(500);
        expect(text).not.toContain(REGISTERED_TOKEN);
        const log = service.logLines.join('\n');
        expect(log).toContain('credential route failed');
        expectNoSecret('forced-500 log', log);
        expectNoSecret('forced-500 audit', await secretSurfaces(service));
    });
});
