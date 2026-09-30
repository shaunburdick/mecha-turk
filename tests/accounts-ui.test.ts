/**
 * Rendering-contract tests for the one-shot handoff (task T-009,
 * token-handoff §1.1/§2 step ①, panel-service §3 invariant 11).
 *
 * The render step is a pure mapping from state onto a view, so these tests
 * drive it with the recording double: the consent copy must arrive verbatim,
 * the input must stay gated on consent **and** a writable pre-flight, and no
 * rendered string may carry a credential. The DOM adapter itself is checked
 * by a static scan — it must write through `textContent`/`setAttribute` only
 * and must pin `type="password"` with `autocomplete="new-password"` — and
 * (review F-E) that sink scan now covers **every** module under
 * `src`, not just the adapter.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { adoptServiceAccounts } from '../src/account-adoption.ts';
import {
    HANDOFF_REMEDIATION,
    accountDetail,
    accountRows,
    accountTitle,
    connectionPhrase,
    lifecycleCopy,
} from '../src/accounts-rows.ts';
import { bindingRows } from '../src/bindings-rows.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import {
    acceptConsentAndRepaint,
    handoffInputEnabled,
    refreshHandoff,
    renderHandoff,
} from '../src/accounts-ui.ts';
import {
    CONSENT_COPY_V1,
    CONSENT_STORAGE_KEY,
    CONSENT_VERSION,
    restoreStoredConsent,
} from '../src/consent.ts';
import { ACCOUNTS_STORAGE_KEY } from '../src/account-mirror.ts';
import type { ScopeResult } from '../src/account-mirror.ts';
import { STORAGE_REFUSAL } from '../src/handoff-copy.ts';
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
import { createStorageDouble, createTestRuntime, fakeHost } from './support/panel.ts';

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

/** Directory holding every panel module the widened scan reads (F-E). */
const SRC_DIR = resolve(import.meta.dirname, '../src');

