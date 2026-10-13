/**
 * Bindings-tab accounts: the *New binding* gate, its reason, the empty text, the refusal (005 FR-120–FR-123, #18).
 */

import { mountText } from '@openchamber/sdk/ui';
import type { TextHandle } from '@openchamber/sdk/ui';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';

/**
 * Why *New binding* is disabled, as text, under the list's toolbar (FR-121).
 * **One constant, two positions** — this line and the add form's refusal when
 * the account list emptied behind an open editor (FR-123's first row): the
 * same reason, so two spellings would be two things that can drift (FR-091's
 * one-rendering intent). It *names* the Accounts tab and never navigates
 * there: a second route to a capability is a second thing to keep in step
 * (FR-010, FR-039), and text is the whole delivery.
 */
export const ACCOUNT_REQUIRED_REASON = 'Add an account on the Accounts tab before binding a repository.';

/** The list's empty text where the gate holds (FR-122's second row). */
export const EMPTY_TEXT_NO_ACCOUNTS = 'No binding yet — add an account on the Accounts tab first.';

/**
 * The list's empty text where at least one account exists (FR-122's third row).
 *
 * The retained `LIST_EMPTY`, verbatim: the control it names is live in this
 * state, which is the only reason a row may name *New binding* at all.
 */
export const EMPTY_TEXT_WITH_ACCOUNT = 'No binding yet — select New binding to add one, or refresh.';

/**
 * The list's empty text while the accounts read has **not** succeeded — not
 * yet started, in flight, or failed (FR-122's first row). It states an
 * absence of **knowledge**, never of accounts, and names only *Refresh* —
 * FR-120's accounts gate never disables it, though the in-flight window does
 * at `loading` (`005 AC-157`), which leaves the advice actionable at `idle`
 * and after a failed read. It does **not** restate the failed read's cause or
 * its retry: those belong to the tab's own failed-read channel, which renders
 * them once (FR-019, FR-121's channel rule).
 */
export const EMPTY_TEXT_NOT_KNOWN = 'No binding yet — the account list is not known. Refresh to read it.';

/**
 * The account picker's placeholder, whenever its option list is empty. The
 * picker offers exactly the accounts the panel marks `usable` — the `active`
 * state alone — so *active* is the product's own word for what the list
 * contains; the withdrawn *Select a verified account* named a state
 * `AccountState` does not have (FR-123). A **constant, not a conditional**: it
 * governs the placeholder's *wording* only — the field stays disabled whenever
 * its option list is empty, and the visible refusal stays the obligation that
 * tells the operator which fix applies.
 */
export const ACCOUNT_PICKER_PLACEHOLDER = 'Select an active account';

/**
 *
 * The wrapper is the codebase's own idiom for a block that comes and goes
 * (`detailBox`, `editorBox`, `agentNoticeBox` all carry a class too), and a
 * reader that needs to find this line — the layout, or a test asserting its
 * position — reads the class rather than guessing at a tag.
 */
export const ACCOUNT_REASON_CLASS = 'mt-reason';

/** The refusal when accounts exist but none of them is `active` (FR-123). */
export const NO_ACTIVE_ACCOUNT_REFUSAL = 'No active account — fix or replace an account on the Accounts tab.';

/** The refusal when there is an `active` account to pick from (FR-123). */
export const PICK_ACCOUNT_REFUSAL = 'Pick the account this repository polls under.';

/**
 * Whether the panel's accounts read has **succeeded** — the one named
 * predicate the gate and the empty text both consume (FR-122's consistency
 * rule). `status` already *is* that flag: `loadBindings` sets it to `'ready'`
 * only when `GET /v1/bindings` **and** `GET /v1/accounts` both returned a
 * list, so `'idle'`, `'loading'`, and `'error'` can never satisfy the gate.
 * Named rather than inlined so {@link emptyBindingsText} *selects* on the
 * gate's own conjunct instead of re-deriving it: two separately-written
 * `status === 'ready'` tests are two tests that can drift, and a length-keyed
 * selector reintroduces the defect this module exists to remove.
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
 * Whether the panel has established that **no account exists** (FR-120): a
 * conjunction, never a length test — a list the panel could not read is
 * missing evidence, so the gate stays silent there and FR-122's *not known*
 * row answers instead. Where the read **has** succeeded the condition is
 * exactly *"no accounts exist"*, no lifecycle state exempt and `usable`
 * deliberately not consulted. `blocked` is the whole answer; the object carries
 * it so a caller cannot reach for the length or read state and build a second
 * gate.
 */
