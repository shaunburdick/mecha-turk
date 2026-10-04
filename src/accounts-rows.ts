/**
 * The Accounts tab's rows and the selected account's detail (005 FR-062–FR-069).
 *
 * A row is where the operator finds out *whether an account can poll*, so it
 * carries every member FR-062 names — display name (falling back to the
 * login), login, numeric id, lifecycle state, connection state, last
 * verified stamp, the four-capability scope matrix, the error reason when the
 * state is `error`, and how many bindings the account backs — as **text**, so
 * a state is never carried by colour alone (FR-083).
 *
 * Three rules live here rather than at the call site, because a second place
 * they could be got wrong is a second chance to violate them:
 *
 * - **First-class bad states** (FR-063): `rejected`, `revoked`, and `error`
 *   each render their own words plus a remediation, and `pending_handoff` is
 *   told apart from `error` + `interrupted-handoff` while the two share one
 *   remediation line (FR-068) — an operator who has connected something and
 *   has not is never left guessing which of the two they are looking at.
 * - **Nothing credential-shaped** (FR-067, FR-069): the DTO is credential-free
 *   by construction and this module renders strings only — no token, no
 *   scope edit, no read-back.
 * - **Unknown is unknown** (FR-003): a member the DTO did not carry reads
 *   *not reported*, never a plausible default; a state outside the six reads
 *   `unknown state: <raw>` rather than being mapped to a friendly guess.
 *
 * Everything here is a pure function of panel state, so the copy is testable
 * without a DOM.
 */

import type { ListItem } from '@openchamber/sdk/ui';
import { elapsedSince } from './bindings-rows.ts';
import type { BindingsTabState } from './panel-state.ts';
import type { AccountsTabState, AccountMember } from './accounts-state.ts';
import { memberDraft, memberRefusal, memberRow } from './accounts-state.ts';
import type { PanelAccount } from './bindings-service.ts';

/**
 * The remediation `pending_handoff` and `error` + `interrupted-handoff` share.
 *
 * FR-068 requires the two states to be distinguishable *and* to offer the
 * same way out, so this line is one constant rather than two spellings.
 */
export const HANDOFF_REMEDIATION = 'Complete or replace the handoff to finish connecting this account.';

/** What one lifecycle state reads as: its words and the way out of it. */
interface LifecycleCopy {
    /** The words the row shows for the state. */
    readonly label: string;
    /** The remediation line, or `null` when the state needs none. */
    readonly remediation: string | null;
}

/**
 * The six lifecycle states FR-062 names, each with its remediation.
 *
 * A `Map` rather than an object literal: the keys are the service's own
 * snake_case vocabulary, and a literal would have to be written against a
 * naming rule it does not choose.
 */
const LIFECYCLE_COPY = new Map<string, LifecycleCopy>([
    ['pending_handoff', { label: 'pending handoff', remediation: HANDOFF_REMEDIATION }],
    ['verifying', { label: 'verifying', remediation: null }],
    ['active', { label: 'active', remediation: null }],
    ['rejected', { label: 'rejected', remediation: 'Rotate the token: this credential was not accepted.' }],
    ['revoked', { label: 'revoked', remediation: 'Rotate the token: this credential was revoked on GitHub.' }],
    ['error', { label: 'error', remediation: 'Rotate the token, or remove the account once nothing needs it.' }],
]);

/** Why an account was stopped short of polling, for the cause line. */
const INTERRUPTED_HANDOFF = 'interrupted-handoff';

/** Words for a connection state the DTO did not carry. */
const CONNECTION_UNREPORTED = 'connection not reported';

/** Words for a lifecycle state the DTO did not carry. */
const LIFECYCLE_UNREPORTED = 'state not reported';

/** Words for a verification stamp the DTO did not carry. */
const VERIFIED_UNREPORTED = 'last verified: not reported';

/** Words for a scope matrix the DTO did not carry. */
export const SCOPE_UNCHECKED = 'scope: not checked';

