/**
 * Consent copy fidelity tests (token-handoff §1.1/§1.2, SEC-01, SEC-12).
 *
 * The contract block is the only definition of this wording, so the tests
 * read *it* and compare: any paraphrase, trimming, re-ordering, or wording
 * change without a version bump fails here rather than shipping a stale
 * consent dialog. The single permitted transformation — removing Markdown
 * emphasis markers, which `textContent` would render literally — is applied to
 * the contract side of the comparison, never to the shipped copy.
 *
 * The copy **and** its version are pinned together in one literal
 * ({@link PINNED_CONSENT}, review W2-5): the contract's paragraphs, the
 * contract's declared version, the shipped paragraphs, and `CONSENT_VERSION`
 * are all asserted against that single fixture, so neither half can drift
 * independently of the other (token-handoff §1.1's version-bump checklist).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { refreshHandoff } from '../src/accounts-ui.ts';
import {
    CONSENT_COPY_PARAGRAPHS,
    CONSENT_COPY_V1,
    CONSENT_STORAGE_KEY,
    CONSENT_VERSION,
    consentCurrent,
    readConsentMirror,
    restoreStoredConsent,
} from '../src/consent.ts';
import { recordingView } from './support/handoff.ts';
import { createStorageDouble, createTestRuntime, fakeHost } from './support/panel.ts';

/** Contract file holding the canonical consent block. */
const CONTRACT_PATH = resolve(import.meta.dirname, '../specs/002-agent-event-extension/contracts/token-handoff.md');

/** Heading that introduces the canonical block. */
const SECTION_HEADING = '### 1.1';

/** Marker that ends the quoted block and starts its rules list. */
const RULES_HEADING = 'Rules for this block:';

/** Fixture timestamp used by the mirror examples. */
const GIVEN_AT = '2026-09-27T00:00:00.000Z';

/**
 * Extract `CONSENT_COPY_V1` from the contract, paragraph by paragraph.
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
 * Read the contract's declared `CONSENT_VERSION`.
 *
 * @returns The integer the contract pins.
 */
function contractVersion(): number {
    const line = readFileSync(CONTRACT_PATH, 'utf8')
        .split('\n')
        .find((candidate) => candidate.includes('CONSENT_VERSION = '));
    expect(line).toBeDefined();

    return Number(line?.split('CONSENT_VERSION = ')[1]?.match(/^\d+/)?.[0]);
}

/**
 * The consent copy **and** its version, pinned in a single literal (W2-5).
 *
 * One literal on purpose: the paragraphs and the version are asserted
 * together in a single test, so a copy change without `CONSENT_VERSION + 1`,
 * or a bump without a copy change, fails this file instead of shipping a
 * stale "yes" (token-handoff §1.1's version-bump checklist). The paragraphs
 * are concatenated rather than left on one line only to stay inside the
 * repository's line-length limit; the joined string is what must match.
 */
const PINNED_CONSENT: { readonly version: number; readonly paragraphs: readonly string[] } = {
    version: 1,
    paragraphs: [
        'Mecha Turk wants to send a GitHub token to a local service.',
        'This local service is allowed but sandbox-advisory: Phase 1 does not enforce an OS sandbox; ' +
            'an allowed service has your full user access — it can run any command and read or write ' +
            'any file your user can.',
        'Your GitHub token is sent over the loopback proxy to this service and stored outside ' +
            'OpenChamber extension storage, protected by file permissions you can back up. ' +
            'It is stored unencrypted (plaintext) on disk, readable by anything running as your user.',
        'Consent is recorded in the service audit as an occurrence only — a version and a time, never the token.',
    ],
};

describe('CONSENT_COPY_V1', () => {
    it('matches the pinned copy and version in one literal (W2-5)', () => {
        // Contract side: the §1.1 block and the version it declares must both
        // match the pin, so changing one without the other fails here.
        expect(contractParagraphs()).toEqual(PINNED_CONSENT.paragraphs);
        expect(contractVersion()).toBe(PINNED_CONSENT.version);

        // Shipped side: the JSON mirror consent.ts re-exports must match the
        // same pin — copy and version travel together in one fixture.
        expect(CONSENT_COPY_PARAGRAPHS).toEqual(PINNED_CONSENT.paragraphs);
        expect(CONSENT_VERSION).toBe(PINNED_CONSENT.version);
    });

    it('keeps the advisory full-user-access sentence FR-008 exists to state', () => {
        expect(CONSENT_COPY_V1).toContain('an allowed service has your full user access');
        expect(CONSENT_COPY_V1).toContain('Phase 1 does not enforce an OS sandbox');
    });

    it('keeps the plaintext-at-rest sentence', () => {
        expect(CONSENT_COPY_V1).toContain('stored unencrypted (plaintext) on disk');
    });

    it('states that consent is recorded as an occurrence without the token', () => {
        expect(CONSENT_COPY_V1).toContain('a version and a time, never the token');
    });

    it('renders four paragraphs separated by blank lines', () => {
        expect(CONSENT_COPY_V1.split('\n\n')).toHaveLength(CONSENT_COPY_PARAGRAPHS.length);
        expect(CONSENT_COPY_V1).not.toContain('**');
    });
});

describe('consent mirror rules (§1.2 re-consent)', () => {
    it('treats a missing or malformed mirror as no consent at all', () => {
        expect(readConsentMirror(null)).toBeNull();
        expect(readConsentMirror('consent')).toBeNull();
        expect(readConsentMirror({ givenAt: 42, version: 1 })).toBeNull();
        expect(readConsentMirror({ givenAt: 'now', version: 1.5 })).toBeNull();
        expect(consentCurrent(null)).toBe(false);
    });

    it('accepts a structurally valid mirror', () => {
        expect(readConsentMirror({ givenAt: GIVEN_AT, version: 1 })).toEqual({
            givenAt: GIVEN_AT,
            version: 1,
        });
    });

    it('forces re-consent when the stored version is below the current copy', () => {
        const stale = { givenAt: GIVEN_AT, version: 1 };

        expect(consentCurrent(stale, 1)).toBe(true);
        expect(consentCurrent(stale, 2)).toBe(false);
        expect(consentCurrent({ ...stale, version: 3 }, 2)).toBe(true);
    });
});

describe('an accepted consent is never re-requested (002 FR-008, 005 FR-061)', () => {
    it('renders no consent step for a panel mounted over a current mirror', async () => {
        const mirror = { givenAt: GIVEN_AT, version: CONSENT_VERSION };
        const storage = createStorageDouble({ [CONSENT_STORAGE_KEY]: mirror });
        const rt = createTestRuntime(fakeHost({ storage: storage.storage }));

        await restoreStoredConsent(rt);
        const record = recordingView();
        rt.handoffView = record.view;
        // What mounting the Accounts body runs: one repaint, and no prompt —
        // navigation is not a new request for consent.
        refreshHandoff(rt);

        expect(rt.state.handoff.consentGiven).toBe(true);
        expect(record.consentShown).toBe(false);
        // The paste row is open: consent governs the first handoff only.
        expect(record.pasteVisible).toBe(true);
        // Nothing rewrote the stored acceptance either.
        expect(storage.values.get(CONSENT_STORAGE_KEY)).toEqual(mirror);
    });
});
