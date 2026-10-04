/**
 * The binding editor's starting-prompt field (005 FR-051, FR-052; 004 FR-014).
 *
 * Exactly one element carries *this binding's* starting prompt, and this is
 * it: a multiline field in the Bindings editor, fed from `GET /v1/bindings`'s
 * `startingPrompt` and never from an audit fingerprint. The row summary
 * renders presence and length only, so this module — and nothing else — is
 * the one place this binding's text can reach the DOM (005 FR-051 as re-cut
 * at v1.9.0: one rendering *per tier value*; this is the binding tier's).
 *
 * The field also carries the two rules that belong to every surface a tier
 * is rendered on (004 FR-089, AC-144): FR-063's five-fact guidance beside
 * the input, and FR-064's honest `not set` in the value slot while nothing
 * is set.
 *
 * **The field has no button of its own.** It is a field of the binding's
 * form, so the editor's own primary control writes it with everything else
 * (2026-10-01 review: the prompt belongs to the binding, so it saves
 * alongside the rest) — and 004 FR-014's rules ride that write unchanged: a
 * field the operator left alone omits `startingPrompt` entirely, a cleared
 * one travels as an explicit empty value, and a refusal lands back on this
 * field with the service's remediation.
 *
 * It is its own module for the same reason `dispatches-controls.ts` is: the
 * Bindings pane was already close to the file-length cap, and a second
 * responsibility with its own refusal to render is exactly how a file goes
 * over it.
 *
 * The module deliberately imports neither `panel-ui` nor `bindings.ts`: a
 * control that `bindings-ui` composes *and* `refresh` repaints has to stay a
 * leaf, or the two would form an import cycle. Its handler is the form's own
 * in `bindings-mount.ts`, which already owns that table.
 */

import { mountTextField } from '@openchamber/sdk/ui';
import type { TextFieldHandle } from '@openchamber/sdk/ui';
import type { ServiceErrorResult } from './service-envelope.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';

/** What the field is words (the operator's instruction). */
export const STARTING_PROMPT_LABEL = 'Starting prompt for dispatches from this repository';

/**
 * FR-063's guidance, fixed beside the binding-tier field (004 FR-089: the
 * guidance travels with *every* surface that renders a tier, and AC-144 names
 * this one).
 *
 * The five facts, in the operator's terms: the text is sent **verbatim**;
 * there are **no placeholders**; the session runs the operator's **pinned
 * Default Agent**, which this text cannot change; a **credential-shaped
 * value is refused** rather than stored; and there is a **length cap** —
 * the same substance `accounts-rows.ts` states on the Accounts tab and the
 * service's `format` states for the Settings row, with this field's own
 * first sentence kept, because *sent first in every dispatch from this
 * binding* is what the field is.
 *
 * It is fixed copy on purpose: a panel sentence that measured or refused
 * anything would be a second validator disagreeing with the one the service
 * runs, so this states what happens and gates nothing.
 */
export const PROMPT_GUIDANCE =
    'Sent first in every dispatch from this binding, to the agent verbatim — there are no '
    + 'placeholders, and the session runs the pinned Default Agent, which this text cannot change. '
    + 'A credential-shaped value is refused rather than stored, and the cap is 2,000 characters.';

/**
 * FR-064's honest-absence word, shown in the value slot while the field is
 * empty.
 *
 * An empty text box reads as an empty instruction the agent will receive;
 * this says otherwise instead — the same word the Settings row and the
 * Accounts field use, so an unset tier reads as one state on all three
 * surfaces.
 */
export const PROMPT_NOT_SET = 'not set';

/**
 * Read the service's refusal **if it belongs to the prompt field**.
 *
 * The whole-file grant validates every binding in one pass, so a 422 can be
 * about any of them; only the one whose message names the prompt may be
 * painted onto the prompt field, and anything else stays on the tab's note
 * where it already has a home. It is read by the binding editor's one save,
 * so the form and the field always classify the same envelope the same way.
 *
 * @param answer - The grant's answer.
 * @returns The field-level copy to render, or `null` when it is not the prompt's.
 */
export function promptRefusal(answer: ServiceErrorResult): string | null {
    if (answer.ok || answer.code !== 'validation' || answer.message === null) {
        return null;
    }

    return answer.message.includes('startingPrompt') ? answer.message : null;
}

/** Callbacks the field invokes. */
export interface BindingPromptHandlers {
    /** The operator typed into the prompt field. */
    readonly setStartingPrompt: (value: string) => void;
}

/** The field, as the pane carries it. */
export interface BindingPromptControls {
    /** The prompt itself — the only element that ever holds its text. */
    readonly field: TextFieldHandle;
}

/**
 * Mount the field into the editor, between the other fields and the form's
 * own action row.
 *
 * @param input - Runtime, editor root, and the handler the field invokes.
 * @returns The handle the pane carries.
 */
export function mountBindingPrompt(input: {
    /** Runtime whose state the field renders from. */
    readonly rt: PanelRuntime;
    /** Editor root the field mounts into. */
    readonly pane: HTMLElement;
    /** Handler the field invokes. */
    readonly handlers: BindingPromptHandlers;
}): BindingPromptControls {
    const state = input.rt.state.bindings;

    return {
        field: mountTextField(input.pane, {
            label: STARTING_PROMPT_LABEL,
            value: state.startingPromptInput,
            placeholder: PROMPT_NOT_SET,
            multiline: true,
            rows: 4,
            helper: PROMPT_GUIDANCE,
            onChange: (value) => input.handlers.setStartingPrompt(value),
        }),
    };
}

/**
 * Repaint the field from state.
 *
 * The refusal is rendered **as the field's own helper**, directly under the
 * input, because FR-052 asks for a *field-level* refusal with its
 * remediation — and the service's copy never echoes what was submitted, so it
 * can be shown verbatim. It is the only thing that displaces
 * FR-063's guidance: the guidance is the field's resting state, and it comes
 * back the moment the service accepts the next save.
 *
 * What the input shows does not depend on the selection: a form the operator
 * has open is isTypeable in both modes, and *New binding* selects no row *by
 * design* (the add form's own signal throughout). That is also why the
 * guidance is unconditional — an idle line telling an operator who is
 * creating a binding to *select* one is copy FR-063 never asked for, and
 * FR-089 applies the five facts to this field whether or not a row is
 * selected. Only the readiness of the form still follows the selection.
 *
 * @param rt - Panel runtime.
 * @param controls - The mounted field.
 */
export function repaintBindingPrompt(rt: PanelRuntime, controls: BindingPromptControls): void {
    const state = rt.state.bindings;
    const isTypeable = state.editorOpen && state.status !== 'loading';

    controls.field.update({
        value: state.startingPromptInput,
        disabled: !isTypeable,
        helper: state.startingPromptError ?? PROMPT_GUIDANCE,
    });
}

/**
 * Release the handle the prompt mounted.
 *
 * @param controls - The field the pane carries.
 */
export function disposeBindingPrompt(controls: BindingPromptControls): void {
    controls.field.dispose();
}

/**
 * Read the stored prompt a freshly selected binding carries.
 *
 * @param bindings - The Bindings tab's state.
 * @param bindingId - The row the operator selected.
 * @returns The stored text, or `''` when the binding has none.
 */
export function storedPromptFor(bindings: BindingsTabState, bindingId: string | null): string {
    if (bindingId === null) {
        return '';
    }

    return bindings.bindings.find((binding) => binding.bindingId === bindingId)?.startingPrompt ?? '';
}
