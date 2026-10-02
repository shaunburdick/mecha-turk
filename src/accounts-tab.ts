/**
 * The Accounts body (005 FR-060–FR-069, T-024).
 *
 * The account custody surface, relocated onto its own tab: the one-shot
 * handoff group (paste → connect, with the static disclaimer the consent
 * dialog was replaced by mounted under the Accounts list — 002 FR-008 as
 * re-cut at v1.9.0) above the credential-free
 * account list the service answers with, and one detail line for the row the
 * operator has open. The list is rendered from `GET /v1/accounts` through
 * [`accounts-rows.ts`](./accounts-rows.ts), which owns every word of it; this
 * module owns only the mounts, the repaint, and the one read the tab needs.
 *
 * The read is deliberately the tab's *existing* one — `loadBindings` fetches
 * bindings and accounts together — so the Accounts tab and the Bindings tab
 * cannot disagree about who is registered, and there is no second list
 * primitive to keep in step. It runs only when nothing has been read yet
 * (`status === 'idle'`): a mount that is already reading is left alone, and
 * **Refresh accounts** is the operator's own re-read (FR-014).
 */

import { mountButton, mountList, mountText, mountTextField } from '@openchamber/sdk/ui';
import type { ButtonHandle, ListHandle, TextHandle, TextFieldHandle } from '@openchamber/sdk/ui';
import {
    mountHandoffDom,
    refreshHandoff,
    submitHandoffAndRepaint,
} from './accounts-ui.ts';
import { mountAccountsDisclaimer } from './accounts-disclaimer.ts';
import {
    armAccountRemoval,
    editAccounts,
    removeAccount,
    saveDisplayName,
    saveStartingPrompt,
    toggleRotation,
} from './accounts-actions.ts';
import { loadBindings } from './bindings.ts';
import { accountFieldView, accountRows, armLabel, detailText } from './accounts-rows.ts';
import { PROFILE_MEMBERS, setMemberEdit } from './accounts-state.ts';
import type { AccountMember, AccountsHandlers } from './accounts-state.ts';
import { mountDetailChips } from './accounts-chips.ts';
import type { DetailChips } from './accounts-chips.ts';
import { refresh } from './panel-ui.ts';
import { createBlock, mountColumnHead, mountStyledText } from './style.ts';
import type { PanelRuntime } from './panel-state.ts';

/** One profile member's field and save control, as the pane carries them. */
export interface MemberControls {
    /** The field itself — the one element that ever holds its draft. */
    readonly field: TextFieldHandle;
    /** The control that writes this member alone through the profile `PUT`. */
    readonly save: ButtonHandle;
    /** Release both handles (FR-017). */
    readonly dispose: () => void;
}

/** The Accounts body handle: the mounted element and its repaint handles. */
export interface AccountsBody {
    /** The body root this view mounted. */
    readonly pane: HTMLElement;
    /** Status line above the list. */
    readonly status: TextHandle;
    /** The credential-free account list (FR-062, FR-067). */
    readonly list: ListHandle;
    /** Explicit re-read of the accounts list (FR-014). */
    readonly refreshAccounts: ButtonHandle;
    /** Wrapper around the selected account's own line. */
    readonly detailBox: HTMLElement;
    /** Chip row over that line: the account's connection and scope. */
    readonly detailChips: DetailChips;
    /** The selected account's state, connection, scope, and remediation. */
    readonly detail: TextHandle;
    /** The two editable profile members' fields, keyed by member (FR-066, FR-089). */
    readonly members: Readonly<Record<AccountMember, MemberControls>>;
    /** Two-step Rotate-token control (FR-064). */
    readonly rotateToken: ButtonHandle;
    /** Two-step Remove-account control (FR-055, FR-065). */
    readonly removeAccount: ButtonHandle;
    /** Note under the body; never credential material. */
    readonly note: TextHandle;
    /** Remove every node this body mounted (FR-017). */
    readonly dispose: () => void;
}

/**
 * Compose the body's one status line.
 *
 * @param input - How many accounts the service listed and how many can poll.
 * @returns The summary text the status line shows.
 */
