/**
 * The prerequisites section's states, its notice, and the honesty rules the
 * spec pins on them (003 FR-071–FR-073, AC-122; 002 FR-038).
 *
 * Everything here derives from panel state, so the suite drives it with the
 * fake host and a literal account/binding set: no live OpenChamber, no PAT,
 * no network, no timers. The last describe is the compatibility scan — this
 * section must add no host capability (NFR-110, AGENTS invariant 3).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    PREREQUISITES_HEADING,
    derivePrerequisites,
    mountPrerequisiteNotice,
    prerequisiteLine,
    prerequisiteNotice,
    prerequisiteStateLabel,
    repaintPrerequisites,
} from '../src/prerequisites.ts';
import { parseAccountsBody } from '../src/bindings-service.ts';
import type { PanelBinding } from '../src/bindings-service.ts';
import type { PanelState } from '../src/panel-state.ts';
import type { Prerequisite, PrerequisiteId } from '../src/prerequisites.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeElement } from './support/dom.ts';

/**
 * The SDK's two mounts, replaced through `vi.mock` rather than through a seam
 * in the production API (the same trade `tests/tabs.test.ts` makes for
 * `mountTabs`): the real primitives call the global `document`, which the
 * Node suite does not have, and the notice's `hidden` flag is exactly what the
 * unmet-item regression has to observe. These doubles model only the
 * `Handle` contract — `update` repaints one text node, `dispose` removes it.
 */
vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual: Record<string, unknown> = await importOriginal();

    /** Structural view of the fake root the mounts append into. */
    interface MountRoot {
        readonly ownerDocument: { createElement(tagName: string): FakeElement };
        append(...nodes: FakeElement[]): void;
    }

    return {
        ...actual,
        mountBanner: (
            root: MountRoot,
            initial: { readonly title: string; readonly body?: string },
        ): { update: (next: { readonly title?: string; readonly body?: string }) => void; dispose: () => void } => {
            const node = root.ownerDocument.createElement('div');
            let { title } = initial;
            let body = initial.body ?? '';
            const paint = (): void => {
                node.textContent = `${title} — ${body}`;
            };
            paint();
            root.append(node);

            return {
                update: (next) => {
                    title = next.title ?? title;
                    body = next.body ?? body;
                    paint();
                },
                dispose: () => {
                    node.remove();
                },
            };
        },
        mountText: (
            root: MountRoot,
            initial: { readonly text: string },
        ): { update: (next: { readonly text?: string }) => void; dispose: () => void } => {
            const node = root.ownerDocument.createElement('p');
            let { text } = initial;
            node.textContent = text;
            root.append(node);

            return {
                update: (next) => {
                    text = next.text ?? text;
                    node.textContent = text;
                },
                dispose: () => {
                    node.remove();
                },
            };
        },
    };
});

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/**
 * Every literal the fixtures repeat, written once: the duplicate counter runs
 * over test files too, and a fixture id read three times is still one string.
 */
const IDS = {
    defaultAgent: 'default-agent',
    openchamberRunning: 'openchamber-running',
    desktopOrWeb: 'desktop-or-web',
    tokenScopes: 'token-scopes',
    registeredProject: 'registered-project',
} as const;

/** The three states FR-072 allows. */
const MET = 'met';
const NOT_MET = 'not-met';
const NOT_CHECKABLE = 'not-checkable';
const ALLOWED_STATES = [MET, NOT_MET, NOT_CHECKABLE] as const;

/** The token-scope prerequisite's title, which the notice copy carries verbatim. */
const SCOPES_TITLE = 'GitHub token scopes';

/** The five identifiers FR-071 names after 005 v1.7.0, in render order. */
const PREREQUISITE_IDS: readonly PrerequisiteId[] = [
    IDS.defaultAgent,
    IDS.openchamberRunning,
    IDS.desktopOrWeb,
    IDS.tokenScopes,
    IDS.registeredProject,
];

/** The account the fixtures bind and connect. */
const ACCOUNT_ID = '77331';
const ACCOUNT_LOGIN = 'acme-bot';

