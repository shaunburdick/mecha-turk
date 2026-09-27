/**
 * Rendering for the one-shot handoff (task T-009, contract §2 steps ①③⑨ and
 * §4 rule 5).
 *
 * Two halves, deliberately separated. {@link renderHandoff} is pure: it maps
 * {@link HandoffState} onto a {@link HandoffView} as strings and booleans, so
 * the whole render surface is testable without a DOM and every rendered
 * string can be scanned for secrets. {@link mountHandoffDom} is the thin DOM
 * adapter that applies those strings — **only** through `textContent` and
 * `setAttribute`, never `innerHTML`, `insertAdjacentHTML`, or any HTML-parsing
 * sink (SEC-14: redaction is not output-encoding; a string that survived
 * redaction is still untrusted input).
 *
 * The consent block renders `CONSENT_COPY_V1` verbatim: the view receives the
 * contract's own copy and is never handed a paraphrase, a trim, or a
 * concatenation with other copy (token-handoff §1.1, SEC-12).
 */

import { CONSENT_COPY_V1 } from './consent.ts';
import { connectedLine } from './handoff-copy.ts';
import { acceptHandoffConsent, runHandoff } from './handoff.ts';
import { preflightHandoff } from './handoff-status.ts';
import type { HandoffState } from './handoff.ts';
import type { PanelRuntime } from './panel-state.ts';

/** Callbacks the mounted handoff group invokes. */
export interface HandoffHandlers {
    /** The operator accepted the consent step. */
    readonly accept: () => void;
    /** The operator declined the consent step. */
    readonly decline: () => void;
    /** The operator submitted the pasted credential. */
    readonly submit: (token: string) => void;
}

/** Every surface the render step may write to. */
export interface HandoffView {
    /** Render the canonical consent copy (verbatim, contract §1.1). */
    setConsentText(text: string): void;
    /** Show or hide the consent step (hidden once the current copy is accepted). */
    showConsent(show: boolean): void;
    /** Enable or disable the credential input (F10 pre-flight gate). */
    setTokenEnabled(enabled: boolean): void;
    /** Replace the credential input's value; `''` clears it. */
    setTokenValue(value: string): void;
    /** Render the operator-facing note; never credential material. */
    setNote(text: string): void;
    /** Render `Connected as <login>`, or hide the line with `null`. */
    setConnected(text: string | null): void;
    /** Enable or disable the submit button. */
    setSubmitEnabled(enabled: boolean): void;
    /** Remove every node this view created. */
    dispose(): void;
}

/**
 * Decide whether the credential input and submit button may be active.
 *
 * The input stays disabled until the pre-flight proved the service storage is
 * writable (F10/SEC-08) and the current consent copy has been accepted (F11).
 *
 * @param state - Current handoff state.
 * @returns `true` when the operator may type and submit a credential.
 */
export function handoffInputEnabled(state: HandoffState): boolean {
    return state.consentGiven && state.storageWritable && !state.busy;
}

/**
 * Apply the handoff state to a view.
 *
 * @param state - Current handoff state.
 * @param view - Surface to write to; the consent copy is passed verbatim.
 */
export function renderHandoff(state: HandoffState, view: HandoffView): void {
    view.setConsentText(CONSENT_COPY_V1);
    view.showConsent(!state.consentGiven);
    const enabled = handoffInputEnabled(state);
    view.setTokenEnabled(enabled);
    view.setSubmitEnabled(enabled);
    view.setNote(state.note);
    view.setConnected(state.connected === null ? null : connectedLine(state.connected.login));
}

/**
 * Repaint the mounted handoff group from the current state.
 *
 * A panel without a mounted group (the tests, and any surface that hides the
 * accounts UI) repaints nothing — the state is still authoritative.
 *
 * @param rt - Panel runtime carrying state and, possibly, the mounted view.
 */
export function refreshHandoff(rt: PanelRuntime): void {
    if (rt.handoffView !== null) {
        renderHandoff(rt.state.handoff, rt.handoffView);
    }
}

/**
 * Run the handoff pre-flight after mount and repaint the group.
 *
 * @param rt - Panel runtime whose handoff group may be mounted.
 */
export async function preflightAndRepaint(rt: PanelRuntime): Promise<void> {
    await preflightHandoff(rt);
    if (!rt.disposed) {
        refreshHandoff(rt);
    }
}

/**
 * Accept the handoff consent, then repaint the group.
 *
 * @param rt - Panel runtime.
 */
export async function acceptConsentAndRepaint(rt: PanelRuntime): Promise<void> {
    await acceptHandoffConsent(rt);
    refreshHandoff(rt);
}

/**
 * Run one handoff and repaint twice: once as it starts (the group disables
 * itself while the credential is in flight) and once when it settles.
 *
 * @param rt - Panel runtime.
 * @param token - The credential the operator pasted.
 */
export async function submitHandoffAndRepaint(rt: PanelRuntime, token: string): Promise<void> {
    const inFlight = runHandoff(rt, { token });
    refreshHandoff(rt);
    await inFlight;
    refreshHandoff(rt);
}

/** What the mount step needs: a root to append to and the handlers to wire. */
interface DomInput {
    /** Panel root the group is appended to. */
    readonly root: HTMLElement;
    /** Callbacks the buttons invoke. */
    readonly handlers: HandoffHandlers;
}

