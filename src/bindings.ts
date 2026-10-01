/**
 * Bindings-tab actions for the event bindings (M3 re-cut).
 *
 * The service owns the durable bindings file; this tab reads, edits, and
 * re-grants it whole. This module owns the **add** flow (repository, account,
 * project, triggers, worktree option), the list reads, the enable/disable
 * toggle, and removal — plus the draft itself, whose reader
 * ({@link readDraft}) the **edit** flow in [`bindings-edit.ts`](./bindings-edit.ts)
 * shares. Every write is the same `PUT /v1/bindings` whole-file grant;
 * actions never throw: every failure lands on the tab's note line, so one
 * refused PUT cannot take the panel down.
 *
 * Every bindings list the service confirms (a read or a grant) with an
 * enabled row also arms the event relay — see {@link armRelayForBindings} —
 * so the loop does not depend on what happened to be in state at mount.
 */

import { parseRepository, repositoryLabel } from './config.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { armRelayForBindings, grantBindings } from './bindings-grant.ts';
import {
    ACCOUNTS_PATH,
    BINDINGS_PATH,
    serviceGet,
} from './service-calls.ts';
import { countEnabledBindings, parseAccountsBody, parseBindingsBody } from './bindings-service.ts';
import type {
    BindingStatusRow,
    BindingsSnapshot,
    PanelAccount,
    PanelBinding,
    PanelTriggers,
} from './bindings-service.ts';
import type { PanelRuntime, BindingsTabState } from './panel-state.ts';

/** One per-binding status row the tab renders (scan state + pending count). */
export type RepoRow = BindingStatusRow;

/**
 * Record one draft-field change the add form just made.
 *
 * @param rt - Panel runtime.
 * @param patch - The fields to update.
 */
export function editBindings(rt: PanelRuntime, patch: Partial<BindingsTabState>): void {
    if (rt.disposed) {
        return;
    }

    Object.assign(rt.state.bindings, patch);
    refresh(rt);
}

/**
 * Return the draft to the add form's defaults.
 *
 * Exported for [`bindings-edit.ts`](./bindings-edit.ts), which clears the
 * same draft when an edit is saved or cancelled: two resets of one draft are
 * two places the defaults could drift, so there is one.
 *
 * @param bindings - The Bindings tab's state.
 */
export function resetDraft(bindings: BindingsTabState): void {
    bindings.repoInput = '';
    bindings.accountSelection = null;
    bindings.repoProjectSelection = null;
    bindings.triggerAssignment = true;
    bindings.triggerMention = false;
    bindings.triggerReviewRequest = true;
    bindings.worktreeSelection = 'none';
}
function resetCoveredDraft(bindings: BindingsTabState, repository: string): void {
    const draft = bindings.repoInput.trim().toLowerCase();
    if (draft === '' || draft !== repository.toLowerCase()) {
        return;
    }

    resetDraft(bindings);
}
function clearDraftIfCovered(bindings: BindingsTabState, stored: readonly PanelBinding[]): void {
    const draft = bindings.repoInput.trim().toLowerCase();
    const covered = draft !== '' && stored.some((binding) => binding.repository.toLowerCase() === draft);
    if (!covered) {
        return;
    }

    resetDraft(bindings);
}
/**
 * Whether the mount still runs; a function call the analyzer never narrows.
 *
 * Exported because a second `if (rt.disposed)` in the *same* function reads
 * as always-falsy to the type-aware rule — the narrowing from the first one
 * survives an `await` — while the runtime genuinely can be torn down between
 * two awaits. A call is the honest way to ask again.
 *
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
export function stillMounted(rt: PanelRuntime): boolean {
    return rt.disposed === false;
}

/**
 * Fetch the stored bindings and their scan status from the service.
 *
 * @param rt - Panel runtime.
 * @returns Both lists, or `null` when the service refused or was unreachable.
 */
async function fetchBindings(rt: PanelRuntime): Promise<BindingsSnapshot | null> {
    if (rt.disposed) {
        return null;
    }

    const result = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: BINDINGS_PATH });
    if (!result.ok) {
        return null;
    }

    const parsed = parseBindingsBody(result.body);
    if (parsed === null) {
        rt.state.bindings.note = redact('The bindings list the service answered was unreadable — refresh to retry.');

        return null;
    }

    clearDraftIfCovered(rt.state.bindings, parsed.bindings);

    return parsed;
}

