/**
 * Panel one-shot handoff tests (task T-009, token-handoff §2/§5, FR-007).
 *
 * Every path drives the real orchestration through a scripted `serviceRequest`
 * double (shared via `tests/support/handoff.ts`) and asserts the contract's
 * panel-side promises: the `finally`-clear
 * of the credential on success **and on every failure class F1–F16**, the
 * storage-write secret scan (AC-001), the F10 pre-flight gate, and the F4 status
 * re-read. (The consent refusal path and the re-consent rule this file used to
 * pin went out with the Accept/Decline dialog on 2026-10-01 — 002 v1.9.0.)
 * Rendering itself lives in `tests/accounts-ui.test.ts`.
 */

import { HostRequestError } from '@openchamber/sdk';
import type { HostRequestErrorCode } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { handoffInputEnabled, submitHandoffAndRepaint } from '../src/accounts-ui.ts';
import { VERIFY_PATH } from '../src/handoff.ts';
import { ACCOUNTS_STORAGE_KEY } from '../src/account-mirror.ts';
import { STATUS_PATH, preflightHandoff } from '../src/handoff-status.ts';
import { STORAGE_REFUSAL } from '../src/handoff-copy.ts';
import { ACCOUNTS_PATH, BINDINGS_PATH } from '../src/service-calls.ts';
import { tick } from './support/panel.ts';
import {
    CONNECTED_ID,
    CONNECTED_LOGIN,
    GIVEN_AT,
    PANEL_TOKEN,
    STATUS_BODY,
    VERIFY_BODY,
    expectNoCredential,
    scopeResults,
    scriptedRuntime,
    serviceScript,
} from './support/handoff.ts';

/** Catalog code the `422 credential-rejected` refusals answer with (§4). */
const CREDENTIAL_REJECTED = 'credential-rejected';

describe('no consent step remains between the paste and the request (002 v1.9.0)', () => {
    it('sends the credential straight through the pre-flight, once', async () => {
        {
            const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            // After the verify, the success re-reads the Bindings tab's two lists so
            // the accounts dropdown offers the account the service just registered
            // (MVP fix 3) — no credential rides on those reads.
            expect(host.requests.map((request) => request.path)).toEqual([
                STATUS_PATH,
                VERIFY_PATH,
                BINDINGS_PATH,
                ACCOUNTS_PATH,
            ]);
            const posted = host.requests[1];
            const body = JSON.parse(posted?.body ?? '{}') as Record<string, unknown>;
            expect(body.token).toBe(PANEL_TOKEN);
            // The removed gate's field is gone from the wire the panel sends.
            expect(Object.hasOwn(body, 'consentVersion')).toBe(false);
            expectNoCredential(host);
        }
    });

    it('holds no consent state or consent storage of its own', async () => {
        {
            const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            const stateKeys = Object.keys(host.rt.state.handoff);

            expect(stateKeys).not.toContain('consentGiven');
            expect([...host.storage.values.keys()]).not.toContain('consent');
        }
    });

});

describe('successful handoff (contract §2 steps ⑧⑨)', () => {
    it('renders the connected line, mirrors the account, and clears the credential', async () => {
        {
            const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
            expect(host.rt.state.handoff.connected).toMatchObject({ numericUserId: CONNECTED_ID });
            expect(host.storage.values.get(ACCOUNTS_STORAGE_KEY)).toEqual([
                {
                    numericUserId: CONNECTED_ID,
                    login: CONNECTED_LOGIN,
                    state: 'active',
                    scopeCheck: { checkedAt: GIVEN_AT, results: scopeResults('ok') },
                },
            ]);
            expectNoCredential(host);
        }
    });

    it('leaves the input re-enabled for the next handoff after a success', async () => {
        {
            const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            expect(handoffInputEnabled(host.rt.state.handoff)).toBe(true);
        }
    });

});

describe('post-connect Bindings reload (MVP fix 3, accounts dropdown)', () => {
    /** Bindings answer for the reload read: a fresh install has none. */
    const EMPTY_BINDINGS = JSON.stringify({ bindings: [], status: [] });

    /** The accounts answer the reload read: the account the service holds. */
    const RELOAD_ACCOUNTS = JSON.stringify({
        accounts: [{ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, state: 'active' }],
    });

    /** Neutral unrouted answer for paths this script does not model. */
    const UNROUTED = JSON.stringify({ error: { code: 'not-found', message: 'unrouted' } });

    it('re-reads bindings and accounts after a successful handoff', async () => {
        const host = await scriptedRuntime((request) => {
            if (request.path === STATUS_PATH) {
                return { status: 200, body: STATUS_BODY };
            }
            if (request.path === VERIFY_PATH) {
                return { status: 201, body: VERIFY_BODY };
            }
            if (request.path === BINDINGS_PATH) {
                return { status: 200, body: EMPTY_BINDINGS };
            }
            if (request.path === ACCOUNTS_PATH) {
                return { status: 200, body: RELOAD_ACCOUNTS };
            }

            return { status: 404, body: UNROUTED };
        });

        await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });
        await tick();

        // The connected line the handoff renders is untouched by the reload,
        // and the Bindings tab now holds the account the service just registered.
        expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
        expect(host.rt.state.bindings.status).toBe('ready');
        expect(host.rt.state.bindings.accounts).toEqual([
            { numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, displayName: null, usable: true, state: 'active' },
        ]);
        expect(host.requests.map((request) => request.path)).toEqual([
            STATUS_PATH,
            VERIFY_PATH,
            BINDINGS_PATH,
            ACCOUNTS_PATH,
        ]);
        expectNoCredential(host);
    });
});

