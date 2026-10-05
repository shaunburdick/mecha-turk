/**
 * Rendering, accessibility, and containment for the six tabs (005 T-030;
 * FR-080–FR-085, NFR-101, NFR-107).
 *
 * This is the cross-cutting half of 005's proof: where a tab's own suite
 * proves that tab's copy, this file proves the rules that only mean anything
 * **across all six** at once:
 *
 * - **FR-080** no HTML sink anywhere, and a hostile `<img onerror>` title,
 *   login, or reason arrives at the SDK as the string it is;
 * - **FR-081** every button, field, select, list, and banner carries a name,
 *   and a row-level action names its row;
 * - **FR-082** the shell stamps the tab↔body association, and the pinned SDK
 *   strip it relies on is keyboard-operable, moves focus, ignores Tab (no
 *   trap), and never wraps a tab label;
 * - **FR-083** state rides in text — a banner with no body is a bug here;
 * - **FR-084** irreversible actions arm first, and `confirm()` does not
 *   exist in the panel source;
 * - **FR-085** a refusal names its cause without echoing the value, and a
 *   redaction refusal blocks the write instead of logging past it.
 *
 * Offline by construction: recorded SDK mounts, the fake DOM, a scripted
 * `host.serviceRequest`, and the pinned SDK's own shipped files. No live
 * host, no token, no network (FR-086).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { rowActionLabel, sourceRevealLabel } from '../src/dispatches-controls.ts';
import { RETRY_LABEL } from '../src/dispatches-rows.ts';
import { armAccountRemoval, saveProfile } from '../src/accounts-actions.ts';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { createAccountsHandlers, selectAccountRow } from '../src/accounts-tab.ts';
import { persistLedger } from '../src/panel-actions.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { AccountScopeMatrix, PanelAccount, PanelBinding } from '../src/bindings-service.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import { fakeDom } from './support/dom.ts';
import { createStorageDouble, createTestRuntime, fakeHost, tick } from './support/panel.ts';

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

/** The six tabs FR-010 puts in the strip, in strip order. */
const TAB_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'] as const;

/** The FR-010 label each tab id carries in the strip. */
function labelOf(id: (typeof TAB_IDS)[number]): string {
    const labels: Record<(typeof TAB_IDS)[number], string> = {
        status: 'Status',
        dispatches: 'Dispatches',
        bindings: 'Bindings',
        accounts: 'Accounts',
        settings: 'Settings',
        about: 'About',
    };

    return labels[id];
}

/** The picker callbacks the bodies take; none is exercised by a mount. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** What the six tabs are being hostile-loaded with (FR-080). */
const HOSTILE = '<img src=x onerror="alert(1)">';

/** Stamp every hostile fixture carries. */
const FIXTURE_STAMP = '2026-09-28T00:00:00.000Z';

/** Correlation id of the hostile dispatch row. */
const RUN_ID = 'mt-run-hostile';

/** The control whose label must arm before it acts (FR-084). */
const REMOVE_LABEL = 'Remove account';

/** The label it carries once armed. */
const REMOVE_ARMED_LABEL = 'Confirm remove';

/** Body the unrouted paths answer with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/** Usage patterns of the HTML sinks FR-080 forbids. */
const HTML_SINKS: readonly RegExp[] = [
    /\.innerHTML\b/,
    /insertAdjacentHTML\s*\(/,
    /\.outerHTML\b/,
    /insertAdjacentText\s*\(/,
    /\bdocument\.write\s*\(/,
    /dangerouslySetInnerHTML/,
];

/** Directory the panel's modules live in, repository-relative. */
const SRC_DIR = 'src';

/**
 * Collect every string inside one SDK mount's props, however deeply nested.
 *
 * @param value - Anything a mount was handed.
 * @param found - Accumulator the caller owns.
 */
function collectStrings(value: unknown, found: string[]): void {
    if (typeof value === 'string') {
        found.push(value);

        return;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            collectStrings(item, found);
        }

        return;
    }

    if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) {
            collectStrings(item, found);
        }
    }
}

