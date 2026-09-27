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

import type { GuestRequest, GuestRequestResult, HostRequestErrorCode, JsonValue } from '@openchamber/sdk';
import { describe, expect, it } from 'vitest';
import { mountHandoffDom, refreshHandoff, submitHandoffAndRepaint } from '../extension/src/accounts-ui.ts';
import { CONSENT_STORAGE_KEY } from '../extension/src/consent.ts';
import { currentHandoffToken } from '../extension/src/handoff.ts';
import type { HandoffHandlers } from '../extension/src/accounts-ui.ts';
import type { PanelRuntime } from '../extension/src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';
import {
    CURRENT_CONSENT,
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
    [422, 'consent-required'],
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
    /** Initial `host.storage`; `{}` models a consentless install (F11). */
    readonly initial?: Readonly<Record<string, JsonValue>>;
}

/** A mounted handoff group over the fake document, plus its runtime. */
interface MountedHandoff {
    /** Panel runtime the group is mounted on. */
    readonly rt: PanelRuntime;
    /** The dedicated credential input. */
    readonly input: FakeElement;
    /** The submit button. */
    readonly submit: FakeElement;
    /** Every element the adapter created, in creation order. */
    readonly created: readonly FakeElement[];
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
    const handler = serviceScript(spec.verify, spec.status);
    const storage = createStorageDouble(spec.initial ?? { [CONSENT_STORAGE_KEY]: CURRENT_CONSENT });
    const host = fakeHost({
        storage: storage.storage,
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => handler(request),
    });
    const rt = createTestRuntime(host);
    const dom = fakeDom();
    let pending: Promise<void> | undefined;
    const handlers: HandoffHandlers = {
        accept: (): void => undefined,
        decline: (): void => undefined,
        submit: (token: string): void => {
            pending = submitHandoffAndRepaint(rt, token);
        },
    };
    rt.handoffView = mountHandoffDom({ root: dom.root, handlers });
    await tick();

    const input = dom.findByTag('input');
    const submit = dom.findButton(SUBMIT_LABEL);
    if (input === undefined || submit === undefined) {
        throw new Error('the handoff group did not mount its credential input and submit button');
    }

    return {
        rt,
        input,
        submit,
        created: dom.created,
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
 * Assemble every exit the input must be cleared for: success, the consent and
 * storage refusals, each host transport code, and each service refusal code.
 *
 * @returns The exit specifications, in reading order.
 */
function exitSpecs(): ExitSpec[] {
    const success: ExitSpec = { name: 'a successful handoff', verify: { status: 201, body: VERIFY_BODY } };
    const specs: ExitSpec[] = [
        success,
        { ...success, name: 'a consent refusal', initial: {} },
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
    for (const spec of exitSpecs()) {
        it(`empties the input after ${spec.name}`, async () => {
            const mounted = await mountHandoff(spec);

            mounted.input.value = PANEL_TOKEN;
            mounted.submit.click();

            // Capture-time write-through: the paste is read and the input is
            // emptied before the request is even in flight.
            expect(mounted.input.value).toBe('');

            // A value that reappears mid-flight must still be gone when the
            // handoff settles — this is the `finally` half of step ⑧.
            mounted.input.value = PANEL_TOKEN;
            await mounted.submitted();

            expect(mounted.input.value).toBe('');
            expect(mounted.rt.state.handoff.busy).toBe(false);
            expect(currentHandoffToken()).toBeUndefined();
            expect(mounted.renderedText()).not.toContain(PANEL_TOKEN);
        });
    }
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
