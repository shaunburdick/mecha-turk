/**
 * The Accounts body (005 FR-060–FR-069, T-024).
 *
 * The account custody surface, relocated onto its own tab: the one-shot
 * handoff group (the flow itself unchanged — FR-061) above the credential-free
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
    acceptConsentAndRepaint,
    mountHandoffDom,
    refreshHandoff,
    submitHandoffAndRepaint,
} from './accounts-ui.ts';
import {
    armAccountRemoval,
    editAccounts,
    removeAccount,
    saveDisplayName,
    toggleRotation,
} from './accounts-actions.ts';
import { declineHandoffConsent } from './handoff.ts';
import { loadBindings } from './bindings.ts';
import { accountRows, armLabel, detailText } from './accounts-rows.ts';
import { mountDetailChips } from './accounts-chips.ts';
import type { DetailChips } from './accounts-chips.ts';
import { refresh } from './panel-ui.ts';
import { createBlock, mountColumnHead, mountStyledText } from './style.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Callbacks the mounted Accounts body invokes. */
export interface AccountsHandlers {
    /** The operator opened one account row. */
    readonly selectAccount: (id: string) => void;
    /** The operator asked for a fresh accounts read. */
    readonly refresh: () => void;
    /** The operator typed into the display-name field (FR-066). */
    readonly setDisplayName: (value: string) => void;
    /** The operator saved the display name (FR-066, AC-130). */
    readonly submitDisplayName: () => void;
    /** The operator armed or cancelled the token rotation (FR-064). */
    readonly rotateToken: () => void;
    /** The operator armed, then confirmed, the removal (FR-055, FR-065). */
    readonly removeAccount: () => void;
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
    /** The selected account's operator display label (FR-066). */
    readonly displayNameField: TextFieldHandle;
    /** Writes the display name through the narrow route (FR-066). */
    readonly saveDisplayName: ButtonHandle;
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
 * Repaint the open row: its words, its label field, and its two confirmations.
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
    const editable = id !== null && accounts.displayNameRow === id;

