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

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuestRequest, GuestRequestResult, JsonValue } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { bindRepository, removeBinding, toggleBinding } from '../src/bindings.ts';
import { armAccountRemoval, removeAccount } from '../src/accounts-actions.ts';
import { createAccountsHandlers } from '../src/accounts-tab.ts';
import { removalStatement } from '../src/accounts-rows.ts';
import { bindingRows } from '../src/bindings-rows.ts';
import { stopRelayPolling } from '../src/relay.ts';
import { BINDINGS_PATH, accountRemovePath } from '../src/service-calls.ts';
import { ACCOUNTS_STORAGE_KEY } from '../src/account-mirror.ts';
import { initialBindings } from '../src/panel-state.ts';
import type { BindingsTabState } from '../src/panel-state.ts';
import type { PanelAccount, PanelBinding } from '../src/bindings-service.ts';
import { createStorageDouble, createTestRuntime, fakeHost, tick } from './support/panel.ts';
import type { StorageDouble } from './support/panel.ts';

/** Fixture identity the service owns (matches the handoff suites). */
const LOGIN = 'octocat-mt';

/** Fixture numeric account id. */
const ACCOUNT_ID = '77331';

/** Fixture repository the grants and the row copy share. */
const WIDGET_REPO = 'acme/widget';

