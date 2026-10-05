/**
 * Recording handle stubs for headless UI-repaint tests.
 *
 * The bindings-tab tests must prove `refresh()` drives both tab bodies without a
 * real browser, but the SDK mounts need a live `document`, so these stubs
 * model only the `Handle` contract: `update` counted, `dispose` silent. They
 * live here so the bindings-section suite and the panel suites share one stub
 * instead of each growing their own.
 */

import type { Handle } from '@openchamber/sdk/ui';
import type { PanelUi, ProjectPickerUi } from '../../src/panel-state.ts';
import type { BindingsPane } from '../../src/bindings-ui.ts';

/**
 * Read the recorded paint count of a stubbed handle.
 *
 * The stub's `paints` reader exists on the concrete stub but not on the SDK
 * handle type the pane stores it as; this is the typed read the tests use so
 * no test-side casts appear.
 *
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
 * without it; the framing tests need the opposite — a UI that lets `refresh`
 * run all the way to the banner without a real DOM.
 *
 * @returns The root framing stub: the banner.
 */
export function stubPanelUi(): PanelUi {
    return {
        banner: stubHandle(),
    };
}

/**
 * Build a `ProjectPickerUi` whose handles are recording stubs.
 *
 * @returns A complete stub picker, as the Bindings body would mount it.
 */
export function stubProjectPickerUi(): ProjectPickerUi {
    return {
        projectSelect: stubHandle(),
        projectStatus: stubHandle(),
        projectDetail: stubHandle(),
        projectRefresh: stubHandle(),
        projectCopy: stubHandle(),
    };
}

/**
 * Build a `BindingsPane` whose handles are recording stubs.
 *
 * The repaint step only calls `update` on these handles and reads `pane` for
 * the tab-visibility `hidden` writes, so the stub pairs recording handles with
 * a plain body element and stands in for a real pane without any SDK mount
 * machinery.
 *
 * @param paneBody - Element the stub reports as the pane's body.
 * @returns A stub pane backed by `paneBody`.
 */
export function stubBindingsPane(paneBody: HTMLElement): BindingsPane {
    return {
        status: stubHandle(),
        note: stubHandle(),
        bindingsList: stubHandle(),
        refreshBindings: stubHandle(),
        newBindingReason: {
            box: paneBody,
            line: stubHandle(),
        },
        newBinding: stubHandle(),
        toggleSelected: stubHandle(),
        removeSelected: stubHandle(),
        editorBox: paneBody,
        editorState: stubHandle(),
        repoField: stubHandle(),
        accountSelect: stubHandle(),
        mentionToken: stubHandle(),
        projectSelect: stubHandle(),
        assignmentCheck: stubHandle(),
        mentionCheck: stubHandle(),
        reviewRequestCheck: stubHandle(),
        worktreeSelect: stubHandle(),
        addBinding: stubHandle(),
        cancelEdit: stubHandle(),
        detailBox: paneBody,
        detailChips: { paint: (): void => undefined, dispose: (): void => undefined },
        selectedDetail: stubHandle(),
        actors: { field: stubHandle() },
        prompt: { field: stubHandle() },
        pane: paneBody,
        dispose: (): void => undefined,
    };
}
