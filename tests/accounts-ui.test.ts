/**
 * Rendering-contract tests for the one-shot handoff (task T-009,
 * token-handoff §1.1/§2 step ①, panel-service §3 invariant 11).
 *
 * The render step is a pure mapping from state onto a view, so these tests
 * drive it with the recording double: the consent copy must arrive verbatim,
 * the input must stay gated on consent **and** a writable pre-flight, and no
 * rendered string may carry a credential. The DOM adapter itself is checked
 * by a static scan — it must write through `textContent`/`setAttribute` only
 * and must pin `type="password"` with `autocomplete="new-password"`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handoffInputEnabled, renderHandoff } from '../extension/src/accounts-ui.ts';
import { CONSENT_COPY_V1 } from '../extension/src/consent.ts';
import { PANEL_TOKEN, initialState, recordingView } from './support/handoff.ts';

/** Filesystem path of the DOM adapter, for the static rendering scan. */
const DOM_SOURCE_PATH = resolve(import.meta.dirname, '../extension/src/accounts-ui.ts');
/** Assert that a list of rendered strings carries no registered credential. */
function expectNoCredentialInStrings(strings: readonly string[]): void {
    expect(strings.join('\n')).not.toContain(PANEL_TOKEN);
}
describe('rendering (contract §1.1, §4 rule 5, SEC-17)', () => {
    it('renders CONSENT_COPY_V1 verbatim into the consent step', () => {
        const record = recordingView();

        renderHandoff(
            { ...initialState(), consentGiven: false },
            record.view,
        );

        expect(record.consentText).toBe(CONSENT_COPY_V1);
        expect(record.consentShown).toBe(true);
        expectNoCredentialInStrings(record.rendered);
    });

    it('hides the consent step once the current copy is accepted', () => {
        const record = recordingView();

        renderHandoff({ ...initialState(), consentGiven: true }, record.view);

        expect(record.consentShown).toBe(false);
    });

    it('enables the credential input only after consent and a writable pre-flight', () => {
        const base = initialState();
        const record = recordingView();

        expect(handoffInputEnabled({ ...base, consentGiven: true })).toBe(false);
        expect(handoffInputEnabled({ ...base, storageWritable: true })).toBe(false);
        expect(
            handoffInputEnabled({ ...base, consentGiven: true, storageWritable: true }),
        ).toBe(true);
        expect(handoffInputEnabled({ ...base, consentGiven: true, storageWritable: true, busy: true })).toBe(false);

        renderHandoff({ ...base, consentGiven: true, storageWritable: true }, record.view);
        expect(record.tokenEnabled).toBe(true);
        expect(record.submitEnabled).toBe(true);
    });

    it('renders the connected line through the view, never as markup', () => {
        const record = recordingView();

        renderHandoff({ ...initialState(), connected: { numericUserId: '1', login: 'octocat' } }, record.view);

        expect(record.connected).toBe('Connected as octocat');
    });

    it('keeps DOM rendering on textContent and the pinned input attributes', () => {
        const source = readFileSync(DOM_SOURCE_PATH, 'utf8');

        expect(source).toContain('textContent');
        expect(source).toContain("setAttribute('type', 'password')");
        expect(source).toContain("setAttribute('autocomplete', 'new-password')");
        // Usage, not vocabulary: the module's own docs name the forbidden
        // sinks, so the scan looks for how they would actually be called.
        expect(source).not.toMatch(/\.innerHTML\b/);
        expect(source).not.toMatch(/insertAdjacentHTML\s*\(/);
        expect(source).not.toMatch(/\.outerHTML\b/);
    });
});

