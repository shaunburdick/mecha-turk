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
import type { PanelBinding } from './bindings-service.ts';

/** The wire member this field is the panel's client of record for (contract §2). */
export const ALLOWED_USERS_FIELD = 'allowedUsers';

/**
 * What the field is, in 005 FR-090's words: the set of GitHub logins allowed
 * to trigger dispatches from **this repository**.
 *
 * It names the binding's own scope rather than the product's, because an
 * allow-list is per binding — one repository, one project — and a label that
 * said "the account" or "the service" would describe a control that does not
 * exist.
 */
export const ALLOWED_USERS_LABEL = 'GitHub logins allowed to trigger dispatches from this repository';

/**
 * FR-090's guidance: **all three** of 002 FR-047's states, in the field's own
 * words, without the operator opening anything else.
 *
 * The three are stated in the order the operator meets them:
 *
 * 1. **No list** — anyone who can open an issue or comment on this repository
 *    may start a session. Named as a consequence, because that is what makes the
 *    state legible rather than merely configured (005 clarification row 41).
 * 2. **A list** — exactly those logins may.
 * 3. **An empty list is refused, not "nobody"** — and the way to stop *every*
 *    trigger is to disable the binding, which is what actually means that.
 *
 * The field's own validation is named as the service's, because the panel has
 * none (002 FR-024) and an operator who finds out otherwise will type
 * something the service refuses and lose the sentence explaining why.
 *
 * It is fixed copy on purpose: a panel sentence that measured or refused
 * anything would be a second validator disagreeing with the one the service
 * runs, so this states what happens and gates nothing (005 plan D24's rule,
 * applied).
 */
export const ALLOWED_USERS_GUIDANCE =
    'One GitHub login per entry. With no list, anyone who can open an issue or comment on this repository '
    + 'may start a session; with a list, only those logins may. An empty list is refused rather than read as '
    + '"nobody" — to stop every trigger, disable the binding instead. The service validates this field, and '
    + 'an empty field leaves it unset.';

/**
 * FR-064's honest-absence word, shown in the value slot while the field is
 * empty — the same word the prompt fields and the Settings row use, so an
 * unset allow-list reads as one state wherever it appears (005 FR-091).
 */
export const ALLOWED_USERS_NOT_SET = 'not set — anyone may trigger this repository';

/**
 * The absent-policy warning a row carries (005 FR-092).
 *
 * **Text, not colour alone** (FR-083), and **information, not an error**: an
 * absent list is a configuration the operator chose and may reasonably keep on
 * a public repository, so this states who can trigger the binding and names the
 * field that restricts it, without scolding, without a modal, and without any
 * of the words *protected*, *restricted*, or *secure* (005 NFR-113 — the panel
 * may never imply a control the service has not reported).
 */
export const ALLOWED_USERS_WARNING =
    'open to anyone — anyone who can open an issue or comment on this repository can start a session; '
    + 'name the logins who may in allowedUsers to change that';

/**
 * The row summary for a binding that **does** carry a list (005 FR-091).
 *
 * The **count only**, in the same presence-and-length-only spirit as the
 * prompt's row summary: a count is not a second rendering of the value, while a
 * login would be (005 clarification row 40).
 *
 * @param count - How many logins the stored list holds.
 * @returns `N users may trigger`.
 */
export function allowedUsersSummary(count: number): string {
    return `${count} ${count === 1 ? 'user' : 'users'} may trigger`;
}

/**
 * The row summary for one binding's policy: its count, or the worded warning.
 *
 * A binding with **no** list gets the warning and no count (there is nothing
 * to count, and printing `0 users` would read as a verdict rather than as the
 * absence of a configuration); a binding **with** one gets the count and **no**
 * warning (005 FR-092, AC-143, AC-144).
 *
 * @param binding - The binding whose row is being composed.
 * @returns The row's own clause.
 */
export function actorsSummary(binding: PanelBinding): string {
    if (binding.allowedUsers === undefined) {
        return ALLOWED_USERS_WARNING;
    }

    return allowedUsersSummary(binding.allowedUsers.length);
}

/**
 * Render the stored list as the field's text.
 *
 * Comma-separated with a comma and a space, which is what the guidance's "one
 * login per entry" implies and what {@link parseAllowedUsers} reads back. The
 * **submitted spelling** is preserved verbatim (002 FR-047): this is not a
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
 * an empty entry. Each omission is a decision (002 FR-024, 005 FR-090):
 *
 * - Folding or de-duplicating would be the panel deciding the stored value, and
 *   the service's stored spelling must survive a re-save unchanged.
 * - Dropping an empty entry would **manufacture `[]`** from text the operator
 *   wrote, and `[]` is a refusal (002 FR-047) — the panel must not turn a
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
 * envelope, so one answer can never split two ways (FR-052, FR-095).
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

    return {
        field: mountTextField(input.pane, {
            label: ALLOWED_USERS_LABEL,
            value: state.allowedUsersInput,
            placeholder: ALLOWED_USERS_NOT_SET,
            helper: ALLOWED_USERS_GUIDANCE,
            onChange: (value) => input.handlers.setAllowedUsers(value),
        }),
    };
}

/**
 * Repaint the field from state (005 FR-090, FR-095).
 *
 * The refusal is rendered **as the field's own helper**, directly under the
 * input, because FR-095 asks for a *field-level* refusal with its remediation —
 * and the service's copy never echoes what was submitted, so it can be shown
 * verbatim (FR-085). It is the only thing that displaces FR-090's guidance:
 * the guidance is the field's resting state, and it comes back the moment the
 * service accepts the next save.
 *
 * What the input shows does not depend on the selection: a form the operator
 * has open is typeable in both modes, exactly as the prompt field beside it is.
 *
 * @param rt - Panel runtime.
 * @param controls - The mounted field.
 */
export function repaintBindingActors(rt: PanelRuntime, controls: BindingActorControls): void {
    const state = rt.state.bindings;
    const typeable = state.editorOpen && state.status !== 'loading';

    controls.field.update({
        value: state.allowedUsersInput,
        disabled: !typeable,
        helper: state.allowedUsersError ?? ALLOWED_USERS_GUIDANCE,
    });
}

/**
 * Release the handle the allow-list field mounted (FR-017).
 *
 * @param controls - The field the pane carries.
 */
export function disposeBindingActors(controls: BindingActorControls): void {
    controls.field.dispose();
}

/**
 * Read the stored allow-list a freshly selected binding carries (002 FR-047).
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
