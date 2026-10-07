/**
 * Credential-input clearing tests (task T-009k, token-handoff §2 step ⑧,
 * FR-007, review finding H1/W2-1).
 *
 * The contract clears the credential on **every** exit — the module-scoped
 * variable *and* the input field. The variable was already covered by
 * `tests/handoff.test.ts`; these tests cover the half that review found
 * unimplemented: they drive the real {@link mountHandoffDom} into a fake
 * document (`tests/support/dom.ts`), paste the registered credential into the
 * input, click the real submit button, and assert the input is emptied at
 * capture time (read + clear in one tick) and again when the handoff settles
 * — on a success and on every failure class F1–F16. No new test dependency:
 * the fake models only the surface the adapter touches and has no HTML sink.
 */

import type { GuestRequest, GuestRequestResult, HostRequestErrorCode } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { mountHandoffDom, preflightAndRepaint, refreshHandoff, submitHandoffAndRepaint } from '../src/accounts-ui.ts';
import { VERIFY_PATH } from '../src/handoff.ts';
import type { HandoffHandlers } from '../src/accounts-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { ACCOUNTS_PATH } from '../src/service-calls.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';
import {
    CONNECTED_ID,
    CONNECTED_LOGIN,
    PANEL_TOKEN,
    VERIFY_BODY,
    serviceScript,
} from './support/handoff.ts';
import { createStorageDouble, createTestRuntime, fakeHost, tick } from './support/panel.ts';

/** Host transport codes the panel must clear the input for (F1–F4, F16). */
const HOST_FAILURES: readonly HostRequestErrorCode[] = [
    'NO_SERVICE',
    'NOT_GRANTED',
    'DISABLED',
    'SERVICE_FAILED',
    'HOST_TIMEOUT',
    'HOST_UNAVAILABLE',
    'HOST_REJECTED',
    'BAD_PATH',
];

/** Service refusals `[status, code]` the input must be cleared for (F5–F15). */
const SERVICE_FAILURES: readonly (readonly [number, string])[] = [
    [409, 'duplicate-account'],
    [422, 'credential-rejected'],
    [422, 'account-rejected'],
    [429, 'rate-limited'],
    [401, 'unauthorized'],
    [400, 'invalid-json'],
    [502, 'upstream-unavailable'],
    [503, 'storage-unavailable'],
];

/** Status body reporting an unwritable store, for the F10 pre-flight refusal. */
const UNWRITABLE_STATUS = JSON.stringify({ service: { storage: { writable: false } }, accounts: [] });

/** Label of the mounted submit button (contract §2 step ④). */
const SUBMIT_LABEL = 'Connect account';

/** What one scripted handoff exit looks like. */
interface ExitSpec {
    /** Test name fragment. */
    readonly name: string;
    /** The `POST /v1/accounts/verify` answer, or a thrown host error. */
    readonly verify: GuestRequestResult | { readonly throws: HostRequestErrorCode };
    /** Optional status body for the pre-flight (and the F4 re-read). */
    readonly status?: string;
    /**
     * Full scripted answer, when the status+verify script is too narrow.
     *
     * The adoption read needs a `GET /v1/accounts` answer of its own, which
     * `serviceScript` (everything-but-status → verify) cannot express.
     */
    readonly script?: (request: GuestRequest) => GuestRequestResult;
}

/** A mounted handoff group over the fake document, plus its runtime. */
interface MountedHandoff {
    /** Panel runtime the group is mounted on. */
    readonly rt: PanelRuntime;
    /** The dedicated credential input. */
    readonly input: FakeElement;
    /** The optional expected-login input (005 FR-006). */
    readonly expected: FakeElement;
    /** The submit button. */
    readonly submit: FakeElement;
    /** Every element the adapter created, in creation order. */
    readonly created: readonly FakeElement[];
    /** Every request the handoff made, in order. */
    readonly requests: GuestRequest[];
    /** Element text the adapter rendered, for the credential scan. */
    renderedText(): string;
    /**
     * The in-flight handoff the submit handler started.
     *
     * @throws {Error} When the submit button was never clicked.
     * @returns The promise the handoff settles on.
     */
    submitted(): Promise<void>;
}

/**
 * Mount the real handoff group over a scripted host.
 *
 * @param spec - Scripted verify answer, status body, and initial storage.
 * @returns The mounted input, button, and runtime.
 */
