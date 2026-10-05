/**
 * The binding editor's derived fields (005 FR-053, FR-057; the recorded PM
 * ruling on T-022).
 *
 * Two facts the editor shows are **derived**, never stored, and both are
 * derived here:
 *
 * - **The mention token in force** is `@${binding.accountLogin}` — precisely
 *   the value `service/poll/triggers.ts#mentionsLogin` matches on. FR-057
 *   asks for it to be rendered and marked as an override when it differs from
 *   the bound account's own `@login`, so the mark fires on *that* difference
 *   (an upstream rename, or any future stored override) and on nothing else.
 *   There is no override **store** in this build: the shipped `BindingRecord`
 *   has no mention-token member, `grep` finds no `mentionToken` anywhere in
 *   `service/`, and an extra `PUT` member is silently dropped by
 *   `assembleBinding` — so the panel renders what the service actually
 *   matches rather than a field it could not write. The deferral and its
 *   lifting condition are recorded in `specs/005-panel-ia/spec.md` →
 *   `### v1.4.0`.
 * - **The bound-account field's scope** is the difference between editing and
 *   adding: with a binding selected the field is fixed to that binding's own
 *   account, so a displayed value and a saved value can never disagree; with
 *   no selection it lists the accounts available to bind.
 * - **The worktree option's declaration** (its two choices and how a choice
 *   is recorded) is a third field view kept here for the same reason: it is
 *   one of FR-053's fields, and `bindings-ui.ts` is at its file-length cap.
 *
 * All three are pure functions of the tab's state, so the copy and the
 * scoping are unit-testable without a DOM. Two mounted pieces live here too —
 * the mention-token line, and the two action rows (the editor's primary
 * control and cancel, plus the list's row-level controls) — and this module
 * deliberately imports neither `panel-ui` nor `bindings.ts`: it is composed by
 * `bindings-ui`, so it has to stay a leaf.
 */

import { mountButton, mountText } from '@openchamber/sdk/ui';
import type { ButtonHandle, SelectOption, TextHandle } from '@openchamber/sdk/ui';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { PanelBinding } from './bindings-service.ts';
import { accountGate, accountsRead } from './bindings-accounts.ts';
import { STATE_OFF, STATE_ON } from './bindings-chips.ts';

/** Label of the primary control while the form is adding a binding. */
export const ADD_BINDING_LABEL = 'Add binding';

/** Label of that same control once the editor holds a loaded row. */
export const SAVE_CHANGES_LABEL = 'Save changes';

/** Label of the list control that opens the editor on an empty draft. */
export const NEW_BINDING_LABEL = 'New binding';

/** Label of the control that walks away from the open editor without writing. */
export const CANCEL_EDIT_LABEL = 'Cancel edit';

/** Callbacks the editor's action row invokes. */
export interface BindingActionHandlers {
    /** The primary control: add in add mode, save in edit mode. */
    readonly submit: () => void;
    /** Open the editor on an empty draft — the list's *New binding* control. */
    readonly newBinding: () => void;
    /** Leave the open editor without writing it. */
    readonly cancelEdit: () => void;
    /** Enable or disable the selected row. */
    readonly toggle: () => void;
    /** Remove the selected row from the granted list. */
    readonly removeBinding: () => void;
}

/** The five controls the pane carries: the editor's two, the list's three. */
export interface BindingActions {
    /** Primary control: **Add binding**, or **Save changes** in edit mode. */
    readonly add: ButtonHandle;
    /** Closes the editor without writing (the open form's own escape). */
    readonly cancel: ButtonHandle;
    /** Opens the editor on an empty draft, so the list is not the add form. */
    readonly newBinding: ButtonHandle;
    /** Enable/disable toggle for the selected row. */
    readonly toggle: ButtonHandle;
    /** Removal control for the selected row. */
    readonly removeSelected: ButtonHandle;
}

/**
 * Mount the editor's action row and the list's row-level controls.
 *
 * They are two halves of one rule: a row can only be changed by loading it
 * into this form and saving it through the whole-file grant, so the primary
 * control is the editor's own (005 FR-050 — no second write path), while
 * **New binding**, **Toggle**, and **Remove** live with the list they act on
 * and stay reachable while the editor is closed (2026-10-01 review: the
 * editor is no longer open by default).
 *
 * @returns The five handles the pane carries.
 */