/** The account the scope fixtures parse out of a service body. */
const PARSED_ID = '1';
const PARSED_LOGIN = 'octocat';

/** Lifecycle state the accounts DTO reports for a connected account. */
const ACTIVE = 'active';

/** RFC 3339 stamp every fixture record carries. */
const FIXTURE_STAMP = '2026-09-29T12:00:00.000Z';

/** FR-010 verdicts as the service records them. */
const VERDICT_OK = 'ok';
const VERDICT_MISSING = 'missing';

/** FR-010 capabilities, in the order the matrix declares them. */
const CAPABILITIES = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/** Host methods a panel module could reach for; none may appear here. */
const HOST_METHODS: readonly string[] = [
    'serviceRequest(',
    'startSession(',
    'openSession(',
    'listProjects(',
    'listWorktrees(',
    'listSessions(',
    'writeClipboard(',
    'openUrl(',
];

/**
 * A fresh install's panel state: no settings snapshot, no accounts, and no
 * bindings.
 *
 * @returns The runtime state the derivation reads.
 */
function freshState(): PanelState {
    return createTestRuntime(fakeHost()).state;
}

/**
 * One binding, under the project it resolves to (or an empty id for a binding
 * the service would hold in its recoverable `project_missing` state).
 *
 * @param projectId - Project the binding dispatches into.
 * @returns The binding record the section reads.
 */
function bindingWith(projectId: string): PanelBinding {
    return {
        bindingId: 'bnd-1',
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: 'acme/widget',
        projectId,
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: true },
        state: ACTIVE,
        createdAt: FIXTURE_STAMP,
        updatedAt: FIXTURE_STAMP,
    };
}

/**
 * A configured install's panel state: host answered, one connected account
 * with a readable matrix, and one bound repository under its project.
 *
 * @returns The runtime state the derivation reads.
 */
function configuredState(): PanelState {
    const state = freshState();
    state.settings = {};
    state.bindings.accounts = [
        { numericUserId: ACCOUNT_ID, login: ACCOUNT_LOGIN, displayName: null, usable: true, scope: VERDICT_OK },
    ];
    state.bindings.bindings = [bindingWith('prj_42')];

    return state;
}

/**
 * One FR-010 matrix whose `contents` verdict the caller picks; the other three
 * capabilities always read `ok`.
 *
 * @param contents - Verdict recorded for the `contents` capability.
 * @returns The matrix as the accounts DTO carries it.
 */
// eslint-disable-next-line llm-core/no-unknown-returns -- fixture shape; naming the type is the assertion.
function matrix(contents: string): unknown {
    const results = Object.fromEntries(
        CAPABILITIES.map((capability) => [capability, capability === 'contents' ? contents : VERDICT_OK]),
    );

    return { checkedAt: FIXTURE_STAMP, results };
}

/**
 * Find one prerequisite by id, failing loudly when the id is unknown.
 *
 * @param state - State to derive from.
 * @returns The derived prerequisite with that id.
 */
function prerequisiteOf(state: PanelState, id: PrerequisiteId): Prerequisite {
    const found = derivePrerequisites(state).find((item) => item.id === id);
    if (found === undefined) {
        throw new Error(`no ${id} prerequisite was derived`);
    }

    return found;
}

