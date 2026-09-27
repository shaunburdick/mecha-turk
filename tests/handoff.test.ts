/**
 * Panel one-shot handoff tests (task T-009, token-handoff §2/§5, FR-007/FR-008).
 *
 * Every path drives the real orchestration through a scripted `serviceRequest`
 * double and asserts the contract's panel-side promises: the consent refusal
 * path (AC-002), the `finally`-clear of the credential on success **and on
 * every failure class F1–F16**, the storage-write secret scan (AC-001), the
 * rendered-string secret scan, the F10 pre-flight gate, the F4 status re-read,
 * and the re-consent rule when a stored version is older than the current one.
 *
 * The DOM half is covered by a static scan of its source: rendering must go
 * through `textContent`/`setAttribute` and never through an HTML sink
 * (contract §4 rule 5, SEC-14), and the input must stay `type="password"` with
 * `autocomplete="new-password"` (SEC-17).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HostRequestError } from '@openchamber/sdk';
import type { GuestRequest, GuestRequestResult, HostRequestErrorCode, JsonValue } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { handoffInputEnabled, renderHandoff, submitHandoffAndRepaint } from '../extension/src/accounts-ui.ts';
import { CONSENT_COPY_V1, CONSENT_STORAGE_KEY, CONSENT_VERSION } from '../extension/src/consent.ts';
import {
    ACCOUNTS_STORAGE_KEY,
    VERIFY_PATH,
    acceptHandoffConsent,
    currentHandoffToken,
} from '../extension/src/handoff.ts';
import type { HandoffState } from '../extension/src/handoff.ts';
import { STATUS_PATH, preflightHandoff } from '../extension/src/handoff-status.ts';
import { CONSENT_REFUSAL, STORAGE_REFUSAL } from '../extension/src/handoff-copy.ts';
import type { HandoffView } from '../extension/src/accounts-ui.ts';
import type { PanelRuntime } from '../extension/src/panel-state.ts';
import { createTestRuntime, createStorageDouble, fakeHost, tick } from './support/panel.ts';
import type { StorageDouble } from './support/panel.ts';

/** Credential registered with this suite's scans; deliberately un-prefixed. */
const PANEL_TOKEN = `panel-handoff-credential-${'z'.repeat(32)}`;

/** Fixture identity the service answers the handoff with. */
const CONNECTED_LOGIN = 'octocat-mt';

/** Numeric id the fixture identity carries. */
const CONNECTED_ID = '77331';

/** Acceptance timestamp used by the consent fixtures. */
const GIVEN_AT = '2026-09-27T00:00:00.000Z';

/** A current consent mirror for the fixtures. */
const CURRENT_CONSENT: JsonValue = { givenAt: GIVEN_AT, version: CONSENT_VERSION };

/** Body answering the pre-flight with a writable store and no accounts. */
const STATUS_BODY = JSON.stringify({ service: { storage: { writable: true } }, accounts: [] });

/** Body answering the handoff with the fixture identity. */
const VERIFY_BODY = JSON.stringify({
    numericUserId: CONNECTED_ID,
    login: CONNECTED_LOGIN,
    state: 'active',
    verifiedAt: GIVEN_AT,
    scopeCheck: { checkedAt: GIVEN_AT, results: { metadata: 'ok', issues: 'ok', pull: 'ok' } },
});

/** Filesystem path of the DOM adapter, for the static rendering scan. */
const DOM_SOURCE_PATH = resolve(import.meta.dirname, '../extension/src/accounts-ui.ts');

/** Recorded view the render step writes into; every string is collected. */
interface RecordingView {
    /** The view handed to `renderHandoff`. */
    readonly view: HandoffView;
    /** Every non-empty string the render step produced, for secret scans. */
    readonly rendered: string[];
    /** Consent copy as rendered. */
    consentText: string;
    /** Whether the consent step is visible. */
    consentShown: boolean;
    /** Whether the credential input accepts typing. */
    tokenEnabled: boolean;
    /** The credential input's current value. */
    tokenValue: string;
    /** The operator-facing note. */
    note: string;
    /** The connected line, when one is shown. */
    connected: string | null;
    /** Whether the submit button is enabled. */
    submitEnabled: boolean;
    /** Whether the view was disposed. */
    disposed: boolean;
}

/**
 * Build a recording view that captures everything the render writes.
 *
 * @returns The view plus its mutable record.
 */
