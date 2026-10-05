/**
 * Rendering for the one-shot handoff (task T-009, contract §2 steps ①④⑨ and
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
 * The Accept/Decline consent step this adapter used to mount is gone
 * (product-owner order 2026-10-01): the flow is paste → connect, and the
 * substance the consent copy carried now sits under the Accounts section as
 * the static, button-free disclaimer in
 * [`accounts-disclaimer.ts`](./accounts-disclaimer.ts).
 *
 * The credential input never retains a paste: the mount step writes the value
 * through at capture (read + `value = ''` in the same tick) and
 * {@link submitHandoffAndRepaint} clears the view again in `finally`, so both
 * halves of contract §2 step ⑧ — the module-scoped variable *and* the input —
 * are emptied on every exit.
 */

import { adoptServiceAccounts } from './account-adoption.ts';
import { connectedLine } from './handoff-copy.ts';
import { runHandoff } from './handoff.ts';
import { preflightHandoff } from './handoff-status.ts';
import type { HandoffState } from './handoff.ts';
import type { PanelRuntime } from './panel-state.ts';

/** The SDK's field-note class, shared by every note this adapter writes. */
const FIELD_NOTE_CLASS = 'oc-sdk-field-note';

/** Callbacks the mounted handoff group invokes. */
export interface HandoffHandlers {
    /**
     * The operator submitted the pasted credential.
     *
     * The second argument is the optional expected-login constraint:
     * an empty string means *no constraint*, which is what the caller sends
     * when the field was left alone.
     */
    readonly submit: (token: string, expectedLogin: string) => void;
}

/** Every surface the render step may write to. */
export interface HandoffView {
    /** Enable or disable the credential input (F10 pre-flight gate). */
    setTokenEnabled(isEnabled: boolean): void;
    /** Replace the credential input's value; `''` clears it (§2 step ⑧). */
    setTokenValue(value: string): void;
    /** Render the operator-facing note; never credential material. */
    setNote(text: string): void;
    /** Render `Connected as <login>`, or hide the line with `null`. */
    setConnected(text: string | null): void;
    /** Show or hide the paste row (credential input and submit). */
    setPasteVisible(isVisible: boolean): void;
    /** Enable or disable the submit button. */
    setSubmitEnabled(isEnabled: boolean): void;
    /** Remove every node this view created. */
    dispose(): void;
}

/**
 * Decide whether the credential input and submit button may be active.
 *
 * The input stays disabled until the pre-flight proved the service storage is
 * writable (F10/SEC-08).
 *
 * @returns `true` when the operator may type and submit a credential.
 */
export function handoffInputEnabled(state: HandoffState): boolean {
    return state.storageWritable && !state.busy;
}

/**
 * Apply the handoff state to a view.
 *
 * A connected account — adopted from the service or handed off one-shot —
 * hides the paste row: the paste field must not offer a credential the
 * service already holds (MVP blocker 2).
 *
 * @param view - Surface to write to.
 */
export function renderHandoff(state: HandoffState, view: HandoffView): void {
    const isConnected = state.connected !== null;
    view.setPasteVisible(!isConnected);
    const isEnabled = handoffInputEnabled(state);
    view.setTokenEnabled(isEnabled);
    view.setSubmitEnabled(isEnabled);
    view.setNote(state.note);
    view.setConnected(state.connected === null ? null : connectedLine(state.connected.login));
}

/**
 * Repaint the mounted handoff group from the current state.
 *
 * A panel without a mounted group (the tests, and any surface that hides the
 * accounts UI) repaints nothing — the state is still authoritative.
 */
export function refreshHandoff(rt: PanelRuntime): void {
    if (rt.handoffView !== null) {
        renderHandoff(rt.state.handoff, rt.handoffView);
    }
}

/**
 * Run the handoff pre-flight after mount and repaint the group.
 *
 * The pre-flight is preceded by the silent account adoption: a service-side
 * account the mirror lost (extension reinstall) is adopted from
 * `GET /v1/accounts` before the operator is shown a paste form that could
 * only end in the service's duplicate refusal (MVP blocker 2).
 */
export async function preflightAndRepaint(rt: PanelRuntime): Promise<void> {
    await adoptServiceAccounts(rt);
    await preflightHandoff(rt);
    if (!rt.disposed) {
        refreshHandoff(rt);
    }
}