async function mountHandoff(spec: ExitSpec): Promise<MountedHandoff> {
    const handler = spec.script ?? serviceScript(spec.verify, spec.status);
    const storage = createStorageDouble({});
    const requests: GuestRequest[] = [];
    const host = fakeHost({
        storage: storage.storage,
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            requests.push(request);

            return handler(request);
        },
    });
    const rt = createTestRuntime(host);
    const dom = fakeDom();
    let pending: Promise<void> | undefined;
    const handlers: HandoffHandlers = {
        submit: (token: string, expectedLogin: string): void => {
            pending = submitHandoffAndRepaint(rt, { token, expectedLogin });
        },
    };
    rt.handoffView = mountHandoffDom({ root: dom.root, handlers });
    await tick();

    const input = dom.findByTag('input');
    const expected = dom.created.find(
        (node) => node.tagName === 'input' && node.attribute('aria-label') === 'Expected GitHub login',
    );
    const submit = dom.findButton(SUBMIT_LABEL);
    if (input === undefined || expected === undefined || submit === undefined) {
        throw new Error('the handoff group did not mount its inputs and submit button');
    }

    return {
        rt,
        input,
        expected,
        submit,
        created: dom.created,
        requests,
        renderedText: (): string => dom.created.map((node) => node.textContent).join('\n'),
        submitted: (): Promise<void> => {
            if (pending === undefined) {
                throw new Error('the submit button was never clicked');
            }

            return pending;
        },
    };
}

/**
 * Assemble every exit the input must be cleared for: success, the
 * storage refusal, each host transport code, and each service refusal code.
 *
 * @returns The exit specifications, in reading order.
 */
function exitSpecs(): ExitSpec[] {
    const success: ExitSpec = { name: 'a successful handoff', verify: { status: 201, body: VERIFY_BODY } };
    const specs: ExitSpec[] = [
        success,
        { ...success, name: 'an unwritable-storage refusal', status: UNWRITABLE_STATUS },
    ];
    for (const code of HOST_FAILURES) {
        specs.push({ name: `the ${code} host failure`, verify: { throws: code } });
    }

    for (const [status, code] of SERVICE_FAILURES) {
        const body = JSON.stringify({ error: { code, message: 'contract-fixed' } });
        specs.push({ name: `the ${code} service refusal`, verify: { status, body } });
    }

    return specs;
}

describe('credential input clearing (contract §2 step ⑧, FR-007)', () => {
    it('empties the input after every exit: success, storage refusal, and each failure class', async () => {
        for (const spec of exitSpecs()) {
            const mounted = await mountHandoff(spec);

            mounted.input.value = PANEL_TOKEN;
            mounted.submit.click();

            // Capture-time write-through: the paste is read and the input is
            // emptied before the request is even in flight.
            expect(mounted.input.value, `${spec.name}: input must clear at capture`).toBe('');

            // A value that reappears mid-flight must still be gone when the
            // handoff settles — this is the `finally` half of step ⑧.
            mounted.input.value = PANEL_TOKEN;
            await mounted.submitted();

            expect(mounted.input.value, `${spec.name}: input must clear on settle`).toBe('');
            expect(mounted.rt.state.handoff.busy, `${spec.name}: busy must clear`).toBe(false);
            expect(mounted.renderedText(), `${spec.name}: rendered text must carry no token`)
                .not.toContain(PANEL_TOKEN);
        }
    });
});

describe('hostile service-supplied strings (invariant 11, M5a)', () => {
    /** What a hostile upstream would put in a login field. */
    const HOSTILE_LOGIN = '<img src=x onerror="alert(1)">';

    it('renders a hostile login as literal text, never as markup', async () => {
        const mounted = await mountHandoff({
            name: 'hostile login render',
            verify: { status: 201, body: VERIFY_BODY },
        });

        mounted.rt.state.handoff.connected = { numericUserId: '1', login: HOSTILE_LOGIN };
        refreshHandoff(mounted.rt);

        const lines = mounted.created.filter((node) => node.textContent.startsWith('Connected as'));
        expect(lines).toHaveLength(1);
        const line = lines[0];
        // The bytes arrive verbatim as text — no escaping, no parsing, no
        // element built out of them (redaction ≠ output-encoding, §4 rule 5).
        expect(line?.textContent).toBe(`Connected as ${HOSTILE_LOGIN}`);
        expect(line?.children).toHaveLength(0);
        expect(mounted.created.some((node) => node.tagName === 'img')).toBe(false);
        // The fake document has no HTML sink at all, so a sink would have
        // thrown before any of these assertions could run.
        expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
    });
});

/**
 * Read the body the group posted to the credential route.
 *
 * @param mounted - The group under test.
 * @returns The parsed body, or `undefined` when no verify was sent.
 */
function verifyBody(mounted: MountedHandoff): Record<string, unknown> | undefined {
    const request = mounted.requests.find((candidate) => candidate.path === VERIFY_PATH);
    if (request === undefined) {
        return undefined;
    }

    return JSON.parse(String(request.body)) as Record<string, unknown>;
}