/**
 * Fetch the credential-free accounts the picker offers.
 *
 * @param rt - Panel runtime.
 * @returns The account list, `null` when the read failed.
 */
async function fetchAccounts(rt: PanelRuntime): Promise<readonly PanelAccount[] | null> {
    if (!stillMounted(rt)) {
        return null;
    }

    const result = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: ACCOUNTS_PATH });
    if (!result.ok) {
        return null;
    }

    return parseAccountsBody(result.body);
}

/** One candidate binding built from the draft, before the grant. */
export interface PreparedBinding {
    /** The fields the PUT will store. */
    readonly bindingId: string;
    readonly accountNumericUserId: string;
    readonly accountLogin: string;
    readonly repository: string;
    readonly projectId: string;
    readonly worktreeOption: string;
    readonly triggers: PanelTriggers;
    readonly state: 'active' | 'disabled';
    readonly createdAt: string;
    readonly updatedAt: string;
}

/** What an edit saves against; absent means the add form (a brand-new row). */
export interface DraftEditTarget {
    /** The binding the draft was loaded from, by id. */
    readonly bindingId: string;
}

/** Note the draft refuses with when there is no row to edit. */
export const SELECT_TO_EDIT_NOTE = 'Select a binding to edit.';

/** Note the draft refuses with when add mode has no account picked. */
const ACCOUNT_NOTE = 'Pick the account this repository polls under.';

/** Note the draft refuses with when the repository is not `owner/name`. */
const REPOSITORY_NOTE = 'repository must be `owner/name`';

/** Note the draft refuses with when the repository is already bound. */
const DUPLICATE_NOTE = 'That repository is already bound.';

/** Note the draft refuses with when no project is picked. */
const PROJECT_NOTE = 'Pick the OpenChamber project the dispatch opens in.';

/** Where a draft is being read from: a brand-new row, or the loaded one. */
type DraftOrigin =
    /** The add form: nothing is stored yet, so every field is the draft's. */
    | { readonly kind: 'add' }
    /** The edit form: id, state, stamps, and account come from this row. */
    | { readonly kind: 'edit'; readonly binding: PanelBinding };

/**
 * Decide which row a draft is being read for.
 *
 * @param bindings - Panel state to read.
 * @param edit - The row being edited, or absent for the add form.
 * @returns The origin, or `null` when the named row no longer exists — the
 *   note then says so, because editing a row the service no longer holds is
 *   a stale selection, not a permission to mint one.
 */
function draftOrigin(bindings: BindingsTabState, edit?: DraftEditTarget): DraftOrigin | null {
    if (edit === undefined) {
        return { kind: 'add' };
    }

    const binding =
        bindings.bindings.find((candidate) => candidate.bindingId === edit.bindingId) ?? null;
    if (binding === null) {
        bindings.note = SELECT_TO_EDIT_NOTE;

        return null;
    }

    return { kind: 'edit', binding };
}

/**
 * Read the account fields the draft saves under.
 *
 * @param bindings - Panel state to read (add mode's account selection).
 * @param origin - Where the draft is being read from.
 * @returns The account fields, or `null` when add mode picked none.
 */
function draftAccount(
    bindings: BindingsTabState,
    origin: DraftOrigin,
): { readonly accountNumericUserId: string; readonly accountLogin: string } | null {
    if (origin.kind === 'edit') {
        // Edit mode's account field is fixed to this row (FR-053), so the
        // account it displays *is* the account it saves — even when that
        // account has since been removed and no longer lists.
        const { accountNumericUserId, accountLogin } = origin.binding;

        return { accountNumericUserId, accountLogin };
    }

    const account =
        bindings.accounts.find((candidate) => candidate.numericUserId === bindings.accountSelection) ?? null;
    if (account === null) {
        bindings.note = ACCOUNT_NOTE;

        return null;
    }

    return { accountNumericUserId: account.numericUserId, accountLogin: account.login };
}

/**
 * Read the repository label, refusing a bad shape or a second binding of it.
 *
 * @param bindings - Panel state to read.
 * @param origin - Where the draft is being read from; only the edited row is
 *   exempt from the duplicate check, because that row already owns the name.
 * @returns The canonical `owner/name`, or `null` (the note then says why).
 */
