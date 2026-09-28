/**
 * Recording handle stubs for headless UI-repaint tests.
 *
 * The repos-tab tests must prove `refresh()` drives both tab bodies without a
 * real browser, but the SDK mounts need a live `document`, so these stubs
 * model only the `Handle` contract: `update` counted, `dispose` silent. They
 * live here so the repos-section suite and the panel suites share one stub
 * instead of each growing their own.
 */

import type { Handle } from '@openchamber/sdk/ui';
import type { PanelUi } from '../../extension/src/panel-state.ts';
import type { ReposPane } from '../../extension/src/repos-ui.ts';

/**
 * Read the recorded paint count of a stubbed handle.
 *
 * The stub's `paints` reader exists on the concrete stub but not on the SDK
 * handle type the pane stores it as; this is the typed read the tests use so
 * no test-side casts appear.
 *
 * @param handle - A handle mounted by {@link stubReposPane} or
 *   {@link stubPanelUi}.
 * @returns How often `update` ran on it so far.
 */
export function stubPaints(handle: Handle<never>): number {
    const reads = (handle as { readonly paints?: () => number }).paints;
    return reads === undefined ? 0 : reads();
}

/**
 * Build a `Handle` double that records how often it repainted.
 *
 * `Handle<P>` needs only `update` and `dispose`, so a recording stub type
 * checks against every SDK handle the panel's UI interfaces hold, and the
 * count turns "the repaint reached this control" into an assertion.
 *
 * @returns A stub typed for the caller's handle field.
 */
export function stubHandle<P>(): Handle<P> & { readonly paints: () => number } {
    let count = 0;

    return {
        update: (): void => {
            count += 1;
        },
        dispose: (): void => undefined,
        paints: (): number => count,
    };
}

/**
 * Build a `PanelUi` whose handles are recording stubs (see {@link stubHandle}).
 *
 * Headless orchestration tests leave `ui` null because `refresh` is a no-op
 * without it; the repos-tab tests need the opposite — a UI that lets `refresh`
 * run all the way to the Repositories section without a real DOM.
 *
 * @returns A complete stub UI.
 */
export function stubPanelUi(): PanelUi {
    return {
        banner: stubHandle(),
        summary: stubHandle(),
        projectSelect: stubHandle(),
        projectStatus: stubHandle(),
        projectDetail: stubHandle(),
        projectRefresh: stubHandle(),
        projectCopy: stubHandle(),
        poll: stubHandle(),
        dispatch: stubHandle(),
        verify: stubHandle(),
        phaseSelect: stubHandle(),
        mark: stubHandle(),
        list: stubHandle(),
    };
}

/**
 * Build a `ReposPane` whose handles are recording stubs.
 *
 * The repaint step only calls `update` on these handles and reads `pane` for
 * the tab-visibility `hidden` writes, so the stub pairs recording handles with
 * a plain body element and stands in for a real pane without any SDK mount
 * machinery.
 *
 * @param paneBody - Element the stub reports as the pane's body.
 * @returns A stub pane backed by `paneBody`.
 */
export function stubReposPane(paneBody: HTMLElement): ReposPane {
    return {
        tabs: stubHandle(),
        status: stubHandle(),
        bindingsList: stubHandle(),
        refreshBindings: stubHandle(),
        repoField: stubHandle(),
        accountSelect: stubHandle(),
        projectSelect: stubHandle(),
        assignmentCheck: stubHandle(),
        mentionCheck: stubHandle(),
        reviewRequestCheck: stubHandle(),
        worktreeSelect: stubHandle(),
        addBinding: stubHandle(),
        toggleSelected: stubHandle(),
        removeSelected: stubHandle(),
        removeAccount: stubHandle(),
        note: stubHandle(),
        runsHeading: stubHandle(),
        runsStatus: stubHandle(),
        runsList: stubHandle(),
        refreshRuns: stubHandle(),
        openRun: stubHandle(),
        retryRun: stubHandle(),
        runsNote: stubHandle(),
        // A node of its own: the repaint hides the banner through this
        // wrapper, and reusing the pane body would hide the whole tab.
        agentNoticeBox: paneBody.ownerDocument.createElement('div'),
        agentNotice: stubHandle(),
        pane: paneBody,
        dispose: (): void => undefined,
    };
}
