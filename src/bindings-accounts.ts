/**
 * The Bindings tab's **accounts side**: the gate on *New binding*, the reason
 * it is blocked, the list's empty text, and the add form's account refusal
 * (005 FR-100 – FR-103, GitHub issue #18).
 *
 * Four requirements, one predicate, and the property they exist to make
 * structural rather than promised:
 *
 * - **The gate is zero accounts *at all***, not zero *usable* ones. `usable` is
 *   `state === 'active'` alone, while the service's `PUT /v1/bindings`
 *   validates that the referenced account merely **exists** — deliberately,
 *   because a binding is meant to outlive its account's health. Widening the
 *   gate to `usable` would convert that considered permissiveness into a panel
 *   prohibition: bindings the service accepts and the poll loop still tracks
 *   could no longer be created, nor deleted (FR-100, FR-104).
 * - **The gate is a conjunction over the accounts read having succeeded.** It
 *   is *not* a length test. `loadBindings` deliberately **retains** the previous
 *   account list when a read fails, so a failed read that followed a successful
 *   read of an *empty* list leaves `accounts.length === 0` — and a length test
 *   would tell an operator with a **broken service** that they have no
 *   accounts. Missing evidence is a stop condition, not permission to guess
 *   (constitution II; 005 AC-152).
 * - **The empty text and the gate read the *same* fact**, {@link accountsRead},
 *   which is what makes FR-102's consistency rule true instead of hoped for:
 *   three rows over one predicate, and a control's state that cannot disagree
 *   with the sentence describing it.
 * - **Every string names a state the product has.** The picker once asked for a
 *   *verified* account, which is not one of `AccountState`'s six values, beside
 *   a refusal that said there was *no active* one — two different facts about
 *   one list (FR-103).
 *
 * Text only, in every position: no button, link, or other control carries the
 * reason, the picker's own hint is never treated as discharging the visible
 * refusal, and every string reaches the DOM through the SDK's non-HTML path
 * (FR-101, FR-080, FR-101's channel rule).
 *
 * Imports neither `panel-ui` nor `bindings.ts`, for the reason
 * `bindings-actors.ts` states: a control `bindings-ui` composes *and* `refresh`
 * repaints has to stay a leaf, or the two form an import cycle.
 */

import { mountText } from '@openchamber/sdk/ui';
import type { TextHandle } from '@openchamber/sdk/ui';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';

/**
 * Why *New binding* is disabled, as text, under the list's toolbar (FR-101).
 *
 * **One constant, two positions** — the line painted here and the add form's
 * refusal when the account list emptied behind an open editor (FR-103's first
 * row). They are the same reason, so two spellings of it would be two things
 * that can drift (FR-091's one-rendering intent).
 *
 * It *names* the Accounts tab and never navigates there: a second route to a
 * capability is a second thing to keep in step (FR-010, FR-039), and text is
 * the whole delivery.
 */
export const ACCOUNT_REQUIRED_REASON = 'Add an account on the Accounts tab before binding a repository.';

/** The list's empty text where the gate holds (FR-102's second row). */
export const EMPTY_TEXT_NO_ACCOUNTS = 'No binding yet — add an account on the Accounts tab first.';

/**
 * The list's empty text where at least one account exists (FR-102's third row).
 *
 * The retained `LIST_EMPTY`, verbatim: the control it names is live in this
 * state, which is the only reason a row may name *New binding* at all.
 */
export const EMPTY_TEXT_WITH_ACCOUNT = 'No binding yet — select New binding to add one, or refresh.';

/**
 * The list's empty text while the accounts read has **not** succeeded — not yet
 * started, in flight, or failed (FR-102's first row).
 *
 * It states an absence of **knowledge**, never of accounts, and names only
 * *Refresh*, which nothing gates on the accounts read. It does **not** restate
 * the failed read's cause or its retry: those belong to the tab's own
 * failed-read channel, which renders them once (FR-019, FR-101's channel rule).
 */
export const EMPTY_TEXT_NOT_KNOWN = 'No binding yet — the account list is not known. Refresh to read it.';

