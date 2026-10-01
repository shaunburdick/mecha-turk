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
 *
 * The credential input never retains a paste: the mount step writes the value
 * through at capture (read + `value = ''` in the same tick) and
 * {@link submitHandoffAndRepaint} clears the view again in `finally`, so both
 * halves of contract §2 step ⑧ — the module-scoped variable *and* the input —
 * are emptied on every exit.
 */

import { adoptServiceAccounts } from './account-adoption.ts';
import { CONSENT_COPY_V1 } from './consent.ts';
import { connectedLine } from './handoff-copy.ts';
import { acceptHandoffConsent, runHandoff } from './handoff.ts';
import { preflightHandoff } from './handoff-status.ts';
import { repaintPrerequisites } from './prerequisites.ts';
import type { HandoffState } from './handoff.ts';
import type { PanelRuntime } from './panel-state.ts';

/** The SDK's field-note class, shared by every note this adapter writes. */
const FIELD_NOTE_CLASS = 'oc-sdk-field-note';

/** Callbacks the mounted handoff group invokes. */
export interface HandoffHandlers {
    /** The operator accepted the consent step. */
    readonly accept: () => void;
    /** The operator declined the consent step. */
    readonly decline: () => void;
    /**
     * The operator submitted the pasted credential.
     *
     * The second argument is the optional expected-login constraint (FR-006):
     * an empty string means *no constraint*, which is what the caller sends
     * when the field was left alone.
     */
    readonly submit: (token: string, expectedLogin: string) => void;
}