/** Order the four FR-010 capabilities render in, so two rows read alike. */
const SCOPE_ORDER = ['metadata', 'issues', 'pull-requests', 'contents'] as const;

/**
 * Read the label an account row leads with.
 *
 * The operator's display name wins when there is one and the GitHub login
 * takes over when there is not, because a name the operator chose is the
 * label they recognise — and the login is still rendered beside it, since
 * `displayName` never becomes identity.
 *
 * @param account - One credential-free account.
 * @returns The title text, verbatim (it renders as text, never as markup).
 */
export function accountTitle(account: PanelAccount): string {
    return account.displayName ?? account.login;
}

/**
 * Read one lifecycle state's words and remediation.
 *
 * @param account - One credential-free account.
 * @returns The copy to render for its `state`.
 */
export function lifecycleCopy(account: PanelAccount): LifecycleCopy {
    const { state } = account;
    if (state === undefined) {
        return { label: LIFECYCLE_UNREPORTED, remediation: null };
    }

    if (state === 'error' && account.errorReason === INTERRUPTED_HANDOFF) {
        // The same way out as `pending_handoff`, but its own words: an
        // operator must be able to tell the two apart.
        return { label: `error (${INTERRUPTED_HANDOFF})`, remediation: HANDOFF_REMEDIATION };
    }

    return LIFECYCLE_COPY.get(state) ?? { label: `unknown state: ${state}`, remediation: null };
}

/**
 * Read one connection state's words.
 *
 * The four states FR-062 names render verbatim, and so does **needs
 * reconnection**: both the status projection and the accounts mirror have
 * been seen carrying that word (the offline fixtures model it), and the
 * Status tab already prints whatever the service reported
 * (`status-lines.ts`). Calling a word the operator can read on the sibling
 * tab *unknown* is the worse lie — so it joins the known set and gets the
 * warning tone beside it, while any word **outside** the set still reads
 * `unknown connection state: <raw>` rather than being mapped to a friendly
 * guess.
 *
 * @param account - One credential-free account.
 * @returns The connection phrase, including an unreported or unknown one.
 */
export function connectionPhrase(account: PanelAccount): string {
    const { connectionState } = account;
    if (connectionState === undefined) {
        return CONNECTION_UNREPORTED;
    }

    switch (connectionState) {
        case 'connected':
        case 'auth-failed':
        case 'rate-limited':
        case 'offline':
        case 'needs reconnection':
            return connectionState;
        default:
            return `unknown connection state: ${connectionState}`;
    }
}

/**
 * How many bindings an account backs, as the rows print it.
 *
 * One place, because `1 bindings` appeared twice and a count that disagrees
 * with its own noun is the kind of detail an operator stops trusting the
 * rest of the row over (product-owner review 2026-10-01).
 *
 * @param count - How many stored bindings name this account.
 * @returns The count with its noun, singular when the count is one.
 */
export function bindingsPhrase(count: number): string {
    return `${count} ${count === 1 ? 'binding' : 'bindings'}`;
}

/**
 * Read the last-verified stamp as elapsed time.
 *
 * @param account - One credential-free account.
 * @returns `last verified <when>`, or the not-reported words when absent.
 */
export function verifiedPhrase(account: PanelAccount): string {
    if (account.verifiedAt === undefined) {
        return VERIFIED_UNREPORTED;
    }

    return `last verified ${elapsedSince(account.verifiedAt)}`;
}

/**
 * Read the four-capability scope matrix as one line.
 *
 * A matrix the DTO did not carry reads *not checked* — never *ok*: an
 * absent matrix is no evidence, and no evidence is not a pass.
 *
 * @param account - One credential-free account.
 * @returns The scope phrase.
 */