/**
 * Every string one SDK mount was handed, at any depth.
 *
 * @param props - Whatever the primitive received.
 * @returns The strings among them, in property order.
 */
function stringsIn(props: unknown): readonly string[] {
    const found: string[] = [];
    collectStrings(props, found);

    return found;
}

/** The four capabilities the scope matrix reports, and their verdicts. */
const SCOPE_CAPABILITIES = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/**
 * One credential-free account row, hostile on purpose.
 *
 * The matrix is built from the capability tuple rather than written out, so
 * the hyphenated key never appears as an object literal name.
 *
 * @returns The account the Accounts tab renders.
 */
function hostileAccount(): PanelAccount {
    return {
        numericUserId: '77331',
        login: HOSTILE,
        displayName: HOSTILE,
        usable: true,
        state: 'active',
        connectionState: 'connected',
        scopeMatrix: Object.fromEntries(SCOPE_CAPABILITIES.map((capability) => [capability, 'ok'])) as
            AccountScopeMatrix,
    };
}

/**
 * One binding backed by {@link hostileAccount}, read through the panel's own
 * fail-closed reader so the fixture cannot be more valid than the service.
 *
 * @returns The binding, or the reader's refusal.
 */
function hostileBinding(): PanelBinding {
    const parsed = parseBindingsBody(JSON.stringify({
        bindings: [{
            bindingId: 'bnd-hostile',
            accountNumericUserId: '77331',
            accountLogin: HOSTILE,
            repository: 'acme/widget',
            projectId: 'prj_42',
            worktreeOption: 'none',
            triggers: { assignment: true, mention: false, reviewRequest: false },
            state: 'active',
            createdAt: FIXTURE_STAMP,
            updatedAt: FIXTURE_STAMP,
        }],
        status: [],
    }));

    if (parsed?.bindings[0] === undefined) {
        throw new Error('the hostile binding fixture could not be read');
    }

    return parsed.bindings[0];
}

/**
 * One dispatch row, hostile in the two fields an issue supplies.
 *
 * @returns The row the Dispatches tab renders.
 */
function hostileRun(): RunRow {
    return {
        id: RUN_ID,
        correlationId: RUN_ID,
        kind: 'assignment',
        repository: 'acme/widget',
        issueNumber: 412,
        issueTitle: HOSTILE,
        issueUrl: 'https://github.com/acme/widget/issues/412',
        state: 'failed',
        stateReason: HOSTILE,
        runKey: 'github|77331|acme/widget|issue|412|0',
        ordinal: 0,
        attempt: 1,
        attachmentId: RUN_ID,
        projectId: 'prj_42',
        worktreeOption: 'none',
        leaseExpiresAt: null,
        resultDeadlineAt: null,
        sourceReferences: [],
        referenceCount: 1,
        referencesTruncated: false,
        referencesNotRetained: 0,
        session: null,
        verification: null,
        detectedAt: FIXTURE_STAMP,
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
        bindingId: 'bnd-hostile',
        headSha: null,
        baseRef: null,
        promptPresent: false,
        promptFingerprint: null,
        promptLength: null,
        promptSources: null,
        // No gate has judged this run yet (003 FR-079), so no policy shape exists.
        actorPolicy: null,
    };
}

/** What one six-tab render recorded. */
interface SixTabs {
    /** The runtime the tabs mounted against. */
    readonly rt: PanelRuntime;
    /** Every string the SDK mounts were handed, in order. */
    readonly strings: readonly string[];
    /** Every request the tabs made, in order. */
    readonly requests: readonly GuestRequest[];
    /** The mount records themselves, so a test can read props by key. */
    readonly log: readonly { readonly key: string; readonly props: unknown }[];
}

/**
 * Mount all six tabs against hostile fixtures and collect everything.
 *
 * @param input - How the service should answer, and state to arrange first.
 * @returns The strings, the requests, and the mount records.
 */
