/**
 * Bearer-auth invariant additions (task T-009o, panel-service §3 invariant
 * 1(d)/(e), review W2-3).
 *
 * The transport suite already proves the uniform 401 for missing, malformed,
 * and wrong credentials; these two cases close the gaps that let an oracle
 * hide: a credential whose **byte length equals** the real service token (so a
 * length probe learns nothing), and the ordering rule itself — an unknown path
 * answered with *invalid* auth must be `401`, never `404`. Both compare the
 * refusal against the reference body byte for byte (SEC-09).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Ready probe every auth case targets; it is authenticated like any route. */
const HEALTH_PATH = '/health';

/** Prefix the host puts in front of the bearer secret. */
const BEARER_PREFIX = 'Bearer ';

/** Route no version of the service declares, for the ordering assertion. */
const UNKNOWN_PATH = '/v1/does-not-exist';

/** Service running for the current test, drained after it. */
let running: TestService | null = null;

afterEach(async () => {
    if (running === null) {
        return;
    }

    await running.shutdown();
    running = null;
});

/**
 * Start a service instance and register it for cleanup.
 *
 * @returns The running harness instance.
 */
async function startServiceForTest(): Promise<TestService> {
    const service = await startTestService();
    running = service;

    return service;
}

/**
 * Request the ready probe with an explicit bearer credential.
 *
 * @param service - Harness instance.
 * @param authorization - Complete `Authorization` header value.
 * @returns The response.
 */
function withBearer(service: TestService, authorization: string): Promise<Response> {
    return fetch(`${service.baseUrl}${HEALTH_PATH}`, { headers: { authorization } });
}

describe('invariant 1 — byte-identical refusals (SEC-09)', () => {
    it('refuses a same-length wrong-value credential with the reference 401', async () => {
        const service = await startServiceForTest();
        const reference = await fetch(`${service.baseUrl}${HEALTH_PATH}`);
        // Equal *byte* length to the real token: a length probe sees nothing.
        const sameLength = 'x'.repeat(service.token.length);
        expect(sameLength.length).toBe(service.token.length);
        expect(sameLength).not.toBe(service.token);

        const attempt = await withBearer(service, `${BEARER_PREFIX}${sameLength}`);
        const body = await attempt.text();

        expect(reference.status).toBe(401);
        expect(attempt.status).toBe(401);
        expect(body).toBe(await reference.text());
        expect(body).not.toContain(sameLength);
        expect(body).not.toContain(service.token);
    });

    it('refuses wrong values of every other length the same way', async () => {
        const service = await startServiceForTest();
        const reference = await fetch(`${service.baseUrl}${HEALTH_PATH}`);
        const referenceBody = await reference.text();
        const wrongValues = ['x'.repeat(service.token.length + 1), 'x'.repeat(4), ''];

        for (const wrong of wrongValues) {
            const attempt = await withBearer(service, `${BEARER_PREFIX}${wrong}`);

            expect(attempt.status).toBe(401);
            expect(await attempt.text()).toBe(referenceBody);
        }
    });
});

describe('invariant 1 — authentication before routing (SEC-02c)', () => {
    it('answers an unknown path with invalid auth as 401, with valid auth as 404', async () => {
        const service = await startServiceForTest();
        const reference = await fetch(`${service.baseUrl}${HEALTH_PATH}`);
        const referenceBody = await reference.text();

        const unauthenticated = await fetch(`${service.baseUrl}${UNKNOWN_PATH}`, {
            headers: { authorization: `${BEARER_PREFIX}not-the-service-token` },
        });
        const authenticated = await service.call(UNKNOWN_PATH);

        expect(unauthenticated.status).toBe(401);
        expect(await unauthenticated.text()).toBe(referenceBody);
        expect(authenticated.status).toBe(404);
    });
});