export function scopePhrase(account: PanelAccount): string {
    const matrix = account.scopeMatrix;
    if (matrix === undefined) {
        return SCOPE_UNCHECKED;
    }

    const verdicts = SCOPE_ORDER.map((capability) => `${capability} ${matrix[capability]}`);

    return `scope: ${verdicts.join(' · ')}`;
}

/**
 * Count the bindings one account backs.
 *
 * @param bindings - The Bindings tab's state, which holds the stored list.
 * @param account - The account being counted.
 * @returns How many stored bindings name this account's numeric id.
 */
export function bindingsBacked(bindings: BindingsTabState, account: PanelAccount): number {
    return bindings.bindings.filter(
        (binding) => binding.accountNumericUserId === account.numericUserId,
    ).length;
}

/**
 * The prompt words an account's row summary carries: presence and length
 * only — never the text, never a fingerprint (005 FR-051 as amended by 004
 * v1.3.0: one rendering *per tier value*, and the account tier's value
 * renders only in its own field).
 *
 * Length is counted the way 004 caps the text — by code point, so a
 * supplementary character is one and not two — and an account whose tier is
 * unset says so rather than showing nothing, because *absent*
 * is a state an operator should be able to read.
 *
 * @param account - The account being rendered.
 * @returns `prompt set · N chars`, or `prompt not set`.
 */
export function accountPromptSummary(account: PanelAccount): string {
    const { startingPrompt } = account;
    if (startingPrompt === undefined || startingPrompt === null) {
        return 'prompt not set';
    }

    return `prompt set · ${[...startingPrompt].length} chars`;
}

/**
 * Compose one account row.
 *
 * @param bindings - The Bindings tab's state, for the binding count.
 * @param account - The account to render.
 * @returns The list row, with every FR-062 member in the subtitle.
 */
export function accountRow(bindings: BindingsTabState, account: PanelAccount): ListItem {
    const lifecycle = lifecycleCopy(account);
    const parts = [
        `@${account.login}`,
        `id ${account.numericUserId}`,
        lifecycle.label,
        connectionPhrase(account),
        verifiedPhrase(account),
        scopePhrase(account),
    ];
    if (account.state === 'error' && typeof account.errorReason === 'string') {
        parts.push(`error: ${account.errorReason}`);
    }

    parts.push(bindingsPhrase(bindingsBacked(bindings, account)));
    parts.push(accountPromptSummary(account));

    return {
        id: account.numericUserId,
        leading: lifecycle.label,
        title: accountTitle(account),
        subtitle: parts.join(' · '),
        meta: String(bindingsBacked(bindings, account)),
    };
}

/**
 * Build the account list rows.
 *
 * @param bindings - The Bindings tab's state, which holds accounts and bindings.
 * @returns The rows, in stored order.
 */
export function accountRows(bindings: BindingsTabState): ListItem[] {
    return bindings.accounts.map((account) => accountRow(bindings, account));
}

/**
 * Compose one account's own line, with its remediation.
 *
 * The remediation is what separates a first-class bad state from a badge:
 * `rejected`, `revoked`, `error`, and `pending_handoff` each say what to do
 * next, and an account that is fine says nothing at all rather than
 * reassuring the operator.
 *
 * @param bindings - The Bindings tab's state, for the binding count.
 * @param account - The account to describe.
 * @returns The detail line.
 */
export function accountDetail(bindings: BindingsTabState, account: PanelAccount): string {
    const lifecycle = lifecycleCopy(account);
    const parts = [
        `${accountTitle(account)} (@${account.login}, id ${account.numericUserId})`,
        lifecycle.label,
        connectionPhrase(account),
        verifiedPhrase(account),
        scopePhrase(account),
        bindingsPhrase(bindingsBacked(bindings, account)),
        accountPromptSummary(account),
    ];
    if (account.state === 'error' && typeof account.errorReason === 'string') {
        parts.push(`error: ${account.errorReason}`);
    }
    if (lifecycle.remediation !== null) {
        parts.push(`remediation: ${lifecycle.remediation}`);
    }

    return parts.join(' · ');
}