    view.detailBox.hidden = selected === undefined;
    view.detail.update({ text: detailText({ bindings, accounts, selected }) });
    view.detailChips.paint(selected ?? null);
    view.displayNameField.update({
        value: accounts.displayNameDraft,
        disabled: !editable,
        helper: accounts.displayNameError ?? '',
    });
    view.saveDisplayName.update({ disabled: !editable });
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
 * Mount the relocated one-shot handoff group (FR-060, FR-061).
 *
 * The flow is relocated, not redesigned: the same consent gate, storage
 * pre-flight, and one-shot paste the panel has always run, now pointed at
 * the container the shell created for the Accounts tab.
 *
 * @param rt - Panel runtime whose handoff state the group renders.
 * @param pane - Pane root the group mounts into.
 */
function mountHandoffGroup(rt: PanelRuntime, pane: HTMLElement): void {
    rt.handoffView = mountHandoffDom({
        root: pane,
        handlers: {
            accept: (): void => {
                void acceptConsentAndRepaint(rt);
            },
            decline: (): void => {
                declineHandoffConsent(rt);
                refreshHandoff(rt);
            },
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
 * Mount the status line, the list, its refresh, and the note.
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

    return { status, list, refreshAccounts, note };
}

/**
 * Mount the display-name field and its save control (FR-066).
 *
 * @param input - The detail box to mount into and the callbacks to wire.
 * @returns The field, the button, and their disposer.
 */
function mountDisplayNameControls(input: {
    /** Detail box the controls mount into. */
    readonly pane: HTMLElement;
    /** Callbacks the controls invoke. */
    readonly handlers: AccountsHandlers;
}): {
    /** The display-name field itself. */
    readonly nameField: TextFieldHandle;
    /** Writes the label through the narrow route. */
    readonly saveName: ButtonHandle;
    /** Release both handles (FR-017). */
    readonly dispose: () => void;
} {
    const nameField = mountTextField(input.pane, {
        label: 'Display name for this account',
        value: '',
        placeholder: 'Shown in the list instead of the login',
        disabled: true,
        onChange: (value) => input.handlers.setDisplayName(value),
    });
    const saveName = mountButton(input.pane, {
        label: 'Save display name',
        variant: 'secondary',
        disabled: true,
        onClick: input.handlers.submitDisplayName,
    });

    return {
        nameField,
        saveName,
        dispose: (): void => {
            nameField.dispose();
            saveName.dispose();
        },
    };
}

/**
 * Mount the selected row's controls: display name, rotate, and remove.
 *
 * They live **inside** the detail box, so a row with nothing selected hides
 * them with it — a control that acts on a selection cannot exist without one.
 *
 * @param input - The detail box to mount into and the callbacks to wire.
 * @returns The four handles plus their disposer.
 */
function mountDetailControls(input: {
    /** Detail box the controls mount into. */
    readonly pane: HTMLElement;
    /** Callbacks the controls invoke. */
    readonly handlers: AccountsHandlers;
}): {
    /** Display-name field (FR-066). */
    readonly displayNameField: TextFieldHandle;
    /** Saves the display name (FR-066). */
    readonly saveDisplayName: ButtonHandle;
    /** Two-step rotation control (FR-064). */
    readonly rotateToken: ButtonHandle;
    /** Two-step removal control (FR-055, FR-065). */
    readonly removeAccount: ButtonHandle;
    /** Release the four handles (FR-017). */
    readonly dispose: () => void;
} {
    const label = mountDisplayNameControls(input);
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
        displayNameField: label.nameField,
        saveDisplayName: label.saveName,
        rotateToken: rotateRow,
        removeAccount: removeRow,
        dispose: (): void => {
            label.dispose();
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
    /** The open row's display-name, rotation, and removal controls. */
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
    // open row's own controls do to it. The third block *is* the detail
    // wrapper, so hiding it hides its heading too — a heading over an empty
    // region would be worse than no region at all.
    const connectBlock = createBlock(pane, { heading: CONNECT_HEADING });
    const listBlock = createBlock(pane, { heading: LIST_HEADING });
    const selectedBlock = createBlock(pane, { heading: SELECTED_HEADING });

    mountHandoffGroup(rt, connectBlock.body);
    const board = mountListBoard({ rt, pane: listBlock.body, handlers });
    const detailBox = selectedBlock.body;
    detailBox.hidden = true;
    const detailChips = mountDetailChips(detailBox);
    const detail = mountText(detailBox, { text: '' });
    const controls = mountDetailControls({ pane: detailBox, handlers });

    const view: AccountsBody = {
        pane,
        status: board.status,
        list: board.list,
        refreshAccounts: board.refreshAccounts,
        detailBox,
        detailChips,
        detail,
        displayNameField: controls.displayNameField,
        saveDisplayName: controls.saveDisplayName,
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
 * Selecting a different row closes whatever the previous one had open: the
 * display-name draft and both armed controls belong to a row, and carrying
 * them across would let a confirm step fire against the wrong account.
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
        // The draft belongs to the row it was loaded for — that is what makes
        // a saved display name impossible to apply to the wrong account —
        // and both confirmations belong to the row too, so an armed click can
        // never fire against the account the operator just opened.
        accounts.selected = id;
        accounts.displayNameRow = id;
        accounts.displayNameDraft = opened?.displayName ?? '';
        accounts.displayNameError = null;
        accounts.removeArmed = null;
        accounts.rotateArmed = null;
    }

    refresh(rt);
}

/**
 * Map the Accounts body's callbacks onto the existing actions.
 *
 * Every row-scoped callback resolves the open row first: the detail block
 * only ever describes one account, so a control with no selection simply
 * does nothing rather than acting on the first row it finds.
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
