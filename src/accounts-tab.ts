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

import { mountButton, mountList, mountText } from '@openchamber/sdk/ui';
import type { ButtonHandle, ListHandle, TextHandle } from '@openchamber/sdk/ui';
import {
    acceptConsentAndRepaint,
    mountHandoffDom,
    refreshHandoff,
    submitHandoffAndRepaint,
} from './accounts-ui.ts';
import { declineHandoffConsent } from './handoff.ts';
import { loadBindings } from './bindings.ts';
import { accountDetail, accountRows } from './accounts-rows.ts';
import { refresh } from './panel-ui.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Callbacks the mounted Accounts body invokes. */
export interface AccountsHandlers {
    /** The operator opened one account row. */
    readonly selectAccount: (id: string) => void;
    /** The operator asked for a fresh accounts read. */
    readonly refresh: () => void;
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
    /** The selected account's state, connection, scope, and remediation. */
    readonly detail: TextHandle;
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

/**
 * Repaint the Accounts body from state (FR-062, FR-063, FR-067).
 *
 * The detail line follows the selection: a row with nothing selected hides
 * it rather than describing a row the operator is not looking at.
 *
 * @param rt - Panel runtime.
 * @param view - The mounted body.
 */
export function repaintAccountsBody(rt: PanelRuntime, view: AccountsBody): void {
    const { bindings, accounts } = rt.state;
    const usable = bindings.accounts.filter((account) => account.usable).length;

    view.status.update({
        text: composeStatus({ total: bindings.accounts.length, usable }),
    });
    view.list.update({ items: accountRows(bindings) });
    view.refreshAccounts.update({ disabled: bindings.status === 'loading' });
    const selected = bindings.accounts.find(
        (candidate) => candidate.numericUserId === accounts.selected,
    );
    view.detailBox.hidden = selected === undefined;
    view.detail.update({
        text: selected === undefined ? '' : accountDetail(bindings, selected),
    });
    view.note.update({ text: accounts.note });
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
    const status = mountText(input.pane, { text: composeStatus({ total: 0, usable: 0 }) });
    const list = mountList(input.pane, {
        items: [],
        ariaLabel: 'Accounts',
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

    mountHandoffGroup(rt, pane);
    const board = mountListBoard({ rt, pane, handlers });
    const detailBox = body.ownerDocument.createElement('div');
    detailBox.hidden = true;
    pane.append(detailBox);
    const detail = mountText(detailBox, { text: '' });

    const view: AccountsBody = {
        pane,
        status: board.status,
        list: board.list,
        refreshAccounts: board.refreshAccounts,
        detailBox,
        detail,
        note: board.note,
        dispose: (): void => {
            board.status.dispose();
            board.list.dispose();
            board.refreshAccounts.dispose();
            board.note.dispose();
            detail.dispose();
            detailBox.remove();
            pane.remove();
        },
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

    const { accounts } = rt.state;
    if (accounts.selected !== id) {
        accounts.selected = id;
        accounts.displayNameRow = null;
        accounts.displayNameDraft = '';
        accounts.displayNameError = null;
        accounts.removeArmed = null;
        accounts.rotateArmed = null;
    }

    refresh(rt);
}

/**
 * Map the Accounts body's callbacks onto the existing actions.
 *
 * @param rt - Panel runtime the actions read and repaint.
 * @returns The handler table for {@link mountAccountsBody}.
 */
export function createAccountsHandlers(rt: PanelRuntime): AccountsHandlers {
    return {
        selectAccount: (id) => selectAccountRow(rt, id),
        refresh: () => void loadBindings(rt),
    };
}
