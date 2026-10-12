/**
 * The one binding-row factory every suite builds its bindings from.
 *
 * The authorization gate reads `bindings.json` **at authorization** and denies
 * when the policy cannot be read (constitution II), which is exactly right in
 * production and exactly wrong for a fixture: a suite that enqueues a
 * detection and then reserves has, implicitly, asserted that a binding exists —
 * a run only exists because a binding scanned it. Before this helper the store
 * held no bindings document at all and the gate refused every fixture reserve
 * with `actor-not-allowed`.
 *
 * So the defaults write the **open** policy (no `allowedUsers` key at all),
 * which is the honest neutral fixture: 002 FR-047's absent state means any
 * human actor may trigger, so every existing dispatch assertion keeps testing
 * what it was written to test, and the restricted-policy suites pass their own
 * list instead. A suite passes only the members it varies; every other field
 * defaults to the stored spelling the panel's whole-file grant writes.
 *
 * Store-side suites read the row as `BindingRecord`, panel-side suites as
 * `PanelBinding`, and JSON fixtures as a plain record — one row, typed for
 * whichever surface judges it.
 *
 * The dispatch fixtures write through {@link store.writeJson} on the real
 * bindings path rather than the `PUT` route deliberately: the gate reads the
 * stored document, and a fixture that went through the whole-file grant would
 * also assert the grant.
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

/** The stored row every fixture binding is, whichever surface reads it. */
export type FixtureBindingRow = BindingRecord & PanelBinding & Record<string, unknown>;

/** Fields one fixture binding differs on, beside its identity. */
export interface FixtureBindingOptions {
    /** Account the binding is bound to. */
    readonly accountNumericUserId?: string;
    /** Account login at bind time. */
    readonly accountLogin?: string;
    /** Repository label, `owner/name`. */
    readonly repository?: string;
    /** Project the dispatch targets. */
    readonly projectId?: string;
    /** Worktree option the run snapshots. */
    readonly worktreeOption?: string;
    /**
     * The actor allow-list, or `null` for the **open** policy.
     *
     * `null` omits the key entirely rather than writing `[]`, because `[]` is a
     * refusal (002 FR-047) and a fixture that wrote it would have its whole
     * document quarantined — an honest failure, but one about the fixture.
     */
    readonly allowedUsers?: readonly string[] | null;
    /** Binding state; `active` unless a fixture is about the disabled path. */
    readonly state?: 'active' | 'disabled' | undefined;
    /** Trigger switches; a complete set, never merged over the default. */
    readonly triggers?: BindingTriggers;
    /** The stored starting prompt; omitted when the binding has none. */
    readonly startingPrompt?: string | undefined;
    /** Scan-window lower bound; omitted when the binding uses the default. */
    readonly historyScope?: HistoryScope | undefined;
    /** RFC 3339 stamp both recorded times carry. */
    readonly stamp?: string;
}

/**
 * `value` when a suite supplied one, else the fixture's fallback.
 *
 * Named so each default reads without a `??` branch of its own: a row builder
 * this wide would otherwise trip the complexity ceiling with plain defaults.
 */
function orDefault<T>(value: T | undefined, fallback: T): T {
    return value ?? fallback;
}

/**
 * The members a fixture carries only when a suite supplied them.
 *
 * Absent keys are meaningful here: `allowedUsers` absent is the open policy
 * (002 FR-047) and a prompt or scope absent is its unset state, so these are
 * omitted rather than written as `null`.
 *
 * @returns The optional members, ready to spread over the required ones.
 */
function optionalMembers(options: FixtureBindingOptions): Record<string, unknown> {
    const { allowedUsers, historyScope, startingPrompt } = options;

    return {
        ...(allowedUsers !== null && allowedUsers !== undefined && { allowedUsers: [...allowedUsers] }),
        ...(startingPrompt !== undefined && { startingPrompt }),
        ...(historyScope !== undefined && { historyScope }),
    };
}

/**
 * Build one binding row exactly as the panel's whole-file grant writes it.
 *
 * @param bindingId - The binding's id, matching the fixture runs'.
 * @returns The stored row.
 */
export function fixtureBindingRow(
    bindingId: string,
    options: FixtureBindingOptions = {},
): FixtureBindingRow {
    return {
        bindingId,
        accountNumericUserId: orDefault(options.accountNumericUserId, '77331'),
        accountLogin: orDefault(options.accountLogin, 'octocat'),
        repository: orDefault(options.repository, 'acme/widget'),
        projectId: orDefault(options.projectId, 'prj_42'),
        worktreeOption: orDefault(options.worktreeOption, 'none'),
        triggers: orDefault(options.triggers, { assignment: true, mention: true, reviewRequest: false }),
        state: orDefault(options.state, 'active'),
        createdAt: orDefault(options.stamp, FIXTURE_BINDING_STAMP),
        updatedAt: orDefault(options.stamp, FIXTURE_BINDING_STAMP),
        ...optionalMembers(options),
    };
}

/**
 * Write the fixture bindings a suite's dispatch path needs.
 *
 * Replaces the whole document rather than merging, because a suite that calls
 * this twice (across a restart, say) wants the same single fixture binding
 * rather than an accumulation.
 *
 * @returns A promise that settles once the document is durable.
 */
export async function writeFixtureBindings(
    store: ServiceStore,
    ...bindings: readonly (readonly [string, FixtureBindingOptions?])[]
): Promise<void> {
    await store.writeJson(BINDINGS_FILE, bindings.map(
        ([bindingId, options]) => fixtureBindingRow(bindingId, options ?? {}),
    ));
}

/**
 * Write the one open-policy binding a fixture run dispatches through.
 *
 * The common case, named separately so a suite's setup reads as what it means:
 * "this run has a binding, and that binding restricts nobody".
 *
 * @returns A promise that settles once the document is durable.
 */
export async function writeOpenBinding(input: {
    /** Open store to write through. */
    readonly store: ServiceStore;
    /** Binding the fixture runs name. */
    readonly bindingId: string;
    /** Per-fixture overrides. */
    readonly options?: FixtureBindingOptions;
}): Promise<void> {
    await writeFixtureBindings(input.store, [input.bindingId, input.options ?? {}]);
}

/**
 * Write the store's copy of the shared dispatch loop's binding.
 *
 * The loop harness installs this binding on the *panel* side; the **store** side
 * exists only because the authorization gate reads `bindings.json` at
 * `POST …/reserve` and denies when it cannot (003 FR-076, constitution II). The
 * two must agree: a run exists because this binding's scan created it.
 *
 * @returns A promise that settles once the document is durable.
 */
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
