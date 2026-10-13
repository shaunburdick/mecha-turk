/**
 * The one binding-row factory every suite builds its bindings from; one row, typed three ways —
 * `BindingRecord` by the store, `PanelBinding` by the panel, a plain record by JSON fixtures.
 */

import { BINDINGS_FILE } from '../../service/accounts/store.ts';
import type { BindingRecord, BindingTriggers } from '../../service/bindings.ts';
import type { HistoryScope } from '../../service/bindings-history-scope.ts';
import type { ServiceStore } from '../../service/store/index.ts';
import type { PanelBinding } from '../../src/bindings-service.ts';
import { PROJECT_ID } from './panel.ts';
import {
    ACCOUNT_ID,
    ACCOUNT_LOGIN,
    BINDING_ID,
    REPOSITORY,
    WORKTREE_OPTION,
} from './fixture-enqueue.ts';

/** Timestamp every fixture binding carries; no fixture waits on a clock. */
export const FIXTURE_BINDING_STAMP = '2026-09-20T00:00:00.000Z';

export type FixtureBindingRow = BindingRecord & PanelBinding & Record<string, unknown>;

/** Fields one fixture binding differs on, beside its identity. */
export interface FixtureBindingOptions {
    readonly accountNumericUserId?: string;
    readonly accountLogin?: string;
    readonly repository?: string;
    readonly projectId?: string;
    readonly worktreeOption?: string;
    /**
     * The actor allow-list, or `null` for the **open** policy: `null` omits the key, where `[]`
     * is a refusal (002 FR-047) that quarantines the whole fixture document.
     */
    readonly allowedUsers?: readonly string[] | null;
    readonly state?: 'active' | 'disabled' | undefined;
    readonly triggers?: BindingTriggers;
    readonly startingPrompt?: string | undefined;
    readonly historyScope?: HistoryScope | undefined;
    readonly stamp?: string;
}

/** The members a fixture carries only when supplied: absent is the open policy or the unset state, never `null`. */
function optionalMembers(options: FixtureBindingOptions): Record<string, unknown> {
    const { allowedUsers, historyScope, startingPrompt } = options;

    return {
        ...(allowedUsers !== null && allowedUsers !== undefined && { allowedUsers: [...allowedUsers] }),
        ...(startingPrompt !== undefined && { startingPrompt }),
        ...(historyScope !== undefined && { historyScope }),
    };
}

/** Build one binding row exactly as the panel's whole-file grant writes it. */
export function fixtureBindingRow(
    bindingId: string,
    options: FixtureBindingOptions = {},
): FixtureBindingRow {
    const stamp = options.stamp ?? FIXTURE_BINDING_STAMP;

    return {
        bindingId,
        accountNumericUserId: options.accountNumericUserId ?? '77331',
        accountLogin: options.accountLogin ?? 'octocat',
        repository: options.repository ?? 'acme/widget',
        projectId: options.projectId ?? 'prj_42',
        worktreeOption: options.worktreeOption ?? 'none',
        triggers: options.triggers ?? { assignment: true, mention: true, reviewRequest: false },
        state: options.state ?? 'active',
        createdAt: stamp,
        updatedAt: stamp,
        ...optionalMembers(options),
    };
}

/**
 * Write the fixture bindings a suite's dispatch path needs.
 *
 * Replaces the whole document (a second call wants the same single binding, not an accumulation)
 * and writes it directly rather than through the `PUT` route — the gate reads the stored file, so
 * the grant must not be what the fixture asserts too.
 */
export async function writeFixtureBindings(
    store: ServiceStore,
    ...bindings: readonly (readonly [string, FixtureBindingOptions?])[]
): Promise<void> {
    await store.writeJson(BINDINGS_FILE, bindings.map(
        ([bindingId, options]) => fixtureBindingRow(bindingId, options ?? {}),
    ));
}

export async function writeOpenBinding(input: {
    readonly store: ServiceStore;
    readonly bindingId: string;
    readonly options?: FixtureBindingOptions;
}): Promise<void> {
    await writeFixtureBindings(input.store, [input.bindingId, input.options ?? {}]);
}

/** Write the store's copy of the shared dispatch loop's binding; the harness installs its panel-side twin. */
export async function writeLoopBinding(store: ServiceStore): Promise<void> {
    await writeOpenBinding({
        store,
        bindingId: BINDING_ID,
        options: {
            repository: REPOSITORY,
            accountNumericUserId: ACCOUNT_ID,
            accountLogin: ACCOUNT_LOGIN,
            projectId: PROJECT_ID,
            worktreeOption: WORKTREE_OPTION,
        },
    });
}