/**
 * The account picker's placeholder, whenever its option list is empty.
 *
 * The picker offers exactly the accounts the panel marks `usable` — the
 * `active` state alone — so *active* is the product's own word for what the
 * list contains. The withdrawn *Select a verified account* named a state
 * `AccountState` does not have (FR-103).
 *
 * A **constant, not a conditional**: one string in every case, and it governs
 * the placeholder's *wording* only — the field stays disabled whenever its
 * option list is empty, and the visible refusal stays the obligation that
 * tells the operator which fix applies.
 */
export const ACCOUNT_PICKER_PLACEHOLDER = 'Select an active account';

/**
 * Class on the reason line's wrapper.
 *
 * The wrapper is the codebase's own idiom for a block that comes and goes
 * (`detailBox`, `editorBox`, `agentNoticeBox` all carry a class too), and a
 * reader that needs to find this line — the layout, or a test asserting its
 * position — reads the class rather than guessing at a tag.
 */
export const ACCOUNT_REASON_CLASS = 'mt-reason';

/** The refusal when accounts exist but none of them is `active` (FR-103). */
export const NO_ACTIVE_ACCOUNT_REFUSAL = 'No active account — fix or replace an account on the Accounts tab.';

/** The refusal when there is an `active` account to pick from (FR-103). */
export const PICK_ACCOUNT_REFUSAL = 'Pick the account this repository polls under.';

/**
 * Whether the panel's accounts read has **succeeded** — the one named predicate
 * the gate and the empty text both consume (FR-102's consistency rule).
 *
 * `status` already *is* that flag: `loadBindings` sets it to `'ready'` only
 * when `GET /v1/bindings` **and** `GET /v1/accounts` both returned a list, and
 * to `'loading'` before either await. So `'idle'` is not-yet-started, `'loading'`
 * is in flight, `'error'` is a failed read, and none of the three can satisfy
 * the gate.
 *
 * Named rather than inlined so that {@link emptyBindingsText} *selects* on the
 * gate's own conjunct instead of re-deriving it: two separately-written
 * `status === 'ready'` tests are two tests that can drift, and a length-keyed
 * selector reintroduces the defect this module exists to remove.
 *
 * @returns Whether the read has succeeded, whatever `accounts` holds.
 */
export function accountsRead(bindings: BindingsTabState): boolean {
    return bindings.status === 'ready';
}

/** Whether *New binding* is blocked for want of an account, and why. */
export interface AccountGate {
    /** `true` when the gate holds and the control must be disabled. */
    readonly blocked: boolean;
}

/**
 * Whether the panel has established that **no account exists** (FR-100).
 *
 * A conjunction, never a length test: a list the panel could not read is
 * missing evidence, so the gate stays silent there and FR-102's *not known*
 * row answers instead. Where the read **has** succeeded, the condition is
 * exactly *"no accounts exist"* — no lifecycle state is exempt, and `usable` is
 * deliberately not consulted.
 *
 * `blocked` is the whole answer; the object carries it so a caller cannot
 * reach for the length or the read state on its own and build a second gate.
 *
 * @returns The gate as the tab's control needs it.
 */
export function accountGate(bindings: BindingsTabState): AccountGate {
    return { blocked: accountsRead(bindings) && bindings.accounts.length === 0 };
}

/**
 * The bindings list's empty text (FR-102's closed three-row table).
 *
 * One predicate — {@link accountsRead} — three outcomes, three rows, selected
 * **in this order**:
 *
 * 1. the read has **not** succeeded ⇒ {@link EMPTY_TEXT_NOT_KNOWN}, whatever
 *    `accounts.length` holds. The stale case is the load-bearing one: a failed
 *    read after a successful read of an *empty* list leaves the list empty on
 *    the panel's own state, so testing length first would render the *add an
 *    account* row over an unanswered read.
 * 2. the read succeeded and the list is **empty** ⇒ {@link EMPTY_TEXT_NO_ACCOUNTS}.
 * 3. the read succeeded and the list holds **≥ 1** ⇒ {@link EMPTY_TEXT_WITH_ACCOUNT}.
 *
 * No row names a control that is unavailable in the state its own row
 * describes, and the gate is a conjunction over this same predicate — so
 * whenever *New binding* is disabled the text names *Refresh* or the Accounts
 * tab, and whenever the text names *New binding* the control is live.
 *
 * @returns The text the list shows while it holds no row.
 */
