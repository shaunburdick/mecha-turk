/**
 * Shared doubles and fixtures for the panel handoff suites (task T-009).
 *
 * The handoff is asserted from two angles — the orchestration in
 * `tests/handoff.test.ts` and the rendering contract in
 * `tests/accounts-ui.test.ts` — and both need the same scripted
 * `serviceRequest` host, the same recording view (every rendered string is
 * captured for the secret scans), and the same registered credential, so
 * those live here exactly once.
 */

import type { GuestRequest, GuestRequestResult, HostRequestErrorCode, JsonValue } from '@openchamber/sdk';
import { HostRequestError } from '@openchamber/sdk';
import { expect } from 'vitest';
import { CONSENT_STORAGE_KEY, CONSENT_VERSION } from '../../extension/src/consent.ts';
import { currentHandoffToken } from '../../extension/src/handoff.ts';
import { STATUS_PATH } from '../../extension/src/handoff-status.ts';
import type { HandoffState } from '../../extension/src/handoff.ts';
import type { HandoffView } from '../../extension/src/accounts-ui.ts';
import type { PanelRuntime } from '../../extension/src/panel-state.ts';
import { createStorageDouble, createTestRuntime, fakeHost, tick } from './panel.ts';
import type { StorageDouble } from './panel.ts';

/** Length of the registered credential's body; no recognisable prefix. */
const TOKEN_BODY_LENGTH = 32;

/** Credential registered with this suite's scans; deliberately un-prefixed. */
export const PANEL_TOKEN = `panel-handoff-credential-${'z'.repeat(TOKEN_BODY_LENGTH)}`;

/** Fixture identity the service answers the handoff with. */
export const CONNECTED_LOGIN = 'octocat-mt';

/** Numeric id the fixture identity carries. */
export const CONNECTED_ID = '77331';

/** Acceptance timestamp used by the consent fixtures. */
export const GIVEN_AT = '2026-09-27T00:00:00.000Z';

/** A current consent mirror for the fixtures. */
export const CURRENT_CONSENT: JsonValue = { givenAt: GIVEN_AT, version: CONSENT_VERSION };

/** Body answering the pre-flight with a writable store and no accounts. */
export const STATUS_BODY = JSON.stringify({ service: { storage: { writable: true } }, accounts: [] });

/** FR-010 capability names, in the contract matrix's reporting order. */
const SCOPE_CAPABILITIES = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/**
 * Build an FR-010 scope matrix where every capability carries one result.
 *
 * Built from the capability list rather than an object literal so the
 * kebab-case capability names stay array elements instead of quoted object
 * keys (repo lint keeps object keys camelCase).
 *
 * @param result - `ok`, `missing`, or `unknown`.
 * @returns The matrix exactly as the service and the account mirror record it.
 */
export function scopeResults(result: 'ok' | 'missing' | 'unknown'): Record<string, string> {
    return Object.fromEntries(SCOPE_CAPABILITIES.map((capability) => [capability, result]));
}

/** Body answering the handoff with the fixture identity. */
export const VERIFY_BODY = JSON.stringify({
    numericUserId: CONNECTED_ID,
    login: CONNECTED_LOGIN,
    state: 'active',
    verifiedAt: GIVEN_AT,
    scopeCheck: { checkedAt: GIVEN_AT, results: scopeResults('ok') },
});
/** Recorded view the render step writes into; every string is collected. */
export interface RecordingView {
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
    /** Whether the paste row (consent field, credential input, submit) shows. */
    pasteVisible: boolean;
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
export function recordingView(): RecordingView {
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
            setPasteVisible: (visible: boolean): void => {
                record.pasteVisible = visible;
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
        pasteVisible: true,
        submitEnabled: false,
        disposed: false,
    };

    return record;
}

/** Scripted `serviceRequest` behaviour plus the requests it observed. */
export interface ScriptedHost {
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
export async function scriptedRuntime(
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
    // The mounted credential input holds the paste this test is about to hand
    // off, exactly as the real DOM would. Clearing it on every exit is
    // contract §2 step ⑧, and seeding it here is what makes
    // `expectNoCredential`'s `tokenValue` assertion a real check instead of a
    // comparison against an untouched default (review H1/W2-1).
    record.tokenValue = PANEL_TOKEN;
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
export function serviceScript(
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
export function expectNoCredential(host: ScriptedHost): void {
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
    // `scriptedRuntime` seeds this with the pasted credential; the handoff
    // must have cleared it (contract §2 step ⑧). The DOM-level proof — paste,
    // click, assert — lives in `tests/handoff-dom.test.ts`.
    expect(host.record.tokenValue).toBe('');
}
/** Empty handoff state, for building render inputs in the tests. */
export function initialState(): HandoffState {
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
