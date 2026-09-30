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
 * scoping are unit-testable without a DOM. The mounted line at the bottom is
 * the thin renderer, and it deliberately imports neither `panel-ui` nor
 * `bindings.ts` — this module is composed by `bindings-ui`, so it has to stay
 * a leaf.
 */

import { mountText } from '@openchamber/sdk/ui';
import type { SelectOption, TextHandle } from '@openchamber/sdk/ui';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { PanelBinding } from './bindings-service.ts';

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

/** The mention-token line as the editor renders it (FR-057). */
export interface MentionTokenView {
    /** The rendered line; text only, never markup (FR-080). */
    readonly line: string;
    /** Whether the line marks the token as differing from the account's own. */
    readonly override: boolean;
}

/**
 * Read the binding the editor is open on.
 *
 * @param bindings - The Bindings tab's state.
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
 * The two logins the mention-token line compares (FR-057, ruling 2).
 *
 * `login` is the one the rendered token is built from — the binding's own
 * `accountLogin` in edit mode, the draft's account in add mode. `current` is
 * the account's login as the service lists it **now**; it is `null` when the
 * panel cannot establish one (no account selected, or the account is gone),
 * and a `null` current is what stops the override mark from firing.
 *
 * @param bindings - The Bindings tab's state.
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
 * Derive the mention token the service matches on for this editor (FR-057).
 *
 * Edit mode reads the selected binding's own `accountLogin` — the value
 * `mentionsLogin` is called with. Add mode reads the account the draft is
 * bound to, which is the token the new binding would match on. The override
 * mark fires only when both a current login is known and the two differ
 * case-insensitively: a binding whose account was removed cannot be compared,
 * and claiming an override without a comparison would be exactly the invented
 * value FR-003 forbids.
 *
 * @param bindings - The Bindings tab's state.
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
 * Scope the bound-account field to the editor's mode (ruling 5, FR-053).
 *
 * Edit mode fixes the field to the selected binding's own account — one
 * option, that binding's own id and login, no free select — which is what
 * makes a displayed value and a saved value unable to disagree. Add mode
 * lists the accounts available to bind (`usable` only: an account that cannot
 * poll is not an account a binding should be created under).
 *
 * @param bindings - The Bindings tab's state.
 * @returns How the select must render.
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
 * @param bindings - The Bindings tab's state, which holds the draft choice.
 * @param setWorktree - Handler that records one of the two options.
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
 * @param input - Runtime whose state the line derives from, and the pane root.
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
 *
 * @param rt - Panel runtime.
 * @param line - The mounted line.
 */
export function repaintBindingMention(rt: PanelRuntime, line: TextHandle): void {
    line.update({ text: mentionTokenView(rt.state.bindings).line });
}
