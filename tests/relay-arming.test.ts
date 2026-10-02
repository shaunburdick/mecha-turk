/**
 * Relay-arming tests (pre-PR review merge-blocker, 2026-09-28).
 *
 * The relay used to arm in exactly two mount-time places: a *successful*
 * mount-time bindings read that already held a row, and an integration-card
 * connection while bindings were active. Two shipped shapes therefore never
 * armed — a panel whose first binding was created in-session (rows stuck
 * `pending` forever) and a panel whose mount-time `GET /v1/bindings` hit the
 * service's spawn race (503 → later Refresh succeeds → still unarmed → the
 * whole session dead until a remount). These tests pin the fix: any bindings
 * read or grant that lands at least one enabled binding arms the relay,
 * `startRelayPolling` stays idempotent, and an empty list still does not arm
 * (a relay draining against no binding would mark queued events
 * `binding-missing` before the binding they belong to exists).
 */

import { describe, expect, it } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { loadInitialBindings } from '../src/bindings-mode.ts';
import { bindRepository, loadBindings } from '../src/bindings.ts';
import { stopRelayPolling } from '../src/relay.ts';
import { ACCOUNTS_PATH, BINDINGS_PATH, EVENTS_PENDING_PATH } from '../src/service-calls.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import {
    DEFAULT_STATUS,
    FIXTURE_TIMESTAMP,
    LOGIN,
    PROJECT_ID,
    REPOSITORY,
    createTestRuntime,
    fakeHost,
    tick,
} from './support/panel.ts';

/** Numeric account id the fixture account and binding share. */
const ACCOUNT_ID = '77331';

/** Body `GET /v1/accounts` answers with: one usable fixture account. */
const ACCOUNTS_BODY = JSON.stringify({
    accounts: [{ numericUserId: ACCOUNT_ID, login: LOGIN, state: 'active', connectionState: 'connected' }],
});

/** Neutral unrouted answer for paths a script does not model. */
const UNROUTED_BODY = '{"error":{"code":"not-found","message":"unrouted"}}';

/** One enabled binding row, exactly as the service stores it. */
function activeBinding(): PanelBinding {
    return {
        bindingId: 'bnd-arm-1',
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: LOGIN,
        repository: REPOSITORY,
        projectId: PROJECT_ID,
        worktreeOption: 'generated',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
    };
}

/**
 * Body `GET /v1/bindings` answers with for the given rows.
 *
 * @param bindings - Stored bindings to report.
 * @returns The snapshot body the parser accepts.
 */
function bindingsBody(bindings: readonly PanelBinding[]): string {
    return JSON.stringify({ bindings, status: [] });
}

/** A service double whose bindings answer a test can swap mid-scenario. */
interface MutableService {
    /** Host double for {@link createTestRuntime}. */
    readonly host: ReturnType<typeof fakeHost>;
    /** Every `serviceRequest` the panel made, as `METHOD path`. */
    readonly requests: string[];
    /** Replace the bindings answer (the spawn race starts as a 503). */
    setBindingsAnswer: (answer: GuestRequestResult) => void;
}

/**
 * Build a host double that answers bindings from a swappable answer.
 *
 * The PUT leg stores its own body, so a grant round-trips exactly what the
 * panel sent — the whole-file contract the service implements.
 *
 * @param initial - First bindings answer (`GET /v1/bindings`).
 * @returns The host, the recorded legs, and the swap control.
 */
function mutableService(initial: GuestRequestResult): MutableService {
    const requests: string[] = [];
    let bindings = initial;

    return {
        requests,
        setBindingsAnswer: (answer) => {
            bindings = answer;
        },
        host: fakeHost({
            serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
                requests.push(`${request.method} ${request.path}`);
                if (request.method === 'PUT' && request.path === BINDINGS_PATH) {
                    const sent = JSON.parse(request.body ?? '{}') as { readonly bindings?: readonly PanelBinding[] };
                    bindings = { status: 200, body: bindingsBody(sent.bindings ?? []) };

                    return bindings;
                }

                if (request.method === 'GET' && request.path === BINDINGS_PATH) {
                    return bindings;
                }

                if (request.method === 'GET' && request.path === ACCOUNTS_PATH) {
                    return { status: 200, body: ACCOUNTS_BODY };
                }

                return { status: DEFAULT_STATUS, body: UNROUTED_BODY };
            },
        }),
    };
}

