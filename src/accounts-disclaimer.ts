/**
 * The static disclaimer under the Accounts section (002 FR-008 as re-cut at
 * v1.9.0): where the token goes, sandbox-advisory reality, and the
 * plaintext-at-rest custody statement, as information — no controls, no state.
 */

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

export const ACCOUNTS_DISCLAIMER: string = ACCOUNTS_DISCLAIMER_PARAGRAPHS.join('\n\n');

const DISCLAIMER_NOTE_CLASS = 'oc-sdk-field-note';

/**
 * Mount the disclaimer into the Accounts section, where it stays visible.
 *
 * Informational only — the mount creates one wrapper and one paragraph and
 * wires nothing: no button, no handler, no stored flag, so there is no state
 * a panel could get out of step with and no copy an operator can "complete".
 */
export function mountAccountsDisclaimer(parent: HTMLElement): HTMLElement {
    const doc = parent.ownerDocument;
    const box = doc.createElement('div');
    box.className = 'oc-sdk';
    box.dataset.accountsDisclaimer = 'informational';
    const text = doc.createElement('p');
    text.className = DISCLAIMER_NOTE_CLASS;
    text.style.whiteSpace = 'pre-line';
    text.textContent = ACCOUNTS_DISCLAIMER;
    box.append(text);
    parent.append(box);

    return box;
}