/** Attribute the SDK paints every button variant from. */
const VARIANT_ATTRIBUTE = 'data-variant';

describe('the group carries a submit control and no consent dialog (002 v1.9.0)', () => {
    it('gives the submit button a real SDK variant, so it does not paint as bare text', async () => {
        {
            const mounted = await mountHandoff({
                name: 'the submit variant',
                verify: { status: 201, body: VERIFY_BODY },
            });

            // The SDK paints every variant from `[data-variant="…"]`; without the
            // attribute the button keeps only its transparent base border.
            expect(mounted.submit.attribute(VARIANT_ATTRIBUTE)).toBe('default');
        }
    });

    it('mounts neither an Accept nor a Decline decision anywhere in the group', async () => {
        {
            const mounted = await mountHandoff({
                name: 'the missing consent dialog',
                verify: { status: 201, body: VERIFY_BODY },
            });

            const labels = mounted.created
                .filter((node) => node.tagName === 'button')
                .map((node) => node.textContent);

            expect(labels).toEqual(['Connect account']);
            // The two-node consent container (copy, then decisions) is gone too.
            expect(mounted.created.some((node) => node.className === 'mt-stack')).toBe(false);
            expect(mounted.created.some((node) => node.className === 'mt-toolbar')).toBe(false);
        }
    });

});

describe('the expected-login supply surface (005 FR-006, AC-141)', () => {
    it('mounts exactly one optional non-credential input beside the token', async () => {
        {
            const mounted = await mountHandoff({
                name: 'the expected-login field',
                verify: { status: 201, body: VERIFY_BODY },
            });

            const inputs = mounted.created.filter((node) => node.tagName === 'input');
            expect(inputs).toHaveLength(2);
            expect(mounted.input.attribute('type')).toBe('password');
            expect(mounted.expected.attribute('type')).toBe('text');
        }
    });

    it('sends no expectedLogin member when the field is left empty', async () => {
        {
            const mounted = await mountHandoff({
                name: 'an empty expected login',
                verify: { status: 201, body: VERIFY_BODY },
            });

            mounted.input.value = PANEL_TOKEN;
            mounted.submit.click();
            await mounted.submitted();

            expect(verifyBody(mounted)).not.toHaveProperty('expectedLogin');
            // Both fields are emptied at capture: a constraint left behind would
            // silently apply to the next account the operator adds, and a paste
            // must never outlive its handoff (contract §2 step ⑧).
            expect(mounted.expected.value).toBe('');
            expect(mounted.input.value).toBe('');
            expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
        }
    });

    it('sends the expected login the operator typed, trimmed', async () => {
        {
            const mounted = await mountHandoff({
                name: 'a typed expected login',
                verify: { status: 201, body: VERIFY_BODY },
            });

            mounted.input.value = PANEL_TOKEN;
            mounted.expected.value = '  OctoCat-MT  ';
            mounted.submit.click();
            await mounted.submitted();

            expect(verifyBody(mounted)?.expectedLogin).toBe('OctoCat-MT');
            expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
        }
    });

    it('renders the mismatch refusal with its own copy and never the token (002 FR-009)', async () => {
        {
            const refusal = JSON.stringify({
                error: { code: 'account-rejected', message: 'contract-fixed' },
            });
            const mounted = await mountHandoff({
                name: 'a mismatched expected login',
                verify: { status: 422, body: refusal },
            });

            mounted.input.value = PANEL_TOKEN;
            mounted.expected.value = 'someone-else';
            mounted.submit.click();
            await mounted.submitted();

            expect(mounted.rt.state.handoff.note)
                .toBe('The token belongs to a different account than the one expected.');
            expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
        }
    });

    it('routes the same paste to the token-replacement path once a row arms it', async () => {
        {
            const rotated = JSON.stringify({
                numericUserId: CONNECTED_ID,
                login: CONNECTED_LOGIN,
                verifiedAt: '2026-09-27T00:00:00.000Z',
            });
            const mounted = await mountHandoff({
                name: 'a rotation',
                verify: { status: 200, body: rotated },
            });
            // A rotation is armed from a loaded row, so the account is there.
            mounted.rt.state.bindings.accounts = [
                {
                    numericUserId: CONNECTED_ID,
                    login: CONNECTED_LOGIN,
                    displayName: null,
                    usable: true,
                    state: 'active',
                },
            ];

            mounted.rt.state.accounts.rotateArmed = CONNECTED_ID;
            mounted.input.value = PANEL_TOKEN;
            mounted.submit.click();
            await mounted.submitted();

            const request = mounted.requests.find(
                (candidate) => candidate.path === `/v1/accounts/${CONNECTED_ID}/token`,
            );
            expect(request).toBeDefined();
            // The constraint never travels on a rotation: the route replaces a
            // credential for an account that is already identified.
            expect(String(request?.body)).not.toContain('expectedLogin');
            // …and neither does the removed consent gate's field (002 v1.9.0).
            expect(String(request?.body)).not.toContain('consentVersion');
            // The arm clears and the retention promise is what the note reports.
            expect(mounted.rt.state.accounts.rotateArmed).toBeNull();
            expect(mounted.rt.state.accounts.note).toContain('retained');
            expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
        }
    });

});

