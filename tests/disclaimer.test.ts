/**
 * Disclaimer copy fidelity tests (token-handoff §1.1, SEC-12 re-pointed).
 *
 * The Accept/Decline consent dialog this suite used to pin was removed by
 * product-owner order on 2026-10-01 (002 FR-008 re-cut at v1.9.0). What
 * replaced it is the static, always-visible disclaimer under the Accounts
 * section — same discipline, new subject: the contract block is the only
 * definition of this wording, so the tests read *it* and compare. Any
 * paraphrase, trimming, re-ordering, or wording change fails here rather than
 * shipping copy the contract does not carry. The single permitted
 * transformation — removing Markdown `**emphasis**` markers, which
 * `textContent` would render literally — is applied to the contract side of
 * the comparison, never to the shipped copy.
 *
 * The disclaimer is informational: no version, no acceptance, no state. The
 * version-bump machinery of the consent era is therefore gone with it — what
 * is pinned now is the copy itself, plus the promise that it never again
 * asks the operator to accept or decline anything.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    ACCOUNTS_DISCLAIMER,
    ACCOUNTS_DISCLAIMER_PARAGRAPHS,
} from '../src/accounts-disclaimer.ts';

/** Contract file holding the canonical disclaimer block. */
const CONTRACT_PATH = resolve(import.meta.dirname, '../specs/002-agent-event-extension/contracts/token-handoff.md');

/** Heading that introduces the canonical block. */
const SECTION_HEADING = '### 1.1';

/** Marker that ends the quoted block and starts its rules list. */
const RULES_HEADING = 'Rules for this block:';

/**
 * Extract `ACCOUNTS_DISCLAIMER` from the contract, paragraph by paragraph.
 *
 * @returns The contract's paragraphs with `**emphasis**` markers removed —
 *   the only transformation this comparison permits.
 */
function contractParagraphs(): string[] {
    const lines = readFileSync(CONTRACT_PATH, 'utf8').split('\n');
    const heading = lines.findIndex((line) => line.startsWith(SECTION_HEADING));
    expect(heading).toBeGreaterThan(-1);

    const paragraphs: string[] = [];
    let current: string | null = null;
    for (const line of lines.slice(heading + 1)) {
        if (line === RULES_HEADING) {
            break;
        }

        if (!line.startsWith('>')) {
            continue;
        }

        const body = line.replace(/^>\s?/, '');
        if (body === '') {
            if (current !== null) {
                paragraphs.push(current);
                current = null;
            }
            continue;
        }

        current = current === null ? body : `${current}\n${body}`;
    }

    if (current !== null) {
        paragraphs.push(current);
    }

    return paragraphs.map((paragraph) => paragraph.replaceAll('**', ''));
}

/**
 * The disclaimer copy, pinned in a single literal beside the contract block
 * it mirrors (the W2-5 discipline, re-pointed from the consent string).
 */
const PINNED_DISCLAIMER: readonly string[] = [
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

describe('ACCOUNTS_DISCLAIMER', () => {
    it('matches the pinned copy in the contract and in the shipped mirror', () => {
        // Contract side: the §1.1 block must match the pin.
        expect(contractParagraphs()).toEqual(PINNED_DISCLAIMER);

        // Shipped side: the mirror `mountAccountsDisclaimer` renders must
        // match the same pin, so the two sources cannot drift apart.
        expect(ACCOUNTS_DISCLAIMER_PARAGRAPHS).toEqual(PINNED_DISCLAIMER);
    });

    it('keeps the advisory full-user-access sentence FR-008 exists to state', () => {
        expect(ACCOUNTS_DISCLAIMER).toContain('an allowed service has your full user access');
        expect(ACCOUNTS_DISCLAIMER).toContain('Phase 1 does not enforce an OS sandbox');
    });

    it('keeps the plaintext-at-rest sentence', () => {
        expect(ACCOUNTS_DISCLAIMER).toContain('stored unencrypted (plaintext) on disk');
    });

    it('states that the audit keeps an occurrence without the token', () => {
        expect(ACCOUNTS_DISCLAIMER).toContain('an occurrence only — an identity and a time, never the token');
    });

    it('renders four paragraphs separated by blank lines, with no markup markers', () => {
        expect(ACCOUNTS_DISCLAIMER.split('\n\n')).toHaveLength(ACCOUNTS_DISCLAIMER_PARAGRAPHS.length);
        expect(ACCOUNTS_DISCLAIMER).not.toContain('**');
    });

    it('asks the operator for nothing: no accept, no decline, no consent gate', () => {
        // The whole point of the 2026-10-01 removal: the copy is information,
        // and neither the shipped text nor the contract block may read as a
        // step an operator has to complete.
        for (const paragraph of ACCOUNTS_DISCLAIMER_PARAGRAPHS) {
            expect(paragraph).not.toMatch(/\baccept\b/i);
            expect(paragraph).not.toMatch(/\bdecline\b/i);
            expect(paragraph).not.toMatch(/\bconsent\b/i);
        }

        const contract = readFileSync(CONTRACT_PATH, 'utf8');
        const section = contract.slice(contract.indexOf(SECTION_HEADING));
        const block = section.slice(0, section.indexOf(RULES_HEADING));
        expect(block).not.toMatch(/\baccept\b/i);
        expect(block).not.toMatch(/\bdecline\b/i);
        expect(block).not.toMatch(/\bconsent\b/i);
    });
});
