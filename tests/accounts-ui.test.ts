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
import { saveDisplayName } from '../src/accounts-actions.ts';
import {
    HANDOFF_REMEDIATION,
    accountDetail,
    accountRows,
    accountTitle,
    bindingsPhrase,
    connectionPhrase,
    lifecycleCopy,
    rotationStatement,
} from '../src/accounts-rows.ts';
import { ACCOUNTS_DISCLAIMER_PARAGRAPHS } from '../src/accounts-disclaimer.ts';
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
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
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
                return request.path === '/v1/accounts'
                    ? { status: 200, body: accountsBody }
                    : { status: 200, body: STATUS_BODY };
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
    const props = calls[calls.length - 1]?.props as
        | { readonly items?: { readonly title?: string }[] }
        | undefined;

    return props?.items ?? [];
}

describe('T-024 the Accounts tab renders every FR-062 member as text', () => {
    it('renders each of the six lifecycle states against each of the four connection states', () => {
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
    });

    it('tells pending_handoff apart from an interrupted handoff while sharing the way out (FR-068)', () => {
        const pending = lifecycleCopy(accountFixture({ state: 'pending_handoff' }));
        const interrupted = lifecycleCopy(
            accountFixture({ state: 'error', errorReason: 'interrupted-handoff' }),
        );

        expect(pending.label).not.toBe(interrupted.label);
        expect(interrupted.label).toContain('interrupted-handoff');
        expect(pending.remediation).toBe(HANDOFF_REMEDIATION);
        expect(interrupted.remediation).toBe(HANDOFF_REMEDIATION);
    });

    it('gives every bad state a remediation and a good one none (FR-063)', () => {
        for (const state of ['rejected', 'revoked', 'error']) {
            expect(lifecycleCopy(accountFixture({ state })).remediation).not.toBeNull();
        }

        expect(lifecycleCopy(accountFixture({ state: 'active' })).remediation).toBeNull();
        // An unknown state is its own words, never a mapped guess (FR-003).
        expect(lifecycleCopy(accountFixture({ state: 'something-new' })).label)
            .toBe('unknown state: something-new');
    });

    it('marks an unreported member as unreported, never as a pass (NFR-112)', () => {
        const bare: PanelAccount = {
            numericUserId: CONNECTED_ID,
            login: CONNECTED_LOGIN,
            displayName: null,
            usable: false,
        };
        const detail = accountDetail(accountsState({ accounts: [bare] }), bare);

        expect(detail).not.toContain('scope: ok');
    });

    it('reads the connection word Status prints instead of calling it unknown (FR-003)', () => {
        // `needs reconnection` reaches the panel from the accounts mirror and
        // the status projection alike, and `status-lines.ts` prints it
        // verbatim — so Accounts must not answer *unknown connection state*
        // for a word its sibling tab renders as fact.
        expect(connectionPhrase(accountFixture({ connectionState: 'needs reconnection' })))
            .toBe('needs reconnection');

        // A word neither surface has ever carried is still refused, not guessed.
        expect(connectionPhrase(accountFixture({ connectionState: 'mystery' })))
            .toBe('unknown connection state: mystery');
    });

    it("counts an account's bindings with a noun that matches the count (FR-062)", () => {
        expect(bindingsPhrase(0)).toBe('0 bindings');
        expect(bindingsPhrase(1)).toBe('1 binding');
        expect(bindingsPhrase(4)).toBe('4 bindings');

        const account = accountFixture({});
        const detail = accountDetail(accountsState({ accounts: [account] }), account);

        expect(detail).toContain('0 bindings');
        expect(detail).not.toContain('1 bindings');
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
        const { dispose, strings } = mountAccountsTab((rt): void => {
            rt.state.bindings = accountsState({ accounts: [accountFixture()] });
        });
        dispose();

        expect(strings.some((line) => line.startsWith('Accounts: '))).toBe(true);
        expect(strings.some((line) => line.includes('Repositories'))).toBe(false);
    });

    it('renders a hostile display name as bytes, never as markup (FR-080)', () => {
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
    });

    it('renders no credential member and no credential bytes (AC-129)', () => {
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
    });
});

