/**
 * The binding editor's actor allow-list field (005 FR-090 – FR-092, FR-095;
 * 002 FR-047).
 *
 * Exactly one element carries *this binding's* permitted logins, and this is
 * it: a free-text field in the Bindings editor, fed from `GET /v1/bindings`'s
 * `allowedUsers`. Everywhere else the panel renders the **count** and never a
 * login (005 FR-091, NFR-113) — this module is the whole of that promise's
 * value-bearing half, and `bindings-rows.ts` is its count-only half.
 *
 * **Why a separate module, and why it owns this field alone.** 004's starting
 * prompt is the same shape of requirement — one value, one rendering, one
 * field-level refusal — and it already lives in `bindings-prompt.ts` beside this
 * one (005 plan D13). Two fields with two sets of three-state rules in one file
 * is how one of them starts answering for the other; and the Bindings pane's
 * mount was already at the file-length cap.
 *
 * It is deliberately **free text**: there is no GitHub identity picker, because
 * the host exposes no such API and 005 FR-004 forbids inventing one (005
 * clarification row 39). It is also deliberately **not a validator**: 002 FR-024
 * makes the service the only rule set, so this module splits what the operator
 * typed and refuses nothing — an element that is not a GitHub login reaches the
 * service and comes back as the service's own refusal, which is the copy
 * 005 FR-095 renders in this field's helper slot (FR-052's rule, reused).
 *
 * The field has **no button of its own**: it is a field of the binding's form,
 * so the editor's own primary control writes it with everything else, and
 * 004 FR-014's untouched-omits rule rides that write with the one difference
 * 002 FR-047 requires — for a **list**, omission means *unset* rather than
 * *leave it alone*, so clearing the field takes the binding back to open.
 *
 * **Why the policy copy is a function and not a constant** (005 v1.14.0). The
 * absent-policy warning used to be a module-level string, which is the root
 * cause `npm run shot` found: **a constant cannot know whether the binding it
 * describes can start anything at all**. It told a *disabled* binding that
 * anyone *can* start a session, and it named *open an issue* and *comment* —
 * acts only the `mention` trigger watches — on every binding whose mention
 * switch was off. So {@link actorsSummary}, {@link allowedUsersGuidance}, and
 * {@link allowedUsersNotSetPlaceholder} are now functions of the binding's
 * **state** and **trigger switches** as well as its list (005 FR-092's
 * eight-row table, FR-096's derivation, NFR-114's general rule).
 *
 * It imports neither `panel-ui` nor `bindings.ts`, exactly as
 * `bindings-prompt.ts` does: a control that `bindings-ui` composes *and*
 * `refresh` repaints has to stay a leaf, or the two would form an import cycle.
 * Its handler is the form's own in `bindings-mount.ts`, which already owns that
 * table.
 */

import { mountTextField } from '@openchamber/sdk/ui';
import type { TextFieldHandle } from '@openchamber/sdk/ui';
import type { ServiceErrorResult } from './service-envelope.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { PanelBinding, PanelTriggers } from './bindings-service.ts';

/** The wire member this field is the panel's client of record for (contract §2). */
export const ALLOWED_USERS_FIELD = 'allowedUsers';

/**
 * What the field is words: the set of GitHub logins allowed
 * to trigger dispatches from **this repository**.
 *
 * It names the binding's own scope rather than the product's, because an
 * allow-list is per binding — one repository, one project — and a label that
 * said "the account" or "the service" would describe a control that does not
 * exist.
 */
export const ALLOWED_USERS_LABEL = 'GitHub logins allowed to trigger dispatches from this repository';

/* -------------------------------------------------------------------- *
 * FR-096 — the copy derivation. One table, one order, one frame, and no
 * fallback sentence: a fixed wording reachable from more than one switch
 * set is the defect this section exists to remove.
 * -------------------------------------------------------------------- */