function composeStatus(input: { readonly total: number; readonly usable: number }): string {
    return `Accounts: ${input.total} (${input.usable} can poll)`;
}

/** Idle label of the two-step Rotate-token control (FR-064). */
const ROTATE_IDLE_LABEL = 'Rotate token';

/** Label after the first click, while the retention statement shows. */
const ROTATE_ARMED_LABEL = 'Cancel rotate';

/** Idle label of the two-step Remove-account control (FR-055). */
const REMOVE_IDLE_LABEL = 'Remove account';

/** Confirm-step label after the first click (no `confirm()` in the frame). */
const REMOVE_ARMED_LABEL = 'Confirm remove';

/** Heading above the one-shot handoff group. */
const CONNECT_HEADING = 'Connect an account';

/** Heading above the credential-free account list. */
const LIST_HEADING = 'Accounts';

/** Heading above the open row's facts and its controls. */
const SELECTED_HEADING = 'Selected account';

/** The list's column labels, in the order the SDK row lays its cells out. */
const LIST_COLUMNS: readonly string[] = ['Lifecycle', 'Account', 'Bindings'];

/**
 * Repaint the open row: its words, both members' fields, and the two
 * confirmations.
 *
 * @param rt - Panel runtime.
 * @param view - The mounted body.
 */
function repaintDetail(rt: PanelRuntime, view: AccountsBody): void {
    const { bindings, accounts } = rt.state;
    const selected = bindings.accounts.find(
        (candidate) => candidate.numericUserId === accounts.selected,
    );
    const id = selected?.numericUserId ?? null;

    view.detailBox.hidden = selected === undefined;
    view.detail.update({ text: detailText({ bindings, accounts, selected }) });
    view.detailChips.paint(selected ?? null);
    // One repaint path for both members: each field reads the same view its
    // mount built, so a draft, a refusal, and FR-064's not-set state cannot
    // disagree with what the mount showed (FR-063, FR-064, FR-085).
    for (const member of PROFILE_MEMBERS) {
        const painted = accountFieldView(member, { accounts, account: selected });
        const control = view.members[member];
        control.field.update({
            value: painted.value,
            disabled: painted.disabled,
            helper: painted.helper,
            placeholder: painted.placeholder,
        });
        control.save.update({ disabled: painted.disabled });
    }
    view.rotateToken.update({
        label: armLabel({
            armed: accounts.rotateArmed,
            id,
            armedLabel: ROTATE_ARMED_LABEL,
            idleLabel: ROTATE_IDLE_LABEL,
        }),
        disabled: id === null,
    });
    view.removeAccount.update({
        label: armLabel({
            armed: accounts.removeArmed,
            id,
            armedLabel: REMOVE_ARMED_LABEL,
            idleLabel: REMOVE_IDLE_LABEL,
        }),
        disabled: id === null,
    });
}

/**
 * Repaint the Accounts body from state (FR-062, FR-063, FR-067).
 *
 * @param rt - Panel runtime.
 * @param view - The mounted body.
 */
export function repaintAccountsBody(rt: PanelRuntime, view: AccountsBody): void {
    const { bindings } = rt.state;
    const usable = bindings.accounts.filter((account) => account.usable).length;

    view.status.update({
        text: composeStatus({ total: bindings.accounts.length, usable }),
    });
    view.list.update({ items: accountRows(bindings) });
    view.refreshAccounts.update({ disabled: bindings.status === 'loading' });
    repaintDetail(rt, view);
    view.note.update({ text: rt.state.accounts.note });
}

/**
 * Mount the relocated one-shot handoff group: paste → connect, with the
 * static disclaimer beneath it and no Accept/Decline step (002 FR-060 as
 * re-cut at v1.9.0 — the substance the consent copy carried is that
 * disclaimer).
 *
 * @param rt - Panel runtime whose handoff state the group renders.
 * @param pane - Pane root the group mounts into.
 */
function mountHandoffGroup(rt: PanelRuntime, pane: HTMLElement): void {
    rt.handoffView = mountHandoffDom({
        root: pane,
        handlers: {
            submit: (token: string, expectedLogin: string): void => {
                void submitHandoffAndRepaint(rt, { token, expectedLogin });
            },
        },
    });
    refreshHandoff(rt);
}