/**
 * What a rotation keeps, stated before it happens.
 *
 * It is the operator's first question about rotation and never the one they
 * fear, so the confirmation answers it rather than asking for faith: every
 * checkpoint, delivery, dispatch, and audit record stays where it is, and the
 * only thing that changes is the credential.
 *
 * @param login - The account being rotated.
 * @returns The retention statement the armed row shows.
 */
export function rotationStatement(login: string): string {
    return (
        `Rotating the token for ${login} keeps every checkpoint, delivery, dispatch, and audit `
        + 'record for this account. Paste the replacement token above and choose Connect account.'
    );
}

/**
 * What a removal does, stated before it happens.
 *
 * The count is the whole point of the arm step: the service's hardened guard
 * disables exactly these bindings when the delete lands, and an operator who
 * is told *zero* is told zero rather than shown a vague warning.
 *
 * @param bindings - The Bindings tab's state, for the count.
 * @param account - The account about to be removed.
 * @returns The cascade statement the armed row shows.
 */
export function removalStatement(bindings: BindingsTabState, account: PanelAccount): string {
    const count = bindingsBacked(bindings, account);

    return (
        `Remove ${account.login}? ${bindingsPhrase(count)} will be disabled — they stay in the `
        + 'list with that reason, and nothing is deleted.'
    );
}

/** What the note says once a rotation landed. */
export function rotationRetained(login: string): string {
    return (
        `Token rotated for ${login} — every checkpoint, delivery, dispatch, and audit record `
        + 'for this account is retained.'
    );
}

/**
 * The confirmation the selected row owes the operator right now.
 *
 * Derived at render time from which control is armed, so the statement can
 * never be staler than the arm it describes and never needs clearing.
 *
 * @param input - The tab's working state, the stored data, and the open row.
 * @returns The statement to append to the detail line, or `null` when nothing
 *   on this row is armed.
 */
export function armStatement(input: {
    /** The Accounts tab's working state. */
    readonly accounts: AccountsTabState;
    /** The Bindings tab's state, for the count. */
    readonly bindings: BindingsTabState;
    /** The row being described. */
    readonly account: PanelAccount;
}): string | null {
    const id = input.account.numericUserId;
    if (input.accounts.removeArmed === id) {
        return removalStatement(input.bindings, input.account);
    }

    if (input.accounts.rotateArmed === id) {
        return rotationStatement(input.account.login);
    }

    return null;
}

/**
 * Compose the detail line for whatever row is open.
 *
 * @param input - The stored data, the working state, and the open row.
 * @returns The text the detail line shows.
 */
export function detailText(input: {
    /** The Bindings tab's state, for counts and the row itself. */
    readonly bindings: BindingsTabState;
    /** The Accounts tab's working state, for the armed controls. */
    readonly accounts: AccountsTabState;
    /** The open row, or `undefined` when nothing is selected. */
    readonly selected: PanelAccount | undefined;
}): string {
    if (input.selected === undefined) {
        return '';
    }

    const { bindings, accounts, selected } = input;
    const detail = accountDetail(bindings, selected);
    const arm = armStatement({ accounts, bindings, account: selected });

    return arm === null ? detail : `${detail} · ${arm}`;
}

/**
 * Which label a two-step control carries right now.
 *
 * @param input - The armed row, the open row, and the two labels.
 * @returns The label to paint.
 */
export function armLabel(input: {
    /** The row whose control is armed, or `null`. */
    readonly armed: string | null;
    /** The row the control acts on, or `null` when nothing is open. */
    readonly id: string | null;
    /** What the control reads once armed. */
    readonly armedLabel: string;
    /** What it reads otherwise. */
    readonly idleLabel: string;
}): string {
    return input.id !== null && input.armed === input.id ? input.armedLabel : input.idleLabel;
}

