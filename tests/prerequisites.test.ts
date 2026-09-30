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
import { describe, expect, it } from 'vitest';
import {
    PREREQUISITES_HEADING,
    derivePrerequisites,
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
    serviceCapability: 'service-capability',
} as const;

/** The three states FR-072 allows. */
const MET = 'met';
const NOT_MET = 'not-met';
const NOT_CHECKABLE = 'not-checkable';
const ALLOWED_STATES = [MET, NOT_MET, NOT_CHECKABLE] as const;

/** The six identifiers FR-071 names, in the order the section renders them. */
const PREREQUISITE_IDS: readonly PrerequisiteId[] = [
    IDS.defaultAgent,
    IDS.openchamberRunning,
    IDS.desktopOrWeb,
    IDS.tokenScopes,
    IDS.registeredProject,
    IDS.serviceCapability,
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
 * A fresh install's panel state: no settings snapshot, no accounts, no
 * bindings, and no consent yet.
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
 * with a readable matrix, one bound repository, consent given, service
 * answering with a writable store.
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
    state.handoff.consentGiven = true;
    state.handoff.preflighted = true;
    state.handoff.storageWritable = true;

    return state;
}

/**
 * One FR-010 matrix whose `contents` verdict the caller picks; the other three
 * capabilities always read `ok`.
 *
 * @param contents - Verdict recorded for the `contents` capability.
 * @returns The matrix as the accounts DTO carries it.
 */
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
 * @param id - Identifier of the prerequisite to return.
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
    it('renders all six on a fresh install, each with a state and a remediation', () => {
        const items = derivePrerequisites(freshState());

        expect(items.map((item) => item.id)).toEqual(PREREQUISITE_IDS);
        expect(items).toHaveLength(6);
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
    });

    it('reads the Default Agent pin as not checkable, and never as met', () => {
        for (const state of [freshState(), configuredState()]) {
            const pin = prerequisiteOf(state, IDS.defaultAgent);

            expect(pin.state).toBe(NOT_CHECKABLE);
            expect(pin.state).not.toBe(MET);
            expect(prerequisiteStateLabel(pin.state)).toBe('not checkable by the panel');
            expect(prerequisiteLine(pin)).toContain('not checkable by the panel');
            // It says how to satisfy it even though it cannot check it.
            expect(pin.remediation).toContain('project-manager');
            expect(pin.remediation).toMatch(/Session Defaults/);
            expect(pin.detail).toMatch(/cannot read/);
        }
    });

    it('holds a fresh install to plan D12: zero bindings is met, not a nag', () => {
        const state = freshState();

        expect(prerequisiteOf(state, IDS.registeredProject).state).toBe(MET);
        expect(prerequisiteOf(state, IDS.tokenScopes).state).toBe(NOT_MET);
        expect(prerequisiteOf(state, IDS.serviceCapability).state).toBe(NOT_MET);
    });

    it('sees an unregistered project on a binding as unmet', () => {
        const state = configuredState();
        state.bindings.bindings = [bindingWith('')];

        const project = prerequisiteOf(state, IDS.registeredProject);
        expect(project.state).toBe(NOT_MET);
        expect(project.detail).toContain('no registered project');
        expect(project.remediation).toContain('command palette');
        expect(project.remediation).toMatch(/never creates a project/);
    });

    it('sees the consent step it has not taken as unmet, and an answered service as met', () => {
        const state = configuredState();
        state.handoff.consentGiven = false;

        expect(prerequisiteOf(state, IDS.serviceCapability).state).toBe(NOT_MET);

        state.handoff.consentGiven = true;
        state.handoff.preflighted = false;
        expect(prerequisiteOf(state, IDS.serviceCapability).state).toBe(NOT_CHECKABLE);

        state.handoff.preflighted = true;
        expect(prerequisiteOf(state, IDS.serviceCapability).state).toBe(MET);
    });

    it('checks OpenChamber running only once the host has answered', () => {
        expect(prerequisiteOf(freshState(), IDS.openchamberRunning).state).toBe(NOT_CHECKABLE);
        expect(prerequisiteOf(configuredState(), IDS.openchamberRunning).state).toBe(MET);
    });

    it('says the desktop-or-web surface is not checkable rather than guessing', () => {
        const surface = prerequisiteOf(configuredState(), IDS.desktopOrWeb);

        expect(surface.state).toBe(NOT_CHECKABLE);
        expect(surface.remediation).toContain('desktop or web');
        expect(surface.remediation).toContain('VS Code');
    });
});

