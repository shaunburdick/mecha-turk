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

import { mountButton, mountList, mountText } from '@openchamber/sdk/ui';
import type { ButtonHandle, ListHandle, TextHandle } from '@openchamber/sdk/ui';
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
    saveProfile,
    toggleRotation,
} from './accounts-actions.ts';
import { loadBindings } from './bindings.ts';
import { accountFieldView, accountRows, armLabel, detailText } from './accounts-rows.ts';
import {
    REMOVE_ARMED_LABEL,
    REMOVE_IDLE_LABEL,
    ROTATE_ARMED_LABEL,
    ROTATE_IDLE_LABEL,
    mountDetailControls,
} from './accounts-detail.ts';
import type { DetailControls } from './accounts-detail.ts';
import { PROFILE_MEMBERS, setMemberEdit } from './accounts-state.ts';
import type { AccountsHandlers } from './accounts-state.ts';
import { mountDetailChips } from './accounts-chips.ts';
import type { DetailChips } from './accounts-chips.ts';
import { refresh } from './panel-ui.ts';
import { createBlock, mountColumnHead, mountStyledText } from './style.ts';
import type { PanelRuntime } from './panel-state.ts';

/** The Accounts body handle: the mounted element and its repaint handles. */
export interface AccountsBody {
    /** The body root this view mounted. */
    readonly pane: HTMLElement;
    /** Status line above the list. */
    readonly status: TextHandle;
    /** The credential-free account list. */
    readonly list: ListHandle;
    /** Explicit re-read of the accounts list. */
    readonly refreshAccounts: ButtonHandle;
    /** Wrapper around the selected account's own line. */
    readonly detailBox: HTMLElement;
    /** Chip row over that line: the account's connection and scope. */
    readonly detailChips: DetailChips;
    /** The selected account's state, connection, scope, and remediation. */
    readonly detail: TextHandle;
    /**
     * The selected row's controls — two profile fields, the **one** save
     * that writes them together (owner ruling, PR #12: "One Save button,
     * both fields"), and the two-step rotate/remove pair.
     */
    readonly controls: DetailControls;
    /** Note under the body; never credential material. */
    readonly note: TextHandle;
    /** Remove every node this body mounted. */
    readonly dispose: () => void;
}

/**
 * Compose the body's one status line.
 *
 * @returns The summary text the status line shows.
 */
function composeStatus(input: { readonly total: number; readonly usable: number }): string {
    return `Accounts: ${input.total} (${input.usable} can poll)`;
}

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
    // disagree with what the mount showed. The
    // shared save is offered only while **both** fields are editable — it
    // writes both members in one body, so one closed row closes it
    // (owner ruling, PR #12: "One Save button, both fields").
    const views = PROFILE_MEMBERS.map((member) => ({
        member,
        painted: accountFieldView(member, { accounts, account: selected }),
    }));
    for (const { member, painted } of views) {
        view.controls.members[member].field.update({
            value: painted.value,
            disabled: painted.isDisabled,
            helper: painted.helper,
            placeholder: painted.placeholder,
        });
    }
    view.controls.saveProfile.update({ disabled: views.some(({ painted }) => painted.isDisabled) });
    view.controls.rotateToken.update({
        label: armLabel({
            armed: accounts.rotateArmed,
            id,
            armedLabel: ROTATE_ARMED_LABEL,
            idleLabel: ROTATE_IDLE_LABEL,
        }),
        disabled: id === null,
    });
    view.controls.removeAccount.update({
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
 * Repaint the Accounts body from state.
 *
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
 * re-cut — the substance the consent copy carried is that
 * disclaimer).
 *
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
 * Mount the status line, list, refresh, note, and the disclaimer, as re-cut.
 *
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
 * @returns The disposer the body hands its caller.
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
        controls,
        note: board.note,
        dispose: accountsDisposer({ board, detail, controls, detailBox, detailChips, pane }),
    };

    rt.accountsUi = view;
    repaintAccountsBody(rt, view);
    // Nothing has ever been read when the panel mounted against a service
    // that was still spawning; this is that read's one retry path.
    if (rt.state.bindings.status === 'idle') {
        void loadBindings(rt);
    }

    return view;
}

/**
 * Record the account row the operator opened.
 *
 * Selecting a different row closes whatever the previous one had open: both
 * members' drafts and both armed controls belong to a row, and carrying them
 * across would let a confirm step — or a save — fire against the wrong
 * account.
 *
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
        setStartingPrompt: (value) => editAccounts(rt, {
            startingPromptDraft: value,
            startingPromptError: null,
        }),
        // One handler behind the one control: both drafts travel together,
        // so a save can never write one field and silently leave the other at
        // whatever the row opened with (owner ruling, PR #12).
        submitProfile: (): void => {
            const { accounts } = rt.state;
            if (accounts.selected !== null) {
                void saveProfile(rt, {
                    numericUserId: accounts.selected,
                    displayName: accounts.displayNameDraft,
                    startingPrompt: accounts.startingPromptDraft,
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