function draftRepository(bindings: BindingsTabState, origin: DraftOrigin): string | null {
    const repository = parseRepository(bindings.repoInput);
    if (repository === null) {
        bindings.note = REPOSITORY_NOTE;

        return null;
    }

    const label = repositoryLabel(repository);
    const ownId = origin.kind === 'edit' ? origin.binding.bindingId : null;
    const duplicate = bindings.bindings.some(
        (candidate) =>
            candidate.bindingId !== ownId &&
            candidate.repository.toLowerCase() === label.toLowerCase(),
    );
    if (duplicate) {
        bindings.note = DUPLICATE_NOTE;

        return null;
    }

    return label;
}

/**
 * Read the project the draft dispatches into.
 *
 * @param bindings - Panel state to read.
 * @returns The project id, or `null` when the operator has not picked one —
 *   a binding with no project is recoverable, not savable (FR-056).
 */
function draftProject(bindings: BindingsTabState): string | null {
    if (bindings.repoProjectSelection === null) {
        bindings.note = PROJECT_NOTE;

        return null;
    }

    return bindings.repoProjectSelection;
}

/**
 * Read the identity a saved row keeps.
 *
 * @param origin - Where the draft is being read from.
 * @param stamp - This save's RFC 3339 stamp, used for a brand-new row.
 * @returns The id, state, and creation stamp the grant will write.
 */
function draftIdentity(
    origin: DraftOrigin,
    stamp: string,
): { readonly bindingId: string; readonly state: 'active' | 'disabled'; readonly createdAt: string } {
    if (origin.kind === 'edit') {
        const { bindingId, state, createdAt } = origin.binding;

        return { bindingId, state, createdAt };
    }

    return { bindingId: `bnd-${newCorrelationId()}`, state: 'active', createdAt: stamp };
}

/**
 * Read one form draft, answered as a ready binding or the problems.
 *
 * Called in two modes, and the mode is the whole difference: with no
 * {@link DraftEditTarget} this reads the **add** form and mints a new row;
 * with one it reads the **edit** form, keeping the selected row's id,
 * creation stamp, state, and account (the editor renders that account fixed,
 * so the stored values are the displayed ones). Everything else —
 * repository, project, triggers, worktree option — is read from the draft in
 * both modes, which is what makes a loaded draft and the row it saves the
 * same values (005 FR-050: one whole-file write, no second write path).
 *
 * @param bindings - Panel state to read the draft from.
 * @param edit - The row being edited, or absent for the add form.
 * @returns The binding, or `null` (the note then says why).
 */
export function readDraft(bindings: BindingsTabState, edit?: DraftEditTarget): PreparedBinding | null {
    const origin = draftOrigin(bindings, edit);
    if (origin === null) {
        return null;
    }

    const label = draftRepository(bindings, origin);
    if (label === null) {
        return null;
    }

    const account = draftAccount(bindings, origin);
    if (account === null) {
        return null;
    }

    const projectId = draftProject(bindings);
    if (projectId === null) {
        return null;
    }

    const stamp = nowIso();

    return {
        ...draftIdentity(origin, stamp),
        accountNumericUserId: account.accountNumericUserId,
        accountLogin: account.accountLogin,
        repository: label,
        projectId,
        worktreeOption: bindings.worktreeSelection,
        triggers: {
            assignment: bindings.triggerAssignment,
            mention: bindings.triggerMention,
            reviewRequest: bindings.triggerReviewRequest,
        },
        updatedAt: stamp,
    };
}

/**
 * Load the bindings, their scan status, and the registered accounts the
 * Bindings tab renders.
 *
 * The success path arms the relay when the read landed at least one enabled
 * binding: this is the read the manual **Refresh** runs, and the one that
 * answers after a mount-time 503, so it is where a panel that started empty
 * (or against a service that was still spawning) finally joins the loop.
 *
 * @param rt - Panel runtime.
 */
