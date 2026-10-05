/**
 * Shared harness for the credential-verification suites (task T-007).
 *
 * Every case in both suites runs the real loopback service with the real
 * GitHub *client* over a fake `fetch`, so status classification, the FR-010
 * scope matrix, and the throttles are exercised exactly as
 * production runs them. The registered credential lives here once, because
 * both suites assert **registered-token scans**: a passing scan proves
 * structural absence rather than a lucky redaction pattern.
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { ACCOUNTS_DIR } from '../../service/accounts/store.ts';
import { VERIFY_PATH } from '../../service/routes/verify.ts';
import type { ScopeCapability, ScopeResult, VerifyOutcome } from '../../service/github.ts';
import { fakeGitHub, userBody } from './github.ts';
import { startTestService } from './service.ts';
import type { EndpointResponse, FakeGitHub, GitHubScript } from './github.ts';
import type { TestService } from './service.ts';

/**
 * Build a header map without writing HTTP header names as object keys.
 *
 * @returns The headers as `fetch` accepts them.
 */
export function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs);
}
/** The `content-type` header every JSON POST carries. */
export const JSON_HEADERS: Record<string, string> = headerMap([['content-type', 'application/json']]);

/** The four FR-010 capabilities, in matrix order. */
export const CAPABILITIES: readonly ScopeCapability[] = ['metadata', 'issues', 'pull-requests', 'contents'];

/** Throttle wait header asserted by the GitHub-429 tests (contract §4). */
export const RETRY_AFTER = 'retry-after';

/** Error name `AbortSignal.timeout` rejects with (review W2-7's classification). */
export const TIMEOUT_ERROR_NAME = 'TimeoutError';

/** Response header GitHub lists a classic token's granted scopes in (FR-010). */
export const OAUTH_SCOPES_HEADER = 'x-oauth-scopes';

/** Scope header value granting every FR-010 capability on a classic token. */
export const REPO_SCOPES = 'repo, user';

/** Scope header value granting none of the FR-010 capabilities. */
export const READ_ONLY_SCOPES = 'user, read:user';

/** Credential registered with this suite's scans; deliberately un-prefixed. */
/** Length of the registered credential's body; no recognisable prefix. */
const TOKEN_BODY_LENGTH = 32;

/** Body long enough to exceed the service's per-token character cap. */
const OVERSIZED_TOKEN_LENGTH = 4_097;

export const REGISTERED_TOKEN = `registered-credential-${'x'.repeat(TOKEN_BODY_LENGTH)}`;

/** Credential the rotation tests replace the fixture token with. */
export const ROTATED_TOKEN = `${REGISTERED_TOKEN}-rotated`;

/** Every credential this suite hands a service, for registered-token scans. */
export const REGISTERED_TOKENS: readonly string[] = [REGISTERED_TOKEN, ROTATED_TOKEN];

/** Numeric id the fixture token belongs to. */
export const ACCOUNT_ID = 77_331;

/** Login the fixture token belongs to. */
export const ACCOUNT_LOGIN = 'octocat-mt';

/** Body cap the service enforces, so oversized tokens are refused pre-network. */
export const OVERSIZED_TOKEN = 'y'.repeat(OVERSIZED_TOKEN_LENGTH);

/** Identity answer used by every happy path in this file (a classic `repo` token). */
export const USER_OK: EndpointResponse = {
    body: userBody({ id: ACCOUNT_ID, login: ACCOUNT_LOGIN }),
    headers: headerMap([[OAUTH_SCOPES_HEADER, REPO_SCOPES]]),
};

/** The same identity with **no** scope header, as fine-grained tokens report. */
export const USER_NO_SCOPES: EndpointResponse = { body: userBody({ id: ACCOUNT_ID, login: ACCOUNT_LOGIN }) };

/** Name of the append-only audit trail inside the data directory. */
export const AUDIT_FILE = 'audit.ndjson';

/** Filesystem mask covering the low nine mode bits. */
export const PERMISSION_BASE = 0o1000;

/** Running harness instances, drained between tests. */
export const running: TestService[] = [];

/**
 * Shut down every service this module started for the current file.
 *
 * Each suite registers this as its own `afterEach`, so a failing test never
 * leaves a listener (or its temp data directory) behind.
 */
export async function stopAllServices(): Promise<void> {
    while (running.length > 0) {
        const service = running.pop();
        await service?.shutdown();
    }
}

/**
 * Build an FR-010 scope matrix where every capability carries one result.
 *
 * @returns The matrix, keyed as the data model declares.
 */
export function scopeResults(result: ScopeResult): Record<ScopeCapability, ScopeResult> {
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
export async function startWithGitHub(script: GitHubScript): Promise<{ service: TestService; github: FakeGitHub }> {
    const github = fakeGitHub(script);
    const service = await startTestService({ github: github.verifier });
    running.push(service);
    await service.handle.reconciled;

    return { service, github };
}

/**
 * Build a `POST /v1/accounts/verify` body.
 *
 * @param extra - Additional fields, e.g. `expectedLogin`.
 * @returns The serialized request body.
 */
export function verifyBody(token: string, extra: Readonly<Record<string, unknown>> = {}): string {
    return JSON.stringify({ token, ...extra });
}

/**
 * POST a verify body to the running service.
 *
 * @param body - Serialized request body.
 * @returns The response.
 */
export function postVerify(service: TestService, body: string): Promise<Response> {
    return service.call(VERIFY_PATH, { method: 'POST', headers: JSON_HEADERS, body });
}

/**
 * Read the `error` envelope of a failure response.
 *
 * @param response - Response whose body should be decoded.
 * @returns The error code, message, and any reason class.
 */
export async function errorOf(response: Response): Promise<{
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
export function expectNoSecret(subject: string, text: string): void {
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
export async function secretSurfaces(service: TestService): Promise<string> {
    const audit = await readFile(join(service.dataDir, AUDIT_FILE), 'utf8').catch(() => '');

    return [...service.logLines, audit].join('\n');
}

/** One decoded audit row, narrowed to the fields these tests assert on. */
export interface AuditRow {
    /** Monotonic sequence number the writer assigned. */
    readonly seq: number;
    /** Event vocabulary name. */
    readonly eventType: string;
    /** Event payload; never credential material. */
    readonly details: Record<string, unknown>;
}

/**
 * Read the audit trail of a harness instance.
 *
 * @param service - Harness instance owning the data directory.
 * @returns The parsed rows, in append order.
 */
export async function auditRows(service: TestService): Promise<readonly AuditRow[]> {
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
export async function accountFileExists(service: TestService): Promise<boolean> {
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
 * The budget is generous on purpose: it is only ever reached when the machine
 * is loaded enough to starve the timer, and every caller asserts this return
 * value, so a slow run should not read as the behaviour being broken.
 *
 * @param isDone - Condition to poll for.
 * @returns Whether the condition held before the deadline.
 */
export async function waitFor(isDone: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (isDone()) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return isDone();
}

/** A `VerifyOutcome` that recovers the fixture identity. */
export const OK_OUTCOME: VerifyOutcome = {
    kind: 'ok',
    identity: { numericUserId: String(ACCOUNT_ID), login: ACCOUNT_LOGIN },
    scopeCheck: { checkedAt: '2026-09-27T00:00:00.000Z', results: scopeResults('ok') },
    credentialKind: 'classic',
    rateBaseline: null,
};