describe('first-run prerequisites (FR-071, AC-122)', () => {
    it('renders all five on a fresh install, each with a state and a remediation', () => {
        {
            const items = derivePrerequisites(freshState());

            expect(items.map((item) => item.id)).toEqual(PREREQUISITE_IDS);
            expect(items).toHaveLength(5);
            for (const item of items) {
                expect(ALLOWED_STATES).toContain(item.state);
                expect(item.title.trim()).not.toBe('');
                expect(item.detail.trim()).not.toBe('');
                expect(item.remediation.trim()).not.toBe('');

                const line = prerequisiteLine(item);
                expect(line).toContain(item.title);
                expect(line).toContain(prerequisiteStateLabel(item.state));
                expect(line).toContain(item.remediation);
            }
        }
        {
            for (const state of [freshState(), configuredState()]) {
                const pin = prerequisiteOf(state, IDS.defaultAgent);

                expect(pin.state).toBe(NOT_CHECKABLE);
                expect(pin.state).not.toBe(MET);
                // It says how to satisfy it even though it cannot check it, and
                // names the first dispatch as the thing that actually checks it
                // (003 FR-072; 005 FR-037 — both require the setting's *path*,
                // neither prescribes a value). Since 002 v1.10.0 / 006 v1.5.0
                // the default is blank, so the line pins the operator's own
                // choice, not a name the owner refused to assume.
                expect(pin.remediation).toMatch(/Session Defaults/);
                expect(pin.remediation).toContain('the agent you want dispatches to run on');
                expect(pin.remediation).toContain('expectedAgent');
                expect(pin.remediation).not.toContain('project-manager');
                expect(pin.detail).toMatch(/cannot read/);
            }
        }
        {
            const state = freshState();

            expect(prerequisiteOf(state, IDS.registeredProject).state).toBe(MET);
            expect(prerequisiteOf(state, IDS.tokenScopes).state).toBe(NOT_MET);
            // The retired service-capability item is gone for good: no state can
            // derive it any more (002 v1.9.0, 005 v1.7.0).
            const ids = derivePrerequisites(state).map((item) => item.id);

            expect(ids).not.toContain('service-capability');
        }
        {
            const state = configuredState();
            state.bindings.bindings = [bindingWith('')];

            const project = prerequisiteOf(state, IDS.registeredProject);
            expect(project.state).toBe(NOT_MET);
            expect(project.remediation).toMatch(/never creates a project/);
        }
        {
            expect(prerequisiteOf(freshState(), IDS.openchamberRunning).state).toBe(NOT_CHECKABLE);
            expect(prerequisiteOf(configuredState(), IDS.openchamberRunning).state).toBe(MET);
        }
        {
            const surface = prerequisiteOf(configuredState(), IDS.desktopOrWeb);

            expect(surface.state).toBe(NOT_CHECKABLE);
        }
    });
});

describe('the unmet notice outside the section (FR-073)', () => {
    it('raises a notice naming the unmet scopes', () => {
        {
            const state = freshState();
            state.bindings.accounts = [
                {
                    numericUserId: ACCOUNT_ID,
                    login: ACCOUNT_LOGIN,
                    displayName: null,
                    usable: true,
                    scope: VERDICT_MISSING,
                },
            ];

            const notice = prerequisiteNotice(derivePrerequisites(state));

            expect(notice).not.toBeNull();
            expect(notice?.body).toContain(SCOPES_TITLE);
            expect(notice?.body).toContain(PREREQUISITES_HEADING);
        }
        {
            const notice = prerequisiteNotice(derivePrerequisites(freshState()));

            expect(notice?.body).toContain(SCOPES_TITLE);
            // The removed prerequisite's title must never ride back into the copy.
            expect(notice?.body).not.toContain('Service capability approval');
        }
        {
            // The configured state still has two not-checkable prerequisites (the
            // pin and the surface) — neither may nag, and neither may show met.
            const configured = configuredState();
            expect(prerequisiteNotice(derivePrerequisites(configured))).toBeNull();
            expect(prerequisiteOf(configured, IDS.desktopOrWeb).state).toBe(NOT_CHECKABLE);
        }
        {
            const runtime = createTestRuntime(fakeHost());

            expect(() => repaintPrerequisites(runtime)).not.toThrow();
        }
    });
});

/**
 * Bring a runtime's state to the point where the *only* thing left to
 * satisfy is the token-scope line: host answered, one usable account with a
 * missing verdict, one bound repository with a project.
 */
function configureForNotice(rt: ReturnType<typeof createTestRuntime>): void {
    rt.state.settings = {};
    rt.state.bindings.accounts = [
        { numericUserId: ACCOUNT_ID, login: ACCOUNT_LOGIN, displayName: null, usable: true, scope: VERDICT_MISSING },
    ];
    rt.state.bindings.bindings = [bindingWith('prj_42')];
}

