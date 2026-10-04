/**
 * Credential handoff tests (task T-007): identity rules, throttles, and the
 * registered-token secret scans (contract §3 invariants 9–10, NFR-004).
 *
 * The happy path and GitHub classification live in
 * `tests/service-verify.test.ts`; both suites share the harness in
 * `tests/support/verify.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_PATH, ACCOUNT_TOKEN_PATH } from '../service/routes/accounts.ts';
import { VERIFY_MAX_ATTEMPTS } from '../service/throttle.ts';
import type { VerifyOutcome } from '../service/github.ts';
import { startTestService } from './support/service.ts';
import { scriptedVerifier } from './support/github.ts';
import type { TestService } from './support/service.ts';
import {
    ACCOUNT_ID,
    JSON_HEADERS,
    OK_OUTCOME,
    OVERSIZED_TOKEN,
    REGISTERED_TOKEN,
    RETRY_AFTER,
    ROTATED_TOKEN,
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

/** Path parameter placeholder shared by the account route paths. */
const ACCOUNT_PATH_PARAM = ':numericUserId';

/** Routed path of the fixture account's credential resource. */
const ROTATION_PATH = ACCOUNT_TOKEN_PATH.replace(ACCOUNT_PATH_PARAM, String(ACCOUNT_ID));

/** Routed path of the fixture account resource (delete). */
const DELETE_PATH = ACCOUNT_PATH.replace(ACCOUNT_PATH_PARAM, String(ACCOUNT_ID));

/**
 * Rotate the fixture account's credential (contract §2.2, M5b).
 *
 * @param service - Harness instance; its bearer token is attached for you.
 * @param token - Replacement credential.
 * @returns The rotation response.
 */
function rotateFixture(service: TestService, token: string): Promise<Response> {
    return service.call(ROTATION_PATH, { method: 'POST', headers: JSON_HEADERS, body: verifyBody(token) });
}

describe('POST /v1/accounts/verify — identity rules (FR-009)', () => {
    it('fails closed on an expectedLogin mismatch with nothing persisted', async () => {
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            const response = await postVerify(service, verifyBody(REGISTERED_TOKEN, { expectedLogin: 'someone-else' }));
            const error = await errorOf(response);

            expect(response.status).toBe(422);
            expect(error.code).toBe('account-rejected');
            expect(await accountFileExists(service)).toBe(false);
        }
    });

    it('answers 409 duplicate-account when the numeric id is already registered', async () => {
        {
            const { service } = await startWithGitHub({ user: USER_OK });
            await postVerify(service, verifyBody(REGISTERED_TOKEN));

            const response = await postVerify(service, verifyBody(`${REGISTERED_TOKEN}-2`));
            const error = await errorOf(response);

            expect(response.status).toBe(409);
            expect(error.code).toBe('duplicate-account');
        }
    });

    it('refuses a malformed token before any network call', async () => {
        {
            const { service, github } = await startWithGitHub({ user: USER_OK });
            const malformed = [{ token: '' }, { token: 'has whitespace' }, { token: OVERSIZED_TOKEN }, { token: 42 }];

            for (const extra of malformed) {
                const response = await postVerify(
                    service,
                    JSON.stringify({ ...extra }),
                );
                const error = await errorOf(response);
                expect(response.status).toBe(422);
                expect(error.code).toBe('validation');
            }

            expect(github.calls).toHaveLength(0);
        }
    });

    it('never echoes a received value in a validation message', async () => {
        {
            const { service } = await startWithGitHub({ user: USER_OK });

            const response = await postVerify(
                service,
                JSON.stringify({ token: REGISTERED_TOKEN, expectedLogin: 12 }),
            );
            const error = await errorOf(response);

            expect(response.status).toBe(422);
            expect(error.code).toBe('validation');
            expect(error.message).toContain('expectedLogin');
            expect(error.message).not.toContain('12');
            expect(JSON.stringify(error)).not.toContain(REGISTERED_TOKEN);
        }
    });

});