/**
 * One trigger switch and the phrase it contributes, in the fixed composition
 * order `assignment`, `mention`, `reviewRequest`.
 *
 * Each phrase names **the act the trigger matches on** rather than the
 * switch's key: an operator reading *assignment* learns the switch's name,
 * and an operator reading *assign an issue to the account* learns what will
 * happen to them. The order matches the declared order of `PanelTriggers` and
 * the wire's `BindingTriggers`, so a reader of this table and a reader of the
 * wire see the same sequence.
 */
const TRIGGER_PHRASES: readonly (readonly [keyof PanelTriggers, string])[] = [
    ['assignment', 'assign an issue to the account'],
    ['mention', 'mention the account in an issue or comment'],
    ['reviewRequest', 'request a review from the account on a pull request'],
];

/**
 * FR-092's *enabled · absent · none on* row: nothing can start a session, and
 * why, with the field that would change it.
 */
const NOTHING_TRIGGERED_OPEN =
    'nothing can start a session from this repository — no trigger is switched on; '
    + 'name the logins who may in allowedUsers';

/**
 * FR-092's *disabled · absent · none on* row: the same sentence with **both**
 * reasons, and no act named — there is no exposed surface to name one from.
 */
const NOTHING_TRIGGERED_OFF_OPEN =
    'nothing can start a session from this repository — it is off, and no trigger is switched on; '
    + 'name the logins who may in allowedUsers';

/**
 * Join the switched-on phrases into one list.
 *
 * **The comma depends on the length** — FR-096's rule as re-cut at v1.15.0 on
 * the product owner's ruling: **two phrases read `a or b`, three read `a, b,
 * or c`**, one stands alone. Standard English — a two-item list takes no comma
 * before *or*, a three-item list does.
 *
 * @param phrases - The phrases the switched-on switches contributed.
 * @returns The list, as it sits inside FR-096's frame.
 */
function joinPhrases(phrases: readonly string[]): string {
    const last = phrases.length - 1;
    const lead = phrases.length === 2 ? ' or' : ', or';

    return phrases
        .map((phrase, index) => (index === 0 ? phrase : `${index === last ? lead : ','} ${phrase}`))
        .join('');
}

/**
 * The one clause that names who may start a session on a binding whose
 * allow-list is absent.
 *
 * The exposed surface of a binding with no allow-list is exactly the triggers
 * switched on for it, so the sentence must name those and no others: naming
 * an act the binding does not watch describes a surface the operator does not
 * have, and an **overstated** exposure is not a safe default either — it is the
 * alarm that teaches operators to stop reading the alarms.
 *
 * Two rules keep it total rather than merely present:
 *
 * - **No fallback sentence.** All eight subsets map here, one each, so a fixed
 *   string reachable from more than one switch set cannot exist. With nothing
 *   switched on there is no exposed surface and the function answers `null`;
 *   FR-092's table is what supplies the sentence in that case.
 * - **The bound account's login is never named.** The phrases say *the
 *   account*, because the row already renders that member and this must not
 *   become a second rendering of it.
 *
 * @param triggers - The binding's switches, as the panel reads them.
 * @returns `anyone who can … can start a session`, or `null` when nothing is on.
 */
export function derivedTriggerClause(triggers: PanelTriggers): string | null {
    const phrases = TRIGGER_PHRASES
        .filter(([key]) => triggers[key])
        .map(([, phrase]) => phrase);

    return phrases.length === 0 ? null : `anyone who can ${joinPhrases(phrases)} can start a session`;
}

/* -------------------------------------------------------------------- *
 * FR-092 — the row's policy clause. Three facts, eight rows, and every
 * row's clause normative.
 * -------------------------------------------------------------------- */

/**
 * The three facts FR-092's closed table is a function of.
 *
 * Not a `PanelBinding`: this module also renders the *editor's* strings, where
 * the row does not exist yet and what is known is the draft's state and its
 * three switch positions.
 */
