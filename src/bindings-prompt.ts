/**
 * The binding editor's starting-prompt field (005 FR-051, FR-052; 004 FR-014).
 *
 * Exactly one element in the whole panel carries the operator's starting
 * prompt, and this is it: a multiline field in the Bindings editor, fed from
 * `GET /v1/bindings`'s `startingPrompt` and never from an audit fingerprint.
 * The row summary renders presence and length only, so this module — and
 * nothing else — is the one place the text can reach the DOM (FR-051).
 *
 * It is its own module for the same reason `dispatches-controls.ts` is: the
 * Bindings pane was already close to the file-length cap, and a second
 * responsibility with its own refusal to render is exactly how a file goes
 * over it.
 *
 * The module deliberately imports neither `panel-ui` nor `bindings.ts`: a
 * control that `bindings-ui` composes *and* `refresh` repaints has to stay a
 * leaf, or the two would form an import cycle. Its actions are the form's
 * handlers in `bindings-mount.ts`, which already owns that table.
 */

import { mountButton, mountTextField } from '@openchamber/sdk/ui';
import type { ButtonHandle, TextFieldHandle } from '@openchamber/sdk/ui';
import type { ServiceErrorResult } from './service-envelope.ts';
import type { BindingsTabState, PanelRuntime } from './panel-state.ts';

/** What the field is, in 005 FR-051's words (the operator's instruction). */
export const STARTING_PROMPT_LABEL = 'Starting prompt for dispatches from this repository';

/** Label of the control that writes the edited prompt. */
export const SAVE_PROMPT_LABEL = 'Save starting prompt';

/** Help under the field while nothing is wrong with it. */
const PROMPT_HELPER = 'Sent first in every dispatch from this binding.';

/** Help under the field before a binding is selected to edit. */
const PROMPT_IDLE = 'Select a binding to edit its starting prompt.';

/**
 * Read the service's refusal **if it belongs to the prompt field** (FR-052).
 *
 * The whole-file grant validates every binding in one pass, so a 422 can be
 * about any of them; only the one whose message names the prompt may be
 * painted onto the prompt field, and anything else stays on the tab's note
 * where it already has a home. Shared by the prompt's own save and by the
 * binding editor's save, so the two cannot classify the same envelope
 * differently.
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

/** Callbacks the field and its save control invoke. */
export interface BindingPromptHandlers {
    /** The operator typed into the prompt field. */
    readonly setStartingPrompt: (value: string) => void;
    /** The operator saved the edited prompt. */
    readonly saveStartingPrompt: () => void;
}

/** The field and its save control, as the pane carries them. */
export interface BindingPromptControls {
    /** The prompt itself — the only element that ever holds its text. */
    readonly field: TextFieldHandle;
    /** Writes the edit through the whole-file grant. */
    readonly save: ButtonHandle;
}

/**
 * Mount the field and its save control into the pane.
 *
 * @param input - Runtime, pane root, and the handlers the controls invoke.
 * @returns The two handles the pane carries.
 */
export function mountBindingPrompt(input: {
    /** Runtime whose state the field renders from. */
    readonly rt: PanelRuntime;
    /** Pane root the controls mount into. */
    readonly pane: HTMLElement;
    /** Handlers the controls invoke. */
    readonly handlers: BindingPromptHandlers;
}): BindingPromptControls {
    const state = input.rt.state.bindings;

    return {
        field: mountTextField(input.pane, {
            label: STARTING_PROMPT_LABEL,
            value: state.startingPromptInput,
            placeholder: 'Leave untouched to keep the prompt that is stored',
            multiline: true,
            rows: 4,
            helper: state.selectedBinding === null ? PROMPT_IDLE : PROMPT_HELPER,
            onChange: (value) => input.handlers.setStartingPrompt(value),
        }),
        save: mountButton(input.pane, {
            label: SAVE_PROMPT_LABEL,
            variant: 'secondary',
            disabled: true,
            onClick: input.handlers.saveStartingPrompt,
        }),
    };
}

/**
 * Repaint the field from state (FR-051, FR-052).
 *
 * The refusal is rendered **as the field's own helper**, directly under the
 * input, because FR-052 asks for a *field-level* refusal with its
 * remediation — and the service's copy never echoes what was submitted, so it
 * can be shown verbatim (FR-085).
 *
 * @param rt - Panel runtime.
 * @param controls - The mounted field and save control.
 */
export function repaintBindingPrompt(rt: PanelRuntime, controls: BindingPromptControls): void {
    const state = rt.state.bindings;
    const editable = state.selectedBinding !== null && state.status !== 'loading';
    const help = state.startingPromptError ?? (editable ? PROMPT_HELPER : PROMPT_IDLE);

    controls.field.update({
        value: state.startingPromptInput,
        disabled: !editable,
        helper: help,
    });
    controls.save.update({ disabled: !editable || !state.startingPromptDirty });
}

/**
 * Release the two handles the prompt mounted (FR-017).
 *
 * @param controls - The field and save control the pane carries.
 */
export function disposeBindingPrompt(controls: BindingPromptControls): void {
    controls.field.dispose();
    controls.save.dispose();
}

/**
 * Read the stored prompt a freshly selected binding carries (004 FR-012).
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
