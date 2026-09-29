/**
 * Run-scoped path helper tests (003 T-023).
 *
 * The wire delta moved every mutation from a delivery id to the run's
 * correlation id, and a delivery-addressed POST now answers `404 unknown-run`
 * service-side. These tests pin the whole family to one prefix so a future call
 * site cannot quietly reintroduce the retired shape: every helper takes the run's
 * correlation id, substitutes it exactly once, and leaves no pattern behind.
 *
 * Offline and pure — nothing here performs IO.
 */

import { describe, expect, it } from 'vitest';
import {
    AUDIT_PATH,
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
    verificationPath,
} from '../src/service-calls.ts';

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
