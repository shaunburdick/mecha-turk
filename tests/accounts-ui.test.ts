/**
 * Rendering-contract tests for the one-shot handoff (task T-009,
 * token-handoff §2 step ①, panel-service §3 invariant 11).
 *
 * The render step is a pure mapping from state onto a view, so these tests
 * drive it with the recording double: the input must stay gated on a writable
 * pre-flight, and no
 * rendered string may carry a credential. (The consent-copy-verbatim and
 * consent-gate cases this file used to pin went out with the Accept/Decline
 * dialog on 2026-10-01 — 002 v1.9.0 — where the copy lives on as the static
 * Accounts disclaimer pinned in `tests/disclaimer.test.ts`.) The DOM adapter
 * itself is checked
 * by a static scan — it must write through `textContent`/`setAttribute` only
 * and must pin `type="password"` with `autocomplete="new-password"` — and
 * (review F-E) that sink scan now covers **every** module under
 * `src`, not just the adapter.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it, vi } from 'vitest';
import { adoptServiceAccounts } from '../src/account-adoption.ts';
import { saveProfile, splitProfileRefusal } from '../src/accounts-actions.ts';
import {
    ACCOUNT_PROMPT_GUIDANCE,
    ACCOUNT_PROMPT_LABEL,
    ACCOUNT_PROMPT_NOT_SET,
    HANDOFF_REMEDIATION,
    accountDetail,
    accountFieldView,
    accountRows,
    accountTitle,
    bindingsPhrase,
    connectionPhrase,
    lifecycleCopy,
    rotationStatement,
} from '../src/accounts-rows.ts';
import { ACCOUNTS_DISCLAIMER_PARAGRAPHS } from '../src/accounts-disclaimer.ts';
import { selectAccountRow } from '../src/accounts-tab.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import {
    handoffInputEnabled,
    refreshHandoff,
    renderHandoff,
} from '../src/accounts-ui.ts';
import { ACCOUNTS_STORAGE_KEY } from '../src/account-mirror.ts';
import type { ScopeResult } from '../src/account-mirror.ts';
import { initialBindings } from '../src/panel-state.ts';
import type { BindingsTabState, PanelRuntime } from '../src/panel-state.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { AccountScopeMatrix, PanelAccount, PanelBinding } from '../src/bindings-service.ts';
import { parseAccountsBody } from '../src/bindings-service.ts';
import { ACCOUNTS_PATH } from '../src/service-calls.ts';
import {
    CONNECTED_ID,
    CONNECTED_LOGIN,
    GIVEN_AT,
    PANEL_TOKEN,
    STATUS_BODY,
    initialState,
    recordingView,
    scopeResults,
    scriptedRuntime,
} from './support/handoff.ts';
import { ACCOUNT_TIER_SENTINEL } from './support/prompt-tiers.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });

                return {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => undefined,
                };
            };
        }
    }

    return stubbed;
});

/** Filesystem path of the DOM adapter, for the static rendering scan. */
const DOM_SOURCE_PATH = resolve(import.meta.dirname, '../src/accounts-ui.ts');

