/**
 * Operator-facing status lines (MVP fixes 2b and 4 — 2026-09-27).
 *
 * Two lines the operator reads were telling a story the service did not back:
 * the binding rows showed no scan outcome at all ("binding on, pending 0,
 * nothing happens"), and the spike summary claimed `identity: not
 * authenticated` while bindings polled under a service-owned account. Both
 * fixes are pure functions of panel state, so they are asserted here without
 * a live DOM: the row copy the Repositories pane renders, and the summary
 * line the Spike tab renders.
 */

import { describe, expect, it } from 'vitest';
import { summarizeState } from '../src/panel-ui.ts';
import { bindingRows } from '../src/repos-rows.ts';
import type { PanelBinding, BindingStatusRow } from '../src/repos-service.ts';
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
        rt.state.repos.bindings = [bindingFixture()];
        rt.state.repos.statusRows = [statusFixture({ lastScanAt: null, lastError: 'auth-failed' })];

        const [row] = bindingRows(rt.state.repos);

        expect(row?.subtitle).toContain('scan: never · auth-failed');
        expect(row?.subtitle).toContain(`polled as ${ACCOUNT_LOGIN}`);
        expect(row?.leading).toBe('on');
        expect(row?.meta).toBe('0');
    });

    it('shows how long ago the last scan ran, and that it was clean', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.repos.bindings = [bindingFixture()];
        rt.state.repos.statusRows = [statusFixture({ lastScanAt: minutesAgo(2), lastError: null })];

        const [row] = bindingRows(rt.state.repos);

        expect(row?.subtitle).toContain('scan: 2m ago · ok');
    });

    it('carries the reason next to the stamp when a scan skipped after a success', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.repos.bindings = [bindingFixture()];
        rt.state.repos.statusRows = [statusFixture({ lastScanAt: minutesAgo(30), lastError: 'auth-failed' })];

        const [row] = bindingRows(rt.state.repos);

        expect(row?.subtitle).toContain('scan: 30m ago · auth-failed');
    });

    it('says the binding has not been scanned while no status row exists', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.repos.bindings = [bindingFixture()];

        const [row] = bindingRows(rt.state.repos);

        expect(row?.subtitle).toContain('not scanned yet');
        expect(row?.meta).toBe('0');
    });
});

describe('summarizeState (identity line in bindings mode, FIX 4)', () => {
    it('names the connected service login instead of the legacy integration token', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindingsActive = 2;
        rt.state.handoff.connected = { numericUserId: '77331', login: ACCOUNT_LOGIN };

        const summary = summarizeState(rt.state);

        expect(summary).toContain(`identity: ${ACCOUNT_LOGIN} (service)`);
        expect(summary).not.toContain(LEGACY_IDENTITY);
        // The legacy token is still on the panel, but it is not what polls.
        expect(summary).not.toContain(`identity: ${rt.state.login}`);
    });

    it('says the service account is the identity while nothing is connected yet', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindingsActive = 1;
        rt.state.handoff.connected = null;

        const summary = summarizeState(rt.state);

        expect(summary).toContain('identity: service account');
        expect(summary).not.toContain(LEGACY_IDENTITY);
    });

    it('keeps the legacy identity wording when no binding is active', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindingsActive = 0;
        rt.state.handoff.connected = { numericUserId: '77331', login: ACCOUNT_LOGIN };

        expect(summarizeState(rt.state)).toContain(`identity: ${LOGIN}`);
    });

    it('keeps the legacy not-authenticated wording when nothing is configured', () => {
        const rt = createTestRuntime(fakeHost());
        rt.state.bindingsActive = 0;
        rt.state.login = null;

        expect(summarizeState(rt.state)).toContain(LEGACY_IDENTITY);
    });
});
