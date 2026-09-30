/**
 * Bindings-tab data-purge affordance tests (MVP fix 2, 2026-09-27).
 *
 * The data purge gives the operator manual control over service-side data:
 * per-binding removal (whole-list PUT minus that binding; accounts untouched)
 * and a two-step account removal (`DELETE /v1/accounts/:numericUserId` — the
 * first click arms, the second deletes, because `confirm()` does not exist
 * inside the service frame). The playbook is a service double that records
 * every `serviceRequest`, so the tests assert the PUT/DELETE leg and the
 * state transitions rather than the transport.
 */

import type { GuestRequest, GuestRequestResult, JsonValue } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { removeAccount, removeBinding } from '../src/bindings.ts';
import { stopRelayPolling } from '../src/relay.ts';
import { BINDINGS_PATH, accountDeletePath } from '../src/service-calls.ts';
import { ACCOUNTS_STORAGE_KEY } from '../src/account-mirror.ts';
import { createBindingsHandlers } from '../src/bindings-mount.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import { createStorageDouble, createTestRuntime, fakeHost, tick } from './support/panel.ts';
import type { StorageDouble } from './support/panel.ts';

/** Fixture identity the service owns (matches the handoff suites). */
const LOGIN = 'octocat-mt';

/** Fixture numeric account id. */
const ACCOUNT_ID = '77331';

/** RFC 3339 stamp the fixture rows carry. */
const STAMP = '2026-09-27T00:00:00.000Z';

/**
 * Build a fixture binding row with every field the parser requires.
 *
 * @param input - Distinguishing fields.
 * @returns One complete binding row.
 */
function bindingFixture(input: {
    /** Panel-generated id. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
}): PanelBinding {
    return {
        bindingId: input.bindingId,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: LOGIN,
        repository: input.repository,
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/** Body the bindings collection answers with. */
function bindingsBody(bindings: readonly PanelBinding[]): string {
    return JSON.stringify({ bindings, status: [] });
}

/** Recorded service double: answers from a handler, records every request. */
interface RecordingHost {
    /** Requests the panel made, in order. */
    readonly requests: GuestRequest[];
    /** The host double handed to {@link createTestRuntime}. */
    readonly host: Parameters<typeof createTestRuntime>[0];
}

/** Body the unrouted fallback paths answer with (neutral in every suite). */
const UNROUTED_BODY = '{"error":{"code":"not-found","message":"unrouted"}}';

/**
 * Build a host whose `serviceRequest` answers per path and records leg order.
 *
 * @param answer - What each request should return.
 * @returns The host double plus its recorded requests.
 */
function recordingService(answer: (request: GuestRequest) => GuestRequestResult): RecordingHost {
    const requests: GuestRequest[] = [];

    return {
        requests,
        host: {
            ...fakeHost(),
            serviceRequest: async (request): Promise<GuestRequestResult> => {
                requests.push(request);

                return answer(request);
            },
        },
    };
}

describe('removeBinding (per-binding purge control)', () => {
    it('grants the stored bindings without the selected row', async () => {
        const kept = bindingFixture({ bindingId: 'bnd-keep', repository: 'acme/widget' });
        const removed = bindingFixture({ bindingId: 'bnd-gone', repository: 'acme/other' });
        const { host, requests } = recordingService((request) => {
            if (request.method === 'PUT' && request.path === BINDINGS_PATH) {
                return { status: 200, body: bindingsBody([kept]) };
            }

            return { status: 404, body: UNROUTED_BODY };
        });
        const rt = createTestRuntime(host);
        rt.state.bindings.bindings = [kept, removed];
        rt.state.bindings.selectedBinding = 'bnd-gone';

        await removeBinding(rt);
        // The granted list still holds an enabled binding, so the relay arms
        // and claims immediately (pre-PR arming fix) — stop that loop before
        // counting the legs this test owns.
        stopRelayPolling(rt);

        // The PUT carried the filtered list: one row, not the selected one.
        expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
            'PUT /v1/bindings',
            'GET /v1/events/pending',
        ]);
        const put = requests[0];
        expect(put?.method).toBe('PUT');
        expect(put?.path).toBe(BINDINGS_PATH);
        const body = JSON.parse(put?.body ?? '{}') as { readonly bindings: readonly { readonly bindingId: string }[] };
        expect(body.bindings.map((binding) => binding.bindingId)).toEqual(['bnd-keep']);

        // The state follows the service's stored answer; accounts untouched.
        expect(rt.state.bindings.bindings.map((binding) => binding.bindingId)).toEqual(['bnd-keep']);
        expect(rt.state.bindings.note).toBe('Removed the binding for acme/other.');
        expect(rt.state.bindings.selectedBinding).toBeNull();
        expect(rt.state.bindingsActive).toBe(1);
    });

    it('demands a selection before putting any list', async () => {
        const { host } = recordingService(() => ({ status: 404, body: UNROUTED_BODY }));
        const rt = createTestRuntime(host);

        await removeBinding(rt);

        expect(rt.state.bindings.note).toBe('Select a binding to remove.');
    });
});

