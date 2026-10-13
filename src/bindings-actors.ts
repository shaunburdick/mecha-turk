/**
 * The binding editor's actor allow-list field — the only element that ever
 * holds a permitted login. Free text, not a picker and not a validator: the
 * host exposes no GitHub identity API and the service owns the rule set, so a
 * non-login reaches the service and comes back as its own refusal.
 */

import { mountTextField } from '@openchamber/sdk/ui';
import type { TextFieldHandle } from '@openchamber/sdk/ui';
import type { ServiceErrorResult } from './service-envelope.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';
import type { PanelBinding, PanelTriggers } from './bindings-service.ts';

/** The wire member this field is the panel's client of record for (contract §2). */
export const ALLOWED_USERS_FIELD = 'allowedUsers';

/**
 * What the field is words.
 *
 * The binding's own scope, not the product's: an allow-list is per binding —
 * one repository, one project — so a label saying "the account" or "the
 * service" would describe a control that does not exist.
 */
export const ALLOWED_USERS_LABEL = 'GitHub logins allowed to trigger dispatches from this repository';

/* -------------------------------------------------------------------- *
 * The copy derivation. One table, one order, one frame, and no fallback
 * sentence: a fixed wording reachable from more than one switch set is the
 * defect this section exists to remove.
 * -------------------------------------------------------------------- */

/**
 * One trigger switch and the phrase it contributes: each phrase names **the act
 * the trigger matches on** rather than the switch's key, so an operator learns
 * what will happen to them. The order matches `PanelTriggers` and the wire's
 * `BindingTriggers`, so a reader of this table and a reader of the wire see the
 * same sequence.
 */
const TRIGGER_PHRASES: readonly (readonly [keyof PanelTriggers, string])[] = [
    ['assignment', 'assign an issue to the account'],
    ['mention', 'mention the account in an issue or comment'],
    ['reviewRequest', 'request a review from the account on a pull request'],
];

/** Enabled · absent · none on: nothing can start a session, why, and the field that would change it. */
const NOTHING_TRIGGERED_OPEN =
    'nothing can start a session from this repository — no trigger is switched on; '
    + 'name the logins who may in allowedUsers';

/** The same sentence with **both** reasons, and no act named — there is no exposed surface to name one from. */
const NOTHING_TRIGGERED_OFF_OPEN =
    'nothing can start a session from this repository — it is off, and no trigger is switched on; '
    + 'name the logins who may in allowedUsers';

/**
 * Join the switched-on phrases into one list.
 *
 * **The comma depends on the length**: two phrases read `a or b`, three read
 * `a, b, or c`, one stands alone. That is the standard English convention, and
 * it is a product-owner ruling rather than a style choice.
 */
function joinPhrases(phrases: readonly string[]): string {
    const last = phrases.length - 1;
    const lead = phrases.length === 2 ? ' or' : ', or';

    return phrases
        .map((phrase, index) => (index === 0 ? phrase : `${index === last ? lead : ','} ${phrase}`))
        .join('');
}

/**
 * The one clause naming who may start a session on a binding with no
 * allow-list. The exposed surface is exactly the triggers switched on, so the
 * sentence names those and no others — an **overstated** exposure is the alarm
 * that teaches operators to stop reading the alarms. **No fallback sentence**:
 * all eight subsets map here, one each, and with nothing switched on there is
 * no surface and the answer is `null`. The bound account's login is never
 * named — the row already renders that member.
 */
export function derivedTriggerClause(triggers: PanelTriggers): string | null {
    const phrases = TRIGGER_PHRASES
        .filter(([key]) => triggers[key])
        .map(([, phrase]) => phrase);

    return phrases.length === 0 ? null : `anyone who can ${joinPhrases(phrases)} can start a session`;
}

/* -------------------------------------------------------------------- *
 * The row's policy clause. Three facts, eight rows, and every row's
 * clause normative.
 * -------------------------------------------------------------------- */

/**
 * The three facts the closed eight-row table is a function of.
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

function watchesAnything(triggers: PanelTriggers): boolean {
    return TRIGGER_PHRASES.some(([key]) => triggers[key]);
}

/** Enabled · list · triggers on: the plain count. */
export function allowedUsersSummary(count: number): string {
    return `${count} ${count === 1 ? 'user' : 'users'} may trigger`;
}

/**
 * The row's policy clause: the table exists to stop the panel asserting a
 * capability the machine does not have. A disabled binding leads with what
 * cannot happen, then names what *would* under an explicit conditional —
 * leading with the conditional alone would still assert a live capability —
 * and the frame never repeats the word *disabled*, since the row already
 * renders the state. The count sentence obeys the same rule (`… once this
 * binding is enabled`). Nothing reads as an error, and none of it may say
 * *protected*, *restricted*, or *secure*: an absent list is a configuration
 * the operator chose, twice over when disabled — the panel's job is to make
 * both legible, not to scold.
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
 * The row summary for one binding's policy: no list gets the worded warning
 * and no count — printing `0 users` would read as a verdict rather than the
 * absence of a configuration — and a list gets the count and **no** warning.
 */