/** The display-name field's label and its purpose line (FR-066). */
const DISPLAY_NAME_LABEL = 'Display name for this account';

/** Help under the label field: what the member does, never a value. */
const DISPLAY_NAME_HINT = 'Shown in the list instead of the login';

/**
 * The account-tier field's label (004 FR-089).
 *
 * The binding tier's label says *from this repository*; this one says *from
 * this account*, so two fields carrying two different values never read as
 * one — the single-rendering rule is about a *value*, and distinct labels
 * keep the surfaces distinct too.
 */
export const ACCOUNT_PROMPT_LABEL = 'Starting prompt for dispatches from this account';

/**
 * FR-063's guidance, fixed beside the account-tier field (research R-4: the
 * Settings row takes its guidance from the service-declared `format`, the
 * Accounts field carries a fixed helper of its own).
 *
 * All five facts FR-063 requires the surface to convey, in the operator's
 * terms: sent verbatim, no placeholders, the pinned Default Agent, the
 * refusal shape, and the cap. It is *fixed* copy on purpose — a panel
 * sentence must never become a second validator that disagrees with the one
 * the service runs.
 */
export const ACCOUNT_PROMPT_GUIDANCE =
    'Sent to the agent verbatim — there are no placeholders, and the text cannot change the '
    + 'pinned Default Agent. A credential-shaped value is refused rather than stored, and the '
    + 'cap is 2,000 characters.';

/**
 * FR-064's honest-absence word, rendered where the prompt's text would be.
 *
 * An empty text box reads as an empty instruction the agent will receive;
 * this says otherwise in the one slot an empty editor leaves visible.
 */
export const ACCOUNT_PROMPT_NOT_SET = 'not set';

/** What one profile member's field renders right now. */
export interface AccountFieldView {
    /** The field's accessible name (FR-081). */
    readonly label: string;
    /** The draft the input holds. */
    readonly value: string;
    /** Shown only while the input is empty — never typed into the value. */
    readonly placeholder: string;
    /** The service's refusal when there is one, else this field's help. */
    readonly helper: string;
    /** Whether the field can be typed into (it needs an open row). */
    readonly disabled: boolean;
    /** Whether the input is multiline — the prompt is, the label is not. */
    readonly multiline: boolean;
}

/**
 * Derive one profile member's field from state.
 *
 * Pure, and the only place either field's words are decided, so mount and
 * repaint cannot drift apart and a test can read the copy without a DOM.
 * The service stays the single save boundary: nothing here
 * validates, lengths, or shapes the draft — it only says what to show and
 * whether the row the draft was loaded for is still the one on screen.
 *
 * @param member - Which editable member to describe.
 * @param input - The tab's working state and the open row, if any.
 * @returns The words and posture the field renders with.
 */
export function accountFieldView(
    member: AccountMember,
    input: {
        /** The Accounts tab's working state. */
        readonly accounts: AccountsTabState;
        /** The open row, or `undefined` when nothing is selected. */
        readonly account: PanelAccount | undefined;
    },
): AccountFieldView {
    const { accounts, account } = input;
    const value = memberDraft(accounts, member);
    const refusal = memberRefusal(accounts, member);
    // Editable only while the open row *is* the row on screen: nothing
    // selected, or a draft that outlived its selection, both read as disabled
    // (FR-066's open-row guard, 004 FR-089's per-account field).
    const disabled = memberRow(accounts, member) !== account?.numericUserId;

    if (member === 'displayName') {
        return {
            label: DISPLAY_NAME_LABEL,
            value,
            placeholder: DISPLAY_NAME_HINT,
            helper: refusal ?? '',
            disabled,
            multiline: false,
        };
    }

    return {
        label: ACCOUNT_PROMPT_LABEL,
        value,
        placeholder: ACCOUNT_PROMPT_NOT_SET,
        helper: refusal ?? ACCOUNT_PROMPT_GUIDANCE,
        disabled,
        multiline: true,
    };
}