describe('removeAccount (two-step delete affordance)', () => {
    /** Fixture mirror the reinstall+wipe scenario leaves in storage. */
    const MIRROR_ENTRY: JsonValue = { numericUserId: ACCOUNT_ID, login: LOGIN, state: 'active', scopeCheck: null };

    /**
     * A runtime whose service answers the delete affirmatively and the reads
     * with the pickers' fresh lists (the deleted account is gone).
     */
    async function removalRuntime(storage: StorageDouble): Promise<{
        readonly rt: ReturnType<typeof createTestRuntime>;
        readonly requests: GuestRequest[];
    }> {
        const { host, requests } = recordingService((request) => {
            if (request.method === 'DELETE') {
                return { status: 200, body: JSON.stringify({ removed: true }) };
            }

            if (request.method === 'GET' && request.path === BINDINGS_PATH) {
                const kept = bindingFixture({ bindingId: 'bnd-1', repository: 'acme/widget' });

                return { status: 200, body: bindingsBody([kept]) };
            }

            return { status: 200, body: JSON.stringify({ accounts: [] }) };
        });
        const rt = createTestRuntime({ ...host, storage: storage.storage });
        rt.state.bindings.status = 'ready';
        rt.state.bindings.accounts = [{ numericUserId: ACCOUNT_ID, login: LOGIN, displayName: null, usable: true }];
        rt.state.handoff.connected = { numericUserId: ACCOUNT_ID, login: LOGIN };

        return { rt, requests };
    }

    it('arms on the first click and deletes on the confirmation', async () => {
        const storage = createStorageDouble({ [ACCOUNTS_STORAGE_KEY]: [MIRROR_ENTRY] });
        const { rt, requests } = await removalRuntime(storage);
        const handlers = createBindingsHandlers(rt);

        // First click: arm only — nothing reaches the service yet.
        handlers.removeAccount();
        await tick();
        expect(requests).toHaveLength(0);
        expect(rt.state.bindings.removeAccountArmed).toBe(true);

        // Second click: the confirmed delete runs.
        handlers.removeAccount();
        await tick();

        // The delete leads; the panel reloads both lists afterwards so the
        // pickers lose the removed row. The reload lands an enabled binding,
        // which arms the relay's immediate claim (pre-PR arming fix) — stop
        // that loop so its interval cannot outlive the test.
        stopRelayPolling(rt);
        expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
            `DELETE /v1/accounts/${ACCOUNT_ID}`,
            'GET /v1/bindings',
            'GET /v1/accounts',
            'GET /v1/events/pending',
        ]);
        // The connected identity pointed at the removed account.
        expect(rt.state.handoff.connected).toBeNull();
        expect(rt.state.bindings.removeAccountArmed).toBe(false);
    });

    it('clears the account mirror from host.storage after the delete', async () => {
        const storage = createStorageDouble({ [ACCOUNTS_STORAGE_KEY]: [MIRROR_ENTRY] });
        const { rt } = await removalRuntime(storage);

        await removeAccount(rt);
        // The post-delete reload lands an enabled binding and arms the relay;
        // stop it so the interval cannot outlive this test.
        stopRelayPolling(rt);

        const mirrored = storage.values.get(ACCOUNTS_STORAGE_KEY);
        expect(mirrored).toEqual([]);
    });

    it('shows the bindings refusal and keeps the account when the service refuses', async () => {
        /** The service's delete refusal exactly as the route answers it. */
        const refusalBody = JSON.stringify({
            error: { code: 'invalid-transition', message: '2 binding(s) still reference this account' },
        });
        const { host } = recordingService((request) => {
            if (request.method === 'DELETE') {
                return { status: 409, body: refusalBody };
            }

            return { status: 404, body: UNROUTED_BODY };
        });
        const rt = createTestRuntime(host);
        rt.state.bindings.status = 'ready';
        rt.state.bindings.accounts = [{ numericUserId: ACCOUNT_ID, login: LOGIN, displayName: null, usable: true }];
        rt.state.handoff.connected = { numericUserId: ACCOUNT_ID, login: LOGIN };

        await removeAccount(rt);
        await removeAccount(rt);

        expect(rt.state.bindings.note).toContain('remove them first');
        // Nothing was deleted: the identity and the state stay as they were.
        expect(rt.state.handoff.connected).toEqual({ numericUserId: ACCOUNT_ID, login: LOGIN });
        expect(rt.state.bindings.accounts).toEqual([
            { numericUserId: ACCOUNT_ID, login: LOGIN, displayName: null, usable: true },
        ]);
    });

    it('builds the delete path from the numeric id', () => {
        expect(accountDeletePath(ACCOUNT_ID)).toBe(`/v1/accounts/${ACCOUNT_ID}`);
    });
});
