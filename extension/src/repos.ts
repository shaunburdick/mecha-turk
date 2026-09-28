/**
 * Repos-tab actions for the event bindings (M3 re-cut).
 *
 * The service owns the durable bindings file; this tab reads, edits, and
 * re-grants it whole. One add flow (repository, account, project, triggers,
 * worktree option) plus an enable/disable toggle for a selected row — both
 * granted through the same `PUT /v1/bindings` whole-file call. Actions never
 * throw: every failure lands on the tab's note line, so one refused PUT
 * cannot take the panel down.
 */

import { parseRepository, repositoryLabel } from './config.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import { refresh } from './panel-ui.ts';
import { redact } from './redaction.ts';
import { removeAccountMirror } from './account-mirror.ts';
import {
    ACCOUNTS_PATH,
    BINDINGS_PATH,
    accountDeletePath,
    serviceDelete,
    serviceGet,
    servicePut,
} from './service-calls.ts';
import { countEnabledBindings, parseAccountsBody, parseBindingsBody } from './repos-service.ts';
import type { BindingStatusRow, BindingsSnapshot, PanelAccount, PanelBinding, PanelTriggers } from './repos-service.ts';
import type { PanelRuntime, Repositories } from './panel-state.ts';

/** One per-binding status row the tab renders (scan state + pending count). */
export type RepoRow = BindingStatusRow;

/**
 * Record one draft-field change the add form just made.
 *
 * @param rt - Panel runtime.
 * @param patch - The fields to update.
 */
export function editRepos(rt: PanelRuntime, patch: Partial<Repositories>): void {
    if (rt.disposed) {
        return;
    }

    Object.assign(rt.state.repos, patch);
    refresh(rt);
}

function resetDraft(repos: Repositories): void {
    repos.repoInput = '';
    repos.accountSelection = null;
    repos.repoProjectSelection = null;
    repos.triggerAssignment = true;
    repos.triggerMention = false;
    repos.worktreeSelection = 'none';
}
function resetCoveredDraft(repos: Repositories, repository: string): void {
    const draft = repos.repoInput.trim().toLowerCase();
    if (draft === '' || draft !== repository.toLowerCase()) {
        return;
    }

    resetDraft(repos);
}
function clearDraftIfCovered(repos: Repositories, bindings: readonly PanelBinding[]): void {
    const draft = repos.repoInput.trim().toLowerCase();
    const covered = draft !== '' && bindings.some((binding) => binding.repository.toLowerCase() === draft);
    if (!covered) {
        return;
    }

    resetDraft(repos);
}
/**
 * Whether the mount still runs; a function call the analyzer never narrows.
 *
 * @param rt - Panel runtime.
 * @returns `true` while the panel is alive.
 */
function stillMounted(rt: PanelRuntime): boolean {
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
        rt.state.repos.note = redact('The bindings list the service answered was unreadable — refresh to retry.');

        return null;
    }

    clearDraftIfCovered(rt.state.repos, parsed.bindings);

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

/**
 * Read one add-form draft, answered as a ready binding or the problems.
 *
 * @param repos - Panel state to read the draft from.
 * @returns The binding, or `null` (the note then says why).
 */
export function readDraft(repos: Repositories): PreparedBinding | null {
    const repository = parseRepository(repos.repoInput);
    if (repository === null) {
        repos.note = 'repository must be `owner/name`';

        return null;
    }

    const label = repositoryLabel(repository);
    const account = repos.accounts.find((candidate) => candidate.numericUserId === repos.accountSelection) ?? null;
    if (account === null) {
        repos.note = 'Pick the account this repository polls under.';

        return null;
    }

    if (repos.repoProjectSelection === null) {
        repos.note = 'Pick the OpenChamber project the dispatch opens in.';

        return null;
    }

    const duplicate = repos.bindings.some((candidate) => candidate.repository.toLowerCase() === label.toLowerCase());
    if (duplicate) {
        repos.note = 'That repository is already bound.';

        return null;
    }

    const stamp = nowIso();

    return {
        bindingId: `bnd-${newCorrelationId()}`,
        accountNumericUserId: account.numericUserId,
        accountLogin: account.login,
        repository: label,
        projectId: repos.repoProjectSelection,
        worktreeOption: repos.worktreeSelection,
        triggers: {
            assignment: repos.triggerAssignment,
            mention: repos.triggerMention,
        },
        state: 'active',
        createdAt: stamp,
        updatedAt: stamp,
    };
}