describe('host transport failures (F1–F4, F16, panel-service §1)', () => {
    /** Host codes and the phrase each one must surface. */
    const HOST_FAILURES: readonly (readonly [HostRequestErrorCode, string])[] = [
        ['NO_SERVICE', 'not approved or has not started'],
        ['NOT_GRANTED', 'Approve the extension capabilities'],
        ['DISABLED', 'extension is disabled'],
        ['SERVICE_FAILED', 'did not start'],
        ['HOST_TIMEOUT', 'did not answer in time'],
        ['HOST_UNAVAILABLE', 'restart the app'],
        ['HOST_REJECTED', 're-approve the extension'],
        ['BAD_PATH', 'Malformed request path'],
    ];

    it('clears the credential and surfaces copy for every host transport failure', async () => {
        {
            for (const [code, phrase] of HOST_FAILURES) {
                const host = await scriptedRuntime(serviceScript({ throws: code }));

                await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

                expect(host.record.note, `${code} copy`).toContain(phrase);
                expectNoCredential(host);
            }
        }
    });

    it('re-reads /v1/status after a timeout and adopts the account that appeared (F4)', async () => {
        {
            const appeared = JSON.stringify({
                service: { storage: { writable: true } },
                accounts: [{ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN }],
            });
            let statusCalls = 0;
            const host = await scriptedRuntime((request) => {
                if (request.path === STATUS_PATH) {
                    statusCalls += 1;

                    return { status: 200, body: statusCalls === 1 ? STATUS_BODY : appeared };
                }

                throw new HostRequestError('HOST_TIMEOUT', 'scripted timeout');
            });

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            expect(statusCalls).toBe(2);
            expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
            // The status re-read carries no scope matrix, so the mirror records
            // `null` instead of inventing an `unknown` verdict (FR-010, M1).
            expect(host.storage.values.get(ACCOUNTS_STORAGE_KEY)).toEqual([
                { numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, state: 'active', scopeCheck: null },
            ]);
            expectNoCredential(host);
        }
    });

});

describe('service refusal copy (F5–F15, contract §4)', () => {
    /** Service answers and the phrase each one must surface. */
    const SERVICE_FAILURES: readonly (readonly [number, string, string])[] = [
        [409, 'duplicate-account', 'already registered'],
        [422, CREDENTIAL_REJECTED, 'create a fresh PAT and paste it again'],
        [422, 'account-rejected', 'different account than the one expected'],
        [429, 'rate-limited', 'rate-limited'],
        [401, 'unauthorized', 'reinstall or re-approve'],
        [400, 'invalid-json', 'this is a bug'],
        [502, 'upstream-unavailable', 'could not be reached'],
    ];

    it('clears the credential and surfaces copy for every service refusal', async () => {
        {
            for (const [status, code, phrase] of SERVICE_FAILURES) {
                const envelope = JSON.stringify({ error: { code, message: 'contract-fixed' } });
                const host = await scriptedRuntime(serviceScript({ status, body: envelope }));

                await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

                expect(host.record.note, `${code} copy`).toContain(phrase);
                expectNoCredential(host);
            }
        }
    });

    it('renders reason-specific copy for a credential rejection', async () => {
        {
            const envelope = JSON.stringify({
                error: { code: CREDENTIAL_REJECTED, message: 'fixed', reasonClass: 'sso-required' },
            });
            const host = await scriptedRuntime(serviceScript({ status: 422, body: envelope }));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            expect(host.record.note).toContain('SSO');
            expectNoCredential(host);
        }
    });

    it('renders §4\'s reason-class wording verbatim for auth-failed and scope-missing (W2-4)', async () => {
        {
            const catalog: readonly (readonly [string, string])[] = [
                ['auth-failed', 'create a fresh PAT and paste it again'],
                ['scope-missing:contents', 'missing the Contents scope — update the token'],
            ];

            for (const [reason, phrase] of catalog) {
                const envelope = JSON.stringify({
                    error: { code: CREDENTIAL_REJECTED, message: 'fixed', reasonClass: reason },
                });
                const host = await scriptedRuntime(serviceScript({ status: 422, body: envelope }));

                await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

                expect(host.record.note).toContain(phrase);
                expectNoCredential(host);
            }
        }
    });


});

