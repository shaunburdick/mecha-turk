/**
 * Operator-facing status lines (MVP fixes 2b and 4 — 2026-09-27).
 *
 * Two lines the operator reads were telling a story the service did not back:
 * the binding rows showed no scan outcome at all ("binding on, pending 0,
 * nothing happens"), and the spike summary claimed `identity: not
 * authenticated` while bindings polled under a service-owned account. Both
 * fixes are pure functions of panel state, so they are asserted here without
 * a live DOM: the row copy the Bindings pane renders, and the summary
 * line the Spike tab renders.
 */

import { describe, expect, it } from 'vitest';
import { summarizeState } from '../src/panel-ui.ts';
import { bindingRows } from '../src/bindings-rows.ts';
import type { PanelBinding, BindingStatusRow } from '../src/bindings-service.ts';
import { LOGIN, createTestRuntime, fakeHost } from './support/panel.ts';

/** Fixture account the binding polls under. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Fixture binding every row test renders. */
const BINDING_ID = 'bnd-status';

/** Identity wording the legacy single-repo mode has always shown. */
const LEGACY_IDENTITY = 'identity: not authenticated';

/** RFC 3339 stamp the fixture binding carries. */
const STAMP = '2026-09-27T00:00:00.000Z';

/** Build a stamp exactly `minutes` before the current clock. */
function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Build the fixture binding the rows render.
 *
 * @returns A complete stored binding row.
 */
function bindingFixture(): PanelBinding {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: '77331',
        accountLogin: ACCOUNT_LOGIN,
        repository: 'acme/widget',
        projectId: 'prj_42',
        worktreeOption: 'none',
        triggers: { assignment: true, mention: false, reviewRequest: false },
        state: 'active',
        createdAt: STAMP,
        updatedAt: STAMP,
    };
}

/**
 * Build the status row one case plants for the fixture binding.
 *
 * @param slot - The scan slice the row carries.
 * @returns The complete status row the service answers.
 */
function statusFixture(slot: {
    readonly lastScanAt: string | null;
    readonly lastError: string | null;
}): BindingStatusRow {
    return {
        bindingId: BINDING_ID,
        repository: 'acme/widget',
        projectId: 'prj_42',
        accountLogin: ACCOUNT_LOGIN,
        active: true,
        lastScanAt: slot.lastScanAt,
        lastError: slot.lastError,
        pendingCount: 0,
    };
}

describe('bindingRows (scan status on the binding rows, FIX 2b)', () => {
    it('names the skip reason when the binding has never completed a scan', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindings.bindings = [bindingFixture()];
        rt.state.bindings.statusRows = [statusFixture({ lastScanAt: null, lastError: 'auth-failed' })];

        const [row] = bindingRows(rt.state.bindings);

        expect(row?.subtitle).toContain('scan: never · auth-failed');
        expect(row?.subtitle).toContain(`polled as ${ACCOUNT_LOGIN}`);
        expect(row?.leading).toBe('on');
        expect(row?.meta).toBe('0');
    });

    it('shows how long ago the last scan ran, and that it was clean', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindings.bindings = [bindingFixture()];
        rt.state.bindings.statusRows = [statusFixture({ lastScanAt: minutesAgo(2), lastError: null })];

        const [row] = bindingRows(rt.state.bindings);

        expect(row?.subtitle).toContain('scan: 2m ago · ok');
    });

    it('carries the reason next to the stamp when a scan skipped after a success', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindings.bindings = [bindingFixture()];
        rt.state.bindings.statusRows = [statusFixture({ lastScanAt: minutesAgo(30), lastError: 'auth-failed' })];

        const [row] = bindingRows(rt.state.bindings);

        expect(row?.subtitle).toContain('scan: 30m ago · auth-failed');
    });

    it('says the binding has not been scanned while no status row exists', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindings.bindings = [bindingFixture()];

        const [row] = bindingRows(rt.state.bindings);

        expect(row?.subtitle).toContain('not scanned yet');
        expect(row?.meta).toBe('0');
    });
});

describe('summarizeState (the panel context line, 005 FR-020)', () => {
    it('names the connected service login as the identity', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.handoff.connected = { numericUserId: '77331', login: ACCOUNT_LOGIN };

        const summary = summarizeState(rt.state);

        expect(summary).toContain(`identity: ${ACCOUNT_LOGIN} (service)`);
        expect(summary).not.toContain(LEGACY_IDENTITY);
        // The host integration token is not what polls, so it is never named.
        expect(summary).not.toContain(`identity: ${LOGIN}`);
    });

    it('says there is no service account yet while nothing is connected', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.handoff.connected = null;

        expect(summarizeState(rt.state)).toContain('identity: no service account yet');
        expect(summarizeState(rt.state)).not.toContain(LEGACY_IDENTITY);
    });

    it('reports bindings and accounts as counts, and as none yet when empty', () => {
        const rt = createTestRuntime(fakeHost());
        expect(summarizeState(rt.state)).toContain('bindings: none yet');
        expect(summarizeState(rt.state)).toContain('accounts: none yet');

        rt.state.bindings.bindings = [bindingFixture(), { ...bindingFixture(), state: 'disabled' }];
        rt.state.bindings.accounts = [
            { numericUserId: '77331', login: ACCOUNT_LOGIN, displayName: null, usable: true },
        ];

        const summary = summarizeState(rt.state);
        expect(summary).toContain('bindings: 2 (1 enabled)');
        expect(summary).toContain('accounts: 1');
    });

    it('carries none of the retired single-repo or spike vocabulary', () => {
        const rt = createTestRuntime(fakeHost());
        const summary = summarizeState(rt.state);

        expect(summary).not.toContain('repository:');
        expect(summary).not.toContain('match:');
        expect(summary).not.toContain('not authenticated');
        expect(summary).toContain('ledger: generation 1, 0 entries');
    });
});