export async function loadBindings(rt: PanelRuntime): Promise<void> {
    if (rt.disposed || rt.state.bindings.status === 'loading') {
        return;
    }

    rt.state.bindings.status = 'loading';
    refresh(rt);

    const [snapshot, accounts] = await Promise.all([
        fetchBindings(rt),
        fetchAccounts(rt),
    ]);
    if (stillMounted(rt)) {
        if (snapshot !== null) {
            rt.state.bindings.bindings = snapshot.bindings;
            rt.state.bindings.statusRows = snapshot.status;
            rt.state.bindingsActive = countEnabledBindings(snapshot.bindings);
            armRelayForBindings(rt, snapshot.bindings);
        }

        // Assign only a read that produced a list: a failed read must not
        // wipe the accounts the picker already offers.
        if (accounts !== null) {
            rt.state.bindings.accounts = accounts;
        }

        rt.state.bindings.status = snapshot !== null && accounts !== null ? 'ready' : 'error';
        if (snapshot === null || accounts === null) {
            rt.state.bindings.note = 'One of the reads failed — refresh to retry.';
        }
    }

    refresh(rt);
}

/**
 * Re-read the bindings and accounts after an account connected or adopted.
 *
 * Fire-and-forget on purpose: the connected line and the account mirror are
 * already written by the time this runs, and the operator's next look is the
 * accounts dropdown — which must list the new account without a manual
 * Refresh. The read is dropped when the mount is gone, and a refused read
 * lands on the tab's own note line rather than anywhere the handoff copy is
 * rendered.
 *
 * @param rt - Panel runtime.
 */
export function reloadBindingsAfterConnect(rt: PanelRuntime): void {
    if (!stillMounted(rt)) {
        return;
    }

    void loadBindings(rt);
}

/**
 * Add the drafted repository as a binding and grant the whole list.
 *
 * A granted add closes the editor — the new row is on the list, which is the
 * surface the success note reports from — while a refused one leaves the
 * editor open with the draft the operator can correct.
 *
 * @param rt - Panel runtime.
 */
export async function bindRepository(rt: PanelRuntime): Promise<void> {
    const { bindings } = rt.state;
    const draft = readDraft(bindings);
    if (draft === null) {
        // The note already says why; repaint to show it.
        refresh(rt);

        return;
    }

    const answer = await grantBindings({
        rt,
        bindings: [...bindings.bindings, draft],
        note: `Bound ${draft.repository} to ${draft.accountLogin}.`,
    });
    resetCoveredDraft(bindings, draft.repository);
    if (answer.ok) {
        bindings.editorOpen = false;
    }

    refresh(rt);
}

/**
 * Toggle the selected binding between enabled and disabled.
 *
 * @param rt - Panel runtime.
 */
export async function toggleBinding(rt: PanelRuntime): Promise<void> {
    const { bindings } = rt.state;
    const binding = bindings.bindings.find((candidate) => candidate.bindingId === bindings.selectedBinding) ?? null;
    if (binding === null) {
        bindings.note = 'Select a binding to toggle.';
        refresh(rt);

        return;
    }

    const next: PanelBinding = {
        ...binding,
        state: binding.state === 'active' ? 'disabled' : 'active',
        updatedAt: nowIso(),
    };
    const updated = bindings.bindings.map(
        (candidate) => (candidate.bindingId === binding.bindingId ? next : candidate),
    );

    await grantBindings({ rt, bindings: updated, note: `${binding.repository} is now ${next.state}.` });
    refresh(rt);
}

/**
 * Remove the selected binding by granting the list without it.
 *
 * Removal is a whole-list PUT (the service replaces its stored bindings
 * wholesale), so the deleted row is simply absent from the granted list and
 * the service holds one less binding afterwards. Referenced accounts are
 * untouched: a binding removal deletes nothing but the binding.
 *
 * @param rt - Panel runtime.
 */
export async function removeBinding(rt: PanelRuntime): Promise<void> {
    const { bindings } = rt.state;
    const binding = bindings.bindings.find((candidate) => candidate.bindingId === bindings.selectedBinding) ?? null;
    if (binding === null) {
        bindings.note = 'Select a binding to remove.';
        refresh(rt);

        return;
    }

    const remaining = bindings.bindings.filter((candidate) => candidate.bindingId !== binding.bindingId);
    bindings.selectedBinding = null;

    await grantBindings({ rt, bindings: remaining, note: `Removed the binding for ${binding.repository}.` });
    refresh(rt);
}