export interface PolicyFacts {
    /** Whether the binding polls right now (`state` on a stored row). */
    readonly state: 'active' | 'disabled';
    /** The trigger switches in force — a stored row's, or the editor's draft. */
    readonly triggers: PanelTriggers;
    /** How many permitted logins the list holds, or `null` when it is absent. */
    readonly count: number | null;
}

/**
 * Whether any trigger is switched on (FR-092's third column).
 *
 * @param triggers - The switches in force.
 * @returns `true` when at least one is on.
 */
function watchesAnything(triggers: PanelTriggers): boolean {
    return TRIGGER_PHRASES.some(([key]) => triggers[key]);
}

/**
 * FR-092's *enabled · list · triggers on* row: the plain count.
 *
 * @param count - How many logins the list holds.
 * @returns `N users may trigger`.
 */
export function allowedUsersSummary(count: number): string {
    return `${count} ${count === 1 ? 'user' : 'users'} may trigger`;
}

/**
 * The row's policy clause, from FR-092's closed eight-row table.
 *
 * Three facts decide it and every row's wording is normative, because the
 * table exists to stop the panel asserting a capability the machine does not
 * have. The four rules underneath are the ones a reader can get
 * wrong:
 *
 * - **A disabled binding leads with what cannot happen**, then names what
 *   *would* under an explicit conditional. The first clause is what makes the
 *   second a counterfactual rather than a claim — a panel that led with the
 *   conditional alone would still be asserting a live capability, and a panel
 *   that said only *"this binding is off"* would leave two rows reading
 *   identically one re-enable away from opposite exposures.
 * - **The frame never repeats the word *disabled*.** The row already renders
 *   the binding's own state as a row fact, so the conditional is what carries
 *   the qualification.
 * - **The count sentence is under the same rule.** `N users may trigger` is a
 *   capability claim, which is why it became `… once this binding is enabled`
 *   — the defect was *found* in the count, and fixing only the warning would
 *   have left the same falsehood one clause away.
 * - **Nothing here reads as an error**, and none of it may use *protected*,
 *   *restricted*, or *secure*: an absent list is a configuration the operator
 *   chose, and a disabled binding is a configuration they chose twice over.
 *   The panel's job is to make both legible, not to scold.
 *
 * @param facts - The state, the switches, and the count (or `null`).
 * @returns The row's own clause.
 */
export function policyClause(facts: PolicyFacts): string {
    const isWatching = watchesAnything(facts.triggers);
    const derived = derivedTriggerClause(facts.triggers);
    const count = facts.count === null ? null : allowedUsersSummary(facts.count);

    // ── Nothing is switched on: there is no exposed surface to describe, so
    //    every row says what *cannot* happen and why (FR-092's rows 3, 4, 7, 8).
    if (!isWatching) {
        if (count === null) {
            return facts.state === 'active'
                ? NOTHING_TRIGGERED_OPEN
                : NOTHING_TRIGGERED_OFF_OPEN;
        }

        return facts.state === 'active'
            ? `no trigger is switched on, so nothing can start a session until one is; ${count} then`
            : `${count} once this binding is enabled — though no trigger is switched on, `
                + 'so nothing can start a session yet';
    }

    // ── A disabled binding states the policy it *would* carry, as an
    //    explicit counterfactual preceded by what cannot happen (rows 5, 6).
    if (facts.state === 'disabled') {
        return count === null
            ? 'nothing can start a session while this binding is off; when you enable it, '
                + `${derived}; name the logins who may in allowedUsers to change that`
            : `${count} once this binding is enabled`;
    }

    // ── Enabled, isWatching something: the count, or the open-policy warning
    //    whose *who* is derived rather than fixed (rows 1, 2).
    return count ?? `open to anyone — ${derived}; name the logins who may in allowedUsers to change that`;
}

/**
 * The row summary for one binding's policy: FR-092's table, applied.
 *
 * A binding with **no** list gets the worded warning and no count (there is
 * nothing to count, and printing `0 users` would read as a verdict rather
 * than as the absence of a configuration); a binding **with** one gets the
 * count and **no** warning.
 *
 * @param binding - The binding whose row is being composed.
 * @returns The row's own clause.
 */
