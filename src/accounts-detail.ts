/**
 * The selected account's controls (005 FR-062, FR-064–FR-066; 004 FR-082,
 * FR-089).
 *
 * This module owns what the "Selected account" block *offers*: the two
 * profile members' fields, the **one** `Save changes` that writes them
 * together (owner ruling, PR #12 — "One Save button, both fields"; the
 * inputs stay per member, only the save is shared), and the two-step
 * rotate/remove pair with the labels each control reads. It was split out of
 * [`accounts-tab.ts`](./accounts-tab.ts) so each file keeps one
 * responsibility and the shell stays inside its length gate (AGENTS.md) —
 * the same split `accounts-chips.ts` and `accounts-rows.ts` already drew.
 *
 * The module mounts and nothing else: every field renders the words
 * `accountFieldView` derives, and the shell repaints every handle from
 * state, so mount and repaint cannot disagree (FR-063, FR-064, FR-085).
 */

import { mountButton, mountTextField } from '@openchamber/sdk/ui';
import type { ButtonHandle, TextFieldHandle } from '@openchamber/sdk/ui';
import { accountFieldView } from './accounts-rows.ts';
import type { AccountMember, AccountsHandlers } from './accounts-state.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Idle label of the two-step Rotate-token control (FR-064). */
export const ROTATE_IDLE_LABEL = 'Rotate token';

/** Label after the first click, while the retention statement shows. */
export const ROTATE_ARMED_LABEL = 'Cancel rotate';

/** Idle label of the two-step Remove-account control (FR-055). */
export const REMOVE_IDLE_LABEL = 'Remove account';

/** Confirm-step label after the first click (no `confirm()` in the frame). */
export const REMOVE_ARMED_LABEL = 'Confirm remove';

/**
 * The one control that writes both profile members (owner ruling, PR #12:
 * "One Save button, both fields").
 *
 * Deliberately the same words the Bindings editor's contextual save reads,
 * because it does the same kind of thing — writes the whole form it sits
 * under — and each tab owns its copy of the label, the way Settings owns
 * `Save configuration`.
 */
const SAVE_CHANGES_LABEL = 'Save changes';

/** One profile member's field, as the pane carries it. */
export interface MemberControls {
    /** The field itself — the one element that ever holds its draft. */
    readonly field: TextFieldHandle;
    /** Release the field's handle (FR-017). */
    readonly dispose: () => void;
}

/** Every handle the selected row's control region mounts. */
export interface DetailControls {
    /** The two editable profile members' fields, keyed by member (FR-066, FR-089). */
    readonly members: Readonly<Record<AccountMember, MemberControls>>;
    /**
     * The one control that writes **both** members in a single body
     * (FR-066, 004 FR-082; owner ruling, PR #12).
     */
    readonly saveProfile: ButtonHandle;
    /** Two-step Rotate-token control (FR-064). */
    readonly rotateToken: ButtonHandle;
    /** Two-step Remove-account control (FR-055, FR-065). */
    readonly removeAccount: ButtonHandle;
    /** Release every handle this region mounted (FR-017). */
    readonly dispose: () => void;
}

/**
 * Mount one profile member's field (FR-066, 004 FR-089).
 *
 * Both members mount the same way — the draft/label flow the display name
 * shipped with — because they are one flow behind one route (004 FR-082),
 * and a second shape would be a second place it could be got wrong. The
 * field renders the words `accountFieldView` derives, so mount and repaint
 * can never disagree (FR-063's guidance, FR-064's not-set state).
 *
 * Neither field mounts a save of its own: the one control belongs to the
 * **pair**, and {@link mountDetailControls} mounts it beside them.
 *
 * @param input - The runtime, the pane, the member, and its callbacks.
 * @returns The field and its disposer.
 */
function mountMemberControls(input: {
    /** Runtime whose state the field mounts from. */
    readonly rt: PanelRuntime;
    /** Detail box the controls mount into. */
    readonly pane: HTMLElement;
    /** Which profile member this field edits. */
    readonly member: AccountMember;
    /** Callbacks the field invokes. */
    readonly handlers: AccountsHandlers;
}): MemberControls {
    const { rt, pane, member, handlers } = input;
    const view = accountFieldView(member, { accounts: rt.state.accounts, account: undefined });
    const onChange = member === 'displayName' ? handlers.setDisplayName : handlers.setStartingPrompt;
    const field = mountTextField(pane, {
        label: view.label,
        value: view.value,
        placeholder: view.placeholder,
        ...(view.multiline ? { multiline: true, rows: 4 } : {}),
        disabled: view.disabled,
        helper: view.helper,
        onChange,
    });

    return {
        field,
        dispose: (): void => {
            field.dispose();
        },
    };
}

/**
 * Mount the two row-level controls: rotate and remove, both two-step and
 * both idle until the row they act on is open.
 *
 * @param input - The pane and the callbacks the controls invoke.
 * @returns The two handles and their disposer.
 */
function mountRowControls(input: {
    /** Detail box the controls mount into. */
    readonly pane: HTMLElement;
    /** Callbacks the controls invoke. */
    readonly handlers: AccountsHandlers;
}): {
    /** Two-step rotation control (FR-064). */
    readonly rotateToken: ButtonHandle;
    /** Two-step removal control (FR-055, FR-065). */
    readonly removeAccount: ButtonHandle;
    /** Release both handles (FR-017). */
    readonly dispose: () => void;
} {
    const rotateToken = mountButton(input.pane, {
        label: ROTATE_IDLE_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: input.handlers.rotateToken,
    });
    const removeAccount = mountButton(input.pane, {
        label: REMOVE_IDLE_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: input.handlers.removeAccount,
    });

    return {
        rotateToken,
        removeAccount,
        dispose: (): void => {
            rotateToken.dispose();
            removeAccount.dispose();
        },
    };
}

/**
 * Mount the selected row's controls: both profile members, the one save that
 * writes them, rotate, and remove.
 *
 * They live **inside** the detail box, so a row with nothing selected hides
 * them with it — a control that acts on a selection cannot exist without one.
 *
 * @param input - The runtime, the detail box, and the callbacks to wire.
 * @returns The handles plus their disposer.
 */
export function mountDetailControls(input: {
    /** Runtime whose state the fields mount from. */
    readonly rt: PanelRuntime;
    /** Detail box the controls mount into. */
    readonly pane: HTMLElement;
    /** Callbacks the controls invoke. */
    readonly handlers: AccountsHandlers;
}): DetailControls {
    const mount = (member: AccountMember): MemberControls =>
        mountMemberControls({ rt: input.rt, pane: input.pane, member, handlers: input.handlers });
    const members = { displayName: mount('displayName'), startingPrompt: mount('startingPrompt') };
    // Mounted after both fields, because it belongs to the pair: it sends
    // `{ displayName, startingPrompt }` in one body, so the shell's first
    // repaint vouches that *both* drafts are for the row on screen before the
    // control can be used (FR-066's open-row guard).
    const saveProfile = mountButton(input.pane, {
        label: SAVE_CHANGES_LABEL,
        variant: 'secondary',
        disabled: true,
        onClick: input.handlers.submitProfile,
    });
    const rows = mountRowControls(input);

    return {
        members,
        saveProfile,
        rotateToken: rows.rotateToken,
        removeAccount: rows.removeAccount,
        dispose: (): void => {
            members.displayName.dispose();
            members.startingPrompt.dispose();
            saveProfile.dispose();
            rows.dispose();
        },
    };
}