function recordingView(): RecordingView {
    const record: RecordingView = {
        view: {
            setConsentText: (text: string): void => {
                record.consentText = text;
                record.rendered.push(text);
            },
            showConsent: (show: boolean): void => {
                record.consentShown = show;
            },
            setTokenEnabled: (enabled: boolean): void => {
                record.tokenEnabled = enabled;
            },
            setTokenValue: (value: string): void => {
                record.tokenValue = value;
            },
            setNote: (text: string): void => {
                record.note = text;
                record.rendered.push(text);
            },
            setConnected: (text: string | null): void => {
                record.connected = text;
                if (text !== null) {
                    record.rendered.push(text);
                }
            },
            setSubmitEnabled: (enabled: boolean): void => {
                record.submitEnabled = enabled;
            },
            dispose: (): void => {
                record.disposed = true;
            },
        },
        rendered: [],
        consentText: '',
        consentShown: true,
        tokenEnabled: false,
        tokenValue: '',
        note: '',
        connected: null,
        submitEnabled: false,
        disposed: false,
    };

    return record;
}

/** Scripted `serviceRequest` behaviour plus the requests it observed. */
interface ScriptedHost {
    /** Storage double backing the host. */
    readonly storage: StorageDouble;
    /** Requests the panel made, in order. */
    readonly requests: readonly GuestRequest[];
    /** Runtime bound to the scripted host. */
    readonly rt: PanelRuntime;
    /** The recording view mounted on the runtime. */
    readonly record: RecordingView;
}

/**
 * Build a runtime whose `serviceRequest` answers from a handler.
 *
 * @param handler - Decides the answer for each request; may throw a host error.
 * @param initial - Values pre-loaded into `host.storage`.
 * @returns The runtime, its storage, and the recorded requests.
 */
async function scriptedRuntime(
    handler: (request: GuestRequest, index: number) => GuestRequestResult | Promise<GuestRequestResult>,
    initial: Readonly<Record<string, JsonValue>> = { [CONSENT_STORAGE_KEY]: CURRENT_CONSENT },
): Promise<ScriptedHost> {
    const storage = createStorageDouble(initial);
    const requests: GuestRequest[] = [];
    const host = fakeHost({
        storage: storage.storage,
        serviceRequest: async (request) => {
            requests.push(request);

            return await handler(request, requests.length);
        },
    });
    const rt = createTestRuntime(host);
    const record = recordingView();
    rt.handoffView = record.view;
    await tick();

    return { storage, requests, rt, record };
}

/**
 * Answer the pre-flight, and refuse or accept the verification afterwards.
 *
 * @param verify - What the `POST /v1/accounts/verify` leg should do.
 * @param status - Optional status body for both status reads.
 * @returns A handler for {@link scriptedRuntime}.
 */
function serviceScript(
    verify: GuestRequestResult | { readonly throws: HostRequestErrorCode },
    status: string = STATUS_BODY,
): (request: GuestRequest) => GuestRequestResult {
    return (request) => {
        if (request.path === STATUS_PATH) {
            return { status: 200, body: status };
        }

        if ('throws' in verify) {
            throw new HostRequestError(verify.throws, 'scripted host failure');
        }

        return verify;
    };
}

/**
 * Assert that no registered credential survived anywhere the test can see.
 *
 * @param host - Scripted runtime holding storage, requests, and rendered text.
 */
function expectNoCredential(host: ScriptedHost): void {
    const surfaces = [
        // The outbound request body is the one surface that *must* carry the
        // credential (that is the handoff); everything the panel stores,
        // renders, or echoes must not.
        ...[...host.storage.values.values()].map((value) => JSON.stringify(value)),
        ...host.requests.map((request) => request.path),
        ...host.record.rendered,
    ].join('\n');

    expect(surfaces).not.toContain(PANEL_TOKEN);
    expect(currentHandoffToken()).toBeUndefined();
    expect(host.record.tokenValue).toBe('');
}

/** Empty handoff state, for building render inputs in the tests. */
function initialState(): HandoffState {
    return {
        consentGiven: false,
        storageWritable: false,
        preflighted: false,
        knownAccountIds: [],
        connected: null,
        note: '',
        busy: false,
    };
}