export function mountBindingActions(input: {
    /** Toolbar row in the editor the primary control and Cancel mount into. */
    readonly editor: HTMLElement;
    /** Toolbar row under the list the row-level controls mount into. */
    readonly row: HTMLElement;
    /** Callbacks the controls invoke. */
    readonly handlers: BindingActionHandlers;
}): BindingActions {
    const { editor, row, handlers } = input;

    return {
        add: mountButton(editor, { label: ADD_BINDING_LABEL, disabled: true, onClick: handlers.submit }),
        cancel: mountButton(editor, {
            label: CANCEL_EDIT_LABEL,
            variant: 'ghost',
            disabled: true,
            onClick: handlers.cancelEdit,
        }),
        newBinding: mountButton(row, {
            label: NEW_BINDING_LABEL,
            variant: 'secondary',
            disabled: true,
            onClick: handlers.newBinding,
        }),
        toggle: mountButton(row, {
            label: 'Toggle enabled',
            variant: 'outline',
            disabled: true,
            onClick: handlers.toggle,
        }),
        removeSelected: mountButton(row, {
            label: 'Remove',
            variant: 'outline',
            disabled: true,
            onClick: handlers.removeBinding,
        }),
    };
}

/**
 * Repaint both action rows from the tab's state (005 FR-050, FR-054).
 *
 * The primary control's label follows the editor's own mode, so what
 * activating it writes is always what its own words say; the list controls
 * follow the selection and the read state, and **Cancel** exists only while
 * the editor is open.
 */
export function repaintBindingActions(input: {
    /** State the rows repaint from. */
    readonly bindings: BindingsTabState;
    /** The mounted action rows. */
    readonly actions: BindingActions;
}): void {
    const { bindings, actions } = input;
    actions.add.update({
        label: bindings.editing ? SAVE_CHANGES_LABEL : ADD_BINDING_LABEL,
        disabled: bindings.status !== 'ready',
    });
    actions.cancel.update({ disabled: !bindings.editorOpen });
    // FR-120: the gate is zero accounts **at all**, and it is conjunctive with the
    // read-state condition already here — so it cannot fire on a read that never
    // succeeded. The predicate is the shared one, not a second `status` test.
    actions.newBinding.update({ disabled: !accountsRead(bindings) || accountGate(bindings).blocked });
    actions.toggle.update({ disabled: bindings.selectedBinding === null });
    actions.removeSelected.update({ disabled: bindings.selectedBinding === null });
}

/** What the editor's state line says about a binding that does not exist yet. */
const EDITOR_STATE_NEW = 'State: a new binding starts enabled.';

/** Line shown before any account is known, so no token can be derived yet. */
export const MENTION_IDLE = 'Select an account to see the mention token in force.';

/** What every derived mention-token line starts with (FR-057's own words). */
const MENTION_PREFIX = 'Mention token in force: ';

/**
 * The mark that tells an operator the rendered token is **not** the bound
 * account's current login.
 *
 * Compared case-insensitively against the account's current login, because
 * `mentionsLogin` matches case-insensitively: a case-only difference is not a
 * difference in what the service matches on, so it must not be marked.
 */
const OVERRIDE_MARK = 'override';

/** Which of the editor's two modes the bound-account field is rendering. */
export type AccountFieldMode =
    /** A binding is selected: the field describes that row, and is fixed. */
    | 'edit'
    /** Nothing is selected: the field is the add form's account picker. */
    | 'add';

/** How the bound-account field must render right now (FR-053, ruling 5). */
export interface AccountFieldView {
    /** Which mode produced this view. */
    readonly mode: AccountFieldMode;
    /** Options the select offers, ready to hand to the SDK select. */
    readonly options: SelectOption[];
    /** What the select shows — and what a save for this row carries. */
    readonly value: string | null;
    /** `true` while the field must not offer another choice. */
    readonly disabled: boolean;
}

/** The mention-token line as the editor renders it. */
export interface MentionTokenView {
    /** The rendered line; text only, never markup. */
    readonly line: string;
    /** Whether the line marks the token as differing from the account's own. */
    readonly override: boolean;
}

/**
 * Read the binding the editor is open on.
 *
 * @returns The selected binding, or `null` while the tab is in add mode.
 */
function selectedBinding(bindings: BindingsTabState): PanelBinding | null {
    if (bindings.selectedBinding === null) {
        return null;
    }

    return bindings.bindings.find(
        (candidate) => candidate.bindingId === bindings.selectedBinding,
    ) ?? null;
}

/**
 * The state the editor states in its own words (005 FR-053, 2026-10-01
 * review: *"no indication in the Binding Editor that the binding is enabled
 * or disabled"*).
 *
 * The line reads the stored row, not the toggle's intent, so it cannot claim
 * a state the service did not confirm; in add mode there is no stored row
 * yet, and the line says what a save will write instead of hiding the
 * question.
 *
 * @returns The line the editor paints under its heading.
 */
export function editorStateLine(bindings: BindingsTabState): string {
    const binding = selectedBinding(bindings);
    if (binding === null) {
        return EDITOR_STATE_NEW;
    }

    return `State: ${binding.state === 'active' ? STATE_ON : STATE_OFF}`;
}

/**
 * The two logins the mention-token line compares (FR-057, ruling 2).
 *
 * `login` is the one the rendered token is built from — the binding's own
 * `accountLogin` in edit mode, the draft's account in add mode. `current` is
 * the account's login as the service lists it **now**; it is `null` when the
 * panel cannot establish one (no account selected, or the account is gone),
 * and a `null` current is what stops the override mark from firing.
 *
 * @returns The token's login and the account's current one.
 */