/**
 * Run one scenario with the relay timer cleaned up on the way out.
 *
 * Arming starts a real interval; leaving it running would let a later test's
 * host double answer a stale tick.
 *
 * @param rt - Runtime under test.
 * @param scenario - The assertions to run while the relay is armed.
 */
async function withRelay(rt: PanelRuntime, scenario: () => Promise<void> | void): Promise<void> {
    try {
        await scenario();
    } finally {
        stopRelayPolling(rt);
    }
}

describe('relay arming (bind after mount / mount-time read failure)', () => {
    it('arms when the first binding is created in an otherwise empty session', async () => {
        // The mount-time read answers an empty list, then the operator binds
        // a repository: the grant must arm what the mount could not see.
        const service = mutableService({ status: 200, body: bindingsBody([]) });
        const rt = createTestRuntime(service.host);
        rt.state.bindings.repoInput = REPOSITORY;
        rt.state.bindings.accountSelection = ACCOUNT_ID;
        rt.state.bindings.repoProjectSelection = PROJECT_ID;

        await withRelay(rt, async () => {
            await loadInitialBindings(rt);
            // Negative case: an empty bindings list never arms the relay.
            expect(rt.relayArmed).toBe(false);

            await bindRepository(rt);

            expect(rt.state.bindings.bindings.map((binding) => binding.repository)).toEqual([REPOSITORY]);
            expect(rt.state.bindingsActive).toBe(1);
            expect(rt.relayArmed).toBe(true);

            // The arm kicks one immediate tick — the claim is on the wire
            // without any timer advancing (no fake timers in this test).
            await tick();
            expect(service.requests).toContain(`GET ${EVENTS_PENDING_PATH}`);
        });
    });

    it('arms on a later read after the mount-time bindings read failed', async () => {
        // First-run shape: the service is still spawning, so the mount-time
        // GET answers 503. A Refresh that later succeeds must join the loop.
        const service = mutableService({
            status: 503,
            body: JSON.stringify({ error: { code: 'storage-unavailable', message: 'service starting' } }),
        });
        const rt = createTestRuntime(service.host);

        await withRelay(rt, async () => {
            await loadInitialBindings(rt);
            expect(rt.relayArmed).toBe(false);
            expect(rt.state.bindings.status).toBe('error');

            service.setBindingsAnswer({ status: 200, body: bindingsBody([activeBinding()]) });
            await loadBindings(rt);

            expect(rt.state.bindings.status).toBe('ready');
            expect(rt.state.bindingsActive).toBe(1);
            expect(rt.relayArmed).toBe(true);
        });
    });

    it('stays unarmed when a later read still answers no bindings', async () => {
        // The read succeeds, so the failure branch is ruled out: only an
        // empty list keeps the relay out of the loop.
        const service = mutableService({ status: 200, body: bindingsBody([]) });
        const rt = createTestRuntime(service.host);
        rt.state.bindings.status = 'error';

        await withRelay(rt, async () => {
            await loadBindings(rt);

            expect(rt.state.bindings.status).toBe('ready');
            expect(rt.state.bindingsActive).toBe(0);
            expect(rt.relayArmed).toBe(false);
            expect(service.requests).not.toContain(`GET ${EVENTS_PENDING_PATH}`);
        });
    });

    it('arms exactly once across a grant and a subsequent read', async () => {
        // `startRelayPolling` is idempotent: the second arming site must not
        // stack a second interval on the same runtime.
        const service = mutableService({ status: 200, body: bindingsBody([]) });
        const rt = createTestRuntime(service.host);
        rt.state.bindings.repoInput = REPOSITORY;
        rt.state.bindings.accountSelection = ACCOUNT_ID;
        rt.state.bindings.repoProjectSelection = PROJECT_ID;

        await withRelay(rt, async () => {
            await loadInitialBindings(rt);
            await bindRepository(rt);
            const firstTimer = rt.state.relay.timer;
            expect(firstTimer).not.toBeNull();

            await loadBindings(rt);

            expect(rt.relayArmed).toBe(true);
            expect(rt.state.relay.timer).toBe(firstTimer);
        });
    });
});