/** The three handles the list half of the body mounts. */
interface ListBoard {
    /** Status line above the list. */
    readonly status: TextHandle;
    /** The account list itself. */
    readonly list: ListHandle;
    /** Explicit re-read button. */
    readonly refreshAccounts: ButtonHandle;
    /** Note under the body. */
    readonly note: TextHandle;
}

/**
 * Mount the status line, list, refresh, note, and the disclaimer, as re-cut at v1.9.0 (002 FR-008).
 *
 * @param input - Runtime, pane root, and the callbacks the controls invoke.
 * @returns The handles the body carries.
 */
function mountListBoard(input: {
    /** Runtime whose state the body repaints from. */
    readonly rt: PanelRuntime;
    /** Pane root the controls mount into. */
    readonly pane: HTMLElement;
    /** Callbacks the list and refresh invoke. */
    readonly handlers: AccountsHandlers;
}): ListBoard {
    const text = composeStatus({ total: 0, usable: 0 });
    const status = mountStyledText(input.pane, { className: 'mt-lede', text });
    const grid = input.pane.ownerDocument.createElement('div');
    grid.className = 'mt-list';
    input.pane.append(grid);
    mountColumnHead(grid, { modifier: 'mt-head--accounts', cells: LIST_COLUMNS });
    const list = mountList(grid, {
        items: [],
        ariaLabel: LIST_HEADING,
        emptyText: 'No account yet — connect one above or refresh.',
        onSelect: (id: string) => input.handlers.selectAccount(id),
    });
    const refreshAccounts = mountButton(
        input.pane,
        { label: 'Refresh accounts', variant: 'secondary', onClick: input.handlers.refresh },
    );
    const note = mountText(input.pane, { text: input.rt.state.accounts.note });
    // The disclaimer sits beneath the Accounts list: always visible, purely
    // informational, and mounted once with the block it lives in — it has no
    // state to repaint and no control to wire.
    mountAccountsDisclaimer(input.pane);

    return { status, list, refreshAccounts, note };
}

/**
 * Mount one profile member's field and its save control (FR-066, 004 FR-089).
 *
 * Both members mount the same way — the draft/label flow the display name
 * shipped with — because the two saves are one helper behind one route (004
 * FR-082), and a second shape would be a second place the flow could be got
 * wrong. The field renders the words `accountFieldView` derives, so mount
 * and repaint can never disagree (FR-063's guidance, FR-064's not-set state).
 *
 * @param input - The runtime, the pane, the member, and its callbacks.
 * @returns The field, the button, and their disposer.
 */
function mountMemberControls(input: {
    /** Runtime whose state the field mounts from. */
    readonly rt: PanelRuntime;
    /** Detail box the controls mount into. */
    readonly pane: HTMLElement;
    /** Which profile member this pair edits. */
    readonly member: AccountMember;
    /** Callbacks the field and the save control invoke. */
    readonly handlers: AccountsHandlers;
}): MemberControls {
    const { rt, pane, member, handlers } = input;
    const view = accountFieldView(member, { accounts: rt.state.accounts, account: undefined });
    const onChange = member === 'displayName' ? handlers.setDisplayName : handlers.setStartingPrompt;
    const onSave = member === 'displayName' ? handlers.submitDisplayName : handlers.submitStartingPrompt;
    const field = mountTextField(pane, {
        label: view.label,
        value: view.value,
        placeholder: view.placeholder,
        ...(view.multiline ? { multiline: true, rows: 4 } : {}),
        disabled: view.disabled,
        helper: view.helper,
        onChange,
    });
    const save = mountButton(pane, {
        label: view.saveLabel,
        variant: 'secondary',
        disabled: view.disabled,
        onClick: onSave,
    });

    return {
        field,
        save,
        dispose: (): void => {
            field.dispose();
            save.dispose();
        },
    };
}

/**
 * Mount the selected row's controls: both profile members, rotate, and remove.
 *
 * They live **inside** the detail box, so a row with nothing selected hides
 * them with it — a control that acts on a selection cannot exist without one.
 *
 * @param input - The runtime, the detail box, and the callbacks to wire.
 * @returns The handles plus their disposer.
 */