/** A second fixture repository, so two rows can be told apart. */
const OTHER_REPO = 'acme/other';

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
    /** Stored state; defaults to the enabled one. */
    readonly state?: 'active' | 'disabled';
}): PanelBinding {
    return {
        bindingId: input.bindingId,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: LOGIN,
        repository: input.repository,
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: input.state ?? 'active',
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
        const kept = bindingFixture({ bindingId: 'bnd-keep', repository: WIDGET_REPO });
        const removed = bindingFixture({ bindingId: 'bnd-gone', repository: OTHER_REPO });
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
        expect(rt.state.bindings.note).toBe(`Removed the binding for ${OTHER_REPO}.`);
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

describe('removeAccount on the Accounts tab (two-step delete, FR-055, FR-065)', () => {
    /** Fixture mirror the reinstall+wipe scenario leaves in storage. */
    const MIRROR_ENTRY: JsonValue = { numericUserId: ACCOUNT_ID, login: LOGIN, state: 'active', scopeCheck: null };

    /**
     * A runtime whose service answers the delete affirmatively and the reads
     * with the lists the hardened guard leaves behind: the account is gone
     * and the binding it backed came back **disabled** (FR-065).
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
                const kept = bindingFixture({
                    bindingId: 'bnd-1',
                    repository: WIDGET_REPO,
                    state: 'disabled',
                });

                return { status: 200, body: bindingsBody([kept]) };
            }

            return { status: 200, body: JSON.stringify({ accounts: [] }) };
        });
        const rt = createTestRuntime({ ...host, storage: storage.storage });
        rt.state.bindings.status = 'ready';
        rt.state.bindings.accounts = [{ numericUserId: ACCOUNT_ID, login: LOGIN, displayName: null, usable: true }];
        rt.state.handoff.connected = { numericUserId: ACCOUNT_ID, login: LOGIN };
        rt.state.accounts.selected = ACCOUNT_ID;

        return { rt, requests };
    }

    it('arms on the first click, names the cascade, and sends nothing (AC-126)', async () => {
        const storage = createStorageDouble({ [ACCOUNTS_STORAGE_KEY]: [MIRROR_ENTRY] });
        const { rt, requests } = await removalRuntime(storage);
        rt.state.bindings.bindings = [
            bindingFixture({ bindingId: 'bnd-1', repository: WIDGET_REPO }),
            bindingFixture({ bindingId: 'bnd-2', repository: OTHER_REPO }),
        ];
        const handlers = createAccountsHandlers(rt);

        handlers.removeAccount();
        await tick();

        // The arm is a statement, not an action: nothing reached the service.
        expect(requests).toHaveLength(0);
        expect(rt.state.accounts.removeArmed).toBe(ACCOUNT_ID);
        const [account] = rt.state.bindings.accounts;
        expect(account).toBeDefined();
        if (account === undefined) {
            return;
        }

        const statement = removalStatement(rt.state.bindings, account);
        expect(statement).toContain('2 bindings will be disabled');
        expect(statement).toContain('nothing is deleted');

        // An account bound to nothing says zero rather than warning vaguely.
        rt.state.bindings.bindings = [];
        expect(removalStatement(rt.state.bindings, account)).toContain('0 bindings will be disabled');
        // And the arm is reversible before it ever becomes a delete.
        armAccountRemoval(rt, ACCOUNT_ID);
        expect(rt.state.accounts.removeArmed).toBe(ACCOUNT_ID);
    });

    it('deletes on the confirmation and renders its bindings disabled (AC-127)', async () => {
        const storage = createStorageDouble({ [ACCOUNTS_STORAGE_KEY]: [MIRROR_ENTRY] });
        const { rt, requests } = await removalRuntime(storage);
        const handlers = createAccountsHandlers(rt);

        handlers.removeAccount();
        await tick();
        handlers.removeAccount();
        await tick();

        // `force=1` is the cascade the arm step stated: the service's guard
        // disables the bindings (one audit row each) instead of refusing.
        expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
            `DELETE /v1/accounts/${ACCOUNT_ID}?force=1`,
            'GET /v1/bindings',
            'GET /v1/accounts',
        ]);
        expect(rt.state.accounts.removeArmed).toBeNull();
        expect(rt.state.accounts.selected).toBeNull();
        // The connected identity pointed at the removed account.
        expect(rt.state.handoff.connected).toBeNull();

        // The binding is present, disabled, and says why — never deleted.
        expect(rt.state.bindings.bindings).toHaveLength(1);
        expect(bindingRows(rt.state.bindings)[0]?.subtitle).toContain('disabled — account removed');
    });

    it('clears the account mirror from host.storage after the delete', async () => {
        const storage = createStorageDouble({ [ACCOUNTS_STORAGE_KEY]: [MIRROR_ENTRY] });
        const { rt } = await removalRuntime(storage);

        await removeAccount(rt, ACCOUNT_ID);

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

        await removeAccount(rt, ACCOUNT_ID);
        await removeAccount(rt, ACCOUNT_ID);

        expect(rt.state.accounts.note).toContain('remove them first');
        // Nothing was deleted: the identity and the state stay as they were.
        expect(rt.state.handoff.connected).toEqual({ numericUserId: ACCOUNT_ID, login: LOGIN });
        expect(rt.state.bindings.accounts).toEqual([
            { numericUserId: ACCOUNT_ID, login: LOGIN, displayName: null, usable: true },
        ]);
    });

    it('builds the forced delete path from the numeric id', () => {
        expect(accountRemovePath(ACCOUNT_ID)).toBe(`/v1/accounts/${ACCOUNT_ID}?force=1`);
    });
});

/** The service's refusal body for an invalid whole-file submission. */
const VALIDATION_REFUSAL = JSON.stringify({
    error: { code: 'validation', message: 'repository must be `owner/name`' },
});

/** The service's refusal body for a store it cannot write. */
const STORE_REFUSAL = JSON.stringify({
    error: { code: 'storage-unavailable', message: 'the bindings file could not be written' },
});

/** The one registered account the add form's picker offers. */
const REGISTERED: PanelAccount = {
    numericUserId: ACCOUNT_ID,
    login: LOGIN,
    displayName: null,
    usable: true,
};

/**
 * A binding the account cascade switched off (005 FR-054).
 *
 * @returns One complete, disabled binding row.
 */
function disabledBinding(): PanelBinding {
    return { ...bindingFixture({ bindingId: 'bnd-off', repository: WIDGET_REPO }), state: 'disabled' };
}

/**
 * Build a bindings state around one row, so the row copy can be asserted.
 *
 * @param input - The row, the accounts the service holds, and how the last
 *   read ended.
 * @returns A complete bindings state.
 */
function bindingsState(input: {
    /** The one binding to render. */
    readonly binding: PanelBinding;
    /** Accounts the service's last successful read reported. */
    readonly accounts: readonly PanelAccount[];
    /** How the last read ended; defaults to a completed one. */
    readonly status?: BindingsTabState['status'];
}): BindingsTabState {
    return {
        ...initialBindings(),
        status: input.status ?? 'ready',
        bindings: [input.binding],
        accounts: input.accounts,
    };
}

describe('the whole-file grant (FR-050, FR-054, FR-058, AC-125)', () => {
    it('sends every binding in one PUT and takes the answer back (FR-050)', async () => {
        const kept = bindingFixture({ bindingId: 'bnd-keep', repository: WIDGET_REPO });
        const { host, requests } = recordingService((request) => {
            if (request.method === 'PUT' && request.path === BINDINGS_PATH) {
                const sent = JSON.parse(request.body ?? '{}') as { readonly bindings?: readonly PanelBinding[] };

                return { status: 200, body: bindingsBody(sent.bindings ?? []) };
            }

            return { status: 404, body: UNROUTED_BODY };
        });
        const rt = createTestRuntime(host);
        rt.state.bindings.status = 'ready';
        rt.state.bindings.bindings = [kept];
        rt.state.bindings.accounts = [REGISTERED];
        rt.state.bindings.repoInput = 'acme/new';
        rt.state.bindings.accountSelection = ACCOUNT_ID;
        rt.state.bindings.repoProjectSelection = 'prj_42';

        await bindRepository(rt);
        stopRelayPolling(rt);

        const put = requests.find((request) => request.method === 'PUT' && request.path === BINDINGS_PATH);
        expect(put).toBeDefined();
        const body = JSON.parse(put?.body ?? '{}') as { readonly bindings: readonly PanelBinding[] };
        expect(body.bindings.map((binding) => binding.repository)).toEqual([WIDGET_REPO, 'acme/new']);
        expect(rt.state.bindings.bindings.map((binding) => binding.repository)).toEqual([WIDGET_REPO, 'acme/new']);
        expect(rt.state.bindings.note).toContain('Bound acme/new');
    });

    it('keeps the stored state when the service refuses a toggle (FR-054)', async () => {
        const { host, requests } = recordingService((request) => {
            if (request.method === 'PUT' && request.path === BINDINGS_PATH) {
                return { status: 503, body: STORE_REFUSAL };
            }

            return { status: 404, body: UNROUTED_BODY };
        });
        const rt = createTestRuntime(host);
        rt.state.bindings.status = 'ready';
        rt.state.bindings.bindings = [disabledBinding()];
        rt.state.bindings.selectedBinding = 'bnd-off';
        const before = JSON.stringify(rt.state.bindings.bindings);

        await toggleBinding(rt);

        expect(requests.some((request) => request.method === 'PUT')).toBe(true);
        expect(JSON.stringify(rt.state.bindings.bindings)).toBe(before);
        expect(rt.state.bindings.note).toContain('no binding changed');
    });

    it('leaves every other binding byte-identical when the submission is refused (AC-125)', async () => {
        const kept = bindingFixture({ bindingId: 'bnd-keep', repository: WIDGET_REPO });
        const other = bindingFixture({ bindingId: 'bnd-other', repository: OTHER_REPO });
        const { host, requests } = recordingService((request) => {
            if (request.method === 'PUT' && request.path === BINDINGS_PATH) {
                return { status: 422, body: VALIDATION_REFUSAL };
            }

            return { status: 404, body: UNROUTED_BODY };
        });
        const rt = createTestRuntime(host);
        rt.state.bindings.status = 'ready';
        rt.state.bindings.bindings = [kept, other];
        rt.state.bindings.accounts = [REGISTERED];
        rt.state.bindings.repoInput = 'acme/new';
        rt.state.bindings.accountSelection = ACCOUNT_ID;
        rt.state.bindings.repoProjectSelection = 'prj_42';
        const before = JSON.stringify(rt.state.bindings.bindings);

        await bindRepository(rt);

        expect(requests.some((request) => request.method === 'PUT')).toBe(true);
        expect(JSON.stringify(rt.state.bindings.bindings)).toBe(before);
        expect(rt.state.bindings.note).toContain('no binding changed');
        // The refusal names the field, never the value the operator typed.
        expect(rt.state.bindings.note).not.toContain('acme/new');
    });

    it('never issues a per-binding PATCH anywhere in the panel source (FR-050)', () => {
        const root = resolve(import.meta.dirname, '..', 'src');
        const method = /\bPATCH\b/;
        const modules = readdirSync(root, { recursive: true }).map(String);
        const offenders: string[] = [];

        for (const name of modules.filter((entry) => entry.endsWith('.ts'))) {
            const lines = readFileSync(resolve(root, name), 'utf8').split('\n');
            for (const line of lines) {
                if (method.test(line)) {
                    offenders.push(`${name}: ${line.trim()}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });
});

describe('a binding disabled because its account was removed (FR-054)', () => {
    it('names the removal on the row instead of showing an inert one', () => {
        const row = bindingRows(bindingsState({ binding: disabledBinding(), accounts: [] }))[0];

        expect(row?.leading).toBe('off');
        expect(row?.subtitle).toContain('disabled — account removed');
    });

    it('says only "disabled" when the operator turned the binding off', () => {
        const row = bindingRows(bindingsState({ binding: disabledBinding(), accounts: [REGISTERED] }))[0];

        expect(row?.subtitle).toContain('disabled');
        expect(row?.subtitle).not.toContain('account removed');
    });

    it('claims no removal while the accounts list was never read (FR-003)', () => {
        const state = bindingsState({ binding: disabledBinding(), accounts: [], status: 'error' });
        const row = bindingRows(state)[0];

        expect(row?.subtitle).toContain('disabled');
        expect(row?.subtitle).not.toContain('account removed');
    });
});