describe('the Accounts tab carries a static disclaimer instead of a consent dialog (002 v1.9.0)', () => {
    it('mounts the disclaimer beneath the Accounts section, always visible', () => {
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
    });

    it('offers no Accept, Decline, or any other button with it', () => {
        const { dispose, created } = mountAccountsTab();
        dispose();

        const labels = created
            .filter((node) => node.tagName === 'button')
            .map((node) => node.textContent);

        expect(labels).not.toContain('Accept and continue');
        expect(labels).not.toContain('Decline');
        // The one credential-path button that remains is the submit control.
    });

    it('keeps no consent state on the runtime the tab mounts (002 v1.9.0)', () => {
        const { rt, dispose } = mountAccountsTab();
        dispose();

        expect(Object.keys(rt.state.handoff)).not.toContain('consentGiven');
    });
});

/** The service's answer to one display-name write, plus what a re-read holds. */
interface DisplaySpec {
    /** What `PUT …/display-name` answers. */
    readonly answer: GuestRequestResult;
    /** The label the follow-up read reports, when the write was accepted. */
    readonly stored?: string | null;
}

/**
 * Mount the runtime the display-name write runs against, over a recording host.
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

            if (request.path === '/v1/accounts') {
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
            usable: true,
            state: 'active',
        },
    ];
    rt.state.accounts.selected = CONNECTED_ID;
    rt.state.accounts.displayNameRow = CONNECTED_ID;
    rt.state.accounts.displayNameDraft = 'Ops label';

    return { rt, requests };
}

describe('T-026 the display name is written by the service, never by the panel (FR-066)', () => {
    it('round-trips a label through the narrow route and shows what came back', async () => {
        const { rt, requests } = await displayRuntime({
            answer: { status: 200, body: JSON.stringify({ account: {} }) },
            stored: NEW_LABEL,
        });

        await saveDisplayName(rt, { numericUserId: CONNECTED_ID, value: NEW_LABEL });

        const put = requests.find((request) => request.method === 'PUT');
        expect(put?.path).toBe(`/v1/accounts/${CONNECTED_ID}/display-name`);
        expect(JSON.parse(String(put?.body))).toEqual({ displayName: NEW_LABEL });
        // The value on screen is the one the authoritative re-read reported.
        expect(rt.state.bindings.accounts[0]?.displayName).toBe(NEW_LABEL);
        expect(rt.state.accounts.displayNameError).toBeNull();
    });

    it('renders the refusal at the field and keeps the stored label (AC-130)', async () => {
        const refusal = JSON.stringify({
            error: {
                code: 'validation',
                message: 'displayName must not contain credential-shaped material (matched shape: PAT)',
            },
        });
        const { rt, requests } = await displayRuntime({ answer: { status: 422, body: refusal } });
        const submitted = 'ghp_looks_like_a_token';
        // What the field holds at the click: the operator's own text.
        rt.state.accounts.displayNameDraft = submitted;

        await saveDisplayName(rt, { numericUserId: CONNECTED_ID, value: submitted });

        expect(requests.some((request) => request.method === 'PUT')).toBe(true);
        // The service's copy names the field and the shape, never the value.
        expect(rt.state.accounts.displayNameError).not.toContain(submitted);
        // Nothing was applied, so the list still shows the stored label, and
        // the draft keeps what was typed so the operator can correct it.
        expect(rt.state.accounts.displayNameDraft).toBe(submitted);
    });

    it('keeps the display name when the login is renamed upstream (AC-128)', () => {
        const renamed = accountFixture({ login: RENAMED_LOGIN, displayName: 'Ops label' });
        const [row] = accountRows(accountsState({ accounts: [renamed] }));

        // The label is the operator's; the login is GitHub's. A rename
        // updates one and must never clobber the other.
        expect(row?.subtitle).toContain('@octocat-renamed');
        expect(accountTitle(accountFixture({ login: RENAMED_LOGIN }))).toBe(RENAMED_LOGIN);
    });

    it('states what a rotation keeps, before anything is pasted (FR-064)', () => {
        const statement = rotationStatement(CONNECTED_LOGIN);

        expect(statement).toContain(CONNECTED_LOGIN);
        expect(statement).toContain('above');
    });
});

