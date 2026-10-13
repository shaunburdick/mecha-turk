/** Recording handle stubs for headless UI-repaint tests: `update` counted, `dispose` silent. */

import type { Handle } from '@openchamber/sdk/ui';
import type { PanelUi } from '../../src/panel-state.ts';
import type { BindingsPane } from '../../src/bindings-ui.ts';

/** The stub's `paints` reader, typed against the SDK `Handle` so tests need no cast. */
export function stubPaints(handle: Handle<never>): number {
    const reads = (handle as { readonly paints?: () => number }).paints;
    return reads === undefined ? 0 : reads();
}

/** What a recording stub learned from the calls it received. */
export interface StubReads {
    readonly paints: () => number;
    readonly lastProps: () => Record<string, unknown> | null;
}

/** The stub's `lastProps` reader, typed against the SDK `Handle` so tests need no cast. */
export function stubLastProps(handle: Handle<never>): Record<string, unknown> | null {
    const reads = (handle as { readonly lastProps?: () => Record<string, unknown> | null }).lastProps;

    return reads === undefined ? null : reads();
}

/** Every string reachable from one mount's props, at any depth, in walk order. */
export function stringsIn(value: unknown): readonly string[] {
    if (typeof value === 'string') {
        return [value];
    }

    if (Array.isArray(value)) {
        return value.flatMap((entry) => stringsIn(entry));
    }

    if (typeof value === 'object' && value !== null) {
        return Object.values(value).flatMap((entry) => stringsIn(entry));
    }

    return [];
}

/**
 * Read one mount's props as the object an assertion compares over: a bare string prop reads as
 * `text`, the label the SDK wrapper would build.
 */
export function propsOf(raw: unknown): Record<string, unknown> {
    if (typeof raw === 'string') {
        return { text: raw };
    }

    if (typeof raw === 'object' && raw !== null) {
        return { ...raw };
    }

    return {};
}

/** The direct string values one mount was handed — no descent, property order. */
export function shallowStringsIn(props: unknown): readonly string[] {
    if (typeof props === 'string') {
        return [props];
    }

    if (typeof props !== 'object' || props === null) {
        return [];
    }

    return Object.values(props).filter((value): value is string => typeof value === 'string');
}

/** A `Handle<P>` double that records how often it repainted, and with what. */
export function stubHandle<P extends object>(): Handle<P> & StubReads {
    let count = 0;
    let last: Record<string, unknown> | null = null;

    return {
        update: (props): void => {
            count += 1;
            last = { ...props };
        },
        dispose: (): void => undefined,
        paints: (): number => count,
        lastProps: (): Record<string, unknown> | null => last,
    };
}

/** A `PanelUi` whose handles are recording stubs (see {@link stubHandle}). */
export function stubPanelUi(): PanelUi {
    return {
        banner: stubHandle(),
    };
}

/** A `BindingsPane` backed by recording stubs and one stand-in body element. */
export function stubBindingsPane(paneBody: HTMLElement): BindingsPane {
    return {
        status: stubHandle(),
        note: stubHandle(),
        bindingsList: stubHandle(),
        refreshBindings: stubHandle(),
        // The history-scope control and its derived window line (002 FR-089, FR-092).
        historyScope: { select: stubHandle() },
        historyScopeHelp: stubHandle(),
        windowScopeLine: stubHandle(),
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
        projectRefresh: stubHandle(),
        projectStatus: stubHandle(),
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
