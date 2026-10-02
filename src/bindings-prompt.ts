/**
 * The binding editor's starting-prompt field (005 FR-051, FR-052; 004 FR-014).
 *
 * Exactly one element in the whole panel carries the operator's starting
 * prompt, and this is it: a multiline field in the Bindings editor, fed from
 * `GET /v1/bindings`'s `startingPrompt` and never from an audit fingerprint.
 * The row summary renders presence and length only, so this module — and
 * nothing else — is the one place the text can reach the DOM (FR-051).
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

/** What the field is, in 005 FR-051's words (the operator's instruction). */
export const STARTING_PROMPT_LABEL = 'Starting prompt for dispatches from this repository';

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
            placeholder: 'Leave untouched to keep the prompt that is stored',
            multiline: true,
            rows: 4,
            helper: state.selectedBinding === null ? PROMPT_IDLE : PROMPT_HELPER,
            onChange: (value) => input.handlers.setStartingPrompt(value),
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
 * Two different questions get two different answers here, and conflating them
 * is what made the field dead in add mode:
 *
 * - **the helper follows the selection** — before a row is selected the field
 *   says so, which is the copy an operator sees whether the editor was opened
 *   by a row click or by *New binding*;
 * - **the input follows the editor** — a form the operator has open is
 *   typeable in both modes. *New binding* selects no row *by design* (the
 *   add form's own signal throughout), so keying `disabled` off the selection
 *   disabled the field exactly where it was being used, leaving it rendered
 *   but unfocusable.
 *
 * @param rt - Panel runtime.
 * @param controls - The mounted field.
 */
export function repaintBindingPrompt(rt: PanelRuntime, controls: BindingPromptControls): void {
    const state = rt.state.bindings;
    const selected = state.selectedBinding !== null && state.status !== 'loading';
    const help = state.startingPromptError ?? (selected ? PROMPT_HELPER : PROMPT_IDLE);
    const typeable = state.editorOpen && state.status !== 'loading';

    controls.field.update({
        value: state.startingPromptInput,
        disabled: !typeable,
        helper: help,
    });
}

/**
 * Release the handle the prompt mounted (FR-017).
 *
 * @param controls - The field the pane carries.
 */
export function disposeBindingPrompt(controls: BindingPromptControls): void {
    controls.field.dispose();
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