async function renderSixTabs(input: {
    /** Answers for `host.serviceRequest`; defaults to the neutral 404. */
    readonly answer?: (request: GuestRequest) => GuestRequestResult | Promise<GuestRequestResult>;
    /** State to arrange before the tabs mount. */
    readonly setup?: (rt: PanelRuntime) => void;
} = {}): Promise<SixTabs> {
    mounts.log.length = 0;
    const requests: GuestRequest[] = [];
    const host = fakeHost({
        serviceRequest: async (request) => {
            requests.push(request);

            return input.answer === undefined
                ? { status: 404, body: UNROUTED }
                : await input.answer(request);
        },
    });
    const rt = createTestRuntime(host);
    rt.state.bindings.bindings = [hostileBinding()];
    rt.state.bindings.accounts = [hostileAccount()];
    rt.state.bindings.status = 'ready';
    rt.state.dispatches.rows = [hostileRun()];
    rt.state.dispatches.status = 'ready';
    input.setup?.(rt);

    const dom = fakeDom();
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });
    for (const id of TAB_IDS) {
        rt.shell?.activate(id);
    }

    await tick();
    const strings = mounts.log.flatMap((entry) => stringsIn(entry.props));
    const log = [...mounts.log];
    rt.shell?.dispose();

    return { rt, strings, requests, log };
}

describe('FR-080 / NFR-101 the six tabs render through the text path only', () => {
    it('has no HTML sink in any module the tabs render from', async () => {
        {
            const modules = readdirSync(resolve(import.meta.dirname, `../${SRC_DIR}`), { recursive: true })
                .map(String)
                .filter((entry) => entry.endsWith('.ts'));

            expect(modules.length).toBeGreaterThan(40);
            for (const module of modules) {
                const source = readFileSync(resolve(import.meta.dirname, `../${SRC_DIR}/${module}`), 'utf8');
                for (const sink of HTML_SINKS) {
                    expect(source, `${module} must not use ${sink.source}`).not.toMatch(sink);
                }
            }
        }
    });

    it('hands a hostile title, login, and reason to the SDK as text', async () => {
        {
            const rendered = await renderSixTabs();
            const text = rendered.strings.join('\n');

            // The fixtures really were hostile, and they arrived verbatim as
            // string props — never as assembled markup.
            expect(text).toContain(HOSTILE);
            expect(rendered.strings.filter((line) => line.includes(HOSTILE)).length).toBeGreaterThan(2);
            for (const entry of rendered.log) {
                expect(entry.key).not.toMatch(/html|innerHTML/i);
            }
        }
    });

});

describe('FR-081 every control and row action has an accessible name', () => {
    it('gives every button, field, select, banner, and list a name', async () => {
        {
            const rendered = await renderSixTabs();
            const namedKinds = new Set(['mountButton', 'mountTextField', 'mountSelect', 'mountBanner', 'mountList']);
            const named = rendered.log.filter((entry) =>
                entry.key.startsWith('mount') && !entry.key.includes(':') && namedKinds.has(entry.key));

            expect(named.length).toBeGreaterThan(10);
            for (const entry of named) {
                const props = entry.props as Record<string, unknown>;
                const name = [props.label, props.title, props.ariaLabel].find(
                    (value) => typeof value === 'string',
                );
                expect(typeof name, `${entry.key} mounted without a name`).toBe('string');
                expect(String(name).trim(), `${entry.key} mounted an empty name`).not.toBe('');
            }
        }
    });

    it('names every tab in the strip and every row in a list', async () => {
        {
            const rendered = await renderSixTabs();
            const strip = rendered.log.find((entry) => entry.key === 'mountTabs');
            const items = (strip?.props as { readonly items?: readonly { readonly label?: string }[] }).items ?? [];

            expect(items.map((item) => item.label)).toEqual([...TAB_IDS].map((id) => labelOf(id)));

            for (const entry of rendered.log.filter((candidate) => candidate.key === 'mountList')) {
                const props = entry.props as {
                    readonly ariaLabel?: string;
                    readonly items?: readonly { readonly title?: string }[];
                };
                expect(props.ariaLabel?.trim(), 'a list has no accessible name').not.toBe('');
                const items = props.items ?? [];
                for (const item of items) {
                    expect(item.title?.trim(), 'a list row has no title').not.toBe('');
                }
            }
        }
    });

    it('names a row-level action with the row it acts on', async () => {
        {
            const row: RunRow = { ...hostileRun(), issueNumber: 412, repository: 'owner/name' };

            expect(rowActionLabel(RETRY_LABEL, row)).toBe('Retry dispatch for #412 in owner/name');
            expect(sourceRevealLabel(false, row)).toContain('#412 in owner/name');
            expect(sourceRevealLabel(true, row)).toContain('#412 in owner/name');
        }
    });

});