/* ------------------------------------------------------------------------- *
 * GitHub issue #35 — the add form must survive a connection.
 *
 * The old render step hid the paste row (credential input, expected-login
 * input, submit) as soon as `connected` was set, so any install that already
 * held an account showed only "Refresh accounts": 002 FR-006 (N accounts)
 * and 005 US4 scenario 3 (the second account's flow is identical) both
 * demand the same paste → connect flow the whole time.
 * ------------------------------------------------------------------------- */

/**
 * Locate the credential row the old render step hid.
 *
 * Group and row are the only `div.oc-sdk` elements the adapter creates, in
 * creation order — the group first, then the row that holds both inputs —
 * so the row is the second of the two.
 *
 * @param created - Every element the adapter created, in order.
 * @returns The row, or `undefined` when the structure changed.
 */
function credentialRow(created: readonly FakeElement[]): FakeElement | undefined {
    const divs = created.filter((node) => node.tagName === 'div' && node.className === 'oc-sdk');

    return divs[1];
}

/**
 * Assert the add form is fully present and usable.
 *
 * @param mounted - The mounted group under test.
 * @param context - What produced this state, for failure labels.
 */
function expectFormAvailable(mounted: MountedHandoff, context: string): void {
    expect(credentialRow(mounted.created)?.hidden, `${context}: credential row hidden`).toBe(false);
    expect(mounted.submit.hidden, `${context}: submit hidden`).toBe(false);
    expect(mounted.input.disabled, `${context}: credential input disabled`).toBe(false);
    expect(mounted.submit.disabled, `${context}: submit disabled`).toBe(false);
}

describe('the add form survives a connection (GitHub issue #35)', () => {
    /** The accounts answer the adoption read: the service holds one already. */
    const HELD_ACCOUNTS = JSON.stringify({
        accounts: [{ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, state: 'active' }],
    });

    it('stays available after a 201 connect, and a second submit sends a second verify', async () => {
        const mounted = await mountHandoff({
            name: 'a second account after a success',
            verify: { status: 201, body: VERIFY_BODY },
        });

        mounted.input.value = PANEL_TOKEN;
        mounted.submit.click();
        await mounted.submitted();

        expectFormAvailable(mounted, 'post-connect');
        expect(mounted.renderedText()).toContain(`Connected as ${CONNECTED_LOGIN}`);

        // The second paste must reach the credential route — exactly what
        // the hidden row made impossible (issue #35).
        mounted.input.value = PANEL_TOKEN;
        mounted.submit.click();
        await mounted.submitted();

        expect(mounted.requests.filter((request) => request.path === VERIFY_PATH)).toHaveLength(2);
        expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
    });

    it('stays available after adoption, and pastes still send verify', async () => {
        const base = serviceScript({ status: 201, body: VERIFY_BODY });
        const mounted = await mountHandoff({
            name: 'a paste after adoption',
            verify: { status: 201, body: VERIFY_BODY },
            script: (request) =>
                request.path === ACCOUNTS_PATH ? { status: 200, body: HELD_ACCOUNTS } : base(request),
        });

        // The mount's own sequence — adoption, pre-flight, repaint — is what
        // used to leave the operator with only "Refresh accounts".
        await preflightAndRepaint(mounted.rt);

        expect(mounted.rt.state.handoff.connected).toEqual({
            numericUserId: CONNECTED_ID,
            login: CONNECTED_LOGIN,
        });
        expect(mounted.renderedText()).toContain(`Connected as ${CONNECTED_LOGIN}`);
        expectFormAvailable(mounted, 'post-adoption');

        mounted.input.value = PANEL_TOKEN;
        mounted.submit.click();
        await mounted.submitted();
        expect(mounted.requests.filter((request) => request.path === VERIFY_PATH)).toHaveLength(1);

        mounted.input.value = PANEL_TOKEN;
        mounted.submit.click();
        await mounted.submitted();
        expect(mounted.requests.filter((request) => request.path === VERIFY_PATH)).toHaveLength(2);
        expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
    });
});