export function actorsSummary(binding: PanelBinding): string {
    return policyClause({
        state: binding.state,
        triggers: binding.triggers,
        count: binding.allowedUsers === undefined ? null : binding.allowedUsers.length,
    });
}

/**
 * The editor guidance's three states, with the first one **derived**.
 *
 *
 * FR-090's obligation is untouched — all three of 002 FR-047's states are
 * stated in the field's own words — but its **first** state's fixed sentence is
 * superseded: *"anyone who can open an issue or comment on this repository"*
 * named acts only the `mention` trigger watches. The derivation supplies that
 * clause instead, in **either mode**: an add-mode draft's switches are the ones
 * the editor is currently showing, and the guidance says what would hold if the
 * draft were saved, which is the only honest thing a field can say about a row
 * that does not exist yet.
 *
 * The other two states do not move. They describe the **field's** value rather
 * than the binding's exposure — a list means only those logins may, and an
 * explicitly empty list is refused rather than read as *nobody* — so neither
 * asserts anything the binding's switches do or do not support.
 *
 * With **no** trigger switched on there is no exposed surface to derive, and
 * FR-092's own sentence for that case is what the first state says instead.
 *
 * @param triggers - The switches the editor is currently showing.
 * @returns The field's helper text.
 */
export function allowedUsersGuidance(triggers: PanelTriggers): string {
    const derived = derivedTriggerClause(triggers);
    const first = derived === null
        ? 'With no list and no trigger switched on, nothing can start a session'
        : `With no list, ${derived}`;

    return `${first}; with a list, only those logins may. `
        + 'An empty list is refused rather than read as "nobody" — to stop every trigger, disable the binding '
        + 'instead. The service validates this field, and an empty field leaves it unset.';
}

/**
 * The value-slot word an empty field shows, with its consequence derived.
 *
 *
 * `not set` is FR-064's honest-absence word and is unchanged; what follows it
 * is FR-096's clause, for the same reason the guidance's first state is. This
 * placeholder renders on **every** unset field, so the v1.11.0 wording —
 * *"anyone may trigger this repository"* — was an unframed present-tense
 * capability claim sitting in a disabled binding's value slot, which is the
 * exact defect NFR-114 exists to forbid.
 *
 * @param facts - The state and switches in force.
 * @returns The placeholder text.
 */
export function allowedUsersNotSetPlaceholder(facts: Omit<PolicyFacts, 'count'>): string {
    if (!watchesAnything(facts.triggers)) {
        return facts.state === 'active'
            ? 'not set — no trigger is switched on, so nothing can start a session'
            : 'not set — nothing can start a session while this binding is off';
    }

    return facts.state === 'active'
        ? 'not set — anyone may trigger this repository'
        : 'not set — anyone may trigger this repository once it is enabled';
}

/**
 * Render the stored list as the field's text.
 *
 * Comma-separated with a comma and a space, which is what the guidance's "one
 * login per entry" implies and what {@link parseAllowedUsers} reads back. The
 * **submitted spelling** is preserved verbatim: this is not a
 * canonical form, and re-saving an untouched list must not rewrite how an
 * operator spelled a login.
 *
 * @param binding - The binding being opened.
 * @returns The field text, or `''` when the binding has no list.
 */
export function storedActorsText(binding: PanelBinding): string {
    return binding.allowedUsers?.join(', ') ?? '';
}

/**
 * Read the field's text as the array the save carries.
 *
 * Splits on commas and newlines and trims each entry — and **nothing else**:
 * no case folding, no de-duplication, no login-shape check, and no dropping of
 * an empty entry. Each omission is a decision:
 *
 * - Folding or de-duplicating would be the panel deciding the stored value, and
 *   the service's stored spelling must survive a re-save unchanged.
 * - Dropping an empty entry would **manufacture `[]`** from text the operator
 *   wrote, and `[]` is a refusal — the panel must not turn a
 *   typing mistake into a wire value the service will reject with a sentence the
 *   operator then has to interpret.
 *
 * So `alice,` submits `['alice', '']` and the service's own remediation names
 * the shape, while a **blank** field submits nothing at all: the product owner
 * ruled at the phase-5 gate that a cleared field means *back to open* (contract
 * §2).
 *
 * @param text - The field's current text.
 * @returns The logins to send, or `null` when the key must be omitted.
 */
