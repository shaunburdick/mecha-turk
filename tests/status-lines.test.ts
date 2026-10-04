/**
 * Operator-facing status lines (MVP fix 2b — 2026-09-27).
 *
 * One line the operator reads was telling a story the service did not back:
 * the binding rows showed no scan outcome at all ("binding on, pending 0,
 * nothing happens"). The fix is a pure function of panel state, so it is
 * asserted here without a live DOM: the row copy the Bindings pane renders.
 *
 * The root context line this file used to assert as well (`bindings: … ·
 * accounts: … · identity: … · ledger: …`) was removed from the panel root by
 * the 2026-10-01 product-owner review, and its assertions went with it — the
 * facts it carried are owned by the tabs that render them.
 */

import { describe, expect, it } from 'vitest';
import { bindingRows } from '../src/bindings-rows.ts';
import type { PanelBinding, BindingStatusRow } from '../src/bindings-service.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';

/** Fixture account the binding polls under. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** Fixture binding every row test renders. */
const BINDING_ID = 'bnd-status';

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
        {
            const rt = createTestRuntime(fakeHost());
            rt.state.bindings.bindings = [bindingFixture()];
            rt.state.bindings.statusRows = [statusFixture({ lastScanAt: null, lastError: 'auth-failed' })];

            const [row] = bindingRows(rt.state.bindings);

            expect(row?.subtitle).toContain(`polled as ${ACCOUNT_LOGIN}`);
            expect(row?.leading).toBe('on');
            expect(row?.meta).toBe('0');
        }
        {
            const rt = createTestRuntime(fakeHost());
            rt.state.bindings.bindings = [bindingFixture()];
            rt.state.bindings.statusRows = [statusFixture({ lastScanAt: minutesAgo(2), lastError: null })];

            const [row] = bindingRows(rt.state.bindings);

            expect(row?.subtitle).toContain('scan: 2m ago · ok');
        }
        {
            const rt = createTestRuntime(fakeHost());
            rt.state.bindings.bindings = [bindingFixture()];
            rt.state.bindings.statusRows = [statusFixture({ lastScanAt: minutesAgo(30), lastError: 'auth-failed' })];

            const [row] = bindingRows(rt.state.bindings);

            expect(row?.subtitle).toContain('scan: 30m ago · auth-failed');
        }
        {
            const rt = createTestRuntime(fakeHost());
            rt.state.bindings.bindings = [bindingFixture()];

            const [row] = bindingRows(rt.state.bindings);

            expect(row?.meta).toBe('0');
        }
    });
});
