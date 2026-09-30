/**
 * The shared service wrappers: run-scoped path helpers (003 T-023) and the
 * refusal classifier the tabs read their problem strings from (006 T-016).
 *
 * The wire delta moved every mutation from a delivery id to the run's
 * correlation id, and a delivery-addressed POST now answers `404 unknown-run`
 * service-side. These tests pin the whole family to one prefix so a future call
 * site cannot quietly reintroduce the retired shape.
 *
 * The second half is the reason 006 extended this file rather than forking it
 * (FR-043): a configuration write must keep its refusal's issue list in the
 * service's order, name *the configuration*, and stay distinguishable from a
 * store failure or a missing grant — while the bindings path keeps the exact
 * sentence it had before.
 *
 * Offline and pure — nothing here performs IO.
 */

import { describe, expect, it } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import {
    AUDIT_PATH,
    BINDINGS_PATH,
    EVENTS_PATH,
    EVENTS_PENDING_PATH,
    abandonPath,
    auditPath,
    blockedPath,
    dispatchedPath,
    requeuePath,
    reservePath,
    resolvePath,
    retryPath,
    servicePut,
    servicePutConfig,
    verificationPath,
} from '../src/service-calls.ts';
import type { ServiceConfigPutResult, ServiceRequester } from '../src/service-calls.ts';

/** Correlation id every helper is exercised with. */
const CORRELATION = 'mt-run-0123456789abcdef01234567';

/** Every run-scoped helper, paired with the verb it must end in. */
const RUN_OPERATIONS: readonly (readonly [(id: string) => string, string])[] = [
    [reservePath, 'reserve'],
    [dispatchedPath, 'dispatched'],
    [abandonPath, 'abandon'],
    [blockedPath, 'blocked'],
    [retryPath, 'retry'],
    [requeuePath, 'requeue'],
    [resolvePath, 'resolve'],
    [verificationPath, 'verification'],
];

describe('run-scoped path helpers (the correlation-id namespace)', () => {
    it('addresses every operation by the run, under the one shared prefix', () => {
        for (const [helper, verb] of RUN_OPERATIONS) {
            expect(helper(CORRELATION)).toBe(`/v1/events/${CORRELATION}/${verb}`);
        }
    });

    it('substitutes the correlation id exactly once and leaves no pattern behind', () => {
        for (const [helper] of RUN_OPERATIONS) {
            const path = helper(CORRELATION);

            expect(path).not.toContain(':correlationId');
            expect(path.split(CORRELATION)).toHaveLength(2);
        }
    });

    it('keeps the two read paths the panel polls unchanged', () => {
        expect(EVENTS_PENDING_PATH).toBe('/v1/events/pending');
        expect(EVENTS_PATH).toBe('/v1/events');
    });

    it('reads one run\'s audit rows through the correlation filter (FR-053)', () => {
        expect(AUDIT_PATH).toBe('/v1/audit');
        expect(auditPath(CORRELATION)).toBe(`/v1/audit?correlationId=${CORRELATION}`);
    });
});

/** One `422 validation` envelope shaped the way the service sends it. */
const VALIDATION_BODY = JSON.stringify({
    error: {
        code: 'validation',
        message: 'retryMaxMs: set retryMaxMs to a value greater than or equal to retryBaseMs',
        issues: [
            { field: 'retryMaxMs', remediation: 'set retryMaxMs to a value greater than or equal to retryBaseMs' },
            { field: 'expectedAgent', remediation: 'set expectedAgent to a non-empty agent name' },
            {
                field: '<withheld>',
                remediation: 'remove this key; only the documented ServiceConfig fields are accepted',
            },
        ],
    },
});

/** A requester that fails the way a closed connection does. */
const unreachableRequester: ServiceRequester = async () => {
    throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
};

/**
 * Narrow a configuration answer to its refusal half, so the cases below read
 * as assertions about a refusal rather than as four copies of the same guard.
 *
 * @param result - The answer to narrow.
 * @returns The refusal half.
 * @throws Error When the answer was a success (the test then fails here).
 */
function refusalOf(result: ServiceConfigPutResult): Extract<ServiceConfigPutResult, { readonly ok: false }> {
    if (result.ok) {
        throw new Error('a non-2xx must not read as success');
    }

    return result;
}