function mountDetailControls(input: {
    /** Runtime whose state the fields mount from. */
    readonly rt: PanelRuntime;
    /** Detail box the controls mount into. */
    readonly pane: HTMLElement;
    /** Callbacks the controls invoke. */
    readonly handlers: AccountsHandlers;
}): {
    /** The two editable members' controls, keyed by member (FR-066, FR-089). */
    readonly members: Readonly<Record<AccountMember, MemberControls>>;
    /** Two-step rotation control (FR-064). */
    readonly rotateToken: ButtonHandle;
    /** Two-step removal control (FR-055, FR-065). */
    readonly removeAccount: ButtonHandle;
    /** Release every handle (FR-017). */
    readonly dispose: () => void;
} {
    const mount = (member: AccountMember): MemberControls =>
        mountMemberControls({ rt: input.rt, pane: input.pane, member, handlers: input.handlers });
    const members = { displayName: mount('displayName'), startingPrompt: mount('startingPrompt') };
    const rotateRow = mountButton(input.pane, {
        label: ROTATE_IDLE_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: input.handlers.rotateToken,
    });
    const removeRow = mountButton(input.pane, {
        label: REMOVE_IDLE_LABEL,
        variant: 'outline',
        disabled: true,
        onClick: input.handlers.removeAccount,
    });

    return {
        members,
        rotateToken: rotateRow,
        removeAccount: removeRow,
        dispose: (): void => {
            members.displayName.dispose();
            members.startingPrompt.dispose();
            rotateRow.dispose();
            removeRow.dispose();
        },
    };
}

/** Everything the Accounts body's disposer releases, as one value. */
interface AccountsParts {
    /** Status, list, refresh, and note. */
    readonly board: ListBoard;
    /** The open row's own line. */
    readonly detail: TextHandle;
    /** The open row's two member fields, rotation, and removal controls. */
    readonly controls: ReturnType<typeof mountDetailControls>;
    /** The open row's card, which doubles as its heading's wrapper. */
    readonly detailBox: HTMLElement;
    /** The open row's chip row. */
    readonly detailChips: DetailChips;
    /** The body root. */
    readonly pane: HTMLElement;
}

/**
 * Build the disposer that releases every node and handle the body mounted.
 *
 * @param parts - What the mount created.
 * @returns The disposer the body hands its caller (FR-017).
 */
function accountsDisposer(parts: AccountsParts): () => void {
    const { board, detail, controls, detailBox, detailChips, pane } = parts;

    return (): void => {
        board.status.dispose();
        board.list.dispose();
        board.refreshAccounts.dispose();
        board.note.dispose();
        detailChips.dispose();
        detail.dispose();
        controls.dispose();
        detailBox.remove();
        pane.remove();
    };
}

/**
 * Mount the Accounts body: handoff group, list, detail, and note.
 *
 * @param input - Runtime, body container, and the callbacks the controls use.
 * @returns The mounted body's handles.
 */