export function emptyBindingsText(bindings: BindingsTabState): string {
    // The `accountsRead` guard comes **first**, and that order is the claim: a
    // length-keyed selector renders *add an account* over an unanswered read.
    if (!accountsRead(bindings)) {
        return EMPTY_TEXT_NOT_KNOWN;
    }

    if (bindings.accounts.length === 0) {
        return EMPTY_TEXT_NO_ACCOUNTS;
    }

    return EMPTY_TEXT_WITH_ACCOUNT;
}

/**
 * The add form's refusal when no account is selected (FR-103's closed table).
 *
 * Total over the reachable cases, in the order **none exist → some `usable` →
 * otherwise**, so a case the requirement does not have would have to be added
 * to this `if` before it could render:
 *
 * - **none exist** ⇒ {@link ACCOUNT_REQUIRED_REASON} — reachable only where the
 *   list emptied while the editor was already open, since the gate otherwise
 *   prevents opening it, and in all three pre-read states the editor's own
 *   *Add binding* is disabled, so no submission reaches here at all.
 * - **some exist, none `active`** ⇒ {@link NO_ACTIVE_ACCOUNT_REFUSAL}, which
 *   names the remediation rather than a selection the operator cannot make.
 * - **at least one `active`** ⇒ {@link PICK_ACCOUNT_REFUSAL}, unchanged and
 *   actionable, because there is something to pick.
 *
 * A **stale** selection — an account removed while the form was open — reaches
 * here with `accounts.length ≥ 1`, and lands in the second or third row by the
 * same fact. Both read truthfully, so no fourth case is invented.
 *
 * @returns The note the add form refuses with.
 */
export function accountSelectionRefusal(bindings: BindingsTabState): string {
    if (bindings.accounts.length === 0) {
        return ACCOUNT_REQUIRED_REASON;
    }

    return bindings.accounts.some((account) => account.usable)
        ? PICK_ACCOUNT_REFUSAL
        : NO_ACTIVE_ACCOUNT_REFUSAL;
}

/** The reason line's wrapper and the text inside it, as the pane carries them. */
export interface AccountReasonControls {
    /** Wrapper, `hidden` whenever the gate does not hold. */
    readonly box: HTMLElement;
    /** The reason itself, empty whenever the gate does not hold. */
    readonly line: TextHandle;
}

/**
 * Repaint the reason line from state.
 *
 * **Both** the wrapper's `hidden` and the text follow the gate: a
 * present-and-blank element satisfies neither a visual nor a DOM reading of
 * "absent", and an always-present line that is routinely blank is the
 * reassuring absence NFR-112 exists to prevent. FR-101's line also stays absent
 * in every state where the tab is **not** blocked — including all three pre-read
 * states, where a list the panel could not read says nothing about whether an
 * account exists.
 */
export function repaintAccountReason(bindings: BindingsTabState, controls: AccountReasonControls): void {
    const { blocked } = accountGate(bindings);

    controls.box.hidden = !blocked;
    controls.line.update({ text: blocked ? ACCOUNT_REQUIRED_REASON : '' });
}

/**
 * Mount the reason line into the list block, **directly after the toolbar**
 * (FR-101).
 *
 * Beside the control it explains rather than inside the editor the operator has
 * not been able to open. The wrapper is this codebase's own idiom for a block
 * that comes and goes (`detailBox`, `editorBox`, `agentNoticeBox`), and it
 * needs no SDK capability beyond `mountText`.
 *
 * @returns The wrapper and the line, for repaint and disposal.
 */
export function mountAccountReason(input: {
    /** Runtime whose state the line derives from. */
    readonly rt: PanelRuntime;
    /** List-block root the line mounts into, after the toolbar. */
    readonly pane: HTMLElement;
}): AccountReasonControls {
    const box = input.pane.ownerDocument.createElement('div');
    box.className = ACCOUNT_REASON_CLASS;
    box.hidden = true;
    input.pane.append(box);
    const controls: AccountReasonControls = { box, line: mountText(box, { text: '' }) };
    // The same painter the repaint path uses, so mount cannot disagree with it
    // about what "absent" means: `hidden` **and** an empty line.
    repaintAccountReason(input.rt.state.bindings, controls);

    return controls;
}

/**
 * Release the reason line's handle and its wrapper.
 */
export function disposeAccountReason(controls: AccountReasonControls): void {
    controls.line.dispose();
    controls.box.remove();
}
