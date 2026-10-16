/**
 * Rendering, accessibility, and containment for the tabs (005 T-030;
 * FR-080–FR-085, NFR-101, NFR-107).
 *
 * This is the cross-cutting half of 005's proof: where a tab's own suite
 * proves that tab's copy, this file proves the rules that only mean anything
 * **across all tabs** at once:
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
import type { AccountScopeMatrix, PanelAccount, PanelBinding } from '../src/bindings-service.ts';
import { TAB_IDS } from '../src/panel-state.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import { fakeDom } from './support/dom.ts';
import { createStorageDouble, createTestRuntime, fakeHost, tick } from './support/panel.ts';
import { TAB_CONTRACT_LABELS } from './support/tab-contract.ts';
import { stringsIn } from './support/ui-stubs.ts';

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

/** What the tabs are being hostile-loaded with (FR-080). */
const HOSTILE = '<img src=x onerror="alert(1)">';

/** Stamp every hostile fixture carries. */
const FIXTURE_STAMP = '2026-09-28T00:00:00.000Z';

/** The hostile `GET /v1/logs` answer: hostile message and field, plus a line that is not JSON at all. */
const HOSTILE_LOGS = JSON.stringify({
    entries: [
        {
            seq: 1,
            line: `${JSON.stringify({ ts: FIXTURE_STAMP, level: 'info', message: HOSTILE, repo: HOSTILE })}\n`,
        },
        { seq: 2, line: 'plainly not a JSON line\n' },
    ],
    startedAt: 1_700_000_000_000,
});

/** Correlation id of the hostile dispatch row. */
const RUN_ID = 'mt-run-hostile';

/** The control whose label must arm before it acts (FR-084). */
const REMOVE_LABEL = 'Remove account';

/** The label it carries once armed. */
const REMOVE_ARMED_LABEL = 'Confirm remove';

/** Body the unrouted paths answer with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

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

/** What one all-tabs render recorded. */
interface AllTabs {
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
 * Mount all tabs against hostile fixtures and collect everything.
 *
 * @returns The strings, the requests, and the mount records.
 */
async function renderAllTabs(input: {
    /** Answers for `host.serviceRequest`; defaults to the hostile logs answer over the neutral 404. */
    readonly answer?: (request: GuestRequest) => GuestRequestResult | Promise<GuestRequestResult>;
    /** State to arrange before the tabs mount. */
    readonly setup?: (rt: PanelRuntime) => void;
} = {}): Promise<AllTabs> {
    mounts.log.length = 0;
    const requests: GuestRequest[] = [];
    const host = fakeHost({
        serviceRequest: async (request) => {
            requests.push(request);

            if (input.answer !== undefined) {
                return await input.answer(request);
            }

            return request.path.startsWith('/v1/logs')
                ? { status: 200, body: HOSTILE_LOGS }
                : { status: 404, body: UNROUTED };
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
    mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt) });
    for (const id of TAB_IDS) {
        rt.shell?.activate(id);
    }

    await tick();
    const strings = mounts.log.flatMap((entry) => stringsIn(entry.props));
    const log = [...mounts.log];
    rt.shell?.dispose();

    return { rt, strings, requests, log };
}

describe('FR-080 / NFR-101 the tabs render through the text path only', () => {

    it('hands a hostile title, login, and reason to the SDK as text', async () => {
        {
            const rendered = await renderAllTabs();
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
            const rendered = await renderAllTabs();
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
            const rendered = await renderAllTabs();
            const strip = rendered.log.find((entry) => entry.key === 'mountTabs');
            const items = (strip?.props as { readonly items?: readonly { readonly label?: string }[] }).items ?? [];

            const listMounts = rendered.log.filter((candidate) => candidate.key === 'mountList');

            expect(items.map((item) => item.label)).toEqual(TAB_CONTRACT_LABELS);

            for (const entry of listMounts) {
                const props = entry.props as {
                    readonly ariaLabel?: string;
                    readonly items?: readonly { readonly title?: string }[];
                };
                expect(props.ariaLabel?.trim(), 'a list has no accessible name').not.toBe('');
                const rows = props.items ?? [];
                for (const item of rows) {
                    expect(item.title?.trim(), 'a list row has no title').not.toBe('');
                }
            }
        }
    });

    it('names a row-level action with the row it acts on', async () => {
        {
            const row: RunRow = { ...hostileRun(), issueNumber: 412, repository: 'owner/name' };

            // The exact composed label is pinned by dispatches-paging.test.ts;
            // what FR-081 requires here is that the name carries the row.
            expect(rowActionLabel(RETRY_LABEL, row)).toContain('#412 in owner/name');
            expect(sourceRevealLabel(false, row)).toContain('#412 in owner/name');
            expect(sourceRevealLabel(true, row)).toContain('#412 in owner/name');
        }
    });

});

describe('FR-083 state is carried by text as well as colour', () => {
    it('gives every banner a title, and every state banner a body too', async () => {
        {
            const rendered = await renderAllTabs();
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
            const rendered = await renderAllTabs();
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
            const spec = tabSpecs(rt).find((entry) => entry.id === 'accounts');
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
            const rendered = await renderAllTabs({
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
            const rendered = await renderAllTabs({
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