export function parseAllowedUsers(text: string): readonly string[] | null {
    const entries = text
        .split(/[,\n]/)
        .map((entry) => entry.trim());

    return entries.every((entry) => entry === '') ? null : entries;
}

/**
 * Read the service's refusal **if it belongs to the allow-list** (005 FR-095).
 *
 * The whole-file grant validates every binding in one pass, so a `422` can be
 * about any of them; only the one whose own message names `allowedUsers` is
 * painted onto this field, and anything else stays on the tab's note where it
 * already has a home. Same classification as the prompt's, read from the same
 * envelope, so one answer can never split two ways.
 *
 * @param answer - The grant's answer.
 * @returns The field-level copy to render, or `null` when it is not the list's.
 */
export function actorsRefusal(answer: ServiceErrorResult): string | null {
    if (answer.ok || answer.code !== 'validation' || answer.message === null) {
        return null;
    }

    return answer.message.includes(ALLOWED_USERS_FIELD) ? answer.message : null;
}

/** Callbacks the field invokes. */
export interface BindingActorHandlers {
    /** The operator typed into the allow-list field. */
    readonly setAllowedUsers: (value: string) => void;
}

/**
 * The one binding whose allow-list a whole-file write overrides (contract §2).
 *
 * The counterpart of 004's `PromptPatch`, with the **opposite default**: a
 * prompt that was untouched is omitted because omission means *leave this one
 * alone*, while a list that was cleared is omitted because omission means
 * *unset*. Every other row always carries its own stored value.
 */
export interface ActorPatch {
    /** Binding whose allow-list the operator edited. */
    readonly bindingId: string;
    /**
     * The logins to submit, or `null` to **omit the key** — which is how a
     * cleared field takes the binding back to open (002 FR-047, contract §2).
     *
     * An empty array is unreachable from this module by construction: a blank
     * field parses to `null`, so the client never manufactures `[]` (a value the
     * service refuses).
     */
    readonly allowedUsers: readonly string[] | null;
}

/**
 * The allow-list patch one save carries, or `undefined` when it carries none.
 *
 * Untouched is **not** "send nothing": the grant sends this binding's stored
 * list whatever the editor did, because a whole-file row that omitted the key
 * would take the binding back to open (contract §2). Only a change to a blank
 * field omits it.
 *
 * @param bindings - The Bindings tab's state.
 * @param bindingId - The row this save writes.
 * @returns The patch, or `undefined` when the operator never touched the field.
 */
export function allowedUsersPatch(bindings: BindingsTabState, bindingId: string): ActorPatch | undefined {
    if (!bindings.allowedUsersDirty) {
        return undefined;
    }

    return { bindingId, allowedUsers: parseAllowedUsers(bindings.allowedUsersInput) };
}

/** The field, as the pane carries it. */
export interface BindingActorControls {
    /** The allow-list itself — the only element that ever holds its logins. */
    readonly field: TextFieldHandle;
}

/**
 * The state and switches the **editor** is currently showing.
 *
 * The switches are the draft's in **both modes**: `bindings-mount.ts` wires the
 * three checkboxes to `triggerAssignment` / `triggerMention` /
 * `triggerReviewRequest`, and those are the values a save would write — so the
 * guidance describes what would hold if this draft were saved, which is the
 * only honest thing a field can say about a row that may not exist yet.
 *
 * The **state** is not a form field: the editor holds no control that writes
 * it, so a loaded row keeps whatever state the service holds (the same value
 * `bindings-draft.ts`'s `draftIdentity` carries into the save) and an add-mode
 * draft is `active` by construction.
 *
 * @param bindings - The Bindings tab's state.
 * @returns The state and switches in force, with no count.
 */
