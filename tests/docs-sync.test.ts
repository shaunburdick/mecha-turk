/**
 * Documentation sync (005 T-033 + 006 T-029, discharging 002 FR-042 and AC-022).
 *
 * The two operator-facing documents must describe the product that shipped,
 * not the one that shipped in September: the six tabs and their vocabulary,
 * the prerequisites section on **Status**, the Dispatches list with its
 * paging and filters, **Settings** as the **single configuration input** for
 * the whole service configuration — every field `GET /v1/config` carries,
 * the take-effect line each row carries, the two-step confirmation before a
 * retention limit is lowered, where the document lives, and the
 * agent-verification baseline the integration card no longer carries — and
 * the Accounts add form as the expected-login supply surface.
 *
 * The Settings claims are 006 T-029's, **extending** 005 T-033 rather than
 * repeating it: what 005 wrote as *read-only in this release* has shipped, so
 * the documents now assert the editable surface instead.
 *
 * The negative half of AC-022 is here too: neither document may instruct an
 * operator to configure anything through `MECHA_TURK_*` or a `.env` file, may
 * present a dead `specs/001-agent-event-orchestrator/` path, or may name a
 * retired tab — **with no exemption at all**. The vocabulary mapping table
 * that used to carry the retired words as history left `README.md` with the
 * product owner's 2026-10-01 ruling (a user-oriented readme for an unreleased
 * product carries no developer rename history), so the mapping now lives
 * where it is normative — 005's own `## Vocabulary Mapping` — and these two
 * documents are scanned whole.
 *
 * Everything here reads the local tree only (FR-086).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Repository root, derived from this file's location. */
const ROOT = resolve(import.meta.dirname, '..');

/** The README, named once for the assertions that read only it. */
const README = 'README.md';

/** The two documents 002 FR-042 puts in scope. */
const PAGES: readonly string[] = [README, 'specs/002-agent-event-extension/quickstart.md'];

/** The six tabs FR-010 ships, which both documents must name. */
const TABS: readonly string[] = ['Status', 'Dispatches', 'Bindings', 'Accounts', 'Settings', 'About'];

/**
 * The heading the README's vocabulary-mapping table used to live under
 * (005 FR-029), which the product owner removed from the readme on
 * 2026-10-01. Kept as the name of the thing that must **not** come back, so
 * the negative guard below fails loudly rather than silently if it does.
 */
const MAPPING_HEADING = '## Vocabulary mapping';

/** The two mapping rows the readme carried, which are spec-only now. */
const MAPPING_ROWS: readonly string[] = [
    '| Runs (panel section) | **Dispatches** | L1 |',
    '| Repositories (panel tab) | **Bindings** | L1 |',
    '| `run` (entity, key, ordinal) | `run` | L4 |',
    '| `GET /v1/events` and its operations | *retained* | L3 |',
];

/**
 * Shapes a retired noun takes when it is used rather than quoted: the bold
 * labels the old surface used, and the capital nouns the rename retired.
 */
const RETIRED: readonly RegExp[] = [
    /\*\*(Spike|Repos|Repositories|Runs|Health)\b/,
    /\bRuns\b/,
    /\bRepositories\b/,
    /\bRun\b\s+[a-z]/,
    /Repos pane/,
    /Spike tab/,
];

/**
 * Read one document whole.
 *
 * @param page - Repository-relative path of the document.
 * @returns Its text.
 */
function page(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8');
}