/** Where the consent step was mounted, for later repaints. */
interface ConsentStep {
    /** Container holding the copy and the two decisions. */
    readonly box: HTMLElement;
    /** Node the canonical consent copy is written into as text. */
    readonly text: HTMLElement;
}

/** Where the credential row was mounted, for later repaints. */
interface CredentialField {
    /** Container holding the caption, input, and note. */
    readonly field: HTMLElement;
    /** The dedicated credential input (`type="password"`, SEC-17). */
    readonly input: HTMLInputElement;
    /** Node the operator-facing note is written into as text. */
    readonly note: HTMLElement;
}

/** DOM factory inputs: the frame's document plus the handlers to wire. */
interface DomFactory {
    /** Document to create in (the frame's, never a global). */
    readonly doc: Document;
    /** Callbacks the buttons invoke. */
    readonly handlers: HandoffHandlers;
}

/**
 * Create one element with the SDK's own class names.
 *
 * @param spec - Document, tag name, and class attribute.
 * @returns The element.
 */
function makeElement(spec: { readonly doc: Document; readonly tag: string; readonly className: string }): HTMLElement {
    const node = spec.doc.createElement(spec.tag);
    node.className = spec.className;

    return node;
}

/**
 * Create a button whose label is written as text, never as markup.
 *
 * @param spec - Document, label, and click handler.
 * @returns The button.
 */
function makeButton(spec: {
    readonly doc: Document;
    readonly label: string;
    readonly onClick: () => void;
}): HTMLButtonElement {
    const button = spec.doc.createElement('button');
    button.className = 'oc-sdk oc-sdk-btn';
    button.type = 'button';
    button.textContent = spec.label;
    button.addEventListener('click', spec.onClick);

    return button;
}

/**
 * Mount the consent step: the canonical copy plus accept and decline.
 *
 * @param spec - Document and the handlers the two decisions invoke.
 * @returns The consent step's container and text node.
 */
function mountConsentStep(spec: DomFactory): ConsentStep {
    const box = makeElement({ doc: spec.doc, tag: 'div', className: 'oc-sdk-row' });
    const text = makeElement({ doc: spec.doc, tag: 'p', className: 'oc-sdk-field-note' });
    text.style.whiteSpace = 'pre-line';
    const accept = makeButton({
        doc: spec.doc,
        label: 'Accept and continue',
        onClick: spec.handlers.accept,
    });
    const decline = makeButton({ doc: spec.doc, label: 'Decline', onClick: spec.handlers.decline });
    box.append(text, accept, decline);

    return { box, text };
}

/**
 * Mount the credential row: caption, dedicated password input, and note.
 *
 * The input is `type="password"` with `autocomplete="new-password"`
 * (token-handoff §2 step ①/SEC-17) so the browser's credential manager offers
 * to *save* what was typed rather than to autofill a stored secret.
 *
 * @param doc - Document to create in.
 * @returns The row's container, input, and note node.
 */
function mountCredentialField(doc: Document): CredentialField {
    const field = makeElement({ doc, tag: 'label', className: 'oc-sdk oc-sdk-field' });
    const caption = makeElement({ doc, tag: 'span', className: 'oc-sdk-field-label' });
    caption.textContent = 'GitHub token';
    const input = doc.createElement('input');
    input.className = 'oc-sdk-input';
    input.setAttribute('type', 'password');
    input.setAttribute('autocomplete', 'new-password');
    input.setAttribute('aria-label', 'GitHub token');
    const note = makeElement({ doc, tag: 'span', className: 'oc-sdk-field-note' });
    field.append(caption, input, note);

    return { field, input, note };
}

/**
 * Mount the handoff group: consent step, credential input, and outcome lines.
 *
 * @param input - Panel root and the callbacks the buttons invoke.
 * @returns The view over the mounted nodes.
 */
export function mountHandoffDom(input: DomInput): HandoffView {
    const { root, handlers } = input;
    const doc = root.ownerDocument;
    const group = makeElement({ doc, tag: 'div', className: 'oc-sdk' });
    const consent = mountConsentStep({ doc, handlers });
    const credential = mountCredentialField(doc);
    const submit = makeButton({
        doc,
        label: 'Connect account',
        onClick: () => handlers.submit(credential.input.value),
    });
    const connected = makeElement({ doc, tag: 'span', className: 'oc-sdk-text' });
    connected.hidden = true;

    group.append(consent.box, credential.field, submit, connected);
    root.append(group);

    return {
        setConsentText: (text: string): void => {
            consent.text.textContent = text;
        },
        showConsent: (show: boolean): void => {
            consent.box.hidden = !show;
        },
        setTokenEnabled: (enabled: boolean): void => {
            credential.input.disabled = !enabled;
        },
        setTokenValue: (value: string): void => {
            credential.input.value = value;
        },
        setNote: (text: string): void => {
            credential.note.textContent = text;
            credential.note.hidden = text === '';
        },
        setConnected: (text: string | null): void => {
            connected.textContent = text ?? '';
            connected.hidden = text === null;
        },
        setSubmitEnabled: (enabled: boolean): void => {
            submit.disabled = !enabled;
        },
        dispose: (): void => {
            group.remove();
        },
    };
}