/**
 * Build a requester that answers one canned response and records what it was
 * asked for.
 *
 * @param answer - The response to give, or a function that throws for the
 *   transport-failure case.
 * @returns The requester plus the recorded requests.
 */
function scriptedRequester(answer: {
    readonly status: number;
    readonly body: string;
}): {
    readonly serviceRequest: ServiceRequester;
    readonly seen: readonly GuestRequest[];
} {
    const seen: GuestRequest[] = [];

    return {
        seen,
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            seen.push(request);

            return { status: answer.status, body: answer.body };
        },
    };
}

describe('the configuration write keeps the refusal body (006 T-016, FR-043, AC-112)', () => {
    it('names the configuration and carries every issue in the service\'s order', async () => {
        const { serviceRequest, seen } = scriptedRequester({ status: 422, body: VALIDATION_BODY });

        const result = await servicePutConfig({ serviceRequest, body: '{"intervalMs":60000}' });

        expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual(['PUT /v1/config']);
        const refusal = refusalOf(result);
        expect(refusal.problem).toBe('service refused the configuration');
        expect(refusal.code).toBe('validation');
        expect(refusal.issues.map((issue) => issue.field)).toEqual([
            'retryMaxMs',
            'expectedAgent',
            '<withheld>',
        ]);
        // The remediation survives byte for byte: this is the service's wording
        // the panel renders unrewritten (AC-107, FR-024).
        expect(refusal.issues[0]?.remediation).toBe(
            'set retryMaxMs to a value greater than or equal to retryBaseMs',
        );
        expect(refusal.problem).not.toContain('bindings');
    });

    it('drops an issue the envelope did not pair, rather than half-reading one', async () => {
        const { serviceRequest } = scriptedRequester({
            status: 422,
            body: JSON.stringify({
                error: {
                    code: 'validation',
                    issues: [{ field: 'intervalMs' }, 'not an entry', { field: 'perPage', remediation: 'set perPage' }],
                },
            }),
        });

        const result = await servicePutConfig({ serviceRequest, body: '{}' });

        expect(refusalOf(result).issues).toEqual([{ field: 'perPage', remediation: 'set perPage' }]);
    });

    it('keeps a store failure and an authorisation failure distinct from a refusal', async () => {
        const unavailable = scriptedRequester({
            status: 503,
            body: JSON.stringify({ error: { code: 'storage-unavailable', message: 'store is unavailable' } }),
        });
        const refused = refusalOf(
            await servicePutConfig({ serviceRequest: unavailable.serviceRequest, body: '{}' }),
        );
        const unauthorised = scriptedRequester({
            status: 401,
            body: JSON.stringify({ error: { code: 'unauthorised', message: 'missing grant' } }),
        });
        const denied = refusalOf(await servicePutConfig({ serviceRequest: unauthorised.serviceRequest, body: '{}' }));

        expect(refused.problem).toBe('service answered 503');
        expect(refused.code).toBe('storage-unavailable');
        expect(refused.issues).toEqual([]);
        expect(denied.problem).toBe('service answered 401');
        expect(denied.issues).toEqual([]);
        // Neither is a refusal of these values, and neither claims to be one.
        expect(refused.problem).not.toContain('refused');
        expect(denied.problem).not.toContain('refused');
    });

    it('describes a transport failure without quoting anything', async () => {
        const { serviceRequest } = scriptedRequester({ status: 200, body: '{}' });

        const unreachable = await servicePutConfig({ serviceRequest: unreachableRequester, body: '{}' });
        const landed = await servicePutConfig({ serviceRequest, body: '{}' });

        expect(unreachable).toEqual({
            ok: false,
            problem: 'service unreachable: ECONNREFUSED',
            code: null,
            issues: [],
        });
        expect(landed).toEqual({ ok: true, body: '{}' });
    });

    it('still says *bindings list* on the bindings path (nothing regresses)', async () => {
        const { serviceRequest } = scriptedRequester({ status: 422, body: VALIDATION_BODY });

        const result = await servicePut({ serviceRequest, path: BINDINGS_PATH, body: '[]' });

        if (result.ok) {
            throw new Error('a bindings 422 must not read as success');
        }

        expect(result.problem).toBe('service refused the bindings list');
        expect(result.code).toBe('validation');
        expect(result.message).toContain('retryMaxMs');
    });
});