/** Assert that a list of rendered strings carries no registered credential. */
function expectNoCredentialInStrings(strings: readonly string[]): void {
    expect(strings.join('\n')).not.toContain(PANEL_TOKEN);
}

describe('consent gate (AC-002, contract §1)', () => {
    it('refuses the handoff before any request when no consent was given', async () => {
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }), {});

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.requests).toHaveLength(0);
        expect(host.record.note).toBe(CONSENT_REFUSAL);
        expectNoCredential(host);
    });

    it('refuses again when the stored consent version is older than the current copy', async () => {
        const stale: JsonValue = { givenAt: GIVEN_AT, version: CONSENT_VERSION - 1 };
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }), {
            [CONSENT_STORAGE_KEY]: stale,
        });

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.requests).toHaveLength(0);
        expect(host.record.note).toBe(CONSENT_REFUSAL);
        expectNoCredential(host);
    });

    it('records the acceptance mirror with the current version', async () => {
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }), {});

        await acceptHandoffConsent(host.rt);

        expect(host.storage.values.get(CONSENT_STORAGE_KEY)).toMatchObject({ version: CONSENT_VERSION });
        expect(host.rt.state.handoff.consentGiven).toBe(true);
    });

    it('sends the credential once with the current consentVersion', async () => {
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.requests.map((request) => request.path)).toEqual([STATUS_PATH, VERIFY_PATH]);
        const posted = host.requests[1];
        const body = JSON.parse(posted?.body ?? '{}') as Record<string, unknown>;
        expect(body.consentVersion).toBe(CONSENT_VERSION);
        expect(body.token).toBe(PANEL_TOKEN);
    });
});

describe('successful handoff (contract §2 steps ⑧⑨)', () => {
    it('renders the connected line, mirrors the account, and clears the credential', async () => {
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
        expect(host.rt.state.handoff.connected).toMatchObject({ numericUserId: CONNECTED_ID });
        expect(host.storage.values.get(ACCOUNTS_STORAGE_KEY)).toEqual([
            { numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, state: 'active' },
        ]);
        expect(host.storage.values.has(CONSENT_STORAGE_KEY)).toBe(true);
        expectNoCredential(host);
    });

    it('leaves the input re-enabled for the next handoff after a success', async () => {
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(handoffInputEnabled(host.rt.state.handoff)).toBe(true);
        expect(host.record.consentShown).toBe(false);
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

    for (const [code, phrase] of HOST_FAILURES) {
        it(`clears the credential and surfaces copy for ${code}`, async () => {
            const host = await scriptedRuntime(serviceScript({ throws: code }));

            await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

            expect(host.record.note).toContain(phrase);
            expectNoCredential(host);
        });
    }

    it('re-reads /v1/status after a timeout and adopts the account that appeared (F4)', async () => {
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

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(statusCalls).toBe(2);
        expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
        expectNoCredential(host);
    });
});

describe('service refusal copy (F5–F15, contract §4)', () => {
    /** Service answers and the phrase each one must surface. */
    const SERVICE_FAILURES: readonly (readonly [number, string, string])[] = [
        [409, 'duplicate-account', 'already registered'],
        [422, 'credential-rejected', 'check the reason, then paste a new one'],
        [422, 'account-rejected', 'different account than the one expected'],
        [429, 'rate-limited', 'rate-limited'],
        [401, 'unauthorized', 'reinstall or re-approve'],
        [400, 'invalid-json', 'this is a bug'],
        [502, 'upstream-unavailable', 'could not be reached'],
    ];

    for (const [status, code, phrase] of SERVICE_FAILURES) {
        it(`clears the credential and surfaces copy for ${code}`, async () => {
            const envelope = JSON.stringify({ error: { code, message: 'contract-fixed' } });
            const host = await scriptedRuntime(serviceScript({ status, body: envelope }));

            await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

            expect(host.record.note).toContain(phrase);
            expectNoCredential(host);
        });
    }

    it('renders reason-specific copy for a credential rejection (AC-003)', async () => {
        const envelope = JSON.stringify({
            error: { code: 'credential-rejected', message: 'fixed', reasonClass: 'sso-required' },
        });
        const host = await scriptedRuntime(serviceScript({ status: 422, body: envelope }));

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.record.note).toContain('SSO');
        expectNoCredential(host);
    });

    it('drops the stored consent when the service answers consent-required (§1.2)', async () => {
        const envelope = JSON.stringify({ error: { code: 'consent-required', message: 'fixed' } });
        const host = await scriptedRuntime(serviceScript({ status: 422, body: envelope }));

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.record.note).toContain('Consent needs renewing');
        expect(host.storage.values.has(CONSENT_STORAGE_KEY)).toBe(false);
        expect(host.rt.state.handoff.consentGiven).toBe(false);
        expectNoCredential(host);
    });
});