/**
 * Replace the stored bindings with one PUT; never throws.
 *
 * On a refused body the panel keeps its local draft and the note explains.
 *
 * @param input - Runtime, the replacement list, and the success note.
 */
async function grantBindings(input: {
    /** Panel runtime. */
    readonly rt: PanelRuntime;
    /** The replacement list. */
    readonly bindings: readonly PanelBinding[];
    /** Success note once the service stored it. */
    readonly note: string;
}): Promise<void> {
    const { rt, bindings, note } = input;
    const result = await servicePut({
        serviceRequest: rt.host.serviceRequest,
        path: BINDINGS_PATH,
        body: JSON.stringify({ bindings }),
    });

    if (!stillMounted(rt)) {
        return;
    }

    if (!result.ok) {
        rt.state.repos.note = `${result.problem} — the failure note is local to this tab.`;
        refresh(rt);

        return;
    }

    const parsed = parseBindingsBody(result.body);
    if (parsed === null) {
        rt.state.repos.note = 'The service answered a list the panel could not read — refresh to see what stuck.';
        refresh(rt);

        return;
    }

    rt.state.repos.bindings = parsed.bindings;
    rt.state.repos.statusRows = parsed.status;
    rt.state.bindingsActive = countEnabledBindings(parsed.bindings);
    rt.state.repos.note = note;
    refresh(rt);
}

/**
 * Load the bindings, their scan status, and the registered accounts the
 * Repos tab renders.
 *
 * @param rt - Panel runtime.
 */