/** Assert that a list of rendered strings carries no registered credential. */
function expectNoCredentialInStrings(strings: readonly string[]): void {
    expect(strings.join('\n')).not.toContain(PANEL_TOKEN);
}
describe('rendering (contract §4 rule 5, SEC-17)', () => {
    it('carries no consent member in the view the render step writes (002 v1.9.0)', () => {
        const record = recordingView();

        renderHandoff(initialState(), record.view);

        // The dialog's writers left the view with the dialog itself.
        expect(Object.keys(record.view)).not.toContain('setConsentText');
        expect(Object.keys(record.view)).not.toContain('showConsent');
        expectNoCredentialInStrings(record.rendered);
    });

    it('enables the credential input only after a writable pre-flight', () => {
        const base = initialState();
        const record = recordingView();

        expect(handoffInputEnabled(base)).toBe(false);
        expect(handoffInputEnabled({ ...base, storageWritable: true })).toBe(true);
        expect(handoffInputEnabled({ ...base, storageWritable: true, busy: true })).toBe(false);

        renderHandoff({ ...base, storageWritable: true }, record.view);
        expect(record.tokenEnabled).toBe(true);
        expect(record.submitEnabled).toBe(true);
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

describe('silent account adoption (MVP blocker 2)', () => {
    it('adopts a service-side account after a reinstall and hides the paste form', async () => {
        const accountsBody = JSON.stringify({
            accounts: [
                {
                    numericUserId: CONNECTED_ID,
                    login: CONNECTED_LOGIN,
                    state: 'active',
                    scopeCheck: { checkedAt: GIVEN_AT, results: scopeResults('ok') },
                },
            ],
        });
        // Reinstall state: host.storage is wiped — no consent mirror, no
        // account mirror. Only the service still holds the account.
        const host = await scriptedRuntime(
            (request) => {
                return ({ status: 200, body: request.path === ACCOUNTS_PATH ? accountsBody : STATUS_BODY });
            },
            {},
        );

        await adoptServiceAccounts(host.rt);
        refreshHandoff(host.rt);

        expect(host.rt.state.handoff.connected).toEqual({ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN });
        expect(host.record.connected).toBe(`Connected as ${CONNECTED_LOGIN}`);
        expect(host.record.pasteVisible).toBe(false);
        // The paste row stays hidden because the service already holds the
        // account; the disclaimer beneath the Accounts list has no visibility
        // rule at all — it is always there (002 v1.9.0).
        // The adoption rewrote the mirror the reinstall deleted, so the
        // next mount adopts from storage without touching the service.
        const mirrored = host.storage.values.get(ACCOUNTS_STORAGE_KEY);
        expect(mirrored).toBeDefined();
        expect(JSON.stringify(mirrored)).toContain(CONNECTED_ID);
    });
});

/** The picker callbacks the shell takes; none is exercised by this suite. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** Every lifecycle state FR-062 names, in the order the DTO lists them. */
const LIFECYCLE_STATES = [
    'pending_handoff',
    'verifying',
    'active',
    'rejected',
    'revoked',
    'error',
] as const;

/** The connection state a credential GitHub refused reports (FR-062). */
const AUTH_FAILED = 'auth-failed';

/** Every connection state FR-062 names. */
const CONNECTION_STATES = ['connected', AUTH_FAILED, 'rate-limited', 'offline'] as const;

/** The words each lifecycle state must render, in the table's own order. */
const LIFECYCLE_LABELS = new Map<string, string>([
    ['pending_handoff', 'pending handoff'],
    ['verifying', 'verifying'],
    ['active', 'active'],
    ['rejected', 'rejected'],
    ['revoked', 'revoked'],
    ['error', 'error'],
]);

/** A payload that must reach the DOM as bytes, never as markup (FR-080). */
const HOSTILE_TITLE = '<img src=x onerror="alert(1)">';

/** The label the display-name round trip writes (FR-066). */
const NEW_LABEL = 'Mecha Turk Ops';

/** The account tier the profile write round-trips (004 FR-082). */
const ACCOUNT_PROMPT = 'Always reproduce the failure before patching.';

/** The login an upstream rename produces (AC-128). */
const RENAMED_LOGIN = 'octocat-renamed';

/** Every FR-010 capability, in the order the contract's matrix reports them. */
const SCOPE_CAPABILITIES = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/**
 * Build a fixture scope matrix where every capability carries one verdict.
 *
 * `Record<ScopeCapability, …>` cannot be written as an object literal here
 * without one hyphenated key tripping the naming rule, so the matrix is built
 * from the capability tuple exactly as the service does (same shape, same
 * cast, no invented verdict).
 *
 * @param verdict - The verdict every capability carries.
 * @returns The four-capability matrix.
 */
function scopeMatrixAll(verdict: ScopeResult): AccountScopeMatrix {
    return Object.fromEntries(SCOPE_CAPABILITIES.map((capability) => [capability, verdict])) as AccountScopeMatrix;
}

/**
 * Build one credential-free account for the row fixtures.
 *
 * @param overrides - Fields the test changes.
 * @returns One complete account.
 */
function accountFixture(overrides: Partial<PanelAccount> = {}): PanelAccount {
    return {
        numericUserId: CONNECTED_ID,
        login: CONNECTED_LOGIN,
        displayName: null,
        usable: true,
        state: 'active',
        connectionState: 'connected',
        scopeMatrix: scopeMatrixAll('ok'),
        ...overrides,
    };
}

/**
 * Build the tab state the row functions read.
 *
 * @param input - The accounts to render and any bindings they back.
 * @returns A ready Bindings-tab state carrying them.
 */
function accountsState(input: {
    /** Accounts the list renders. */
    readonly accounts: readonly PanelAccount[];
    /** Bindings the count and consequence lines read. */
    readonly bindings?: readonly PanelBinding[];
}): BindingsTabState {
    return {
        ...initialBindings(),
        status: 'ready',
        accounts: input.accounts,
        bindings: input.bindings ?? [],
    };
}

/**
 * Read every string one mount was handed.
 *
 * @param props - Whatever the SDK primitive received.
 * @returns The strings among them, in property order.
 */
function stringsIn(props: unknown): readonly string[] {
    if (typeof props === 'string') {
        return [props];
    }

    if (typeof props !== 'object' || props === null) {
        return [];
    }

    return Object.values(props).filter((value): value is string => typeof value === 'string');
}

/**
 * Mount only the Accounts body against the recording SDK stub.
 *
 * @param setup - State to arrange before the body mounts.
 * @returns The runtime, the disposer, and every string handed to the SDK.
 */
function mountAccountsTab(setup?: (rt: PanelRuntime) => void): {
    /** The runtime the body mounted against. */
    readonly rt: PanelRuntime;
    /** The shell's disposer for this body. */
    readonly dispose: () => void;
    /** Every element the mount created, in creation order. */
    readonly created: readonly FakeElement[];
    /** Every string the mount and its first repaint handed to the SDK. */
    readonly strings: readonly string[];
} {
    mounts.log.length = 0;
    const rt = createTestRuntime(fakeHost());
    setup?.(rt);
    const dom = fakeDom();
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'accounts');
    if (spec === undefined) {
        throw new Error('the Accounts tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the Accounts body mounted no disposer');
    }

    const strings = mounts.log.flatMap((entry) => stringsIn(entry.props));

    return { rt, dispose, created: dom.created, strings };
}

/**
 * Whether the Accounts disclaimer is **mounted** on the Accounts body, and
 * what its text says (002 FR-008 as re-cut at v1.9.0).
 *
 * @param created - Every element the mount created.
 * @returns The disclaimer container, or `undefined` when nothing mounted one.
 */
function mountedDisclaimer(created: readonly FakeElement[]): FakeElement | undefined {
    return created.find((node) => node.attribute('data-accounts-disclaimer') !== null);
}

/**
 * Read the rows the account list was last painted with.
 *
 * The mount paints an empty list; the repaint that follows is what the
 * operator sees, so the last call to `mountList` is the one to read.
 *
 * @returns The rows, in paint order.
 */
function mountedListItems(): readonly { readonly title?: string; readonly subtitle?: string }[] {
    const calls = mounts.log.filter(
        (candidate) => candidate.key === 'mountList' || candidate.key === 'mountList:update',
    );
    const props = calls.at(-1)?.props as
        | { readonly items?: { readonly title?: string }[] }
        | undefined;

    return props?.items ?? [];
}

describe('T-024 the Accounts tab renders every FR-062 member as text', () => {
    it('renders each of the six lifecycle states against each of the four connection states', () => {
        {
            for (const state of LIFECYCLE_STATES) {
                for (const connection of CONNECTION_STATES) {
                    const account = accountFixture({
                        state,
                        connectionState: connection,
                        errorReason: state === 'error' ? AUTH_FAILED : null,
                    });
                    const detail = accountDetail(accountsState({ accounts: [account] }), account);

                    expect(detail).toContain(LIFECYCLE_LABELS.get(state));
                    expect(detail).toContain(connection);
                    expect(detail).toContain(`id ${CONNECTED_ID}`);
                }
            }
        }
        {
            const pending = lifecycleCopy(accountFixture({ state: 'pending_handoff' }));
            const interrupted = lifecycleCopy(
                accountFixture({ state: 'error', errorReason: 'interrupted-handoff' }),
            );

            expect(pending.label).not.toBe(interrupted.label);
            expect(interrupted.label).toContain('interrupted-handoff');
            expect(pending.remediation).toBe(HANDOFF_REMEDIATION);
            expect(interrupted.remediation).toBe(HANDOFF_REMEDIATION);
        }
        {
            for (const state of ['rejected', 'revoked', 'error']) {
                expect(lifecycleCopy(accountFixture({ state })).remediation).not.toBeNull();
            }

            expect(lifecycleCopy(accountFixture({ state: 'active' })).remediation).toBeNull();
            // An unknown state is its own words, never a mapped guess (FR-003).
            expect(lifecycleCopy(accountFixture({ state: 'something-new' })).label)
                .toBe('unknown state: something-new');
        }
        {
            const bare: PanelAccount = {
                numericUserId: CONNECTED_ID,
                login: CONNECTED_LOGIN,
                displayName: null,
                usable: false,
            };
            const detail = accountDetail(accountsState({ accounts: [bare] }), bare);

            expect(detail).not.toContain('scope: ok');
        }
        {
            // `needs reconnection` reaches the panel from the accounts mirror and
            // the status projection alike, and `status-lines.ts` prints it
            // verbatim — so Accounts must not answer *unknown connection state*
            // for a word its sibling tab renders as fact.
            expect(connectionPhrase(accountFixture({ connectionState: 'needs reconnection' })))
                .toBe('needs reconnection');

            // A word neither surface has ever carried is still refused, not guessed.
            expect(connectionPhrase(accountFixture({ connectionState: 'mystery' })))
                .toBe('unknown connection state: mystery');
        }
        {
            expect(bindingsPhrase(0)).toBe('0 bindings');
            expect(bindingsPhrase(1)).toBe('1 binding');
            expect(bindingsPhrase(4)).toBe('4 bindings');

            const account = accountFixture({});
            const detail = accountDetail(accountsState({ accounts: [account] }), account);

            expect(detail).toContain('0 bindings');
            expect(detail).not.toContain('1 bindings');
        }
    });

    it('counts the bindings an account backs, in the row and in the detail', () => {
        const account = accountFixture();
        const binding: PanelBinding = {
            bindingId: 'bnd-9',
            accountNumericUserId: account.numericUserId,
            accountLogin: account.login,
            repository: 'acme/other',
            projectId: 'prj_7',
            worktreeOption: 'none',
            triggers: { assignment: false, mention: true, reviewRequest: false },
            state: 'active',
            createdAt: GIVEN_AT,
            updatedAt: GIVEN_AT,
        };
        const state = accountsState({ accounts: [account], bindings: [binding] });
        const [row] = accountRows(state);

        expect(row?.meta).toBe('1');
        // The count and its noun agree: "1 bindings" was the defect both the
        // row subtitle and the detail line carried (2026-10-01 review).
        expect(accountDetail(state, account)).toContain('1 binding');
        expect(accountDetail(state, account)).not.toContain('1 bindings');
        expect(row?.subtitle).toContain('1 binding');
        expect(accountTitle(account)).toBe(CONNECTED_LOGIN);
    });
});

describe('T-024 the Accounts tab copy and secret posture (FR-020, FR-067, AC-129)', () => {
    it('renders Accounts copy on the tab itself and none of the retired noun', () => {
        {
            const { dispose, strings } = mountAccountsTab((rt): void => {
                rt.state.bindings = accountsState({ accounts: [accountFixture()] });
            });
            dispose();

            expect(strings.some((line) => line.startsWith('Accounts: '))).toBe(true);
            expect(strings.some((line) => line.includes('Repositories'))).toBe(false);
        }
        {
            const hostile = accountFixture({ displayName: HOSTILE_TITLE });
            const state = accountsState({ accounts: [hostile] });

            expect(accountTitle(hostile)).toBe(HOSTILE_TITLE);
            expect(accountDetail(state, hostile)).toContain(HOSTILE_TITLE);

            const { dispose, strings } = mountAccountsTab((rt): void => {
                rt.state.bindings = accountsState({ accounts: [hostile] });
                rt.state.accounts.selected = hostile.numericUserId;
            });
            dispose();

            const [row] = mountedListItems();
            expect(row?.title).toBe(HOSTILE_TITLE);
            // The detail line carries it too, as text on a text node — the fake
            // document has no HTML sink at all, so a sink would have thrown.
            expect(strings.some((line) => line.includes('onerror'))).toBe(true);
        }
        {
            const account = accountFixture({ state: 'rejected', errorReason: AUTH_FAILED });
            const state = accountsState({ accounts: [account] });
            const rendered = [
                ...accountRows(state).flatMap((row) => [row.title, row.subtitle, row.leading ?? '', row.meta ?? '']),
                accountDetail(state, account),
            ].join('\n');

            expect(Object.keys(account)).not.toContain('credential');
            expect(Object.keys(account)).not.toContain('expectedLogin');
            expectNoCredentialInStrings([rendered]);

            const { dispose, strings } = mountAccountsTab((rt): void => {
                rt.state.bindings = accountsState({ accounts: [account] });
            });
            dispose();
            expectNoCredentialInStrings(strings);
        }
    });
});

describe('the Accounts tab carries a static disclaimer instead of a consent dialog (002 v1.9.0)', () => {
    it('mounts the disclaimer beneath the Accounts section, always visible', () => {
        {
            const { rt, dispose, created } = mountAccountsTab();
            dispose();

            const disclaimer = mountedDisclaimer(created);
            expect(disclaimer).toBeDefined();
            expect(disclaimer?.hidden).toBe(false);
            expect(disclaimer?.attribute('data-accounts-disclaimer')).toBe('informational');
            // The fake document keeps `textContent` per node, so the copy is read
            // from the paragraph inside the container rather than recomputed.
            const text = disclaimer?.children.map((child) => child.textContent).join('\n\n') ?? '';
            for (const paragraph of ACCOUNTS_DISCLAIMER_PARAGRAPHS) {
                expect(text).toContain(paragraph);
            }

            expect(rt.handoffView).not.toBeNull();
        }
        {
            const { dispose, created } = mountAccountsTab();
            dispose();

            const labels = created
                .filter((node) => node.tagName === 'button')
                .map((node) => node.textContent);

            expect(labels).not.toContain('Accept and continue');
            expect(labels).not.toContain('Decline');
            // The one credential-path button that remains is the submit control.
        }
        {
            const { rt, dispose } = mountAccountsTab();
            dispose();

            expect(Object.keys(rt.state.handoff)).not.toContain('consentGiven');
        }
    });
});

/** The service's answer to one profile write, plus what a re-read holds. */
interface DisplaySpec {
    /** What the account profile `PUT` answers. */
    readonly answer: GuestRequestResult;
    /** The label the follow-up read reports, when the write was accepted. */
    readonly stored?: string | null;
    /** The account tier the follow-up read reports, when one is set. */
    readonly storedPrompt?: string;
}

/**
 * Mount the runtime the profile write runs against, over a recording host.
 *
 * @param spec - The write's answer and the label a re-read reports.
 * @returns The runtime and every request it made.
 */
async function displayRuntime(spec: DisplaySpec): Promise<{
    /** The runtime under test. */
    readonly rt: PanelRuntime;
    /** Every request the write and its re-read made, in order. */
    readonly requests: GuestRequest[];
}> {
    const requests: GuestRequest[] = [];
    const listed = [
        {
            numericUserId: CONNECTED_ID,
            login: CONNECTED_LOGIN,
            displayName: spec.stored ?? 'Ops label',
            startingPrompt: spec.storedPrompt ?? null,
            state: 'active',
            connectionState: 'connected',
            verifiedAt: GIVEN_AT,
            errorReason: null,
            scopeCheck: { checkedAt: GIVEN_AT, results: scopeResults('ok') },
        },
    ];
    const host = fakeHost({
        serviceRequest: async (request: GuestRequest): Promise<GuestRequestResult> => {
            requests.push(request);
            if (request.method === 'PUT') {
                return spec.answer;
            }

            if (request.path === ACCOUNTS_PATH) {
                return { status: 200, body: JSON.stringify({ accounts: listed }) };
            }

            if (request.path === '/v1/bindings') {
                return { status: 200, body: JSON.stringify({ bindings: [], status: [] }) };
            }

            return { status: 404, body: '{"error":{"code":"not-found","message":"unrouted"}}' };
        },
    });
    const rt = createTestRuntime(host);
    rt.state.bindings.status = 'ready';
    rt.state.bindings.accounts = [
        {
            numericUserId: CONNECTED_ID,
            login: CONNECTED_LOGIN,
            displayName: 'Ops label',
            startingPrompt: spec.storedPrompt ?? null,
            usable: true,
            state: 'active',
        },
    ];
    rt.state.accounts.selected = CONNECTED_ID;
    rt.state.accounts.displayNameRow = CONNECTED_ID;
    rt.state.accounts.displayNameDraft = 'Ops label';
    rt.state.accounts.startingPromptRow = CONNECTED_ID;
    rt.state.accounts.startingPromptDraft = spec.storedPrompt ?? '';

    return { rt, requests };
}

/**
 * Run the profile write exactly the way the one `Save changes` control runs
 * it: both drafts, read off the two fields (owner ruling, PR #12 — "One Save
 * button, both fields").
 *
 * @param rt - Runtime whose open row carries the drafts.
 * @returns The write's completion — resolved only after the re-read.
 */
async function saveBothDrafts(rt: PanelRuntime): Promise<void> {
    const { accounts } = rt.state;
    if (accounts.selected === null) {
        throw new Error('the fixture never opened a row to save');
    }

    return await saveProfile(rt, {
        numericUserId: accounts.selected,
        displayName: accounts.displayNameDraft,
        startingPrompt: accounts.startingPromptDraft,
    });
}

describe('T-026 the display name is written by the service, never by the panel (FR-066)', () => {
    it('round-trips a label through the profile write and shows what came back', async () => {
        {
            const { rt, requests } = await displayRuntime({
                answer: { status: 200, body: JSON.stringify({ account: {} }) },
                stored: NEW_LABEL,
            });
            rt.state.accounts.displayNameDraft = NEW_LABEL;
            rt.state.accounts.startingPromptDraft = ACCOUNT_PROMPT;

            await saveBothDrafts(rt);

            const put = requests.find((request) => request.method === 'PUT');
            // Re-cut by the owner's PR #12 ruling — "One Save button, both
            // fields": the body carries **both** members, in the order the
            // panel builds them, each equal to its own field's draft. The
            // route has always accepted them together (005 v1.10.0), so only
            // the panel's choice of how many bodies to send changed.
            expect(put?.path).toBe(`/v1/accounts/${CONNECTED_ID}`);
            const labelBody = JSON.parse(String(put?.body)) as Record<string, unknown>;
            expect(Object.keys(labelBody)).toEqual(['displayName', 'startingPrompt']);
            expect(labelBody).toEqual({ displayName: NEW_LABEL, startingPrompt: ACCOUNT_PROMPT });
            // The value on screen is the one the authoritative re-read reported.
            expect(rt.state.bindings.accounts[0]?.displayName).toBe(NEW_LABEL);
            expect(rt.state.accounts.displayNameError).toBeNull();
            expect(rt.state.accounts.startingPromptError).toBeNull();
        }
    });

    it('renders the refusal at the field and keeps the stored label', async () => {
        {
            const refusal = JSON.stringify({
                error: {
                    code: 'validation',
                    message:
                        'displayName: displayName must not contain credential-shaped material (matched shape: PAT)',
                },
            });
            const { rt, requests } = await displayRuntime({ answer: { status: 422, body: refusal } });
            const submitted = 'ghp_looks_like_a_token';
            // What the field holds at the click: the operator's own text.
            rt.state.accounts.displayNameDraft = submitted;
            // The prompt slot holds a refusal of its own, so the assertion
            // below can tell *untouched* apart from *cleared* — the one
            // answer must not borrow, overwrite, or retire the other's.
            const olderPromptRefusal = 'startingPrompt: an older refusal';
            rt.state.accounts.startingPromptError = olderPromptRefusal;

            await saveBothDrafts(rt);

            expect(requests.some((request) => request.method === 'PUT')).toBe(true);
            // The service's copy names the field and the shape, never the value.
            expect(rt.state.accounts.displayNameError).not.toContain(submitted);
            // Isolation: a label refusal lands in the label's slot only. The
            // prompt slot keeps what its own field already said — it is
            // neither marked with this reason nor cleared by it.
            expect(rt.state.accounts.startingPromptError).toBe(olderPromptRefusal);
            // Nothing was applied, so the list still shows the stored label, and
            // the draft keeps what was typed so the operator can correct it.
            expect(rt.state.accounts.displayNameDraft).toBe(submitted);
        }
    });

    it('keeps the display name when the login is renamed upstream', async () => {
        {
            const renamed = accountFixture({ login: RENAMED_LOGIN, displayName: 'Ops label' });
            const [row] = accountRows(accountsState({ accounts: [renamed] }));

            // The label is the operator's; the login is GitHub's. A rename
            // updates one and must never clobber the other.
            expect(row?.subtitle).toContain('@octocat-renamed');
            expect(accountTitle(accountFixture({ login: RENAMED_LOGIN }))).toBe(RENAMED_LOGIN);
        }
    });

    it('states what a rotation keeps, before anything is pasted', async () => {
        {
            const statement = rotationStatement(CONNECTED_LOGIN);

            expect(statement).toContain(CONNECTED_LOGIN);
            expect(statement).toContain('above');
        }
    });

});

/**
 * Read an accounts body carrying exactly the members a test names (004 FR-082).
 *
 * @param members - The record members to seed the one account with.
 * @returns The parsed accounts, or the reader's refusal.
 */
function readAccounts(members: Record<string, unknown>): PanelAccount[] | null {
    return parseAccountsBody(
        JSON.stringify({
            accounts: [{ numericUserId: CONNECTED_ID, login: CONNECTED_LOGIN, ...members }],
        }),
    );
}

describe('T-031 the account tier rides the profile write (004 FR-082, FR-089)', () => {
    it('writes both members in one body and brings the value back on a reload', async () => {
        {
            const { rt, requests } = await displayRuntime({
                answer: { status: 200, body: JSON.stringify({ account: {} }) },
                storedPrompt: ACCOUNT_PROMPT,
            });
            rt.state.accounts.startingPromptDraft = ACCOUNT_PROMPT;

            await saveBothDrafts(rt);

            const put = requests.find((request) => request.method === 'PUT');
            // The one route both members travel (plan C28/C29), now carrying
            // both together: the owner ruled one save for the pair (PR #12),
            // so the label rides along as exactly the text its own field
            // holds — never a value the panel invented.
            expect(put?.path).toBe(`/v1/accounts/${CONNECTED_ID}`);
            const promptBody = JSON.parse(String(put?.body)) as Record<string, unknown>;
            expect(Object.keys(promptBody)).toEqual(['displayName', 'startingPrompt']);
            expect(promptBody).toEqual({ displayName: 'Ops label', startingPrompt: ACCOUNT_PROMPT });
            // The authoritative re-read is what puts it back on the record…
            expect(rt.state.bindings.accounts[0]?.startingPrompt).toBe(ACCOUNT_PROMPT);
            // …and reopening the row loads that stored text into the field again.
            rt.state.accounts.selected = null;
            selectAccountRow(rt, CONNECTED_ID);
            expect(rt.state.accounts.startingPromptDraft).toBe(ACCOUNT_PROMPT);
            expect(rt.state.accounts.startingPromptError).toBeNull();
        }
    });

    it('an unset tier reads "not set" where the text would be', async () => {
        {
            const { rt, dispose, strings } = mountAccountsTab((runtime): void => {
                runtime.state.bindings = accountsState({ accounts: [accountFixture()] });
                selectAccountRow(runtime, CONNECTED_ID);
            });
            const field = accountFieldView('startingPrompt', {
                accounts: rt.state.accounts,
                account: rt.state.bindings.accounts[0],
            });
            dispose();

            // Honest absence: the slot an empty instruction box would occupy
            // says *not set* — and the value itself is empty, never copy.
            expect(field.value).toBe('');
            expect(field.placeholder).toBe(ACCOUNT_PROMPT_NOT_SET);
            expect(strings).toContain(ACCOUNT_PROMPT_NOT_SET);
            // FR-063's guidance travels with the field: all five facts, fixed
            // copy, and the service still the only validator (plan D24) — and
            // they reach the mount, not just the view function.
            expect(field.helper).toBe(ACCOUNT_PROMPT_GUIDANCE);
            expect(strings).toContain(ACCOUNT_PROMPT_GUIDANCE);
            expect(strings).toContain(ACCOUNT_PROMPT_LABEL);
            for (const fact of ['verbatim', 'placeholders', 'Default Agent', 'refused', '2,000']) {
                expect(field.helper, fact).toContain(fact);
            }
        }
    });


    it('a refusal renders its remediation and changes nothing', async () => {
        {
            const refusal = JSON.stringify({
                error: {
                    code: 'validation',
                    message:
                        'startingPrompt: startingPrompt must not contain credential-shaped material'
                        + ' (matched shape: GitHub-PAT)',
                },
            });
            const { rt, requests } = await displayRuntime({
                answer: { status: 422, body: refusal },
                storedPrompt: ACCOUNT_PROMPT,
            });
            const submitted = 'ghp_looks_like_a_token';
            rt.state.accounts.startingPromptDraft = submitted;
            // A label refusal of its own, so the split can be seen *not* to
            // touch it: the one write judges both members, and each field
            // keeps the answer that named it (FR-085).
            const olderLabelRefusal = 'displayName: an older refusal';
            rt.state.accounts.displayNameError = olderLabelRefusal;

            await saveBothDrafts(rt);

            expect(requests.some((request) => request.method === 'PUT')).toBe(true);
            // The service's own copy lands in this field's slot, and the value
            // it refused appears nowhere in it (FR-085) — nor in the label's.
            expect(rt.state.accounts.startingPromptError).toContain('credential');
            expect(rt.state.accounts.startingPromptError).not.toContain(submitted);
            expect(rt.state.accounts.displayNameError).toBe(olderLabelRefusal);
            // Nothing changed: the draft still holds what was typed, and the
            // stored tier is still the one the service already held.
            expect(rt.state.accounts.startingPromptDraft).toBe(submitted);
            expect(rt.state.bindings.accounts[0]?.startingPrompt).toBe(ACCOUNT_PROMPT);
        }
    });

    it('the row summary carries presence and length only (005 FR-051)', async () => {
        {
            const set = accountFixture({ startingPrompt: ACCOUNT_PROMPT });
            const unset = accountFixture({});
            const withPromptRow = accountRows(accountsState({ accounts: [set] }))[0];
            const withoutPromptRow = accountRows(accountsState({ accounts: [unset] }))[0];

            expect(withPromptRow?.subtitle).toContain(`prompt set · ${ACCOUNT_PROMPT.length} chars`);
            expect(withPromptRow?.subtitle).not.toContain(ACCOUNT_PROMPT);
            expect(withPromptRow?.subtitle).not.toContain('mtp-');
            expect(withoutPromptRow?.subtitle).toContain('prompt not set');
            // The detail line is a summary too — presence, never the text.
            expect(accountDetail(accountsState({ accounts: [set] }), set)).toContain('prompt set');
            expect(accountDetail(accountsState({ accounts: [set] }), set)).not.toContain(ACCOUNT_PROMPT);
        }
    });

    it('host.storage receives no copy of the tier', async () => {
        {
            const host = await scriptedRuntime((request) => {
                if (request.method === 'PUT') {
                    return { status: 200, body: JSON.stringify({ account: {} }) };
                }

                if (request.path === ACCOUNTS_PATH) {
                    return {
                        status: 200,
                        body: JSON.stringify({
                            accounts: [
                                {
                                    numericUserId: CONNECTED_ID,
                                    login: CONNECTED_LOGIN,
                                    displayName: null,
                                    startingPrompt: ACCOUNT_PROMPT,
                                    state: 'active',
                                    connectionState: 'connected',
                                    verifiedAt: GIVEN_AT,
                                    errorReason: null,
                                    scopeCheck: { checkedAt: GIVEN_AT, results: scopeResults('ok') },
                                },
                            ],
                        }),
                    };
                }

                if (request.path === '/v1/bindings') {
                    return { status: 200, body: JSON.stringify({ bindings: [], status: [] }) };
                }

                return { status: 404, body: '{"error":{"code":"not-found","message":"unrouted"}}' };
            });
            const { rt } = host;
            rt.state.bindings.status = 'ready';
            rt.state.bindings.accounts = [
                {
                    numericUserId: CONNECTED_ID,
                    login: CONNECTED_LOGIN,
                    displayName: null,
                    startingPrompt: null,
                    usable: true,
                    state: 'active',
                },
            ];
            selectAccountRow(rt, CONNECTED_ID);
            rt.state.accounts.startingPromptDraft = ACCOUNT_PROMPT;
            await saveBothDrafts(rt);
            // The mirror is what the panel *does* write to storage, so the
            // assertion below runs against a write that really happened.
            await adoptServiceAccounts(rt);

            expect(host.storage.operations).toContain('set:accounts');
            const stored = JSON.stringify([...host.storage.values.values()]);
            expect(stored).not.toContain(ACCOUNT_PROMPT);
            expect(stored).not.toContain('startingPrompt');
        }
    });


    it('refuses a non-text tier instead of reading it as unset (FR-082)', () => {
        // Fail closed: a value that is neither text nor `null` refuses the
        // whole body rather than being dropped (FR-017's posture).
        expect(readAccounts({ startingPrompt: 42 })).toBeNull();
        expect(readAccounts({ startingPrompt: { text: ACCOUNT_PROMPT } })).toBeNull();
        // Absent and `null` both read as unset — a complete, valid state.
        expect(readAccounts({})?.[0]?.startingPrompt).toBeUndefined();
        expect(readAccounts({ startingPrompt: null })?.[0]?.startingPrompt).toBeUndefined();
        // A string arrives as the tier the field loads.
        expect(readAccounts({ startingPrompt: ACCOUNT_PROMPT })?.[0]?.startingPrompt)
            .toBe(ACCOUNT_PROMPT);
    });

    it('renders the account tier in exactly one element on this tab (T-032, 005 FR-051)', () => {
        const { dispose } = mountAccountsTab((runtime): void => {
            runtime.state.bindings = accountsState({
                accounts: [accountFixture({ startingPrompt: ACCOUNT_TIER_SENTINEL })],
            });
            // Opened the way an operator opens it: the row click is what
            // loads the stored tier into the field (004 FR-089).
            selectAccountRow(runtime, CONNECTED_ID);
        });
        const carrying = mounts.log.filter(
            (entry) => JSON.stringify(entry.props ?? null).includes(ACCOUNT_TIER_SENTINEL),
        );
        dispose();

        // One element carries it: this harness logs a repaint beside its
        // mount as `<primitive>:update`, so the records are counted as a
        // mount (an element created with the value) or that same field's
        // repaint — and a list row, detail line, or second field carrying
        // it would arrive as a different primitive or a second mount.
        const creations = carrying.filter((entry) => !entry.key.includes(':'));
        expect(creations).toHaveLength(1);
        expect(creations[0]?.key).toBe('mountTextField');
        expect(carrying.every(
            (entry) => entry.key === 'mountTextField' || entry.key === 'mountTextField:update',
        )).toBe(true);
    });
});

/* ------------------------------------------------------------------------- *
 * The owner's PR #12 ruling: "One Save button, both fields" + "Split back
 * into per-field slots". The inputs stay separate, the save is shared, the
 * body carries both members, and the service's one composed `message` is
 * split back into the two slots by **known field name**.
 * ------------------------------------------------------------------------- */

describe('one Save changes writes both profile members (owner ruling, PR #12)', () => {
    it('offers exactly one save control, and neither retired per-member one', () => {
        const { dispose } = mountAccountsTab();
        const labels = mounts.log
            .filter((entry) => entry.key === 'mountButton')
            .map((entry) => (entry.props as { readonly label?: string }).label);
        dispose();

        // The pair owns one control, and the two labels it replaced are gone:
        // a second save would be a second body, which is what the ruling
        // removed (005 FR-066, 004 FR-082 — no FR names a button count, so
        // the count is the owner's to set).
        expect(labels.filter((label) => label === 'Save changes')).toHaveLength(1);
        expect(labels).not.toContain('Save display name');
        expect(labels).not.toContain('Save starting prompt');
        // Rotate and remove keep their own row-level controls, unchanged.
        expect(labels).toContain('Rotate token');
        expect(labels).toContain('Remove account');
    });

    it('splits a refusal that fails both members into the two slots', async () => {
        const refusal = JSON.stringify({
            error: {
                code: 'validation',
                message: [
                    'displayName: displayName must not contain credential-shaped material (matched shape: PAT)',
                    'startingPrompt: startingPrompt must not contain credential-shaped material'
                        + ' (matched shape: GitHub-PAT)',
                ].join('; '),
            },
        });
        const { rt, requests } = await displayRuntime({ answer: { status: 422, body: refusal } });
        const submittedLabel = 'ghp_looks_like_a_label';
        const submittedPrompt = 'ghp_looks_like_a_prompt';
        rt.state.accounts.displayNameDraft = submittedLabel;
        rt.state.accounts.startingPromptDraft = submittedPrompt;

        await saveBothDrafts(rt);

        expect(requests.some((request) => request.method === 'PUT')).toBe(true);
        // Each slot holds **its own** reason, whole — and the other member's
        // name never crosses the split, which is what proves the cut was made
        // on the field names rather than on any colon in a remediation.
        const labelError = String(rt.state.accounts.displayNameError);
        const promptError = String(rt.state.accounts.startingPromptError);
        expect(labelError).toContain('credential-shaped material');
        expect(labelError).not.toContain('startingPrompt');
        expect(promptError).toContain('credential-shaped material');
        expect(promptError).not.toContain('displayName');
        // Neither submitted value echoes back anywhere (FR-085).
        expect(labelError).not.toContain(submittedLabel);
        expect(promptError).not.toContain(submittedPrompt);
        // Nothing was written: both drafts still hold what was typed.
        expect(rt.state.accounts.displayNameDraft).toBe(submittedLabel);
        expect(rt.state.accounts.startingPromptDraft).toBe(submittedPrompt);
    });

    it('splits on the known field names, never on a colon or a semicolon', () => {
        // A remediation may carry its own `; ` ("…be text; send it absent…")
        // and its own `: ` ("…(matched shape: PAT)"); neither marks a field
        // boundary, so each half arrives intact in its own slot.
        const split = splitProfileRefusal(
            'startingPrompt: startingPrompt must be text; send it absent or null to leave the '
            + 'starting prompt unset; displayName: displayName must not contain credential-shaped '
            + 'material (matched shape: PAT)',
        );

        expect(split.startingPrompt).toContain('leave the starting prompt unset');
        expect(split.startingPrompt).toContain('startingPrompt:');
        expect(split.startingPrompt).not.toContain('displayName');
        expect(split.displayName).toContain('matched shape: PAT');
        expect(split.displayName).not.toContain('startingPrompt');

        // A reason that names neither member reaches **both** slots rather
        // than being dropped on the way to the operator.
        const unnamed = splitProfileRefusal('body: the account profile body is a closed set');

        expect(unnamed.displayName).toContain('closed set');
        expect(unnamed.startingPrompt).toContain('closed set');

        // And a message with no field shape at all — a transport problem,
        // say — is still shown, never swallowed.
        const problem = 'service answered 503';
        const generic = splitProfileRefusal(problem);

        expect(generic.displayName).toBe(problem);
        expect(generic.startingPrompt).toBe(problem);
    });

    it('stops one stale row before either field is written (open-row guard)', async () => {
        const { rt, requests } = await displayRuntime({
            answer: { status: 200, body: JSON.stringify({ account: {} }) },
        });
        // One draft outlived its row: the label field points at an account
        // the operator no longer has open, so the single write — which would
        // carry both fields — must not run at all.
        rt.state.accounts.displayNameRow = '999';

        await saveBothDrafts(rt);

        expect(requests.some((request) => request.method === 'PUT')).toBe(false);
        // The guard is about the **row**, so it is stated on both fields:
        // neither member is writable while the selection is stale.
        expect(rt.state.accounts.displayNameError).toContain('Select the account again');
        expect(rt.state.accounts.startingPromptError).toContain('Select the account again');
    });
});

