/**
 * Consent copy fidelity tests (token-handoff §1.1/§1.2, SEC-01, SEC-12).
 *
 * The contract block is the only definition of this wording, so the tests
 * read *it* and compare: any paraphrase, trimming, re-ordering, or wording
 * change without a version bump fails here rather than shipping a stale
 * consent dialog. The single permitted transformation — removing Markdown
 * emphasis markers, which `textContent` would render literally — is applied to
 * the contract side of the comparison, never to the shipped copy.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CONSENT_COPY_PARAGRAPHS,
    CONSENT_COPY_V1,
    CONSENT_VERSION,
    consentCurrent,
    readConsentMirror,
} from '../extension/src/consent.ts';

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

describe('CONSENT_COPY_V1', () => {
    it('matches the contract §1.1 block word for word', () => {
        expect(CONSENT_COPY_PARAGRAPHS).toEqual(contractParagraphs());
    });

    it('pins CONSENT_VERSION to the version the contract declares', () => {
        expect(CONSENT_VERSION).toBe(contractVersion());
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