export async function loadRepositories(rt: PanelRuntime): Promise<void> {
    if (rt.disposed || rt.state.repos.status === 'loading') {
        return;
    }

    rt.state.repos.status = 'loading';
    refresh(rt);

    const [snapshot, accounts] = await Promise.all([
        fetchBindings(rt),
        fetchAccounts(rt),
    ]);
    if (stillMounted(rt)) {
        if (snapshot !== null) {
            rt.state.repos.bindings = snapshot.bindings;
            rt.state.repos.statusRows = snapshot.status;
            rt.state.bindingsActive = countEnabledBindings(snapshot.bindings);
        }

        // Assign only a read that produced a list: a failed read must not
        // wipe the accounts the picker already offers.
        if (accounts !== null) {
            rt.state.repos.accounts = accounts;
        }

        rt.state.repos.status = snapshot !== null && accounts !== null ? 'ready' : 'error';
        if (snapshot === null || accounts === null) {
            rt.state.repos.note = 'One of the reads failed — refresh to retry.';
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
export function reloadReposAfterConnect(rt: PanelRuntime): void {
    if (!stillMounted(rt)) {
        return;
    }

    void loadRepositories(rt);
}

/**
 * Add the drafted repository as a binding and grant the whole list.
 *
 * @param rt - Panel runtime.
 */
export async function bindRepository(rt: PanelRuntime): Promise<void> {
    const { repos } = rt.state;
    const draft = readDraft(repos);
    if (draft === null) {
        // The note already says why; repaint to show it.
        refresh(rt);

        return;
    }

    await grantBindings({
        rt,
        bindings: [...repos.bindings, draft],
        note: `Bound ${draft.repository} to ${draft.accountLogin}.`,
    });
    resetCoveredDraft(repos, draft.repository);
    refresh(rt);
}

/**
 * Toggle the selected binding between enabled and disabled.
 *
 * @param rt - Panel runtime.
 */
export async function toggleBinding(rt: PanelRuntime): Promise<void> {
    const { repos } = rt.state;
    const binding = repos.bindings.find((candidate) => candidate.bindingId === repos.selectedBinding) ?? null;
    if (binding === null) {
        repos.note = 'Select a binding to toggle.';
        refresh(rt);

        return;
    }

    const next: PanelBinding = {
        ...binding,
        state: binding.state === 'active' ? 'disabled' : 'active',
        updatedAt: nowIso(),
    };
    const updated = repos.bindings.map((candidate) => (candidate.bindingId === binding.bindingId ? next : candidate));

    await grantBindings({ rt, bindings: updated, note: `${binding.repository} is now ${next.state}.` });
    refresh(rt);
}

/**
 * Resolve the account the Remove-account control targets.
 *
 * The panel's connected identity wins (that is whose removal clears the
 * handoff card); without one, the first usable account the service lists is
 * the MVP target. `null` means there is nothing to remove yet.
 *
 * @param rt - Panel runtime.
 * @returns The removal target, or `null` when no account is known.
 */
function removalTarget(rt: PanelRuntime): RemovalTarget | null {
    const { connected } = rt.state.handoff;
    if (connected !== null) {
        return { numericUserId: connected.numericUserId, login: connected.login };
    }

    const first = rt.state.repos.accounts.find((candidate) => candidate.usable) ?? null;

    return first === null ? null : { numericUserId: first.numericUserId, login: first.login };
}

/** One account the Remove-account control can target. */
export interface RemovalTarget {
    /** GitHub numeric user id of the account to remove. */
    readonly numericUserId: string;
    /** Display login, for the operator-facing note. */
    readonly login: string;
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
    const { repos } = rt.state;
    const binding = repos.bindings.find((candidate) => candidate.bindingId === repos.selectedBinding) ?? null;
    if (binding === null) {
        repos.note = 'Select a binding to remove.';
        refresh(rt);

        return;
    }

    const remaining = repos.bindings.filter((candidate) => candidate.bindingId !== binding.bindingId);
    repos.selectedBinding = null;

    await grantBindings({ rt, bindings: remaining, note: `Removed the binding for ${binding.repository}.` });
    refresh(rt);
}

/**
 * Answer the Remove-account arm click: arm the two-step confirmation.
 *
 * There is no `confirm()` inside the service frame, so the button itself
 * becomes the confirmation: the first click arms, the second click (while
 * armed) submits the delete.
 *
 * @param rt - Panel runtime.
 */
export function armAccountRemoval(rt: PanelRuntime): void {
    if (rt.disposed) {
        return;
    }

    rt.state.repos.removeAccountArmed = true;
    refresh(rt);
}

/**
 * Delete the targeted account from the service and clear the panel mirror.
 *
 * Two-step confirmed through the armed flag ({@link armAccountRemoval}); this
 * runs the `DELETE /v1/accounts/:numericUserId`. A 409 invalid-transition
 * refusal means bindings still reference the account — the service's own
 * remediation is shown (remove the bindings first), and the delete is not
 * forced. On success the panel mirror entry is dropped and the connected
 * identity is cleared when it pointed at the removed account, so the operator
 * is not left looking at a connected line for an account that no longer
 * exists.
 *
 * @param rt - Panel runtime.
 */
export async function removeAccount(rt: PanelRuntime): Promise<void> {
    const { repos } = rt.state;
    repos.removeAccountArmed = false;
    const target = removalTarget(rt);
    if (target === null) {
        repos.note = 'No account is connected to remove.';
        refresh(rt);

        return;
    }

    const result = await serviceDelete({
        serviceRequest: rt.host.serviceRequest,
        path: accountDeletePath(target.numericUserId),
    });
    if (rt.disposed) {
        return;
    }

    if (!result.ok) {
        repos.note =
            result.code === 'invalid-transition'
                ? 'The service refused: bindings still reference this account — remove them first.'
                : redact(`The service refused the account removal: ${result.problem}`);
        refresh(rt);

        return;
    }

    await removeAccountMirror(rt, target.numericUserId);
    if (!stillMounted(rt)) {
        return;
    }

    if (rt.state.handoff.connected?.numericUserId === target.numericUserId) {
        rt.state.handoff.connected = null;
    }
    repos.note = `Removed the account ${target.login} from the service.`;
    refresh(rt);
    // Re-read both sources so the accounts picker loses the removed row and
    // the note is not clobbered by a stale repaint elsewhere.
    await loadRepositories(rt);
}