describe('duplicate-account adoption (operator re-paste after reinstall)', () => {
    /** The service's duplicate refusal exactly as the routes build it (§4). */
    const DUPLICATE_BODY = JSON.stringify({ error: { code: 'duplicate-account', message: 'contract-fixed' } });

    /** The credential-free accounts answer, run once per describe. */
    const ACCOUNTS_BODY = JSON.stringify({
        accounts: [{ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, state: 'active' }],
    });

    it('adopts the registered account instead of offering another paste that 409s', async () => {
        {
            const host = await scriptedRuntime((request) => {
                if (request.path === STATUS_PATH) {
                    return { status: 200, body: STATUS_BODY };
                }

                if (request.path === VERIFY_PATH) {
                    return { status: 409, body: DUPLICATE_BODY };
                }

                if (request.path === '/v1/accounts') {
                    return { status: 200, body: ACCOUNTS_BODY };
                }

                return { status: 404, body: JSON.stringify({ error: { code: 'not-found', message: 'unrouted' } }) };
            });

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            // The adoption filled the identity from the service's own answer and
            // the panel shows the connected line — not the rotate-the-token copy.
            expect(host.rt.state.handoff.connected).toEqual({ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN });
            expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
            expect(host.record.note).toBe(
                `This GitHub account is already registered — connected as ${CONNECTED_LOGIN}.`
            );
            expect(host.record.pasteVisible).toBe(false);
            // The mirror was rewritten for the account the mirror lost.
            expect(host.storage.values.get(ACCOUNTS_STORAGE_KEY)).toEqual([
                { numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, state: 'active', scopeCheck: null },
            ]);
            expectNoCredential(host);
        }
    });

    it('keeps the duplicate-refusal copy when the adoption read still fails', async () => {
        {
            // The default scripted double answers every non-status path (the
            // adoption's GET /v1/accounts included) with the 409 envelope, so the
            // adoption read fails closed and the catalogue copy stands.
            const host = await scriptedRuntime(serviceScript({ status: 409, body: DUPLICATE_BODY }));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            expect(host.rt.state.handoff.connected).toBeNull();
            expect(host.record.pasteVisible).toBe(true);
            expectNoCredential(host);
        }
    });

    it('re-reads the Bindings tab lists so the dropdown offers the adopted account', async () => {
        {
            const host = await scriptedRuntime((request) => {
                if (request.path === STATUS_PATH) {
                    return { status: 200, body: STATUS_BODY };
                }
                if (request.path === VERIFY_PATH) {
                    return { status: 409, body: DUPLICATE_BODY };
                }
                if (request.path === '/v1/accounts') {
                    return { status: 200, body: ACCOUNTS_BODY };
                }
                if (request.path === BINDINGS_PATH) {
                    return { status: 200, body: JSON.stringify({ bindings: [], status: [] }) };
                }

                return { status: 404, body: JSON.stringify({ error: { code: 'not-found', message: 'unrouted' } }) };
            });

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });
            await tick();

            // The adoption connects the account AND the tab re-reads it, so the
            // operator's dropdown shows it without a manual Refresh.
            expect(host.rt.state.handoff.connected).toEqual({ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN });
            expect(host.rt.state.bindings.accounts).toEqual([
                {
                    numericUserId: CONNECTED_ID,
                    login: CONNECTED_LOGIN, displayName: null, usable: true, state: 'active' },
            ]);
            expectNoCredential(host);
        }
    });

});

describe('storage pre-flight (F10/F14, SEC-08)', () => {
    it('keeps the input disabled and sends nothing while storage is unwritable', async () => {
        {
            const unwritable = JSON.stringify({ service: { storage: { writable: false } }, accounts: [] });
            const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }, unwritable));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            expect(host.requests.map((request) => request.path)).toEqual([STATUS_PATH]);
            expect(host.record.note).toBe(STORAGE_REFUSAL);
            expect(handoffInputEnabled(host.rt.state.handoff)).toBe(false);
            expect(host.record.tokenEnabled).toBe(false);
            expectNoCredential(host);
        }
    });

    it('marks storage unwritable when a submission hits 503 (F14)', async () => {
        {
            const envelope = JSON.stringify({ error: { code: 'storage-unavailable', message: 'fixed' } });
            const host = await scriptedRuntime(serviceScript({ status: 503, body: envelope }));

            await submitHandoffAndRepaint(host.rt, { token: PANEL_TOKEN });

            expect(host.rt.state.handoff.storageWritable).toBe(false);
            expectNoCredential(host);
        }
    });

    it('records the pre-flight baseline the F4 re-read compares against', async () => {
        {
            const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

            const snapshot = await preflightHandoff(host.rt);

            expect(snapshot?.storageWritable).toBe(true);
            expect(host.rt.state.handoff.knownAccountIds).toEqual([]);
            expect(host.requests.map((request) => request.path)).toEqual([STATUS_PATH]);
        }
    });

});

