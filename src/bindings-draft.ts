/**
 * The Bindings tab's **draft**: what the form holds, and the reader that turns
 * it into the row a whole-file grant writes (005 FR-050, FR-053; 004 FR-014;
 * 002 FR-047).
 *
 * Split out of [`bindings.ts`](./bindings.ts) for the file-length gate, and
 * along the seam the module's own header already drew: `bindings.ts` owns the
 * tab's **actions** (read, add, toggle, remove), while this owns the one thing
 * two of those actions share — the row the editor is about to become. The edit
 * flow in [`bindings-edit.ts`](./bindings-edit.ts) reads it for exactly the same
 * reason, and there is now one place a draft could be got wrong.
 *
 * Two rules ride the reader, and both are decisions rather than defaults:
 *
 * - **What the form shows is what the grant writes.** Every editable field is
 *   read from the draft in both modes; only the identity members (id, state,
 *   creation stamp) and the fixed account come from the row being edited, and
 *   only because the editor displays them (005 FR-050).
 * - **Nothing is silently dropped on the way out** (002 FR-047). The stored
 *   allow-list travels through an edit even when the operator never touched the
 *   field, because a whole-file row that omitted the key would take the binding
 *   back to open — the one rule that differs from 004's prompt, where an
 *   omitted key means *leave this one alone*.
 *
 * The reader is not pure: when the draft cannot be saved it says why **on the
 * tab's note**, because that note is the surface a refusal already has a home on
 * (005 FR-085).
 */

import { parseRepository, repositoryLabel } from './config.ts';
import { accountSelectionRefusal } from './bindings-accounts.ts';
import { newCorrelationId, nowIso } from './ids.ts';
import type { PanelBinding, PanelTriggers } from './bindings-service.ts';
import type { BindingsTabState } from './panel-state.ts';

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
    /**
     * The stored allow-list this row already holds, when it has one.
     *
     * Carried through the draft for the one reason 002 FR-047 forces: a
     * whole-file row that **omitted** the key would take its binding back to
     * open, so an edit of some *other* field must not quietly erase the
     * policy. A brand-new row has none, so this stays absent, which is the
     * complete "no policy configured" state (contract §1).
     *
     * `| undefined` is explicit because `exactOptionalPropertyTypes` is on and
     * the draft writes the member on every row: an `undefined` is dropped by
     * `JSON.stringify`, which is exactly how *unset* travels (contract §2).
     */
    readonly allowedUsers?: readonly string[] | undefined;
}

/** What an edit saves against; absent means the add form (a brand-new row). */
export interface DraftEditTarget {
    /** The binding the draft was loaded from, by id. */
    readonly bindingId: string;
}

/** Note the draft refuses with when there is no row to edit. */
export const SELECT_TO_EDIT_NOTE = 'Select a binding to edit.';

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
        // Edit mode's account field is fixed to this row, so the
        // account it displays *is* the account it saves — even when that
        // account has since been removed and no longer lists.
        const { accountNumericUserId, accountLogin } = origin.binding;

        return { accountNumericUserId, accountLogin };
    }

    const account =
        bindings.accounts.find((candidate) => candidate.numericUserId === bindings.accountSelection) ?? null;
    if (account === null) {
        // FR-103's total dispatch: *no accounts*, *no `active` one*, or something
        // to pick. The strings live with the gate, so the toolbar reason and this
        // refusal cannot become two spellings of one reason.
        bindings.note = accountSelectionRefusal(bindings);

        return null;
    }

    return { accountNumericUserId: account.numericUserId, accountLogin: account.login };
}

/**
 * Read the repository label, refusing a bad shape or a second binding of it.
 *
 * @param origin - Where the draft is being read from; only the edited row is
 *   exempt from the isDuplicate check, because that row already owns the name.
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
    const isDuplicate = bindings.bindings.some(
        (candidate) =>
            candidate.bindingId !== ownId &&
            candidate.repository.toLowerCase() === label.toLowerCase(),
    );
    if (isDuplicate) {
        bindings.note = DUPLICATE_NOTE;

        return null;
    }

    return label;
}

/**
 * Read the project the draft dispatches into.
 *
 * @returns The project id, or `null` when the operator has not picked one —
 *   a binding with no project is recoverable, not savable.
 */
function draftProject(bindings: BindingsTabState): string | null {
    if (bindings.repoProjectSelection === null) {
        bindings.note = PROJECT_NOTE;

        return null;
    }

    return bindings.repoProjectSelection;
}

/**
 * Read the allow-list a saved row keeps, which the draft must not lose.
 *
 * A brand-new row has none — absent is the complete "no policy configured"
 * state — while an edit carries the row's stored list through, so
 * changing an unrelated field cannot take a restricted binding back to open
 * (contract §2). The grant's patch then overrides this one row from the field
 * the operator actually edited.
 *
 * @param origin - Where the draft is being read from.
 * @returns The list to carry, or `undefined` for the add form.
 */
function draftActors(origin: DraftOrigin): readonly string[] | undefined {
    return origin.kind === 'edit' ? origin.binding.allowedUsers : undefined;
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
        // `undefined` rather than `[]`: omission is how the wire says *unset*,
        // and the client never manufactures the empty list the service refuses.
        allowedUsers: draftActors(origin),
    };
}