describe('storage pre-flight (F10/F14, SEC-08)', () => {
    it('keeps the input disabled and sends nothing while storage is unwritable', async () => {
        const unwritable = JSON.stringify({ service: { storage: { writable: false } }, accounts: [] });
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }, unwritable));

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.requests.map((request) => request.path)).toEqual([STATUS_PATH]);
        expect(host.record.note).toBe(STORAGE_REFUSAL);
        expect(handoffInputEnabled(host.rt.state.handoff)).toBe(false);
        expect(host.record.tokenEnabled).toBe(false);
        expectNoCredential(host);
    });

    it('marks storage unwritable when a submission hits 503 (F14)', async () => {
        const envelope = JSON.stringify({ error: { code: 'storage-unavailable', message: 'fixed' } });
        const host = await scriptedRuntime(serviceScript({ status: 503, body: envelope }));

        await submitHandoffAndRepaint(host.rt, PANEL_TOKEN);

        expect(host.rt.state.handoff.storageWritable).toBe(false);
        expect(host.record.note).toContain('not writable');
        expectNoCredential(host);
    });

    it('records the pre-flight baseline the F4 re-read compares against', async () => {
        const host = await scriptedRuntime(serviceScript({ status: 201, body: VERIFY_BODY }));

        const snapshot = await preflightHandoff(host.rt);

        expect(snapshot?.storageWritable).toBe(true);
        expect(host.rt.state.handoff.knownAccountIds).toEqual([]);
        expect(host.requests.map((request) => request.path)).toEqual([STATUS_PATH]);
    });
});

describe('rendering (contract §1.1, §4 rule 5, SEC-17)', () => {
    it('renders CONSENT_COPY_V1 verbatim into the consent step', () => {
        const record = recordingView();

        renderHandoff(
            { ...initialState(), consentGiven: false },
            record.view,
        );

        expect(record.consentText).toBe(CONSENT_COPY_V1);
        expect(record.consentShown).toBe(true);
        expectNoCredentialInStrings(record.rendered);
    });

    it('hides the consent step once the current copy is accepted', () => {
        const record = recordingView();

        renderHandoff({ ...initialState(), consentGiven: true }, record.view);

        expect(record.consentShown).toBe(false);
    });

    it('enables the credential input only after consent and a writable pre-flight', () => {
        const base = initialState();
        const record = recordingView();

        expect(handoffInputEnabled({ ...base, consentGiven: true })).toBe(false);
        expect(handoffInputEnabled({ ...base, storageWritable: true })).toBe(false);
        expect(
            handoffInputEnabled({ ...base, consentGiven: true, storageWritable: true }),
        ).toBe(true);
        expect(handoffInputEnabled({ ...base, consentGiven: true, storageWritable: true, busy: true })).toBe(false);

        renderHandoff({ ...base, consentGiven: true, storageWritable: true }, record.view);
        expect(record.tokenEnabled).toBe(true);
        expect(record.submitEnabled).toBe(true);
    });

    it('renders the connected line through the view, never as markup', () => {
        const record = recordingView();

        renderHandoff({ ...initialState(), connected: { numericUserId: '1', login: 'octocat' } }, record.view);

        expect(record.connected).toBe('Connected as octocat');
    });

    it('keeps DOM rendering on textContent and the pinned input attributes', () => {
        const source = readFileSync(DOM_SOURCE_PATH, 'utf8');

        expect(source).toContain('textContent');
        expect(source).toContain("setAttribute('type', 'password')");
        expect(source).toContain("setAttribute('autocomplete', 'new-password')");
        // Usage, not vocabulary: the module's own docs name the forbidden
        // sinks, so the scan looks for how they would actually be called.
        expect(source).not.toMatch(/\.innerHTML\b/);
        expect(source).not.toMatch(/insertAdjacentHTML\s*\(/);
        expect(source).not.toMatch(/\.outerHTML\b/);
    });
});