/** Usage patterns of the HTML sinks contract §4 rule 5 forbids. */
const HTML_SINKS: readonly RegExp[] = [
    /\.innerHTML\b/,
    /insertAdjacentHTML\s*\(/,
    /\.outerHTML\b/,
    /\.insertAdjacentText\s*\(/,
    /\bdocument\.write\s*\(/,
];
/** Assert that a list of rendered strings carries no registered credential. */
function expectNoCredentialInStrings(strings: readonly string[]): void {
    expect(strings.join('\n')).not.toContain(PANEL_TOKEN);
}
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

    it('keeps every module of src on text-only sinks (F-E)', () => {
        const modules = readdirSync(SRC_DIR, { recursive: true })
            .map((entry) => String(entry))
            .filter((entry) => entry.endsWith('.ts'));

        // A scan that matched nothing would be reading the wrong directory.
        expect(modules.length).toBeGreaterThan(1);
        for (const relative of modules) {
            const source = readFileSync(join(SRC_DIR, relative), 'utf8');
            for (const sink of HTML_SINKS) {
                expect(source, `${relative} must not call ${sink.source}`).not.toMatch(sink);
            }
        }
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
        expect(host.record.consentShown).toBe(false);
        // The adoption rewrote the mirror the reinstall deleted, so the
        // next mount adopts from storage without touching the service.
        const mirrored = host.storage.values.get(ACCOUNTS_STORAGE_KEY);
        expect(mirrored).toBeDefined();
        expect(JSON.stringify(mirrored)).toContain(CONNECTED_ID);
    });
});

describe('accepting the consent step (MVP blocker: Accept did not stick)', () => {
    it('persists the mirror and hides the consent card after Accept', async () => {
        // No stored mirror: this install has not encountered the copy yet.
        const host = await scriptedRuntime(
            () => ({ status: 200, body: STATUS_BODY }),
            {},
        );

        await acceptConsentAndRepaint(host.rt);

        expect(host.storage.values.get(CONSENT_STORAGE_KEY)).toMatchObject({ version: CONSENT_VERSION });
        expect(host.rt.state.handoff.consentGiven).toBe(true);
        // Working storage: the card is gone for this mount and the mirror
        // the re-consent gate reads at submit time now exists.
        expect(host.record.consentShown).toBe(false);
        expect(host.record.note).toBe('');
    });

    it('keeps the consent card and names the storage refusal when the write fails', async () => {
        const storage = createStorageDouble({});
        const host = fakeHost({
            storage: {
                ...storage.storage,
                set: async () => {
                    throw new Error('storage offline');
                },
            },
        });
        const rt = createTestRuntime(host);
        const record = recordingView();
        rt.handoffView = record.view;

        await acceptConsentAndRepaint(rt);

        // Fail closed and show it: no mirror stored, no pretend-accepted
        // state, and the operator sees why the card is still there.
        expect(storage.values.has(CONSENT_STORAGE_KEY)).toBe(false);
        expect(rt.state.handoff.consentGiven).toBe(false);
        expect(record.consentShown).toBe(true);
        expect(record.note).toBe(STORAGE_REFUSAL);
        // The pasted-token gate stays shut without a stored mirror, so the
        // input can never appear while the consent step is unresolved.
        expect(handoffInputEnabled(rt.state.handoff)).toBe(false);
    });

    it('re-accepting after a refused write retries the mirror write', async () => {
        const storage = createStorageDouble({});
        let refused = true;
        const host = fakeHost({
            storage: {
                ...storage.storage,
                set: async (key, value) => {
                    if (refused) {
                        throw new Error('storage offline');
                    }
                    await storage.storage.set(key, value);
                },
            },
        });
        const rt = createTestRuntime(host);
        const record = recordingView();
        rt.handoffView = record.view;

        await acceptConsentAndRepaint(rt);
        expect(rt.state.handoff.consentGiven).toBe(false);

        refused = false;
        await acceptConsentAndRepaint(rt);

        expect(rt.state.handoff.consentGiven).toBe(true);
        expect(storage.values.get(CONSENT_STORAGE_KEY)).toMatchObject({ version: CONSENT_VERSION });
        expect(record.consentShown).toBe(false);
    });
});

describe('restoring accepted consent at mount (remount must not re-ask)', () => {
    it('sets consentGiven from the current stored mirror before the first repaint', async () => {
        const host = await scriptedRuntime(
            () => ({ status: 200, body: STATUS_BODY }),
            { [CONSENT_STORAGE_KEY]: { givenAt: GIVEN_AT, version: CONSENT_VERSION } },
        );

        await restoreStoredConsent(host.rt);
        refreshHandoff(host.rt);

        expect(host.rt.state.handoff.consentGiven).toBe(true);
        expect(host.record.consentShown).toBe(false);
    });

    it('treats a missing, stale, or unreadable mirror as no consent', async () => {
        const absent = createTestRuntime(fakeHost({ storage: createStorageDouble({}).storage }));
        await restoreStoredConsent(absent);
        expect(absent.state.handoff.consentGiven).toBe(false);

        const stale = createTestRuntime(
            fakeHost({
                storage: createStorageDouble({ [CONSENT_STORAGE_KEY]: { givenAt: GIVEN_AT, version: 0 } }).storage,
            }),
        );
        await restoreStoredConsent(stale);
        expect(stale.state.handoff.consentGiven).toBe(false);

        const broken = createTestRuntime(
            fakeHost({
                storage: {
                    get: async () => {
                        throw new Error('storage unavailable');
                    },
                    set: () => Promise.resolve(),
                    delete: () => Promise.resolve(),
                    keys: async () => [],
                },
            }),
        );
        await restoreStoredConsent(broken);
        expect(broken.state.handoff.consentGiven).toBe(false);

        // Repaint from the broken read: the card shows, with no crash.
        const record = recordingView();
        broken.handoffView = record.view;
        refreshHandoff(broken);
        expect(record.consentShown).toBe(true);
    });

    it('leaves the gate exactly as the stored mirror says, not the memory', async () => {
        // An in-memory "true" from a previous mount must not survive when the
        // stored mirror says otherwise — the mirror is the durable record.
        const host = await scriptedRuntime(
            () => ({ status: 200, body: STATUS_BODY }),
            {},
        );
        host.rt.state.handoff.consentGiven = true;

        await restoreStoredConsent(host.rt);

        expect(host.rt.state.handoff.consentGiven).toBe(false);
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

    return { rt, dispose, strings };
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
                expect(detail).toContain('scope: metadata ok');
            }
        }
    });

    it('tells pending_handoff apart from an interrupted handoff while sharing the way out (FR-068)', () => {
        const pending = lifecycleCopy(accountFixture({ state: 'pending_handoff' }));
        const interrupted = lifecycleCopy(
            accountFixture({ state: 'error', errorReason: 'interrupted-handoff' }),
        );

        expect(pending.label).not.toBe(interrupted.label);
        expect(pending.label).toContain('pending handoff');
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

        expect(detail).toContain('state not reported');
        expect(detail).toContain('connection not reported');
        expect(detail).toContain('scope: not checked');
        expect(connectionPhrase(bare)).toBe('connection not reported');
        expect(detail).not.toContain('scope: ok');
    });

    it('shows every binding an unusable account backs as unable to poll (FR-063)', () => {
        const binding: PanelBinding = {
            bindingId: 'bnd-1',
            accountNumericUserId: CONNECTED_ID,
            accountLogin: CONNECTED_LOGIN,
            repository: 'acme/widget',
            projectId: 'prj_42',
            worktreeOption: 'none',
            triggers: { assignment: true, mention: false, reviewRequest: false },
            state: 'active',
            createdAt: GIVEN_AT,
            updatedAt: GIVEN_AT,
        };
        const rows = bindingRows(accountsState({
            accounts: [accountFixture({ usable: false, state: 'revoked' })],
            bindings: [binding],
        }));

        expect(rows[0]?.subtitle).toContain('account cannot poll (revoked)');
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
        expect(accountDetail(state, account)).toContain('1 bindings');
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