/**
 * What one submit carries: the pasted credential and its constraint.
 *
 * Bundled rather than passed as separate arguments so the handoff keeps its
 * two-parameter shape, and so a future optional field joins this record
 * instead of growing the signature again.
 */
export interface HandoffSubmission {
    /** The pasted credential; lives only in the call's scope. */
    readonly token: string;
    /** Optional expected-login constraint; omitted means none. */
    readonly expectedLogin?: string;
}

/**
 * Run one handoff and repaint twice: once as it starts (the group disables
 * itself while the credential is in flight) and once when it settles.
 *
 * The credential input is cleared in `finally`, on **every** exit — success,
 * service refusal, host failure, timeout, or a thrown error — so a paste never
 * survives the handoff it belonged to (contract §2 step ⑧). The mount
 * step already wrote the value through at capture time (it reads the input and
 * empties it before the request starts); this second clear is what removes a
 * value that reappeared while the request was in flight, and it is why
 * {@link HandoffView.setTokenValue} has a production call site.
 *
 * The expected-login constraint travels only when the operator
 * typed one: an empty or blank field omits the `expectedLogin` member
 * entirely, which is how the service is told *no constraint* and stores
 * `expectedLogin: null`.
 *
 * @param submission - The pasted credential and its optional constraint.
 */
export async function submitHandoffAndRepaint(
    rt: PanelRuntime,
    submission: HandoffSubmission,
): Promise<void> {
    const constraint = submission.expectedLogin?.trim() ?? '';
    try {
        const input =
            constraint === ''
                ? { token: submission.token }
                : { token: submission.token, expectedLogin: constraint };
        const inFlight = runHandoff(rt, input);
        refreshHandoff(rt);
        await inFlight;
    } finally {
        rt.handoffView?.setTokenValue('');
        refreshHandoff(rt);
    }
}

/** What the mount step needs: a root to append to and the handlers to wire. */
interface DomInput {
    /** Panel root the group is appended to. */
    readonly root: HTMLElement;
    /** Callbacks the buttons invoke. */
    readonly handlers: HandoffHandlers;
}

