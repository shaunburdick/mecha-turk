/**
 * The binding editor's starting-prompt field (005 FR-051, FR-052; 004
 * FR-014): the one element carrying this binding's prompt. It has no button
 * of its own — the editor's primary control writes it with everything else,
 * so 004 FR-014's untouched-omits, cleared-travels, refusal-lands-here rules
 * have exactly one home.
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
 * this one). The five facts, in the operator's terms: the text is sent
 * **verbatim**; there are **no placeholders**; the session runs the
 * operator's **pinned Default Agent**, which this text cannot change; a
 * **credential-shaped value is refused** rather than stored; and there is a
 * **length cap**. It is fixed copy on purpose: a panel sentence that measured
 * or refused anything would be a second validator disagreeing with the one
 * the service runs, so this states what happens and gates nothing.
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
 * Read the service's refusal **if it belongs to the prompt field**: the
 * whole-file grant validates every binding in one pass, so a 422 can be about
 * any of them, and only the one whose message names the prompt may be painted
 * onto the prompt field — anything else stays on the tab's note where it
 * already has a home. Read by the binding editor's one save, so the form and
 * the field always classify the same envelope the same way. `null` when it is
 * not the prompt's.
 */
export function promptRefusal(answer: ServiceErrorResult): string | null {
    if (answer.ok || answer.code !== 'validation' || answer.message === null) {
        return null;
    }

    return answer.message.includes('startingPrompt') ? answer.message : null;
}

export interface BindingPromptHandlers {
    /** The operator typed into the prompt field. */
    readonly setStartingPrompt: (value: string) => void;
}

export interface BindingPromptControls {
    /** The prompt itself — the only element that ever holds its text. */
    readonly field: TextFieldHandle;
}

/**
 * Mount the field into the editor, between the other fields and the form's
 * own action row.
 *
 * @returns The handle the pane carries.
 */
export function mountBindingPrompt(input: {
    readonly rt: PanelRuntime;
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
 * Repaint the field from state. The refusal is rendered **as the field's own
 * helper**, directly under the input, because FR-052 asks for a *field-level*
 * refusal with its remediation — and the service's copy never echoes what was
 * submitted, so it can be shown verbatim; it is the only thing that displaces
 * FR-063's guidance, the field's resting state, which returns the moment the
 * next save is accepted. What the input shows does not depend on the selection:
 * the form is typeable in both modes and *New binding* selects no row *by
 * design*, so the guidance is unconditional — an idle line telling an
 * operator creating a binding to *select* one is copy FR-063 never asked for.
 * Only the readiness of the form still follows the selection.
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
 */
export function disposeBindingPrompt(controls: BindingPromptControls): void {
    controls.field.dispose();
}

/**
 * Read the stored prompt a freshly selected binding carries.
 *
 * @returns The stored text, or `''` when the binding has none.
 */
export function storedPromptFor(bindings: BindingsTabState, bindingId: string | null): string {
    if (bindingId === null) {
        return '';
    }

    return bindings.bindings.find((binding) => binding.bindingId === bindingId)?.startingPrompt ?? '';
}
