/**
 * Bindings-tab actions for the event bindings (M3 re-cut).
 *
 * The service owns the durable bindings file; this tab reads, edits, and
 * re-grants it whole. This module owns the **add** flow (repository, account,
 * project, triggers, worktree option, and the starting prompt and allow-list
 * that travel with the rest of the draft), the list reads, the enable/disable
 * toggle, and removal — plus the draft's **defaults**, which the **edit** flow
 * in [`bindings-edit.ts`](./bindings-edit.ts) resets when a save lands or a
 * cancel closes. The draft's *reader* moved to
 * [`bindings-draft.ts`](./bindings-draft.ts) for the file-length gate and is
 * still re-exported here. Every write is the same `PUT /v1/bindings`
 * whole-file grant; actions never throw: every failure lands on the tab's note
 * line, so one refused PUT cannot take the panel down.
 *
 * Every bindings list the service confirms (a read or a grant) with an
 * enabled row also arms the event relay — see {@link armRelayForBindings} —
 * so the loop does not depend on what happened to be in state at mount.
 */

import { nowIso } from './ids.ts';
import { refresh } from './panel-ui.ts';
import { displayedProjectId } from './project-picker.ts';
import { redact } from './redaction.ts';
import { armRelayForBindings, grantBindings } from './bindings-grant.ts';
import { readDraft } from './bindings-draft.ts';
import { actorsRefusal, allowedUsersPatch } from './bindings-actors.ts';
import { promptRefusal } from './bindings-prompt.ts';
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
} from './bindings-service.ts';
import type { PanelRuntime, BindingsTabState } from './panel-state.ts';

/** One per-binding status row the tab renders (scan state + pending count). */
export type RepoRow = BindingStatusRow;

// The draft reader and its two exported shapes moved to `bindings-draft.ts` for
// the file-length gate; they stay importable from here so no call site had to
// change with the move, exactly as `AccountsTabState` is re-exported from
// `accounts-state.ts` by `panel-state.ts`.
export { SELECT_TO_EDIT_NOTE, readDraft } from './bindings-draft.ts';
export type { DraftEditTarget, PreparedBinding } from './bindings-draft.ts';

/**
 * Record one draft-field change the add form just made.
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
 * The project field is **prefilled with the value the panel picker's control
 * displays** (002 FR-013, FR-097(b)) — the stored pick, else the derived
 * current-project default, else `null` — so the two dropdowns agree whenever
 * the form opens, and one where nothing resolves still opens empty exactly as
 * it did before. The caller passes it rather than reading panel state here:
 * this function stays a function of the bindings slice alone, and every reset
 * site names the value it means (plan J5).
 *
 * @param displayed - What the picker's control shows right now, or `null`.
 */
export function resetDraft(bindings: BindingsTabState, displayed: string | null): void {
    bindings.repoInput = '';
    bindings.accountSelection = null;
    bindings.repoProjectSelection = displayed;
    bindings.triggerAssignment = true;
    bindings.triggerMention = false;
    bindings.triggerReviewRequest = true;
    bindings.worktreeSelection = 'none';
}
function resetCoveredDraft(bindings: BindingsTabState, repository: string, displayed: string | null): void {
    const draft = bindings.repoInput.trim().toLowerCase();
    if (draft === '' || draft !== repository.toLowerCase()) {
        return;
    }

    resetDraft(bindings, displayed);
}
function clearDraftIfCovered(
    bindings: BindingsTabState,
    stored: readonly PanelBinding[],
    displayed: string | null,
): void {
    const draft = bindings.repoInput.trim().toLowerCase();
    const isCovered = draft !== '' && stored.some((binding) => binding.repository.toLowerCase() === draft);
    if (!isCovered) {
        return;
    }

    resetDraft(bindings, displayed);
}
/**
 * Whether the mount still runs; a function call the analyzer never narrows.
 *
 * Exported because a second `if (rt.disposed)` in the *same* function reads
 * as always-falsy to the type-aware rule — the narrowing from the first one
 * survives an `await` — while the runtime genuinely can be torn down between
 * two awaits. A call is the honest way to ask again.
 *
 * @returns `true` while the panel is alive.
 */
export function stillMounted(rt: PanelRuntime): boolean {
    return !rt.disposed;
}

/**
 * Fetch the stored bindings and their scan status from the service.
 *
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

    // The covered-draft clear is a reset, so it takes the displayed value
    // like every other one (002 FR-097(b)).
    clearDraftIfCovered(rt.state.bindings, parsed.bindings, displayedProjectId(rt.state));

    return parsed;
}

/**
 * Fetch the credential-free accounts the picker offers.
 *
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


/**
 * Load the bindings, their scan status, and the registered accounts the
 * Bindings tab renders.
 *
 * The success path arms the relay when the read landed at least one enabled
 * binding: this is the read the manual **Refresh** runs, and the one that
 * answers after a mount-time 503, so it is where a panel that started empty
 * (or against a service that was still spawning) finally joins the loop.
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
 * The starting prompt rides this write the way it rides the edit save: one
 * form, one primary control, the prompt alongside the rest (005 `## Clarifications`
 * row 33), so 004 FR-014's two rules hold in add mode too. A field the
 * operator never touched omits the member — for a brand-new row that means
 * the binding is created prompt-less, and every *other* row's stored prompt
 * is preserved by the same omission — while a touched one travels with it,
 * an explicit empty value included. A refusal the prompt caused lands on the
 * field it belongs to rather than being left to the tab's note.
 */
export async function bindRepository(rt: PanelRuntime): Promise<void> {
    const { bindings } = rt.state;
    const draft = readDraft(bindings);
    if (draft === null) {
        // The note already says why; repaint to show it.
        refresh(rt);

        return;
    }

    const prompt = bindings.startingPromptDirty
        ? { bindingId: draft.bindingId, startingPrompt: bindings.startingPromptInput }
        : undefined;
    // The allow-list rides this write the same way: a brand-new row
    // has no policy yet, so a field the operator never touched creates the
    // binding open, and a touched one travels with it. A cleared field omits the
    // key, which for a new row is the same unset state.
    const actors = allowedUsersPatch(bindings, draft.bindingId);
    const answer = await grantBindings({
        rt,
        bindings: [...bindings.bindings, draft],
        note: `Bound ${draft.repository} to ${draft.accountLogin}.`,
        ...(prompt !== undefined && { prompt }),
        ...(actors !== undefined && { actors }),
        // The new row's mode is the draft's own: the select's default is the
        // documented default, so an untouched control binds the binding to watch
        // from now on (002 FR-089). The patch names **this** row, so creating one
        // look-back binding cannot re-arm a catch-up on every binding already
        // scanned (002 FR-084).
        historyScope: { bindingId: draft.bindingId, historyScope: draft.historyScope },
    });
    resetCoveredDraft(bindings, draft.repository, displayedProjectId(rt.state));
    if (answer.ok) {
        bindings.editorOpen = false;
        bindings.startingPromptDirty = false;
        bindings.startingPromptError = null;
        bindings.startingPromptInput = '';
        bindings.allowedUsersDirty = false;
        bindings.allowedUsersError = null;
        bindings.allowedUsersInput = '';
    } else {
        const refusal = promptRefusal(answer);
        bindings.startingPromptError = refusal === null ? null : redact(refusal);
        const actorsRefused = actorsRefusal(answer);
        bindings.allowedUsersError = actorsRefused === null ? null : redact(actorsRefused);
    }

    refresh(rt);
}

/** Toggle the selected binding between enabled and disabled. */
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