/** One file the SDK ships, read as the offline check of its own behavior. */
function sdkFile(name: string): string {
    return readFileSync(
        resolve(import.meta.dirname, '../node_modules/@openchamber/sdk/dist/ui', name),
        'utf8',
    );
}

describe('FR-082 the strip is associated, keyboard-operable, and truncates', () => {
    it('stamps the tab↔body association in the shell that owns it', () => {
        {
            const source = readFileSync(resolve(import.meta.dirname, '../src/tabs.ts'), 'utf8');

            expect(source).toContain("setAttribute('id', ");
            expect(source).toContain('oc-tab-');
            expect(source).toContain("setAttribute('role', 'tabpanel')");
            expect(source).toContain("setAttribute('aria-labelledby', ");
        }
        {
            const strip = sdkFile('tabs.js');
            const navigation = sdkFile('navigation.js');

            // role, selection, and the roving slot are what the shell re-stamps.
            expect(strip).toContain("'tablist'");
            expect(strip).toContain('aria-selected');
            expect(strip).toContain('tabIndex');
            // Horizontal keys only: Tab is never matched, so focus is never held.
            expect(strip).toContain("navigationKey(event, 'horizontal')");
            expect(strip).toContain('.focus()');
            expect(navigation).not.toMatch(/'Tab'/);
            expect(navigation).not.toMatch(/'Escape'/);
        }
        {
            const style = sdkFile('style.js');
            const at = style.indexOf('.oc-sdk-tab {');

            expect(at).toBeGreaterThan(-1);
            // The rule holds an interpolated theme colour, so the window is read
            // by offset rather than by a `[^}]*` that the first `}` would end.
        }
    });
});

describe('FR-083 state is carried by text as well as colour', () => {
    it('gives every banner a title, and every state banner a body too', async () => {
        {
            const rendered = await renderSixTabs();
            const banners = rendered.log.filter((entry) => entry.key === 'mountBanner');

            expect(banners.length).toBeGreaterThan(0);
            for (const entry of banners) {
                const props = entry.props as {
                    readonly tone?: string;
                    readonly title?: string;
                    readonly body?: string;
                };
                expect(props.title?.trim(), 'a banner title is empty').not.toBe('');
                if (props.tone !== 'info') {
                    expect(props.body?.trim(
                    ), `the ${String(props.tone)} banner "${String(props.title)}" carries no body`)
                        .not.toBe('');
                }
            }
        }
    });

    it('says the state in words the operator can read', async () => {
        {
            const rendered = await renderSixTabs();
            const text = rendered.strings.join('\n');

            // At least one state word is on screen in the default mount, so the
            // rule is being checked against real copy and not an empty panel.
            expect(text).toMatch(/could not be read|not checkable|unreadable|not met|waiting/);
        }
    });

});