export function actorsSummary(binding: PanelBinding): string {
    return policyClause({
        state: binding.state,
        triggers: binding.triggers,
        count: binding.allowedUsers === undefined ? null : binding.allowedUsers.length,
    });
}

/**
 * The editor guidance's three states, with the first one **derived**: it once
 * named acts only the `mention` trigger watches, so the derivation supplies the
 * clause in **either mode** — an add-mode draft's switches are the ones the
 * editor is showing, and the guidance says what would hold if the draft were
 * saved. The other two describe the **field's** value rather than the
 * binding's exposure; with nothing switched on there is no surface to derive
 * and the policy clause's own sentence answers.
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
 * The value-slot word an empty field shows, with its consequence derived:
 * `not set` is the honest-absence word, but the clause after it must be derived
 * like the guidance's first state — this placeholder renders on **every**
 * unset field, and a bare *"anyone may trigger"* would be an unframed
 * capability claim sitting in a disabled binding's value slot.
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
 * The **submitted spelling** is preserved verbatim: this is not a canonical
 * form, and re-saving an untouched list must not rewrite how an operator spelled
 * a login.
 */
export function storedActorsText(binding: PanelBinding): string {
    return binding.allowedUsers?.join(', ') ?? '';
}

/**
 * Read the field's text as the array the save carries: split on commas and
 * newlines, trim each entry — and **nothing else**. Folding or de-duplicating
 * would be the panel deciding the stored value; dropping an empty entry would
 * **manufacture `[]`** from typed text, and `[]` is a refusal the service
 * rejects with a sentence the operator then has to interpret. So `alice,`
 * submits `['alice', '']` and the service's remediation names the shape, while
 * a **blank** field submits nothing: a cleared field means *back to open*.
 */
export function parseAllowedUsers(text: string): readonly string[] | null {
    const entries = text
        .split(/[,\n]/)
        .map((entry) => entry.trim());

    return entries.every((entry) => entry === '') ? null : entries;
}

/**
 * Read the service's refusal **if it belongs to the allow-list**: the
 * whole-file grant validates every binding in one pass, so only the one whose
 * own message names `allowedUsers` is painted onto this field and anything
 * else stays on the tab's note — same classification as the prompt's, read
 * from the same envelope, so one answer can never split two ways.
 */
export function actorsRefusal(answer: ServiceErrorResult): string | null {
    if (answer.ok || answer.code !== 'validation' || answer.message === null) {
        return null;
    }

    return answer.message.includes(ALLOWED_USERS_FIELD) ? answer.message : null;
}

export interface BindingActorHandlers {
    readonly setAllowedUsers: (value: string) => void;
}

/**
 * The one binding whose allow-list a whole-file write overrides — the prompt's
 * patch with the **opposite default**: an untouched prompt is omitted because
 * omission means *leave this one alone*, a cleared list because it means
 * *unset*. Every other row carries its own stored value.
 */
export interface ActorPatch {
    readonly bindingId: string;
    /**
     * The logins to submit, or `null` to **omit the key** — how a cleared field
     * takes the binding back to open. An empty array is unreachable here: a
     * blank field parses to `null`, so the client never manufactures `[]`.
     */
    readonly allowedUsers: readonly string[] | null;
}

/**
 * The allow-list patch one save carries, or `undefined` when it carries none.
 *
 * Untouched is **not** "send nothing": the grant sends this binding's stored
 * list whatever the editor did, because a whole-file row that omitted the key
 * would take the binding back to open. Only a change to a blank field omits it.
 */
export function allowedUsersPatch(bindings: BindingsTabState, bindingId: string): ActorPatch | undefined {
    if (!bindings.allowedUsersDirty) {
        return undefined;
    }

    return { bindingId, allowedUsers: parseAllowedUsers(bindings.allowedUsersInput) };
}

export interface BindingActorControls {
    readonly field: TextFieldHandle;
}

/**
 * The state and switches the **editor** is currently showing: the switches are
 * the draft's in **both modes** (`bindings-mount.ts` wires the three
 * checkboxes to the values a save would write), while the **state** is not a
 * form field — a loaded row keeps the service's own state and an add-mode
 * draft is `active` by construction.
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
 * The two controls that decide *what counts as a trigger for this repository*
 * sit next to each other, so the field mounts after the mention-token line and
 * before the fields that are not about triggers.
 */
export function mountBindingActors(input: {
    readonly rt: PanelRuntime;
    readonly pane: HTMLElement;
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
 * Repaint the field from state. The refusal renders **as the field's own
 * helper** directly under the input — a field-level refusal with its
 * remediation, and the service's copy never echoes what was submitted, so it
 * can be shown verbatim; it is the only thing that displaces the resting
 * guidance. The **placeholder** repaints with it, because it carries the unset
 * state's consequence — and the SDK takes a patched subset, so an absent key
 * means *leave what is painted* and omitting it would strand the old wording.
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

export function disposeBindingActors(controls: BindingActorControls): void {
    controls.field.dispose();
}

export function storedActorsFor(bindings: BindingsTabState, bindingId: string | null): string {
    if (bindingId === null) {
        return '';
    }

    const binding = bindings.bindings.find((candidate) => candidate.bindingId === bindingId);

    return binding === undefined ? '' : storedActorsText(binding);
}