describe('POST /v1/accounts/verify — throttles (SEC-04, invariant 9)', () => {
    it('answers 429 verify-busy while another verification holds the slot', async () => {
        {
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
        }
    });

    it('answers 429 rate-limited with retry-after after 10 attempts in the window', async () => {
        {
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
        }
    });

});

describe('POST /v1/accounts/:id/token — the same throttle rules as verify (M5b)', () => {
    it('answers 429 verify-busy while another rotation holds the single slot', async () => {
        {
            let release: (() => void) | undefined;
            let hang = false;
            const scripted = scriptedVerifier(async (): Promise<VerifyOutcome> => {
                if (!hang) {
                    return OK_OUTCOME;
                }

                return await new Promise<VerifyOutcome>((resolve) => {
                    release = () => resolve(OK_OUTCOME);
                });
            });
            const service = await startTestService({ github: scripted.verifier });
            running.push(service);
            await service.handle.reconciled;
            const registered = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            expect(registered.status).toBe(201);

            hang = true;
            const rotation = rotateFixture(service, ROTATED_TOKEN);
            expect(await waitFor(() => release !== undefined)).toBe(true);
            const second = await rotateFixture(service, REGISTERED_TOKEN);
            const busy = await errorOf(second);

            expect(second.status).toBe(429);
            expect(busy.code).toBe('verify-busy');

            release?.();
            const completed = await rotation;
            expect(completed.status).toBe(200);
        }
    });

    it('shares the rolling attempt window with verify rather than opening a second one (M5b)', async () => {
        {
            const { service } = await startWithGitHub({ user: USER_OK });
            const registered = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            expect(registered.status).toBe(201);
            // Fill the window with attempts that are refused *after* the throttle
            // slot is taken, so the count reaches VERIFY_MAX_ATTEMPTS exactly.
            for (let attempt = 1; attempt < VERIFY_MAX_ATTEMPTS; attempt += 1) {
                const duplicate = await postVerify(service, verifyBody(`${REGISTERED_TOKEN}-${attempt}`));
                expect(duplicate.status).toBe(409);
            }

            const rotation = await rotateFixture(service, ROTATED_TOKEN);
            const error = await errorOf(rotation);

            expect(rotation.status).toBe(429);
            expect(error.code).toBe('rate-limited');
            expect(rotation.headers.get(RETRY_AFTER)).not.toBeNull();
        }
    });

});

describe('secret containment (NFR-004, contract §3 assertion)', () => {
    it('keeps the registered token out of every response, log line, and audit row', async () => {
        {
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
                JSON.stringify({ token: REGISTERED_TOKEN, expectedLogin: 1 }),
            );
            responses.push(await malformed.text());
            const status = await service.call('/v1/status');
            responses.push(await status.text());

            expectNoSecret('responses/logs/audit', [...responses, await secretSurfaces(service)].join('\n'));
        }
    });

    it('keeps the token out of the log when a verify is forced to fail with 500', async () => {
        {
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
            expectNoSecret('forced-500 log', log);
            expectNoSecret('forced-500 audit', await secretSurfaces(service));
        }
    });

    it('keeps both credentials out of the rotation and delete responses (M5c)', async () => {
        {
            const { service } = await startWithGitHub({ user: USER_OK });
            const registered = await postVerify(service, verifyBody(REGISTERED_TOKEN));
            expect(registered.status).toBe(201);

            const rotation = await rotateFixture(service, ROTATED_TOKEN);
            const rotationText = await rotation.text();
            const removal = await service.call(DELETE_PATH, { method: 'DELETE' });
            const removalText = await removal.text();

            expect(rotation.status).toBe(200);
            expect(removal.status).toBe(200);
            expectNoSecret('rotation response', rotationText);
            expectNoSecret('delete response', removalText);
            expectNoSecret('rotation/delete logs and audit', await secretSurfaces(service));
            expect(rotationText).not.toContain('"credential"');
            expect(removalText).not.toContain('"credential"');
        }
    });

});