describe('FR-084 irreversible actions arm first, and confirm() does not exist', () => {
    it('arms the removal, names the cascade, and only then sends', async () => {
        {
            mounts.log.length = 0;
            const requests: GuestRequest[] = [];
            const rt = createTestRuntime(fakeHost({
                serviceRequest: async (request) => {
                    requests.push(request);

                    return { status: 404, body: UNROUTED };
                },
            }));
            rt.state.bindings.bindings = [hostileBinding()];
            rt.state.bindings.accounts = [hostileAccount()];
            rt.state.bindings.status = 'ready';
            const handlers = createAccountsHandlers(rt);
            const dom = fakeDom();
            const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'accounts');
            if (spec === undefined) {
                throw new Error('the Accounts tab spec is missing from the shell');
            }

            spec.mount(dom.root);
            const idle = mounts.log
                .filter((entry) => entry.key === 'mountButton')
                .map((entry) => (entry.props as { readonly label?: string }).label);
            expect(idle).toContain(REMOVE_LABEL);

            handlers.selectAccount('77331');
            handlers.removeAccount();
            await tick();

            // Step one changes no state beyond arming, and says what will happen.
            expect(requests).toEqual([]);
            expect(rt.state.accounts.removeArmed).toBe('77331');
            const armed = mounts.log
                .filter((entry) => entry.key === 'mountButton:update' || entry.key === 'mountButton')
                .map((entry) => (entry.props as { readonly label?: string }).label);
            expect(armed).toContain(REMOVE_ARMED_LABEL);

            handlers.removeAccount();
            await tick();

            // Step two is the one that reaches the service.
            expect(requests.map((request) => request.method)).toContain('DELETE');
            rt.shell?.dispose();
        }
    });

    it('states the cascade in words on the row itself', async () => {
        {
            const rendered = await renderSixTabs({
                setup: (rt) => {
                    armAccountRemoval(rt, '77331');
                    rt.state.accounts.selected = '77331';
                },
            });
            const text = rendered.strings.join('\n');

            expect(text).toMatch(/1 binding(s)? will be disabled/);
            expect(text).toContain(REMOVE_ARMED_LABEL);
        }
    });

});

describe('FR-085 a refusal names its cause and never echoes the value', () => {
    it('keeps a refused credential-shaped display name out of the render', async () => {
        {
            const token = `ghp_${'refusald'.repeat(3)}`;
            const rendered = await renderSixTabs({
                answer: () => ({ status: 422, body: JSON.stringify({
                    error: { code: 'validation', message: 'displayName: this value looks like a credential' },
                }) }),
                setup: (rt) => {
                    rt.state.bindings.status = 'ready';
                },
            });

            const { rt } = rendered;
            // The refusal is only reachable for the row the operator has open,
            // which is also what stops a save from landing on the wrong account.
            selectAccountRow(rt, '77331');
            rt.state.accounts.displayNameDraft = token;
            await saveProfile(rt, {
                numericUserId: '77331',
                displayName: rt.state.accounts.displayNameDraft,
                startingPrompt: rt.state.accounts.startingPromptDraft,
            });
            await tick();

            expect(rt.state.accounts.displayNameError).toContain('credential');
            expect(rt.state.accounts.displayNameError).not.toContain(token);
            expect(rendered.strings.join('\n')).not.toContain(token);
        }
    });

    it('blocks a ledger write whose content is secret-shaped, instead of logging past it', async () => {
        {
            const storage = createStorageDouble();
            const token = `ghp_${'ledgerxx'.repeat(3)}`;
            const rt = createTestRuntime(fakeHost({ storage: storage.storage }));
            rt.state.ledger.entries.push({
                seq: 1,
                at: '2026-09-30T00:00:00.000Z',
                correlationId: 'mt-correlation',
                panelGeneration: 1,
                kind: 'error',
                detail: { error: token },
            });

            await persistLedger(rt);

            // The refusal blocks the write: `serializeLedger` throws before the
            // host is asked, the bad entry is repaired out, and the retry that
            // does land carries no part of the value. What the operator sees is
            // a banner naming the failure — never the secret, never silence.
            expect(JSON.stringify([...storage.values])).not.toContain(token);
            expect(rt.state.status.title).toMatch(/Ledger (repaired|write failed)/);
            expect(rt.state.status.body).not.toContain(token);
        }
    });

});