export function mountAccountsBody(input: {
    /** Runtime whose state the body repaints from. */
    readonly rt: PanelRuntime;
    /** Body container the shell created for the Accounts tab. */
    readonly body: HTMLElement;
    /** Callbacks the list and refresh invoke. */
    readonly handlers: AccountsHandlers;
}): AccountsBody {
    const { rt, body, handlers } = input;
    const pane = body.ownerDocument.createElement('div');
    body.append(pane);

    // Three blocks: how an account arrives, which ones are here, and what the
    // open row's own controls do to it. The first carries the tab title (one
    // rule across the six tabs, 2026-10-01). The third block *is* the detail
    // wrapper, so hiding it hides its heading too — a heading over an empty
    // region would be worse than no region at all.
    const connectBlock = createBlock(pane, { heading: CONNECT_HEADING, title: true });
    const listBlock = createBlock(pane, { heading: LIST_HEADING });
    const selectedBlock = createBlock(pane, { heading: SELECTED_HEADING });

    mountHandoffGroup(rt, connectBlock.body);
    const board = mountListBoard({ rt, pane: listBlock.body, handlers });
    const detailBox = selectedBlock.body;
    detailBox.hidden = true;
    const detailChips = mountDetailChips(detailBox);
    const detail = mountText(detailBox, { text: '' });
    const controls = mountDetailControls({ rt, pane: detailBox, handlers });

    const view: AccountsBody = {
        pane,
        status: board.status,
        list: board.list,
        refreshAccounts: board.refreshAccounts,
        detailBox,
        detailChips,
        detail,
        members: controls.members,
        rotateToken: controls.rotateToken,
        removeAccount: controls.removeAccount,
        note: board.note,
        dispose: accountsDisposer({ board, detail, controls, detailBox, detailChips, pane }),
    };

    rt.accountsUi = view;
    repaintAccountsBody(rt, view);
    // Nothing has ever been read when the panel mounted against a service
    // that was still spawning; this is that read's one retry path (FR-019).
    if (rt.state.bindings.status === 'idle') {
        void loadBindings(rt);
    }

    return view;
}

/**
 * Record the account row the operator opened (FR-062).
 *
 * Selecting a different row closes whatever the previous one had open: both
 * members' drafts and both armed controls belong to a row, and carrying them
 * across would let a confirm step — or a save — fire against the wrong
 * account (FR-066, 004 FR-089).
 *
 * @param rt - Panel runtime.
 * @param id - Numeric user id of the row the operator selected.
 */
export function selectAccountRow(rt: PanelRuntime, id: string): void {
    if (rt.disposed) {
        return;
    }

    const { accounts, bindings } = rt.state;
    if (accounts.selected !== id) {
        const opened = bindings.accounts.find((candidate) => candidate.numericUserId === id);
        // Each draft belongs to the row it was loaded for — that is what makes
        // a saved member impossible to apply to the wrong account — and both
        // confirmations belong to the row too, so an armed click can never
        // fire against the account the operator just opened.
        accounts.selected = id;
        setMemberEdit({ accounts, member: 'displayName', row: id, value: opened?.displayName ?? '' });
        setMemberEdit({ accounts, member: 'startingPrompt', row: id, value: opened?.startingPrompt ?? '' });
        accounts.removeArmed = null;
        accounts.rotateArmed = null;
    }

    refresh(rt);
}

/**
 * Map the Accounts body's callbacks onto the existing actions.
 *
 * Every row-scoped callback resolves the open row first, so a control with
 * no selection does nothing rather than acting on the first row it finds.
 *
 * @param rt - Panel runtime the actions read and repaint.
 * @returns The handler table for {@link mountAccountsBody}.
 */
export function createAccountsHandlers(rt: PanelRuntime): AccountsHandlers {
    return {
        selectAccount: (id) => selectAccountRow(rt, id),
        refresh: () => void loadBindings(rt),
        setDisplayName: (value) => editAccounts(rt, {
            displayNameDraft: value,
            displayNameError: null,
        }),
        submitDisplayName: (): void => {
            const { accounts } = rt.state;
            if (accounts.selected !== null) {
                void saveDisplayName(rt, {
                    numericUserId: accounts.selected,
                    value: accounts.displayNameDraft,
                });
            }
        },
        setStartingPrompt: (value) => editAccounts(rt, {
            startingPromptDraft: value,
            startingPromptError: null,
        }),
        submitStartingPrompt: (): void => {
            const { accounts } = rt.state;
            if (accounts.selected !== null) {
                void saveStartingPrompt(rt, {
                    numericUserId: accounts.selected,
                    value: accounts.startingPromptDraft,
                });
            }
        },
        rotateToken: (): void => {
            if (rt.state.accounts.selected !== null) {
                toggleRotation(rt, rt.state.accounts.selected);
            }
        },
        removeAccount: (): void => {
            const { accounts } = rt.state;
            if (accounts.selected === null) {
                return;
            }

            if (accounts.removeArmed === accounts.selected) {
                void removeAccount(rt, accounts.selected);

                return;
            }

            armAccountRemoval(rt, accounts.selected);
        },
    };
}