export function editorPolicyFacts(bindings: BindingsTabState): Omit<PolicyFacts, 'count'> {
    const loaded = bindings.editing
        ? bindings.bindings.find((candidate) => candidate.bindingId === bindings.selectedBinding)
        : undefined;

    return {
        state: loaded?.state ?? 'active',
        triggers: {
            assignment: bindings.triggerAssignment,
            mention: bindings.triggerMention,
            reviewRequest: bindings.triggerReviewRequest,
        },
    };
}

/**
 * Mount the field into the editor, beside the mention-token override.
 *
 * 005 clarification row 38 puts the two controls that decide *what counts as a
 * trigger for this repository* next to each other, so the field mounts directly
 * after the mention-token line and before the fields that are not about
 * triggers.
 *
 * @param input - Runtime, editor root, and the handler the field invokes.
 * @returns The handle the pane carries.
 */
export function mountBindingActors(input: {
    /** Runtime whose state the field renders from. */
    readonly rt: PanelRuntime;
    /** Editor root the field mounts into. */
    readonly pane: HTMLElement;
    /** Handler the field invokes. */
    readonly handlers: BindingActorHandlers;
}): BindingActorControls {
    const state = input.rt.state.bindings;
    const facts = editorPolicyFacts(state);

    return {
        field: mountTextField(input.pane, {
            label: ALLOWED_USERS_LABEL,
            value: state.allowedUsersInput,
            placeholder: allowedUsersNotSetPlaceholder(facts),
            helper: allowedUsersGuidance(facts.triggers),
            onChange: (value) => input.handlers.setAllowedUsers(value),
        }),
    };
}

/**
 * Repaint the field from state.
 *
 * The refusal is rendered **as the field's own helper**, directly under the
 * input, because FR-095 asks for a *field-level* refusal with its remediation —
 * and the service's copy never echoes what was submitted, so it can be shown
 * verbatim. It is the only thing that displaces FR-090's guidance:
 * the guidance is the field's resting state, and it comes back the moment the
 * service accepts the next save.
 *
 * The **placeholder** is repainted with it, which matters: it carries the unset
 * state's consequence, so a switch the operator just unchecked has to move it
 * too. The SDK takes a patched subset, so an absent key means
 * *leave what is painted*, and omitting it would strand the v1.11.0 wording on a
 * form whose switches have since changed.
 *
 * What the input shows does not depend on the selection: a form the operator
 * has open is isTypeable in both modes, exactly as the prompt field beside it is.
 *
 * @param rt - Panel runtime.
 * @param controls - The mounted field.
 */
export function repaintBindingActors(rt: PanelRuntime, controls: BindingActorControls): void {
    const state = rt.state.bindings;
    const isTypeable = state.editorOpen && state.status !== 'loading';
    const facts = editorPolicyFacts(state);

    controls.field.update({
        value: state.allowedUsersInput,
        disabled: !isTypeable,
        placeholder: allowedUsersNotSetPlaceholder(facts),
        helper: state.allowedUsersError ?? allowedUsersGuidance(facts.triggers),
    });
}

/**
 * Release the handle the allow-list field mounted.
 *
 * @param controls - The field the pane carries.
 */
export function disposeBindingActors(controls: BindingActorControls): void {
    controls.field.dispose();
}

/**
 * Read the stored allow-list a freshly selected binding carries.
 *
 * @param bindings - The Bindings tab's state.
 * @param bindingId - The row the operator selected.
 * @returns The field text for that row, or `''` when it has no list.
 */
export function storedActorsFor(bindings: BindingsTabState, bindingId: string | null): string {
    if (bindingId === null) {
        return '';
    }

    const binding = bindings.bindings.find((candidate) => candidate.bindingId === bindingId);

    return binding === undefined ? '' : storedActorsText(binding);
}