describe('the unmet notice outside the section (FR-073)', () => {
    it('raises a notice naming the unmet scopes', () => {
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
        expect(notice?.title).toBe('Setup prerequisites need attention');
        expect(notice?.body).toContain('GitHub token scopes');
        expect(notice?.body).toContain(PREREQUISITES_HEADING);
    });

    it('raises it for a fresh install, whose scopes and consent are genuinely unmet', () => {
        const notice = prerequisiteNotice(derivePrerequisites(freshState()));

        expect(notice?.body).toContain('GitHub token scopes');
        expect(notice?.body).toContain('Service capability approval');
    });

    it('never raises it for met or not-checkable items', () => {
        // The configured state still has two not-checkable prerequisites (the
        // pin and the surface) — neither may nag, and neither may show met.
        expect(prerequisiteNotice(derivePrerequisites(configuredState()))).toBeNull();
        expect(prerequisiteOf(configuredState(), IDS.desktopOrWeb).state).toBe(NOT_CHECKABLE);
    });

    it('repaints nothing, quietly, on a runtime with no mounted section', () => {
        const runtime = createTestRuntime(fakeHost());

        expect(() => repaintPrerequisites(runtime)).not.toThrow();
    });
});

describe('account scope evidence (FR-071, fail-closed parsing)', () => {
    it('reads a missing capability as a missing verdict', () => {
        const body = JSON.stringify({
            accounts: [
                { numericUserId: PARSED_ID, login: PARSED_LOGIN, state: ACTIVE, scopeCheck: matrix(VERDICT_MISSING) },
            ],
        });

        expect(parseAccountsBody(body)?.[0]?.scope).toBe(VERDICT_MISSING);
    });

    it('reads an all-ok matrix as ok', () => {
        const body = JSON.stringify({
            accounts: [
                { numericUserId: PARSED_ID, login: PARSED_LOGIN, state: ACTIVE, scopeCheck: matrix(VERDICT_OK) },
            ],
        });

        expect(parseAccountsBody(body)?.[0]?.scope).toBe(VERDICT_OK);
    });

    it('leaves the verdict absent when the DTO carries no matrix this build reads', () => {
        const body = JSON.stringify({ accounts: [{ numericUserId: PARSED_ID, login: PARSED_LOGIN, state: ACTIVE }] });
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
    });

    it('treats an unusable account as no evidence at all', () => {
        const state = freshState();
        state.bindings.accounts = [
            { numericUserId: PARSED_ID, login: PARSED_LOGIN, displayName: null, usable: false, scope: VERDICT_OK },
        ];

        expect(prerequisiteOf(state, IDS.tokenScopes).state).toBe(NOT_MET);
    });
});

describe('no new host capability (NFR-110, AGENTS invariant 3)', () => {
    it('declares exactly sessions and prompt in the manifest', () => {
        const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
            readonly openchamber?: { readonly contributes?: { readonly capabilities?: readonly string[] } };
        };

        expect(manifest.openchamber?.contributes?.capabilities).toEqual(['sessions', 'prompt']);
    });

    it('makes no host call of its own', () => {
        const source = readFileSync(resolve(ROOT, 'src/prerequisites.ts'), 'utf8');

        expect(source).not.toContain("from './session.ts'");
        expect(source).not.toMatch(/\brt\.host\b/);
        for (const method of HOST_METHODS) {
            expect(source, `prerequisites must not call ${method}`).not.toContain(method);
        }
    });
});