/** Where the credential row was mounted, for later repaints. */
interface CredentialField {
    /** Container holding both inputs, hidden together once connected. */
    readonly field: HTMLElement;
    /** The dedicated credential input (`type="password"`, SEC-17). */
    readonly input: HTMLInputElement;
    /** Node the operator-facing note is written into as text. */
    readonly note: HTMLElement;
    /** The optional expected-login input — the form's only other field (FR-006). */
    readonly expected: HTMLInputElement;
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

/** The SDK button variants this adapter may ask for; the SDK reads `data-variant`. */
type HandoffButtonVariant = 'default' | 'outline';

/**
 * Create a button whose label is written as text, never as markup.
 *
 * **The variant is not optional.** The SDK's sheet gives `.oc-sdk-btn` only a
 * transparent border as its base and paints every real treatment from an
 * attribute selector (`[data-variant="…"]`), so a button with no variant is
 * bare text on the page — which is how every button here used to read before
 * the variant rule landed (product-owner review 2026-10-01). The attribute is
 * written through `dataset`, which records the same `data-variant` the sheet's
 * selector matches.
 *
 * @param spec - Document, label, variant, and click handler.
 * @returns The button.
 */
function makeButton(spec: {
    readonly doc: Document;
    readonly label: string;
    readonly variant: HandoffButtonVariant;
    readonly onClick: () => void;
}): HTMLButtonElement {
    const button = spec.doc.createElement('button');
    button.className = 'oc-sdk oc-sdk-btn';
    button.dataset.variant = spec.variant;
    button.type = 'button';
    button.textContent = spec.label;
    button.addEventListener('click', spec.onClick);

    return button;
}

/**
 * Mount the optional expected-login input.
 *
 * The add form's **only** other field: a plain login string the *service*
 * validates, so the panel renders it as an ordinary optional input with no
 * local verdict (FR-052's rule). It is emptied at capture for the opposite
 * reason the token is — not because it is secret, but because a constraint
 * left in the field would silently apply to the next account added.
 *
 * @param doc - Document to create in (the frame's, never a global).
 * @returns The field container and its input.
 */
function mountExpectedLoginField(doc: Document): {
    /** The label container the caption, input, and hint sit in. */
    readonly field: HTMLElement;
    /** The input itself. */
    readonly input: HTMLInputElement;
} {
    const field = makeElement({ doc, tag: 'label', className: 'oc-sdk oc-sdk-field' });
    const caption = makeElement({ doc, tag: 'span', className: 'oc-sdk-field-label' });
    caption.textContent = 'Expected GitHub login (optional)';
    const input = doc.createElement('input');
    input.className = 'oc-sdk-input';
    input.setAttribute('type', 'text');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', 'Expected GitHub login');
    const hint = makeElement({ doc, tag: 'span', className: FIELD_NOTE_CLASS });
    hint.textContent = 'Optional: leave empty to add the account with no login constraint.';
    field.append(caption, input, hint);

    return { field, input };
}

/**
 * Mount the credential row: caption, dedicated password input, and note.
 *
 * The input is `type="password"` with `autocomplete="new-password"`
 * (token-handoff §2 step ①/SEC-17) so the browser's credential manager offers
 * to *save* what was typed rather than to autofill a stored secret. The
 * expected-login field sits in the same row so the two hide together once an
 * account is connected (the paste row is then pointless for both).
 *
 * @returns The row's container, both inputs, and the note node.
 */
function mountCredentialField(doc: Document): CredentialField {
    const row = makeElement({ doc, tag: 'div', className: 'oc-sdk' });
    const field = makeElement({ doc, tag: 'label', className: 'oc-sdk oc-sdk-field' });
    const caption = makeElement({ doc, tag: 'span', className: 'oc-sdk-field-label' });
    caption.textContent = 'GitHub token';
    const input = doc.createElement('input');
    input.className = 'oc-sdk-input';
    input.setAttribute('type', 'password');
    input.setAttribute('autocomplete', 'new-password');
    input.setAttribute('aria-label', 'GitHub token');
    const note = makeElement({ doc, tag: 'span', className: FIELD_NOTE_CLASS });
    field.append(caption, input, note);
    const expected = mountExpectedLoginField(doc);
    row.append(field, expected.field);

    return { field: row, input, note, expected: expected.input };
}

/**
 * Mount the submit button with the capture-time write-through.
 *
 * The pasted credential is read and the input emptied in the **same tick**, so
 * the DOM holds the value only between the paste and the click — one shot, no
 * cache, no retry buffer (contract §2 steps ② and ⑧). The expected
 * login is captured the same way and for the inverse reason: it is not a
 * secret, but an empty field has to *stay* empty, or a constraint typed for
 * one account would be submitted with the next one (FR-006: absent or empty
 * means no constraint).
 *
 * @param spec - Document, both inputs to read, and the callbacks.
 * @returns The wired submit button.
 */
function mountSubmitButton(spec: {
    /** Document to create the button in. */
    readonly doc: Document;
    /** Credential input the button reads (and immediately empties). */
    readonly input: HTMLInputElement;
    /** Expected-login input the button reads (and immediately empties). */
    readonly expected: HTMLInputElement;
    /** Callback that runs the handoff with what was pasted. */
    readonly handlers: HandoffHandlers;
}): HTMLButtonElement {
    return makeButton({
        doc: spec.doc,
        label: 'Connect account',
        variant: 'default',
        onClick: () => {
            const pasted = spec.input.value;
            spec.input.value = '';
            const expectedLogin = spec.expected.value.trim();
            spec.expected.value = '';
            spec.handlers.submit(pasted, expectedLogin);
        },
    });
}

/**
 * Mount the handoff group: credential input, submit, and outcome lines.
 *
 * @returns The view over the mounted nodes.
 */
export function mountHandoffDom(input: DomInput): HandoffView {
    const { root, handlers } = input;
    const doc = root.ownerDocument;
    const group = makeElement({ doc, tag: 'div', className: 'oc-sdk' });
    const credential = mountCredentialField(doc);
    const submit = mountSubmitButton({
        doc,
        input: credential.input,
        expected: credential.expected,
        handlers,
    });
    const connected = makeElement({ doc, tag: 'span', className: 'oc-sdk-text' });
    connected.hidden = true;

    group.append(credential.field, submit, connected);
    root.append(group);

    return {
        setTokenEnabled: (isEnabled: boolean): void => {
            credential.input.disabled = !isEnabled;
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
        setPasteVisible: (isVisible: boolean): void => {
            credential.field.hidden = !isVisible;
            submit.hidden = !isVisible;
        },
        setSubmitEnabled: (isEnabled: boolean): void => {
            submit.disabled = !isEnabled;
        },
        dispose: (): void => {
            group.remove();
        },
    };
}