describe('002 FR-042 / AC-022 the two operator documents describe the shipped panel', () => {
    it('reads both documents rather than an empty pair', () => {
        {
            for (const doc of PAGES) {
                expect(page(doc).length, `${doc} is suspiciously short`).toBeGreaterThan(1_500);
            }
        }
        {
            for (const doc of PAGES) {
                const text = page(doc);
                for (const tab of TABS) {
                    expect(text, `${doc} does not name the ${tab} tab`).toContain(tab);
                }
                expect(text).toContain('Dispatches');
                expect(text).toContain('Bindings');
            }
        }
        {
            const onStatus = /Status[^\n]*prerequisites|prerequisites[^\n]*Status/i;

            for (const doc of PAGES) {
                const text = page(doc);
                expect(text, `${doc} does not mention the prerequisites`).toMatch(/prerequisites/i);
                expect(text, `${doc} does not place them on Status`).toMatch(onStatus);
            }
        }
        {
            for (const doc of PAGES) {
                // Prose asserts against whitespace-normalized text: both documents
                // wrap at ~80 columns, so a phrase's words can be on two lines.
                const prose = page(doc).replaceAll(/\s+/g, ' ');
                expect(prose, `${doc} does not point at the configuration document`).toContain('GET /v1/config');
                // 006 T-029 (extending 005 T-033): the read-only era is history —
                // the tab edits, and the documents must say so rather than repeat
                // the release note that has now shipped.
                expect(prose, `${doc} still calls the tab read-only`).not.toContain('read-only in this release');
                // The baseline the integration card no longer carries (002 FR-029,
                // 006 FR-100): named, sourced from the service, defaulted.
                expect(prose, `${doc} does not name the baseline field`).toContain('expectedAgent');
                expect(prose, `${doc} does not name the documented default`).toContain('project-manager');
                // The manifest carries no configuration either way it is said:
                // the card declaring nothing, or (since the owner's 2026-09-30
                // sweep) no card existing at all.
                expect(prose, `${doc} does not say the card carries no settings or is gone`).toMatch(
                    /carries \*\*no settings\*\*|no integration card/,
                );
                // 006's own surface claims: the take-effect line each row carries,
                // the two-step confirmation before anything is deleted, and where
                // the document lives (operator-backable, not an environment file).
                expect(prose, `${doc} does not say where the configuration lives`).toContain('config.json');
                expect(prose, `${doc} does not say it is operator-backable`).toContain('operator-backable');
            }
        }
        {
            for (const doc of PAGES) {
                expect(page(doc), `${doc} does not document the expected-login input`)
                    .toContain('expected GitHub login');
            }
        }
        {
            const text = page(README);

            // The owner's 2026-10-01 ruling, verbatim in intent: this is a
            // user-oriented readme for an unreleased product, so the rename
            // history goes entirely — heading, prose, and every row. What the
            // rows used to guard positively (the tabs really are called
            // Dispatches and Bindings) is guarded by the negative scan below,
            // which now covers the whole document with no exempt section.
            expect(text, 'the README still introduces a vocabulary mapping')
                .not.toContain(MAPPING_HEADING);
            for (const row of MAPPING_ROWS) {
                expect(text, `the README still carries the mapping row ${row}`).not.toContain(row);
            }
        }
    });
});

describe('002 AC-022 the negative half: no dead instruction and no retired tab', () => {
    it('instructs no environment or file-based configuration', () => {
        {
            for (const doc of PAGES) {
                const text = page(doc);
                expect(text, `${doc} still instructs an environment variable`).not.toContain('MECHA_TURK_');
                expect(text, `${doc} still points at a dotenv file`).not.toContain('.env');
            }
        }
        {
            for (const doc of PAGES) {
                expect(page(doc), `${doc} cites a retired spec path`)
                    .not.toContain('specs/001-agent-event-orchestrator/');
            }
        }
        {
            for (const doc of PAGES) {
                const text = page(doc);
                for (const retired of RETIRED) {
                    expect(retired.test(text), `${doc} uses a retired noun: ${retired.source}`).toBe(false);
                }
            }

            // Not vacuous: the rule really does catch the shape it exists for,
            // and it now reads both documents whole — the mapping section that
            // used to be the one sanctioned exemption left the readme, so the
            // scan no longer strips anything before it looks.
            expect(RETIRED[0]?.test('the **Spike** tab')).toBe(true);
            expect(RETIRED[1]?.test('under **Runs**')).toBe(true);
            expect(page(README)).not.toContain(MAPPING_HEADING);
        }
    });
});