export function accountGate(bindings: BindingsTabState): AccountGate {
    return { blocked: accountsRead(bindings) && bindings.accounts.length === 0 };
}

/**
 * The bindings list's empty text (FR-122's closed three-row table): one
 * predicate — {@link accountsRead} — three outcomes, selected **in this
 * order**: not succeeded ⇒ {@link EMPTY_TEXT_NOT_KNOWN}, whatever
 * `accounts.length` holds (the stale case is the load-bearing one — a failed
 * read after an empty list would otherwise render *add an account* over an
 * unanswered read); succeeded and empty ⇒ {@link EMPTY_TEXT_NO_ACCOUNTS};
 * succeeded and ≥ 1 ⇒ {@link EMPTY_TEXT_WITH_ACCOUNT}. No row names a control
 * unavailable in the state its own row describes, and the gate is a
 * conjunction over this same predicate, so the text and *New binding* can
 * never disagree.
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
 * The add form's refusal when no account is selected (FR-123's closed table): total over the
 * reachable cases in the order **none exist → some `usable` → otherwise**, so a case the
 * requirement lacks must be added to this `if` before it could render. **none exist** ⇒
 * {@link ACCOUNT_REQUIRED_REASON} (reachable only where the list emptied mid-edit); **some exist,
 * none `active`** ⇒ {@link NO_ACTIVE_ACCOUNT_REFUSAL}, naming the remediation rather than a
 * selection the operator cannot make; **at least one `active`** ⇒ {@link PICK_ACCOUNT_REFUSAL},
 * unchanged and actionable. A **stale** selection lands in the second or third row by the same
 * fact, so no fourth case is invented.
 */
export function accountSelectionRefusal(bindings: BindingsTabState): string {
    if (bindings.accounts.length === 0) {
        return ACCOUNT_REQUIRED_REASON;
    }

    return bindings.accounts.some((account) => account.usable)
        ? PICK_ACCOUNT_REFUSAL
        : NO_ACTIVE_ACCOUNT_REFUSAL;
}

export interface AccountReasonControls {
    /** Wrapper, `hidden` whenever the gate does not hold. */
    readonly box: HTMLElement;
    /** The reason itself, empty whenever the gate does not hold. */
    readonly line: TextHandle;
}

/**
 * **Both** the wrapper's `hidden` and the text follow the gate: a
 * present-and-blank element satisfies neither a visual nor a DOM reading of
 * "absent", and an always-present line that is routinely blank is the
 * reassuring absence NFR-112 exists to prevent. FR-121's line also stays
 * absent in every state where the tab is **not** blocked — including all three
 * pre-read states, where a list the panel could not read says nothing about
 * whether an account exists.
 */
export function repaintAccountReason(bindings: BindingsTabState, controls: AccountReasonControls): void {
    const { blocked } = accountGate(bindings);

    controls.box.hidden = !blocked;
    controls.line.update({ text: blocked ? ACCOUNT_REQUIRED_REASON : '' });
}

/**
 * Mount the reason line into the list block, **directly after the toolbar**
 * (FR-121).
 *
 * Beside the control it explains rather than inside the editor the operator has
 * not been able to open. The wrapper is this codebase's own idiom for a block
 * that comes and goes (`detailBox`, `editorBox`, `agentNoticeBox`), and it
 * needs no SDK capability beyond `mountText`.
 */
export function mountAccountReason(input: {
    readonly rt: PanelRuntime;
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

export function disposeAccountReason(controls: AccountReasonControls): void {
    controls.line.dispose();
    controls.box.remove();
}