/** Every surface the render step may write to. */
export interface HandoffView {
    /** Render the canonical consent copy (verbatim, contract §1.1). */
    setConsentText(text: string): void;
    /** Show or hide the consent step (hidden once the current copy is accepted). */
    showConsent(show: boolean): void;
    /** Enable or disable the credential input (F10 pre-flight gate). */
    setTokenEnabled(enabled: boolean): void;
    /** Replace the credential input's value; `''` clears it (§2 step ⑧). */
    setTokenValue(value: string): void;
    /** Render the operator-facing note; never credential material. */
    setNote(text: string): void;
    /** Render `Connected as <login>`, or hide the line with `null`. */
    setConnected(text: string | null): void;
    /** Show or hide the paste row (consent field, credential input, submit). */
    setPasteVisible(visible: boolean): void;
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
 * A connected account — adopted from the service or handed off one-shot —
 * hides the paste row: consent governs NEW token handoff only, and the paste
 * field must not offer a credential the service already holds (MVP blocker 2).
 *
 * The **consent step itself is hidden by acceptance alone**, not by
 * connection. Hiding it once an account is connected made the one acceptance
 * the service-capability prerequisite reads unreachable — an install whose
 * account was adopted after a reinstall could never clear the notice that
 * told the operator to accept, which is the defect 005 FR-073's "an unmet
 * item the panel *can* determine" exists to prevent. The step is therefore
 * shown whenever the current copy has not been accepted, and gone the moment
 * it has.
 *
 * @param state - Current handoff state.
 * @param view - Surface to write to; the consent copy is passed verbatim.
 */
export function renderHandoff(state: HandoffState, view: HandoffView): void {
    view.setConsentText(CONSENT_COPY_V1);
    const connected = state.connected !== null;
    view.showConsent(!state.consentGiven);
    view.setPasteVisible(!connected);
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
 * Repaint every surface the handoff state drives, not just the group.
 *
 * The service-capability prerequisite is derived from the very same
 * `HandoffState` (consent, service answer, store writability), and its
 * notice lives above the tab strip where nothing on the Accounts tab would
 * repaint it. Every path that changes one of those three signals therefore
 * ends here: without this call the operator could accept the consent step
 * and read a banner that still said they had not — the recurring complaint
 * this helper exists to close (005 FR-037, FR-073).
 *
 * @param rt - Panel runtime whose group and prerequisites repaint.
 */
function repaintHandoffSurfaces(rt: PanelRuntime): void {
    refreshHandoff(rt);
    repaintPrerequisites(rt);
}

/**
 * Run the handoff pre-flight after mount and repaint the group.
 *
 * The pre-flight is preceded by the silent account adoption: a service-side
 * account the mirror lost (extension reinstall) is adopted from
 * `GET /v1/accounts` before the operator is shown a paste form that could
 * only end in the service's duplicate refusal (MVP blocker 2).
 *
 * The pre-flight's own outcome is part of the prerequisite read, so this
 * repaints the notice too: the mount's last synchronous `refresh` can run
 * before this async read lands, and a notice derived from a pre-flight that
 * has not reported yet is a notice built on the wrong facts.
 *
 * @param rt - Panel runtime whose handoff group may be mounted.
 */
export async function preflightAndRepaint(rt: PanelRuntime): Promise<void> {
    await adoptServiceAccounts(rt);
    await preflightHandoff(rt);
    if (!rt.disposed) {
        repaintHandoffSurfaces(rt);
    }
}

/**
 * Accept the handoff consent, then repaint the group **and** the
 * prerequisites the acceptance just changed.
 *
 * The state flag follows the write outcome (see
 * {@link acceptHandoffConsent}), and the notice above the tab strip reads
 * that same flag — so the repaint has to reach both surfaces, or the
 * operator accepts the step and keeps reading a banner that says they did
 * not. This is the whole of the "consent nag never clears" fix.
 *
 * @param rt - Panel runtime.
 */
export async function acceptConsentAndRepaint(rt: PanelRuntime): Promise<void> {
    await acceptHandoffConsent(rt);
    repaintHandoffSurfaces(rt);
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
    /** Optional expected-login constraint; omitted means none (FR-006). */
    readonly expectedLogin?: string;
}

/**
 * Run one handoff and repaint twice: once as it starts (the group disables
 * itself while the credential is in flight) and once when it settles.
 *
 * The credential input is cleared in `finally`, on **every** exit — success,
 * service refusal, host failure, timeout, or a thrown error — so a paste never
 * survives the handoff it belonged to (contract §2 step ⑧, FR-007). The mount
 * step already wrote the value through at capture time (it reads the input and
 * empties it before the request starts); this second clear is what removes a
 * value that reappeared while the request was in flight, and it is why
 * {@link HandoffView.setTokenValue} has a production call site.
 *
 * The expected-login constraint (FR-006) travels only when the operator
 * typed one: an empty or blank field omits the `expectedLogin` member
 * entirely, which is how the service is told *no constraint* and stores
 * `expectedLogin: null` (002 FR-009, 005 AC-141).
 *
 * @param rt - Panel runtime.
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
        // A handoff the service refused on consent grounds drops the mirror
        // again (§1.2), so the prerequisite it backs must repaint with it.
        repaintHandoffSurfaces(rt);
    }
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
    /** Container holding both inputs, hidden together once connected. */
    readonly field: HTMLElement;
    /** The dedicated credential input (`type="password"`, SEC-17). */
    readonly input: HTMLInputElement;
    /** Node the operator-facing note is written into as text. */
    readonly note: HTMLElement;
    /** The optional expected-login input — the form's only other field (FR-006). */
    readonly expected: HTMLInputElement;
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

/** The SDK button variants this adapter may ask for; the SDK reads `data-variant`. */
type HandoffButtonVariant = 'default' | 'outline';

/**
 * Create a button whose label is written as text, never as markup.
 *
 * **The variant is not optional.** The SDK's sheet gives `.oc-sdk-btn` only a
 * transparent border as its base and paints every real treatment from an
 * attribute selector (`[data-variant="…"]`), so a button with no variant is
 * bare text on the page — which is exactly how the consent decisions read
 * before this (product-owner review 2026-10-01). The attribute is written with
 * `setAttribute` rather than `dataset` so the offline DOM double records it
 * like any other attribute and a test can pin it.
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
    button.setAttribute('data-variant', spec.variant);
    button.type = 'button';
    button.textContent = spec.label;
    button.addEventListener('click', spec.onClick);

    return button;
}

/**
 * Mount the consent step: the canonical copy plus accept and decline.
 *
 * The two decisions sit **beneath** the copy in a wrapping toolbar rather
 * than beside it: the step used to mount into an `.oc-sdk-row`, whose
 * `align-items: center` floated the buttons vertically against four
 * paragraphs and pushed them to the far right edge of the pane, where they
 * read as sentences rather than as controls (product-owner review
 * 2026-10-01).
 *
 * @param spec - Document and the handlers the two decisions invoke.
 * @returns The consent step's container and text node.
 */
function mountConsentStep(spec: DomFactory): ConsentStep {
    const box = makeElement({ doc: spec.doc, tag: 'div', className: 'mt-stack' });
    const text = makeElement({ doc: spec.doc, tag: 'p', className: FIELD_NOTE_CLASS });
    text.style.whiteSpace = 'pre-line';
    const decisions = makeElement({ doc: spec.doc, tag: 'div', className: 'mt-toolbar' });
    const accept = makeButton({
        doc: spec.doc,
        label: 'Accept and continue',
        variant: 'default',
        onClick: spec.handlers.accept,
    });
    const decline = makeButton({
        doc: spec.doc,
        label: 'Decline',
        variant: 'outline',
        onClick: spec.handlers.decline,
    });
    decisions.append(accept, decline);
    box.append(text, decisions);

    return { box, text };
}

/**
 * Mount the optional expected-login input (005 FR-006, 002 FR-009).
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
 * @param doc - Document to create in.
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
 * cache, no retry buffer (contract §2 steps ② and ⑧, FR-007). The expected
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
    const submit = mountSubmitButton({
        doc,
        input: credential.input,
        expected: credential.expected,
        handlers,
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
        setPasteVisible: (visible: boolean): void => {
            credential.field.hidden = !visible;
            submit.hidden = !visible;
        },
        setSubmitEnabled: (enabled: boolean): void => {
            submit.disabled = !enabled;
        },
        dispose: (): void => {
            group.remove();
        },
    };
}
