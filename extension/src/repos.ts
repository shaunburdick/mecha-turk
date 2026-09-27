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
import { parseAccountsBody, parseBindingsBody } from './repos-service.ts';
import type { BindingStatusRow, PanelAccount, PanelBinding, PanelTriggers } from './repos-service.ts';
import { BINDINGS_PATH, serviceGet, servicePut } from './service-calls.ts';
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
 * Fetch the stored bindings from the service.
 *
 * @param rt - Panel runtime.
 * @returns The bindings, or `null` when the service refused or was unreachable.
 */
async function fetchBindings(rt: PanelRuntime): Promise<readonly PanelBinding[] | null> {
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

    return parsed.bindings;
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

    const result = await serviceGet({ serviceRequest: rt.host.serviceRequest, path: '/v1/accounts' });
    if (!result.ok) {
        return null;
    }

    return parseAccountsBody(result.body);
}

/**
 * Clear the draft when the fresh bindings now cover it.
 *
 * A draft whose repository is already bound shrinks to nothing, so the add
 * form cannot offer a second binding for the same repository.
 *
 * @param repos - Panel state.
 * @param bindings - The bindings the service now holds.
 */

/**
 * Empty the add-form draft.
 *
 * @param repos - Panel state.
 */

/**
 * Clear the draft once its repository appears in the granted list.
 *
 * @param repos - Panel state.
 * @param repository - The freshly bound repository label.
 */

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
    rt.state.repos.note = note;
    refresh(rt);
}

/**
 * Load the bindings and the registered accounts the Repos tab renders.
 *
 * @param rt - Panel runtime.
 */
export async function loadRepositories(rt: PanelRuntime): Promise<void> {
    if (rt.disposed || rt.state.repos.status === 'loading') {
        return;
    }

    rt.state.repos.status = 'loading';
    refresh(rt);

    const [bindings, accounts] = await Promise.all([
        fetchBindings(rt),
        fetchAccounts(rt),
    ]);
    if (stillMounted(rt)) {
        if (bindings !== null) {
            rt.state.repos.bindings = bindings;
        }

        rt.state.repos.status = bindings !== null && accounts !== null ? 'ready' : 'error';
        if (bindings === null || accounts === null) {
            rt.state.repos.note = 'One of the reads failed — refresh to retry.';
        }
    }

    refresh(rt);
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