/**
 * Mount the FR-073 notice over a runtime with one unmet checkable item.
 *
 * @returns The runtime and the notice wrapper the mount appended.
 */
function mountedNotice(): {
    readonly rt: ReturnType<typeof createTestRuntime>;
    readonly box: FakeElement;
} {
    const rt = createTestRuntime(fakeHost());
    configureForNotice(rt);
    const dom = fakeDom();
    mountPrerequisiteNotice({ rt, parent: dom.root });
    const box = dom.rootElement.firstElementChild;
    if (box === null) {
        throw new Error('the notice wrapper did not mount');
    }

    return { rt, box };
}

describe('the mounted notice tracks the derivation (FR-073, owner review 2026-09-30)', () => {
    it('shows the banner for unmet scopes and hides it once the evidence lands', () => {
        {
            const { rt, box } = mountedNotice();

            // The missing scope verdict is what raises the banner at mount.
            expect(box.hidden).toBe(false);
            expect(prerequisiteNotice(derivePrerequisites(rt.state))).not.toBeNull();

            // The account's matrix comes back all-ok on the next read.
            rt.state.bindings.accounts = [
                { numericUserId: ACCOUNT_ID, login: ACCOUNT_LOGIN, displayName: null, usable: true, scope: VERDICT_OK },
            ];
            repaintPrerequisites(rt);

            // The observation is what clears it — nothing to accept anywhere.
            expect(prerequisiteNotice(derivePrerequisites(rt.state))).toBeNull();
            expect(box.hidden).toBe(true);
        }
        {
            const { rt, box } = mountedNotice();

            repaintPrerequisites(rt);

            expect(box.hidden).toBe(false);
            expect(prerequisiteNotice(derivePrerequisites(rt.state))?.body).toContain(SCOPES_TITLE);
        }
    });
});

describe('account scope evidence (FR-071, fail-closed parsing)', () => {
    it('reads a missing capability as a missing verdict', () => {
        {
            const body = JSON.stringify({
                accounts: [
                    { numericUserId: PARSED_ID, login: PARSED_LOGIN, state: ACTIVE, scopeCheck: matrix(
                        VERDICT_MISSING
                    ) },
                ],
            });

            expect(parseAccountsBody(body)?.[0]?.scope).toBe(VERDICT_MISSING);
        }
        {
            const body = JSON.stringify({
                accounts: [
                    { numericUserId: PARSED_ID, login: PARSED_LOGIN, state: ACTIVE, scopeCheck: matrix(VERDICT_OK) },
                ],
            });

            expect(parseAccountsBody(body)?.[0]?.scope).toBe(VERDICT_OK);
        }
        {
            const body = JSON.stringify({ accounts: [{
                numericUserId: PARSED_ID, login: PARSED_LOGIN, state: ACTIVE }] });
            const unreadable = JSON.stringify({
                accounts: [
                    {
                        numericUserId: PARSED_ID,
                        login: PARSED_LOGIN,
                        state: ACTIVE,
                        scopeCheck: { checkedAt: FIXTURE_STAMP, results: { metadata: 'maybe' } },
                    },
                ],
            });

            expect(parseAccountsBody(body)?.[0]).not.toHaveProperty('scope');
            expect(parseAccountsBody(unreadable)?.[0]).not.toHaveProperty('scope');
        }
        {
            const state = freshState();
            state.bindings.accounts = [
                { numericUserId: PARSED_ID, login: PARSED_LOGIN, displayName: null, usable: false, scope: VERDICT_OK },
            ];

            expect(prerequisiteOf(state, IDS.tokenScopes).state).toBe(NOT_MET);
        }
    });
});

describe('no new host capability (NFR-110, AGENTS invariant 3)', () => {
    it('makes no host call of its own', () => {
        const source = readFileSync(resolve(ROOT, 'src/prerequisites.ts'), 'utf8');

        expect(source).not.toContain("from './session.ts'");
        expect(source).not.toMatch(/\brt\.host\b/);
        for (const method of HOST_METHODS) {
            expect(source, `prerequisites must not call ${method}`).not.toContain(method);
        }
    });
});
