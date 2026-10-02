/**
 * The static disclaimer under the Accounts section (002 FR-008 as re-cut at
 * v1.9.0 — product-owner order 2026-10-01: the Connect-account Accept/Decline
 * dialog is gone, and this text is what remains).
 *
 * It carries the substance of the old consent copy — where the token goes,
 * the sandbox-advisory reality of an allowed service, and the plaintext-at-rest
 * custody statement — as **information**: no buttons, no state, no
 * persistence, nothing to accept or decline. The canonical wording is the
 * quoted block in `specs/002-agent-event-extension/contracts/token-handoff.md`
 * §1.1; this module is its machine mirror, and `tests/disclaimer.test.ts`
 * fails the build whenever the contract block and these paragraphs disagree by
 * a single character (the verification-enforced single source SEC-12 set up,
 * re-pointed at the disclaimer when the gate left).
 *
 * Rendering is text-only: {@link mountAccountsDisclaimer} writes the copy
 * through `textContent`, never an HTML-parsing sink (SEC-14), and carries no
 * interactive element at all.
 */

/** The disclaimer as the contract's §1.1 blockquote holds it: four paragraphs. */
export const ACCOUNTS_DISCLAIMER_PARAGRAPHS: readonly string[] = [
    'Mecha Turk wants to send a GitHub token to a local service.',
    'This local service is allowed but sandbox-advisory: Phase 1 does not enforce an OS sandbox; ' +
        'an allowed service has your full user access — it can run any command and read or write ' +
        'any file your user can.',
    'Your GitHub token is sent over the loopback proxy to this service and stored outside ' +
        'OpenChamber extension storage, protected by file permissions you can back up. ' +
        'It is stored unencrypted (plaintext) on disk, readable by anything running as your user.',
    'A connection is recorded in the service audit as an occurrence only — an identity and a time, ' +
        'never the token.',
];

/** The disclaimer as one renderable string; paragraphs separated by a blank line. */
export const ACCOUNTS_DISCLAIMER: string = ACCOUNTS_DISCLAIMER_PARAGRAPHS.join('\n\n');

/** Class every field note in this adapter shares, so the text reads as a note. */
const DISCLAIMER_NOTE_CLASS = 'oc-sdk-field-note';

/**
 * Mount the disclaimer into the Accounts section, where it stays visible.
 *
 * Informational only — the mount creates one wrapper and one paragraph and
 * wires nothing: no button, no handler, no stored flag, so there is no state
 * a panel could get out of step with and no copy an operator can "complete".
 *
 * @param parent - Element the disclaimer is appended to (the Accounts block).
 * @returns The mounted container, for disposal with the block it sits in.
 */
export function mountAccountsDisclaimer(parent: HTMLElement): HTMLElement {
    const doc = parent.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'oc-sdk';
    box.setAttribute('data-accounts-disclaimer', 'informational');
    const text = doc.createElement('p');
    text.className = DISCLAIMER_NOTE_CLASS;
    text.style.whiteSpace = 'pre-line';
    text.textContent = ACCOUNTS_DISCLAIMER;
    box.append(text);
    parent.append(box);

    return box;
}
