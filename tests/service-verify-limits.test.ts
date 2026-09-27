/**
 * Credential handoff tests (task T-007): identity rules, throttles, and the
 * registered-token secret scans (contract §3 invariants 9–10, NFR-004).
 *
 * The happy path, consent gate, and GitHub classification live in
 * `tests/service-verify.test.ts`; both suites share the harness in
 * `tests/support/verify.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from '../extension/src/consent.ts';
import type { VerifyOutcome } from '../extension/service/github.ts';
import { startTestService } from './support/service.ts';
import { scriptedVerifier } from './support/github.ts';
import {
    OK_OUTCOME,
    OVERSIZED_TOKEN,
    REGISTERED_TOKEN,
    RETRY_AFTER,
    USER_OK,
    accountFileExists,
    errorOf,
    expectNoSecret,
    postVerify,
    secretSurfaces,
    running,
    startWithGitHub,
    stopAllServices,
    verifyBody,
    waitFor,
} from './support/verify.ts';

afterEach(stopAllServices);

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

