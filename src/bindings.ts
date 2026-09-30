/**
 * Bindings-tab actions for the event bindings (M3 re-cut).
 *
 * The service owns the durable bindings file; this tab reads, edits, and
 * re-grants it whole. One add flow (repository, account, project, triggers,
 * worktree option) plus an enable/disable toggle for a selected row — both
 * granted through the same `PUT /v1/bindings` whole-file call. Actions never
 * throw: every failure lands on the tab's note line, so one refused PUT
 * cannot take the panel down.
 *
 * Every bindings list the service confirms (a read or a grant) with an
 * enabled row also arms the event relay — see {@link armRelayForBindings} —
 * so the loop does not depend on what happened to be in state at mount.
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
import { startRelayPolling } from './relay.ts';
import { countEnabledBindings, parseAccountsBody, parseBindingsBody } from './bindings-service.ts';
import type {
    BindingStatusRow,
    BindingsSnapshot,
    PanelAccount,
    PanelBinding,
    PanelTriggers,
} from './bindings-service.ts';
import type { PanelRuntime, Repositories } from './panel-state.ts';

/** One per-binding status row the tab renders (scan state + pending count). */
export type RepoRow = BindingStatusRow;

/**
 * Record one draft-field change the add form just made.
 *
 * @param rt - Panel runtime.
 * @param patch - The fields to update.
 */
export function editBindings(rt: PanelRuntime, patch: Partial<Repositories>): void {
    if (rt.disposed) {
        return;
    }

    Object.assign(rt.state.bindings, patch);
    refresh(rt);
}

function resetDraft(bindings: Repositories): void {
    bindings.repoInput = '';
    bindings.accountSelection = null;
    bindings.repoProjectSelection = null;
    bindings.triggerAssignment = true;
    bindings.triggerMention = false;
    bindings.triggerReviewRequest = true;
    bindings.worktreeSelection = 'none';
}
function resetCoveredDraft(bindings: Repositories, repository: string): void {
    const draft = bindings.repoInput.trim().toLowerCase();
    if (draft === '' || draft !== repository.toLowerCase()) {
        return;
    }

    resetDraft(bindings);
}
function clearDraftIfCovered(bindings: Repositories, stored: readonly PanelBinding[]): void {
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

/**
 * Read one add-form draft, answered as a ready binding or the problems.
 *
 * @param bindings - Panel state to read the draft from.
 * @returns The binding, or `null` (the note then says why).
 */
export function readDraft(bindings: Repositories): PreparedBinding | null {
    const repository = parseRepository(bindings.repoInput);
    if (repository === null) {
        bindings.note = 'repository must be `owner/name`';

        return null;
    }

    const label = repositoryLabel(repository);
    const account =
        bindings.accounts.find((candidate) => candidate.numericUserId === bindings.accountSelection) ?? null;
    if (account === null) {
        bindings.note = 'Pick the account this repository polls under.';

        return null;
    }

    if (bindings.repoProjectSelection === null) {
        bindings.note = 'Pick the OpenChamber project the dispatch opens in.';

        return null;
    }

    const duplicate = bindings.bindings.some((candidate) => candidate.repository.toLowerCase() === label.toLowerCase());
    if (duplicate) {
        bindings.note = 'That repository is already bound.';

        return null;
    }

    const stamp = nowIso();

    return {
        bindingId: `bnd-${newCorrelationId()}`,
        accountNumericUserId: account.numericUserId,
        accountLogin: account.login,
        repository: label,
        projectId: bindings.repoProjectSelection,
        worktreeOption: bindings.worktreeSelection,
        triggers: {
            assignment: bindings.triggerAssignment,
            mention: bindings.triggerMention,
            reviewRequest: bindings.triggerReviewRequest,
        },
        state: 'active',
        createdAt: stamp,
        updatedAt: stamp,
    };
}

/**
 * Arm the event relay from one bindings list the service just confirmed.
 *
 * Arming used to happen in exactly two places — a *successful* mount-time
 * read with a binding in it (`bindings-mode.loadInitialBindings`) and an
 * integration-card connection while bindings were already active
 * (`app.handleConnection`). Both are mount-time signals, so a panel whose
 * first binding landed in-session, or whose mount-time `GET /v1/bindings`
 * answered 503 (the service's spawn race on a first run), never armed:
 * every later event sat `pending` until a remount. Any read or grant that
 * lands here is proof the service is up and the binding exists, so it arms
 * too. `startRelayPolling` is a no-op once `rt.relayArmed` is set, which
 * makes the extra calls idempotent — and it kicks one immediate tick, so the
 * operator does not wait out `RELAY_POLL_INTERVAL_MS` after binding.
 *
 * An empty list must not arm: a relay draining against no binding would
 * mark queued events `binding-missing` before the binding they belong to
 * ever lands.
 *
 * @param rt - Panel runtime.
 * @param bindings - The bindings list the service just confirmed as stored.
 */
function armRelayForBindings(rt: PanelRuntime, bindings: readonly PanelBinding[]): void {
    if (countEnabledBindings(bindings) > 0) {
        startRelayPolling(rt);
    }
}

/**
 * Replace the stored bindings with one PUT; never throws.
 *
 * On a refused body the panel keeps its local draft and the note explains.
 * A granted list with an enabled row also arms the relay (see
 * {@link armRelayForBindings}), so the first binding created in-session
 * dispatches without waiting for a remount.
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
        rt.state.bindings.note = `${result.problem} — the failure note is local to this tab.`;
        refresh(rt);

        return;
    }

    const parsed = parseBindingsBody(result.body);
    if (parsed === null) {
        rt.state.bindings.note = 'The service answered a list the panel could not read — refresh to see what stuck.';
        refresh(rt);

        return;
    }

    rt.state.bindings.bindings = parsed.bindings;
    rt.state.bindings.statusRows = parsed.status;
    rt.state.bindingsActive = countEnabledBindings(parsed.bindings);
    armRelayForBindings(rt, parsed.bindings);
    rt.state.bindings.note = note;
    refresh(rt);
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

    await grantBindings({
        rt,
        bindings: [...bindings.bindings, draft],
        note: `Bound ${draft.repository} to ${draft.accountLogin}.`,
    });
    resetCoveredDraft(bindings, draft.repository);
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

    const first = rt.state.bindings.accounts.find((candidate) => candidate.usable) ?? null;

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

    rt.state.bindings.removeAccountArmed = true;
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
    const { bindings } = rt.state;
    bindings.removeAccountArmed = false;
    const target = removalTarget(rt);
    if (target === null) {
        bindings.note = 'No account is connected to remove.';
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
        bindings.note =
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
    bindings.note = `Removed the account ${target.login} from the service.`;
    refresh(rt);
    // Re-read both sources so the accounts picker loses the removed row and
    // the note is not clobbered by a stale repaint elsewhere.
    await loadBindings(rt);
}