function mentionParties(bindings: BindingsTabState): {
    /** Login the rendered token is built from, or `null` when there is none. */
    readonly login: string | null;
    /** Account's current login, or `null` when the panel cannot establish it. */
    readonly current: string | null;
} {
    const binding = selectedBinding(bindings);
    if (binding === null) {
        const draft =
            bindings.accounts.find(
                (candidate) => candidate.numericUserId === bindings.accountSelection,
            ) ?? null;

        return { login: draft?.login ?? null, current: draft?.login ?? null };
    }

    const account =
        bindings.accounts.find(
            (candidate) => candidate.numericUserId === binding.accountNumericUserId,
        ) ?? null;

    return { login: binding.accountLogin, current: account?.login ?? null };
}

/**
 * Derive the mention token the service matches on for this editor.
 *
 * Edit mode reads the selected binding's own `accountLogin` — the value
 * `mentionsLogin` is called with. Add mode reads the account the draft is
 * bound to, which is the token the new binding would match on. The override
 * mark fires only when both a current login is known and the two differ
 * case-insensitively: a binding whose account was removed cannot be compared,
 * and claiming an override without a comparison would be exactly the invented
 * value FR-003 forbids.
 *
 * @returns The line to render and whether it marks an override.
 */
export function mentionTokenView(bindings: BindingsTabState): MentionTokenView {
    const { login, current } = mentionParties(bindings);
    if (login === null || login === '') {
        return { line: MENTION_IDLE, override: false };
    }

    const token = `@${login}`;
    if (current === null || current.toLowerCase() === login.toLowerCase()) {
        return { line: `${MENTION_PREFIX}${token}`, override: false };
    }

    return {
        line: `${MENTION_PREFIX}${token} — ${OVERRIDE_MARK}: the account's current login is @${current}`,
        override: true,
    };
}

/**
 * Scope the bound-account field to the editor's mode (ruling 5).
 *
 * Edit mode fixes the field to the selected binding's own account — one
 * option, that binding's own id and login, no free select — which is what
 * makes a displayed value and a saved value unable to disagree. Add mode
 * lists the accounts available to bind (`usable` only: an account that cannot
 * poll is not an account a binding should be created under).
 */
export function accountFieldView(bindings: BindingsTabState): AccountFieldView {
    const binding = selectedBinding(bindings);
    if (binding !== null) {
        return {
            mode: 'edit',
            options: [
                { id: binding.accountNumericUserId, label: binding.accountLogin },
            ],
            value: binding.accountNumericUserId,
            disabled: true,
        };
    }

    const bindable = bindings.accounts.filter((candidate) => candidate.usable);

    return {
        mode: 'add',
        options: bindable.map((candidate) => ({
            id: candidate.numericUserId,
            label: candidate.login,
        })),
        value: bindings.accountSelection,
        disabled: bindings.status !== 'ready' || bindable.length === 0,
    };
}

/** Worktree options the add form offers (MVP: `new:` comes later). */
const WORKTREE_OPTIONS = [
    { id: 'none', label: 'none — project default directory' },
    { id: 'generated', label: 'generated — OpenChamber creates a worktree' },
] as const;

/**
 * The worktree option field's props (005 FR-053).
 *
 * The two choices are the MVP's own (`new:<branch>` arrives with its own
 * feature); the handler is narrowed to them so a future third option has to
 * widen this signature rather than slip through a string.
 *
 * @returns The props the SDK select takes.
 */
export function worktreeFieldView(
    bindings: BindingsTabState,
    setWorktree: (id: 'none' | 'generated') => void,
): {
    readonly label: string;
    readonly value: 'none' | 'generated';
    readonly options: { readonly id: string; readonly label: string }[];
    readonly onChange: (id: string) => void;
} {
    return {
        label: 'Worktree option',
        value: bindings.worktreeSelection,
        options: WORKTREE_OPTIONS.map((option) => ({ id: option.id, label: option.label })),
        onChange: (id: string) => setWorktree(id === 'generated' ? 'generated' : 'none'),
    };
}

/**
 * Mount the mention-token line into the pane, right under the account field.
 *
 * @returns The handle the pane carries for repaint and disposal.
 */
export function mountBindingMention(input: {
    /** Runtime whose tab state the line derives from. */
    readonly rt: PanelRuntime;
    /** Pane root the line mounts into. */
    readonly pane: HTMLElement;
}): TextHandle {
    return mountText(input.pane, { text: mentionTokenView(input.rt.state.bindings).line });
}

/**
 * Repaint the mention-token line from state.
 */
export function repaintBindingMention(rt: PanelRuntime, line: TextHandle): void {
    line.update({ text: mentionTokenView(rt.state.bindings).line });
}
